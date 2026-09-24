/* rotacion.js — tres correcciones pedidas por un tercero (`mazda_miata`) sobre
 * el método publicado en INFORME-NULO.md / INFORME-BARRIDO.md.
 *
 *   A) El nulo de bloques (INFORME-NULO §1 "Null 2") sorteaba las POSICIONES de
 *      arranque de cada bloque apagado de forma independiente. Eso rompe el
 *      acoplamiento entre la duración de un bloque y el estado del mercado.
 *      Reemplazo: tomar la serie indicadora encendido/apagado como un objeto
 *      rígido y ROTARLA módulo T. Sorteo j → estado[(t + j) mod T].
 *      Las T rotaciones son finitas, así que el p es EXACTO (enumeración),
 *      no Monte Carlo.
 *
 *   B) El 79% de re-derivación de zona (INFORME-BARRIDO §6): ¿artefacto de
 *      granularidad o propiedad del motor? Test: la tasa de re-derivación
 *      contra el rango intrabarra de la barra del fill medido en unidades del
 *      ancho de la zona. Plana → propiedad. Creciente → artefacto.
 *
 *   C) El test de pasa-vs-bloquea (INFORME-NULO §3): poder estadístico formal.
 *
 * Reusa engine.js y el cache signals.json. Semilla 20260917.
 * ESM. No toca el VPS ni Supabase. No commitea nada.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LB, ZONE_TOL, allPivots, buildDailyCtx, analyzeKit, gatePasa,
  loadSeries, loadCcl, emaOf, emaStep,
} from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = process.argv.slice(2);
const argN = (k, d) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };
const DRAWS = argN("draws", 5000);        // sólo para REPRODUCIR el nulo viejo
const SIN_VIEJO = ARGS.includes("--sinViejo");
const SEED = 20260917;

/* ─────────────────────── PRNG reproducible (idéntico a nulo.js) ────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── constantes: IDÉNTICAS a simulate.js / nulo.js / cocos.js ── */
const CAPITAL = 7_000_000;
const RISK = 0.015;
const MAX_POS = 5;
const MAX_DIA = 5;
const CAP_PCT = 0.20;
const VENTANA_H = 48;
const TP_FRAC = 0.5;
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;
const FEE = {
  gold: 0.005 * IVA + DERECHOS,
  platinum: 0.003 * IVA + DERECHOS,
  black: 0.001 * IVA + DERECHOS,
  cocos: 0.0005 * IVA,
};
const TIERS = ["gold", "platinum", "black", "cocos"];
const DIAS_DAILY = 252, DIAS_HOURLY = 30, DIAS_REGIME = 126;

const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";
const VENTANAS = { IS: [IS_DESDE, IS_HASTA], OOS: [OOS_DESDE, OOS_HASTA] };

const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TRUNCA_DAILY = { OKLO: "2024-05-10", RGTI: "2022-03-01", SATL: "2022-01-01", KEEL: "2026-04-06", LAR: "2025-01-27" };

const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/* ─────────────────────────── carga ─────────────────────────── */
function cargarTodo() {
  const syms = fs.readdirSync(path.join(DATA, "hourly"))
    .filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  const daily = {}, hourly = {};
  for (const s of syms) {
    const d = loadSeries(DATA, "daily", s), h = loadSeries(DATA, "hourly", s);
    if (!d || !h) continue;
    daily[s] = TRUNCA_DAILY[s] ? d.filter((b) => b.t >= TRUNCA_DAILY[s]) : d;
    hourly[s] = h;
  }
  return { syms: Object.keys(daily), daily, hourly };
}
function cargarSenales() {
  const f = path.join(DIR, "signals.json");
  if (!fs.existsSync(f)) throw new Error("falta signals.json — correr antes: node simulate.js");
  return JSON.parse(fs.readFileSync(f, "utf8")).senales;
}

/* ── régimen del worker, barra por barra (copia literal de nulo.js) ── */
function construirRegimen(daily, hourly, timeline) {
  const out = new Map();
  const spyD = daily.SPY, qqqD = daily.QQQ, spyH = hourly.SPY, qqqH = hourly.QQQ;
  if (!spyD || !qqqD) return out;
  const hMap = (arr) => new Map(arr.map((b) => [b.ts, b.c]));
  const spyHm = hMap(spyH), qqqHm = hMap(qqqH);
  const emaCache = new Map();
  const idxD = (arr, d) => {
    let lo = 0, hi = arr.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].t < d) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  };
  let ultSpy = null, ultQqq = null;
  for (const ts of timeline) {
    const d = dia(ts);
    if (!emaCache.has(d)) {
      const i1 = idxD(spyD, d), i2 = idxD(qqqD, d);
      const w1 = spyD.slice(Math.max(0, i1 + 1 - DIAS_REGIME), i1 + 1);
      const w2 = qqqD.slice(Math.max(0, i2 + 1 - DIAS_REGIME), i2 + 1);
      emaCache.set(d, {
        spy: emaOf(w1.map((x) => x.c), 50), qqq: emaOf(w2.map((x) => x.c), 50),
        spyC: w1.length ? w1[w1.length - 1].c : null, qqqC: w2.length ? w2[w2.length - 1].c : null,
      });
    }
    const e = emaCache.get(d);
    if (e.spy == null || e.qqq == null) continue;
    const cs = spyHm.get(ts) ?? ultSpy ?? e.spyC;
    const cq = qqqHm.get(ts) ?? ultQqq ?? e.qqqC;
    if (cs != null) ultSpy = cs;
    if (cq != null) ultQqq = cq;
    const above = (c, eBase) => c >= emaStep(eBase, c, 50);
    const a = above(cs, e.spy), b = above(cq, e.qqq);
    out.set(ts, a && b ? "risk_on" : !a && !b ? "risk_off" : "mixto");
  }
  return out;
}

/* ── features de SPY (idéntico a nulo.js) ── */
function featuresSpy({ useAdj = true, lag = 1 } = {}) {
  const spy = loadSeries(DATA, "daily", "SPY", { useAdj });
  const c = spy.map((x) => x.c);
  const ema = (n) => {
    const k = 2 / (n + 1); const out = new Array(c.length).fill(null);
    let e = c.slice(0, n).reduce((s, x) => s + x, 0) / n; out[n - 1] = e;
    for (let i = n; i < c.length; i++) { e = c[i] * k + e * (1 - k); out[i] = e; }
    return out;
  };
  const e200 = ema(200), e50 = ema(50);
  const vol = new Array(c.length).fill(null);
  for (let i = 20; i < c.length; i++) {
    let s = 0, s2 = 0;
    for (let k = i - 19; k <= i; k++) { const r = Math.log(c[k] / c[k - 1]); s += r; s2 += r * r; }
    const m = s / 20;
    vol[i] = Math.sqrt(Math.max(0, s2 / 20 - m * m)) * Math.sqrt(252);
  }
  const f = new Map();
  for (let i = 0; i < spy.length; i++) {
    f.set(spy[i].t, {
      above200: e200[i] != null ? c[i] >= e200[i] : null,
      above50: e50[i] != null ? c[i] >= e50[i] : null,
      vol: vol[i] == null ? null : Math.round(vol[i] * 10000) / 10000,
    });
  }
  const out = new Map();
  for (let i = lag; i < spy.length; i++) out.set(spy[i].t, f.get(spy[i - lag].t));
  return { feat: out, dias: spy.map((x) => x.t), crudo: f };
}

