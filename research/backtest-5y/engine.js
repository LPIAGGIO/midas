/* engine.js — PORT del motor de señales de workers/niveles-auto/worker.js
 *
 * Objetivo: reproducir, sin optimizar nada, la lógica que hoy corre en el VPS
 * para decidir DÓNDE compra el bot (zona de soporte), DÓNDE corta (stop) y
 * DÓNDE vende (resistencia), más el filtro que decide si la señal se opera.
 *
 * Todo lo que sigue es copia funcional del worker (v7, config "NUEVA" del
 * 16/09/2026, ya congelada). Las constantes NO se tocan.
 *
 * Diferencias declaradas con el worker (ver README.md, sección "qué se
 * aproximó"):
 *   - La serie diaria de la ventana (1y) se arma con ruedas COMPLETAS; la
 *     rueda en curso entra como barra parcial construida con las horarias del
 *     día, pero los pivotes diarios se confirman sobre las completas.
 *   - El spot es el cierre de la barra horaria en curso (el worker usa el
 *     último precio de data912).
 *   - No hay libro de puntas, ni volumen intradiario del CEDEAR, ni fecha de
 *     earnings: esos tres chequeos del worker se documentan y no se simulan.
 *
 * ESM (el package.json de Midas es "type":"module").
 */
import fs from "node:fs";
import path from "node:path";

export const LB = 5;             // barras de confirmación del pivote
export const ZONE_TOL = 0.006;   // ±0,6%: pivotes a esa distancia son la misma zona

/* ───────────────────────── carga de datos crudos ───────────────────────── */

// JSON crudo de Yahoo → [{ts, t, o, h, l, c, v}] (mismo shape que yahooCandles).
export function parseYahoo(json, { useAdj = false } = {}) {
  const res = json?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose || null;
  const out = [];
  for (let i = 0; i < (res.timestamp || []).length; i++) {
    if (q.high?.[i] == null || q.low?.[i] == null || q.close?.[i] == null) continue;
    const c = useAdj && adj && adj[i] != null ? adj[i] : q.close[i];
    // factor de ajuste por dividendos: se aplica a todo el OHLC para no romper
    // la coherencia de las mechas cuando se pide la serie ajustada.
    const f = useAdj && adj && adj[i] != null && q.close[i] > 0 ? adj[i] / q.close[i] : 1;
    out.push({
      ts: res.timestamp[i],
      t: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10),
      o: (q.open?.[i] ?? q.close[i]) * f,
      h: q.high[i] * f,
      l: q.low[i] * f,
      c,
      v: q.volume?.[i] || 0,
    });
  }
  return out.length ? out : null;
}

export function loadSeries(dataDir, kind, sym, opts) {
  const f = path.join(dataDir, kind, `${sym}.json`);
  if (!fs.existsSync(f)) return null;
  return parseYahoo(JSON.parse(fs.readFileSync(f, "utf8")), opts);
}

// CCL por día corrido (argentinadatos). OJO (INVENTARIO §3): la serie trae un
// dato por día calendario arrastrando el último valor; el join se hace por
// fecha de rueda con retroceso de hasta 14 días.
export function loadCcl(dataDir) {
  const j = JSON.parse(fs.readFileSync(path.join(dataDir, "ccl.json"), "utf8"));
  const map = new Map();
  for (const r of j.data || j) {
    const v = (Number(r.compra) + Number(r.venta)) / 2 || Number(r.venta) || Number(r.compra);
    if (v > 0) map.set(r.fecha, v);
  }
  const cache = new Map();
  return (dia) => {
    if (cache.has(dia)) return cache.get(dia);
    let d = new Date(dia + "T12:00:00Z");
    for (let i = 0; i < 14; i++) {
      const k = d.toISOString().slice(0, 10);
      if (map.has(k)) { cache.set(dia, map.get(k)); return map.get(k); }
      d = new Date(d.getTime() - 86400000);
    }
    cache.set(dia, null);
    return null;
  };
}

/* ─────────────── primitivas del worker (copia funcional) ─────────────── */

