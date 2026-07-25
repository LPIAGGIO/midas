/**
 * Worker niveles-auto v5: análisis técnico automático de papeles → alertas BOT
 * en la pantalla "Alertas TV · Bot" de Midas.
 *
 * Disparador: 100% MANUAL — filas pending en tv_analysis_queue (LP encola papel
 * por papel desde la pantalla). El escaneo de portfolio se desactivó (23/07).
 *
 * Motor v5 (24/07): en vez de "el último pivote", el bot construye ZONAS:
 *  - Junta TODOS los pivotes confirmados (diario 1y lb=5 + 60m 1mes lb=5) y
 *    los agrupa en zonas de ±0,6%. Una zona con 3 toques vale más que una
 *    mecha suelta.
 *  - Cada zona se puntúa (score 1-10): toques, volumen del pivote vs SMA20,
 *    confluencia con EMA 21/50/200 diaria, confluencia diario+horario.
 *  - Contexto: régimen de mercado (SPY y QQQ vs EMA50 → risk_on/off/mixto),
 *    RSI14 del papel, y distancia a earnings (aviso si <7 días).
 *  - Kit: entrada (zona soporte más cercana) + STOP LOSS (piso de la zona
 *    inferior o 1×ATR) + take profit (zona resistencia) con R:R calculado.
 *    Si la entrada cercana es solo horaria (scalp) y hay zona diaria más
 *    abajo, emite también la entrada swing.
 *  - FEEDBACK LOOP: cada nivel emitido se registra en nivel_track y una
 *    pasada horaria mide qué hizo el precio 1/5/10 ruedas después y si tocó.
 *    En unos meses eso dice qué tipos de nivel del bot funcionan de verdad.
 *
 * Conversión a ARS: usd × CCL ÷ ratio (ratio derivado en vivo del feed).
 * Idempotente: borra las AUTO no disparadas del ticker antes de recrear.
 * PM2 PERSISTENTE: cola cada 60s las 24hs; tracks cada 60 min.
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
const LB = 5;        // barras de confirmación del pivote (igual que el Pine)
const ZONE_TOL = 0.006; // ±0,6%: pivotes a esa distancia son la misma zona

// Acciones argentinas → su ADR en NYSE (ratio = acciones locales por ADR).
const ARG_ADR = {
  YPFD: { adr: "YPF", r: 1 }, GGAL: { adr: "GGAL", r: 10 }, PAMP: { adr: "PAM", r: 25 },
  BMA: { adr: "BMA", r: 10 }, CEPU: { adr: "CEPU", r: 10 }, EDN: { adr: "EDN", r: 20 },
  LOMA: { adr: "LOMA", r: 5 }, SUPV: { adr: "SUPV", r: 5 }, TGSU2: { adr: "TGS", r: 5 },
  CRES: { adr: "CRESY", r: 10 }, IRSA: { adr: "IRS", r: 10 }, BBAR: { adr: "BBAR", r: 3 },
  TECO2: { adr: "TEO", r: 5 },
};

/* ───────── Yahoo: auth (para quoteSummary) y velas ───────── */
let _yAuth = null;
async function yahooAuth() {
  if (_yAuth) return _yAuth;
  const r = await fetch("https://fc.yahoo.com", { headers: UA });
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
  const cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, Cookie: cookie } });
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("sin crumb Yahoo");
  _yAuth = { cookie, crumb };
  return _yAuth;
}
const yraw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));

// Contexto fundamental: earnings + target analistas. Upsertea ticker_context
// para la pantalla Y devuelve los datos (el kit los usa para el aviso).
async function tickerContext(symUsa, tk) {
  try {
    const a = await yahooAuth();
    const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symUsa)}?modules=calendarEvents,financialData,defaultKeyStatistics,summaryDetail&crumb=${encodeURIComponent(a.crumb)}`;
    const r = await fetch(u, { headers: { ...UA, Cookie: a.cookie } });
    const j = await r.json();
    const res = j?.quoteSummary?.result?.[0];
    if (!res) return null;
    const eDates = res.calendarEvents?.earnings?.earningsDate || [];
    const eRaw = yraw(eDates[0]);
    const earnings = eRaw ? new Date(eRaw * 1000).toISOString().slice(0, 10) : null;
    const target = yraw(res.financialData?.targetMeanPrice);
    const reco = res.financialData?.recommendationKey || null;
    // Snapshot fundamental compacto para la card de Research del día.
    const ks = res.defaultKeyStatistics || {}, fd = res.financialData || {}, sd = res.summaryDetail || {};
    const fund = {
      peFwd: yraw(ks.forwardPE) ?? yraw(sd.forwardPE),
      revG: yraw(fd.revenueGrowth),          // crecimiento ingresos i.a. (fracción)
      margin: yraw(fd.profitMargins),        // margen neto (fracción)
      shortF: yraw(ks.shortPercentOfFloat),  // short float (fracción)
      beta: yraw(sd.beta),
      divY: yraw(sd.dividendYield),          // fracción
      cap: yraw(sd.marketCap) ?? yraw(ks.enterpriseValue),
    };
    const hasFund = Object.values(fund).some((v) => v != null);
    // Titulares recientes del ticker (Yahoo search): la pantalla los muestra
    // en el grupo — información fresca sin esperar el brief matinal.
    let news = null;
    try {
      const nr = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symUsa)}&newsCount=5&quotesCount=0`, { headers: UA });
      const nj = await nr.json();
      news = (nj?.news || []).slice(0, 5).map((n) => ({ title: n.title, link: n.link, pub: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null, src: n.publisher || null }));
      if (!news.length) news = null;
    } catch { /* sin titulares no es error */ }
    await supabase.from("ticker_context").upsert({ ticker: tk, earnings_date: earnings, target_mean: target, recommendation: reco, news, fund: hasFund ? fund : null, updated_at: new Date().toISOString() }, { onConflict: "ticker" });
    return { earnings, target };
  } catch (e) { log(`[contexto ${tk}] ${e.message}`); return null; }
}

