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
  YPFD: { adr: "YPF", r: 10 }, // split 10:1 local 04/08/2026 (antes r=1)
  GGAL: { adr: "GGAL", r: 10 }, PAMP: { adr: "PAM", r: 25 },
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
  const iolArs2 = {};
  try {
    const { data: iq2 } = await supabase.from("iol_quotes").select("ticker,last");
    for (const r of iq2 || []) if (Number(r.last) > 0) iolArs2[String(r.ticker).toUpperCase()] = Number(r.last);
  } catch { /* sin respaldo */ }
  // Respaldo del feed de CEDEARs: arg_cedears responde VACIO a ratos (el 28/08
  // a las 11:09 fallaron MU, SNDK y UBER con "sin ratio" y a las 11:24 andaban).
  // iol_quotes tiene el ultimo cierre y no se cae.
  const iolArs = {};
  try {
    const { data: iq } = await supabase.from("iol_quotes").select("ticker,last");
    for (const r of iq || []) if (Number(r.last) > 0) iolArs[String(r.ticker).toUpperCase()] = Number(r.last);
  } catch (e) { log("[iol_quotes respaldo]", e.message); }

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
      // v8 (08/08): respaldo de VOLUMEN de cada zona. Antes el motor solo
      // premiaba la coincidencia exacta con el POC (un único precio); ahora
      // mide qué porcentaje del volumen del año se operó DENTRO del rango de
      // la zona. Un soporte donde se operó mucho es una zona de pelea real;
      // uno en un hueco del perfil no frena nada — el precio lo atraviesa.
      const prof = buildProfile(daily);
      const volEnZona = (lo, hi) => {
        if (!prof || !(hi > lo)) return null;
        let acc = 0;
        for (const b of prof.bins) {
          const ov = Math.min(hi, b.hi) - Math.max(lo, b.lo); // solape zona↔bin
          if (ov > 0) acc += b.pct * (ov / (b.hi - b.lo));
        }
        return acc; // % del volumen anual dentro de la zona
      };
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
      // Stop: 0,7% DEBAJO del piso de la siguiente zona (el stop va bajo el
      // soporte, no en el soporte — clavado exacto te lo barre una mecha, y
      // además coincidía con la entrada swing de esa misma zona), o 1×ATR.
      let stopLvl = null, stopWhy = "";
      if (buyZone) {
        const below = buysBelow.filter((z) => z.hi < buyZone.lo * 0.995);
        if (below.length) { const z = below[below.length - 1]; stopLvl = z.lo * 0.993; stopWhy = `0,7% bajo la zona de ${z.touches} toque${z.touches > 1 ? "s" : ""}`; }
        else { stopLvl = buyZone.hi - atr; stopWhy = "1×ATR diario"; }
      }

      // Conversión a ARS según el modo.
      let toArs, usdShown;
      if (modo === "usa") {
        // usdPx sale de data912/usa_stocks, que NO lista ETFs: GLD (SPDR Gold
        // Trust) no esta ahi y el ratio quedaba null SIEMPRE — no era
        // intermitente, GLD nunca se pudo analizar. `spot` ya cae al ultimo
        // cierre de Yahoo, que si trae ETFs, asi que sirve igual para derivar
        // el ratio. Y si el feed de CEDEARs vino vacio, se usa el cierre de IOL.
        const usdRef = usdPx[tk] > 0 ? usdPx[tk] : spot;
        const arsRef = arsPx[tk] > 0 ? arsPx[tk] : (iolArs[tk] || 0);
        const ratio = arsRef > 0 && usdRef > 0 ? Math.max(1, Math.round((usdRef * ccl) / arsRef)) : null;
        if (!ratio) throw new Error("sin ratio (ni feed de CEDEARs ni cierre de IOL)");
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

      // CONTRA-TENDENCIA (AQR "Hold the Dip"): estructura bajista + precio en
      // mínimos = comprar el dip contra momentum, la jugada que pierde 6 de 10
      // veces. Etiqueta explícita y score capado en 4 — el recordatorio salta
      // exactamente donde pica la mano de promediar.
      const low20 = Math.min(...daily.slice(-20).map((c) => c.l));
      const enMinimos = daily[daily.length - 1].l <= low20 * 1.01;
      const contraTendencia = estr === "bajista" && enMinimos;
      const ctTxt = contraTendencia ? " · CONTRA-TENDENCIA: dip contra momentum (AQR: pierde 6 de 10)" : "";

      // 1. Entrada principal — señales de velas/divergencia/POC ajustan el score.
      if (buyZone) {
        const sc = scoreZone(buyZone, emas);
        const sig = [];
        const pat = patternAtZone(daily, buyZone, "sup") || (hourly ? patternAtZone(hourly, buyZone, "sup") : null);
        if (pat) { sig.push(`${pat.k} ${pat.when}`); if (pat.bull) sc.score += 1; }
        if (div.bull) { sig.push("divergencia RSI alcista"); sc.score += 1; }
        if (poc && Math.abs(poc - buyZone.avg) / buyZone.avg <= 0.01) { sig.push("es el POC del año"); sc.score += 1; }
        // Respaldo de volumen: con 30 bins, el reparto parejo daría 3,3% por
        // zona; arriba de 6% es concentración real, abajo de 1,5% es hueco.
        const vz = volEnZona(buyZone.lo, buyZone.hi);
        if (vz != null) {
          if (vz >= 6) { sig.push(`respaldo de volumen fuerte (${vz.toFixed(1)}% del año)`); sc.score += 1; }
          else if (vz < 1.5) { sig.push(`zona sin volumen (${vz.toFixed(1)}%): el precio la atraviesa rápido`); sc.score -= 1; }
        }
        if (estr === "alcista") sc.score += 1; else if (estr === "bajista") sc.score -= 1;
        if (contraTendencia) { sig.push("CONTRA-TENDENCIA"); sc.score = Math.min(sc.score, 4); }
        sc.score = Math.max(1, Math.min(10, sc.score));
        const sigTxt = sig.filter((s) => s !== "CONTRA-TENDENCIA").length ? " · " + sig.filter((s) => s !== "CONTRA-TENDENCIA").join(" · ") : "";
        const gapTxt = gapDn ? ` · gap abierto abajo ${fmt(gapDn.lo)}-${fmt(gapDn.hi)} (imán)` : "";
        const rr = sellZone && stopLvl && buyZone.hi - stopLvl > 0 ? Math.round(((sellZone.lo - buyZone.hi) / (buyZone.hi - stopLvl)) * 10) / 10 : null;
        const rrTxt = rr != null ? ` · R:R ${fmt1(rr)}${rr < 1.2 ? " flaco" : rr >= 2.5 ? " bueno" : ""}` : "";
        // Sizing por riesgo (regla Scalbi: la distancia a la invalidante manda
        // el tamaño, nunca al revés): riesgo por papel en ARS y cuántos papeles
        // corresponden a arriesgar $250k / $500k.
        let sizeTxt = "";
        if (stopLvl && stopLvl > 0 && stopLvl < buyZone.hi) {
          const rpp = toArs(buyZone.hi) - toArs(stopLvl);
          if (rpp > 0) sizeTxt = ` · riesgo $${Math.round(rpp).toLocaleString("es-AR")}/papel (250k→${Math.floor(250000 / rpp)} · 500k→${Math.floor(500000 / rpp)} papeles)`;
        }
        mk(buyZone.hi, "down", `AUTO · soporte ${unit}${fmt(buyZone.hi)} · ${tfLabel(buyZone)} · ${zoneTag(buyZone, sc)}${sigTxt} · tendencia ${estr}${ctTxt}${rrTxt}${sizeTxt}${gapTxt}${warnTxt} · zona de COMPRA`, buyZone.hasD ? "soporte-diario" : "soporte-horario", { score: sc.score, touches: buyZone.touches, rr, senales: sig.join(",") || null });
        // 2. Stop de esa entrada
        if (stopLvl && stopLvl > 0 && stopLvl < buyZone.hi) {
          mk(stopLvl, "down", `AUTO · STOP LOSS ${unit}${fmt(stopLvl)} si comprás en ${fmt(buyZone.hi)} · ${stopWhy}`, "stop", { score: null, touches: null });
        }
        // PAPER IOL (Fase 0 del test de trading automático): si la señal
        // califica con las reglas escritas — score >=7, R:R >=2, a favor de
        // tendencia, papel operable en USA — queda registrada como orden
        // límite SIMULADA en paper_iol_trades. paperPass() la llena y la
        // maneja sola (stop, trailing, target). Cero plata real.
        // Para los papeles del bot dejamos asentado también lo que NO califica:
        // sin eso, un papel puede pasar semanas sin generar una sola orden y no
        // hay forma de saber si es que nunca hubo setup o si el filtro está
        // demasiado exigente. El nivel en sí ya queda medido en nivel_track.
        if (BOT_UNIVERSO.has(tk.toUpperCase()) && modo !== "local_ars") {
          const faltas = [];
          if (sc.score < 7) faltas.push(`score ${sc.score}/10, hace falta 7`);
          if (rr == null || rr < 2) faltas.push(`R:R ${rr ?? "sin calcular"}, hace falta 2`);
          if (contraTendencia) faltas.push("va contra la tendencia");
          if (!(stopLvl > 0 && stopLvl < buyZone.hi)) faltas.push("sin stop válido");
          if (!sellZone) faltas.push("sin zona de salida");
          if (faltas.length) botDescarte(tk, buyZone.hi, faltas);
        }
        if (BOT_UNIVERSO.has(tk.toUpperCase()) && modo !== "local_ars" && sc.score >= 7 && rr != null && rr >= 2 && !contraTendencia && stopLvl && stopLvl > 0 && stopLvl < buyZone.hi && sellZone) {
          await paperSignal(symUsa, tk, buyZone.hi, stopLvl, sellZone.lo, sc.score, rr, `score ${sc.score}/10 · R:R ${fmt1(rr)} · ${zoneTag(buyZone, sc)}${sigTxt} · tendencia ${estr}`).catch((e) => log(`[paper ${tk}] ${e.message}`));
        }
        // 2b. Entrada swing (zona diaria más abajo) — para trade, no scalp.
        // La etiqueta CONTRA-TENDENCIA aplica acá también: la swing es la
        // tentación clásica de la promediada.
        if (swingZone) {
          const sc2 = scoreZone(swingZone, emas);
          if (contraTendencia) sc2.score = Math.min(sc2.score, 4);
          mk(swingZone.hi, "down", `AUTO · soporte ${unit}${fmt(swingZone.hi)} · diario · ${zoneTag(swingZone, sc2)}${ctTxt} · zona de COMPRA swing`, "soporte-diario", { score: sc2.score, touches: swingZone.touches, senales: contraTendencia ? "CONTRA-TENDENCIA" : null });
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
        const vzr = volEnZona(sellZone.lo, sellZone.hi);
        if (vzr != null) {
          if (vzr >= 6) { sig.push(`respaldo de volumen fuerte (${vzr.toFixed(1)}% del año)`); sc.score += 1; }
          else if (vzr < 1.5) { sig.push(`zona sin volumen (${vzr.toFixed(1)}%): puede romperla de largo`); sc.score -= 1; }
        }
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

      // Anti-repique: si un nivel IGUAL ya disparó HOY (quedó gris en pantalla),
      // no se recrea — con el precio pegado al nivel, cada rearme de 15 min
      // generaba una copia nueva que volvía a sonar (caso YPFD 50,44 ×3).
      const todayARr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
      const { data: firedToday } = await supabase.from("price_alerts").select("dir,usd_ref,price")
        .eq("user_id", job.user_id).eq("ticker", tk).eq("origen", "tv")
        .not("triggered_at", "is", null).gte("triggered_at", todayARr + "T00:00:00-03:00");
      const isDupFired = (r) => (firedToday || []).some((f) => f.dir === r.dir &&
        (r.usd_ref != null && f.usd_ref != null
          ? Math.abs(Number(f.usd_ref) - r.usd_ref) / r.usd_ref < 0.002
          : Math.abs(Number(f.price) - r.price) / Math.max(1, r.price) < 0.002));
      const keepIdx = rows.map((_, i) => i).filter((i) => !isDupFired(rows[i]));
      const rowsClean = keepIdx.map((i) => rows[i]);
      const tracksClean = keepIdx.map((i) => tracks[i]);
      if (rowsClean.length) {
        const { error } = await supabase.from("price_alerts").insert(rowsClean);
        if (error) throw new Error(error.message);
        // Dedup del feedback loop: el rearme de 15 min re-emite los mismos
        // niveles; solo se registra un nivel si no hay ya un track ABIERTO
        // del mismo tipo a menos de 0,2% (una fila por nivel real emitido).
        const { data: openTr } = await supabase.from("nivel_track").select("tipo,level").eq("user_id", job.user_id).eq("ticker", tk).eq("done", false);
        const fresh = tracksClean.filter((t) => !(openTr || []).some((o) => o.tipo === t.tipo && Math.abs(Number(o.level) - t.level) / t.level < 0.002));
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

/* ───────── Ratchet: el stop solo sube (regla Scalbi, fase 2) ─────────
 * Para cada posición ABIERTA de contado (importada en positions, sin IOL),
 * mantiene UNA alerta "RATCHET · STOP dinámico": arranca 1×ATR bajo la
 * entrada promedio y, por cada múltiplo R que el máximo desde la entrada
 * avanza, sube (1R ganado → breakeven; 2R → protege 1R; ...). NUNCA baja.
 * No hay take profit: el ratchet ES la toma de ganancias. Suma el time-stop:
 * si tras 10 ruedas el trade nunca validó (+0,5R), la nota lo dice.
 * Sobrevive a los rearmes (nota no empieza con AUTO). */
async function ratchetPass() {
  const { data: pos } = await supabase.from("positions")
    .select("user_id,ticker,operation_type,quantity,entry_price,entry_date,created_at,broker")
    .in("instrument_type", ["cedear", "stock"]).neq("broker", "iol");
  const { data: ratchets } = await supabase.from("price_alerts")
    .select("id,user_id,ticker,usd_ref,price,triggered_at").like("nota", "RATCHET%");
  const groups = new Map();
  for (const p of pos || []) {
    const key = p.user_id + "|" + p.ticker.toUpperCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  // feeds para ratio en vivo
  const [dolRes, usaRes, cedRes] = await Promise.all([
    fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).then((r) => r.json()).catch(() => null),
    fetch("https://data912.com/live/usa_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/arg_cedears", { headers: UA }).then((r) => r.json()).catch(() => []),
  ]);
  const ccl = Number(dolRes?.venta) || Number(dolRes?.compra) || null;
  const usdPx = {}, arsPx = {};
  for (const it of usaRes || []) if (it?.symbol && Number(it.c) > 0) usdPx[it.symbol.toUpperCase()] = Number(it.c);
  for (const it of cedRes || []) if (it?.symbol && Number(it.c) > 0) arsPx[it.symbol.toUpperCase()] = Number(it.c);

  const liveKeys = new Set();
  for (const [key, ops] of groups) {
    try {
      const [userId, tk] = key.split("|");
      // walk cronológico (a prueba de cruces por cero): neto, costo promedio
      // y fecha de inicio de la RACHA abierta actual.
      // Orden: fecha y, dentro del mismo día, created_at (sin esto el walk de
      // un día de round-trips queda ambiguo y el promedio sale corrido).
      ops.sort((a, b) => (a.entry_date || "").localeCompare(b.entry_date || "") || String(a.created_at || "").localeCompare(String(b.created_at || "")));
      let q = 0, v = 0, streakStart = null;
      for (const p of ops) {
        const n = Number(p.quantity) || 0, px = Number(p.entry_price) || 0;
        const s = p.operation_type === "sell" ? -n : n;
        if (q <= 0 && s > 0) streakStart = p.entry_date;
        if (q === 0 || (q > 0) === (s > 0)) { q += s; v += s * px; }
        else {
          const closing = Math.min(Math.abs(s), Math.abs(q));
          const avg = v / q; const opening = Math.abs(s) - closing;
          if (opening > 0) { q = s > 0 ? opening : -opening; v = q * px; }
          else { q += s; v += (s > 0 ? closing : -closing) * avg; }
        }
        if (q <= 0) streakStart = null;
      }
      if (q <= 0 || !streakStart) continue;
      const avgArs = v / q;

      // símbolo y conversión (misma cascada que el kit)
      const adrInfo = ARG_ADR[tk] || null;
      const symUsa = adrInfo ? adrInfo.adr : tk;
      let daily = await yahooCandles(symUsa, "1d", "1y");
      let modo = adrInfo ? "adr" : "usa";
      if (!daily) { daily = await yahooCandles(tk + ".BA", "1d", "1y"); modo = "local_ars"; if (!daily) continue; }
      let toArs, entryLvl, unit;
      if (modo === "usa") {
        // Mismo respaldo que en el analisis: ETFs no estan en usa_stocks y el
        // feed de CEDEARs se cae a ratos. Sin esto el ratchet de GLD no existia.
        const usdRef = usdPx[tk] > 0 ? usdPx[tk] : (Number(daily?.[daily.length - 1]?.c) || 0);
        const arsRef = arsPx[tk] > 0 ? arsPx[tk] : (iolArs2[tk] || 0);
        const ratio = arsRef > 0 && usdRef > 0 && ccl ? Math.max(1, Math.round((usdRef * ccl) / arsRef)) : null;
        if (!ratio) continue;
        toArs = (usd) => Math.round((usd * ccl) / ratio);
        entryLvl = (avgArs * ratio) / ccl; unit = "US$";
      } else if (modo === "adr") {
        if (!ccl) continue;
        toArs = (usd) => Math.round((usd * ccl) / adrInfo.r);
        entryLvl = (avgArs * adrInfo.r) / ccl; unit = "US$";
      } else { toArs = (x) => Math.round(x); entryLvl = avgArs; unit = "$"; }

      const since = daily.filter((c) => c.t >= streakStart);
      if (!since.length) continue;
      const hwm = Math.max(...since.map((c) => c.h));
      let atr = 0;
      for (let i = Math.max(1, daily.length - 14); i < daily.length; i++) {
        atr += Math.max(daily[i].h - daily[i].l, Math.abs(daily[i].h - daily[i - 1].c), Math.abs(daily[i].l - daily[i - 1].c));
      }
      atr /= Math.min(14, daily.length - 1);
      if (!(atr > 0) || !(entryLvl > 0)) continue;

      const R = atr;
      const k = Math.floor((hwm - entryLvl) / R);
      const stop = k >= 1 ? entryLvl + (k - 1) * R : entryLvl - R;
      const ruedas = since.length;
      const validated = hwm >= entryLvl + 0.5 * R;
      const fmtL = (x) => x.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const timeTxt = !validated && ruedas >= 10 ? ` · TIME-STOP: ${ruedas} ruedas sin validar +0,5R — revisar la tesis` : "";
      const nota = `RATCHET · STOP dinámico ${unit}${fmtL(stop)} · ${k >= 1 ? `ganaste ${k}R → protege ${k - 1 > 0 ? k - 1 + "R" : "breakeven"}` : "1×ATR bajo tu entrada"} · entrada ~${unit}${fmtL(entryLvl)} · R=${fmtL(R)} · solo sube, nunca baja${timeTxt}`;

      liveKeys.add(key);
      const mine = (ratchets || []).filter((r) => r.user_id === userId && r.ticker.toUpperCase() === tk);
      const lvlOf = (r) => (r.usd_ref != null ? Number(r.usd_ref) : Number(r.price));
      const newLvl = modo === "local_ars" ? toArs(stop) : stop;
      // Anti-spam: si ya DISPARÓ un ratchet a este nivel (o mayor), el aviso
      // está dado — no se recrea hasta que el stop suba de verdad. Si el
      // usuario borró la disparada, tampoco lo perseguimos al mismo nivel.
      const fired = mine.filter((r) => r.triggered_at);
      if (fired.some((r) => lvlOf(r) >= newLvl - 0.005)) continue;
      // Se borran TODAS las vivas, no la primera. `.find()` devolvia una sola:
      // si por lo que fuera quedaban dos sin disparar, cada corrida borraba una
      // e insertaba otra, asi que el sobrante quedaba para siempre. LP vio tres
      // ratchets de GGAL a 43,38 / 43,35 / 43,34, de tres corridas distintas.
      const vivas = mine.filter((r) => !r.triggered_at);
      const prev = vivas.length
        ? vivas.reduce((a, b) => (lvlOf(b) > lvlOf(a) ? b : a))   // la mas alta manda
        : null;
      if (prev && lvlOf(prev) != null && newLvl <= lvlOf(prev) + 0.005) continue; // nunca baja ni repite
      for (const v of vivas) await supabase.from("price_alerts").delete().eq("id", v.id);
      await supabase.from("price_alerts").insert({
        user_id: userId, ticker: tk, price: toArs(stop), dir: "down", nota,
        usd_ref: modo === "local_ars" ? null : Math.round(stop * 100) / 100, canal: "screen", origen: "tv",
      });
      log(`ratchet ${tk}: stop ${stop.toFixed(2)} (k=${k}, entrada ${entryLvl.toFixed(2)}, hwm ${hwm.toFixed(2)})`);
    } catch (e) { log(`[ratchet ${key}] ${e.message}`); }
  }
  // posiciones cerradas → su ratchet se retira (disparado o no)
  for (const r of ratchets || []) {
    const key = r.user_id + "|" + r.ticker.toUpperCase();
    if (groups.has(key) && !liveKeys.has(key)) await supabase.from("price_alerts").delete().eq("id", r.id);
  }
}

/* ───────── Régimen de cartera (Kaminski & Lo): modo defensa ─────────
 * Regla del paper adaptada: si la canasta de tenencias acumula < −4% en 12
 * meses → DEFENSA (reducir equity, refugio en caución/FCI); se vuelve a
 * NORMAL tras un mes (21 ruedas) de retorno no negativo. Mientras no exista
 * serie real de equity, la canasta es sintética: retorno ponderado por valor
 * de las tenencias actuales (subyacente USA/ADR — sin ruido CCL). Además
 * graba el equity ARS real del día en portfolio_equity para que en unos
 * meses la regla corra sobre la serie verdadera. */
async function regimePass() {
  const { data: pos } = await supabase.from("positions")
    .select("user_id,ticker,operation_type,quantity,entry_price,entry_date,created_at,broker")
    .in("instrument_type", ["cedear", "stock"]).neq("broker", "iol");
  if (!pos?.length) return;
  const [usaRes, cedRes] = await Promise.all([
    fetch("https://data912.com/live/usa_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/arg_cedears", { headers: UA }).then((r) => r.json()).catch(() => []),
  ]);
  const arsPx = {};
  for (const it of [...(cedRes || []), ...(usaRes || [])]) if (it?.symbol && Number(it.c) > 0 && !(it.symbol.toUpperCase() in arsPx)) arsPx[it.symbol.toUpperCase()] = Number(it.c);

  // net por usuario|ticker (walk simple: solo hace falta el neto)
  const perUser = new Map();
  for (const p of pos) {
    const u = p.user_id, tk = p.ticker.toUpperCase();
    if (!perUser.has(u)) perUser.set(u, new Map());
    const m = perUser.get(u);
    m.set(tk, (m.get(tk) || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0));
  }
  const candCache = new Map();
  const getRets = async (tk) => {
    if (candCache.has(tk)) return candCache.get(tk);
    const adr = ARG_ADR[tk];
    let d = await yahooCandles(adr ? adr.adr : tk, "1d", "1y");
    if (!d) d = await yahooCandles(tk + ".BA", "1d", "1y");
    const rets = new Map();
    if (d) for (let i = 1; i < d.length; i++) rets.set(d[i].t, d[i].c / d[i - 1].c - 1);
    candCache.set(tk, rets);
    return rets;
  };
  const todayAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

  for (const [userId, m] of perUser) {
    try {
      const holds = [...m.entries()].filter(([, q]) => q > 1e-6);
      if (!holds.length) continue;
      // pesos por valor ARS actual (fallback: sin feed no pondera)
      let totalV = 0;
      const w = new Map();
      for (const [tk, q] of holds) { const v = q * (arsPx[tk] || 0); if (v > 0) { w.set(tk, v); totalV += v; } }
      if (!(totalV > 0)) continue;
      // canasta sintética: retorno diario ponderado de las tenencias actuales
      const retMaps = new Map();
      for (const [tk] of w) retMaps.set(tk, await getRets(tk));
      const dates = [...new Set([].concat(...[...retMaps.values()].map((r) => [...r.keys()])))].sort();
      let cum = 1, peak = 1, dd = 0;
      const cums = [];
      for (const d of dates) {
        let r = 0;
        for (const [tk, val] of w) r += (val / totalV) * (retMaps.get(tk).get(d) || 0);
        cum *= 1 + r; peak = Math.max(peak, cum); dd = Math.min(dd, cum / peak - 1);
        cums.push(cum);
      }
      const ret12 = cum - 1;
      const ret1m = cums.length > 21 ? cum / cums[cums.length - 22] - 1 : 0;
      const { data: prevRow } = await supabase.from("portfolio_regime").select("regime").eq("user_id", userId).maybeSingle();
      const prev = prevRow?.regime || "normal";
      let regime = prev;
      if (prev === "normal" && ret12 < -0.04) regime = "defensa";
      else if (prev === "defensa" && ret1m >= 0) regime = "normal";
      await supabase.from("portfolio_regime").upsert({
        user_id: userId, regime,
        metric: { ret12: Math.round(ret12 * 1000) / 10, ret1m: Math.round(ret1m * 1000) / 10, dd: Math.round(dd * 1000) / 10, holdings: holds.length },
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
      await supabase.from("portfolio_equity").upsert({ user_id: userId, date: todayAR, value: Math.round(totalV) }, { onConflict: "user_id,date" });
      log(`regimen ${userId.slice(0, 8)}: ${regime} (12m ${(ret12 * 100).toFixed(1)}% · 1m ${(ret1m * 100).toFixed(1)}% · dd ${(dd * 100).toFixed(1)}%)`);
    } catch (e) { log(`[regimen] ${e.message}`); }
  }
}

/* ───────── Perfil de volumen (Mapa de posiciones, 08/08) ─────────
 * El análogo honesto del "mapa de liquidaciones" para mercados sin
 * derivados: en vez de inventar dónde estarían los stops, muestra a qué
 * PRECIOS se operó de verdad el último año. Los niveles con volumen
 * concentrado son zonas de pelea (imanes); los huecos son aire por donde
 * el precio viaja rápido. Reusa las velas que el motor ya baja.
 * Calcula 30 bins, el POC (precio con más volumen) y el área de valor
 * (el rango que concentra el 70% del volumen, método estándar de Market
 * Profile: se arranca en el POC y se suman los vecinos más pesados). */
function buildProfile(daily, nBins = 30) {
  const lo = Math.min(...daily.map((c) => c.l)), hi = Math.max(...daily.map((c) => c.h));
  if (!(hi > lo)) return null;
  const w = (hi - lo) / nBins;
  const vols = new Array(nBins).fill(0);
  for (const c of daily) {
    const px = (c.h + c.l + c.c) / 3; // precio típico de la rueda
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((px - lo) / w)));
    vols[i] += c.v || 0;
  }
  const total = vols.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  const pocIdx = vols.indexOf(Math.max(...vols));
  // Área de valor: 70% del volumen alrededor del POC.
  let lo_i = pocIdx, hi_i = pocIdx, acc = vols[pocIdx];
  while (acc < total * 0.7 && (lo_i > 0 || hi_i < nBins - 1)) {
    const down = lo_i > 0 ? vols[lo_i - 1] : -1;
    const up = hi_i < nBins - 1 ? vols[hi_i + 1] : -1;
    if (up >= down) { hi_i++; acc += vols[hi_i]; } else { lo_i--; acc += vols[lo_i]; }
  }
  return {
    poc: lo + (pocIdx + 0.5) * w,
    va_low: lo + lo_i * w,
    va_high: lo + (hi_i + 1) * w,
    bins: vols.map((v, i) => ({
      lo: Math.round((lo + i * w) * 100) / 100,
      hi: Math.round((lo + (i + 1) * w) * 100) / 100,
      vol: Math.round(v),
      pct: Math.round((v / total) * 10000) / 100,
    })),
  };
}

async function volumeProfilePass() {
  // Universo: lo que está en el tablero de alertas + lo que hay en cartera.
  const [{ data: al }, { data: pos }] = await Promise.all([
    supabase.from("price_alerts").select("ticker").eq("canal", "screen"),
    supabase.from("positions").select("ticker").in("instrument_type", ["cedear", "stock"]),
  ]);
  const tks = new Set();
  for (const r of [...(al || []), ...(pos || [])]) {
    const t = (r.ticker || "").trim().toUpperCase();
    if (t) tks.add(t);
  }
  let ok = 0;
  for (const tk of tks) {
    try {
      const adr = ARG_ADR[tk] || null;
      const sym = adr ? adr.adr : tk;
      let daily = await yahooCandles(sym, "1d", "1y");
      let usedSym = sym, moneda = "USD";
      if (!daily) {
        usedSym = tk + ".BA";
        daily = await yahooCandles(usedSym, "1d", "1y");
        moneda = "ARS";
        if (!daily) continue;
      }
      const p = buildProfile(daily);
      if (!p) continue;

      // SMA de 200 SEMANAS (~4 años): la base estructural del papel. No es
      // señal —comprar su toque es el caso contra-tendencia de AQR— pero mide
      // cuánto aire hay debajo del precio antes del piso multianual. Un papel
      // a +358% de su base (MU hoy) no tiene red cerca; uno a +37% (XOM) sí.
      let sma200w = null;
      try {
        const wk = await yahooCandles(usedSym, "1wk", "5y");
        if (wk && wk.length >= 200) {
          const ult = wk.slice(-200);
          sma200w = Math.round((ult.reduce((s, c) => s + c.c, 0) / 200) * 100) / 100;
        }
      } catch { /* sin la semanal el perfil sigue sirviendo */ }

      await supabase.from("volume_profile").upsert({
        ticker: tk, sym: usedSym, moneda,
        spot: Math.round(daily[daily.length - 1].c * 100) / 100,
        poc: Math.round(p.poc * 100) / 100,
        va_low: Math.round(p.va_low * 100) / 100,
        va_high: Math.round(p.va_high * 100) / 100,
        sma200w,
        bins: p.bins, updated_at: new Date().toISOString(),
      }, { onConflict: "ticker" });
      ok++;
    } catch (e) { log(`[perfil ${tk}] ${e.message}`); }
  }
  log(`perfil de volumen: ${ok}/${tks.size} papeles`);
}

/* ───────── Bot IOL sobre CEDEARs, en pesos (v2, 19/08/2026) ─────────
 *
 * QUÉ CAMBIÓ Y POR QUÉ. La v1 simulaba comprar la acción en el segmento USA de
 * IOL, en dólares. Pero LP opera CEDEARs: la plata está en la cuenta en pesos,
 * el instrumento cotiza en BYMA y la tarifa es otra. Todo eso estaba mal
 * modelado y hacía que los resultados del paper salieran optimistas.
 *
 * QUÉ OPERA. Tres papeles, y NO son todos la misma clase de instrumento:
 * MU y SNDK son CEDEARs (certificados sobre acciones de EE.UU.), mientras que
 * GGAL es una acción argentina — el papel local es la acción, y su ADR en NYSE
 * sólo aporta la serie en dólares. Los dos casos se compran en pesos en BYMA y
 * pagan la misma tarifa, pero el puente al dólar se calcula distinto (ver
 * ratioArs) y confundirlos rompe el dimensionamiento.
 *
 * EL MODELO, EN DOS MONEDAS. Los NIVELES se siguen calculando sobre el
 * subyacente en dólares: ahí está la serie limpia, el volumen real y la tesis
 * (uno compra "MU en 906", no "MU en 295.400 pesos", que se mueve solo porque
 * se movió el dólar). La EJECUCIÓN es en pesos sobre el CEDEAR. El puente es
 * el ratio implícito medido en vivo — precio del CEDEAR ÷ precio del
 * subyacente — que ya lleva adentro tanto el ratio de conversión como el CCL,
 * y se recalcula en cada pasada. Así, si el dólar salta 3% de un día para el
 * otro, el límite en pesos sube con él y la orden NO se dispara sola: sigue
 * esperando a que el papel llegue al precio de la tesis.
 *
 * TARIFA REAL (tarifario IOL, verificado 19/08/2026):
 *   comisión por perfil (gold 0,5% / platinum 0,3% / black 0,1%) + IVA 21%
 *   + derechos de mercado 0,05% + IVA. SIN mínimo por operación — el mínimo
 *   de US$2 era del segmento USA y acá no aplica.
 *   BONIFICACIÓN INTRADIARIA: si compra y venta caen en la misma rueda, IOL no
 *   cobra SU comisión en la segunda pata (quedan sólo los derechos). En gold
 *   eso baja la vuelta completa de 1,331% a 0,726%.
 *
 * LAS DOS LLAVES. Modo paper es el default y no se sale de él por accidente:
 * hacen falta `linked_brokers.bot_enabled = true` en la base Y `IOL_BOT_REAL=1`
 * en el VPS. Si aparece una sola de las dos, el worker no adivina: o se queda
 * en paper avisando, o se mata. Es la regla que escribió LP en su pre-mortem.
 */
// Universo del bot paper. Eran 3 y dos NUNCA calificaban (GGAL score 2/10,
// SNDK 4/10 contra un minimo de 7), asi que en 25 dias junto 5 operaciones y 4
// fueron MU: en los hechos era un bot de un solo papel. Se amplia a 15
// diversificando sectores — semis, big tech, consumo, salud, energia, LatAm —
// para que las senales no esten todas correlacionadas y la muestra crezca.
// Todos verificados con precio en data912 (arg_cedears + usa_stocks), que es lo
// que el bot necesita para derivar el ratio. El sizing no cambia: sigue siendo
// 1,5% del capital por trade, y CAP_ARS limita cuantas van simultaneas.
const BOT_TICKERS = String(process.env.IOL_BOT_TICKERS || "MU,SNDK,GGAL,NVDA,AMD,AAPL,MSFT,GOOGL,META,AMZN,KO,JNJ,XOM,MELI,NU")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const BOT_UNIVERSO = new Set(BOT_TICKERS);
const BOT_USER = process.env.IOL_BOT_USER || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const CAP_ARS = Number(process.env.IOL_BOT_CAP_ARS || 3000000);

/* Aviso por Telegram al duenio del bot, para ESPEJAR la operacion en Cocos.
 * El mismo bot de @midas_ar_BOT (token compartido via .env). Fire-and-forget:
 * un fallo de Telegram JAMAS debe frenar el ciclo de trading — se loguea y
 * sigue. Sin token configurado, no hace nada (comportamiento previo). */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
let _tgChatCache = null;
async function tgEspejo(texto) {
  if (!TG_TOKEN) return;
  try {
    if (!_tgChatCache) {
      const { data } = await supabase.from("telegram_links")
        .select("chat_id").eq("user_id", BOT_USER).eq("enabled", true).maybeSingle();
      _tgChatCache = data?.chat_id || null;
    }
    if (!_tgChatCache) { log("[tgEspejo] sin chat_id vinculado, no se envia"); return; }
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: _tgChatCache, text: texto, parse_mode: "HTML" }),
    });
    const j = await r.json().catch(() => null);
    if (!j?.ok) log("[tgEspejo] Telegram rechazo el mensaje:", JSON.stringify(j || r.status));
    else log("[tgEspejo] enviado ok, msg", j.result?.message_id);
  } catch (e) { log("[tgEspejo]", e.message); }
}
/* Cocos no acepta cualquier precio: la pantalla exige multiplos "redondos"
 * (SNDK a ~$13.712 rechazo el limite exacto, acepto 13.720). Para una COMPRA
 * el redondeo va siempre para ABAJO: una orden espejo que queda por encima
 * del limite del bot puede llenarse sola en un rebote y dejar una posicion
 * huerfana sin bot que la maneje (31/08: se llevo el susto pero salio bien).
 * Escala observada, no documental — si Cocos rechaza un multiplo de estos,
 * el que corrige es este piso. */
