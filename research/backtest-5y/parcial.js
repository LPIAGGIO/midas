#!/usr/bin/env node
/* parcial.js — ¿dónde conviene disparar el TP parcial con entrada A MERCADO?
 *
 * El motor vende la mitad de la posición cuando el precio recorre el 50% del
 * camino hacia el target (TP_PARCIAL_FRAC_CAMINO = 0,5 en el worker). Ese
 * parámetro se congeló cuando la entrada era una orden límite EN el soporte.
 * `INFORME-AGRESIVIDAD.md` cambió la entrada: la configuración elegida por
 * walk-forward entra A MERCADO en la apertura de la barra siguiente, con
 * stop/target móviles con la entrada, 30% por posición y sin apalancamiento.
 * Con esa entrada, "la mitad del camino" cae en otro lugar y el parcial
 * protege distinto.
 *
 * Bloques:
 *   0 · chequeo de consistencia (la celda 50%/50% tiene que reproducir el
 *       +2,23% / +2,44% de INFORME-AGRESIVIDAD, y la celda base de todo el
 *       proyecto tiene que seguir reproduciendo results.json / results-cocos)
 *   A · la guarda del breakeven: ¿es redundante por construcción?
 *   B · la grilla punto de disparo × fracción vendida, CON guarda
 *   C · la misma grilla SIN guarda, y el delta
 *   D · el intercambio retorno / drawdown y el efecto sobre la cola derecha
 *   E · walk-forward estricto (elección mirando SÓLO el IS) + benchmark SPY
 *   F · modelos nulos de la celda ganadora
 *   G · DSR con el N actualizado (venía en 324)
 *
 * Reusa engine.js y el cache signals.json. No toca el VPS ni Supabase.
 * Semilla 20260917. ESM.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadSeries, loadCcl, gatePasa } from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = process.argv.slice(2);
const argN = (k, d) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };
const DRAWS = argN("draws", 5000);
const SIN_NULO = ARGS.includes("--sinNulo");
const SEED = 20260917;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── constantes: IDÉNTICAS a simulate.js / cocos.js / agresividad.js ── */
const CAPITAL = 7_000_000;
const RISK = 0.015;
const MAX_POS = 5;
const MAX_DIA = 5;
const CAP_PCT = 0.20;
const VENTANA_H = 48;
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;
const FEE = {
  gold: (0.005 * IVA) + DERECHOS,
  platinum: (0.003 * IVA) + DERECHOS,
  black: (0.001 * IVA) + DERECHOS,
  cocos: 0.0005 * IVA,
};
const TIERS = ["gold", "platinum", "black", "cocos"];

const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";
const VENTANAS = { IS: [IS_DESDE, IS_HASTA], OOS: [OOS_DESDE, OOS_HASTA] };

const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TRUNCA_DAILY = { OKLO: "2024-05-10", RGTI: "2022-03-01", SATL: "2022-01-01", KEEL: "2026-04-06", LAR: "2025-01-27" };

const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/* ── las dos variantes de entrada que se usan acá ── */
const V_NIVEL = { id: "nivel", k: 0, modo: "lim", desc: "en el nivel exacto (base de todo el proyecto)" };
const V_MKTO = { id: "mkt-open", k: null, modo: "mktO", desc: "a mercado, apertura de la barra siguiente" };

/* ── LA CONFIGURACIÓN ELEGIDA POR INFORME-AGRESIVIDAD §8 ──
 * a mercado en la apertura de la barra siguiente · stop/target móviles con la
 * entrada · 30% por posición · 5 posiciones · sin apalancamiento. */
const ELE = { variante: V_MKTO, conv: "movil", capPct: 0.30, maxPos: MAX_POS, maxGross: 1 };
const SPREAD_CAL = 0.0025;   // horquilla media ponderada medida en cedear_fv_log

/* ── los ejes del barrido ──
 *  punto de disparo: seis anclados al CAMINO (fracción del trayecto entrada →
 *  target) y tres anclados al BREAKEVEN (precio de entrada + costos de ida y
 *  vuelta, más un colchón).
 *  fracción vendida: qué parte de la posición se suelta en el parcial. */
const PUNTOS = [
  { id: "sin", modo: "ninguno", val: null, etq: "sin parcial" },
  { id: "c25", modo: "camino", val: 0.25, etq: "25% del camino" },
  { id: "c40", modo: "camino", val: 0.40, etq: "40% del camino" },
  { id: "c50", modo: "camino", val: 0.50, etq: "50% del camino (ACTUAL)" },
  { id: "c60", modo: "camino", val: 0.60, etq: "60% del camino" },
  { id: "c75", modo: "camino", val: 0.75, etq: "75% del camino" },
  { id: "be05", modo: "be", val: 0.005, etq: "breakeven + 0,5%" },
  { id: "be10", modo: "be", val: 0.010, etq: "breakeven + 1,0%" },
  { id: "be20", modo: "be", val: 0.020, etq: "breakeven + 2,0%" },
];
const FRACS = [0.25, 0.50, 0.75];

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

/* ────────────────── ctx / órdenes / simulador ────────────────── */
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