export function allPivots(candles, lb, tf) {
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

export function clusterZones(pivs, tol = ZONE_TOL) {
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

export function emaOf(closes, n) {
  if (closes.length < n) return null;
  const k = 2 / (n + 1);
  let e = closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}
// Paso incremental: equivale a haber pasado un cierre más a emaOf().
export const emaStep = (e, c, n) => (e == null ? null : c * (2 / (n + 1)) + e * (1 - 2 / (n + 1)));

export function rsi14(closes) {
  if (closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return g + l === 0 ? 50 : Math.round((100 * g) / (g + l));
}

export function scoreZone(z, emas) {
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

export function candlePattern(cs, i) {
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

export function patternAtZone(cs, zone, side) {
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

export function rsiSeries(closes) {
  const out = new Array(closes.length).fill(null);
  for (let i = 14; i < closes.length; i++) {
    let g = 0, l = 0;
    for (let k = i - 13; k <= i; k++) { const d = closes[k] - closes[k - 1]; if (d > 0) g += d; else l -= d; }
    out[i] = g + l === 0 ? 50 : (100 * g) / (g + l);
  }
  return out;
}

export function divergences(dLos, dHis, rsiArr) {
  let bull = false, bear = false;
  const lo = dLos.slice(-2), hi = dHis.slice(-2);
  if (lo.length === 2 && rsiArr[lo[0].i] != null && rsiArr[lo[1].i] != null) bull = lo[1].p < lo[0].p && rsiArr[lo[1].i] > rsiArr[lo[0].i] + 2;
  if (hi.length === 2 && rsiArr[hi[0].i] != null && rsiArr[hi[1].i] != null) bear = hi[1].p > hi[0].p && rsiArr[hi[1].i] < rsiArr[hi[0].i] - 2;
  return { bull, bear };
}

export function estructuraDe(dLos, dHis) {
  if (dLos.length < 2 || dHis.length < 2) return "rango";
  const hl = dLos[dLos.length - 1].p > dLos[dLos.length - 2].p;
  const hh = dHis[dHis.length - 1].p > dHis[dHis.length - 2].p;
  const ll = dLos[dLos.length - 1].p < dLos[dLos.length - 2].p;
  const lh = dHis[dHis.length - 1].p < dHis[dHis.length - 2].p;
  return hh && hl ? "alcista" : ll && lh ? "bajista" : "rango";
}

export function openGaps(daily) {
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

export function pocOf(daily) {
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

export function buildProfile(daily, nBins = 30) {
  const lo = Math.min(...daily.map((c) => c.l)), hi = Math.max(...daily.map((c) => c.h));
  if (!(hi > lo)) return null;
  const w = (hi - lo) / nBins;
  const vols = new Array(nBins).fill(0);
  for (const c of daily) {
    const px = (c.h + c.l + c.c) / 3;
    const i = Math.min(nBins - 1, Math.max(0, Math.floor((px - lo) / w)));
    vols[i] += c.v || 0;
  }
  const total = vols.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  return {
    bins: vols.map((v, i) => ({
      lo: lo + i * w, hi: lo + (i + 1) * w,
      pct: Math.round((v / total) * 10000) / 100,
    })),
  };
}

/* ───────────────── contexto diario (se recalcula 1× por rueda) ─────────────
 * Recibe la ventana de ruedas COMPLETAS (1 año, ~252 barras) y devuelve todo
 * lo que el worker deriva de la diaria y no cambia dentro de la rueda. */
export function buildDailyCtx(win) {
  const closes = win.map((c) => c.c);
  const dp = allPivots(win, LB, "d");
  const bigP = allPivots(win, 20, "d");
  const rsiArr = rsiSeries(closes);
  return {
    win, closes,
    dp,
    bigSup: clusterZones(bigP.los),
    bigRes: clusterZones(bigP.his),
    div: divergences(dp.los, dp.his, rsiArr),
    estr: estructuraDe(dp.los, dp.his),
    gaps: openGaps(win),
    poc: pocOf(win),
    prof: buildProfile(win),
    ema: { 21: emaOf(closes, 21), 50: emaOf(closes, 50), 200: emaOf(closes, 200) },
    yrHigh: Math.max(...win.map((c) => c.h)),
    yrLow: Math.min(...win.map((c) => c.l)),
  };
}

/* ───────────────────────────── el kit ─────────────────────────────
 * ctx        contexto diario (buildDailyCtx)
 * partial    barra parcial de la rueda en curso (o null)
 * hourly     ventana horaria de ~1 mes, terminada en la barra en curso
 * hourPivs   {his, los} de la ventana horaria, ya confirmados
 * spot       precio de referencia (cierre de la barra horaria en curso)
 */
export function analyzeKit({ ctx, partial, hourly, hourPivs, spot }) {
  const dailyFull = partial ? [...ctx.win, partial] : ctx.win;
  const closes = partial ? [...ctx.closes, partial.c] : ctx.closes;
  const emas = partial
    ? { 21: emaStep(ctx.ema[21], partial.c, 21), 50: emaStep(ctx.ema[50], partial.c, 50), 200: emaStep(ctx.ema[200], partial.c, 200) }
    : ctx.ema;
  const rsi = rsi14(closes);

  const supZ = clusterZones([...ctx.dp.los, ...hourPivs.los]);
  const resZ = clusterZones([...ctx.dp.his, ...hourPivs.his]);

  const volEnZona = (lo, hi) => {
    if (!ctx.prof || !(hi > lo)) return null;
    let acc = 0;
    for (const b of ctx.prof.bins) {
      const ov = Math.min(hi, b.hi) - Math.max(lo, b.lo);
      if (ov > 0) acc += b.pct * (ov / (b.hi - b.lo));
    }
    return acc;
  };

  // ATR14 diario (mismo loop que el worker).
  let atr = 0;
  for (let i = Math.max(1, dailyFull.length - 14); i < dailyFull.length; i++) {
    atr += Math.max(dailyFull[i].h - dailyFull[i].l, Math.abs(dailyFull[i].h - dailyFull[i - 1].c), Math.abs(dailyFull[i].l - dailyFull[i - 1].c));
  }
  atr /= Math.min(14, dailyFull.length - 1);

  const buysBelow = supZ.filter((z) => z.hi < spot * 0.999);
  const buyZone = buysBelow.length ? buysBelow[buysBelow.length - 1] : null;
  const sellsAbove = resZ.filter((z) => z.lo > spot * 1.001);
  const sellZone = sellsAbove.length ? sellsAbove[0] : null;
  // Entrada swing: si la cercana es SOLO horaria y hay una zona con pata
  // diaria >1,5% más abajo, el worker emite también ese nivel.
  let swingZone = null;
  if (buyZone && !buyZone.hasD) {
    const deeper = buysBelow.filter((z) => z.hasD && z.hi < buyZone.lo * 0.985);
    if (deeper.length) swingZone = deeper[deeper.length - 1];
  }

  let stopLvl = null, stopWhy = "", stopRR = null;
  if (buyZone) {
    const below = buysBelow.filter((z) => z.hi < buyZone.lo * 0.995);
    if (below.length) { const z = below[below.length - 1]; stopLvl = z.lo * 0.993; stopWhy = `zona de ${z.touches} toques`; }
    else { stopLvl = buyZone.hi - atr; stopWhy = "1xATR diario"; }
    // PISO POR VOLATILIDAD (test 22/09/2026). Con ATR_K seteado, el stop no
    // puede quedar MAS CERCA que k veces el ATR diario del papel. Conserva la
    // informacion del soporte (si ya esta lejos no lo toca) pero impide que
    // caiga adentro del ruido. Medido ese dia: el stop promedio del bot esta
    // a 0,60 desvios diarios; en LAC/OKLO/HUT a 0,21-0,26, o sea 80-84% de
    // probabilidad de que lo toque el ruido en UN solo dia.
    stopRR = stopLvl;   // el stop del SOPORTE, antes del piso por ATR
    const K_ATR = Number(process.env.ATR_K || 0);
    if (K_ATR > 0 && atr > 0) {
      const piso = buyZone.hi - K_ATR * atr;
      if (piso < stopLvl) { stopLvl = piso; stopWhy = K_ATR + "xATR (piso de volatilidad)"; }
    }
    /* PISO QUIRURGICO POR SIGMA (23/09/2026). El piso por ATR crudo de arriba
     * mueve TODOS los stops y por eso destruye el R:R de casi todas las señales
     * (medido 22/09: de 182 setups a 3 con k=2,5). Este otro solo interviene
     * cuando el stop es ABSURDO — abajo de SIGMA_MIN desvios diarios del papel —
     * y lo lleva exactamente a ese umbral. El caso normal no se toca.
     * Disparador: el 23/09 LAC entro con el stop a 0,11 sigmas, o sea 92% de
     * probabilidad de saltar por ruido en UN dia. El resto del libro ese mismo
     * dia estaba entre 0,81 y 1,42 sigmas, o sea sano. */
    const SIG_MIN = Number(process.env.SIGMA_MIN || 0);
    if (SIG_MIN > 0 && stopLvl > 0 && dailyFull.length > 30) {
      const cl = dailyFull.map((c) => c.c);
      const rr2 = [];
      for (let i = Math.max(1, cl.length - 252); i < cl.length; i++) rr2.push(cl[i] / cl[i - 1] - 1);
      if (rr2.length > 30) {
        const mu = rr2.reduce((a, b) => a + b, 0) / rr2.length;
        const sd = Math.sqrt(rr2.reduce((a, b) => a + (b - mu) ** 2, 0) / rr2.length);
        const sigmas = (buyZone.hi - stopLvl) / (buyZone.hi * sd);
        if (sd > 0 && sigmas < SIG_MIN) {
          stopLvl = buyZone.hi * (1 - SIG_MIN * sd);
          stopWhy = SIG_MIN + " sigmas (piso quirurgico, el geometrico caia en " + sigmas.toFixed(2) + ")";
        }
      }
    }
  }

  const low20 = Math.min(...dailyFull.slice(-20).map((c) => c.l));
  const enMinimos = dailyFull[dailyFull.length - 1].l <= low20 * 1.01;
  const contraTendencia = ctx.estr === "bajista" && enMinimos;

  const out = {
    spot, rsi, estr: ctx.estr, atr, contraTendencia,
    buy: null, stop: null, target: null, score: null, rr: null,
    swing: swingZone ? swingZone.hi : null,
    senales: [], sellScore: null,
  };
  if (!buyZone) return out;

  const sc = scoreZone(buyZone, emas);
  const sig = [];
  const pat = patternAtZone(dailyFull, buyZone, "sup") || (hourly ? patternAtZone(hourly, buyZone, "sup") : null);
  if (pat) { sig.push(`${pat.k} ${pat.when}`); if (pat.bull) sc.score += 1; }
  if (ctx.div.bull) { sig.push("divergencia RSI alcista"); sc.score += 1; }
  if (ctx.poc && Math.abs(ctx.poc - buyZone.avg) / buyZone.avg <= 0.01) { sig.push("es el POC del año"); sc.score += 1; }
  const vz = volEnZona(buyZone.lo, buyZone.hi);
  if (vz != null) {
    if (vz >= 6) { sig.push("respaldo de volumen fuerte"); sc.score += 1; }
    else if (vz < 1.5) { sig.push("zona sin volumen"); sc.score -= 1; }
  }
  if (ctx.estr === "alcista") sc.score += 1; else if (ctx.estr === "bajista") sc.score -= 1;
  if (contraTendencia) { sig.push("CONTRA-TENDENCIA"); sc.score = Math.min(sc.score, 4); }
  sc.score = Math.max(1, Math.min(10, sc.score));

  // ATR_RR_ORIG=1: el R:R del filtro se calcula con el stop del SOPORTE aunque
  // la ejecucion use el stop ancho por ATR. Sirve para AISLAR el efecto del
  // stop: sin esto, alejarlo mata el R:R y el gate descarta las señales antes
  // de que se pueda medir si el stop ancho ayuda (medido 22/09/2026: con piso
  // de 2,5xATR sobrevivian 3 setups en 5 años contra 182 del base).
  const stopParaRR = (process.env.ATR_RR_ORIG && stopRR != null) ? stopRR : stopLvl;
  const rr = sellZone && stopParaRR && buyZone.hi - stopParaRR > 0
    ? Math.round(((sellZone.lo - buyZone.hi) / (buyZone.hi - stopParaRR)) * 10) / 10
    : null;

  out.buy = buyZone.hi;
  out.buyZone = { lo: buyZone.lo, hi: buyZone.hi, touches: buyZone.touches, hasD: buyZone.hasD, hasH: buyZone.hasH, volMax: buyZone.volMax };
  out.tipo = buyZone.hasD ? "soporte-diario" : "soporte-horario";
  out.stop = stopLvl;
  out.stopWhy = stopWhy;
  out.target = sellZone ? sellZone.lo : null;
  out.score = sc.score;
  out.rr = rr;
  out.senales = sig;
  return out;
}

/* Filtro de entrada del bot, textual del worker (líneas 540-561):
 *   score >= 7 · R:R >= 2 · sin contra-tendencia · régimen risk_on
 *   (o mixto con score >= 8 y R:R >= 2,5, a MITAD de riesgo) ·
 *   stop válido · zona de salida.
 * No se simula el bloqueo por earnings (<= 3 días): no hay dato histórico. */
export function gatePasa(kit, regime) {
  const mixtoOk = regime === "mixto" && kit.score >= 8 && kit.rr != null && kit.rr >= 2.5;
  const regimenOk = regime === "risk_on" || mixtoOk;
  const ok = kit.buy != null && kit.score >= 7 && kit.rr != null && kit.rr >= 2 &&
    !kit.contraTendencia && regimenOk &&
    kit.stop != null && kit.stop > 0 && kit.stop < kit.buy && kit.target != null;
  return { ok, riskMult: mixtoOk ? 0.5 : 1, regimenOk, mixtoOk };
}

/* Régimen de mercado del worker: SPY y QQQ contra su EMA50 sobre 6 meses de
 * diaria (range=6mo → ~126 ruedas; emaOf siembra con la SMA de las primeras
 * 50 de ESA ventana, así que el largo de la ventana importa). */
export function regimenDe(spyWin, qqqWin) {
  const above = (win) => {
    if (!win || !win.length) return null;
    const c = win.map((x) => x.c);
    const e = emaOf(c, 50);
    return e != null && c[c.length - 1] >= e;
  };
  const a = above(spyWin), b = above(qqqWin);
  if (a == null || b == null) return null;
  return a && b ? "risk_on" : !a && !b ? "risk_off" : "mixto";
}

/* ─── camino lento (fiel pero caro): se usa para el chequeo del port ─── */
export function analyzeAsOf(dailyAll, hourlyAll, iH, { diasDaily = 252, diasHourly = 30, spot = null } = {}) {
  const bar = hourlyAll[iH];
  const dia = bar.t;
  const win = dailyAll.filter((d) => d.t < dia).slice(-diasDaily);
  if (win.length < 60) return null;
  const hoy = [];
  for (let k = iH; k >= 0 && hourlyAll[k].t === dia; k--) hoy.unshift(hourlyAll[k]);
  const partial = hoy.length ? {
    ts: hoy[0].ts, t: dia, o: hoy[0].o,
    h: Math.max(...hoy.map((x) => x.h)), l: Math.min(...hoy.map((x) => x.l)),
    c: hoy[hoy.length - 1].c, v: hoy.reduce((s, x) => s + x.v, 0),
  } : null;
  const desde = bar.ts - diasHourly * 86400;
  const hourly = [];
  for (let k = iH; k >= 0 && hourlyAll[k].ts >= desde; k--) hourly.unshift(hourlyAll[k]);
  const hp = allPivots(hourly, LB, "h");
  const ctx = buildDailyCtx(win);
  return analyzeKit({ ctx, partial, hourly, hourPivs: hp, spot: spot ?? bar.c });
}