function tickPiso(pxArs) {
  const px = Number(pxArs) || 0;
  const tick = px >= 50000 ? 50 : px >= 10000 ? 10 : px >= 1000 ? 5 : 1;
  return Math.floor(px / tick) * tick;
}
const BOT_RISK = 0.015;      // riesgo por trade: 1,5% del capital
const BOT_VENTANA_H = 48;    // la orden límite vive 48hs y se cae sola
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;                                  // 0,0605%
const COMISION = { gold: 0.005, platinum: 0.003, black: 0.001 };
const PERFIL = String(process.env.IOL_PERFIL || "gold").toLowerCase();

// TARIFA SOMBRA: qué habría costado la misma operación en Cocos. No es una
// estimación — sale de medir 183 operaciones reales de CEDEARs del libro de LP
// ($11.093 M operados): Cocos NO cobra comisión, sólo derechos de mercado más
// IVA, y eso da 0,0545% por punta contra 0,6655% de IOL Gold. Doce veces menos.
//
// Se registra en paralelo porque el bot está en IOL por una sola razón —es el
// único que se puede automatizar hoy, Cocos todavía no tiene API— y esa razón
// es transitoria. Sin la sombra, dentro de tres meses el scorecard diría si la
// estrategia funciona EN IOL GOLD, y se correría el riesgo de descartar algo
// que sí funciona donde va a terminar operándose. Con stop -2,5% y target +6%
// el listón es 45% de aciertos en Gold y 34% en Cocos: misma estrategia, dos
// varas distintas.
// 0,050% de derechos + IVA. BYMA cobra DOS tasas distintas, medidas exactas
// sobre 183 operaciones reales de CEDEARs de LP: 0,044% cuando se compra y
// vende el mismo papel en el dia ("Compra/Venta Trading", 94 ops) y 0,050%
// cuando no ("Compra/Venta", 89 ops). Son doce por ciento de diferencia.
//
// El bot opera SWING —entra un dia y sale otro—, asi que le corresponde la
// cara. Antes habia un 0,0545% que era el promedio ponderado de las dos, y eso
// no describe ninguna de las dos operatorias: subestimaba el swing y
// sobreestimaba el intradia.
//
// En Cocos no hay comision del broker: se paga solo esto.
const FEE_COCOS = 0.0005 * IVA;