function construirOrdenes(senales, universo, desde, hasta, filtro) {
  const out = [];
  for (const s of senales) {
    if (!universo.has(s.sym)) continue;
    if (s.dia < desde || s.dia > hasta) continue;
    const f = filtro(s);
    if (!f) continue;
    out.push({
      ...s, riskMult: f.riskMult ?? 1,
      stopRel: (s.entry - s.stop) / s.entry,
      tgtRel: (s.target - s.entry) / s.entry,
      created: s.ts * 1000 + 1,
    });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}

/* El simulador. Copia literal del de agresividad.js (que es el de cocos.js, que
 * es el de simulate.js) con TRES perillas nuevas y NADA más:
 *   tpModo   · "ninguno" | "camino" | "be"
 *   tpVal    · fracción del camino (modo camino) o colchón sobre el breakeven
 *              (modo be)
 *   tpFrac   · qué fracción de la posición se vende en el parcial (0,5 = la
 *              mitad, que es lo que hace el worker hoy)
 *   guardaBE · si true, el parcial NUNCA se ejecuta por debajo del breakeven:
 *              el disparo se sube al precio de breakeven cuando cae abajo.
 *   tpU      · (sólo para el modelo nulo) array indexado por orden con la
 *              fracción del camino sorteada para cada trade.
 *
 * El breakeven se calcula con la tarifa COCOS (la de referencia del informe) y
 * con el spread efectivamente modelado en la corrida:
 *   bePx = entryPx · (1 + fee + halfSp·cruza) / (1 − fee − halfSp)
 * o sea el precio al que la venta de esa pata empata exactamente los costos de
 * ida y vuelta. Se ignora el arrastre del CCL a propósito: el disparo es un
 * precio que se pone por adelantado sobre el papel, no una cuenta en pesos.
 */
function simular(ordenes, ctx, ccl, opts = {}) {
  const {
    variante = V_NIVEL, conv = "fijo", capPct = CAP_PCT, maxPos = MAX_POS,
    maxGross = 1, spread = 0, light = false, soloIdx = null,
    tpModo = "camino", tpVal = 0.5, tpFrac = 0.5, guardaBE = false, tpU = null,
  } = opts;
  const { barAt, timeline, tFin, bars } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const halfSp = spread / 2;
  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const skips = { openSym: 0, dupPend: 0, posMax: 0, entradasDia: 0, qtyCero: 0, reemplazadas: 0, expiradas: 0, sinFill: 0, sinBarras: 0, sinSpot: 0, degenerada: 0, filtrada: 0 };
  const entradasDia = new Map();
  const realized = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const equity = [];
  let oi = 0, colocadas = 0, cruzadas = 0, maxBruto = 0, maxComp = 0;

  const comprometido = () => {
    let s = 0;
    for (const p of pend.values()) s += p.notional;
    for (const p of open.values()) s += p.notional;
    return s;
  };
  const brutoAbierto = () => {
    let s = 0;
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
    const slip = outN * halfSp + (pos.cruza ? entN * halfSp : 0);
    const leg = {
      sym: pos.sym, qty, reason, entryTs: pos.entryTs, exitTs: ts, entryPx: pos.entryPx, exitPx: px,
      entN, bruto: outN - entN, brutoSinCcl: qty * (px - pos.entryPx) * pos.rIn, pnl: {}, fees: {},
    };
    for (const tier of TIERS) {
      const f = feeLeg(entN, tier, false) + feeLeg(outN, tier, intradia) + slip;
      leg.fees[tier] = f;
      leg.pnl[tier] = outN - entN - f;
      realized[tier] += leg.pnl[tier];
    }
    legs.push(leg); pos.legs.push(leg);
  };

  for (const t of timeline) {
    /* 1) llegan las señales */
    while (oi < ordenes.length && ordenes[oi].created <= t) {
      const o = ordenes[oi++];
      if (soloIdx && !soloIdx.has(o._i)) { skips.filtrada++; continue; }
      if (!barAt[o.sym]) { skips.sinBarras++; continue; }
      if (open.has(o.sym)) { skips.openSym++; continue; }
      const prev = pend.get(o.sym);
      if (prev && Math.abs(prev.entry - o.entry) / o.entry < 0.005) { skips.dupPend++; continue; }
      if (prev) { pend.delete(o.sym); skips.reemplazadas++; }
      if (pend.size + open.size >= maxPos) { skips.posMax++; continue; }
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) { skips.entradasDia++; continue; }

      const barSig = barAt[o.sym].get(o.ts * 1000);
      const spotSig = barSig ? barSig.c : null;
      let pxRef, modo = variante.modo, cruza = false;
      if (variante.modo === "lim") {
        pxRef = o.entry * (1 + variante.k);
        if (spotSig != null && pxRef >= spotSig) { pxRef = spotSig; modo = "mktC"; cruza = true; }
      } else if (variante.modo === "mktC") {
        if (spotSig == null) { skips.sinSpot++; continue; }
        pxRef = spotSig; cruza = true;
      } else {
        if (spotSig == null) { skips.sinSpot++; continue; }
        pxRef = spotSig; cruza = true;
      }

      const stopPx = conv === "movil" ? pxRef * (1 - o.stopRel) : o.stop;
      const tgtPx = conv === "movil" ? pxRef * (1 + o.tgtRel) : o.target;
      if (!(stopPx > 0 && stopPx < pxRef && tgtPx > pxRef)) { skips.degenerada++; continue; }

      const rIn = rArs(d);
      const riesgoU = (pxRef - stopPx) * rIn;
      if (!(riesgoU > 0)) { skips.qtyCero++; continue; }
      let qty = (CAPITAL * RISK * o.riskMult) / riesgoU;
      qty = Math.min(qty, (CAPITAL * capPct) / (pxRef * rIn));
      qty = Math.min(qty, Math.max(0, CAPITAL * maxGross - comprometido()) / (pxRef * rIn));
      if (!(qty > 0)) { skips.qtyCero++; continue; }
      entradasDia.set(d, (entradasDia.get(d) || 0) + 1);
      colocadas++;
      if (cruza) cruzadas++;
      pend.set(o.sym, { ...o, qty, rIn, pxRef, stopPx, tgtPx, modo, cruza, notional: qty * pxRef * rIn });
    }

    /* 2) pendientes: expiración y fill */
    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); skips.expiradas++; continue; }
      const b = barAt[sym].get(t);
      if (!b) continue;
      let fillPx = null, entryTs = t, juzgarFill = false;
      if (p.modo === "lim") {
        if (b.l <= p.pxRef) fillPx = p.pxRef;
      } else if (p.modo === "mktC") {
        fillPx = p.pxRef; entryTs = p.ts * 1000; juzgarFill = true;
      } else {
        fillPx = b.o; entryTs = t; juzgarFill = true;
      }
      if (fillPx == null) continue;
      pend.delete(sym);
      const stopPx = conv === "movil" ? fillPx * (1 - p.stopRel) : p.stopPx;
      const tgtPx = conv === "movil" ? fillPx * (1 + p.tgtRel) : p.tgtPx;
      if (!(stopPx > 0 && stopPx < fillPx && tgtPx > fillPx)) { skips.degenerada++; continue; }

      /* ── el kit del TP parcial, fijado en el momento del fill ── */
      const bePx = fillPx * (1 + FEE.cocos + (p.cruza ? halfSp : 0)) / (1 - FEE.cocos - halfSp);
      let tpCrudo = null;
      if (tpU) tpCrudo = fillPx + tpU[p._i] * (tgtPx - fillPx);
      else if (tpModo === "camino") tpCrudo = fillPx + tpVal * (tgtPx - fillPx);
      else if (tpModo === "be") tpCrudo = bePx * (1 + tpVal);
      let tpNivel = tpCrudo;
      const bajoBE = tpCrudo != null && tpCrudo < bePx;
      let subido = false;
      if (tpNivel != null && guardaBE && bajoBE) { tpNivel = bePx; subido = true; }
      // un disparo por encima (o justo en) el target no es un parcial: la
      // posición sale entera por target. Se apaga y se cuenta aparte.
      const sobreTgt = tpNivel != null && tpNivel >= tgtPx;
      if (sobreTgt) tpNivel = null;

      const pos = {
        sym: p.sym, qty: p.qty, qty0: p.qty, entryPx: fillPx, entryTs, rIn: p.rIn,
        stop: stopPx, stopIni: stopPx, target: tgtPx, R: fillPx - stopPx,
        notional: p.qty * fillPx * p.rIn, legs: [], tpDone: false, barras: 0, juzgarFill,
        cruza: p.cruza, nivel: p.entry, premio: fillPx / p.entry - 1,
        tocoNivel: false, score: p.score, rr: p.rr, regime: p.regime, dia: p.dia, _i: p._i,
        bePx, tpCrudo, tpNivel, tpBajoBE: bajoBE, tpSubido: subido, tpSobreTgt: sobreTgt,
        tgtRel: (tgtPx - fillPx) / fillPx, stopRel: (fillPx - stopPx) / fillPx,
      };
      if (b.l <= p.entry) pos.tocoNivel = true;
      open.set(sym, pos); trades.push(pos);
    }

    /* 3) abiertas: stop → target → TP parcial → trailing (el mismo orden del worker) */
    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs && !pos.juzgarFill) continue;
      pos.barras++;
      const hi = b.h, lo = b.l;
      if (lo <= pos.nivel) pos.tocoNivel = true;
      if (lo <= pos.stop) {
        cerrarPata(pos, pos.qty, pos.stop, t, pos.stop > pos.stopIni ? "trailing" : "stop");
        open.delete(sym); continue;
      }
      if (tpFrac > 0 && pos.tpNivel != null && !pos.tpDone) {
        if (hi >= pos.tpNivel) {
          const q = pos.qty * tpFrac;
          cerrarPata(pos, q, Math.min(pos.tpNivel, pos.target), t, "tp_parcial");
          pos.qty -= q; pos.notional = pos.qty * pos.entryPx * pos.rIn; pos.tpDone = true;
          pos.tpTs = t;
        }
      }
      if (hi >= pos.target) {
        cerrarPata(pos, pos.qty, pos.target, t, "target");
        open.delete(sym); continue;
      }
      const k = Math.floor((hi - pos.entryPx) / pos.R);
      if (k >= 2 && pos.entryPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (k - 2) * pos.R;
    }

    /* 4) exposición y equity */
    const gb = brutoAbierto(), gc = comprometido();
    if (gb > maxBruto) maxBruto = gb;
    if (gc > maxComp) maxComp = gc;
    if (!light) {
      const d = dia(t / 1000);
      let unreal = 0;
      for (const [sym, pos] of open) {
        const b = barAt[sym].get(t);
        unreal += pos.qty * ((b ? b.c : pos.entryPx) - pos.entryPx) * pos.rIn;
      }
      const row = { dia: d, bruto: gb, comp: gc, eq: {} };
      for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
      if (equity.length && equity[equity.length - 1].dia === d) {
        row.bruto = Math.max(row.bruto, equity[equity.length - 1].bruto);
        row.comp = Math.max(row.comp, equity[equity.length - 1].comp);
        equity[equity.length - 1] = row;
      } else equity.push(row);
    }
  }

  skips.sinFill += pend.size;
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || bars[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    cerrarPata(pos, pos.qty, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (!light && equity.length) {
    const last = equity[equity.length - 1];
    for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier];
  }
  return {
    trades, legs, skips, equity, realized, nSenales: ordenes.length, colocadas, cruzadas,
    maxBruto, maxComp,
  };
}

