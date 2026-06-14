/**
 * Worker: paper-trader — paper trading de VARIAS variantes de estrategia
 * cripto sobre Kraken, en paralelo, para compararlas. Capital simulado USD
 * 1000 por estrategia (repartido en partes iguales entre sus activos).
 *
 * Estrategias (fee 0,26%/lado, cierre diario):
 *   trend       : SMA 20/100, BTC+ETH (la original).
 *   trend_filt  : 20/100 + filtro anti-whipsaw (solo long si la lenta sube).
 *   trend_multi : 20/100, BTC+ETH+SOL (diversifica).
 *   trend_stop  : 20/100 + stop-loss 12% desde la entrada (corta pérdidas;
 *                 no re-entra hasta un cruce alcista nuevo).
 *   trend_slow  : SMA 50/200 (cruce lento, casi sin whipsaws).
 *   donchian    : ruptura de canal 50 días (long si rompe el máximo de 50,
 *                 cash si rompe el mínimo; mantiene entre medio).
 *
 * Modos: --init siembra el histórico (is_live=false); sin flag = run diario.
 * Tablas paper_equity/paper_trades/paper_state (columna strategy + stopped).
 */
require("dotenv").config();
const https = require("https");
const { createClient } = require("@supabase/supabase-js");
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = require("ws");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FEE = 0.0026, FILTER_LOOKBACK = 20, CAPITAL = 1000;
const PAIRS = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
const STRATS = [
  { id: "trend", label: "Tendencia 20/100", type: "sma", fast: 20, slow: 100, assets: ["BTC", "ETH"] },
  { id: "trend_filt", label: "+ Filtro anti-whipsaw", type: "sma", fast: 20, slow: 100, filter: true, assets: ["BTC", "ETH"] },
  { id: "trend_multi", label: "Multi-activo (+SOL)", type: "sma", fast: 20, slow: 100, assets: ["BTC", "ETH", "SOL"] },
  { id: "trend_stop", label: "+ Stop-loss 12%", type: "sma", fast: 20, slow: 100, stop: 0.12, assets: ["BTC", "ETH"] },
  { id: "trend_stop8", label: "+ Stop-loss 8%", type: "sma", fast: 20, slow: 100, stop: 0.08, assets: ["BTC", "ETH"] },
  { id: "trend_stop18", label: "+ Stop-loss 18%", type: "sma", fast: 20, slow: 100, stop: 0.18, assets: ["BTC", "ETH"] },
  { id: "trend_slow", label: "Cruce lento 50/200", type: "sma", fast: 50, slow: 200, assets: ["BTC", "ETH"] },
  { id: "donchian", label: "Ruptura 50 días", type: "donchian", n: 50, assets: ["BTC", "ETH"] },
];
const INIT = process.argv.includes("--init");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const get = (url) => new Promise((res, rej) => https.get(url, { headers: { "User-Agent": "Midas/paper-trader" } }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
const sma = (arr, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k]; return s / n; };

// Señal long/cash según el tipo de estrategia. currentLong = posición previa
// (donchian la mantiene entre bordes del canal).
function wantLongSignal(closes, i, cfg, currentLong) {
  if (cfg.type === "donchian") {
    if (i < cfg.n) return false;
    let hi = -Infinity, lo = Infinity;
    for (let k = i - cfg.n; k < i; k++) { if (closes[k] > hi) hi = closes[k]; if (closes[k] < lo) lo = closes[k]; }
    if (closes[i] > hi) return true;
    if (closes[i] < lo) return false;
    return currentLong;
  }
  const f = sma(closes, i, cfg.fast), s = sma(closes, i, cfg.slow);
  if (f == null || s == null) return false;
  let long = f > s;
  if (cfg.filter) { const sp = sma(closes, i - FILTER_LOOKBACK, cfg.slow); long = long && sp != null && s > sp; }
  return long;
}

const candleCache = {};
async function fetchDaily(asset) {
  if (candleCache[asset]) return candleCache[asset];
  const j = await get(`https://api.kraken.com/0/public/OHLC?pair=${PAIRS[asset]}&interval=1440`);
  if (j.error && j.error.length) throw new Error("Kraken " + asset + ": " + j.error.join(","));
  const key = Object.keys(j.result).find((x) => x !== "last");
  const today = new Date().toISOString().slice(0, 10);
  const rows = j.result[key].map((r) => ({ d: new Date(r[0] * 1000).toISOString().slice(0, 10), close: Number(r[4]) })).filter((c) => c.d < today);
  candleCache[asset] = rows;
  return rows;
}

async function runSleeve(strat, asset) {
  const rows = await fetchDaily(asset);
  const closes = rows.map((c) => c.close);
  const sleeveCapital = CAPITAL / strat.assets.length;
  const warmup = strat.type === "donchian" ? strat.n : strat.slow;

  const { data: stRows } = await supabase.from("paper_state").select("*").eq("strategy", strat.id).eq("asset", asset);
  let st = stRows && stRows[0];
  let startIdx;
  if (!st) {
    st = { position: "cash", units: 0, cash_usd: sleeveCapital, entry_price: null, last_date: null, stopped: false };
    startIdx = warmup;
  } else {
    startIdx = rows.findIndex((r) => r.d > st.last_date);
    if (startIdx < 0) return null;
  }

  const bhUnits = (sleeveCapital * (1 - FEE)) / closes[warmup];
  const eqRows = [], trRows = [];

  for (let i = startIdx; i < rows.length; i++) {
    const price = closes[i];
    const wantLong = wantLongSignal(closes, i, strat, st.position === "long");
    const stopHit = st.position === "long" && strat.stop && st.entry_price && price <= st.entry_price * (1 - strat.stop);

    if (st.position === "long") {
      if (stopHit) {
        const gross = st.units * price, fee = gross * FEE, u = st.units;
        st.cash_usd = gross * (1 - FEE); st.units = 0; st.position = "cash"; st.entry_price = null; st.stopped = true;
        trRows.push({ strategy: strat.id, d: rows[i].d, asset, side: "sell", price, units: u, fee_usd: fee, equity_after: st.cash_usd, reason: `stop −${(strat.stop * 100).toFixed(0)}%` });
      } else if (!wantLong) {
        const gross = st.units * price, fee = gross * FEE, u = st.units;
        st.cash_usd = gross * (1 - FEE); st.units = 0; st.position = "cash"; st.entry_price = null; st.stopped = false;
        trRows.push({ strategy: strat.id, d: rows[i].d, asset, side: "sell", price, units: u, fee_usd: fee, equity_after: st.cash_usd, reason: "señal de salida" });
      }
    } else { // cash
      if (!wantLong) {
        st.stopped = false; // señal abajo: reseteo el bloqueo de stop, listo para el próximo cruce
      } else if (wantLong && !st.stopped) {
        const fee = st.cash_usd * FEE;
        st.units = (st.cash_usd * (1 - FEE)) / price; st.cash_usd = 0; st.position = "long"; st.entry_price = price;
        trRows.push({ strategy: strat.id, d: rows[i].d, asset, side: "buy", price, units: st.units, fee_usd: fee, equity_after: st.units * price, reason: "señal de entrada" });
      }
    }

    const sleeveEquity = st.position === "long" ? st.units * price : st.cash_usd;
    eqRows.push({ strategy: strat.id, d: rows[i].d, asset, price, position: st.position, sleeve_equity: sleeveEquity, bh_equity: bhUnits * price, is_live: !INIT });
    st.last_date = rows[i].d;
  }

  for (let k = 0; k < eqRows.length; k += 500) {
    const { error } = await supabase.from("paper_equity").upsert(eqRows.slice(k, k + 500), { onConflict: "strategy,d,asset" });
    if (error) throw new Error(`paper_equity ${strat.id}/${asset}: ${error.message}`);
  }
  if (trRows.length) {
    const { error } = await supabase.from("paper_trades").insert(trRows);
    if (error) throw new Error(`paper_trades ${strat.id}/${asset}: ${error.message}`);
  }
  const { error: e2 } = await supabase.from("paper_state").upsert({ strategy: strat.id, asset, position: st.position, units: st.units, cash_usd: st.cash_usd, entry_price: st.entry_price, last_date: st.last_date, stopped: st.stopped, updated_at: new Date().toISOString() }, { onConflict: "strategy,asset" });
  if (e2) throw new Error(`paper_state ${strat.id}/${asset}: ${e2.message}`);
  return eqRows.length ? eqRows[eqRows.length - 1].sleeve_equity : null;
}

(async () => {
  log(`paper-trader ${INIT ? "[INIT]" : "[diario]"} — ${STRATS.length} estrategias, fee ${FEE}`);
  for (const strat of STRATS) {
    let total = 0, ok = true;
    for (const asset of strat.assets) {
      try { const eq = await runSleeve(strat, asset); total += eq || 0; } catch (e) { ok = false; log(`ERROR ${strat.id}/${asset}: ${e.message}`); }
    }
    if (ok) log(`${strat.id} (${strat.label}): equity total ${total.toFixed(2)}`);
  }
  log("Fin.");
  process.exit(0);
})();
