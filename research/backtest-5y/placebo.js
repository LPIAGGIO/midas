/* placebo.js — EL TEST PLACEBO
 *
 * Pregunta: ¿el motor + el simulador encuentran edge donde POR CONSTRUCCIÓN
 * no hay nada? Se corre la cañería COMPLETA (engine.js → señales → gate del
 * worker → cartera → comisión de Cocos) sobre series sintéticas.
 *
 * Tres placebos, de menos a más exigente (los que pidió LP):
 *   1. rw      · random walk gaussiano con la misma volatilidad y el mismo
 *                drift que cada papel; retornos independientes.
 *   2. boot    · permutación al azar de los retornos REALES de cada papel
 *                (destruye el orden temporal, conserva EXACTO el marginal).
 *   3. bloque5 · igual que 2 pero permutando bloques de 5 barras.
 * Más dos controles que agrega este script y que no estaban pedidos:
 *   0. ident · la misma construcción con permutación identidad = la serie
 *              real. Mide cuánto distorsiona la propia construcción.
 *   4. nulo  · bootstrap con los retornos CENTRADOS (drift 0 por papel) y
 *              CCL sin deriva. Es el único placebo verdaderamente "sin nada
 *              que encontrar": separa "el motor fabrica señal" de "el motor
 *              cobra el drift del activo y del dólar".
 *
 * El CCL se corre en dos versiones: el real y uno aleatorizado sin deriva.
 *
 * Semilla 20260917. Todo local, sin VPS, sin Supabase, sin commitear.
 * ESM (el package.json de Midas es "type":"module").
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadSeries, loadCcl, allPivots, buildDailyCtx, analyzeKit, emaOf, emaStep, gatePasa, LB } from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = process.argv.slice(2);
const argN = (k, d) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };
const UNIV = argN("univ", 100);
const HILOS = argN("hilos", Math.min(8, Math.max(1, os.cpus().length - 2)));
const SOLO_CHK = ARGS.includes("--soloChequeo");
const SEED = 20260917;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
const seedDe = (tipo, k) => (SEED ^ Math.imul(hashStr(tipo), 2654435761) ^ Math.imul(k + 1, 40503)) >>> 0;
const seedCcl = (k) => (SEED ^ Math.imul(k + 1, 2246822519)) >>> 0;

/* ── constantes: IDÉNTICAS a simulate.js / cocos.js ── */
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
const TIPOS = ["rw", "boot", "bloque5", "nulo"];
const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/* ─────────────────────────── carga ─────────────────────────── */
function cargarTodo(soloSyms = null) {
  const syms = fs.readdirSync(path.join(DATA, "hourly"))
    .filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  const daily = {}, hourly = {};
  for (const s of syms) {
    if (soloSyms && !soloSyms.includes(s)) continue;
    const d = loadSeries(DATA, "daily", s), h = loadSeries(DATA, "hourly", s);
    if (!d || !h) continue;
    daily[s] = TRUNCA_DAILY[s] ? d.filter((b) => b.t >= TRUNCA_DAILY[s]) : d;
    hourly[s] = h;
  }
  return { syms: Object.keys(daily), daily, hourly };
}

/* ── régimen del worker, barra por barra (copia literal de simulate.js) ── */
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

/* ── features de SPY (copia literal de simulate.js; sólo para el chequeo) ── */
function featuresSpy() {
  const spy = loadSeries(DATA, "daily", "SPY", { useAdj: true });
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
  for (let i = 0; i < spy.length; i++) f.set(spy[i].t, { above200: e200[i] != null ? c[i] >= e200[i] : null, above50: e50[i] != null ? c[i] >= e50[i] : null, vol: vol[i] });
  const lag = new Map();
  for (let i = 1; i < spy.length; i++) lag.set(spy[i].t, f.get(spy[i - 1].t));
  return lag;
}

/* ── el motor barra por barra (copia literal de simulate.js) ── */
function analizadorRapido(D, H) {
  const pivH = allPivots(H, LB, "h");
  const cumV = new Array(H.length + 1).fill(0);
  for (let k = 0; k < H.length; k++) cumV[k + 1] = cumV[k] + H[k].v;
  const lo = (arr, idx) => { let a = 0, b = arr.length; while (a < b) { const m = (a + b) >> 1; if (arr[m].i < idx) a = m + 1; else b = m; } return a; };
  const cache = new Map();
  return (i, spotOverride) => {
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
    return analyzeKit({ ctx, partial, hourly: H.slice(h0, i + 1), hourPivs: { his: sel(pivH.his), los: sel(pivH.los) }, spot: spotOverride ?? bar.c });
  };
}