/* ─────────────────────────── estadística ─────────────────────────── */
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function quantile(a, q) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1)))); return s[i]; }
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function normInv(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/* clasificación de caminos de salida por trade */
function caminosDe(trades) {
  const c = {
    "parcial→target": 0, "parcial→trailing": 0, "parcial→stop": 0, "parcial→fin": 0,
    "seco→target": 0, "seco→trailing": 0, "seco→stop": 0, "seco→fin": 0,
  };
  for (const t of trades) {
    const last = t.legs[t.legs.length - 1];
    if (!last) continue;
    const r = last.reason === "fin_ventana" ? "fin" : last.reason;
    const k = `${t.tpDone ? "parcial" : "seco"}→${r}`;
    if (c[k] != null) c[k]++;
  }
  return c;
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
  const expoDia = sim.equity.map((e) => e.bruto / CAPITAL);
  const apalDia = sim.equity.map((e) => Math.max(0, e.bruto - CAPITAL) / CAPITAL);
  const apalMedia = apalDia.length ? mean(apalDia) : 0;
  /* la cola derecha: cuánto del resultado lo hacen los mejores trades */
  const ord = [...porTrade].sort((a, b) => b - a);
  const top10 = ord.slice(0, Math.max(1, Math.round(n * 0.10)));
  const sumaTop10 = top10.reduce((s, x) => s + x, 0);
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, bruto, brutoSinCcl, notional, fees,
    brutoPct: notional > 0 ? bruto / notional : null,
    costoPct: notional > 0 ? fees / notional : null,
    netoPct: notional > 0 ? (bruto - fees) / notional : null,
    expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    opsMes: n / Math.max(meses, 1e-9),
    tamMedio: n ? notional / n / CAPITAL : null,
    llenado: sim.nSenales ? n / sim.nSenales : null,
    expoMax: sim.maxBruto / CAPITAL, expoMedia: expoDia.length ? mean(expoDia) : 0,
    apalMedia, sharpe, maxDDpct: dd * 100, srDiario: sd > 0 ? m / sd : null, rets, meses,
    nSenales: sim.nSenales, colocadas: sim.colocadas, skips: sim.skips,
    /* específicas del parcial */
    nParcial: sim.trades.filter((t) => t.tpDone).length,
    nBajoBE: sim.trades.filter((t) => t.tpBajoBE).length,
    nSubido: sim.trades.filter((t) => t.tpSubido).length,
    nSobreTgt: sim.trades.filter((t) => t.tpSobreTgt).length,
    caminos: caminosDe(sim.trades),
    /* cola derecha */
    pnlMax: n ? ord[0] : null, pnlP90: quantile(porTrade, 0.90), pnlP10: quantile(porTrade, 0.10),
    sdTrade: stdev(porTrade), shareTop10: total !== 0 ? sumaTop10 / total : null, sumaTop10,
    porTrade,
  };
}
function dsr(rets, srDiario, sigmaSR, N) {
  if (!rets || rets.length < 20 || srDiario == null || !(sigmaSR > 0) || !(N > 1)) return null;
  const n = rets.length, m = mean(rets), sd = stdev(rets);
  const g3 = mean(rets.map((r) => ((r - m) / sd) ** 3));
  const g4 = mean(rets.map((r) => ((r - m) / sd) ** 4));
  const gamma = 0.5772156649;
  const sr0 = sigmaSR * ((1 - gamma) * normInv(1 - 1 / N) + gamma * normInv(1 - 1 / (N * Math.E)));
  const den = Math.sqrt(Math.max(1e-12, 1 - g3 * srDiario + ((g4 - 1) / 4) * srDiario ** 2));
  return { sr0, dsr: normCdf(((srDiario - sr0) * Math.sqrt(n - 1)) / den), g3, g4 };
}
function ubicar(real, nulos) {
  const B = nulos.length;
  const menores = nulos.filter((x) => x < real).length;
  const iguales = nulos.filter((x) => x === real).length;
  const s = [...nulos].sort((x, y) => x - y);
  return {
    percentil: (menores + 0.5 * iguales) / B, p1cola: (nulos.filter((x) => x >= real).length + 1) / (B + 1), B,
    med: s[Math.floor(B / 2)], p05: s[Math.floor(B * 0.05)], p95: s[Math.floor(B * 0.95)],
    mediaNulo: mean(nulos), sdNulo: stdev(nulos), real,
  };
}
function sorteoK(idx, N, K, rnd) {
  for (let i = 0; i < K; i++) { const j = i + Math.floor(rnd() * (N - i)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx.slice(0, K);
}
/* benchmark: SPY en pesos, comprado y no tocado (el control de INFORME-AGRESIVIDAD §5) */
function buyHold(ctx, ccl) {
  const porSym = {};
  for (const sym of Object.keys(ctx.serie)) {
    const arr = ctx.serie[sym];
    if (!arr || arr.length < 20) continue;
    const m = new Map();
    for (const b of arr) m.set(b.t, b.c * (ccl(b.t) || 1));
    porSym[sym] = m;
  }
  const syms = Object.keys(porSym);
  const rets = [];
  for (const s of syms) {
    const m = porSym[s];
    const ds = [...m.keys()].sort();
    const p0 = m.get(ds[0]), p1 = m.get(ds[ds.length - 1]);
    if (p0 > 0) rets.push({ s, r: p1 / p0 - 1 });
  }
  const media = mean(rets.map((x) => x.r));
  let spy = null, spyDD = null, spySharpe = null;
  if (porSym.SPY) {
    const ds = [...porSym.SPY.keys()].sort();
    spy = porSym.SPY.get(ds[ds.length - 1]) / porSym.SPY.get(ds[0]) - 1;
    let v = 1, pk = 1, d2 = 0; const rs = [];
    for (let i = 1; i < ds.length; i++) {
      const r = porSym.SPY.get(ds[i]) / porSym.SPY.get(ds[i - 1]) - 1;
      rs.push(r); v *= 1 + r; pk = Math.max(pk, v); d2 = Math.max(d2, (pk - v) / pk);
    }
    spyDD = d2 * 100;
    const sd2 = stdev(rs);
    spySharpe = sd2 > 0 ? (mean(rs) / sd2) * Math.sqrt(252) : null;
  }
  return {
    n: rets.length, mensualPct: (media / ctx.meses) * 100,
    spyTotalPct: spy, spyMensualPct: spy == null ? null : (spy / ctx.meses) * 100,
    spyMaxDDpct: spyDD, spySharpe,
  };
}

/* ─────────────────────────────── main ─────────────────────────────── */
const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pct = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));