/* ────────────────── simulador (copia de nulo.js + tier cocos + tsSenal) ── */
function construirCtx(bars, universo, desde, hasta) {
  const tsSet = new Set(); const barAt = {}, serie = {}, idx = {};
  for (const s of universo) {
    if (!bars[s]) continue;
    barAt[s] = new Map(); serie[s] = []; idx[s] = new Map();
    for (const b of bars[s]) {
      if (b.t < desde || b.t > hasta) continue;
      tsSet.add(b.ts * 1000); barAt[s].set(b.ts * 1000, b);
      idx[s].set(b.ts * 1000, serie[s].length); serie[s].push(b);
    }
  }
  const timeline = [...tsSet].sort((a, b) => a - b);
  const dias = [...new Set(timeline.map((t) => dia(t / 1000)))].sort();
  const meses = dias.length ? (new Date(dias[dias.length - 1]) - new Date(dias[0])) / (365.25 / 12 * 86400000) : 1;
  return { barAt, serie, idx, timeline, dias, meses, tFin: timeline.length ? timeline[timeline.length - 1] : 0, bars, desde, hasta };
}

function construirOrdenes(senales, universo, desde, hasta, filtro, stopMult = 1, tgtMult = 1) {
  const out = [];
  for (const s of senales) {
    if (!universo.has(s.sym)) continue;
    if (s.dia < desde || s.dia > hasta) continue;
    const f = filtro(s);
    if (!f) continue;
    const R = s.entry - s.stop, T = s.target - s.entry;
    out.push({ ...s, riskMult: f.riskMult ?? 1, stop: s.entry - R * stopMult, target: s.entry + T * tgtMult, created: s.ts * 1000 + 1 });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}

function simular(ordenes, ctx, ccl, { light = false, exitMode = "intrabar", capPct = CAP_PCT } = {}) {
  const { barAt, timeline, tFin, bars } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const skips = { openSym: 0, dupPend: 0, posMax: 0, entradasDia: 0, qtyCero: 0, reemplazadas: 0, expiradas: 0, sinFill: 0, sinBarras: 0 };
  const entradasDia = new Map();
  const realized = { gold: 0, platinum: 0, black: 0, cocos: 0 };
  const equity = [];
  let oi = 0;
  const comprometido = () => { let s = 0; for (const p of pend.values()) s += p.notional; for (const p of open.values()) s += p.notional; return s; };
  const feeLeg = (n, tier, bonif) => n * (bonif ? DERECHOS : FEE[tier]);
  const cerrarPata = (pos, qty, px, ts, reason) => {
    const d = dia(ts / 1000);
    const rOut = rArs(d);
    const intradia = dia(pos.entryTs / 1000) === d;
    const entN = qty * pos.entryPx * pos.rIn;
    const outN = qty * px * rOut;
    const leg = { sym: pos.sym, qty, reason, entryTs: pos.entryTs, exitTs: ts, entN, bruto: outN - entN, brutoSinCcl: qty * (px - pos.entryPx) * pos.rIn, pnl: {}, fees: {} };
    for (const tier of TIERS) {
      const f = feeLeg(entN, tier, false) + feeLeg(outN, tier, intradia);
      leg.fees[tier] = f; leg.pnl[tier] = outN - entN - f; realized[tier] += leg.pnl[tier];
    }
    legs.push(leg); pos.legs.push(leg);
  };
  for (const t of timeline) {
    while (oi < ordenes.length && ordenes[oi].created <= t) {
      const o = ordenes[oi++];
      if (!barAt[o.sym]) { skips.sinBarras++; continue; }
      if (open.has(o.sym)) { skips.openSym++; continue; }
      const prev = pend.get(o.sym);
      if (prev && Math.abs(prev.entry - o.entry) / o.entry < 0.005) { skips.dupPend++; continue; }
      if (prev) { pend.delete(o.sym); skips.reemplazadas++; }
      if (pend.size + open.size >= MAX_POS) { skips.posMax++; continue; }
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) { skips.entradasDia++; continue; }
      const rIn = rArs(d);
      const riesgoU = (o.entry - o.stop) * rIn;
      if (!(riesgoU > 0)) { skips.qtyCero++; continue; }
      let qty = (CAPITAL * RISK * o.riskMult) / riesgoU;
      qty = Math.min(qty, (CAPITAL * capPct) / (o.entry * rIn));
      qty = Math.min(qty, Math.max(0, CAPITAL - comprometido()) / (o.entry * rIn));
      if (!(qty > 0)) { skips.qtyCero++; continue; }
      entradasDia.set(d, (entradasDia.get(d) || 0) + 1);
      pend.set(o.sym, { ...o, qty, rIn, notional: qty * o.entry * rIn });
    }
    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); skips.expiradas++; continue; }
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (b.l <= p.entry) {
        pend.delete(sym);
        const pos = {
          sym: p.sym, qty: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          notional: p.qty * p.entry * p.rIn, notional0: p.qty * p.entry * p.rIn,
          legs: [], tpDone: false,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia, tsSenal: p.ts,
          vol: p.vol, s200: p.s200, s50: p.s50,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }
    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs) continue;
      const hi = exitMode === "close" ? b.c : b.h;
      const lo = exitMode === "close" ? b.c : b.l;
      if (lo <= pos.stop) { cerrarPata(pos, pos.qty, pos.stop, t, pos.stop > pos.stopIni ? "trailing" : "stop"); open.delete(sym); continue; }
      if (TP_FRAC > 0 && !pos.tpDone) {
        const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
        if (hi >= nivel) { const q = pos.qty / 2; cerrarPata(pos, q, Math.min(nivel, pos.target), t, "tp_parcial"); pos.qty -= q; pos.notional = pos.qty * pos.entryPx * pos.rIn; pos.tpDone = true; }
      }
      if (hi >= pos.target) { cerrarPata(pos, pos.qty, pos.target, t, "target"); open.delete(sym); continue; }
      const k = Math.floor((hi - pos.entryPx) / pos.R);
      if (k >= 2 && pos.entryPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (k - 2) * pos.R;
    }
    if (!light) {
      const d = dia(t / 1000);
      let unreal = 0;
      for (const [sym, pos] of open) { const b = barAt[sym].get(t); unreal += pos.qty * ((b ? b.c : pos.entryPx) - pos.entryPx) * pos.rIn; }
      const row = { dia: d, eq: {} };
      for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
      if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row; else equity.push(row);
    }
  }
  skips.sinFill += pend.size;
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || bars[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    cerrarPata(pos, pos.qty, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (!light && equity.length) { const last = equity[equity.length - 1]; for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier]; }
  return { trades, legs, skips, equity, realized, nSenales: ordenes.length };
}

/* ─────────────────────────── métricas / estadística ─────────────────── */
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
function metricas(sim, tier, meses) {
  const porTrade = sim.trades.map((tr) => tr.legs.reduce((s, l) => s + l.pnl[tier], 0));
  const n = porTrade.length;
  const wins = porTrade.filter((x) => x > 0), losses = porTrade.filter((x) => x <= 0);
  const total = porTrade.reduce((s, x) => s + x, 0);
  const rets = [];
  for (let i = 1; i < sim.equity.length; i++) rets.push(sim.equity[i].eq[tier] / sim.equity[i - 1].eq[tier] - 1);
  const m = mean(rets), sd = stdev(rets);
  const sharpe = sd > 0 ? (m / sd) * Math.sqrt(252) : null;
  let peak = -Infinity, dd = 0;
  for (const e of sim.equity) { peak = Math.max(peak, e.eq[tier]); dd = Math.max(dd, (peak - e.eq[tier]) / peak); }
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    sharpe, maxDDpct: dd * 100, srDiario: sd > 0 ? m / sd : null, rets,
  };
}
const mensualLight = (sim, tier, meses) => (sim.realized[tier] / CAPITAL / Math.max(meses, 1e-9)) * 100;