// bonificada = segunda pata de una operatoria intradiaria: IOL no cobra su
// comisión, quedan sólo los derechos de mercado.
const feePunta = (notionalArs, bonificada) =>
  notionalArs * (bonificada ? DERECHOS : (COMISION[PERFIL] ?? COMISION.gold) * IVA + DERECHOS);

const diaAr = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");

let MODO_REAL = false;
let avisoModo = "";

/* Resuelve el modo en cada pasada. No cachea: si LP apaga la bandera en la
 * base, la próxima pasada ya lo respeta sin reiniciar nada. */
async function resolverModo() {
  const quiereReal = process.env.IOL_BOT_REAL === "1";
  const { data } = await supabase.from("linked_brokers")
    .select("bot_enabled,status,broker_account_id")
    .eq("user_id", BOT_USER).eq("broker", "iol").maybeSingle();
  const flagDb = Boolean(data?.bot_enabled) && data?.status === "active";

  if (quiereReal && !flagDb) {
    log("[bot] ABORTO: IOL_BOT_REAL=1 en el VPS pero bot_enabled=false en la base.");
    log("[bot] Las dos llaves tienen que estar puestas a propósito. No opero a ciegas.");
    process.exit(1);
  }
  if (flagDb && !quiereReal && avisoModo !== "db-sin-env") {
    avisoModo = "db-sin-env";
    log("[bot] bot_enabled=true en la base pero falta IOL_BOT_REAL=1 en el VPS: sigo en PAPER.");
  }
  MODO_REAL = quiereReal && flagDb;
  if (MODO_REAL && avisoModo !== "real") {
    avisoModo = "real";
    log(`[bot] *** MODO REAL ACTIVO *** cuenta ${data.broker_account_id} · papeles ${BOT_TICKERS.join(", ")} · capital ${pesos(CAP_ARS)} · perfil ${PERFIL}`);
  }
}