function main() {
  const t0 = Date.now();
  const all = cargarTodo();
  const senales = cargarSenales();
  const ccl = loadCcl(DATA);
  const U38 = new Set(LIMPIOS_38.filter((s) => all.syms.includes(s)));
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
  const prevCo = JSON.parse(fs.readFileSync(path.join(DIR, "results-cocos.json"), "utf8"));
  const prevAg = JSON.parse(fs.readFileSync(path.join(DIR, "results-agresividad.json"), "utf8"));

  console.log(`series ${all.syms.length} · señales ${senales.length} · U38 ${U38.size} · sorteos ${DRAWS} · semilla ${SEED}`);
  console.log(`configuración congelada (INFORME-AGRESIVIDAD §8): ${ELE.variante.desc} · stop/target ${ELE.conv} · ${pct(ELE.capPct, 0)} por posición · ${ELE.maxPos} posiciones · sin apalancamiento`);
  console.log(`tarifa de referencia: COCOS ${pct(FEE.cocos, 4)} por punta · spread calibrado ${pct(SPREAD_CAL, 2)}`);

  const out = {
    generado: new Date().toISOString(), semilla: SEED, draws: DRAWS,
    configuracion: { variante: ELE.variante.id, conv: ELE.conv, capPct: ELE.capPct, maxPos: ELE.maxPos, maxGross: ELE.maxGross },
    puntos: PUNTOS, fracs: FRACS, spreadCalibrado: SPREAD_CAL,
  };

  const gateBase = (s) => {
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };

  const CTX = {}, ORD = {};
  for (const [vn, [d0, d1]] of Object.entries(VENTANAS)) {
    CTX[vn] = construirCtx(all.hourly, U38, d0, d1);
    ORD[vn] = construirOrdenes(senales, U38, d0, d1, gateBase);
    ORD[vn].forEach((o, i) => { o._i = i; });
  }
  const BH = {};
  for (const vn of ["IS", "OOS"]) BH[vn] = buyHold(CTX[vn], ccl);

  /* ══════════ 0 · CHEQUEO DE CONSISTENCIA ══════════ */
  console.log(`\n===== 0 · CHEQUEO DE CONSISTENCIA · esto va antes que nada =====`);
  let malos = 0; const chequeo = [];
  const cmpN = (etq, a, b, tol) => {
    const d = a == null && b == null ? 0 : Math.abs(a - b);
    if (!(d <= tol)) { malos++; console.log(`   !! DESCUADRE ${etq}: mio ${a} vs publicado ${b} (Δ ${d})`); }
    chequeo.push({ etq, mio: a, ref: b, delta: d });
  };

  /* 0.a — la celda base de TODO el proyecto (los 38, límite en el nivel, 20%,
   * stop/target fijos, con el parcial al 50% del camino y media posición): las
   * cuatro tarifas contra results.json / results-cocos.json. */
  const BASE38 = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const sim = simular(ORD[vn], ctx, ccl, { variante: V_NIVEL, conv: "fijo", capPct: CAP_PCT, maxPos: MAX_POS, maxGross: 1, spread: 0, tpModo: "camino", tpVal: 0.5, tpFrac: 0.5, guardaBE: false });
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    BASE38[vn] = { ctx, sim, m };
    const refIol = prev.corridas[`38/base/${vn}`], refCo = prevCo.A[vn];
    for (const tier of TIERS) {
      const r = tier === "cocos" ? refCo.cocos : refIol.metricas[tier];
      const x = m[tier];
      cmpN(`base/${vn}/${tier}/n`, x.n, r.n, 0);
      cmpN(`base/${vn}/${tier}/mensual`, x.mensualPct, tier === "cocos" ? r.mensual : r.mensualPct, 1e-9);
      cmpN(`base/${vn}/${tier}/total`, x.total, r.total, 1e-6);
      cmpN(`base/${vn}/${tier}/win`, x.winRate, tier === "cocos" ? r.win : r.winRate, 1e-12);
      cmpN(`base/${vn}/${tier}/payoff`, x.payoff, r.payoff, 1e-9);
      cmpN(`base/${vn}/${tier}/sharpe`, x.sharpe, r.sharpe, 1e-9);
      cmpN(`base/${vn}/${tier}/maxDD`, x.maxDDpct, tier === "cocos" ? r.dd : r.maxDDpct, 1e-9);
    }
    console.log(`   [base 38/nivel/20%] ${vn}: n=${m.cocos.n} · COCOS ${n2(m.cocos.mensualPct)}%/mes · DD ${n2(m.cocos.maxDDpct, 1)}%`);
  }

  /* 0.b — LA QUE PIDE LA CONSIGNA: la celda (50% del camino, 50% vendido) sobre
   * la configuración elegida por INFORME-AGRESIVIDAD tiene que dar +2,23% (IS)
   * y +2,44% (OOS). Si no, se para acá. */
  const ELEG = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const sim = simular(ORD[vn], ctx, ccl, { ...ELE, spread: 0, tpModo: "camino", tpVal: 0.5, tpFrac: 0.5, guardaBE: false });
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    ELEG[vn] = { ctx, sim, m };
    const r = prevAg.E.resultado[`elegida/${vn}`];
    const x = m.cocos;
    cmpN(`elegida/${vn}/n`, x.n, r.n, 0);
    cmpN(`elegida/${vn}/mensual`, x.mensualPct, r.mensual, 1e-9);
    cmpN(`elegida/${vn}/total`, x.total, r.total, 1e-6);
    cmpN(`elegida/${vn}/win`, x.winRate, r.win, 1e-12);
    cmpN(`elegida/${vn}/payoff`, x.payoff, r.payoff, 1e-9);
    cmpN(`elegida/${vn}/sharpe`, x.sharpe, r.sharpe, 1e-9);
    cmpN(`elegida/${vn}/maxDD`, x.maxDDpct, r.maxDD, 1e-9);
    cmpN(`elegida/${vn}/brutoPct`, x.brutoPct, r.brutoPct, 1e-12);
    cmpN(`elegida/${vn}/netoPct`, x.netoPct, r.netoPct, 1e-12);
    cmpN(`elegida/${vn}/tamMedio`, x.tamMedio, r.tamMedio, 1e-12);
    cmpN(`elegida/${vn}/expoMedia`, x.expoMedia, r.expoMedia, 1e-12);
    cmpN(`elegida/${vn}/llenado`, x.llenado, r.llenado, 1e-12);
    console.log(`   [50% del camino, 50% vendido] ${vn}: n=${x.n} · mensual ${n2(x.mensualPct)}% · DD ${n2(x.maxDDpct, 1)}% · Sharpe ${n2(x.sharpe)} · parciales ${x.nParcial} · publicado ${n2(r.mensual)}% / DD ${n2(r.maxDD, 1)}%`);
  }
  out.chequeo = { descuadres: malos, n: chequeo.length, detalle: chequeo };
  if (malos) {
    console.log(`\n*** ABORTA: ${malos} descuadres. No se sigue. ***`);
    fs.writeFileSync(path.join(DIR, "results-parcial.json"), JSON.stringify(out, null, 1));
    return;
  }
  console.log(`   ${chequeo.length} comparaciones, 0 descuadres. La celda (50%, 50%) reproduce +2,23%/mes IS y +2,44%/mes OOS.`);

  /* registro de celdas para el N del DSR */
  /* Registro de celdas para el N del DSR.
   * Una celda = (punto de disparo × fracción vendida × ventana). La guarda de
   * breakeven se cuenta como celda APARTE sólo si produce una cartera distinta
   * de la misma celda sin guarda; si el resultado es idéntico al número, no es
   * un grado de libertad que se haya ejercido y no suma al N (igual se reporta
   * la versión paranoica, que las cuenta todas). No se cuenta la celda
   * (50% del camino, 50% vendido), que ya estaba contada en INFORME-AGRESIVIDAD
   * como la configuración elegida. */
  const CELDAS = new Map();
  let paranoicoNuevas = 0;
  const YA_CONTADAS = new Set(["camino|0.5|0.5|IS", "camino|0.5|0.5|OOS"]);
  const correr = (vn, p, frac, guarda, spread, registrar = true) => {
    const ctx = CTX[vn];
    const opts = {
      ...ELE, spread,
      tpModo: p.modo, tpVal: p.val, tpFrac: p.modo === "ninguno" ? 0 : frac, guardaBE: guarda,
    };
    const sim = simular(ORD[vn], ctx, ccl, opts);
    const m = metricas(sim, "cocos", ctx.meses);
    if (registrar && !(spread > 0)) {
      const base = `${p.modo}|${p.val}|${p.modo === "ninguno" ? 0 : frac}|${vn}`;
      // versión paranoica: cuenta CADA combinación mirada, incluida la guarda,
      // y saca sólo la que ya estaba contada en INFORME-AGRESIVIDAD
      if (!(base === `camino|0.5|0.5|${vn}` && !guarda)) paranoicoNuevas++;
      const yaEsta = CELDAS.get(base);
      if (!yaEsta) {
        if (!YA_CONTADAS.has(base)) CELDAS.set(base, { sr: m.srDiario, sharpe: m.sharpe, mensual: m.mensualPct });
      } else if (Math.abs(yaEsta.mensual - m.mensualPct) > 1e-12) {
        CELDAS.set(`${base}|noguarda`, { sr: m.srDiario, sharpe: m.sharpe, mensual: m.mensualPct });
      }
    }
    return { sim, m, ctx };
  };

  /* ══════════ A · LA GUARDA DEL BREAKEVEN ══════════ */
  console.log(`\n===== A · LA GUARDA DEL BREAKEVEN · ¿es redundante por construcción? =====`);
  console.log(`  breakeven = precio al que la venta de la pata empata comisión (Cocos, ${pct(FEE.cocos, 4)} por punta)`);
  console.log(`  Sin spread el breakeven queda ${pct((1 + FEE.cocos) / (1 - FEE.cocos) - 1, 4)} por encima del precio de entrada;`);
  console.log(`  con el spread calibrado de ${pct(SPREAD_CAL, 2)} (media horquilla por punta, cruzan las dos) queda ${pct((1 + FEE.cocos + SPREAD_CAL / 2) / (1 - FEE.cocos - SPREAD_CAL / 2) - 1, 4)} por encima.`);
  out.A = { porPunto: {}, distrib: {} };
  for (const vn of ["IS", "OOS"]) {
    const tr = ELEG[vn].sim.trades;
    const tg = tr.map((t) => t.tgtRel), st = tr.map((t) => t.stopRel);
    out.A.distrib[vn] = {
      n: tr.length,
      tgtRel: { media: mean(tg), p10: quantile(tg, 0.10), p25: quantile(tg, 0.25), mediana: quantile(tg, 0.50), p75: quantile(tg, 0.75), min: Math.min(...tg) },
      stopRel: { media: mean(st), mediana: quantile(st, 0.50) },
      rrMedio: mean(tr.map((t) => t.tgtRel / t.stopRel)),
    };
    const d = out.A.distrib[vn];
    console.log(`  [${vn}] n=${tr.length} · distancia al target (móvil, desde el fill): media ${pct(d.tgtRel.media, 2)} · mediana ${pct(d.tgtRel.mediana, 2)} · p10 ${pct(d.tgtRel.p10, 2)} · mínimo ${pct(d.tgtRel.min, 3)} · R:R medio ${n2(d.rrMedio)}`);
  }
  console.log(`\n  ${"punto".padEnd(24)} ${"vn".padEnd(4)} ${"trades".padStart(6)} ${"disparo medio".padStart(13)} ${"< breakeven".padStart(11)} ${"% de trades".padStart(11)} ${">= target".padStart(9)} ${"pérdida media si dispara".padStart(24)}`);
  for (const p of PUNTOS.filter((x) => x.modo !== "ninguno")) for (const vn of ["IS", "OOS"]) {
    /* se corre SIN guarda y con fracción 50% para medir el diagnóstico crudo */
    const { sim, m } = correr(vn, p, 0.50, false, 0, false);
    const bajo = sim.trades.filter((t) => t.tpBajoBE);
    // cuánto pierde la pata parcial de los que disparan por debajo del BE
    const perd = bajo.filter((t) => t.tpDone).map((t) => {
      const leg = t.legs.find((l) => l.reason === "tp_parcial");
      return leg ? leg.pnl.cocos / leg.entN : null;
    }).filter((x) => x != null);
    const dispMedio = mean(sim.trades.filter((t) => t.tpNivel != null).map((t) => t.tpNivel / t.entryPx - 1));
    out.A.porPunto[`${p.id}|${vn}`] = {
      punto: p.id, vn, n: m.n, disparoMedio: dispMedio, nBajoBE: bajo.length,
      fracBajoBE: m.n ? bajo.length / m.n : null, nSobreTgt: m.nSobreTgt,
      nBajoBEdisparados: perd.length, perdidaMediaPct: perd.length ? mean(perd) : null,
    };
    const o = out.A.porPunto[`${p.id}|${vn}`];
    console.log(`  ${p.etq.padEnd(24)} ${vn.padEnd(4)} ${String(m.n).padStart(6)} ${pct(dispMedio, 2).padStart(13)} ${String(bajo.length).padStart(11)} ${pct(o.fracBajoBE, 1).padStart(11)} ${String(m.nSobreTgt).padStart(9)} ${(o.perdidaMediaPct == null ? "-" : pct(o.perdidaMediaPct, 3)).padStart(24)}`);
  }

  /* ══════════ B y C · LA GRILLA ══════════ */
  console.log(`\n===== B · LA GRILLA · punto de disparo × fracción vendida =====`);
  out.B = {};
  const GRID = {};   // clave: punto|frac|guarda|spread|vn
  for (const guarda of [true, false]) for (const sp of [0, SPREAD_CAL]) for (const vn of ["IS", "OOS"]) {
    for (const p of PUNTOS) {
      const fracs = p.modo === "ninguno" ? [0] : FRACS;
      for (const fr of fracs) {
        const r = correr(vn, p, fr, guarda, sp);
        const bench = BH[vn].spyMensualPct * r.m.expoMedia;
        const rec = {
          punto: p.id, etq: p.etq, frac: fr, guarda, spread: sp, vn,
          n: r.m.n, mensual: r.m.mensualPct, maxDD: r.m.maxDDpct, sharpe: r.m.sharpe,
          win: r.m.winRate, payoff: r.m.payoff, nParcial: r.m.nParcial, nBajoBE: r.m.nBajoBE,
          nSubido: r.m.nSubido, nSobreTgt: r.m.nSobreTgt, caminos: r.m.caminos,
          expoMedia: r.m.expoMedia, expoMax: r.m.expoMax, brutoPct: r.m.brutoPct, netoPct: r.m.netoPct,
          total: r.m.total, opsMes: r.m.opsMes, tamMedio: r.m.tamMedio,
          benchSpy: bench, exceso: r.m.mensualPct - bench,
          pnlMax: r.m.pnlMax, pnlP90: r.m.pnlP90, sdTrade: r.m.sdTrade, shareTop10: r.m.shareTop10,
          expectancy: r.m.expectancy, srDiario: r.m.srDiario,
        };
        GRID[`${p.id}|${fr}|${guarda ? "g" : "n"}|${sp}|${vn}`] = { ...rec, rets: r.m.rets, sim: r.sim };
        out.B[`${p.id}|${fr}|${guarda ? "g" : "n"}|${sp}|${vn}`] = rec;
      }
    }
  }
  const cel = (pid, fr, g, sp, vn) => GRID[`${pid}|${pid === "sin" ? 0 : fr}|${g ? "g" : "n"}|${sp}|${vn}`];

  const imprimirGrilla = (titulo, campo, g, sp, dec = 2, suf = "%") => {
    for (const vn of ["IS", "OOS"]) {
      console.log(`\n  [${vn}] ${titulo}`);
      console.log(`  ${"punto de disparo".padEnd(24)} ${FRACS.map((f) => (pct(f, 0) + " vendido").padStart(14)).join("")}`);
      for (const p of PUNTOS) {
        const fila = FRACS.map((f) => {
          const c = cel(p.id, f, g, sp, vn);
          return (n2(c[campo], dec) + suf).padStart(14);
        }).join("");
        const marca = p.id === "c50" ? " <-" : "";
        console.log(`  ${p.etq.padEnd(24)} ${fila}${marca}`);
      }
    }
  };
  console.log(`\n  --- B.1 · retorno mensual neto en Cocos, SIN spread, CON guarda de breakeven ---`);
  imprimirGrilla("retorno mensual (%)", "mensual", true, 0);
  console.log(`\n  --- B.2 · retorno mensual neto en Cocos, CON spread ${pct(SPREAD_CAL, 2)}, CON guarda ---`);
  imprimirGrilla(`retorno mensual con spread ${pct(SPREAD_CAL, 2)} (%)`, "mensual", true, SPREAD_CAL);
  console.log(`\n  --- B.3 · max drawdown (%), sin spread, con guarda ---`);
  imprimirGrilla("max drawdown (%)", "maxDD", true, 0, 1);
  console.log(`\n  --- B.4 · max drawdown (%), con spread ${pct(SPREAD_CAL, 2)}, con guarda ---`);
  imprimirGrilla(`max drawdown con spread (%)`, "maxDD", true, SPREAD_CAL, 1);
  console.log(`\n  --- B.5 · Sharpe, sin spread, con guarda ---`);
  imprimirGrilla("Sharpe", "sharpe", true, 0, 2, "");
  console.log(`\n  --- B.6 · exceso contra SPY en pesos escalado a la exposición de cada celda, sin spread ---`);
  imprimirGrilla("exceso vs SPY·expo (pp/mes)", "exceso", true, 0);
  console.log(`\n  --- B.7 · exceso contra SPY·expo, CON spread ${pct(SPREAD_CAL, 2)} ---`);
  imprimirGrilla("exceso vs SPY·expo con spread (pp/mes)", "exceso", true, SPREAD_CAL);

  console.log(`\n  --- B.8 · detalle por celda (sin spread, con guarda): win, payoff, parciales y caminos de salida ---`);
  console.log(`  ${"punto".padEnd(24)} ${"fr".padStart(4)} ${"vn".padEnd(4)} ${"n".padStart(4)} ${"mens".padStart(7)} ${"DD".padStart(6)} ${"win".padStart(6)} ${"payoff".padStart(7)} ${"parc".padStart(5)} ${"p→tgt".padStart(6)} ${"p→trl".padStart(6)} ${"p→stp".padStart(6)} ${"stop seco".padStart(9)} ${"tgt seco".padStart(8)} ${"trl seco".padStart(8)}`);
  for (const p of PUNTOS) for (const f of (p.modo === "ninguno" ? [0.5] : FRACS)) for (const vn of ["IS", "OOS"]) {
    const c = cel(p.id, f, true, 0, vn);
    const k = c.caminos, n = c.n || 1;
    console.log(`  ${p.etq.padEnd(24)} ${pct(p.modo === "ninguno" ? 0 : f, 0).padStart(4)} ${vn.padEnd(4)} ${String(c.n).padStart(4)} ${n2(c.mensual).padStart(6)}% ${n2(c.maxDD, 1).padStart(5)}% ${pct(c.win).padStart(6)} ${n2(c.payoff).padStart(7)} ${String(c.nParcial).padStart(5)} ${pct(k["parcial→target"] / n).padStart(6)} ${pct(k["parcial→trailing"] / n).padStart(6)} ${pct(k["parcial→stop"] / n).padStart(6)} ${pct(k["seco→stop"] / n).padStart(9)} ${pct(k["seco→target"] / n).padStart(8)} ${pct(k["seco→trailing"] / n).padStart(8)}`);
    if (p.modo === "ninguno") break;
  }

  /* ── C · la guarda: con y sin ── */
  console.log(`\n===== C · LA GUARDA DEL BREAKEVEN, CON Y SIN · delta por celda (sin spread) =====`);
  console.log(`  ${"punto".padEnd(24)} ${"fr".padStart(4)} ${"vn".padEnd(4)} ${"con guarda".padStart(10)} ${"sin guarda".padStart(10)} ${"Δ mensual".padStart(10)} ${"Δ DD".padStart(8)} ${"trades afectados".padStart(16)}`);
  out.C = {};
  let celdasGuardaDistinta = 0;
  for (const p of PUNTOS.filter((x) => x.modo !== "ninguno")) for (const f of FRACS) for (const vn of ["IS", "OOS"]) {
    const a = cel(p.id, f, true, 0, vn), b = cel(p.id, f, false, 0, vn);
    const dif = Math.abs(a.mensual - b.mensual) > 1e-12 || Math.abs(a.maxDD - b.maxDD) > 1e-12;
    if (dif) celdasGuardaDistinta++;
    out.C[`${p.id}|${f}|${vn}`] = {
      conGuarda: a.mensual, sinGuarda: b.mensual, delta: a.mensual - b.mensual,
      ddCon: a.maxDD, ddSin: b.maxDD, deltaDD: a.maxDD - b.maxDD, afectados: a.nSubido, distinta: dif,
    };
    if (a.nSubido > 0 || dif) {
      console.log(`  ${p.etq.padEnd(24)} ${pct(f, 0).padStart(4)} ${vn.padEnd(4)} ${n2(a.mensual).padStart(9)}% ${n2(b.mensual).padStart(9)}% ${n2(a.mensual - b.mensual).padStart(9)}pp ${n2(a.maxDD - b.maxDD, 1).padStart(7)}pp ${String(a.nSubido).padStart(16)}`);
    }
  }
  out.C._resumen = { celdasConDeltaNoNulo: celdasGuardaDistinta, celdasComparadas: 8 * 3 * 2 };
  console.log(`  celdas donde la guarda cambia algo: ${celdasGuardaDistinta} de ${8 * 3 * 2}`);

  /* ══════════ D · EL INTERCAMBIO RETORNO / DRAWDOWN Y LA COLA DERECHA ══════════ */
  console.log(`\n===== D · QUÉ HACE EL PARCIAL · retorno, drawdown y cola derecha, por separado =====`);
  console.log(`  (referencia = la celda actual: 50% del camino, 50% vendido, con guarda, sin spread)`);
  out.D = {};
  for (const vn of ["IS", "OOS"]) {
    const ref = cel("c50", 0.5, true, 0, vn);
    console.log(`\n  [${vn}] referencia: mensual ${n2(ref.mensual)}% · DD ${n2(ref.maxDD, 1)}% · Sharpe ${n2(ref.sharpe)} · sd por trade $${fmt(ref.sdTrade)} · mejor trade $${fmt(ref.pnlMax)} · top-10% de trades = ${pct(ref.shareTop10)} del total`);
    console.log(`  ${"punto".padEnd(24)} ${"fr".padStart(4)} ${"mensual".padStart(8)} ${"Δret".padStart(7)} ${"maxDD".padStart(7)} ${"ΔDD".padStart(7)} ${"ret/DD".padStart(7)} ${"sd/trade".padStart(10)} ${"mejor".padStart(10)} ${"p90".padStart(9)} ${"top10%".padStart(7)} ${"exceso".padStart(7)}`);
    for (const p of PUNTOS) for (const f of (p.modo === "ninguno" ? [0.5] : FRACS)) {
      const c = cel(p.id, f, true, 0, vn);
      out.D[`${p.id}|${p.modo === "ninguno" ? 0 : f}|${vn}`] = {
        mensual: c.mensual, dRet: c.mensual - ref.mensual, maxDD: c.maxDD, dDD: c.maxDD - ref.maxDD,
        retSobreDD: c.maxDD > 0 ? c.mensual / c.maxDD : null, sdTrade: c.sdTrade, pnlMax: c.pnlMax,
        pnlP90: c.pnlP90, shareTop10: c.shareTop10, sharpe: c.sharpe, exceso: c.exceso,
      };
      const o = out.D[`${p.id}|${p.modo === "ninguno" ? 0 : f}|${vn}`];
      console.log(`  ${p.etq.padEnd(24)} ${pct(p.modo === "ninguno" ? 0 : f, 0).padStart(4)} ${n2(c.mensual).padStart(7)}% ${n2(o.dRet).padStart(6)}pp ${n2(c.maxDD, 1).padStart(6)}% ${n2(o.dDD, 1).padStart(6)}pp ${n2(o.retSobreDD).padStart(7)} ${fmt(c.sdTrade).padStart(10)} ${fmt(c.pnlMax).padStart(10)} ${fmt(c.pnlP90).padStart(9)} ${pct(c.shareTop10, 0).padStart(7)} ${n2(c.exceso).padStart(6)}%`);
      if (p.modo === "ninguno") break;
    }
  }

  /* ══════════ E · WALK-FORWARD ESTRICTO ══════════ */
  console.log(`\n===== E · WALK-FORWARD ESTRICTO =====`);
  /* CRITERIO PRE-DECLARADO, fijado antes de mirar el OOS:
   *   se elige la celda con MAYOR retorno mensual neto en Cocos del IN-SAMPLE,
   *   SIN spread (la misma convención con la que INFORME-AGRESIVIDAD §8.1
   *   eligió la configuración de entrada: el spread es un dato de mercado que
   *   se aplica después, en su propio bloque), CON la guarda de breakeven
   *   puesta (es la condición que pide LP), con al menos 30 trades en el IS.
   *   Empate → menor drawdown.
   * Se reportan además, como criterios secundarios PRE-DECLARADOS:
   *   · la celda de mayor Sharpe del IS (criterio de riesgo)
   *   · la celda de mayor retorno del IS midiendo CON spread
   * Los tres se eligen mirando SÓLO el in-sample. El OOS se corre una vez. */
  const candidatas = [];
  for (const p of PUNTOS) for (const f of (p.modo === "ninguno" ? [0] : FRACS)) {
    const c = cel(p.id, f, true, 0, "IS");
    if (c.n >= 30) candidatas.push({ p, f, c, conSpread: cel(p.id, f, true, SPREAD_CAL, "IS") });
  }
  const porRet = [...candidatas].sort((a, b) => (b.c.mensual - a.c.mensual) || (a.c.maxDD - b.c.maxDD));
  const porSharpe = [...candidatas].sort((a, b) => (b.c.sharpe - a.c.sharpe) || (a.c.maxDD - b.c.maxDD));
  const porRetSp = [...candidatas].sort((a, b) => (b.conSpread.mensual - a.conSpread.mensual) || (a.conSpread.maxDD - b.conSpread.maxDD));
  const ganadora = porRet[0];
  console.log(`  criterio primario (pre-declarado): mayor mensual del IS, sin spread, con guarda, n>=30. Desempate por menor drawdown.`);
  console.log(`  GANADORA DEL IS: ${ganadora.p.etq} · ${pct(ganadora.f, 0)} vendido → IS ${n2(ganadora.c.mensual)}%/mes · DD ${n2(ganadora.c.maxDD, 1)}% · Sharpe ${n2(ganadora.c.sharpe)}`);
  console.log(`  (criterio de riesgo · mayor Sharpe del IS: ${porSharpe[0].p.etq} · ${pct(porSharpe[0].f, 0)} → Sharpe ${n2(porSharpe[0].c.sharpe)} · ${n2(porSharpe[0].c.mensual)}%/mes · DD ${n2(porSharpe[0].c.maxDD, 1)}%)`);
  console.log(`  (criterio con spread · mayor mensual del IS a ${pct(SPREAD_CAL, 2)}: ${porRetSp[0].p.etq} · ${pct(porRetSp[0].f, 0)} → ${n2(porRetSp[0].conSpread.mensual)}%/mes)`);
  console.log(`\n  ranking completo del IS (sin spread, con guarda), para que se vea que no hay cherry-picking:`);
  porRet.forEach((x, i) => {
    console.log(`    ${String(i + 1).padStart(2)}. ${x.p.etq.padEnd(24)} ${pct(x.f, 0).padStart(4)} → ${n2(x.c.mensual).padStart(6)}%/mes · DD ${n2(x.c.maxDD, 1).padStart(5)}% · Sharpe ${n2(x.c.sharpe).padStart(5)} · conSpread ${n2(x.conSpread.mensual).padStart(6)}%`);
  });

  out.E = {
    criterio: "mayor mensual neto Cocos en IS, sin spread, con guarda de breakeven, n>=30; desempate por menor drawdown",
    ganadora: { punto: ganadora.p.id, etq: ganadora.p.etq, frac: ganadora.f },
    porSharpe: { punto: porSharpe[0].p.id, frac: porSharpe[0].f },
    porRetSpread: { punto: porRetSp[0].p.id, frac: porRetSp[0].f },
    ranking: porRet.map((x) => ({ punto: x.p.id, frac: x.f, mensual: x.c.mensual, dd: x.c.maxDD, sharpe: x.c.sharpe, conSpread: x.conSpread.mensual })),
    resultado: {},
  };
  console.log(`\n  --- la ganadora del IS, corrida en el OOS UNA VEZ y sin retocar ---`);
  console.log(`  ${"corrida".padEnd(22)} ${"n".padStart(4)} ${"mensual".padStart(8)} ${"c/spread".padStart(9)} ${"DD".padStart(6)} ${"win".padStart(6)} ${"payoff".padStart(7)} ${"Sharpe".padStart(7)} ${"parc".padStart(5)} ${"expoMed".padStart(8)} ${"SPY·expo".padStart(9)} ${"exceso".padStart(8)}`);
  for (const [nm, pid, fr] of [
    ["ACTUAL (50%,50%)", "c50", 0.5],
    [`GANADORA IS`, ganadora.p.id, ganadora.f],
    [`mayor Sharpe IS`, porSharpe[0].p.id, porSharpe[0].f],
    ["sin parcial", "sin", 0],
  ]) {
    for (const vn of ["IS", "OOS"]) {
      const c = cel(pid, fr, true, 0, vn), cs = cel(pid, fr, true, SPREAD_CAL, vn);
      out.E.resultado[`${nm}/${vn}`] = {
        punto: pid, frac: fr, n: c.n, mensual: c.mensual, mensualSpread: cs.mensual, maxDD: c.maxDD,
        maxDDSpread: cs.maxDD, win: c.win, payoff: c.payoff, sharpe: c.sharpe, nParcial: c.nParcial,
        expoMedia: c.expoMedia, benchSpy: c.benchSpy, exceso: c.exceso, excesoSpread: cs.exceso,
        caminos: c.caminos, total: c.total, brutoPct: c.brutoPct,
      };
      console.log(`  ${(nm + " · " + vn).padEnd(22)} ${String(c.n).padStart(4)} ${n2(c.mensual).padStart(7)}% ${n2(cs.mensual).padStart(8)}% ${n2(c.maxDD, 1).padStart(5)}% ${pct(c.win).padStart(6)} ${n2(c.payoff).padStart(7)} ${n2(c.sharpe).padStart(7)} ${String(c.nParcial).padStart(5)} ${n2(c.expoMedia, 2).padStart(8)} ${n2(c.benchSpy).padStart(8)}% ${n2(c.exceso).padStart(7)}%`);
    }
  }
  console.log(`  benchmark: SPY en pesos comprado y quieto → IS ${n2(BH.IS.spyMensualPct)}%/mes (DD ${n2(BH.IS.spyMaxDDpct, 1)}%) · OOS ${n2(BH.OOS.spyMensualPct)}%/mes (DD ${n2(BH.OOS.spyMaxDDpct, 1)}%)`);
  out.E.benchmark = { IS: BH.IS, OOS: BH.OOS };

  /* ══════════ F · MODELOS NULOS ══════════ */
  out.F = {};
  if (!SIN_NULO) {
    console.log(`\n===== F · MODELOS NULOS DE LA CELDA GANADORA (${DRAWS} sorteos, semilla ${SEED}) =====`);
    const rnd = mulberry32(SEED);
    const gp = PUNTOS.find((x) => x.id === ganadora.p.id);

    /* Nulo 1 · EL PUNTO DEL PARCIAL AL AZAR. Es el nulo propio de esta
     * pregunta: misma entrada, misma fracción vendida, mismo todo, pero el
     * disparo del parcial se sortea uniforme en el camino (0,1) trade por
     * trade, con la misma guarda de breakeven. Si el punto elegido no le gana
     * a un punto al azar, mover la perilla no selecciona nada.
     * La fracción vendida del nulo es la de la celda ganadora; si la ganadora
     * resulta ser "sin parcial" (que no tiene fracción), se usa 0,50 — que es
     * exactamente el parámetro del worker de hoy, o sea que la pregunta pasa a
     * ser "¿apagar el parcial le gana al parcial de siempre puesto en cualquier
     * lado del camino?". */
    const fracNulo = ganadora.f > 0 ? ganadora.f : 0.5;
    console.log(`  (fracción vendida del nulo: ${pct(fracNulo, 0)})`);
    for (const vn of ["IS", "OOS"]) {
      const real = cel(gp.id, ganadora.f, true, 0, vn).mensual;
      const N = ORD[vn].length;
      const nulos = [];
      for (let b = 0; b < DRAWS; b++) {
        const u = new Float64Array(N);
        for (let i = 0; i < N; i++) u[i] = rnd();
        const s = simular(ORD[vn], CTX[vn], ccl, {
          ...ELE, spread: 0, tpFrac: fracNulo, guardaBE: true, tpU: u, light: true,
        });
        const tot = s.trades.reduce((acc, tr) => acc + tr.legs.reduce((z, l) => z + l.pnl.cocos, 0), 0);
        nulos.push((tot / CAPITAL / CTX[vn].meses) * 100);
      }
      const u = ubicar(real, nulos);
      out.F[`puntoAlAzar/${vn}`] = { fracNulo, ...u };
      console.log(`  nulo · punto del parcial al azar · ${vn}: real ${n2(real)}% · mediana nulo ${n2(u.med)}% · percentil ${pct(u.percentil)} · p=${n2(u.p1cola, 4)} · p5-p95 ${n2(u.p05)} a ${n2(u.p95)}`);
    }

    /* Nulo 1.bis · LOS DOS EJES AL AZAR. El barrido movió dos perillas (punto y
     * fracción), así que el nulo completo sortea las dos: punto uniforme en el
     * camino y fracción uniforme en (0,1), trade por trade. Contesta la
     * pregunta del anexo entero: ¿la celda que eligió el IS le gana a poner el
     * parcial en cualquier lado y por cualquier tamaño? */
    for (const vn of ["IS", "OOS"]) {
      const real = cel(gp.id, ganadora.f, true, 0, vn).mensual;
      const N = ORD[vn].length;
      const nulos = [];
      for (let b = 0; b < DRAWS; b++) {
        const u = new Float64Array(N);
        for (let i = 0; i < N; i++) u[i] = rnd();
        const fr = rnd();
        const s = simular(ORD[vn], CTX[vn], ccl, {
          ...ELE, spread: 0, tpFrac: fr, guardaBE: true, tpU: u, light: true,
        });
        const tot = s.trades.reduce((acc, tr) => acc + tr.legs.reduce((z, l) => z + l.pnl.cocos, 0), 0);
        nulos.push((tot / CAPITAL / CTX[vn].meses) * 100);
      }
      const u = ubicar(real, nulos);
      out.F[`dosEjesAlAzar/${vn}`] = u;
      console.log(`  nulo · punto Y fracción al azar · ${vn}: real ${n2(real)}% · mediana nulo ${n2(u.med)}% · percentil ${pct(u.percentil)} · p=${n2(u.p1cola, 4)} · p5-p95 ${n2(u.p05)} a ${n2(u.p95)}`);
    }

    /* Nulo 2 · SELECCIÓN DE ÓRDENES (el nulo 1 de INFORME-AGRESIVIDAD, re-corrido
     * con el parcial de la celda ganadora): ¿las señales que el llenado elige
     * son mejores que K cualesquiera? */
    for (const vn of ["IS", "OOS"]) {
      const c = cel(gp.id, ganadora.f, true, 0, vn);
      const K = c.n, N = ORD[vn].length, real = c.mensual;
      const idx = ORD[vn].map((_, i) => i);
      const nulos = [];
      for (let b = 0; b < DRAWS; b++) {
        const sel = new Set(sorteoK(idx, N, K, rnd));
        const s = simular(ORD[vn], CTX[vn], ccl, {
          ...ELE, spread: 0, tpModo: gp.modo, tpVal: gp.val, tpFrac: ganadora.f, guardaBE: true,
          light: true, soloIdx: sel,
        });
        const tot = s.trades.reduce((acc, tr) => acc + tr.legs.reduce((z, l) => z + l.pnl.cocos, 0), 0);
        nulos.push((tot / CAPITAL / CTX[vn].meses) * 100);
      }
      const u = ubicar(real, nulos);
      out.F[`seleccion/${vn}`] = { K, N, ...u };
      console.log(`  nulo · selección de órdenes · ${vn}: real ${n2(real)}% · mediana nulo ${n2(u.med)}% · percentil ${pct(u.percentil)} · p=${n2(u.p1cola, 4)}`);
    }

    /* Nulo 3 · BOOTSTRAP DE BLOQUES sobre la diferencia diaria de equity contra
     * la celda ACTUAL (50% del camino, 50% vendido). ¿La mejora se distingue
     * de cero? */
    for (const vn of ["IS", "OOS"]) {
      const a = cel(gp.id, ganadora.f, true, 0, vn).sim.equity;
      const b = cel("c50", 0.5, true, 0, vn).sim.equity;
      const mapa = new Map(b.map((e) => [e.dia, e.eq.cocos]));
      const d = [];
      let pa = CAPITAL, pb = CAPITAL;
      for (const e of a) {
        const eb = mapa.get(e.dia);
        if (eb == null) continue;
        d.push((e.eq.cocos - pa) - (eb - pb));
        pa = e.eq.cocos; pb = eb;
      }
      const L = 10, nb = Math.ceil(d.length / L);
      const muestras = [];
      for (let it = 0; it < DRAWS; it++) {
        let s = 0;
        for (let k = 0; k < nb; k++) {
          const st = Math.floor(rnd() * Math.max(1, d.length - L));
          for (let j = 0; j < L && st + j < d.length; j++) s += d[st + j];
        }
        muestras.push((s * (d.length / (nb * L)) / CAPITAL / CTX[vn].meses) * 100);
      }
      muestras.sort((x, y) => x - y);
      const real = cel(gp.id, ganadora.f, true, 0, vn).mensual - cel("c50", 0.5, true, 0, vn).mensual;
      out.F[`bootstrap/${vn}`] = {
        deltaReal: real, p05: muestras[Math.floor(DRAWS * 0.05)], p50: muestras[Math.floor(DRAWS * 0.5)],
        p95: muestras[Math.floor(DRAWS * 0.95)], pLeq0: muestras.filter((x) => x <= 0).length / DRAWS, dias: d.length,
      };
      const o = out.F[`bootstrap/${vn}`];
      console.log(`  bootstrap de bloques (ganadora − actual) · ${vn}: Δ real ${n2(real)} pp/mes · IC90 [${n2(o.p05)}, ${n2(o.p95)}] · p(Δ<=0) ${n2(o.pLeq0, 3)}`);
    }
  }

  /* ══════════ G · DSR ══════════ */
  console.log(`\n===== G · DEFLATED SHARPE RATIO con el N actualizado =====`);
  const Nprev = prevAg.G.N;                     // 324
  const NparPrev = prevAg.G.Nparanoico;         // 496
  const nNuevas = CELDAS.size;
  const N = Nprev + nNuevas;
  const Nparanoico = NparPrev + paranoicoNuevas;
  const sigPrev = prevCo.E.sigmaSR.cocos;       // 3,6559e-2 (160 variantes previas)
  const sigAgr = prevAg.G.sigmaNuevas;          // 4,3712e-2 (las 150 de agresividad)
  const srsNuevas = [...CELDAS.values()].map((x) => x.sr).filter((x) => x != null);
  const sigNuevas = stdev(srsNuevas);
  console.log(`  celdas nuevas evaluadas acá: ${nNuevas} (punto × fracción × ventana; la guarda sólo cuenta`);
  console.log(`  aparte si cambia la cartera, y no cambia ninguna). La celda 50%/50% no se cuenta: ya estaba`);
  console.log(`  contada como "elegida" en INFORME-AGRESIVIDAD. Versión paranoica (cuenta la guarda igual): ${paranoicoNuevas}.`);
  console.log(`  N ${Nprev} → ${N} · paranoico ${NparPrev} → ${Nparanoico}`);
  console.log(`  σ(SR) Cocos: publicado ${sigPrev.toExponential(4)} · de agresividad ${sigAgr.toExponential(4)} · de las ${srsNuevas.length} celdas nuevas ${sigNuevas.toExponential(4)}`);
  out.G = { Nprev, nNuevas, N, NparPrev, Nparanoico, sigmaPrev: sigPrev, sigmaAgr: sigAgr, sigmaNuevas: sigNuevas, filas: {} };
  const agregar = (nombre, c) => {
    const d0 = dsr(c.rets, c.srDiario, sigPrev, Nprev);
    const d1 = dsr(c.rets, c.srDiario, sigPrev, N);
    const d2 = dsr(c.rets, c.srDiario, sigNuevas, N);
    const d3 = dsr(c.rets, c.srDiario, sigPrev, Nparanoico);
    out.G.filas[nombre] = {
      n: c.n, sharpe: c.sharpe, mensual: c.mensual,
      dsrNprev: d0 ? d0.dsr : null, dsr: d1 ? d1.dsr : null,
      dsrSigmaNuevas: d2 ? d2.dsr : null, dsrParanoico: d3 ? d3.dsr : null, sr0: d1 ? d1.sr0 : null,
    };
    console.log(`    ${nombre.padEnd(40)} n=${String(c.n).padStart(3)} SR ${n2(c.sharpe).padStart(6)} · DSR(N=${Nprev}) ${d0 ? d0.dsr.toFixed(4) : "-"} → DSR(N=${N}) ${d1 ? d1.dsr.toFixed(4) : "-"} · σ nuevas ${d2 ? d2.dsr.toFixed(4) : "-"} · paranoico ${d3 ? d3.dsr.toFixed(4) : "-"}`);
  };
  agregar("ACTUAL (50% camino, 50%) · IS", cel("c50", 0.5, true, 0, "IS"));
  agregar("ACTUAL (50% camino, 50%) · OOS", cel("c50", 0.5, true, 0, "OOS"));
  agregar(`GANADORA IS (${ganadora.p.id}, ${pct(ganadora.f, 0)}) · IS`, cel(ganadora.p.id, ganadora.f, true, 0, "IS"));
  agregar(`GANADORA IS (${ganadora.p.id}, ${pct(ganadora.f, 0)}) · OOS`, cel(ganadora.p.id, ganadora.f, true, 0, "OOS"));
  agregar(`mayor Sharpe IS (${porSharpe[0].p.id}, ${pct(porSharpe[0].f, 0)}) · IS`, cel(porSharpe[0].p.id, porSharpe[0].f, true, 0, "IS"));
  agregar(`mayor Sharpe IS (${porSharpe[0].p.id}, ${pct(porSharpe[0].f, 0)}) · OOS`, cel(porSharpe[0].p.id, porSharpe[0].f, true, 0, "OOS"));
  agregar("sin parcial · IS", cel("sin", 0, true, 0, "IS"));
  agregar("sin parcial · OOS", cel("sin", 0, true, 0, "OOS"));

  /* ── huella de reproducibilidad ── */
  for (const k of Object.keys(out.B)) { /* out.B ya está limpio de rets/sim */ }
  const digest = (() => {
    const nums = [];
    const walk = (o) => {
      if (o == null) return;
      if (typeof o === "number") { nums.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { if (k === "generado" || k.startsWith("_")) continue; walk(o[k]); } }
    };
    walk({ A: out.A, B: out.B, C: out.C, D: out.D, E: out.E, F: out.F, G: out.G });
    let h = 2166136261 >>> 0;
    for (const v of nums) {
      const s = Number.isFinite(v) ? v.toExponential(12) : String(v);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { nNumeros: nums.length, fnv1a: h.toString(16) };
  })();
  out.digest = digest;
  console.log(`\nhuella de reproducibilidad: ${digest.nNumeros} números · FNV-1a ${digest.fnv1a}`);
  fs.writeFileSync(path.join(DIR, "results-parcial.json"), JSON.stringify(out, null, 1));
  console.log(`listo en ${((Date.now() - t0) / 1000).toFixed(1)} s → results-parcial.json`);
}

main();
