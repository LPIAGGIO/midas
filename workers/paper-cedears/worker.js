/**
 * Worker: paper-cedears — paper trading de momentum en acciones USA (= CEDEARs,
 * el CCL se cancela en el ranking). Capital simulado USD 1000 por variante.
 *
 * Estrategia (validada en research 14/06): cada N ruedas rankea la canasta por
 * momentum "12-1" (retorno de 12 meses excluyendo el último mes) y holdea
 * equal-weight los TOP-8 con momentum POSITIVO (los negativos van a cash →
 * protección en bear). Fee 0,2%/lado (spread CEDEAR; comisión 0 en Cocos).
 *
 * VARIANTES (cadencia de rotación) corridas en paralelo para comparar forward
 * cuál aguanta mejor el costo de rotar más seguido:
 *   w5  → rota cada 5 ruedas  (~semanal)
 *   w10 → rota cada 10 ruedas (~quincenal)
 *   m21 → rota el 17 de cada mes (mensual; el día en que LP rota el book real)
 *   iol21 → igual que m21 (17 del mes) pero con el costo real de IOL Gold
 *
 * Auto-seed: cada variante sin estado se siembra con todo el histórico
 * (is_live=false); las que ya tienen estado avanzan 1 día (is_live=true). Así
 * m21 conserva su historia en vivo y w5/w10 arrancan solas en la próxima corrida.
 * Tablas paper_cedear_equity/holdings/state/trades (clave: columna variant).
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
const LB = 252, SKIP = 21, TOPK = 8, CAPITAL = 1000, FEE = 0.002;
// fee = costo por lado. 0,002 = spread CEDEAR en Cocos (comisión 0). La variante
// iol21 modela el costo real de IOL Gold (comisión 0,5%/lado + IVA 21% ≈ 0,605%
// + spread 0,2%) ≈ 0,8%/lado, misma cadencia mensual, para aislar cuánto le come
// la comisión del broker al mismo momentum.
// mode: "ruedas" rota cada `rebal` ruedas; "day17" rota el 17 de cada mes (o el
// primer día hábil siguiente si el 17 cae finde/feriado), una vez por mes.
const VARIANTS = [
  { id: "w5", mode: "ruedas", rebal: 5, fee: 0.002 },
  { id: "w10", mode: "ruedas", rebal: 10, fee: 0.002 },
  { id: "m21", mode: "day17", rebal: 21, fee: 0.002 },
  { id: "iol21", mode: "day17", rebal: 21, fee: 0.008 },
];

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

// Corre una variante: arranca de su estado (o siembra si no existe) y devuelve
// las filas a persistir. No toca la DB salvo lectura previa hecha por el caller.
function runVariant(V, ctx) {
  const { dates, px, idxOf, bhUnits, assets, state, holdingsIn } = ctx;
  const REBAL = V.rebal, FEE = V.fee;
  let cash, holdings = {}, startIdx, lastRebalIdx, live;
  if (!state) {
    // siembra: backfill completo, histórico teórico. En "ruedas" arranca
    // invirtiendo el día 1 (lastRebalIdx = LB-REBAL); en "day17" la primera
    // rotación cae en el primer cruce del 17 después de LB.
    cash = CAPITAL; startIdx = LB; live = false;
    lastRebalIdx = V.mode === "day17" ? LB : LB - REBAL;
  } else {
    cash = Number(state.cash_usd);
    for (const [t, u] of Object.entries(holdingsIn || {})) holdings[t] = u;
    const nd = dates.find((d) => d > state.last_date);
    if (!nd) return null; // sin días nuevos
    startIdx = idxOf(nd); lastRebalIdx = idxOf(state.last_rebal); live = true;
  }

  const eqRows = [], trRows = [];
  for (let i = startIdx; i < dates.length; i++) {
    // "day17": rota en el primer día hábil en/después del 17 de cada mes (una
    // vez por mes). "ruedas": cada REBAL ruedas. Comparación de ISO date como
    // string (yyyy-mm-dd ordena lexicográficamente).
    const dtI = dates[i], m17 = dtI.slice(0, 7) + "-17";
    const doRebal = V.mode === "day17"
      ? (dtI >= m17 && dates[lastRebalIdx] < m17)
      : (i - lastRebalIdx >= REBAL);
    if (doRebal) {
      const ranked = assets.map((a) => { const pa = px(a, i - SKIP), pb = px(a, i - LB); return [a, (pa && pb) ? pa / pb - 1 : -Infinity]; }).sort((x, y) => y[1] - x[1]);
      const picked = ranked.slice(0, TOPK).filter(([, m]) => m > 0).map(([a]) => a); // dual: solo momentum positivo
      let portVal = cash; for (const [t, u] of Object.entries(holdings)) { const p = px(t, i); if (p) portVal += u * p; }
      const targetUsd = portVal / TOPK;
      for (const [t, u] of Object.entries(holdings)) {
        const pt = px(t, i);
        if (!picked.includes(t) && u > 0 && pt) {
          cash += u * pt * (1 - FEE);
          trRows.push({ d: dates[i], variant: V.id, ticker: t, side: "sell", price: pt, units: u, reason: "sale del top" });
          holdings[t] = 0;
        }
      }
      for (const t of picked) {
        const pi = px(t, i); if (!pi) continue;
        const diff = targetUsd - (holdings[t] || 0) * pi;
        if (diff > pi * 0.5) {
          const spend = Math.min(diff, cash); if (spend <= 0) continue;
          const u = spend * (1 - FEE) / pi; holdings[t] = (holdings[t] || 0) + u; cash -= spend;
          trRows.push({ d: dates[i], variant: V.id, ticker: t, side: "buy", price: pi, units: u, reason: "entra/ajusta top" });
        }
      }
      lastRebalIdx = i;
    }
    let eq = cash, n = 0; for (const [t, u] of Object.entries(holdings)) { const p = px(t, i); if (u > 0 && p) { eq += u * p; n++; } }
    let bh = 0; for (const a of assets) { if (bhUnits[a] && px(a, i)) bh += bhUnits[a] * px(a, i); }
    eqRows.push({ d: dates[i], variant: V.id, equity: eq, bh_equity: bh, n_holdings: n, is_live: live });
  }
  return { cash, holdings, lastRebalIdx, eqRows, trRows };
}

(async () => {
  log(`paper-cedears — momentum Top-${TOPK} dual, variantes ${VARIANTS.map((v) => v.id).join("/")}`);
  const series = await loadSeries();
  const assets = Object.keys(series);
  // Calendario = UNIÓN de fechas con forward-fill por acción (robusto a lags de
  // Yahoo, IPOs y huecos puntuales). px() devuelve el último precio conocido.
  const allD = new Set(); for (const a of assets) for (const d of series[a].keys()) allD.add(d);
  const dates = [...allD].sort();
  const ff = {};
  for (const a of assets) { const arr = []; let last = null; for (const d of dates) { if (series[a].has(d)) last = series[a].get(d); arr.push(last); } ff[a] = arr; }
  const px = (a, i) => ff[a][i];
  const idxOf = (d) => dates.indexOf(d);
  const bhUnits = {}; for (const a of assets) { const p0 = px(a, LB); if (p0) bhUnits[a] = (CAPITAL / assets.length) * (1 - FEE) / p0; }

  // SEÑAL DE MOMENTUM FRESCA (independiente de los rebalanceos del paper): rankea
  // HOY con el último cierre disponible y escribe el Top-8 en `momentum_signal`.
  // La rutina de rebalanceo real de IOL lee de acá, así opera contra el momentum
  // del día y NO contra las tenencias viejas del paper (que rebalancea 1/mes).
  try {
    const li = dates.length - 1;
    const rk = assets.map((a) => { const pa = px(a, li - SKIP), pb = px(a, li - LB); return [a, (pa && pb) ? pa / pb - 1 : -Infinity]; })
      .filter(([, m]) => Number.isFinite(m)).sort((x, y) => y[1] - x[1]);
    const top8 = rk.slice(0, TOPK).filter(([, m]) => m > 0).map(([a]) => a);
    const { error: sigErr } = await supabase.from("momentum_signal").upsert({
      id: "current", top8,
      ranking: rk.slice(0, 15).map(([a, m]) => ({ t: a, mom: Math.round(m * 1000) / 10 })),
      as_of_date: dates[li], updated_at: new Date().toISOString(),
    }, { onConflict: "id" });
    if (sigErr) log("momentum_signal error: " + sigErr.message);
    else log(`momentum_signal actualizado (${dates[li]}): ${top8.join(", ")}`);
  } catch (e) { log("momentum_signal excepcion: " + (e && e.message)); }

  // estado + holdings actuales, agrupados por variante
  const { data: stArr } = await supabase.from("paper_cedear_state").select("*");
  const { data: hArr } = await supabase.from("paper_cedear_holdings").select("*");
  const stateBy = {}; for (const s of stArr || []) stateBy[s.id] = s;
  const holdBy = {}; for (const h of hArr || []) { (holdBy[h.variant || "m21"] ||= {})[h.ticker] = Number(h.units); }

  const ctx = { dates, px, idxOf, bhUnits, assets };
  for (const V of VARIANTS) {
    const r = runVariant(V, { ...ctx, state: stateBy[V.id], holdingsIn: holdBy[V.id] });
    if (!r) { log(`${V.id}: sin días nuevos`); continue; }

    for (let k = 0; k < r.eqRows.length; k += 500) {
      const { error } = await supabase.from("paper_cedear_equity").upsert(r.eqRows.slice(k, k + 500), { onConflict: "d,variant" });
      if (error) throw new Error(`${V.id} equity: ` + error.message);
    }
    if (r.trRows.length) { const { error } = await supabase.from("paper_cedear_trades").insert(r.trRows); if (error) throw new Error(`${V.id} trades: ` + error.message); }
    await supabase.from("paper_cedear_holdings").delete().eq("variant", V.id);
    const hold = Object.entries(r.holdings).filter(([, u]) => u > 0).map(([t, u]) => ({ ticker: t, variant: V.id, units: u, weight: null, updated_at: new Date().toISOString() }));
    if (hold.length) await supabase.from("paper_cedear_holdings").insert(hold);
    await supabase.from("paper_cedear_state").upsert({ id: V.id, cash_usd: r.cash, last_date: dates[dates.length - 1], last_rebal: dates[r.lastRebalIdx], updated_at: new Date().toISOString() }, { onConflict: "id" });

    const le = r.eqRows[r.eqRows.length - 1];
    log(`${V.id}: ${r.eqRows.length} días, ${r.trRows.length} trades, equity ${le.equity.toFixed(0)} vs b&h ${le.bh_equity.toFixed(0)}, ${le.n_holdings} holdings${stateBy[V.id] ? "" : " [seed]"}`);
  }
  process.exit(0);
})().catch((e) => { log("ERROR: " + e.message); process.exit(1); });