async function yahooCandles(sym, interval, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, { headers: UA });
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < (res.timestamp || []).length; i++) {
    if (q.high?.[i] != null && q.low?.[i] != null && q.close?.[i] != null) {
      out.push({ ts: res.timestamp[i], t: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), o: q.open?.[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume?.[i] || 0 });
    }
  }
  return out.length ? out : null;
}

/* ───────── Motor de zonas ───────── */
// TODOS los pivotes confirmados (no solo el último), con volumen relativo
// del pivote vs la SMA20 de volumen previa (¿el mercado defendió el nivel?).
function allPivots(candles, lb, tf) {
  const his = [], los = [];
  for (let i = lb; i < candles.length - lb; i++) {
    let isHi = true, isLo = true;
    for (let k = i - lb; k <= i + lb; k++) {
      if (candles[k].h > candles[i].h) isHi = false;
      if (candles[k].l < candles[i].l) isLo = false;
      if (!isHi && !isLo) break;
    }
    if (!isHi && !isLo) continue;
    const from = Math.max(0, i - 20);
    const win = candles.slice(from, i);
    const avg = win.reduce((s, c) => s + c.v, 0) / Math.max(1, win.length);
    const vr = avg > 0 ? candles[i].v / avg : 1;
    if (isHi) his.push({ p: candles[i].h, i, tf, vr });
    if (isLo) los.push({ p: candles[i].l, i, tf, vr });
  }
  return { his, los };
}

// Agrupa pivotes en zonas de ±tol. Una zona junta toques de ambas temporalidades.
function clusterZones(pivs, tol = ZONE_TOL) {
  const sorted = [...pivs].sort((a, b) => a.p - b.p);
  const zones = [];
  for (const pv of sorted) {
    const z = zones[zones.length - 1];
    if (z && Math.abs(pv.p - z.avg) / z.avg <= tol) {
      z.members.push(pv);
      z.avg = z.members.reduce((s, m) => s + m.p, 0) / z.members.length;
    } else zones.push({ avg: pv.p, members: [pv] });
  }
  return zones.map((z) => ({
    lo: Math.min(...z.members.map((m) => m.p)),
    hi: Math.max(...z.members.map((m) => m.p)),
    avg: z.avg,
    touches: z.members.length,
    hasD: z.members.some((m) => m.tf === "d"),
    hasH: z.members.some((m) => m.tf === "h"),
    volMax: Math.max(...z.members.map((m) => m.vr || 1)),
  }));
}