function generarSenales({ syms, daily, hourly }, regimen, feats) {
  const senales = [];
  const stats = { barras: 0, conKit: 0, conBuy: 0, emitidas: 0 };
  for (const sym of syms) {
    const H = hourly[sym], D = daily[sym];
    if (!H || !D || H.length < 200) continue;
    const analiza = analizadorRapido(D, H);
    let ultEntry = null, ultTs = 0;
    for (let i = 0; i < H.length; i++) {
      const bar = H[i], d = bar.t;
      stats.barras++;
      const kit = analiza(i);
      if (!kit) continue;
      stats.conKit++;
      if (kit.buy == null) continue;
      stats.conBuy++;
      if (!(kit.stop > 0 && kit.stop < kit.buy) || !(kit.target > kit.buy)) continue;
      const msTs = bar.ts * 1000;
      if (ultEntry != null && Math.abs(kit.buy - ultEntry) / kit.buy < 0.005 && msTs - ultTs <= VENTANA_H * 3600 * 1000) continue;
      ultEntry = kit.buy; ultTs = msTs;
      const rg = regimen.get(bar.ts) || null;
      const ft = feats.get(d) || {};
      senales.push({
        sym, ts: bar.ts, dia: d, entry: kit.buy, stop: kit.stop, target: kit.target,
        score: kit.score, rr: kit.rr, tipo: kit.tipo, estr: kit.estr, rsi: kit.rsi,
        ct: kit.contraTendencia ? 1 : 0, regime: rg,
        s200: ft.above200 == null ? null : (ft.above200 ? 1 : 0),
        s50: ft.above50 == null ? null : (ft.above50 ? 1 : 0),
        vol: ft.vol == null ? null : Math.round(ft.vol * 10000) / 10000,
      });
      stats.emitidas++;
    }
  }
  senales.sort((a, b) => a.ts - b.ts);
  return { senales, stats };
}