/* Encola los papeles del bot para análisis aunque LP no tenga alerta armada
 * sobre ellos. Sin esto el bot dependería de que él mantenga vivo el tablero,
 * y un papel se le podría caer del radar sin que nadie se entere. */
async function botEnqueue() {
  if (!inUsMarketWindow()) return;
  const { data: pend } = await supabase.from("tv_analysis_queue")
    .select("ticker").eq("user_id", BOT_USER).eq("status", "pending");
  const yaEsta = new Set((pend || []).map((p) => String(p.ticker).toUpperCase()));
  const faltan = BOT_TICKERS.filter((t) => !yaEsta.has(t));
  if (!faltan.length) return;
  await supabase.from("tv_analysis_queue").insert(
    faltan.map((t) => ({ user_id: BOT_USER, ticker: t, source: "bot-iol", status: "pending" }))
  );
  log(`[bot] encolados para análisis: ${faltan.join(", ")}`);
}

/* Feeds de precio: ARS del instrumento que se opera de verdad — CEDEAR para los
 * papeles extranjeros, la acción misma para los argentinos — y USD del subyacente sobre el que se calculó la tesis.
 *
 * OJO CON LOS ADR (medido el 19/08/2026): data912 /live/usa_stocks trae 3.159
 * instrumentos pero NO incluye los ADR argentinos — GGAL e YPF no están. Sin
 * el precio en dólares el bot no puede evaluar el fill, así que GGAL quedaría
 * fuera en silencio, que es la peor forma de fallar. Para esos casos se cae a
 * Yahoo, con caché de 2 minutos: son uno o dos símbolos, no vale la pena
 * pegarle en cada pasada de 60 segundos. */
