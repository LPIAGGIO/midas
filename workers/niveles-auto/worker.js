/**
 * Worker niveles-auto: análisis técnico automático de papeles → alertas BOT
 * en la pantalla "Alertas TV · Bot" de Midas.
 *
 * Dos disparadores:
 *  1. MANUAL (pre-compra): filas pending en tv_analysis_queue (las carga LP
 *     desde la pantalla ANTES de comprar → le dice a cuánto conviene entrar).
 *  2. PORTFOLIO (post-compra): posiciones cedear/stock NUEVAS (últimas 24h)
 *     de cualquier broker EXCEPTO 'iol' (el test de momentum no se toca),
 *     que no tengan ya un análisis en la cola.
 *
 * Para cada ticker: velas del subyacente USA vía Yahoo (diario 1y + 60m 1mes),
 * pivotes con confirmación (misma lógica que el Pine "Midas Niveles Auto"):
 *  - Soporte diario  → alerta dir=down "zona de COMPRA"
 *  - Resistencia diaria → alerta dir=up "venta / tomar ganancia"
 *  - Niveles horarios como afinación si están más cerca del precio.
 * Conversión a ARS: usd × CCL ÷ ratio, con ratio DERIVADO en vivo del feed
 * (data912: cedear ARS vs subyacente USD) — sin mapa hardcodeado.
 *
 * Idempotente: no duplica alertas AUTO no disparadas del mismo ticker+nivel;
 * al recalcular, borra las AUTO viejas no disparadas y crea las nuevas.
 * Schedule: PM2 cron cada 5 min, lun-vie 10:00-18:55 ART (ecosystem.config.js).
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const LB = 5; // barras de confirmación del pivote (igual que el Pine)

async function yahooCandles(sym, interval, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, { headers: UA });
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < (res.timestamp || []).length; i++) {
    if (q.high?.[i] != null && q.low?.[i] != null && q.close?.[i] != null) out.push({ h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out.length ? out : null;
}

// Último pivote confirmado (máximo local con LB barras a cada lado).
function pivots(candles, lb = LB) {
  let res = null, sop = null;
  for (let i = lb; i < candles.length - lb; i++) {
    let isHi = true, isLo = true;
    for (let k = i - lb; k <= i + lb; k++) {
      if (candles[k].h > candles[i].h) isHi = false;
      if (candles[k].l < candles[i].l) isLo = false;
      if (!isHi && !isLo) break;
    }
    if (isHi) res = candles[i].h;
    if (isLo) sop = candles[i].l;
  }
  return { res, sop };
}

async function main() {
  log("niveles-auto arrancando");

  // CCL + feeds para ratio en vivo
  const [dolRes, usaRes, cedRes] = await Promise.all([
    fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).then((r) => r.json()).catch(() => null),
    fetch("https://data912.com/live/usa_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/arg_cedears", { headers: UA }).then((r) => r.json()).catch(() => []),
  ]);
  const ccl = Number(dolRes?.venta) || Number(dolRes?.compra);
  if (!ccl) { log("sin CCL, abort"); return; }
  const usdPx = {}, arsPx = {};
  for (const it of usaRes || []) if (it?.symbol && Number(it.c) > 0) usdPx[it.symbol.toUpperCase()] = Number(it.c);
  for (const it of cedRes || []) if (it?.symbol && Number(it.c) > 0) arsPx[it.symbol.toUpperCase()] = Number(it.c);

  // 1. Cola manual pendiente
  const { data: queue } = await supabase.from("tv_analysis_queue").select("*").eq("status", "pending").limit(20);
  const jobs = (queue || []).map((q) => ({ ...q, ticker: q.ticker.toUpperCase().trim() }));

  // 2. Posiciones nuevas (24h) de brokers != iol, sin análisis previo
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: newPos } = await supabase.from("positions")
    .select("user_id,ticker,broker,created_at")
    .in("instrument_type", ["cedear", "stock"]).neq("broker", "iol").gte("created_at", since);
  for (const p of newPos || []) {
    const tk = (p.ticker || "").toUpperCase().trim();
    if (!tk || jobs.some((j) => j.ticker === tk && j.user_id === p.user_id)) continue;
    const { data: prev } = await supabase.from("tv_analysis_queue").select("id").eq("user_id", p.user_id).eq("ticker", tk).gte("created_at", since).limit(1);
    if (prev && prev.length) continue;
    const { data: ins } = await supabase.from("tv_analysis_queue").insert({ user_id: p.user_id, ticker: tk, source: "portfolio" }).select().single();
    if (ins) jobs.push(ins);
  }

  if (!jobs.length) { log("sin trabajos"); return; }

  for (const job of jobs) {
    const tk = job.ticker;
    try {
      const [daily, hourly] = await Promise.all([
        yahooCandles(tk, "1d", "1y"),
        yahooCandles(tk, "60m", "1mo"),
      ]);
      if (!daily) throw new Error("sin velas Yahoo");
      const d = pivots(daily, LB);
      const h = hourly ? pivots(hourly, LB) : { res: null, sop: null };
      const spot = usdPx[tk] ?? daily[daily.length - 1].c;

      // Nivel de compra = soporte más CERCANO por debajo del precio (el horario
      // afina si está entre el diario y el precio). Venta = resistencia más
      // cercana por encima.
      const sops = [d.sop, h.sop].filter((x) => x != null && x < spot);
      const ress = [d.res, h.res].filter((x) => x != null && x > spot);
      const buyLvl = sops.length ? Math.max(...sops) : null;
      const sellLvl = ress.length ? Math.min(...ress) : null;

      // Ratio en vivo: (usd × ccl) / precio del cedear en ARS.
      const ratio = arsPx[tk] > 0 && usdPx[tk] > 0 ? Math.max(1, Math.round((usdPx[tk] * ccl) / arsPx[tk])) : null;
      if (!ratio) throw new Error("sin ratio (no está el CEDEAR en el feed)");

      // Limpiar alertas AUTO previas NO disparadas de este ticker/usuario
      await supabase.from("price_alerts").delete().eq("user_id", job.user_id).eq("ticker", tk).eq("origen", "tv").is("triggered_at", null).like("nota", "AUTO an%");

      const mk = (usd, dir, nota) => ({
        user_id: job.user_id, ticker: tk, price: Math.round((usd * ccl) / ratio),
        dir, nota, usd_ref: Math.round(usd * 100) / 100, canal: "screen", origen: "tv",
      });
      const rows = [];
      if (buyLvl) rows.push(mk(buyLvl, "down", `AUTO análisis: zona de COMPRA — soporte US$${buyLvl.toFixed(2)} (pivote ${buyLvl === d.sop ? "diario" : "horario"})`));
      if (sellLvl) rows.push(mk(sellLvl, "up", `AUTO análisis: resistencia US$${sellLvl.toFixed(2)} (pivote ${sellLvl === d.res ? "diario" : "horario"}) — venta/tomar ganancia`));
      if (rows.length) { const { error } = await supabase.from("price_alerts").insert(rows); if (error) throw new Error(error.message); }

      await supabase.from("tv_analysis_queue").update({
        status: "done", processed_at: new Date().toISOString(),
        result: { spot_usd: spot, buy_usd: buyLvl, sell_usd: sellLvl, daily: d, hourly: h, ratio, ccl },
      }).eq("id", job.id);
      log(`${tk}: compra ${buyLvl ? buyLvl.toFixed(2) : "-"} / venta ${sellLvl ? sellLvl.toFixed(2) : "-"} (ratio ${ratio})`);
    } catch (e) {
      await supabase.from("tv_analysis_queue").update({ status: "error", processed_at: new Date().toISOString(), result: { error: e.message } }).eq("id", job.id);
      log(`${tk} ERROR: ${e.message}`);
    }
  }
  log("niveles-auto OK");
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e.message); process.exit(1); });
