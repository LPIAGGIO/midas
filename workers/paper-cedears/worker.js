/**
 * Worker: paper-cedears — paper trading de momentum en acciones USA (= CEDEARs,
 * el CCL se cancela en el ranking). Capital simulado USD 1000.
 *
 * Estrategia (validada en research 14/06): cada ~mes (21 ruedas) rankea la
 * canasta por momentum "12-1" (retorno de 12 meses excluyendo el último mes)
 * y holdea equal-weight los TOP-8 con momentum POSITIVO (los negativos van a
 * cash → protección en bear). Fee 0,2%/lado (spread CEDEAR; comisión 0 en Cocos).
 *
 * Modos: --init siembra el histórico (is_live=false); sin flag = run diario
 * (PM2 cron). Tablas paper_cedear_equity/holdings/state/trades.
 * Fuente: Yahoo OHLC diario (sin keys).
 */
require("dotenv").config();
const https = require("https");
const { createClient } = require("@supabase/supabase-js");
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = require("ws");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const SYMS = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "NFLX", "AVGO", "KO", "MELI", "JPM", "V", "MA", "WMT", "JNJ", "PG", "XOM", "DIS", "COIN", "PLTR", "MSTR", "QCOM", "MU", "INTC", "ORCL", "CRM", "NKE", "BA"];
const LB = 252, SKIP = 21, REBAL = 21, TOPK = 8, CAPITAL = 1000, FEE = 0.002;
const INIT = process.argv.includes("--init");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const get = (u) => new Promise((res, rej) => https.get(u, { headers: { "User-Agent": "Mozilla/5.0" } }, (r) => { let b = ""; r.on("data", (d) => b += d); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));

async function loadSeries() {
  const series = {};
  for (const s of SYMS) {
    try {
      const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?interval=1d&range=2y`);
      const r = j?.chart?.result?.[0]; if (!r) continue;
      const ts = r.timestamp, cl = r.indicators.quote[0].close;
      const today = new Date().toISOString().slice(0, 10);
      const m = new Map();
      for (let i = 0; i < ts.length; i++) { const d = new Date(ts[i] * 1000).toISOString().slice(0, 10); if (cl[i] != null && d < today) m.set(d, cl[i]); }
      if (m.size > LB + 30) series[s] = m;
    } catch (e) { }
  }
  return series;
}

(async () => {
  log(`paper-cedears ${INIT ? "[INIT]" : "[diario]"} — momentum Top-${TOPK} dual, rotación ${REBAL}d`);
  const series = await loadSeries();
  const assets = Object.keys(series);
  let dates = [...series[assets[0]].keys()];
  for (const a of assets) dates = dates.filter((d) => series[a].has(d));
  dates.sort();
  const px = (a, i) => series[a].get(dates[i]);
  const idxOf = (d) => dates.indexOf(d);

  // Estado previo
  const { data: stArr } = await supabase.from("paper_cedear_state").select("*").eq("id", "momentum");
  const { data: hArr } = await supabase.from("paper_cedear_holdings").select("*");
  let cash, holdings = {}, startIdx, lastRebalIdx;
  if (!stArr || !stArr[0]) {
    cash = CAPITAL; startIdx = LB; lastRebalIdx = LB - REBAL;
  } else {
    cash = Number(stArr[0].cash_usd);
    for (const h of hArr || []) holdings[h.ticker] = Number(h.units);
    startIdx = idxOf(dates.find((d) => d > stArr[0].last_date)) ;
    if (startIdx < 0) { log("sin días nuevos"); return; }
    lastRebalIdx = idxOf(stArr[0].last_rebal);
  }

  // benchmark equal-weight (comprado el día LB)
  const bhUnits = {}; for (const a of assets) bhUnits[a] = (CAPITAL / assets.length) * (1 - FEE) / px(a, LB);

  const eqRows = [], trRows = [];
  for (let i = startIdx; i < dates.length; i++) {
    // ¿rebalanceo? cada REBAL ruedas desde el último
    if (i - lastRebalIdx >= REBAL) {
      const ranked = assets.map((a) => [a, px(a, i - SKIP) / px(a, i - LB) - 1]).sort((x, y) => y[1] - x[1]);
      const picked = ranked.slice(0, TOPK).filter(([, m]) => m > 0).map(([a]) => a); // dual: solo momentum positivo
      // valor actual de la cartera
      let portVal = cash; for (const [t, u] of Object.entries(holdings)) portVal += u * px(t, i);
      const targetUsd = portVal / TOPK; // equal weight sobre K (si pickea <K, queda cash)
      // vender los que salen
      for (const [t, u] of Object.entries(holdings)) {
        if (!picked.includes(t) && u > 0) {
          const proceeds = u * px(t, i) * (1 - FEE); cash += proceeds;
          trRows.push({ d: dates[i], ticker: t, side: "sell", price: px(t, i), units: u, reason: "sale del top" });
          holdings[t] = 0;
        }
      }
      // ajustar/comprar los elegidos a targetUsd
      for (const t of picked) {
        const curUsd = (holdings[t] || 0) * px(t, i);
        const diff = targetUsd - curUsd;
        if (diff > px(t, i) * 0.5) { // comprar
          const spend = Math.min(diff, cash); if (spend <= 0) continue;
          const u = spend * (1 - FEE) / px(t, i); holdings[t] = (holdings[t] || 0) + u; cash -= spend;
          trRows.push({ d: dates[i], ticker: t, side: "buy", price: px(t, i), units: u, reason: "entra/ajusta top" });
        }
      }
      lastRebalIdx = i;
    }
    // equity del día
    let eq = cash; let n = 0; for (const [t, u] of Object.entries(holdings)) { if (u > 0) { eq += u * px(t, i); n++; } }
    let bh = 0; for (const a of assets) bh += bhUnits[a] * px(a, i);
    eqRows.push({ d: dates[i], equity: eq, bh_equity: bh, n_holdings: n, is_live: !INIT });
  }

  // persistir
  for (let k = 0; k < eqRows.length; k += 500) {
    const { error } = await supabase.from("paper_cedear_equity").upsert(eqRows.slice(k, k + 500), { onConflict: "d" });
    if (error) throw new Error("equity: " + error.message);
  }
  if (trRows.length) { const { error } = await supabase.from("paper_cedear_trades").insert(trRows); if (error) throw new Error("trades: " + error.message); }
  // holdings actuales (reemplazo completo)
  await supabase.from("paper_cedear_holdings").delete().neq("ticker", "___");
  const hold = Object.entries(holdings).filter(([, u]) => u > 0).map(([t, u]) => ({ ticker: t, units: u, weight: null, updated_at: new Date().toISOString() }));
  if (hold.length) await supabase.from("paper_cedear_holdings").insert(hold);
  await supabase.from("paper_cedear_state").upsert({ id: "momentum", cash_usd: cash, last_date: dates[dates.length - 1], last_rebal: dates[lastRebalIdx], updated_at: new Date().toISOString() }, { onConflict: "id" });

  const lastEq = eqRows[eqRows.length - 1];
  log(`OK: ${eqRows.length} días, ${trRows.length} trades, equity ${lastEq.equity.toFixed(0)} vs b&h ${lastEq.bh_equity.toFixed(0)}, ${lastEq.n_holdings} holdings`);
  process.exit(0);
})().catch((e) => { log("ERROR: " + e.message); process.exit(1); });