function emaOf(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let e = closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}
function rsi14(closes) {
  if (closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return g + l === 0 ? 50 : Math.round((100 * g) / (g + l));
}

// Score 1-10 de una zona: toques + volumen + confluencia EMA + confluencia TF.
function scoreZone(z, emas) {
  let s = 3;
  if (z.touches >= 3) s += 2; else if (z.touches === 2) s += 1;
  if (z.volMax >= 1.5) s += 2; else if (z.volMax >= 1.2) s += 1;
  const emaHit = Object.entries(emas)
    .filter(([, v]) => v != null && Math.abs(v - z.avg) / z.avg <= 0.007)
    .map(([n]) => "EMA" + n);
  if (emaHit.length) s += 2;
  if (z.hasD && z.hasH) s += 1;
  return { score: Math.min(10, s), emaHit };
}

/* ───────── Señales de velas y volumen (v6) ─────────
 * Un patrón de velas suelto es ruido; el MISMO patrón sobre una zona con
 * toques es confirmación. Los detectores solo se reportan si la vela operó
 * cerca de la zona del kit. */
function candlePattern(cs, i) {
  const c = cs[i];
  if (!c) return null;
  const body = Math.abs(c.c - c.o), range = c.h - c.l;
  if (!(range > 0)) return null;
  const upperW = c.h - Math.max(c.c, c.o), lowerW = Math.min(c.c, c.o) - c.l;
  const p = cs[i - 1];
  if (p) {
    const pBody = Math.abs(p.c - p.o);
    if (pBody > 0 && body > pBody) {
      if (c.c > c.o && p.c < p.o && c.c >= Math.max(p.o, p.c) && c.o <= Math.min(p.o, p.c)) return { k: "envolvente alcista", bull: true };
      if (c.c < c.o && p.c > p.o && c.o >= Math.max(p.o, p.c) && c.c <= Math.min(p.o, p.c)) return { k: "envolvente bajista", bull: false };
    }
  }
  if (lowerW >= 2 * body && upperW <= body && c.c >= c.l + range * 0.6) return { k: "martillo", bull: true };
  if (upperW >= 2 * body && lowerW <= body && c.c <= c.l + range * 0.4) return { k: "estrella fugaz", bull: false };
  if (body <= range * 0.1) return { k: "doji (indecisión)", bull: null };
  return null;
}
// Patrón en las últimas 2 velas, solo si esa vela tocó/rozó la zona (±1,5%).
function patternAtZone(cs, zone, side) {
  for (const i of [cs.length - 1, cs.length - 2]) {
    const pat = candlePattern(cs, i);
    if (!pat) continue;
    const c = cs[i];
    const near = side === "sup" ? c.l <= zone.hi * 1.015 : c.h >= zone.lo * 0.985;
    const fits = side === "sup" ? pat.bull !== false : pat.bull !== true;
    if (near && fits) return { ...pat, when: i === cs.length - 1 ? "hoy" : "ayer" };
  }
  return null;
}
// RSI por barra (media simple 14) para buscar divergencias en los pivotes.
function rsiSeries(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 14; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let k = i - 13; k <= i; k++) { const d = closes[k] - closes[k - 1]; if (d > 0) g += d; else l -= d; }
    out[i] = g + l === 0 ? 50 : (100 * g) / (g + l);
  }
  return out;
}
// Divergencia clásica entre los dos últimos pivotes: precio hace mínimo más
// bajo con RSI más alto (alcista) / máximo más alto con RSI más bajo (bajista).
function divergences(dLos, dHis, rsiArr) {
  let bull = false, bear = false;
  const lo = dLos.slice(-2), hi = dHis.slice(-2);
  if (lo.length === 2 && rsiArr[lo[0].i] != null && rsiArr[lo[1].i] != null) bull = lo[1].p < lo[0].p && rsiArr[lo[1].i] > rsiArr[lo[0].i] + 2;
  if (hi.length === 2 && rsiArr[hi[0].i] != null && rsiArr[hi[1].i] != null) bear = hi[1].p > hi[0].p && rsiArr[hi[1].i] < rsiArr[hi[0].i] - 2;
  return { bull, bear };
}
// Estructura de tendencia por pivotes diarios: HH+HL / LL+LH / rango.
function estructuraDe(dLos, dHis) {
  if (dLos.length < 2 || dHis.length < 2) return "rango";
  const hl = dLos[dLos.length - 1].p > dLos[dLos.length - 2].p;
  const hh = dHis[dHis.length - 1].p > dHis[dHis.length - 2].p;
  const ll = dLos[dLos.length - 1].p < dLos[dLos.length - 2].p;
  const lh = dHis[dHis.length - 1].p < dHis[dHis.length - 2].p;
  return hh && hl ? "alcista" : ll && lh ? "bajista" : "rango";
}
// Gaps de apertura sin llenar (imanes de precio).
function openGaps(daily) {
  const gaps = [];
  for (let i = 1; i < daily.length; i++) {
    const p = daily[i - 1], c = daily[i];
    if (c.l > p.h) gaps.push({ lo: p.h, hi: c.l, i, up: true });
    else if (c.h < p.l) gaps.push({ lo: c.h, hi: p.l, i, up: false });
  }
  return gaps.filter((g) => {
    for (let k = g.i + 1; k < daily.length; k++) {
      if (g.up && daily[k].l <= g.lo) return false;
      if (!g.up && daily[k].h >= g.hi) return false;
    }
    return true;
  });
}
// POC: el precio donde más volumen operó en el año (50 bins, hlc3 ponderado).
function pocOf(daily) {
  const lo = Math.min(...daily.map((c) => c.l)), hi = Math.max(...daily.map((c) => c.h));
  if (!(hi > lo)) return null;
  const bins = new Array(50).fill(0);
  for (const c of daily) {
    const px = (c.h + c.l + c.c) / 3;
    bins[Math.min(49, Math.max(0, Math.floor(((px - lo) / (hi - lo)) * 50)))] += c.v;
  }
  const bi = bins.indexOf(Math.max(...bins));
  return lo + ((bi + 0.5) / 50) * (hi - lo);
}