/* percentil + p de una cola, MISMA convención que nulo.js:
 *   p = (#{nulo >= real} + 1) / (B + 1)
 * En el nulo de rotación eso es exactamente el p de permutación EXACTO si la
 * lista `nulos` son las B rotaciones distintas de la identidad: la identidad
 * aporta el "+1" del numerador y del denominador. */
function ubicar(real, nulos) {
  const B = nulos.length;
  const menores = nulos.filter((x) => x < real).length;
  const iguales = nulos.filter((x) => x === real).length;
  const s = [...nulos].sort((x, y) => x - y);
  return {
    percentil: (menores + 0.5 * iguales) / B, p1cola: (nulos.filter((x) => x >= real).length + 1) / (B + 1),
    B, med: s[Math.floor(B / 2)], p05: s[Math.floor(B * 0.05)], p95: s[Math.floor(B * 0.95)],
    mediaNulo: mean(nulos), sdNulo: stdev(nulos), real,
  };
}
function sorteoK(idx, N, K, rnd) {
  for (let i = 0; i < K; i++) { const j = i + Math.floor(rnd() * (N - i)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx.slice(0, K);
}
function colocarBloques(D, L, rnd) {
  const m = L.length;
  if (!m) return [];
  const S = L.reduce((s, x) => s + x, 0);
  let sep = 1, F = D - S - (m - 1);
  if (F < 0) { sep = 0; F = D - S; }
  if (F < 0) return null;
  const cortes = [];
  for (let i = 0; i < m; i++) cortes.push(Math.floor(rnd() * (F + 1)));
  cortes.sort((a, b) => a - b);
  const huecos = []; let prev = 0;
  for (const c of cortes) { huecos.push(c - prev); prev = c; }
  huecos.push(F - prev);
  const orden = L.slice();
  for (let i = orden.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = orden[i]; orden[i] = orden[j]; orden[j] = t; }
  const out = []; let pos = huecos[0];
  for (let i = 0; i < m; i++) { out.push([pos, pos + orden[i] - 1]); pos += orden[i] + (i < m - 1 ? sep + huecos[i + 1] : 0); }
  return out;
}
function bloquesOff(mask) {
  const out = []; let i = 0;
  while (i < mask.length) {
    if (!mask[i]) { let j = i; while (j + 1 < mask.length && !mask[j + 1]) j++; out.push([i, j]); i = j + 1; }
    else i++;
  }
  return out;
}

/* ══════════ el nulo nuevo: ROTACIÓN CIRCULAR ══════════
 * La serie indicadora encendido/apagado se toma como un objeto RÍGIDO y se la
 * rota módulo T: mask_j[t] = mask[(t + j) mod T]. Preserva por construcción
 * el multiconjunto completo de duraciones, el orden de los bloques y los
 * huecos entre ellos, porque nunca se corta la serie. Lo único que se destruye
 * es la alineación calendario↔retornos, que es el nulo buscado.
 *
 * COSTURA: al leer la serie rotada de forma LINEAL, el bloque que queda a
 * caballo del punto de corte se parte en dos (36 bloques pueden verse como
 * 37). Dos salidas posibles; se elige la SEGUNDA (ver INFORME-ROTACION §2):
 *   (a) descartar del estadístico el bloque que cruza la costura — rompe la
 *       conservación del total de días apagados;
 *   (b) rotar sólo por j tales que la costura NO caiga dentro de un bloque
 *       apagado — conserva EXACTAMENTE el multiconjunto y el total.
 * j es admisible ⟺ NO (mask[(j-1+T) mod T] === false && mask[j] === false). */
function bloquesOffCircular(mask) {
  const T = mask.length;
  if (mask.every((x) => !x)) return [{ ini: 0, len: T }];
  const out = [];
  for (let i = 0; i < T; i++) {
    if (!mask[i] && mask[(i - 1 + T) % T]) {       // arranque de bloque
      let len = 0, k = i;
      while (!mask[k % T] && len < T) { len++; k++; }
      out.push({ ini: i, len });
    }
  }
  return out;
}
const rotarMask = (mask, j) => { const T = mask.length, o = new Array(T); for (let t = 0; t < T; t++) o[t] = mask[(t + j) % T]; return o; };
function rotacionesAdmisibles(mask) {
  const T = mask.length, adm = [];
  for (let j = 0; j < T; j++) if (!(!mask[(j - 1 + T) % T] && !mask[j])) adm.push(j);
  return adm;
}
const igualMultiset = (a, b) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
};

/* ── regresión logística (Newton-Raphson), 1 regresor + intercepto ── */
function logistica(x, y, { iters = 80 } = {}) {
  const n = x.length;
  let b0 = 0, b1 = 0;
  for (let it = 0; it < iters; it++) {
    let g0 = 0, g1 = 0, h00 = 0, h01 = 0, h11 = 0;
    for (let i = 0; i < n; i++) {
      const e = Math.max(-500, Math.min(500, b0 + b1 * x[i]));
      const p = 1 / (1 + Math.exp(-e));
      const w = Math.max(1e-10, p * (1 - p));
      const r = y[i] - p;
      g0 += r; g1 += r * x[i];
      h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
    }
    const det = h00 * h11 - h01 * h01;
    if (!(Math.abs(det) > 1e-14)) break;
    const d0 = (h11 * g0 - h01 * g1) / det;
    const d1 = (h00 * g1 - h01 * g0) / det;
    b0 += d0; b1 += d1;
    if (Math.abs(d0) < 1e-12 && Math.abs(d1) < 1e-12) break;
  }
  let h00 = 0, h01 = 0, h11 = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.max(-500, Math.min(500, b0 + b1 * x[i]));
    const p = 1 / (1 + Math.exp(-e));
    const w = Math.max(1e-10, p * (1 - p));
    h00 += w; h01 += w * x[i]; h11 += w * x[i] * x[i];
  }
  const det = h00 * h11 - h01 * h01;
  const se1 = det > 0 ? Math.sqrt(h00 / det) : null;
  const z = se1 ? b1 / se1 : null;
  return { n, b0, b1, se1, z, p2: z == null ? null : 2 * (1 - normCdf(Math.abs(z))) };
}

function rangos(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length); let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rr = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = rr;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  const n = x.length;
  if (n < 5) return null;
  const rx = rangos(x), ry = rangos(y);
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  const rho = dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
  const t = Math.abs(rho) >= 1 ? Infinity : rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { n, rho, t, p2: 2 * (1 - normCdf(Math.abs(t))) };
}
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return null;
  const ma = mean(a), mb = mean(b), sa = stdev(a), sb = stdev(b);
  const se = Math.sqrt(sa * sa / na + sb * sb / nb);
  const t = se > 0 ? (ma - mb) / se : 0;
  const df = se > 0 ? (sa * sa / na + sb * sb / nb) ** 2 / ((sa * sa / na) ** 2 / (na - 1) + (sb * sb / nb) ** 2 / (nb - 1)) : 0;
  return { na, nb, ma, mb, sa, sb, se, t, df, p2: 2 * (1 - normCdf(Math.abs(t))) };
}
function cuantil(v, q) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

