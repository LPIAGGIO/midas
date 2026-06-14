/**
 * Worker: paper-trader — simulación (paper) de la estrategia trend-following
 * cripto sobre Kraken, con capital ficticio de USD 1000 (500 BTC + 500 ETH).
 *
 * Estrategia (validada en research 14/06): SMA crossover 20/100 sobre el
 * cierre diario. Señal long si SMA20 > SMA100, cash (USD) si no. Cada cambio
 * de posición paga fee 0,26% (taker Kraken). Pocas operaciones/año → el fee
 * no la mata; bate buy&hold net de fees y corta pérdidas en bajadas.
 *
 * Modos:
 *   node worker.js --init   → siembra el histórico (720 velas diarias de
 *                             Kraken) simulando como si hubiéramos arrancado
 *                             hace ~2 años. Marca is_live=false (retrospectivo).
 *   node worker.js          → run diario (PM2 cron): procesa los días nuevos
 *                             desde la última fecha guardada, is_live=true.
 *
 * Tablas: paper_equity (curva diaria por sleeve + benchmark buy&hold),
 *         paper_trades (cada operación), paper_state (posición actual).
 * Fuente: Kraken OHLC público (sin keys). Idempotente (upserts por (d,asset)).
 */
require("dotenv").config();
const https = require("https");
const { createClient } = require("@supabase/supabase-js");
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = require("ws");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FAST = 20, SLOW = 100, FEE = 0.0026, SLEEVE_CAPITAL = 500;
const ASSETS = [{ asset: "BTC", pair: "XBTUSD" }, { asset: "ETH", pair: "ETHUSD" }];
const INIT = process.argv.includes("--init");

const log = (m, x) => console.log(`[${new Date().toISOString()}] ${m}`, x ? JSON.stringify(x) : "");
const get = (url) => new Promise((res, rej) => https.get(url, { headers: { "User-Agent": "Midas/paper-trader" } }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
const sma = (arr, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k]; return s / n; };

async function fetchDaily(pair) {
  const j = await get(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440`);
  if (j.error && j.error.length) throw new Error("Kraken: " + j.error.join(","));
  const key = Object.keys(j.result).find((x) => x !== "last");
  return j.result[key].map((r) => ({ d: new Date(r[0] * 1000).toISOString().slice(0, 10), close: Number(r[4]) }));
}

async function runAsset({ asset, pair }) {
  const candles = await fetchDaily(pair);
  // Excluir la vela del día en curso (incompleta): la última de Kraken es hoy parcial.
  const today = new Date().toISOString().slice(0, 10);
  const rows = candles.filter((c) => c.d < today);
  const closes = rows.map((c) => c.close);

  // Estado previo
  const { data: stRows } = await supabase.from("paper_state").select("*").eq("asset", asset);
  let st = stRows && stRows[0];
  let startIdx;
  if (!st) {
    // Init: arranca en el primer día con SLOW SMA disponible, en cash.
    st = { asset, position: "cash", units: 0, cash_usd: SLEEVE_CAPITAL, entry_price: null, last_date: null };
    startIdx = SLOW; // primer índice con SMA lenta
  } else {
    startIdx = rows.findIndex((r) => r.d > st.last_date);
    if (startIdx < 0) { log(`${asset}: sin días nuevos`); return; }
  }

  // benchmark buy&hold: $500 comprados el día startIdx (1 fee), mantenidos.
  const bhStartPrice = closes[Math.max(SLOW, 0)];
  const bhUnits = (SLEEVE_CAPITAL * (1 - FEE)) / bhStartPrice;

  const equityRows = [], tradeRows = [];
  for (let i = startIdx; i < rows.length; i++) {
    const price = closes[i];
    const f = sma(closes, i, FAST), s = sma(closes, i, SLOW);
    const wantLong = f != null && s != null && f > s;

    // Rebalanceo al cierre del día i según la señal.
    if (wantLong && st.position === "cash") {
      st.units = (st.cash_usd * (1 - FEE)) / price;
      const fee = st.cash_usd * FEE;
      st.cash_usd = 0; st.position = "long"; st.entry_price = price;
      tradeRows.push({ d: rows[i].d, asset, side: "buy", price, units: st.units, fee_usd: fee, equity_after: st.units * price, reason: `SMA${FAST}>SMA${SLOW}` });
    } else if (!wantLong && st.position === "long") {
      const gross = st.units * price;
      const fee = gross * FEE;
      st.cash_usd = gross * (1 - FEE);
      const u = st.units; st.units = 0; st.position = "cash"; st.entry_price = null;
      tradeRows.push({ d: rows[i].d, asset, side: "sell", price, units: u, fee_usd: fee, equity_after: st.cash_usd, reason: `SMA${FAST}<SMA${SLOW}` });
    }

    const sleeveEquity = st.position === "long" ? st.units * price : st.cash_usd;
    const bhEquity = bhUnits * price;
    equityRows.push({ d: rows[i].d, asset, price, position: st.position, sleeve_equity: sleeveEquity, bh_equity: bhEquity, is_live: !INIT });
    st.last_date = rows[i].d;
  }

  if (equityRows.length) {
    for (let k = 0; k < equityRows.length; k += 500) {
      const { error } = await supabase.from("paper_equity").upsert(equityRows.slice(k, k + 500), { onConflict: "d,asset" });
      if (error) throw new Error(`paper_equity ${asset}: ${error.message}`);
    }
  }
  if (tradeRows.length) {
    const { error } = await supabase.from("paper_trades").insert(tradeRows);
    if (error) throw new Error(`paper_trades ${asset}: ${error.message}`);
  }
  const { error: stErr } = await supabase.from("paper_state").upsert({
    asset, position: st.position, units: st.units, cash_usd: st.cash_usd,
    entry_price: st.entry_price, last_date: st.last_date, updated_at: new Date().toISOString(),
  }, { onConflict: "asset" });
  if (stErr) throw new Error(`paper_state ${asset}: ${stErr.message}`);

  const finalEq = equityRows.length ? equityRows[equityRows.length - 1] : null;
  log(`${asset}: ${equityRows.length} días, ${tradeRows.length} trades, equity ${finalEq ? finalEq.sleeve_equity.toFixed(2) : "?"} vs b&h ${finalEq ? finalEq.bh_equity.toFixed(2) : "?"}, pos ${st.position}`);
}

(async () => {
  log(`paper-trader inicio ${INIT ? "[INIT histórico]" : "[run diario]"} — SMA ${FAST}/${SLOW}, fee ${FEE}, $${SLEEVE_CAPITAL}/sleeve`);
  for (const a of ASSETS) {
    try { await runAsset(a); } catch (e) { log(`ERROR ${a.asset}: ${e.message}`); }
  }
  log("Fin.");
  process.exit(0);
})();