// Régimen de mercado: SPY y QQQ contra su EMA50. Comprar soportes con el
// mercado en cascada es el error caro — el kit lo advierte.
async function marketRegime() {
  try {
    const [spy, qqq] = await Promise.all([yahooCandles("SPY", "1d", "6mo"), yahooCandles("QQQ", "1d", "6mo")]);
    const above = (cs) => { const c = cs.map((x) => x.c); const e = emaOf(c, 50); return e != null && c[c.length - 1] >= e; };
    const a = above(spy), b = above(qqq);
    return a && b ? "risk_on" : !a && !b ? "risk_off" : "mixto";
  } catch { return null; }
}

/* ───────── Análisis principal ───────── */
async function main() {
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

  // Cola manual pendiente, colapsando duplicados por usuario+ticker.
  const { data: queue } = await supabase.from("tv_analysis_queue").select("*").eq("status", "pending").limit(20);
  const seen = new Set();
  const jobs = [];
  for (const q of queue || []) {
    const tk = q.ticker.toUpperCase().trim();
    const key = q.user_id + "|" + tk;
    if (seen.has(key)) {
      await supabase.from("tv_analysis_queue").update({ status: "done", processed_at: new Date().toISOString(), result: { dup: true } }).eq("id", q.id);
      continue;
    }
    seen.add(key);
    jobs.push({ ...q, ticker: tk });
  }
  if (!jobs.length) return;

  const regime = await marketRegime();

  for (const job of jobs) {
    const tk = job.ticker;
    try {
      const adrInfo = ARG_ADR[tk] || null;
      const symUsa = adrInfo ? adrInfo.adr : tk;
      let sym = symUsa;
      let daily = await yahooCandles(symUsa, "1d", "1y");
      let hourly = daily ? await yahooCandles(symUsa, "60m", "1mo") : null;
      let modo = adrInfo ? "adr" : "usa";
      if (!daily) {
        sym = tk + ".BA";
        daily = await yahooCandles(sym, "1d", "1y");
        hourly = daily ? await yahooCandles(sym, "60m", "1mo") : null;
        modo = "local_ars";
        if (!daily) throw new Error("sin velas Yahoo (ni USA, ni ADR, ni .BA)");
      }

      const closes = daily.map((c) => c.c);
      const spot = modo === "usa" ? (usdPx[tk] ?? closes[closes.length - 1]) : closes[closes.length - 1];
      const emas = { 21: emaOf(closes, 21), 50: emaOf(closes, 50), 200: emaOf(closes, 200) };
      const rsi = rsi14(closes);
      const ctx = await tickerContext(symUsa, tk);

      // Pivotes de las dos temporalidades → zonas. Estructurales aparte (lb=20).
      const dp = allPivots(daily, LB, "d");
      const hp = hourly ? allPivots(hourly, LB, "h") : { his: [], los: [] };
      const supZ = clusterZones([...dp.los, ...hp.los]);
      const resZ = clusterZones([...dp.his, ...hp.his]);
      const bigP = allPivots(daily, 20, "d");
      const bigSup = clusterZones(bigP.los);
      const bigRes = clusterZones(bigP.his);

      // Señales v6: divergencias RSI, estructura de tendencia, gaps y POC.
      const rsiArr = rsiSeries(closes);
      const div = divergences(dp.los, dp.his, rsiArr);
      const estr = estructuraDe(dp.los, dp.his);
      const gaps = openGaps(daily);
      const poc = pocOf(daily);
      const gapUp = gaps.filter((g) => g.lo > spot && (g.lo - spot) / spot <= 0.15).sort((a, b) => a.lo - b.lo)[0] || null;
      const gapDn = gaps.filter((g) => g.hi < spot && (spot - g.hi) / spot <= 0.15).sort((a, b) => b.hi - a.hi)[0] || null;

      // ATR14 diario para el stop sin pivote y para el aviso de rango.
      let atr = 0;
      for (let i = Math.max(1, daily.length - 14); i < daily.length; i++) {
        atr += Math.max(daily[i].h - daily[i].l, Math.abs(daily[i].h - daily[i - 1].c), Math.abs(daily[i].l - daily[i - 1].c));
      }
      atr /= Math.min(14, daily.length - 1);
      const yrHigh = Math.max(...daily.map((c) => c.h));
      const yrLow = Math.min(...daily.map((c) => c.l));

      // Entrada: zona soporte más cercana debajo del precio (alerta en el techo
      // de la zona = primer contacto). Venta: zona resistencia más cercana (piso).
      const buysBelow = supZ.filter((z) => z.hi < spot * 0.999);
      const buyZone = buysBelow.length ? buysBelow[buysBelow.length - 1] : null;
      const sellsAbove = resZ.filter((z) => z.lo > spot * 1.001);
      const sellZone = sellsAbove.length ? sellsAbove[0] : null;
      // Entrada swing extra: si la cercana es SOLO horaria y hay una zona con
      // pata diaria >1,5% más abajo, también vale mostrarla (scalp vs trade).
      let swingZone = null;
      if (buyZone && !buyZone.hasD) {
        const deeper = buysBelow.filter((z) => z.hasD && z.hi < buyZone.lo * 0.985);
        if (deeper.length) swingZone = deeper[deeper.length - 1];
      }
      // Stop: piso de la siguiente zona debajo de la entrada, o 1×ATR.
      let stopLvl = null, stopWhy = "";
      if (buyZone) {
        const below = buysBelow.filter((z) => z.hi < buyZone.lo * 0.995);
        if (below.length) { const z = below[below.length - 1]; stopLvl = z.lo; stopWhy = `piso de zona ${z.touches} toque${z.touches > 1 ? "s" : ""}`; }
        else { stopLvl = buyZone.hi - atr; stopWhy = "1×ATR diario"; }
      }

      // Conversión a ARS según el modo.
      let toArs, usdShown;
      if (modo === "usa") {
        const ratio = arsPx[tk] > 0 && usdPx[tk] > 0 ? Math.max(1, Math.round((usdPx[tk] * ccl) / arsPx[tk])) : null;
        if (!ratio) throw new Error("sin ratio (no está el CEDEAR en el feed)");
        toArs = (usd) => Math.round((usd * ccl) / ratio);
        usdShown = (x) => Math.round(x * 100) / 100;
      } else if (modo === "adr") {
        toArs = (usd) => Math.round((usd * ccl) / adrInfo.r);
        usdShown = (x) => Math.round(x * 100) / 100;
      } else {
        toArs = (ars) => Math.round(ars);
        usdShown = () => null;
      }

      await supabase.from("price_alerts").delete().eq("user_id", job.user_id).eq("ticker", tk).eq("origen", "tv").is("triggered_at", null).like("nota", "AUTO%");

      const unit = modo === "local_ars" ? "$" : "US$";
      const fmt = (x) => x.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const fmt1 = (x) => x.toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      const tfLabel = (z) => (z.hasD && z.hasH ? "diario+horario" : z.hasD ? "diario" : "horario");
      const zoneTag = (z, sc) => `${z.touches} toque${z.touches > 1 ? "s" : ""}${z.volMax >= 1.5 ? " · vol alto" : ""}${sc.emaHit.length ? " · " + sc.emaHit.join("+") : ""} · score ${sc.score}/10`;

      // Avisos de contexto (van en la nota de entrada, una sola vez).
      const warns = [];
      if (ctx?.earnings) {
        const dEarn = Math.round((new Date(ctx.earnings) - Date.now()) / 86400000);
        if (dEarn >= 0 && dEarn <= 7) warns.push(`OJO earnings ${ctx.earnings.slice(8, 10)}/${ctx.earnings.slice(5, 7)}`);
      }
      if (regime === "risk_off") warns.push("OJO mercado débil (SPY y QQQ bajo EMA50)");
      if (estr === "bajista") warns.push("estructura bajista: soportes frágiles");
      if (rsi != null && rsi <= 30) warns.push(`RSI ${rsi} sobrevendido`);
      const warnTxt = warns.length ? " · " + warns.join(" · ") : "";

      const rows = [], tracks = [];
      const mk = (lvl, dir, nota, tipo, extra = {}) => {
        rows.push({ user_id: job.user_id, ticker: tk, price: toArs(lvl), dir, nota, usd_ref: usdShown(lvl), canal: "screen", origen: "tv" });
        tracks.push({ user_id: job.user_id, ticker: tk, sym, tipo, dir, level: Math.round(lvl * 100) / 100, spot: Math.round(spot * 100) / 100, regime, rsi, estructura: estr, ...extra });
      };

      // 1. Entrada principal — señales de velas/divergencia/POC ajustan el score.
      if (buyZone) {
        const sc = scoreZone(buyZone, emas);
        const sig = [];
        const pat = patternAtZone(daily, buyZone, "sup") || (hourly ? patternAtZone(hourly, buyZone, "sup") : null);
        if (pat) { sig.push(`${pat.k} ${pat.when}`); if (pat.bull) sc.score += 1; }
        if (div.bull) { sig.push("divergencia RSI alcista"); sc.score += 1; }
        if (poc && Math.abs(poc - buyZone.avg) / buyZone.avg <= 0.01) { sig.push("es el POC del año"); sc.score += 1; }
        if (estr === "alcista") sc.score += 1; else if (estr === "bajista") sc.score -= 1;
        sc.score = Math.max(1, Math.min(10, sc.score));
        const sigTxt = sig.length ? " · " + sig.join(" · ") : "";
        const gapTxt = gapDn ? ` · gap abierto abajo ${fmt(gapDn.lo)}-${fmt(gapDn.hi)} (imán)` : "";
        const rr = sellZone && stopLvl && buyZone.hi - stopLvl > 0 ? Math.round(((sellZone.lo - buyZone.hi) / (buyZone.hi - stopLvl)) * 10) / 10 : null;
        const rrTxt = rr != null ? ` · R:R ${fmt1(rr)}${rr < 1.2 ? " flaco" : rr >= 2.5 ? " bueno" : ""}` : "";
        mk(buyZone.hi, "down", `AUTO · soporte ${unit}${fmt(buyZone.hi)} · ${tfLabel(buyZone)} · ${zoneTag(buyZone, sc)}${sigTxt} · tendencia ${estr}${rrTxt}${gapTxt}${warnTxt} · zona de COMPRA`, buyZone.hasD ? "soporte-diario" : "soporte-horario", { score: sc.score, touches: buyZone.touches, rr, senales: sig.join(",") || null });
        // 2. Stop de esa entrada
        if (stopLvl && stopLvl > 0 && stopLvl < buyZone.hi) {
          mk(stopLvl, "down", `AUTO · STOP LOSS ${unit}${fmt(stopLvl)} si comprás en ${fmt(buyZone.hi)} · ${stopWhy}`, "stop", { score: null, touches: null });
        }
        // 2b. Entrada swing (zona diaria más abajo) — para trade, no scalp.
        if (swingZone) {
          const sc2 = scoreZone(swingZone, emas);
          mk(swingZone.hi, "down", `AUTO · soporte ${unit}${fmt(swingZone.hi)} · diario · ${zoneTag(swingZone, sc2)} · zona de COMPRA swing`, "soporte-diario", { score: sc2.score, touches: swingZone.touches });
        }
      }
      // 3. Take profit / venta con lectura de breakout + señales bajistas.
      if (sellZone) {
        const sc = scoreZone(sellZone, emas);
        const sig = [];
        const pat = patternAtZone(daily, sellZone, "res") || (hourly ? patternAtZone(hourly, sellZone, "res") : null);
        if (pat) { sig.push(`${pat.k} ${pat.when}`); if (pat.bull === false) sc.score += 1; }
        if (div.bear) { sig.push("divergencia RSI bajista"); sc.score += 1; }
        if (poc && Math.abs(poc - sellZone.avg) / sellZone.avg <= 0.01) { sig.push("es el POC del año"); sc.score += 1; }
        sc.score = Math.max(1, Math.min(10, sc.score));
        const sigTxt = sig.length ? " · " + sig.join(" · ") : "";
        const above = [...bigRes.filter((z) => z.lo > sellZone.hi * 1.005).map((z) => z.lo), yrHigh > sellZone.hi * 1.005 ? yrHigh : null].filter((x) => x != null);
        const nextUp = above.length ? Math.min(...above) : null;
        const gapTxt = gapUp ? ` · gap abierto arriba ${fmt(gapUp.lo)}-${fmt(gapUp.hi)} (imán)` : "";
        const hotRsi = rsi != null && rsi >= 70 ? ` · RSI ${rsi} sobrecomprado` : "";
        mk(sellZone.lo, "up", `AUTO · resistencia ${unit}${fmt(sellZone.lo)} · ${tfLabel(sellZone)} · ${zoneTag(sellZone, sc)}${sigTxt}${hotRsi} · take profit / venta${nextUp ? ` · si la rompe: momentum hacia ${unit}${fmt(nextUp)}` : ""}${gapTxt}`, "resistencia", { score: sc.score, touches: sellZone.touches, senales: sig.join(",") || null });
      }
      // 3b. POC como nivel propio si no duplica los del kit (±1,5%).
      if (poc && Math.abs(poc - spot) / spot >= 0.015 && Math.abs(poc - spot) / spot <= 0.12) {
        const dupB = buyZone && Math.abs(poc - buyZone.hi) / buyZone.hi < 0.015;
        const dupS = sellZone && Math.abs(poc - sellZone.lo) / sellZone.lo < 0.015;
        if (!dupB && !dupS) {
          if (poc < spot) mk(poc, "down", `AUTO · POC ${unit}${fmt(poc)} · mayor volumen del año · soporte por volumen`, "poc", {});
          else mk(poc, "up", `AUTO · POC ${unit}${fmt(poc)} · mayor volumen del año · resistencia por volumen`, "poc", {});
        }
      }
      // 4. Estructurales (lb=20), solo si no duplican los niveles cortos.
      const bigS = bigSup.filter((z) => z.hi < spot && (!buyZone || z.hi < buyZone.lo * 0.97));
      if (bigS.length) {
        const z = bigS[bigS.length - 1];
        const sc = scoreZone(z, emas);
        mk(z.hi, "down", `AUTO · soporte ESTRUCTURAL ${unit}${fmt(z.hi)} · pivote mayor del año · ${zoneTag(z, sc)}`, "estructural-sop", { score: sc.score, touches: z.touches });
      }
      const bigR = bigRes.filter((z) => z.lo > spot && (!sellZone || z.lo > sellZone.hi * 1.03));
      if (bigR.length) {
        const z = bigR[0];
        const sc = scoreZone(z, emas);
        mk(z.lo, "up", `AUTO · resistencia ESTRUCTURAL ${unit}${fmt(z.lo)} · pivote mayor del año · ${zoneTag(z, sc)}`, "estructural-res", { score: sc.score, touches: z.touches });
      }
      // 5. Sin soporte debajo (mínimos nuevos): piso de 52 semanas como referencia.
      if (!buyZone && !bigS.length && yrLow < spot * 0.995) {
        mk(yrLow, "down", `AUTO · piso del año ${unit}${fmt(yrLow)} · mínimo 52 semanas (sin soporte de pivote debajo: mínimos nuevos)${warnTxt}`, "piso-anio", { score: null, touches: null });
      }

      if (rows.length) {
        const { error } = await supabase.from("price_alerts").insert(rows);
        if (error) throw new Error(error.message);
        // Dedup del feedback loop: el rearme de 15 min re-emite los mismos
        // niveles; solo se registra un nivel si no hay ya un track ABIERTO
        // del mismo tipo a menos de 0,2% (una fila por nivel real emitido).
        const { data: openTr } = await supabase.from("nivel_track").select("tipo,level").eq("user_id", job.user_id).eq("ticker", tk).eq("done", false);
        const fresh = tracks.filter((t) => !(openTr || []).some((o) => o.tipo === t.tipo && Math.abs(Number(o.level) - t.level) / t.level < 0.002));
        if (fresh.length) await supabase.from("nivel_track").insert(fresh).then(({ error: e2 }) => { if (e2) log(`[track ${tk}] ${e2.message}`); });
      }

      await supabase.from("tv_analysis_queue").update({
        status: "done", processed_at: new Date().toISOString(),
        result: { modo, spot, regime, rsi, buy: buyZone?.hi ?? null, sell: sellZone?.lo ?? null, ccl },
      }).eq("id", job.id);
      log(`${tk} [${modo}] rgm=${regime} rsi=${rsi}: compra ${buyZone ? buyZone.hi.toFixed(2) : "-"} / venta ${sellZone ? sellZone.lo.toFixed(2) : "-"} (${rows.length} alertas)`);
    } catch (e) {
      await supabase.from("tv_analysis_queue").update({ status: "error", processed_at: new Date().toISOString(), result: { error: e.message } }).eq("id", job.id);
      log(`${tk} ERROR: ${e.message}`);
    }
  }
}