const yCache = new Map();
async function yahooSpot(sym) {
  const hit = yCache.get(sym);
  if (hit && Date.now() - hit.t < 120000) return hit.v;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`, { headers: UA });
    const j = await r.json();
    const v = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    const num = Number.isFinite(v) ? Number(v) : null;
    yCache.set(sym, { v: num, t: Date.now() });
    return num;
  } catch { return null; }
}

/* Mínimo de la rueda, para no subestimar las ejecuciones.
 *
 * EL SESGO QUE ARREGLA. El paper miraba el último precio cada 60 segundos y
 * daba por ejecutada la orden sólo si en ese instante estaba por debajo del
 * límite. Pero una orden límite de verdad queda DESCANSANDO en el book de IOL:
 * si el papel la perfora un segundo y rebota, la orden se ejecuta igual. El
 * paper se perdía todas esas mechas, así que reportaba menos ejecuciones de las
 * que habría habido con plata puesta — justo el número con el que se decide si
 * la estrategia sirve. Comparar el límite contra el MÍNIMO de la rueda replica
 * lo que hace el book.
 *
 * Sigue siendo conservador a propósito: se ejecuta al precio límite, nunca
 * mejor, aunque el mínimo haya estado más abajo. */
const minCache = new Map();
async function minRueda(sym) {
  const hit = minCache.get(sym);
  if (hit && Date.now() - hit.t < 120000) return hit.v;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`, { headers: UA });
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const lows = (res?.indicators?.quote?.[0]?.low || []).filter((x) => Number.isFinite(x));
    const v = lows.length ? Math.min(...lows) : null;
    minCache.set(sym, { v, t: Date.now() });
    return v;
  } catch { return null; }
}

async function botFeeds() {
  const [dol, ced, loc, usa] = await Promise.all([
    fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).then((r) => r.json()).catch(() => null),
    fetch("https://data912.com/live/arg_cedears", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/arg_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/usa_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
  ]);
  const ccl = Number(dol?.venta) || Number(dol?.compra) || null;
  const ars = {}, arsAsk = {}, arsBid = {}, usd = {};
  for (const it of [...(ced || []), ...(loc || [])]) {
    const s = String(it?.symbol || "").toUpperCase();
    if (!s || !(Number(it.c) > 0)) continue;
    ars[s] = Number(it.c);
    if (Number(it.px_ask) > 0) arsAsk[s] = Number(it.px_ask);
    if (Number(it.px_bid) > 0) arsBid[s] = Number(it.px_bid);
  }
  for (const it of usa || []) {
    const s = String(it?.symbol || "").toUpperCase();
    if (s && Number(it.c) > 0) usd[s] = Number(it.c);
  }
  // Relleno por Yahoo sólo lo que falta de los papeles del bot.
  for (const tk of BOT_TICKERS) {
    const sym = (ARG_ADR[tk] ? ARG_ADR[tk].adr : tk).toUpperCase();
    if (usd[sym] > 0) continue;
    const v = await yahooSpot(sym);
    if (v > 0) usd[sym] = v;
  }
  return { ars, arsAsk, arsBid, usd, ccl };
}