/* poder de un test de dos medias con el SE observado, normal (la convención
 * de los informes previos). delta = efecto / SE. */
function poder(delta, alpha = 0.05) {
  const zc = normInv(1 - alpha / 2);
  return (1 - normCdf(zc - delta)) + normCdf(-zc - delta);
}

/* ── el analizador point-in-time por símbolo (copia literal de barrido.js) ── */
function analizadorPorSimbolo(D, H) {
  const pivH = allPivots(H, LB, "h");
  const cumV = new Array(H.length + 1).fill(0);
  for (let k = 0; k < H.length; k++) cumV[k + 1] = cumV[k] + H[k].v;
  const lo = (arr, idx) => { let a = 0, b = arr.length; while (a < b) { const m = (a + b) >> 1; if (arr[m].i < idx) a = m + 1; else b = m; } return a; };
  const cache = new Map();
  const byTs = new Map();
  for (let i = 0; i < H.length; i++) byTs.set(H[i].ts * 1000, i);
  return {
    idxDe: (tms) => byTs.get(tms),
    piezas: (i) => {
      const bar = H[i], d = bar.t;
      let ctx = cache.get(d);
      if (ctx === undefined) {
        const win = [];
        for (let k = D.length - 1; k >= 0; k--) { if (D[k].t < d) win.unshift(D[k]); if (win.length >= DIAS_DAILY) break; }
        ctx = win.length >= 60 ? buildDailyCtx(win) : null;
        cache.clear(); cache.set(d, ctx);
      }
      if (!ctx) return null;
      let j = i; while (j > 0 && H[j - 1].t === d) j--;
      let ph = -Infinity, pl = Infinity, pv = 0;
      for (let k = j; k <= i; k++) { ph = Math.max(ph, H[k].h); pl = Math.min(pl, H[k].l); pv += H[k].v; }
      const partial = { ts: H[j].ts, t: d, o: H[j].o, h: ph, l: pl, c: bar.c, v: pv };
      const desde = bar.ts - DIAS_HOURLY * 86400;
      let h0 = i; while (h0 > 0 && H[h0 - 1].ts >= desde) h0--;
      const conf = i - LB;
      const fixVr = (p) => {
        if (p.i - h0 >= 20) return p;
        const from = Math.max(h0, p.i - 20), nb = p.i - from;
        if (nb <= 0) return { ...p, vr: 1 };
        const avg = (cumV[p.i] - cumV[from]) / nb;
        return { ...p, vr: avg > 0 ? H[p.i].v / avg : 1 };
      };
      const sel = (arr) => { const out = []; for (let k = lo(arr, h0 + LB); k < arr.length && arr[k].i <= conf; k++) out.push(fixVr(arr[k])); return out; };
      return { ctx, partial, hourly: H.slice(h0, i + 1), hourPivs: { his: sel(pivH.his), los: sel(pivH.los) }, spot: bar.c };
    },
  };
}

/* huella FNV-1a sobre la lista de números reportados */
function huella(nums) {
  let h = 0x811c9dc5;
  for (const x of nums) {
    const s = (x == null || !isFinite(x)) ? "null" : Number(x).toPrecision(12);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  }
  return h.toString(16).padStart(8, "0");
}

const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pct = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));