/* ───────── Feedback loop: medir qué hizo el precio después de cada nivel ───────── */
async function updateTracks() {
  const { data: open } = await supabase.from("nivel_track").select("*").eq("done", false).limit(500);
  if (!open?.length) return;
  // Toques intradía exactos: si la alerta correspondiente disparó en pantalla.
  const { data: fired } = await supabase.from("price_alerts").select("ticker,user_id,dir,usd_ref,price,triggered_at").not("triggered_at", "is", null).eq("origen", "tv");
  const bySym = new Map();
  for (const t of open) { if (!bySym.has(t.sym)) bySym.set(t.sym, []); bySym.get(t.sym).push(t); }
  for (const [sym, tracks] of bySym) {
    let candles = null;
    try { candles = await yahooCandles(sym, "1d", "3mo"); } catch { /* siguiente pasada */ }
    if (!candles) continue;
    for (const t of tracks) {
      const created = String(t.created_at).slice(0, 10);
      const after = candles.filter((c) => c.t > created);
      const upd = {};
      // ¿Tocó? — por velas diarias posteriores, o por la alerta disparada en vivo.
      if (!t.touched) {
        const lvl = Number(t.level);
        const hitBar = after.find((c) => (t.dir === "down" ? c.l <= lvl : c.h >= lvl));
        const hitAlert = (fired || []).find((f) => f.ticker === t.ticker && f.user_id === t.user_id && f.dir === t.dir &&
          (f.usd_ref != null ? Math.abs(Number(f.usd_ref) - lvl) < 0.01 : Math.abs(Number(f.price) - lvl) < 1) &&
          new Date(f.triggered_at) >= new Date(t.created_at));
        if (hitBar || hitAlert) { upd.touched = true; upd.touched_at = hitAlert ? f0(hitAlert.triggered_at) : new Date(hitBar.t + "T21:00:00Z").toISOString(); }
      }
      if (t.px_after_1 == null && after.length >= 1) upd.px_after_1 = after[0].c;
      if (t.px_after_5 == null && after.length >= 5) upd.px_after_5 = after[4].c;
      if (t.px_after_10 == null && after.length >= 10) { upd.px_after_10 = after[9].c; upd.done = true; }
      if (Object.keys(upd).length) await supabase.from("nivel_track").update(upd).eq("id", t.id);
    }
  }
  log(`tracks: ${open.length} abiertos revisados`);
}
const f0 = (x) => new Date(x).toISOString();