/* Pesos por cada dólar de precio del subyacente: el puente entre la tesis (que
 * se piensa en dólares) y la ejecución (que se paga en pesos).
 *
 * SON DOS INSTRUMENTOS DISTINTOS, aunque los dos se compren en pesos en BYMA:
 *
 *  - CEDEAR (MU, SNDK): certificado sobre una acción extranjera. El puente se
 *    MIDE en vivo dividiendo el precio del CEDEAR por el del subyacente, y así
 *    quedan adentro tanto el ratio de conversión como el CCL del momento, sin
 *    depender de ninguna tabla.
 *
 *  - ACCIÓN ARGENTINA con ADR (GGAL, YPFD): acá el papel local ES la acción, no
 *    un certificado de nada. Lo que se opera es GGAL en BYMA; el ADR de NYSE es
 *    sólo de dónde sacamos la serie limpia en dólares. El puente es CCL ÷ r,
 *    donde r = cuántas acciones locales entran en un ADR.
 *
 * EL PELIGRO DE r. Ese número vive en la tabla ARG_ADR y NO se mide: si la
 * empresa parte el papel, queda viejo y la conversión se va por el factor del
 * split, en silencio. Ya pasó: YPFD tenía r=1 hasta el split 10:1 del 04/08 y
 * hubo que corregirlo a mano. Por eso, cuando hay precio local observado, se
 * contrasta contra el reconstruido: si difieren más de 3% no se opera el papel.
 * Un ratio podrido no produce una señal fea que se note — produce un tamaño de
 * posición diez veces mayor al que corresponde, que es de lo que no se vuelve.
 *
 * Si falta cualquier pata devuelve null y el bot saltea ese papel: prefiero
 * perder una señal antes que dimensionar con un tipo de cambio inventado. */
function ratioArs(tk, sym, f) {
  const adr = ARG_ADR[tk];
  if (adr) {
    if (!(f.ccl > 0)) return null;
    const r = f.ccl / adr.r;
    // Control cruzado contra el mercado local, cuando lo hay.
    const obs = f.ars[tk], usd = f.usd[sym];
    if (obs > 0 && usd > 0) {
      const desvio = Math.abs((usd * r) / obs - 1);
      if (desvio > 0.03) {
        log(`[bot ${tk}] NO OPERO: el ratio de la tabla (${adr.r} acciones por ADR) reconstruye ${pesos(usd * r)} pero el papel cotiza ${pesos(obs)} — ${(desvio * 100).toFixed(1)}% de desvío. Puede ser un split sin registrar. Revisar ARG_ADR.`);
        return null;
      }
    }
    return r;
  }
  const a = f.ars[tk], u = f.usd[sym];
  if (!(a > 0) || !(u > 0)) return null;
  return a / u;
}

/* ── Ejecución real en IOL (sólo con las dos llaves puestas) ──
 * El worker corre 24/7 en el VPS y no puede usar el MCP de IOL: el MCP es el
 * canal de la sesión interactiva. Usa la API REST con el mismo token que ya
 * mantienen iol-cash-sync e iol-positions-sync.
 * OJO: esta parte todavía NO se probó contra la API en vivo porque la cuenta
 * no está fondeada. Antes de flipear las llaves hay que mandar una orden de
 * prueba chica y verificar la forma de la respuesta. */
async function iolToken() {
  const { data } = await supabase.from("linked_brokers")
    .select("access_token,access_expires_at").eq("user_id", BOT_USER).eq("broker", "iol").maybeSingle();
  if (!data?.access_token) throw new Error("sin access_token de IOL");
  if (data.access_expires_at && new Date(data.access_expires_at) <= new Date())
    throw new Error("access_token de IOL vencido (lo revive el keep-alive)");
  return data.access_token;
}

async function iolOrden(lado, simbolo, cantidad, precio) {
  const token = await iolToken();
  const url = `https://api.invertironline.com/api/v2/operar/${lado === "compra" ? "Comprar" : "Vender"}`;
  const body = {
    mercado: "bCBA", simbolo, cantidad,
    precio: Math.round(precio * 100) / 100,
    plazo: "t1", validez: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19),
    tipoOrden: "precioLimite",
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) throw new Error(`IOL ${lado} ${simbolo}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return String(j?.numeroOperacion ?? j?.numero ?? j?.id ?? "");
}

const descartes = new Map();
function botDescarte(tk, nivel, faltas) {
  const clave = `${tk}|${Math.round(nivel * 100)}|${faltas.join("+")}`;
  const antes = descartes.get(clave);
  if (antes && Date.now() - antes < 6 * 3600 * 1000) return;  // el mismo motivo, una vez cada 6hs
  descartes.set(clave, Date.now());
  log(`[bot ${tk}] setup en US$${nivel.toFixed(2)} NO califica: ${faltas.join(" · ")}`);
}

/* Cancela una orden apoyada. Se usa para re-alinear el límite en pesos cuando
 * el tipo de cambio lo corrió. Igual que iolOrden, NO se probó contra la API en
 * vivo todavía. */
async function iolCancelar(numero) {
  const token = await iolToken();
  const r = await fetch(`https://api.invertironline.com/api/v2/operar/Cancelar/${encodeURIComponent(numero)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`IOL cancelar ${numero}: ${r.status}`);
  return true;
}

// Cuánto puede despegarse el límite apoyado del nivel vigente antes de
// recolocar. Medido sobre 231 ruedas de 2026, el CCL se mueve 0,27% en dos días
// (mediana) y 1,20% en el percentil 90: con 0,3% se recolocaría casi siempre y
// con 1% se dejaría pasar media cola. 0,5% deja quieta la orden en el caso
// normal y la corrige cuando el movimiento empieza a pesar contra un stop de
// 2,5%.
const DERIVA_MAX = 0.005;

async function paperSignal(sym, tk, entry, stop, target, score, rr, senal) {
  if (!BOT_UNIVERSO.has(String(tk).toUpperCase())) return;   // opera 3 papeles, no todo el tablero
  const { data: ex } = await supabase.from("paper_iol_trades").select("id,status,entry_limit").eq("sym", sym).in("status", ["pending", "open"]);
  if ((ex || []).some((t) => t.status === "open")) return;          // ya hay posición en el papel
  const pend = (ex || []).filter((t) => t.status === "pending");
  if (pend.some((t) => Math.abs(Number(t.entry_limit) - entry) / entry < 0.005)) return; // misma señal (rearme)
  if (pend.length) {
    await supabase.from("paper_iol_trades").update({
      status: "cancelled", exit_reason: "reemplazada por señal nueva", veredicto: "sin_fill",
      nota_sim: "reemplazada por una señal más fresca antes de llegar a ejecutarse",
    }).in("id", pend.map((t) => t.id));
    // El espejo en Cocos tiene que enterarse: su orden vieja quedaria colgada
    // mientras el bot ya esta mirando otro nivel.
    for (const p of pend) {
      await tgEspejo(
        `<b>BOT · CANCELADA ${tk}</b>\n` +
        `La orden a US$${Number(p.entry_limit).toFixed(2)} se reemplaza por una señal nueva (viene otro aviso con el nivel fresco).\n\n` +
        `Si la espejaste en Cocos, CANCELALA antes de poner la nueva.`);
    }
  }

  const f = await botFeeds();
  const rArs = ratioArs(String(tk).toUpperCase(), String(sym).toUpperCase(), f);
  if (!rArs) { log(`[bot ${tk}] sin precio local o sin precio del subyacente: no dimensiono a ciegas`); return; }

  // Sizing por riesgo, EN PESOS sobre el instrumento que se compra de verdad.
  const riesgoUnidad = (entry - stop) * rArs;
  if (!(riesgoUnidad > 0)) return;
  let qty = Math.floor((CAP_ARS * BOT_RISK) / riesgoUnidad);
  // Sin palanca: lo comprometido en órdenes vivas de OTROS papeles limita ésta.
  const { data: vivas } = await supabase.from("paper_iol_trades")
    .select("qty,px_ars_entrada,entry_limit,ratio").in("status", ["pending", "open"]).neq("sym", sym);
  const comprometido = (vivas || []).reduce(
    (s, t) => s + t.qty * Number(t.px_ars_entrada ?? Number(t.entry_limit) * Number(t.ratio ?? 0)), 0);
  const disponible = CAP_ARS - comprometido;
  const precioUnidad = entry * rArs;
  qty = Math.min(qty, Math.floor(disponible / precioUnidad));
  if (qty < 1) {
    log(`[bot ${tk}] señal descartada: quedan ${pesos(disponible)} y cada unidad cuesta ${pesos(precioUnidad)}`);
    return;
  }

  const fila = {
    ticker: tk, sym, senal, score, rr, status: "pending", qty,
    entry_limit: entry, stop, stop_inicial: stop, target, r_value: entry - stop,
    modo: MODO_REAL ? "real" : "paper", perfil: PERFIL, ratio: Math.round(rArs * 100) / 100,
    regla_salida: "trailing_2r",
    px_ars_orden: Math.round(precioUnidad),
    nota_sim: `Nivel de compra US$${entry.toFixed(2)} ≈ ${pesos(precioUnidad)} por unidad. Esperando que el papel baje a buscarlo. Si llega: compra ${qty}, vende en US$${target.toFixed(2)} ≈ ${pesos(target * rArs)}, corta en US$${stop.toFixed(2)} ≈ ${pesos(stop * rArs)}.`,
  };
  if (MODO_REAL) {
    try { fila.broker_order_id = await iolOrden("compra", tk, qty, precioUnidad); }
    catch (e) { log(`[bot ${tk}] NO se mandó la orden real: ${e.message}`); return; }
  }
  const { error } = await supabase.from("paper_iol_trades").insert(fila);
  if (error) throw new Error(error.message);
  log(`[bot ${tk}] ${MODO_REAL ? "ORDEN REAL" : "orden simulada"}: ${qty} × ${pesos(precioUnidad)} (US${entry.toFixed(2)}) · stop ${stop.toFixed(2)} · target ${target.toFixed(2)} · compromete ${pesos(qty * precioUnidad)}`);
  await tgEspejo(
    `<b>BOT · orden colocada</b> (${MODO_REAL ? "IOL real" : "simulada"})\n` +
    `<b>COMPRA ${qty} × ${tk}</b> limite ${pesos(precioUnidad)} (US${entry.toFixed(2)})\n` +
    `Stop ${pesos(stop * rArs)} · Target ${pesos(target * rArs)}\n` +
    `score ${score}/10 · R:R ${Number(rr).toFixed(1)}\n\n` +
    `Para espejar en Cocos: limite ${pesos(tickPiso(precioUnidad))} (redondeado al tick, para ABAJO: quedarse afuera es mejor que pagar de mas), misma cantidad o proporcional. Te aviso si entra, si cierra o si se cancela.`);
}