/* ────────────────── ctx / órdenes / simulador (copia de cocos.js) ────────── */
function construirCtx(bars, universo, desde, hasta) {
  const tsSet = new Set(); const barAt = {}, serie = {};
  for (const s of universo) {
    if (!bars[s]) continue;
    barAt[s] = new Map(); serie[s] = [];
    for (const b of bars[s]) {
      if (b.t < desde || b.t > hasta) continue;
      tsSet.add(b.ts * 1000); barAt[s].set(b.ts * 1000, b); serie[s].push(b);
    }
  }
  const timeline = [...tsSet].sort((a, b) => a - b);
  const dias = [...new Set(timeline.map((t) => dia(t / 1000)))].sort();
  const meses = dias.length ? (new Date(dias[dias.length - 1]) - new Date(dias[0])) / (365.25 / 12 * 86400000) : 1;
  return { barAt, serie, timeline, dias, meses, tFin: timeline.length ? timeline[timeline.length - 1] : 0, bars, desde, hasta };
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

/* Variantes de diagnóstico (apagadas en el caso base, que es idéntico a
 * simulate.js / cocos.js). Cada una ataca UNO de los sospechosos de fabricar
 * señal dentro de la barra horaria:
 *   ordenOptimista → se evalúa el target ANTES que el stop (el base hace al
 *                    revés, que es lo pesimista). Mide la ambigüedad intrabarra.
 *   gapStop        → si la barra ABRIÓ debajo del stop, el stop se ejecuta en
 *                    la apertura y no en el nivel. Mide cuánto vale el
 *                    supuesto de "el stop siempre se llena en el precio exacto".
 *   fillCierre     → la orden límite no se llena al toque intrabarra sino al
 *                    CIERRE de la barra que tocó (la confirmación que el
 *                    worker hace a 150 s y el backtest no simula).
 */
function simular(ordenes, ctx, ccl, { exitMode = "intrabar", capPct = CAP_PCT, ordenOptimista = false, gapStop = false, fillCierre = false } = {}) {
  const { barAt, timeline, tFin, bars } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const skips = { openSym: 0, dupPend: 0, posMax: 0, entradasDia: 0, qtyCero: 0, reemplazadas: 0, expiradas: 0, sinFill: 0, sinBarras: 0 };
  const entradasDia = new Map();
  const realized = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const equity = [];
  let oi = 0;

  const comprometido = () => {
    let s = 0;
    for (const p of pend.values()) s += p.notional;
    for (const p of open.values()) s += p.notional;
    return s;
  };
  const feeLeg = (n, tier, bonif) => n * (bonif ? DERECHOS : FEE[tier]);

  const cerrarPata = (pos, qty, px, ts, reason) => {
    const d = dia(ts / 1000);
    const rOut = rArs(d);
    const intradia = dia(pos.entryTs / 1000) === d;
    const entN = qty * pos.entryPx * pos.rIn;
    const outN = qty * px * rOut;
    const leg = {
      sym: pos.sym, qty, reason, entryTs: pos.entryTs, exitTs: ts, entryPx: pos.entryPx, exitPx: px,
      entN, bruto: outN - entN, brutoSinCcl: qty * (px - pos.entryPx) * pos.rIn, pnl: {}, fees: {},
    };
    for (const tier of TIERS) {
      const f = feeLeg(entN, tier, false) + feeLeg(outN, tier, intradia);
      leg.fees[tier] = f;
      leg.pnl[tier] = outN - entN - f;
      realized[tier] += leg.pnl[tier];
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
        const px = fillCierre ? b.c : p.entry;
        if (!(px > p.stop)) { pend.delete(sym); skips.qtyCero++; continue; }
        pend.delete(sym);
        const pos = {
          sym: p.sym, qty: p.qty, qty0: p.qty, entryPx: px, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: px - p.stop,
          notional: p.qty * px * p.rIn, legs: [], tpDone: false, barras: 0,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }

    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs) continue;
      pos.barras++;
      const hi = exitMode === "close" ? b.c : b.h;
      const lo = exitMode === "close" ? b.c : b.l;
      const pegarStop = () => {
        const px = gapStop && b.o < pos.stop ? b.o : pos.stop;
        cerrarPata(pos, pos.qty, px, t, pos.stop > pos.stopIni ? "trailing" : "stop");
        open.delete(sym);
      };
      const pegarArriba = () => {   // TP parcial + target; devuelve true si cerró
        if (TP_FRAC > 0 && !pos.tpDone) {
          const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
          if (hi >= nivel) {
            const q = pos.qty / 2;
            cerrarPata(pos, q, Math.min(nivel, pos.target), t, "tp_parcial");
            pos.qty -= q; pos.notional = pos.qty * pos.entryPx * pos.rIn; pos.tpDone = true;
          }
        }
        if (hi >= pos.target) { cerrarPata(pos, pos.qty, pos.target, t, "target"); open.delete(sym); return true; }
        return false;
      };
      if (ordenOptimista) {
        if (pegarArriba()) continue;
        if (lo <= pos.stop) { pegarStop(); continue; }
      } else {
        if (lo <= pos.stop) { pegarStop(); continue; }
        if (pegarArriba()) continue;
      }
      if (pos.R > 0) {
        const k = Math.floor((hi - pos.entryPx) / pos.R);
        if (k >= 2 && pos.entryPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (k - 2) * pos.R;
      }
    }

    const d = dia(t / 1000);
    let unreal = 0;
    for (const [sym, pos] of open) {
      const b = barAt[sym].get(t);
      unreal += pos.qty * ((b ? b.c : pos.entryPx) - pos.entryPx) * pos.rIn;
    }
    const row = { dia: d, eq: {} };
    for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
    if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row;
    else equity.push(row);
  }

  skips.sinFill += pend.size;
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || bars[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    cerrarPata(pos, pos.qty, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (equity.length) {
    const last = equity[equity.length - 1];
    for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier];
  }
  return { trades, legs, skips, equity, realized, nSenales: ordenes.length };
}

/* ─────────────────────────── estadística ─────────────────────────── */
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function cuantil(arrOrd, q) {
  if (!arrOrd.length) return null;
  const i = (arrOrd.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? arrOrd[lo] : arrOrd[lo] + (arrOrd[hi] - arrOrd[lo]) * (i - lo);
}
function resumen(v) {
  const s = [...v].sort((a, b) => a - b);
  return {
    n: v.length, media: mean(v), sd: stdev(v),
    p05: cuantil(s, 0.05), p25: cuantil(s, 0.25), p50: cuantil(s, 0.50),
    p75: cuantil(s, 0.75), p95: cuantil(s, 0.95), min: s[0], max: s[s.length - 1],
  };
}
function ubicar(real, nulos) {
  const B = nulos.length;
  const menores = nulos.filter((x) => x < real).length;
  const iguales = nulos.filter((x) => x === real).length;
  return {
    percentil: (menores + 0.5 * iguales) / B,
    p1cola: (nulos.filter((x) => x >= real).length + 1) / (B + 1),
    B, real,
  };
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
  const bruto = sim.legs.reduce((s, l) => s + l.bruto, 0);
  const brutoSinCcl = sim.legs.reduce((s, l) => s + l.brutoSinCcl, 0);
  const notional = sim.legs.reduce((s, l) => s + l.entN, 0);
  const fees = sim.legs.reduce((s, l) => s + l.fees[tier], 0);
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, bruto, brutoSinCcl, notional, fees,
    brutoPct: notional > 0 ? bruto / notional : null,
    brutoSinCclPct: notional > 0 ? brutoSinCcl / notional : null,
    cclPct: notional > 0 ? (bruto - brutoSinCcl) / notional : null,
    costoPct: notional > 0 ? fees / notional : null,
    expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    sharpe, maxDDpct: dd * 100, meses,
  };
}

/* ────────────────────── síntesis de series ──────────────────────
 * Una barra sintética i = la barra REAL fuente srcIdx[i] con el cierre
 * reescalado: se conservan o/c, h/c, l/c y el volumen de la barra fuente.
 * Así el marginal del rango intrabarra y del volumen queda intacto y lo
 * único que se aleatoriza es el camino del precio.
 *
 *   rw      → srcIdx[i] = i (geometría en su lugar), retorno ~ N(mu, sd)
 *   boot    → srcIdx = permutación de 1..n-1
 *   bloque5 → srcIdx = permutación de bloques contiguos de 5
 *   nulo    → como boot pero con los retornos centrados (drift 0)
 *   ident   → srcIdx[i] = i y retorno real: reproduce la serie original
 */
function permutar(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
}
function srcDe(tipo, n, rnd) {
  // devuelve src[1..n-1] con el índice REAL del que sale el retorno y la geometría
  const src = new Array(n);
  src[0] = 0;
  if (tipo === "rw" || tipo === "ident") { for (let i = 1; i < n; i++) src[i] = i; return src; }
  if (tipo === "bloque5") {
    const L = 5, idx = [];
    for (let a = 1; a < n; a += L) idx.push(a);
    permutar(idx, rnd);
    let p = 1;
    for (const a of idx) { const fin = Math.min(n - 1, a + L - 1); for (let q = a; q <= fin && p < n; q++) src[p++] = q; }
    while (p < n) src[p++] = p - 1;
    return src;
  }
  const idx = []; for (let i = 1; i < n; i++) idx.push(i);
  permutar(idx, rnd);
  for (let i = 1; i < n; i++) src[i] = idx[i - 1];
  return src;
}
function sintetizarSerie(src0, tipo, rnd, c0 = null) {
  const n = src0.length;
  if (n < 3) return src0.map((b) => ({ ...b }));
  const r = new Array(n).fill(0);
  for (let i = 1; i < n; i++) r[i] = Math.log(src0[i].c / src0[i - 1].c);
  const rr = r.slice(1);
  const mu = mean(rr), sd = stdev(rr);
  const src = srcDe(tipo, n, rnd);
  const out = new Array(n);
  let c = c0 != null ? c0 : src0[0].c;
  const g0 = src0[src[0]];
  out[0] = { ts: src0[0].ts, t: src0[0].t, o: c * (g0.o / g0.c), h: c * (g0.h / g0.c), l: c * (g0.l / g0.c), c, v: g0.v };
  for (let i = 1; i < n; i++) {
    let ri;
    if (tipo === "rw") ri = mu + sd * gauss(rnd);
    else if (tipo === "nulo") ri = r[src[i]] - mu;
    else ri = r[src[i]];
    c = c * Math.exp(ri);
    const g = src0[src[i]];
    out[i] = { ts: src0[i].ts, t: src0[i].t, o: c * (g.o / g.c), h: c * (g.h / g.c), l: c * (g.l / g.c), c, v: g.v };
  }
  return out;
}
function agruparPorDia(H) {
  const out = []; let cur = null;
  for (const b of H) {
    if (!cur || cur.t !== b.t) { cur = { ts: b.ts, t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; out.push(cur); }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
  }
  return out;
}
function sintetizarSimbolo(D, H, tipo, rnd) {
  const t0h = H[0].t;
  const iSplit = D.findIndex((b) => b.t >= t0h);
  const corte = iSplit < 0 ? D.length : iSplit;
  const Dpre = D.slice(0, corte);
  if (Dpre.length < 10) return { D: D.map((b) => ({ ...b })), H: H.map((b) => ({ ...b })) };
  const Dp = sintetizarSerie(Dpre, tipo, rnd);
  // enganche de nivel: se conserva el salto real entre el último cierre diario
  // previo y el primer cierre horario
  const c0 = Dp[Dp.length - 1].c * (H[0].c / Dpre[Dpre.length - 1].c);
  const Hs = sintetizarSerie(H, tipo, rnd, c0);
  const Dov = agruparPorDia(Hs);
  return { D: [...Dp, ...Dov], H: Hs };
}

/* ── CCL sintético: se aleatorizan los retornos diarios del CCL ──
 *   real       → el verdadero
 *   mezcla     → permutación de sus retornos (misma deriva, otro timing)
 *   sinDeriva  → permutación de sus retornos CENTRADOS (misma volatilidad,
 *                deriva cero). Es la versión que responde "¿es carry de
 *                dólar lo que estamos midiendo?"
 */
function cclSintetico(cclReal, dias, modo, rnd) {
  if (modo === "real") return cclReal;
  const v = dias.map((d) => cclReal(d) || 1);
  const r = []; for (let i = 1; i < v.length; i++) r.push(Math.log(v[i] / v[i - 1]));
  let rr = r.slice();
  if (modo === "sinDeriva") { const m = mean(r); rr = r.map((x) => x - m); }
  permutar(rr, rnd);
  const map = new Map(); let c = v[0];
  map.set(dias[0], c);
  for (let i = 1; i < dias.length; i++) { c *= Math.exp(rr[i - 1]); map.set(dias[i], c); }
  return (d) => map.get(d) ?? 1;
}

/* ───────────── una corrida completa de la cañería ───────────── */
const gateBase = (s) => {
  const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
  return g.ok ? { riskMult: g.riskMult } : null;
};
const DIAGS = {
  optimista: { ordenOptimista: true },
  gapStop: { gapStop: true },
  fillCierre: { fillCierre: true },
};

function correrUniverso({ daily, hourly, syms }, cclPorModo, feats = new Map()) {
  const timeline = [...new Set(hourly.SPY.map((b) => b.ts))].sort((a, b) => a - b);
  const regimen = construirRegimen(daily, hourly, timeline);
  const regCount = {};
  for (const v of regimen.values()) regCount[v] = (regCount[v] || 0) + 1;
  const { senales, stats } = generarSenales({ syms, daily, hourly }, regimen, feats);
  const uni = new Set(syms);
  const res = { regCount, stats, nSenalesCrudas: senales.length, ventanas: {} };
  for (const [vn, [d0, d1]] of Object.entries(VENTANAS)) {
    const ctx = construirCtx(hourly, uni, d0, d1);
    const ord = construirOrdenes(senales, uni, d0, d1, gateBase);
    res.ventanas[vn] = { nOrdenes: ord.length, meses: ctx.meses, ccl: {}, diag: {} };
    // diagnósticos mecánicos, siempre con el CCL real (lo que se compara es el Δ)
    for (const [nom, op] of Object.entries(DIAGS)) {
      const s = simular(ord, ctx, cclPorModo.real, op);
      const md = metricas(s, "cocos", ctx.meses);
      res.ventanas[vn].diag[nom] = { n: md.n, mensual: md.mensualPct, brutoPct: md.brutoPct, papelPct: md.brutoSinCclPct };
    }
    for (const [modo, ccl] of Object.entries(cclPorModo)) {
      const sim = simular(ord, ctx, ccl);
      const m = metricas(sim, "cocos", ctx.meses);
      const mg = metricas(sim, "gold", ctx.meses);
      const mb = metricas(sim, "black", ctx.meses);
      res.ventanas[vn].ccl[modo] = {
        n: m.n, mensual: m.mensualPct, total: m.total, brutoPct: m.brutoPct,
        papelPct: m.brutoSinCclPct, cclPct: m.cclPct, costoPct: m.costoPct,
        win: m.winRate, payoff: m.payoff, sharpe: m.sharpe, dd: m.maxDDpct,
        notional: m.notional, mensualGold: mg.mensualPct, mensualBlack: mb.mensualPct,
        fills: sim.trades.length, expiradas: sim.skips.expiradas,
      };
    }
  }
  return res;
}

/* ─────────────────────── worker thread ─────────────────────── */
if (!isMainThread) {
  const { jobs } = workerData;
  const real = cargarTodo(LIMPIOS_38);
  const symsOrd = real.syms.slice().sort();
  const cclReal = loadCcl(DATA);
  const diasAll = (() => {
    const s = new Set();
    for (const sym of symsOrd) for (const b of real.hourly[sym]) s.add(b.t);
    return [...s].sort();
  })();
  const salida = [];
  for (const job of jobs) {
    const rnd = mulberry32(seedDe(job.tipo, job.k));
    const daily = {}, hourly = {};
    for (const sym of symsOrd) {
      const s = sintetizarSimbolo(real.daily[sym], real.hourly[sym], job.tipo, rnd);
      daily[sym] = s.D; hourly[sym] = s.H;
    }
    const rc = mulberry32(seedCcl(job.k));
    const cclPorModo = {
      real: cclReal,
      sinDeriva: cclSintetico(cclReal, diasAll, "sinDeriva", rc),
    };
    const r = correrUniverso({ daily, hourly, syms: symsOrd }, cclPorModo);
    salida.push({ tipo: job.tipo, k: job.k, ...r });
    parentPort.postMessage({ tick: 1 });
  }
  parentPort.postMessage({ done: true, salida });
}

/* ─────────────────────────────── main ─────────────────────────────── */
const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pct = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));

function lanzarWorkers(jobs, nHilos, onTick) {
  const lotes = Array.from({ length: nHilos }, () => []);
  jobs.forEach((j, i) => lotes[i % nHilos].push(j));
  return Promise.all(lotes.filter((l) => l.length).map((lote) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { jobs: lote } });
    w.on("message", (m) => { if (m.tick) onTick(); else if (m.done) { res(m.salida); w.terminate(); } });
    w.on("error", rej);
  }))).then((xs) => xs.flat());
}