/* ───────── Confirmación post-toque (filtro de falsas rupturas) ─────────
 * Cuando una alerta AUTO dispara, la campana dice "tocó" — pero comprar la
 * mecha no es lo mismo que comprar el rebote confirmado. Esta pasada mira
 * cómo CERRÓ la vela del toque (60m para niveles horarios, diaria para el
 * resto) y le agrega el veredicto a la nota: defensa validada / ruptura. */
async function confirmTouches() {
  const { data: fired } = await supabase.from("price_alerts").select("id,ticker,dir,usd_ref,price,nota,triggered_at")
    .eq("origen", "tv").not("triggered_at", "is", null).like("nota", "AUTO%");
  const todo = (fired || []).filter((a) => !/· cierre:/.test(a.nota || ""));
  for (const a of todo) {
    try {
      const adr = ARG_ADR[a.ticker];
      const sym = adr ? adr.adr : (a.usd_ref != null ? a.ticker : a.ticker + ".BA");
      const lvl = a.usd_ref != null ? Number(a.usd_ref) : Number(a.price);
      const isHourly = /horario/i.test(a.nota || "") && !/diario\+horario/i.test(a.nota || "");
      const cs = await yahooCandles(sym, isHourly ? "60m" : "1d", isHourly ? "5d" : "1mo");
      if (!cs || cs.length < 2) continue;
      const trig = new Date(a.triggered_at).getTime() / 1000;
      const idx = cs.findIndex((c, i) => c.ts <= trig && (i === cs.length - 1 || cs[i + 1].ts > trig));
      if (idx < 0 || idx >= cs.length - 1) continue; // la vela del toque todavía no cerró
      const close = cs[idx].c;
      let verdict;
      if (a.dir === "down") verdict = close >= lvl ? "cerró ARRIBA del nivel → defensa validada" : "cerró ABAJO del nivel → ruptura, cuidado";
      else verdict = close > lvl ? "cerró ARRIBA del nivel → ruptura validada, momentum" : "cerró ABAJO del nivel → falso quiebre";
      await supabase.from("price_alerts").update({ nota: `${a.nota} · cierre: ${verdict}` }).eq("id", a.id);
      log(`confirmación ${a.ticker} ${lvl}: ${verdict}`);
    } catch (e) { log(`[confirm ${a.ticker}] ${e.message}`); }
  }
}