async function paperPass() {
  await resolverModo();
  const { data: trades } = await supabase.from("paper_iol_trades").select("*").in("status", ["pending", "open"]);
  if (!trades?.length) return;
  const now = Date.now();
  for (const t of trades.filter((x) => x.status === "pending" && now - new Date(x.created_at).getTime() > BOT_VENTANA_H * 3600 * 1000)) {
    await supabase.from("paper_iol_trades").update({
      status: "cancelled", exit_reason: `expirada ${BOT_VENTANA_H}h sin fill`, veredicto: "sin_fill",
      nota_sim: `El papel nunca bajó a US$${Number(t.entry_limit).toFixed(2)} en ${BOT_VENTANA_H}hs: la orden se cayó sola, sin costo. No hubo decisión que juzgar.`,
    }).eq("id", t.id);
    log(`[bot ${t.ticker}] orden expirada sin ejecutarse (el precio no llegó al nivel)`);
    await tgEspejo(
      `<b>BOT · CANCELADA ${t.ticker}</b>\n` +
      `La orden de compra a ${pesos(Number(t.px_ars_orden) || Number(t.entry_limit) * Number(t.ratio || 0))} expiro sin ejecutarse.\n\n` +
      `Si la espejaste en Cocos, CANCELALA — el bot ya no la sigue.`);
  }
  if (!inUsMarketWindow()) return;

  const f = await botFeeds();
  for (const t of trades) {
    if (t.status === "cancelled") continue;
    const tkU = String(t.ticker).toUpperCase(), symU = String(t.sym).toUpperCase();
    const p = f.usd[symU];
    const rArs = ratioArs(tkU, symU, f);
    if (!p || !rArs) continue;

    if (t.status === "pending") {
      /* RE-ALINEAR EL LÍMITE EN PESOS.
       *
       * El fill se evalúa sobre el subyacente en dólares —ahí está la tesis: se
       * compra "MU en 915", no "MU en 289.581 pesos"— pero la orden que queda
       * apoyada en el broker está en pesos y no se entera de que el tipo de
       * cambio se movió. Sin esto, paper y real divergen: el paper seguiría el
       * nivel en dólares y el real quedaría clavado en un precio que ya no lo
       * representa. Y el paper existe justamente para predecir el real.
       *
       * Sólo aplica en modo real: en paper no hay orden que corregir, el nivel
       * se recalcula solo en cada pasada. */
      if (MODO_REAL && t.broker_order_id && t.px_ars_orden > 0) {
        const deberia = Number(t.entry_limit) * rArs;
        const deriva = Math.abs(deberia / Number(t.px_ars_orden) - 1);
        if (deriva > DERIVA_MAX) {
          try {
            await iolCancelar(t.broker_order_id);
            const nuevo = await iolOrden("compra", t.ticker, t.qty, deberia);
            await supabase.from("paper_iol_trades").update({
              broker_order_id: nuevo,
              px_ars_orden: Math.round(deberia),
              recolocaciones: (t.recolocaciones || 0) + 1,
            }).eq("id", t.id);
            log(`[bot ${t.ticker}] orden recolocada: el dólar la corrió ${(deriva * 100).toFixed(2)}% · ${pesos(t.px_ars_orden)} → ${pesos(deberia)}`);
          } catch (e) {
            log(`[bot ${t.ticker}] NO se pudo recolocar (${e.message}) — la orden vieja sigue apoyada en ${pesos(t.px_ars_orden)}`);
          }
        }
      }
      // Una orden límite descansa en el book: alcanza con que el papel haya
      // TOCADO el nivel en algún momento de la rueda, no que esté ahí ahora.
      const lim = Number(t.entry_limit);
      const bajo = p <= lim ? p : await minRueda(symU);
      if (!(bajo <= lim)) continue;
      // Fill: la CONDICIÓN se evalúa en dólares (la tesis es sobre el papel),
      // el PRECIO se toma en pesos del papel local pagando la punta vendedora,
      // que es lo que cuesta de verdad cruzarse contra el book.
      const pxUsd = Math.min(lim, p > 0 ? Math.max(p, bajo) : lim);
      // El precio en pesos sale del NIVEL, no del ask del momento.
      // Estaba usando el ask y era un error grueso: el ask refleja dónde está
      // el papel AHORA, no dónde se ejecutó la orden. Con MU llegó a inventar
      // $4.644 de sobreprecio por unidad — 1,6%, más que una vuelta completa
      // de comisiones. Una orden límite descansando en el book es el lado
      // PASIVO: la cruza un vendedor y se ejecuta al límite, sin pagar spread.
      const pxArs = Math.round(pxUsd * rArs);
      await supabase.from("paper_iol_trades").update({
        status: "open", entry_price: pxUsd, entry_ts: new Date().toISOString(),
        px_ars_entrada: pxArs, ratio: Math.round(rArs * 100) / 100,
        nota_sim: `LLEGÓ al nivel. Entró ${t.qty} × ${pesos(pxArs)} (US$${pxUsd.toFixed(2)}), total ${pesos(pxArs * t.qty)}. Vende en el target US$${Number(t.target).toFixed(2)} ≈ ${pesos(Number(t.target) * rArs)}; corta en el stop US$${Number(t.stop).toFixed(2)} ≈ ${pesos(Number(t.stop) * rArs)}.`,
      }).eq("id", t.id);
      log(`[bot ${t.ticker}] LLEGÓ AL NIVEL → ${MODO_REAL ? "compra ejecutada" : "fill simulado"} ${t.qty} × ${pesos(pxArs)} · vendería en ${pesos(Number(t.target) * rArs)} / corta en ${pesos(Number(t.stop) * rArs)}`);
      await tgEspejo(
        `<b>BOT · ENTRO ${t.ticker}</b>\n` +
        `Fill ${t.qty} × ${pesos(pxArs)} (US${pxUsd.toFixed(2)}) · total ${pesos(pxArs * t.qty)}\n` +
        `Target ${pesos(Number(t.target) * rArs)} · Stop ${pesos(Number(t.stop) * rArs)}\n\n` +
        `Si espejaste en Cocos, ya deberias estar comprado. Guarda estos niveles.`);
      continue;
    }

    const entry = Number(t.entry_price), R = Number(t.r_value);
    let stop = Number(t.stop);
    /* TRAILING DESDE +2R, no desde +1R (cambiado el 20/08/2026).
     *
     * La versión anterior movía el stop a punto de equilibrio apenas la
     * posición daba +1R, y eso contradecía el filtro de entrada. R es la
     * distancia al stop —típicamente 2 o 3%—, así que apenas el papel subía eso
     * el stop saltaba a la entrada y cualquier retroceso cerraba la operación.
     * Pero para entrar se exige R:R >= 2, o sea que el target vive en 2R o más:
     * quedaba matemáticamente casi inalcanzable.
     *
     * El backtest con las funciones de este mismo worker sobre 5 años de MU y
     * GGAL y 1,5 de SNDK lo mostró crudo: de 22 operaciones UNA llegó al target
     * (12 por stop, 9 por trailing) y el movimiento bruto medio fue +0,51% —
     * cuando el filtro promete 2:1. Con el arranque en +2R: 4 de 20 al target y
     * bruto medio +2,20%.
     *
     * OJO CON ESOS NÚMEROS: se probaron cuatro variantes sobre ~20 operaciones
     * y se eligió la mejor, con t-stat de 0,19 y 1,23. Estadísticamente no
     * prueban nada. Lo que justifica el cambio es que un sistema que pide 2:1
     * para entrar y se sale en 1:1 se contradice solo, y eso es aritmética, no
     * muestra. El backtest únicamente lo hizo visible.
     *
     * Ahora: +2R → breakeven, +3R → protege 1R, y así. Nunca baja.
     * Las operaciones anteriores quedan marcadas regla_salida='trailing_1r'
     * para que el scorecard no promedie dos estrategias distintas. */
    const k = Math.floor((p - entry) / R);
    if (k >= 2 && entry + (k - 2) * R > stop) {
      stop = entry + (k - 2) * R;
      await supabase.from("paper_iol_trades").update({ stop }).eq("id", t.id);
      log(`[bot ${t.ticker}] trailing: stop sube a US$${stop.toFixed(2)} (+${k}R)`);
    }
    /* MARCA A MERCADO EN PESOS (26/08/2026).
     *
     * Hasta acá el resultado en pesos sólo existía al cerrar, así que mientras
     * la operación estaba viva sólo se veía el lado dólar. No son lo mismo: el
     * CEDEAR se mueve con el papel Y con el CCL. Medido sobre la MU abierta:
     * +2,46% en dólares contra +2,95% en pesos — medio punto que puso el dólar.
     *
     * Importa porque son decisiones distintas: el stop y el target están
     * calculados sobre el precio en DÓLARES, pero lo que entra a la caja es el
     * resultado en PESOS.
     *
     * Se valúa contra la punta COMPRADORA (bid), que es a lo que podrías
     * vender ahora — no contra el último operado, que puede estar arriba de lo
     * que el mercado te paga. Si no hay bid, cae al teórico por el ratio. */
    {
      const entArs = Number(t.px_ars_entrada);
      if (entArs > 0 && rArs > 0) {
        const teoricoAhora = Math.round(p * rArs);
        const bidAhora = f.arsBid[tkU];
        const pxArsAhora = bidAhora > 0 ? Math.min(teoricoAhora, bidAhora) : teoricoAhora;
        // comisiones de las DOS puntas: la de entrada ya se pagó, la de salida
        // se pagaría al cerrar. El no realizado se muestra neto de las dos para
        // que sea comparable con el pnl_ars de una cerrada.
        const feesEst = feePunta(entArs * t.qty, false) + feePunta(pxArsAhora * t.qty, false);
        const pnlArsAb = (pxArsAhora - entArs) * t.qty - feesEst;
        const pnlUsdAb = (p - Number(t.entry_price)) * t.qty;
        await supabase.from("paper_iol_trades").update({
          px_ars_actual: pxArsAhora,
          pnl_ars_abierto: Math.round(pnlArsAb),
          pnl_usd_abierto: Math.round(pnlUsdAb * 100) / 100,
          marcado_at: new Date().toISOString(),
        }).eq("id", t.id);
      }
    }

    let exitUsd = null, reason = null;
    if (p <= stop) { exitUsd = Math.min(stop, p); reason = stop > Number(t.stop_inicial) ? "trailing" : "stop"; }
    else if (p >= Number(t.target)) { exitUsd = Math.max(Number(t.target), p); reason = "target"; }
    if (exitUsd == null) continue;

    // Salida en pesos contra la punta compradora (se vende al bid).
    // La salida por target es una orden límite descansando arriba: se ejecuta
    // al nivel, pasiva. La salida por stop es a mercado — ahí sí se cruza
    // contra la punta compradora y se paga el spread. Si el bid está peor que
    // el nivel, mando el peor de los dos: en un stop nunca te sale mejor.
    const teorico = Math.round(exitUsd * rArs);
    const bid = f.arsBid[tkU];
    const pxArsSal = reason === "target" ? teorico : (bid > 0 ? Math.min(teorico, bid) : teorico);
    const pxArsEnt = Number(t.px_ars_entrada);
    const intradia = t.entry_ts ? diaAr(t.entry_ts) === diaAr(new Date()) : false;
    const fees = feePunta(pxArsEnt * t.qty, false) + feePunta(pxArsSal * t.qty, intradia);
    const pnlArs = (pxArsSal - pxArsEnt) * t.qty - fees;
    // La misma operación con la tarifa de Cocos. En Cocos no hay bonificación
    // intradiaria que modelar: como no cobran comisión, las dos patas cuestan
    // igual y sólo se pagan los derechos de mercado.
    const feesAlt = (pxArsEnt + pxArsSal) * t.qty * FEE_COCOS;
    const pnlAlt = (pxArsSal - pxArsEnt) * t.qty - feesAlt;
    const veredicto = pnlArs > 0 ? "acierto" : "error";

    let ordenSalida = null;
    if (MODO_REAL) {
      try { ordenSalida = await iolOrden("venta", t.ticker, t.qty, pxArsSal); }
      catch (e) { log(`[bot ${t.ticker}] NO se pudo mandar la venta real: ${e.message} — la posición sigue abierta`); continue; }
    }

    await supabase.from("paper_iol_trades").update({
      status: "closed", exit_price: exitUsd, exit_ts: new Date().toISOString(), exit_reason: reason,
      px_ars_salida: pxArsSal, fees_ars: Math.round(fees), pnl_ars: Math.round(pnlArs),
      fees_ars_alt: Math.round(feesAlt), pnl_ars_alt: Math.round(pnlAlt), tarifa_alt: "cocos",
      intradia, veredicto,
      pnl_pct: Math.round((pnlArs / (pxArsEnt * t.qty)) * 10000) / 100,
      broker_order_id: ordenSalida || t.broker_order_id,
      nota_sim: `Cerró por ${reason}${intradia ? " el mismo día (IOL bonifica la comisión de la segunda pata)" : ""}. Vendió ${t.qty} × ${pesos(pxArsSal)} contra ${pesos(pxArsEnt)} de entrada. Comisiones ${pesos(fees)}. Resultado ${pnlArs >= 0 ? "+" : "-"}${pesos(Math.abs(pnlArs))} → la decisión fue ${veredicto === "acierto" ? "CORRECTA" : "EQUIVOCADA"}.`,
    }).eq("id", t.id);
    log(`[bot ${t.ticker}] CIERRE ${reason}${intradia ? " (intradía)" : ""}: ${pesos(pxArsSal)} · comisiones ${pesos(fees)} · P&L ${pnlArs >= 0 ? "+" : "-"}${pesos(Math.abs(pnlArs))} · ${veredicto.toUpperCase()}`);
    await tgEspejo(
      `<b>BOT · SALIDA ${t.ticker}</b> por <b>${reason}</b>\n` +
      `<b>VENDE ${t.qty} × ${t.ticker}</b> a ~${pesos(pxArsSal)} (US${exitUsd.toFixed(2)})\n` +
      `P&L simulado: ${pnlArs >= 0 ? "+" : "-"}${pesos(Math.abs(pnlArs))}\n\n` +
      `Si espejaste en Cocos: VENDER ahora al mercado o con limite cerca de ${pesos(pxArsSal)}.`);
    log(`[bot ${t.ticker}]   la misma en Cocos: comisiones ${pesos(feesAlt)} · P&L ${pnlAlt >= 0 ? "+" : "-"}${pesos(Math.abs(pnlAlt))}`);
  }
}


