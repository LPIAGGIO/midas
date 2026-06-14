/**
 * Worker: paper-trader — paper trading de VARIAS variantes de trend-following
 * cripto sobre Kraken, en paralelo, para compararlas. Capital simulado USD
 * 1000 por estrategia (repartido en partes iguales entre sus activos).
 *
 * Estrategias (todas SMA crossover 20/100 sobre cierre diario, fee 0,26%):
 *   - trend        : 20/100 en BTC+ETH (la original).
 *   - trend_filt   : 20/100 + filtro anti-whipsaw — solo va long si la media
 *                    lenta ADEMÁS viene subiendo (slow[i] > slow[i-20]); evita
 *                    comprar en repuntes falsos dentro de un downtrend.
 *   - trend_multi  : 20/100 en BTC+ETH+SOL (diversifica).
 *
 * Modos: --init siembra el histórico (is_live=false); sin flag = run diario
 * (PM2 cron, is_live=true). Tablas paper_equity/paper_trades/paper_state con
 * columna `strategy`. Idempotente (upsert por (strategy,d,asset)).
 */
require("dotenv").config();
const https = require("https");
const { createClient } = require("@supabase/supabase-js");
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = require("ws");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const FAST = 20, SLOW = 100, FEE = 0.0026, FILTER_LOOKBACK = 20, CAPITAL = 1000;
const PAIRS = { BTC: "XBTUSD", ETH: "ETHUSD", SOL: "SOLUSD" };
const STRATS = [
  { id: "trend", label: "Tendencia 20/100", filter: false, assets: ["BTC", "ETH"] },
  { id: "trend_filt", label: "Tendencia + filtro", filter: true, assets: ["BTC", "ETH"] },
  { id: "trend_multi", label: "Tendencia multi-activo", filter: false, assets: ["BTC", "ETH", "SOL"] },
];
const INIT = process.argv.includes("--init");

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const get = (url) => new Promise((res, rej) => https.get(url, { headers: { "User-Agent": "Midas/paper-trader" } }, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on("error", rej));
const sma = (arr, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k]; return s / n; };

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

  const { data: stRows } = await supabase.from("paper_state").select("*").eq("strategy", strat.id).eq("asset", asset);
  let st = stRows && stRows[0];
  let startIdx;
  if (!st) {
    st = { position: "cash", units: 0, cash_usd: sleeveCapital, entry_price: null, last_date: null };
    startIdx = SLOW;
  } else {
    startIdx = rows.findIndex((r) => r.d > st.last_date);
    if (startIdx < 0) return;
  }

  const bhStartPrice = closes[SLOW];
  const bhUnits = (sleeveCapital * (1 - FEE)) / bhStartPrice;
  const eqRows = [], trRows = [];

  for (let i = startIdx; i < rows.length; i++) {
    const price = closes[i];
    const f = sma(closes, i, FAST), s = sma(closes, i, SLOW);
    let wantLong = f != null && s != null && f > s;
    if (wantLong && strat.filter) {
      const sPast = sma(closes, i - FILTER_LOOKBACK, SLOW);
      wantLong = sPast != null && s > sPast; // media lenta subiendo
    }

    if (wantLong && st.position === "cash") {
      const fee = st.cash_usd * FEE;
      st.units = (st.cash_usd * (1 - FEE)) / price;
      st.cash_usd = 0; st.position = "long"; st.entry_price = price;
      trRows.push({ strategy: strat.id, d: rows[i].d, asset, side: "buy", price, units: st.units, fee_usd: fee, equity_after: st.units * price, reason: strat.filter ? `SMA${FAST}>SMA${SLOW} + lenta↑` : `SMA${FAST}>SMA${SLOW}` });
    } else if (!wantLong && st.position === "long") {
      const gross = st.units * price, fee = gross * FEE, u = st.units;
      st.cash_usd = gross * (1 - FEE); st.units = 0; st.position = "cash"; st.entry_price = null;
      trRows.push({ strategy: strat.id, d: rows[i].d, asset, side: "sell", price, units: u, fee_usd: fee, equity_after: st.cash_usd, reason: `SMA${FAST}<SMA${SLOW}` });
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
  const { error: e2 } = await supabase.from("paper_state").upsert({ strategy: strat.id, asset, position: st.position, units: st.units, cash_usd: st.cash_usd, entry_price: st.entry_price, last_date: st.last_date, updated_at: new Date().toISOString() }, { onConflict: "strategy,asset" });
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