/* ───────── Modo día volátil: rearme automático del tablero ─────────
 * Cada 15 min en horario de mercado USA, re-encola los tickers que YA están
 * en el tablero (con alertas AUTO vivas). NO agrega papeles nuevos — la regla
 * de LP sigue: los papeles entran a mano; esto solo refresca los que él cargó.
 * Las disparadas no se tocan (conservan su veredicto de cierre hasta que él
 * las borre); se recalculan las vigentes con el precio del momento. */
function inUsMarketWindow() {
  const ar = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const dow = ar.getDay(), mins = ar.getHours() * 60 + ar.getMinutes();
  return dow >= 1 && dow <= 5 && mins >= 10 * 60 + 30 && mins <= 17 * 60;
}
async function autoRearm() {
  if (!inUsMarketWindow()) return;
  const { data: act } = await supabase.from("price_alerts").select("user_id,ticker").eq("origen", "tv").eq("canal", "screen").like("nota", "AUTO%");
  if (!act?.length) return;
  const { data: pend } = await supabase.from("tv_analysis_queue").select("user_id,ticker").eq("status", "pending");
  const pendSet = new Set((pend || []).map((p) => p.user_id + "|" + p.ticker.toUpperCase()));
  const seen = new Set(), rows = [];
  for (const a of act) {
    const key = a.user_id + "|" + a.ticker.toUpperCase();
    if (seen.has(key) || pendSet.has(key)) continue;
    seen.add(key);
    rows.push({ user_id: a.user_id, ticker: a.ticker, source: "auto-rearm", status: "pending" });
  }
  if (rows.length) {
    await supabase.from("tv_analysis_queue").insert(rows);
    log(`auto-rearm: ${rows.map((r) => r.ticker).join(", ")}`);
  }
}

/* ───────── Loop persistente ───────── */
async function loop() {
  log("niveles-auto v6 arrancando (cola 60s; rearme 15 min en mercado; confirmaciones 10 min; tracks 60 min)");
  let lastTracks = 0, lastConfirm = 0, lastRearm = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (Date.now() - lastRearm > 15 * 60 * 1000) {
        await autoRearm().catch((e) => log("[rearm]", e.message));
        lastRearm = Date.now();
      }
      await main();
      if (Date.now() - lastConfirm > 10 * 60 * 1000) {
        await confirmTouches().catch((e) => log("[confirm]", e.message));
        lastConfirm = Date.now();
      }
      if (Date.now() - lastTracks > 60 * 60 * 1000) {
        await updateTracks().catch((e) => log("[tracks]", e.message));
        lastTracks = Date.now();
      }
    } catch (e) { console.error("[loop]", e.message); }
    await new Promise((r) => setTimeout(r, 60 * 1000));
  }
}

loop();