/* ───────── Loop persistente ───────── */
async function loop() {
  log("niveles-auto v7 arrancando (cola 60s; paper IOL 60s; rearme 15 min; ratchet 30 min; confirmaciones 10 min; tracks 60 min)");
  await resolverModo().catch((e) => log("[bot]", e.message));
  log(`[bot] modo ${MODO_REAL ? "REAL" : "PAPER (simulacion)"} · papeles ${BOT_TICKERS.join(", ")} · capital ${pesos(CAP_ARS)} · perfil ${PERFIL} · comision ida y vuelta ${(((COMISION[PERFIL] ?? COMISION.gold) * IVA + DERECHOS) * 200).toFixed(3)}%`);
  let lastTracks = 0, lastConfirm = 0, lastRearm = 0, lastRatchet = 0, lastRegime = 0, lastProfile = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (Date.now() - lastRearm > 15 * 60 * 1000) {
        await autoRearm().catch((e) => log("[rearm]", e.message));
        await botEnqueue().catch((e) => log("[bot enqueue]", e.message));
        lastRearm = Date.now();
      }
      if (Date.now() - lastRatchet > 30 * 60 * 1000) {
        await ratchetPass().catch((e) => log("[ratchet]", e.message));
        lastRatchet = Date.now();
      }
      if (Date.now() - lastRegime > 4 * 60 * 60 * 1000) {
        await regimePass().catch((e) => log("[regimen]", e.message));
        lastRegime = Date.now();
      }
      if (Date.now() - lastProfile > 12 * 60 * 60 * 1000) {
        await volumeProfilePass().catch((e) => log("[perfil]", e.message));
        lastProfile = Date.now();
      }
      await main();
      await paperPass().catch((e) => log("[paper]", e.message));
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