/* ═══════════════════════════════ main ═══════════════════════════════ */
function main() {
  const t0 = Date.now();
  const all = cargarTodo();
  const senales = cargarSenales();
  const ccl = loadCcl(DATA);
  const U38 = new Set(LIMPIOS_38.filter((s) => all.syms.includes(s)));
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
  const prevNulo = JSON.parse(fs.readFileSync(path.join(DIR, "results-nulo.json"), "utf8"));
  const prevCocos = JSON.parse(fs.readFileSync(path.join(DIR, "results-cocos.json"), "utf8"));
  const prevBarr = JSON.parse(fs.readFileSync(path.join(DIR, "results-barrido.json"), "utf8"));
  console.log(`series ${all.syms.length} · señales ${senales.length} · universo limpio ${U38.size} · semilla ${SEED} · sorteos del nulo VIEJO ${DRAWS}`);

  const out = { generado: new Date().toISOString(), semilla: SEED, draws: DRAWS };
  const HUELLA = [];

  /* ── features y umbrales (idéntico a nulo.js) ── */
  const FA = featuresSpy({ useAdj: true, lag: 1 });
  const volMedIS = (() => {
    const v = senales.filter((s) => s.dia <= IS_HASTA && s.vol != null).map((s) => s.vol).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })();
  console.log(`volMedIS = ${volMedIS} · results.json dice ${prev.volMedIS} · ${volMedIS === prev.volMedIS ? "COINCIDE" : "NO COINCIDE"}`);
  if (volMedIS !== prev.volMedIS) throw new Error("el umbral de volatilidad no reproduce");

  /* ── gates (idénticos a nulo.js) ── */
  const gateBase = (s) => {
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };
  const gateSin = (s) => (s.score >= 7 && s.rr >= 2 && !s.ct ? { riskMult: 1 } : null);
  const conj = (g, extra) => (s) => { const r = g(s); return r && extra(s) ? r : null; };
  const cVolBaja = (s) => s.vol != null && s.vol <= volMedIS;
  const c200 = (s) => s.s200 === 1;
  const c50 = (s) => s.s50 === 1;
  const c200bajo = (s) => s.s200 === 0;
  const cVolAlta = (s) => s.vol != null && s.vol > volMedIS;
  const cRegOk = (s) => gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime).regimenOk;

  const regDia = new Map();
  {
    const timelineSPY = [...new Set(all.hourly.SPY.map((b) => b.ts))].sort((a, b) => a - b);
    const reg = construirRegimen(all.daily, all.hourly, timelineSPY);
    const acc = new Map();
    for (const [ts, v] of reg) {
      const d = dia(ts);
      const a = acc.get(d) || { on: 0, tot: 0 };
      a.tot++; if (v === "risk_on") a.on++;
      acc.set(d, a);
    }
    for (const [d, a] of acc) regDia.set(d, a.on / a.tot >= 0.5);
    let ok = 0, tot = 0;
    for (const s of senales) { const r = reg.get(s.ts); if (r != null) { tot++; if (r === s.regime) ok++; } }
    console.log(`[chequeo] régimen del worker recalculado == el del cache en ${ok}/${tot} señales`);
    out.chequeoRegimen = { ok, tot };
  }
  const dCond = {
    volBaja: (d) => { const f = FA.feat.get(d); return !!(f && f.vol != null && f.vol <= volMedIS); },
    e200: (d) => { const f = FA.feat.get(d); return !!(f && f.above200); },
    e50: (d) => { const f = FA.feat.get(d); return !!(f && f.above50); },
    e200bajo: (d) => { const f = FA.feat.get(d); return !!(f && f.above200 === false); },
    volAlta: (d) => { const f = FA.feat.get(d); return !!(f && f.vol != null && f.vol > volMedIS); },
    regOk: (d) => !!regDia.get(d),
  };
  const PARES = [
    { nombre: "base + vol20 baja", padre: "base (worker)", gp: gateBase, cond: cVolBaja, dc: dCond.volBaja, exacto: true },
    { nombre: "base + SPY>EMA200", padre: "base (worker)", gp: gateBase, cond: c200, dc: dCond.e200, exacto: true },
    { nombre: "base + SPY>EMA50", padre: "base (worker)", gp: gateBase, cond: c50, dc: dCond.e50, exacto: true },
    { nombre: "base (worker)", padre: "sin régimen", gp: gateSin, cond: cRegOk, dc: dCond.regOk, exacto: false },
    { nombre: "sin régimen + vol20 baja", padre: "sin régimen", gp: gateSin, cond: cVolBaja, dc: dCond.volBaja, exacto: true },
    { nombre: "sin régimen + SPY>EMA200", padre: "sin régimen", gp: gateSin, cond: c200, dc: dCond.e200, exacto: true },
    { nombre: "sin régimen + SPY>EMA50", padre: "sin régimen", gp: gateSin, cond: c50, dc: dCond.e50, exacto: true },
    { nombre: "control: sin régimen + SPY<EMA200", padre: "sin régimen", gp: gateSin, cond: c200bajo, dc: dCond.e200bajo, exacto: true },
    { nombre: "control: sin régimen + vol20 alta", padre: "sin régimen", gp: gateSin, cond: cVolAlta, dc: dCond.volAlta, exacto: true },
  ];

  /* ── ctx por ventana + chequeo contra results.json ── */
  const CTX = {};
  for (const [vn, [d0, d1]] of Object.entries(VENTANAS)) CTX[vn] = construirCtx(all.hourly, U38, d0, d1);
  console.log(`\n===== CHEQUEO 1 · las 20 celdas de INFORME.md §3 =====`);
  const mapaPrev = {
    "base (worker)": "38/base (worker)", "sin régimen": "38/sin régimen",
    "base + vol20 baja": "38/base + vol20 baja", "base + SPY>EMA200": "38/base + SPY>EMA200",
    "base + SPY>EMA50": "38/base + SPY>EMA50", "sin régimen + vol20 baja": "38/sin régimen + vol20 baja",
    "sin régimen + SPY>EMA200": "38/sin régimen + SPY>EMA200", "sin régimen + SPY>EMA50": "38/sin régimen + SPY>EMA50",
    "control: sin régimen + SPY<EMA200": "38/sin régimen + SPY<EMA200 (control)",
    "control: sin régimen + vol20 alta": "38/sin régimen + vol20 alta (control)",
  };
  const GATES_CHK = {
    "base (worker)": gateBase, "sin régimen": gateSin,
    "base + vol20 baja": conj(gateBase, cVolBaja), "base + SPY>EMA200": conj(gateBase, c200),
    "base + SPY>EMA50": conj(gateBase, c50), "sin régimen + vol20 baja": conj(gateSin, cVolBaja),
    "sin régimen + SPY>EMA200": conj(gateSin, c200), "sin régimen + SPY>EMA50": conj(gateSin, c50),
    "control: sin régimen + SPY<EMA200": conj(gateSin, c200bajo), "control: sin régimen + vol20 alta": conj(gateSin, cVolAlta),
  };
  let peorD = 0, celdas = 0;
  const chequeo = [];
  for (const [gn, g] of Object.entries(GATES_CHK)) {
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const sim = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, g), ctx, ccl);
      const m = metricas(sim, "gold", ctx.meses);
      const ref = prev.corridas[`${mapaPrev[gn]}/${vn}`];
      const dm = ref ? Math.abs(m.mensualPct - ref.metricas.gold.mensualPct) : null;
      const dn = ref ? m.n - ref.metricas.gold.n : null;
      if (dm != null) { peorD = Math.max(peorD, dm); celdas++; }
      chequeo.push({ gate: gn, vn, n: m.n, mensual: m.mensualPct, dMensual: dm, dN: dn });
    }
  }
  console.log(`  ${celdas}/20 celdas comparadas · máxima diferencia de mensual ${peorD.toExponential(1)} pp · diferencias de n: ${chequeo.every((c) => c.dN === 0) ? "todas 0" : "HAY DESCUADRES"}`);
  out.chequeoTimeline = { celdas, peorD, ok: peorD < 1e-9 && chequeo.every((c) => c.dN === 0) };
  if (!out.chequeoTimeline.ok) throw new Error("ABORTA: no reproduce INFORME.md §3");

  /* ══════════════════ A · EL NULO VIEJO, REPRODUCIDO ══════════════════
   * Se replica EXACTAMENTE el bloque A de nulo.js, incluido el consumo del
   * PRNG por el nulo 1 (que no se usa acá pero adelanta el stream), para que
   * el nulo 2 salga bit a bit igual al publicado. */
  console.log(`\n===== CHEQUEO 2 · el nulo de BLOQUES publicado, reproducido =====`);
  out.viejo = {};
  const VIEJO = {};
  if (!SIN_VIEJO) {
    const rnd = mulberry32(SEED);
    let peorP = 0, peorPct = 0, n = 0;
    for (const par of PARES) {
      VIEJO[par.nombre] = {};
      for (const vn of ["IS", "OOS"]) {
        const ctx = CTX[vn];
        const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, par.gp);
        const hijo = padre.filter((o) => par.cond(o));
        const N = padre.length, K = hijo.length;
        if (!K || K === N) continue;                    // MISMO continue que nulo.js
        // nulo 1: sólo consumir el PRNG en el mismo orden (los valores no se usan)
        const idx = [...Array(N).keys()];
        for (let b = 0; b < DRAWS; b++) sorteoK(idx, N, K, rnd);
        // nulo 2: bloques al azar
        const dias = ctx.dias;
        const maskReal = dias.map((d) => par.dc(d));
        const offs = bloquesOff(maskReal);
        const largos = offs.map(([a, b]) => b - a + 1);
        const offSetReal = new Set();
        for (const [a, b] of offs) for (let i = a; i <= b; i++) offSetReal.add(dias[i]);
        const simRealDia = simular(padre.filter((o) => !offSetReal.has(o.dia)), ctx, ccl);
        const mrdG = metricas(simRealDia, "gold", ctx.meses), mrdB = metricas(simRealDia, "black", ctx.meses);
        const n2G = [], n2B = [];
        for (let b = 0; b < DRAWS; b++) {
          const col = colocarBloques(dias.length, largos, rnd);
          if (!col) continue;
          const off = new Set();
          for (const [a, z] of col) for (let i = a; i <= z && i < dias.length; i++) off.add(dias[i]);
          const s = simular(padre.filter((o) => !off.has(o.dia)), ctx, ccl, { light: true });
          n2G.push(mensualLight(s, "gold", ctx.meses));
          n2B.push(mensualLight(s, "black", ctx.meses));
        }
        const uG = ubicar(mrdG.mensualPct, n2G), uB = ubicar(mrdB.mensualPct, n2B);
        VIEJO[par.nombre][vn] = { gold: uG, black: uB, realDia: { gold: mrdG.mensualPct, black: mrdB.mensualPct }, N, K, bloques: offs.length, diasOff: largos.reduce((s, x) => s + x, 0), diasTot: dias.length, largos };
        const ref = prevNulo.A[par.nombre] && prevNulo.A[par.nombre][vn];
        if (ref) {
          const dp = Math.abs(uG.p1cola - ref.nulo2.gold.p1cola);
          const dpc = Math.abs(uG.percentil - ref.nulo2.gold.percentil);
          const dpB = Math.abs(uB.p1cola - ref.nulo2.black.p1cola);
          peorP = Math.max(peorP, dp, dpB); peorPct = Math.max(peorPct, dpc); n++;
          console.log(`  ${(par.nombre + "/" + vn).padEnd(40)} pctil ${pct(uG.percentil).padStart(6)} (pub ${pct(ref.nulo2.gold.percentil).padStart(6)}) p=${uG.p1cola.toFixed(4)} (pub ${ref.nulo2.gold.p1cola.toFixed(4)}) Δp=${dp.toExponential(1)}`);
        }
      }
    }
    console.log(`  celdas comparadas ${n} · máxima |Δp| ${peorP.toExponential(2)} · máxima |Δpercentil| ${peorPct.toExponential(2)}`);
    out.viejo.chequeo = { celdas: n, peorP, peorPct, ok: peorP < 1e-12 };
    if (peorP > 1e-12) console.log(`  *** EL NULO VIEJO NO REPRODUCE — ver INFORME-ROTACION §1 ***`);
  } else {
    console.log("  (salteado con --sinViejo)");
  }

  /* ══════════════════ B · EL NULO DE ROTACIÓN ══════════════════ */
  console.log(`\n===== B · NULO DE ROTACIÓN CIRCULAR · p EXACTO POR ENUMERACIÓN =====`);
  out.rot = {};
  for (const par of PARES) {
    out.rot[par.nombre] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, par.gp);
      const hijo = padre.filter((o) => par.cond(o));
      const N = padre.length, K = hijo.length;
      if (!K || K === N) { console.log(`  ${par.nombre}/${vn}: K=${K} N=${N}, no filtra nada`); continue; }
      const dias = ctx.dias, T = dias.length;
      const mask = dias.map((d) => par.dc(d));
      const circ = bloquesOffCircular(mask);
      const largosCirc = circ.map((b) => b.len);
      const diasOff = mask.filter((x) => !x).length;
      const lin = bloquesOff(mask).map(([a, b]) => b - a + 1);
      const adm = rotacionesAdmisibles(mask);
      const admSet = new Set(adm);
      const j0adm = admSet.has(0);
      const J = j0adm ? adm : [0, ...adm].sort((a, b) => a - b);

      // el estadístico real = la rotación j = 0 (por definición)
      const offReal = new Set();
      for (let t = 0; t < T; t++) if (!mask[t]) offReal.add(dias[t]);
      const simReal = simular(padre.filter((o) => !offReal.has(o.dia)), ctx, ccl);
      const real = Object.fromEntries(TIERS.map((tt) => [tt, metricas(simReal, tt, ctx.meses).mensualPct]));

      // enumeración
      const statsAdm = Object.fromEntries(TIERS.map((tt) => [tt, []]));
      const statsAll = Object.fromEntries(TIERS.map((tt) => [tt, []]));
      let okDias = 0, okMulti = 0, okMultiAdm = 0, nAdm = 0;
      for (let j = 0; j < T; j++) {
        const mj = rotarMask(mask, j);
        const off = new Set();
        let cnt = 0;
        for (let t = 0; t < T; t++) if (!mj[t]) { off.add(dias[t]); cnt++; }
        if (cnt === diasOff) okDias++;
        const linJ = bloquesOff(mj).map(([a, b]) => b - a + 1);
        const circJ = bloquesOffCircular(mj).map((b) => b.len);
        if (igualMultiset(circJ, largosCirc)) okMulti++;
        const esAdm = admSet.has(j) || (j === 0 && !j0adm);
        const s = simular(padre.filter((o) => !off.has(o.dia)), ctx, ccl, { light: true });
        for (const tt of TIERS) {
          const v = mensualLight(s, tt, ctx.meses);
          statsAll[tt].push(v);
          if (esAdm && j !== 0) statsAdm[tt].push(v);
        }
        if (esAdm) { nAdm++; if (igualMultiset(linJ, largosCirc)) okMultiAdm++; }
      }
      const uAdm = Object.fromEntries(TIERS.map((tt) => [tt, ubicar(real[tt], statsAdm[tt])]));
      const uAll = Object.fromEntries(TIERS.map((tt) => [tt, ubicar(real[tt], statsAll[tt].filter((_, j) => j !== 0))]));
      out.rot[par.nombre][vn] = {
        N, K, T, diasOff, bloquesCirc: circ.length, bloquesLin: lin.length,
        largosCirc, admisibles: nAdm, j0admisible: j0adm,
        pMin: 1 / (statsAdm.gold.length + 1),
        verif: { diasOk: okDias === T, multiCircOk: okMulti === T, multiLinAdmOk: okMultiAdm === nAdm },
        real, adm: uAdm, todas: uAll,
      };
      const g = uAdm.gold, b = uAdm.black, ga = uAll.gold;
      const refp = prevNulo.A[par.nombre] && prevNulo.A[par.nombre][vn] ? prevNulo.A[par.nombre][vn].nulo2 : null;
      console.log(`  ${(par.nombre + " / " + vn).padEnd(40)} señales ${K}/${N} · T=${T} · apagadas ${diasOff} en ${circ.length} bloques (circular) / ${lin.length} (lineal)`);
      console.log(`     rotaciones admisibles ${nAdm}/${T} (p mínimo ${(1 / (statsAdm.gold.length + 1)).toFixed(4)}) · verif días ${okDias}/${T} · multiset circular ${okMulti}/${T} · multiset lineal en admisibles ${okMultiAdm}/${nAdm}`);
      console.log(`     GOLD real ${n2(g.real).padStart(6)}% · mediana rot ${n2(g.med).padStart(6)}% · pctil ${pct(g.percentil).padStart(6)} · p EXACTO ${g.p1cola.toFixed(4)}${refp ? `   (publicado: pctil ${pct(refp.gold.percentil)} p=${refp.gold.p1cola.toFixed(4)})` : ""}`);
      console.log(`     BLACK real ${n2(b.real).padStart(6)}% · pctil ${pct(b.percentil).padStart(6)} · p EXACTO ${b.p1cola.toFixed(4)}${refp ? `   (publicado: pctil ${pct(refp.black.percentil)} p=${refp.black.p1cola.toFixed(4)})` : ""}`);
      console.log(`     [robustez] con las T rotaciones sin filtrar la costura: gold pctil ${pct(ga.percentil)} p=${ga.p1cola.toFixed(4)}`);
      HUELLA.push(g.percentil, g.p1cola, b.percentil, b.p1cola);
    }
  }

  /* ── B.2 · la celda de INFORME-COCOS §D.4 (tarifa Cocos) ── */
  console.log(`\n===== B.2 · LA CELDA DE INFORME-COCOS D.4 (filtro de vol, tarifa Cocos) =====`);
  out.rotCocos = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase);
    const dias = ctx.dias, T = dias.length;
    const mask = dias.map((d) => dCond.volBaja(d));
    const adm = rotacionesAdmisibles(mask);
    const admSet = new Set(adm);
    const offReal = new Set();
    for (let t = 0; t < T; t++) if (!mask[t]) offReal.add(dias[t]);
    const simReal = simular(padre.filter((o) => !offReal.has(o.dia)), ctx, ccl);
    const real = Object.fromEntries(TIERS.map((tt) => [tt, metricas(simReal, tt, ctx.meses).mensualPct]));
    const st = Object.fromEntries(TIERS.map((tt) => [tt, []]));
    for (const j of adm) {
      if (j === 0) continue;
      const mj = rotarMask(mask, j);
      const off = new Set();
      for (let t = 0; t < T; t++) if (!mj[t]) off.add(dias[t]);
      const s = simular(padre.filter((o) => !off.has(o.dia)), ctx, ccl, { light: true });
      for (const tt of TIERS) st[tt].push(mensualLight(s, tt, ctx.meses));
    }
    const u = Object.fromEntries(TIERS.map((tt) => [tt, ubicar(real[tt], st[tt])]));
    const ref = prevCocos.D.volatilidad[vn];
    out.rotCocos[vn] = { real, rot: u, publicadoNulo2: ref ? { cocos: ref.nulo2.cocos, gold: ref.nulo2.gold } : null, admisibles: adm.length };
    console.log(`  ${vn}: COCOS real ${n2(u.cocos.real)}% · mediana rot ${n2(u.cocos.med)}% · pctil ${pct(u.cocos.percentil)} · p EXACTO ${u.cocos.p1cola.toFixed(4)}` +
      (ref ? `   (publicado bloques: pctil ${pct(ref.nulo2.cocos.percentil)} p=${ref.nulo2.cocos.p1cola.toFixed(4)})` : ""));
    console.log(`      GOLD pctil ${pct(u.gold.percentil)} p=${u.gold.p1cola.toFixed(4)}` + (ref ? `   (publicado: pctil ${pct(ref.nulo2.gold.percentil)} p=${ref.nulo2.gold.p1cola.toFixed(4)})` : ""));
    HUELLA.push(u.cocos.percentil, u.cocos.p1cola);
  }

  /* ══════════════════ C · EL 79% CONTRA EL RANGO INTRABARRA ══════════════════ */
  console.log(`\n===== C · EL 79% · ¿ARTEFACTO DE GRANULARIDAD O PROPIEDAD DEL MOTOR? =====`);
  const TOLS = [0.0025, 0.005, 0.01, 0.02];
  const ANA = {};
  const getAna = (sym) => (ANA[sym] || (ANA[sym] = analizadorPorSimbolo(all.daily[sym], all.hourly[sym])));
  const TR = {};
  let okZona = 0, totZona = 0;
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const sim = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase), ctx, ccl);
    TR[vn] = sim.trades.map((tr) => {
      const a = getAna(tr.sym);
      const H = all.hourly[tr.sym];
      const iFill = a.idxDe(tr.entryTs);
      const iSen = a.idxDe(tr.tsSenal * 1000);
      let zona = null;
      if (iSen != null) { const pz = a.piezas(iSen); if (pz) { const k = analyzeKit(pz); zona = k.buyZone || null; } }
      totZona++;
      if (zona && Math.abs(zona.hi - tr.entryPx) / tr.entryPx < 1e-9) okZona++;
      const evalEn = (i) => {
        if (i == null) return null;
        const pz = a.piezas(i);
        if (!pz) return null;
        const k = analyzeKit(pz);
        return { buy: k.buy, score: k.score, rr: k.rr, atr: k.atr, spot: k.spot };
      };
      const enSig = evalEn(iFill != null && iFill + 1 < H.length ? iFill + 1 : null);
      const enFill = evalEn(iFill);
      const mismaCon = (e, tol) => (e == null || e.buy == null ? false : Math.abs(e.buy - tr.entryPx) / tr.entryPx <= tol);
      const barFill = ctx.serie[tr.sym][ctx.idx[tr.sym].get(tr.entryTs)];
      const rango = barFill.h - barFill.l;
      const anchoClus = zona ? zona.hi - zona.lo : null;
      const anchoTol = ZONE_TOL * tr.entryPx;
      const anchoEfec = anchoClus == null ? null : Math.max(anchoClus, anchoTol);
      return {
        sym: tr.sym, dia: tr.dia, vn,
        entry: tr.entryPx, zonaLo: zona ? zona.lo : null, zonaHi: zona ? zona.hi : null,
        barH: barFill.h, barL: barFill.l, rango, rangoPct: rango / tr.entryPx,
        anchoClus, anchoTol, anchoEfec,
        r1: anchoClus > 0 ? rango / anchoClus : null,
        r2: rango / anchoTol,
        r3: anchoEfec > 0 ? rango / anchoEfec : null,
        gold: tr.legs.reduce((s, l) => s + l.pnl.gold, 0),
        aguantaSigTol: Object.fromEntries(TOLS.map((t) => [t, mismaCon(enSig, t) ? 1 : 0])),
        aguantaFillTol: Object.fromEntries(TOLS.map((t) => [t, mismaCon(enFill, t) ? 1 : 0])),
        sinNivelSig: enSig && enSig.buy == null ? 1 : 0,
      };
    });
  }
  const TODOS = [...TR.IS, ...TR.OOS];
  console.log(`  la zona reconstruida en la barra de la señal reproduce el nivel de entrada en ${okZona}/${totZona} trades`);
  out.selfCheckZona = { ok: okZona, tot: totZona };

  // self-check contra la tabla publicada de INFORME-BARRIDO §6 (fila "siguiente")
  const refE = prevBarr.E.filas.filter((f) => f.cuando === "siguiente");
  let okE = 0, totE = 0;
  for (const f of refE) {
    const grp = f.vn === "POOL" ? TODOS : TR[f.vn];
    for (const t of TOLS) {
      const rr = grp.filter((x) => !x.aguantaSigTol[t]).length / grp.length;
      totE++;
      if (Math.abs(rr - f.rederiva[String(t)]) < 1e-12) okE++;
    }
  }
  console.log(`  la tasa de re-derivación reproduce la tabla publicada de INFORME-BARRIDO §6 en ${okE}/${totE} celdas`);
  out.chequeoE = { ok: okE, tot: totE };

  const DEFS = [
    { id: "r1", nombre: "amplitud del cluster (zonaHi - zonaLo)", nota: "sólo definida en las zonas de 2+ pivotes" },
    { id: "r2", nombre: "banda de agrupamiento (ZONE_TOL x nivel = 0,6%)", nota: "definida siempre" },
    { id: "r3", nombre: "efectivo = max(cluster, banda)", nota: "definida siempre" },
  ];
  out.C = { defs: DEFS, tablas: {}, tendencia: {}, descr: {} };
  {
    const w = TODOS.map((x) => x.anchoClus).filter((x) => x != null);
    console.log(`  anchos: zonas de UN pivote (ancho 0) ${w.filter((x) => !(x > 0)).length}/${w.length} · ancho mediano del cluster ${pct(cuantil(TODOS.filter((x) => x.anchoClus > 0).map((x) => x.anchoClus / x.entry), 0.5), 3)} del nivel`);
    console.log(`  rango intrabarra de la barra del fill: p10 ${pct(cuantil(TODOS.map((x) => x.rangoPct), 0.1), 2)} · mediana ${pct(cuantil(TODOS.map((x) => x.rangoPct), 0.5), 2)} · p90 ${pct(cuantil(TODOS.map((x) => x.rangoPct), 0.9), 2)}`);
    out.C.descr = {
      zonasUnPivote: w.filter((x) => !(x > 0)).length, nZonas: w.length,
      anchoClusMedPct: cuantil(TODOS.filter((x) => x.anchoClus > 0).map((x) => x.anchoClus / x.entry), 0.5),
      rangoPct: Object.fromEntries([0.1, 0.25, 0.5, 0.75, 0.9].map((q) => [q, cuantil(TODOS.map((x) => x.rangoPct), q)])),
    };
  }

  const NQ = 5;   // quintiles: con n = 205 quedan ~41 por celda
  for (const def of DEFS) {
    out.C.tablas[def.id] = {}; out.C.tendencia[def.id] = {};
    const muestra = TODOS.filter((x) => x[def.id] != null && isFinite(x[def.id]) && x[def.id] > 0);
    const ord = [...muestra].sort((a, b) => a[def.id] - b[def.id]);
    console.log(`\n  --- ancho = ${def.nombre} · n = ${ord.length} (${def.nota}) ---`);
    console.log(`  quintil   n    ratio med   ratio rango      ${TOLS.map((t) => `re-der ±${(t * 100).toFixed(2)}%`).join("  ")}`);
    const grupos = [];
    for (let q = 0; q < NQ; q++) {
      const a = Math.floor((q * ord.length) / NQ), b = Math.floor(((q + 1) * ord.length) / NQ);
      const g = ord.slice(a, b);
      if (!g.length) continue;
      const row = {
        quintil: q + 1, n: g.length,
        ratioMed: cuantil(g.map((x) => x[def.id]), 0.5),
        ratioMin: g[0][def.id], ratioMax: g[g.length - 1][def.id],
        rangoPctMed: cuantil(g.map((x) => x.rangoPct), 0.5),
        rederiva: Object.fromEntries(TOLS.map((t) => [t, g.filter((x) => !x.aguantaSigTol[t]).length / g.length])),
        rederivaFill: Object.fromEntries(TOLS.map((t) => [t, g.filter((x) => !x.aguantaFillTol[t]).length / g.length])),
      };
      grupos.push(row);
      console.log(`     ${row.quintil}    ${String(row.n).padStart(3)}   ${n2(row.ratioMed).padStart(8)}   ${n2(row.ratioMin).padStart(5)}-${n2(row.ratioMax).padEnd(7)}   ${TOLS.map((t) => pct(row.rederiva[t]).padStart(13)).join("  ")}`);
    }
    out.C.tablas[def.id] = grupos;
    const x = muestra.map((v) => Math.log(v[def.id]));
    for (const t of TOLS) {
      const y = muestra.map((v) => (v.aguantaSigTol[t] ? 0 : 1));
      const sp = spearman(muestra.map((v) => v[def.id]), y);
      const lg = logistica(x, y);
      // tasa ajustada en ratio = 1 (barra tan angosta como la zona): es la
      // extrapolación del modelo a "granularidad perfecta". No se extrapola
      // más abajo del mínimo observado sin decirlo.
      const pEn1 = 1 / (1 + Math.exp(-lg.b0));
      const rmin = Math.min(...muestra.map((v) => v[def.id]));
      const pEnMin = 1 / (1 + Math.exp(-(lg.b0 + lg.b1 * Math.log(rmin))));
      // ¿replica en las dos ventanas?
      const porVn = {};
      for (const vn of ["IS", "OOS"]) {
        const m2 = muestra.filter((v) => v.vn === vn);
        porVn[vn] = m2.length >= 10 ? spearman(m2.map((v) => v[def.id]), m2.map((v) => (v.aguantaSigTol[t] ? 0 : 1))) : null;
      }
      out.C.tendencia[def.id][t] = { spearman: sp, logit: lg, tasa: mean(y), pEn1, rmin, pEnMin, porVn };
      console.log(`     tendencia ±${(t * 100).toFixed(2)}%: Spearman rho=${n2(sp.rho, 4)} p=${sp.p2.toFixed(4)} · logit b1(log ratio)=${n2(lg.b1, 4)} se=${n2(lg.se1, 4)} z=${n2(lg.z)} p=${lg.p2.toFixed(4)} · tasa global ${pct(mean(y))} · tasa ajustada en ratio=1 ${pct(pEn1)} · IS rho=${porVn.IS ? n2(porVn.IS.rho, 3) : "-"} (p=${porVn.IS ? porVn.IS.p2.toFixed(4) : "-"}) OOS rho=${porVn.OOS ? n2(porVn.OOS.rho, 3) : "-"} (p=${porVn.OOS ? porVn.OOS.p2.toFixed(4) : "-"})`);
      HUELLA.push(sp.rho, sp.p2, lg.b1, lg.p2, pEn1);
    }
  }

  /* ══════════════════ D · PODER DEL TEST PASA-VS-BLOQUEA ══════════════════ */
  console.log(`\n===== D · PODER DEL TEST DE PASA-VS-BLOQUEA (INFORME-NULO §3) =====`);
  out.D = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase);
    const sim = simular(padre, ctx, ccl);
    const pasa = { gold: [], black: [], bruto: [] }, bloq = { gold: [], black: [], bruto: [] };
    for (const t of sim.trades) {
      const g = cVolBaja(t) ? pasa : bloq;
      g.gold.push(t.legs.reduce((s, l) => s + l.pnl.gold, 0));
      g.black.push(t.legs.reduce((s, l) => s + l.pnl.black, 0));
      g.bruto.push(t.legs.reduce((s, l) => s + l.bruto, 0) / t.notional0);
    }
    out.D[vn] = {};
    for (const met of ["gold", "black", "bruto"]) {
      const w = welch(pasa[met], bloq[met]);
      const dif = w.ma - w.mb;
      const delta = w.se > 0 ? dif / w.se : 0;
      const zc = normInv(0.975);
      const mde95 = zc * w.se;                      // efecto mínimo SIGNIFICATIVO
      const mde80 = (zc + normInv(0.80)) * w.se;    // efecto mínimo con 80% de poder
      const pot = poder(Math.abs(delta));
      const nMult80 = ((zc + normInv(0.80)) / Math.abs(delta)) ** 2;
      const nMult50 = (zc / Math.abs(delta)) ** 2;
      const nTot = w.na + w.nb;
      out.D[vn][met] = { na: w.na, nb: w.nb, ma: w.ma, mb: w.mb, dif, se: w.se, t: w.t, p2: w.p2, mde95, mde80, potencia: pot, nMult80, nMult50, nTot, nNec80: nTot * nMult80, nNec50: nTot * nMult50 };
      const u = met === "bruto" ? (v) => pct(v, 3) : (v) => "$" + fmt(v);
      console.log(`  ${vn} · ${met}: n ${w.na}/${w.nb} · dif ${u(dif)} · SE ${u(w.se)} · t=${n2(w.t)} p=${w.p2.toFixed(4)}`);
      console.log(`     efecto mínimo detectable (significancia, alfa 0,05 dos colas) ${u(mde95)} = ${n2(mde95 / Math.abs(dif))}x el observado`);
      console.log(`     efecto mínimo detectable con 80% de poder ${u(mde80)} = ${n2(mde80 / Math.abs(dif))}x el observado`);
      console.log(`     POTENCIA para el efecto observado: ${pct(pot, 1)} · n necesario para 80% de poder: ${n2(nMult80, 1)}x (${fmt(nTot * nMult80)} trades, hoy ${nTot}) · para significancia al 50% de poder: ${n2(nMult50, 1)}x`);
      HUELLA.push(dif, w.se, pot, nMult80);
    }
  }

  out.huella = { n: HUELLA.length, fnv1a: huella(HUELLA) };
  console.log(`\nhuella de reproducibilidad: ${HUELLA.length} números, FNV-1a ${out.huella.fnv1a}`);
  fs.writeFileSync(path.join(DIR, "results-rotacion.json"), JSON.stringify(out, null, 1));
  console.log(`results-rotacion.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