async function main() {
  const t0 = Date.now();
  const all = cargarTodo();
  const cclReal = loadCcl(DATA);
  const U38 = new Set(LIMPIOS_38.filter((s) => all.syms.includes(s)));
  const prevCocos = JSON.parse(fs.readFileSync(path.join(DIR, "results-cocos.json"), "utf8"));

  console.log(`placebo.js · universos ${UNIV} por placebo · hilos ${HILOS} · semilla ${SEED}`);
  console.log(`series ${all.syms.length} · U38 ${U38.size} · tipos ${TIPOS.join(", ")} + control ident`);

  const out = {
    generado: new Date().toISOString(), semilla: SEED, universos: UNIV,
    tipos: TIPOS, ventanas: VENTANAS,
    tarifa: { cocos: FEE.cocos, vuelta: FEE.cocos * 2 },
  };

  /* ══════════ 0 · CHEQUEO DE CONSISTENCIA ══════════ */
  console.log(`\n===== 0 · CHEQUEO DE CONSISTENCIA =====`);
  // 0.a — la cañería de este script regenera signals.json EXACTO
  const timelineReal = [...new Set(all.hourly.SPY.map((b) => b.ts))].sort((a, b) => a - b);
  const regReal = construirRegimen(all.daily, all.hourly, timelineReal);
  const featsReal = featuresSpy();
  const { senales: senMias, stats: stMias } = generarSenales(all, regReal, featsReal);
  const cacheado = JSON.parse(fs.readFileSync(path.join(DIR, "signals.json"), "utf8"));
  const huella = (arr) => {
    let h = 2166136261 >>> 0;
    for (const s of arr) {
      const str = `${s.sym}|${s.ts}|${s.entry.toExponential(12)}|${s.stop.toExponential(12)}|${s.target.toExponential(12)}|${s.score}|${s.rr}|${s.ct}|${s.regime}`;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return h.toString(16);
  };
  const hMias = huella(senMias), hCache = huella(cacheado.senales);
  const okSen = senMias.length === cacheado.senales.length && hMias === hCache;
  console.log(`  0.a señales regeneradas ${senMias.length} vs cache ${cacheado.senales.length} · huella ${hMias} vs ${hCache} → ${okSen ? "IDÉNTICAS" : "DISTINTAS"}`);
  out.chequeo = { senalesMias: senMias.length, senalesCache: cacheado.senales.length, huellaMia: hMias, huellaCache: hCache, okSenales: okSen, stats: stMias };

  // 0.b — el caso base con Cocos reproduce +0,26 / +0,32
  const REAL = {};
  let okBase = true;
  for (const [vn, [d0, d1]] of Object.entries(VENTANAS)) {
    const ctx = construirCtx(all.hourly, U38, d0, d1);
    const ord = construirOrdenes(senMias, U38, d0, d1, gateBase);
    const sim = simular(ord, ctx, cclReal);
    const m = metricas(sim, "cocos", ctx.meses);
    const ref = prevCocos.A[vn].cocos;
    const dMensual = Math.abs(m.mensualPct - ref.mensual), dN = Math.abs(m.n - ref.n), dTot = Math.abs(m.total - ref.total);
    const ok = dMensual < 1e-9 && dN === 0 && dTot < 1e-6;
    if (!ok) okBase = false;
    REAL[vn] = { ctx, ord, sim, m };
    console.log(`  0.b ${vn}: n ${m.n} (ref ${ref.n}) · mensual Cocos ${n2(m.mensualPct, 4)}% (ref ${n2(ref.mensual, 4)}%) · bruto ${pct(m.brutoPct, 3)} · papel ${pct(m.brutoSinCclPct, 3)} · CCL ${pct(m.cclPct, 3)} → ${ok ? "OK" : "DESCUADRE"}`);
    out.chequeo[`base_${vn}`] = { n: m.n, mensual: m.mensualPct, ref: ref.mensual, delta: dMensual, brutoPct: m.brutoPct, papelPct: m.brutoSinCclPct, cclPct: m.cclPct };
  }
  out.chequeo.okBase = okBase;
  if (!okSen || !okBase) {
    console.log(`\n*** ABORTA: el chequeo de consistencia no pasa. No se sigue. ***`);
    fs.writeFileSync(path.join(DIR, "results-placebo.json"), JSON.stringify(out, null, 1));
    return;
  }
  console.log(`  chequeo de consistencia: PASA (señales idénticas y +0,26 / +0,32 reproducidos).`);
  if (SOLO_CHK) { fs.writeFileSync(path.join(DIR, "results-placebo.json"), JSON.stringify(out, null, 1)); return; }

  /* ══════════ 0.c · CONTROL "IDENT": cuánto distorsiona la construcción ══════════ */
  console.log(`\n===== 0.c · CONTROL de construcción (ident: permutación identidad) =====`);
  const IDENT = {};
  {
    const rnd = mulberry32(SEED);
    const symsOrd = [...U38].sort();
    const daily = {}, hourly = {};
    for (const sym of symsOrd) {
      const s = sintetizarSimbolo(all.daily[sym], all.hourly[sym], "ident", rnd);
      daily[sym] = s.D; hourly[sym] = s.H;
    }
    const timeline = [...new Set(hourly.SPY.map((b) => b.ts))].sort((a, b) => a - b);
    const regimen = construirRegimen(daily, hourly, timeline);
    const { senales } = generarSenales({ syms: symsOrd, daily, hourly }, regimen, new Map());
    const uni = new Set(symsOrd);
    out.ident = { nSenalesCrudas: senales.length, ventanas: {} };
    for (const [vn, [d0, d1]] of Object.entries(VENTANAS)) {
      const ctx = construirCtx(hourly, uni, d0, d1);
      const ord = construirOrdenes(senales, uni, d0, d1, gateBase);
      const sim = simular(ord, ctx, cclReal);
      const m = metricas(sim, "cocos", ctx.meses);
      IDENT[vn] = { ctx, ord, m };
      out.ident.ventanas[vn] = { nOrdenes: ord.length, n: m.n, mensual: m.mensualPct, brutoPct: m.brutoPct, papelPct: m.brutoSinCclPct, cclPct: m.cclPct };
      console.log(`  ${vn}: señales ${ord.length} (real ${REAL[vn].ord.length}) · trades ${m.n} (real ${REAL[vn].m.n}) · mensual ${n2(m.mensualPct, 3)}% (real ${n2(REAL[vn].m.mensualPct, 3)}%) · bruto ${pct(m.brutoPct, 3)} (real ${pct(REAL[vn].m.brutoPct, 3)}) · papel ${pct(m.brutoSinCclPct, 3)} (real ${pct(REAL[vn].m.brutoSinCclPct, 3)})`);
    }
    console.log(`  → la diferencia es el artefacto de la construcción (la diaria del tramo horario se arma agregando las barras de 60'), y es la referencia correcta contra la que se comparan los placebos.`);
  }

  /* ══════════ 0.d · DIAGNÓSTICOS MECÁNICOS SOBRE LA SERIE REAL ══════════ */
  console.log(`\n===== 0.d · DIAGNÓSTICOS mecánicos sobre los datos REALES (Cocos) =====`);
  out.diagReal = {};
  for (const vn of ["IS", "OOS"]) {
    out.diagReal[vn] = { base: { n: REAL[vn].m.n, mensual: REAL[vn].m.mensualPct, brutoPct: REAL[vn].m.brutoPct, papelPct: REAL[vn].m.brutoSinCclPct } };
    const linea = [];
    for (const [nom, op] of Object.entries(DIAGS)) {
      const s = simular(REAL[vn].ord, REAL[vn].ctx, cclReal, op);
      const md = metricas(s, "cocos", REAL[vn].ctx.meses);
      out.diagReal[vn][nom] = { n: md.n, mensual: md.mensualPct, brutoPct: md.brutoPct, papelPct: md.brutoSinCclPct };
      linea.push(`${nom} ${n2(md.mensualPct, 3)}% (Δ ${n2(md.mensualPct - REAL[vn].m.mensualPct, 3)})`);
    }
    console.log(`  ${vn}: base ${n2(REAL[vn].m.mensualPct, 3)}% · ${linea.join(" · ")}`);
  }

  /* ══════════ 1 · EL REAL BAJO CCL ALEATORIZADO ══════════ */
  console.log(`\n===== 1 · EL RESULTADO REAL bajo ${UNIV} sorteos de CCL sin deriva =====`);
  const diasAll = (() => {
    const s = new Set();
    for (const sym of U38) for (const b of all.hourly[sym]) s.add(b.t);
    return [...s].sort();
  })();
  const realSinDeriva = { IS: [], OOS: [] }, identSinDeriva = { IS: [], OOS: [] };
  for (let k = 0; k < UNIV; k++) {
    const rc = mulberry32(seedCcl(k));
    const ccl = cclSintetico(cclReal, diasAll, "sinDeriva", rc);
    for (const vn of ["IS", "OOS"]) {
      const sim = simular(REAL[vn].ord, REAL[vn].ctx, ccl);
      const m = metricas(sim, "cocos", REAL[vn].ctx.meses);
      realSinDeriva[vn].push({ mensual: m.mensualPct, brutoPct: m.brutoPct, papelPct: m.brutoSinCclPct, cclPct: m.cclPct, n: m.n });
      const si = simular(IDENT[vn].ord, IDENT[vn].ctx, ccl);
      const mi = metricas(si, "cocos", IDENT[vn].ctx.meses);
      identSinDeriva[vn].push({ mensual: mi.mensualPct, brutoPct: mi.brutoPct, papelPct: mi.brutoSinCclPct });
    }
  }
  out.realSinDeriva = {}; out.identSinDeriva = {};
  for (const vn of ["IS", "OOS"]) {
    const v = realSinDeriva[vn].map((x) => x.mensual);
    const rs = resumen(v);
    const vi = identSinDeriva[vn].map((x) => x.mensual);
    out.realSinDeriva[vn] = { resumen: rs, brutoPct: resumen(realSinDeriva[vn].map((x) => x.brutoPct)), valores: v };
    out.identSinDeriva[vn] = { resumen: resumen(vi), brutoPct: resumen(identSinDeriva[vn].map((x) => x.brutoPct)), valores: vi };
    console.log(`  ${vn}: real con CCL sin deriva → mensual media ${n2(rs.media, 3)}% (sd ${n2(rs.sd, 3)}) · p05 ${n2(rs.p05, 3)} · p50 ${n2(rs.p50, 3)} · p95 ${n2(rs.p95, 3)}  [con CCL real: ${n2(REAL[vn].m.mensualPct, 3)}%]`);
    console.log(`  ${vn}: ident con CCL sin deriva → mensual media ${n2(mean(vi), 3)}%  [con CCL real: ${n2(IDENT[vn].m.mensualPct, 3)}%]`);
  }

  /* ══════════ 2 · LOS PLACEBOS ══════════ */
  const jobs = [];
  for (const tipo of TIPOS) for (let k = 0; k < UNIV; k++) jobs.push({ tipo, k });
  console.log(`\n===== 2 · ${jobs.length} universos sintéticos (${TIPOS.length} placebos x ${UNIV}) en ${HILOS} hilos =====`);
  let hechos = 0;
  const tick = () => {
    hechos++;
    if (hechos % 10 === 0 || hechos === jobs.length) {
      const seg = (Date.now() - t0) / 1000;
      process.stdout.write(`\r   ${hechos}/${jobs.length} universos · ${seg.toFixed(0)}s · eta ${((seg / hechos) * (jobs.length - hechos)).toFixed(0)}s     `);
    }
  };
  const res = await lanzarWorkers(jobs, HILOS, tick);
  console.log("");

  /* ══════════ 3 · DISTRIBUCIONES Y UBICACIÓN DEL REAL ══════════ */
  out.placebos = {};
  const MODOS = ["real", "sinDeriva"];
  for (const tipo of TIPOS) {
    const univ = res.filter((r) => r.tipo === tipo).sort((a, b) => a.k - b.k);
    out.placebos[tipo] = { n: univ.length, ventanas: {} };
    console.log(`\n───── placebo "${tipo}" · ${univ.length} universos ─────`);
    for (const vn of ["IS", "OOS"]) {
      const rec = { nOrdenes: resumen(univ.map((u) => u.ventanas[vn].nOrdenes)), nSenalesCrudas: resumen(univ.map((u) => u.nSenalesCrudas)), ccl: {} };
      for (const modo of MODOS) {
        const g = (f) => univ.map((u) => f(u.ventanas[vn].ccl[modo])).filter((x) => x != null && Number.isFinite(x));
        const mens = g((x) => x.mensual);
        const brut = g((x) => x.brutoPct);
        const pap = g((x) => x.papelPct);
        const nTr = g((x) => x.n);
        const realVal = modo === "real" ? REAL[vn].m.mensualPct : mean(realSinDeriva[vn].map((x) => x.mensual));
        const realBruto = modo === "real" ? REAL[vn].m.brutoPct : mean(realSinDeriva[vn].map((x) => x.brutoPct));
        const identVal = modo === "real" ? IDENT[vn].m.mensualPct : mean(identSinDeriva[vn].map((x) => x.mensual));
        const identBruto = modo === "real" ? IDENT[vn].m.brutoPct : mean(identSinDeriva[vn].map((x) => x.brutoPct));
        const ub = ubicar(realVal, mens), ubB = ubicar(realBruto, brut);
        const ubI = ubicar(identVal, mens), ubIB = ubicar(identBruto, brut);
        // p-valor pareado cuando el CCL es sorteado: mismo sorteo k para real y placebo
        let pPar = null;
        if (modo === "sinDeriva") {
          const pares = univ.map((u) => (u.ventanas[vn].ccl[modo].mensual >= identSinDeriva[vn][u.k].mensual ? 1 : 0));
          pPar = (pares.reduce((s, x) => s + x, 0) + 1) / (pares.length + 1);
        }
        rec.ccl[modo] = {
          mensual: resumen(mens), bruto: resumen(brut), papel: resumen(pap), nTrades: resumen(nTr),
          real: realVal, realBruto, percentil: ub.percentil, p: ub.p1cola,
          percentilBruto: ubB.percentil, pBruto: ubB.p1cola,
          ident: identVal, identBruto, percentilIdent: ubI.percentil, pIdent: ubI.p1cola,
          percentilIdentBruto: ubIB.percentil, pIdentBruto: ubIB.p1cola, pPareado: pPar,
        };
        const r = rec.ccl[modo];
        const sp = " ".repeat(vn.length + modo.length + 5);
        console.log(`  [${vn}/${modo.padEnd(9)}] mensual placebo: media ${n2(r.mensual.media, 3)}% sd ${n2(r.mensual.sd, 3)} · p05 ${n2(r.mensual.p05, 3)} p25 ${n2(r.mensual.p25, 3)} p50 ${n2(r.mensual.p50, 3)} p75 ${n2(r.mensual.p75, 3)} p95 ${n2(r.mensual.p95, 3)}`);
        console.log(`  ${sp}  REAL ${n2(realVal, 3)}% → pct ${n2(r.percentil * 100, 1)} · p = ${n2(r.p, 4)}   |   IDENT ${n2(identVal, 3)}% → pct ${n2(r.percentilIdent * 100, 1)} · p = ${n2(r.pIdent, 4)}${pPar != null ? ` · p pareado ${n2(pPar, 4)}` : ""}`);
        console.log(`  ${sp}  bruto/op placebo media ${pct(r.bruto.media, 3)} (p05 ${pct(r.bruto.p05, 3)} p95 ${pct(r.bruto.p95, 3)}) · papel ${pct(r.papel.media, 3)} · REAL ${pct(realBruto, 3)} pct ${n2(r.percentilBruto * 100, 1)} · IDENT ${pct(identBruto, 3)} pct ${n2(r.percentilIdentBruto * 100, 1)} p = ${n2(r.pIdentBruto, 4)}`);
        console.log(`  ${sp}  señales que pasan el gate ${n2(rec.nOrdenes.media, 0)} (real ${REAL[vn].ord.length} · ident ${IDENT[vn].ord.length}) · trades ${n2(r.nTrades.media, 1)} (real ${REAL[vn].m.n} · ident ${IDENT[vn].m.n})`);
      }
      // diagnósticos: cuánto mueve cada sospechoso al placebo (Δ contra su propia base)
      rec.diag = {};
      const baseMens = univ.map((u) => u.ventanas[vn].ccl.real.mensual);
      const basePapel = univ.map((u) => u.ventanas[vn].ccl.real.papelPct);
      for (const nom of Object.keys(DIAGS)) {
        const dM = univ.map((u, i) => u.ventanas[vn].diag[nom].mensual - baseMens[i]);
        const dP = univ.map((u, i) => u.ventanas[vn].diag[nom].papelPct - basePapel[i]);
        rec.diag[nom] = { deltaMensual: resumen(dM), deltaPapel: resumen(dP), nivel: resumen(univ.map((u) => u.ventanas[vn].diag[nom].mensual)) };
        console.log(`  [${vn}/diag ${nom.padEnd(10)}] Δ mensual media ${n2(rec.diag[nom].deltaMensual.media, 3)} pp (p05 ${n2(rec.diag[nom].deltaMensual.p05, 3)} · p95 ${n2(rec.diag[nom].deltaMensual.p95, 3)}) · Δ papel/op ${pct(rec.diag[nom].deltaPapel.media, 3)}`);
      }
      out.placebos[tipo].ventanas[vn] = rec;
    }
  }

  out.detalle = res.map((r) => ({
    tipo: r.tipo, k: r.k, nSenalesCrudas: r.nSenalesCrudas, regCount: r.regCount,
    IS: r.ventanas.IS, OOS: r.ventanas.OOS,
  }));

  /* ── huella de reproducibilidad ── */
  const digest = (() => {
    const nums = [];
    const walk = (o) => {
      if (o == null) return;
      if (typeof o === "number") { nums.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { if (k === "generado") continue; walk(o[k]); } }
    };
    walk({ chequeo: out.chequeo, ident: out.ident, realSinDeriva: out.realSinDeriva, placebos: out.placebos });
    let h = 2166136261 >>> 0;
    for (const v of nums) {
      const s = Number.isFinite(v) ? v.toExponential(12) : String(v);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { nNumeros: nums.length, fnv1a: h.toString(16) };
  })();
  out.digest = digest;
  console.log(`\nhuella de reproducibilidad: ${digest.nNumeros} números · FNV-1a ${digest.fnv1a}`);
  fs.writeFileSync(path.join(DIR, "results-placebo.json"), JSON.stringify(out, null, 1));
  console.log(`results-placebo.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (isMainThread) main();
