#!/usr/bin/env node
/* agresividad.js — ¿se llega al 3% mensual entrando más agresivo y más grande?
 *
 * El cuello de botella del motor no son las señales: son las ejecuciones. En el
 * in-sample el gate deja pasar 528 señales y sólo 111 terminan en trade; 278
 * órdenes expiran a las 48 h porque el papel nunca bajó al nivel. La hipótesis
 * es que entrando más arriba se llenan muchas más órdenes; la tensión es que el
 * edge de 0,36% del nocional viene justamente de comprar EN el nivel. La
 * pregunta es si el edge cae MENOS que proporcionalmente.
 *
 * Bloques:
 *   0 · chequeo de consistencia contra results.json y results-cocos.json
 *   A · barrido de agresividad de entrada (5 niveles + las dos variantes de
 *       mercado), con tasa de llenado y edge por operación lado a lado
 *   B · stop/target FIJOS al nivel vs MÓVILES con la entrada
 *   C · barrido de tamaño (MAX_POS_PCT) × tope de posiciones simultáneas,
 *       con exposición bruta y apalancamiento requerido
 *   D · grilla combinada agresividad × tamaño (retorno y drawdown)
 *   E · walk-forward estricto + modelos nulos de la celda ganadora del IS
 *   F · sensibilidad al spread del CEDEAR (calibrado con cedear_fv_log)
 *   G · DSR con el N actualizado
 *
 * Reusa engine.js y el cache signals.json. No toca el VPS ni Supabase.
 * Semilla 20260917. ESM.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadSeries, loadCcl, emaOf, emaStep, gatePasa } from "./engine.js";

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

/* ── constantes: IDÉNTICAS a simulate.js / cocos.js ── */
const CAPITAL = 7_000_000;
const RISK = 0.015;
const MAX_POS = 5;                             // tope de posiciones simultáneas (base)
const MAX_DIA = 5;
const CAP_PCT = 0.20;                          // MAX_POS_PCT (base)
const VENTANA_H = 48;
const TP_FRAC = 0.5;
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;
const FEE = {
  gold: (0.005 * IVA) + DERECHOS,
  platinum: (0.003 * IVA) + DERECHOS,
  black: (0.001 * IVA) + DERECHOS,
  cocos: 0.0005 * IVA,
};
const TIERS = ["gold", "platinum", "black", "cocos"];
const DIAS_REGIME = 126;

const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";
const VENTANAS = { IS: [IS_DESDE, IS_HASTA], OOS: [OOS_DESDE, OOS_HASTA] };

const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TRUNCA_DAILY = { OKLO: "2024-05-10", RGTI: "2022-03-01", SATL: "2022-01-01", KEEL: "2026-04-06", LAR: "2025-01-27" };

const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/* ── las variantes de agresividad de entrada ──
 * k = cuánto por encima del nivel se pone el límite.
 * "cruza": si el límite queda por encima del último precio conocido (el cierre
 * de la barra de la señal) la orden ya no es pasiva — se ejecuta contra la
 * punta vendedora. En ese caso se llena al toque, al precio del spot, y paga
 * media horquilla de spread. Con k=0 nunca pasa (el motor define la entrada
 * como el techo de una zona que está SIEMPRE debajo del spot: z.hi < spot*0,999). */
const VARIANTES = [
  { id: "nivel", k: 0, modo: "lim", desc: "en el nivel exacto (base)" },
  { id: "lim025", k: 0.0025, modo: "lim", desc: "límite 0,25% por encima" },
  { id: "lim050", k: 0.0050, modo: "lim", desc: "límite 0,50% por encima" },
  { id: "lim100", k: 0.0100, modo: "lim", desc: "límite 1,00% por encima" },
  { id: "mkt-close", k: null, modo: "mktC", desc: "a mercado, cierre de la barra de la señal" },
  { id: "mkt-open", k: null, modo: "mktO", desc: "a mercado, apertura de la barra siguiente" },
];
const CONVS = ["fijo", "movil"];

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
      stopRel: (s.entry - s.stop) / s.entry,      // distancia relativa a la entrada
      tgtRel: (s.target - s.entry) / s.entry,
      created: s.ts * 1000 + 1,
    });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}

/* El simulador. Copia literal del de cocos.js (que es el de simulate.js) con
 * cinco perillas nuevas y NADA más:
 *   variante  · cómo se ejecuta la entrada (ver VARIANTES)
 *   conv      · "fijo" = stop/target donde los puso el motor;
 *               "movil" = misma distancia RELATIVA respecto del precio de fill
 *   capPct    · tope por posición (MAX_POS_PCT)
 *   maxPos    · tope de posiciones simultáneas
 *   maxGross  · tope de exposición bruta en múltiplos del capital. 1 = la regla
 *               actual (sin apalancamiento). Más de 1 = se permite descubierto,
 *               y NO se cobra el funding (ver el informe).
 *   spread    · horquilla del CEDEAR. Se cobra media horquilla en CADA punta
 *               que cruza: siempre en la salida (el stop se vende contra el
 *               bid) y además en la entrada cuando la orden es marketable.
 */
function simular(ordenes, ctx, ccl, opts = {}) {
  const {
    variante = VARIANTES[0], conv = "fijo", capPct = CAP_PCT, maxPos = MAX_POS,
    maxGross = 1, spread = 0, light = false, soloIdx = null,
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
    // spread: media horquilla de salida siempre; media de entrada sólo si la
    // orden cruzó (a mercado o límite marketable).
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
      // el dedup sigue siendo por NIVEL de la señal, no por precio de ejecución
      if (prev && Math.abs(prev.entry - o.entry) / o.entry < 0.005) { skips.dupPend++; continue; }
      if (prev) { pend.delete(o.sym); skips.reemplazadas++; }
      if (pend.size + open.size >= maxPos) { skips.posMax++; continue; }
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) { skips.entradasDia++; continue; }

      // precio de referencia = a cuánto esperamos entrar (sizing y límite)
      const barSig = barAt[o.sym].get(o.ts * 1000);
      const spotSig = barSig ? barSig.c : null;
      let pxRef, modo = variante.modo, cruza = false;
      if (variante.modo === "lim") {
        pxRef = o.entry * (1 + variante.k);
        if (spotSig != null && pxRef >= spotSig) { pxRef = spotSig; modo = "mktC"; cruza = true; }
      } else if (variante.modo === "mktC") {
        if (spotSig == null) { skips.sinSpot++; continue; }
        pxRef = spotSig; cruza = true;
      } else { // mktO: el precio real es la apertura de la barra siguiente;
        if (spotSig == null) { skips.sinSpot++; continue; }
        pxRef = spotSig; cruza = true;   // para el sizing se usa el último cierre conocido
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
        // límite pasiva: se llena si la barra tocó el precio. Se llena AL LÍMITE
        // aunque la barra haya abierto más abajo (misma convención pesimista
        // que el caso base).
        if (b.l <= p.pxRef) fillPx = p.pxRef;
      } else if (p.modo === "mktC") {
        // a mercado al cierre de la barra de la señal: el fill ya ocurrió antes
        // de esta barra, así que ESTA barra se juzga entera.
        fillPx = p.pxRef; entryTs = p.ts * 1000; juzgarFill = true;
      } else {
        // a mercado a la apertura de la barra siguiente: se entra al open y la
        // barra se juzga entera (sabemos que el fill fue al principio).
        fillPx = b.o; entryTs = t; juzgarFill = true;
      }
      if (fillPx == null) continue;
      pend.delete(sym);
      // con fill a mercado el precio real puede diferir del de referencia:
      // con la convención MÓVIL el stop/target se recalculan sobre el fill.
      const stopPx = conv === "movil" ? fillPx * (1 - p.stopRel) : p.stopPx;
      const tgtPx = conv === "movil" ? fillPx * (1 + p.tgtRel) : p.tgtPx;
      if (!(stopPx > 0 && stopPx < fillPx && tgtPx > fillPx)) { skips.degenerada++; continue; }
      const pos = {
        sym: p.sym, qty: p.qty, qty0: p.qty, entryPx: fillPx, entryTs, rIn: p.rIn,
        stop: stopPx, stopIni: stopPx, target: tgtPx, R: fillPx - stopPx,
        notional: p.qty * fillPx * p.rIn, legs: [], tpDone: false, barras: 0, juzgarFill,
        cruza: p.cruza, nivel: p.entry, premio: fillPx / p.entry - 1,
        tocoNivel: false, score: p.score, rr: p.rr, regime: p.regime, dia: p.dia,
      };
      // ¿esta orden se habría llenado igual con el límite EN el nivel?
      // (se marca acá con la barra del fill y se completa mientras viva)
      if (b.l <= p.entry) pos.tocoNivel = true;
      open.set(sym, pos); trades.push(pos);
    }

    /* 3) abiertas: stop → target → TP parcial → trailing */
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
      if (TP_FRAC > 0 && !pos.tpDone) {
        const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
        if (hi >= nivel) {
          const q = pos.qty / 2;
          cerrarPata(pos, q, Math.min(nivel, pos.target), t, "tp_parcial");
          pos.qty -= q; pos.notional = pos.qty * pos.entryPx * pos.rIn; pos.tpDone = true;
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
        // dentro del día se queda la última marca, pero el máximo del día manda
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
  // apalancamiento efectivamente usado: la parte de la exposición que excede el
  // capital propio. El funding NO está cobrado en el P&L; se reporta aparte.
  // Tasa: 0,069% por día CORRIDO (caución tomadora all-in de INFORME-COCOS §6).
  const apalDia = sim.equity.map((e) => Math.max(0, e.bruto - CAPITAL) / CAPITAL);
  const apalMedia = apalDia.length ? mean(apalDia) : 0;
  const costoFundingMensual = apalMedia * 0.00069 * 30.4375 * 100;
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, bruto, brutoSinCcl, notional, fees,
    brutoPct: notional > 0 ? bruto / notional : null,
    brutoSinCclPct: notional > 0 ? brutoSinCcl / notional : null,
    cclPct: notional > 0 ? (bruto - brutoSinCcl) / notional : null,
    costoPct: notional > 0 ? fees / notional : null,
    netoPct: notional > 0 ? (bruto - fees) / notional : null,
    expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    opsMes: n / Math.max(meses, 1e-9),
    tamMedio: n ? notional / n / CAPITAL : null,
    llenado: sim.nSenales ? n / sim.nSenales : null,
    llenadoColocadas: sim.colocadas ? n / sim.colocadas : null,
    expoMax: sim.maxBruto / CAPITAL, expoMedia: expoDia.length ? mean(expoDia) : 0,
    compMax: sim.maxComp / CAPITAL, apalMedia, costoFundingMensual,
    mensualConFunding: (total / CAPITAL / Math.max(meses, 1e-9)) * 100 - costoFundingMensual,
    sharpe, maxDDpct: dd * 100, srDiario: sd > 0 ? m / sd : null, rets, meses,
    nSenales: sim.nSenales, colocadas: sim.colocadas, cruzadas: sim.cruzadas, skips: sim.skips,
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
/* Benchmark de beta: comprar los 38 papeles en partes iguales al principio de
 * la ventana y no tocarlos, medido en PESOS (precio en USD × CCL del día). Es
 * el control que hace falta cuando una variante sube la exposición: si el
 * resultado se explica por estar comprado, hay que compararlo contra estar
 * comprado y listo. Se reporta como retorno simple total / meses, igual que el
 * mensual de la estrategia (que también es aritmético sobre capital fijo). */
function buyHold(ctx, ccl) {
  // cierre diario en pesos de cada papel dentro de la ventana
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
  rets.sort((a, b) => a.r - b.r);
  const media = mean(rets.map((x) => x.r));
  const mediana = rets.length ? rets[Math.floor(rets.length / 2)].r : null;
  // índice equiponderado con rebalanceo diario (promedio de retornos diarios)
  let idxv = 1, peak = 1, dd = 0;
  const diarios = [];
  for (let i = 1; i < ctx.dias.length; i++) {
    const d = ctx.dias[i], dp = ctx.dias[i - 1];
    const rs = [];
    for (const s of syms) {
      const a = porSym[s].get(dp), b = porSym[s].get(d);
      if (a > 0 && b > 0) rs.push(b / a - 1);
    }
    if (!rs.length) continue;
    const r = mean(rs);
    diarios.push(r);
    idxv *= 1 + r;
    peak = Math.max(peak, idxv);
    dd = Math.max(dd, (peak - idxv) / peak);
  }
  const sd = stdev(diarios);
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
    n: rets.length, totalPct: media, medianaPct: mediana, mensualPct: (media / ctx.meses) * 100,
    medianaMensualPct: mediana == null ? null : (mediana / ctx.meses) * 100,
    spyTotalPct: spy, spyMensualPct: spy == null ? null : (spy / ctx.meses) * 100, spyMaxDDpct: spyDD, spySharpe,
    idxTotalPct: idxv - 1, idxMensualPct: ((idxv - 1) / ctx.meses) * 100,
    idxMaxDDpct: dd * 100, idxSharpe: sd > 0 ? (mean(diarios) / sd) * Math.sqrt(252) : null,
    peor: rets[0], mejor: rets[rets.length - 1],
  };
}

function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a), mb = mean(b), va = stdev(a) ** 2 / a.length, vb = stdev(b) ** 2 / b.length;
  if (va + vb <= 0) return null;
  const t = (ma - mb) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  // aproximación normal para el p de dos colas (df >= 20 en todos los usos)
  return { t, df, p: 2 * (1 - normCdf(Math.abs(t))), ma, mb, na: a.length, nb: b.length };
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

  console.log(`series ${all.syms.length} · señales ${senales.length} · U38 ${U38.size} · sorteos ${DRAWS} · semilla ${SEED}`);
  console.log(`tarifa de referencia: COCOS ${pct(FEE.cocos, 4)} por punta · ${pct(FEE.cocos * 2, 4)} ida y vuelta`);

  const out = {
    generado: new Date().toISOString(), semilla: SEED, draws: DRAWS,
    tarifas: Object.fromEntries(TIERS.map((t) => [t, { punta: FEE[t], vuelta: FEE[t] * 2 }])),
    variantes: VARIANTES.map((v) => ({ id: v.id, k: v.k, modo: v.modo, desc: v.desc })),
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

  /* ══════════ 0 · CHEQUEO DE CONSISTENCIA ══════════ */
  console.log(`\n===== 0 · CHEQUEO DE CONSISTENCIA · la celda base tiene que reproducir INFORME-COCOS =====`);
  const BASE = {}, chequeo = [];
  let malos = 0;
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const sim = simular(ORD[vn], ctx, ccl, { variante: VARIANTES[0], conv: "fijo", capPct: CAP_PCT, maxPos: MAX_POS, maxGross: 1, spread: 0 });
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    BASE[vn] = { ctx, sim, m };
    const refIol = prev.corridas[`38/base/${vn}`];
    const refCo = prevCo.A[vn];
    for (const tier of TIERS) {
      const r = tier === "cocos" ? refCo.cocos : refIol.metricas[tier];
      const x = m[tier];
      const cmp = [
        ["n", x.n, r.n, 0],
        ["mensual", x.mensualPct, tier === "cocos" ? r.mensual : r.mensualPct, 1e-9],
        ["total", x.total, r.total, 1e-6],
        ["win", x.winRate, tier === "cocos" ? r.win : r.winRate, 1e-12],
        ["payoff", x.payoff, r.payoff, 1e-9],
        ["sharpe", x.sharpe, r.sharpe, 1e-9],
        ["maxDD", x.maxDDpct, tier === "cocos" ? r.dd : r.maxDDpct, 1e-9],
      ];
      for (const [k, a, b, tol] of cmp) {
        const d = a == null && b == null ? 0 : Math.abs(a - b);
        if (!(d <= tol)) { malos++; console.log(`   !! DESCUADRE ${vn}/${tier}/${k}: mio ${a} vs publicado ${b} (Δ ${d})`); }
        chequeo.push({ vn, tier, k, mio: a, ref: b, delta: d });
      }
    }
    console.log(`   ${vn}: n=${m.cocos.n} · señales ${m.cocos.nSenales} · llenado ${pct(m.cocos.llenado)} · expiradas ${m.cocos.skips.expiradas} · gold ${n2(m.gold.mensualPct)}% · black ${n2(m.black.mensualPct)}% · COCOS ${n2(m.cocos.mensualPct)}% · DD ${n2(m.cocos.maxDDpct, 1)}%`);
  }
  out.chequeo = { descuadres: malos, n: chequeo.length, detalle: chequeo };
  if (malos) {
    console.log(`\n*** ABORTA: ${malos} descuadres. No se sigue. ***`);
    fs.writeFileSync(path.join(DIR, "results-agresividad.json"), JSON.stringify(out, null, 1));
    return;
  }
  console.log(`   ${chequeo.length} comparaciones, 0 descuadres. La celda base reproduce +0,26%/mes IS y +0,32%/mes OOS de INFORME-COCOS.`);

  /* el registro de TODAS las celdas evaluadas, para el N del DSR */
  const CELDAS = new Map();
  const claveDe = (o) => `${o.variante}|${o.conv}|${o.capPct}|${o.maxPos}|${o.maxGross}|${o.vn}`;
  const correr = (vn, opts, noReg = false) => {
    const ctx = CTX[vn];
    const sim = simular(ORD[vn], ctx, ccl, opts);
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    const clave = claveDe({ variante: opts.variante.id, conv: opts.conv, capPct: opts.capPct, maxPos: opts.maxPos, maxGross: opts.maxGross, vn });
    // las corridas de calibración del nulo de exposición y las del barrido de
    // spread NO son configuraciones candidatas: no entran en el N del DSR.
    if (!noReg && !(opts.spread > 0)) CELDAS.set(clave, { srCocos: m.cocos.srDiario, sharpe: m.cocos.sharpe });
    return { sim, m, ctx };
  };

  /* ══════════ A · BARRIDO DE AGRESIVIDAD ══════════ */
  console.log(`\n===== A · BARRIDO DE AGRESIVIDAD DE ENTRADA · tamaño base (20%, 5 posiciones), sin spread =====`);
  out.A = {};
  const AGR = {};
  for (const conv of CONVS) for (const v of VARIANTES) for (const vn of ["IS", "OOS"]) {
    const r = correr(vn, { variante: v, conv, capPct: CAP_PCT, maxPos: MAX_POS, maxGross: 1, spread: 0 });
    AGR[`${v.id}|${conv}|${vn}`] = r;
  }
  for (const conv of CONVS) {
    console.log(`\n  --- stop/target ${conv === "fijo" ? "FIJOS al nivel" : "MÓVILES con la entrada"} ---`);
    console.log(`  ${"variante".padEnd(11)} ${"vn".padEnd(4)} ${"señ".padStart(4)} ${"fills".padStart(5)} ${"llenado".padStart(8)} ${"ops/mes".padStart(8)} ${"premio".padStart(7)} ${"bruto/op".padStart(9)} ${"neto/op".padStart(8)} ${"tam".padStart(6)} ${"producto".padStart(9)} ${"mensual".padStart(8)} ${"expoMed".padStart(8)} ${"x/expo".padStart(7)} ${"win".padStart(6)} ${"payoff".padStart(7)} ${"Sharpe".padStart(7)} ${"maxDD".padStart(6)}`);
    for (const v of VARIANTES) for (const vn of ["IS", "OOS"]) {
      const { m, sim } = AGR[`${v.id}|${conv}|${vn}`];
      const x = m.cocos;
      const prem = sim.trades.length ? mean(sim.trades.map((t) => t.premio)) : 0;
      const producto = x.opsMes * x.tamMedio * (x.brutoPct - x.costoPct) * 100;
      out.A[`${v.id}|${conv}|${vn}`] = {
        variante: v.id, conv, vn, senales: x.nSenales, colocadas: x.colocadas, cruzadas: x.cruzadas,
        fills: x.n, llenado: x.llenado, llenadoColocadas: x.llenadoColocadas, expiradas: x.skips.expiradas,
        opsMes: x.opsMes, premioMedio: prem, brutoPct: x.brutoPct, costoPct: x.costoPct, netoPct: x.netoPct,
        papelPct: x.brutoSinCclPct, cclPct: x.cclPct,
        tamMedio: x.tamMedio, producto, mensual: x.mensualPct, win: x.winRate, payoff: x.payoff,
        sharpe: x.sharpe, maxDD: x.maxDDpct, expoMax: x.expoMax, expoMedia: x.expoMedia,
        expectancy: x.expectancy, total: x.total, porExpo: x.expoMedia > 0 ? x.mensualPct / x.expoMedia : null,
        mensualGold: m.gold.mensualPct, mensualBlack: m.black.mensualPct,
        degeneradas: x.skips.degenerada,
      };
      const pe = x.expoMedia > 0 ? x.mensualPct / x.expoMedia : null;
      console.log(`  ${v.id.padEnd(11)} ${vn.padEnd(4)} ${String(x.nSenales).padStart(4)} ${String(x.n).padStart(5)} ${pct(x.llenado).padStart(8)} ${n2(x.opsMes, 1).padStart(8)} ${pct(prem, 2).padStart(7)} ${pct(x.brutoPct, 3).padStart(9)} ${pct(x.netoPct, 3).padStart(8)} ${pct(x.tamMedio, 1).padStart(6)} ${n2(producto).padStart(8)}% ${n2(x.mensualPct).padStart(7)}% ${n2(x.expoMedia, 2).padStart(8)} ${n2(pe).padStart(7)} ${pct(x.winRate).padStart(6)} ${n2(x.payoff).padStart(7)} ${n2(x.sharpe).padStart(7)} ${n2(x.maxDDpct, 1).padStart(5)}%`);
    }
  }

  /* ══════════ B · LA CONVENCIÓN DE STOP Y TARGET ══════════ */
  console.log(`\n===== B · STOP/TARGET FIJOS AL NIVEL vs MÓVILES CON LA ENTRADA =====`);
  /* CRITERIO PRE-DECLARADO, y mirando SÓLO el IS: gana la convención con mayor
   * retorno mensual PROMEDIO en el in-sample sobre las 5 variantes que no son
   * el caso base (en el base las dos convenciones son idénticas por
   * construcción: el fill es el nivel, así que las distancias relativas
   * coinciden). El conteo de celdas ganadas se reporta aparte porque cuenta
   * otra cosa y no siempre dice lo mismo. */
  out.B = {};
  let ganaFijo = 0, ganaMovil = 0;
  const isFijo = [], isMovil = [];
  for (const v of VARIANTES) for (const vn of ["IS", "OOS"]) {
    const f = AGR[`${v.id}|fijo|${vn}`].m.cocos, mo = AGR[`${v.id}|movil|${vn}`].m.cocos;
    const d = mo.mensualPct - f.mensualPct;
    if (v.id !== "nivel") {
      if (d > 0) ganaMovil++; else if (d < 0) ganaFijo++;
      if (vn === "IS") { isFijo.push(f.mensualPct); isMovil.push(mo.mensualPct); }
    }
    out.B[`${v.id}|${vn}`] = {
      fijo: { mensual: f.mensualPct, dd: f.maxDDpct, n: f.n, bruto: f.brutoPct, win: f.winRate, payoff: f.payoff },
      movil: { mensual: mo.mensualPct, dd: mo.maxDDpct, n: mo.n, bruto: mo.brutoPct, win: mo.winRate, payoff: mo.payoff },
      delta: d,
    };
    console.log(`  ${v.id.padEnd(11)} ${vn.padEnd(4)} fijo ${n2(f.mensualPct).padStart(6)}% (n=${String(f.n).padStart(3)}, bruto ${pct(f.brutoPct, 3)}, DD ${n2(f.maxDDpct, 1)}%)  ·  móvil ${n2(mo.mensualPct).padStart(6)}% (n=${String(mo.n).padStart(3)}, bruto ${pct(mo.brutoPct, 3)}, DD ${n2(mo.maxDDpct, 1)}%)  ·  Δ ${n2(d).padStart(6)} pp`);
  }
  const mediaFijo = mean(isFijo), mediaMovil = mean(isMovil);
  out.B._resumen = { ganaFijo, ganaMovil, mediaISfijo: mediaFijo, mediaISmovil: mediaMovil };
  console.log(`  celdas (sin el base, donde las dos convenciones coinciden): gana móvil ${ganaMovil}, gana fijo ${ganaFijo}`);
  console.log(`  criterio pre-declarado (promedio del mensual en el IS sobre las 5 variantes no-base): fijo ${n2(mediaFijo)}% · móvil ${n2(mediaMovil)}%`);

  /* ══════════ A.bis · DE DÓNDE SALEN LOS FILLS EXTRA ══════════ */
  console.log(`\n===== A.bis · LOS FILLS EXTRA: ¿valen lo mismo que los que tocaban el nivel? =====`);
  out.Abis = {};
  const convDom = mediaMovil >= mediaFijo ? "movil" : "fijo";
  console.log(`  (convención dominante del bloque B: ${convDom})`);
  for (const v of VARIANTES.slice(1)) for (const vn of ["IS", "OOS"]) {
    const { sim, ctx } = AGR[`${v.id}|${convDom}|${vn}`];
    const con = sim.trades.filter((t) => t.tocoNivel), sin = sim.trades.filter((t) => !t.tocoNivel);
    const rr = (arr) => {
      const legs = arr.flatMap((t) => t.legs);
      const nt = legs.reduce((s, l) => s + l.entN, 0);
      const br = legs.reduce((s, l) => s + l.bruto, 0);
      const fe = legs.reduce((s, l) => s + l.fees.cocos, 0);
      return { n: arr.length, brutoPct: nt > 0 ? br / nt : null, netoPct: nt > 0 ? (br - fe) / nt : null, pnl: br - fe, exp: arr.length ? (br - fe) / arr.length : null };
    };
    const a = rr(con), b = rr(sin);
    const rel = (t) => t.legs.reduce((s, l) => s + l.bruto, 0) / t.legs.reduce((s, l) => s + l.entN, 0);
    const w = welch(con.map(rel), sin.map(rel));
    out.Abis[`${v.id}|${vn}`] = { tocoNivel: a, noToco: b, welch: w };
    console.log(`  ${v.id.padEnd(11)} ${vn.padEnd(4)} tocó el nivel n=${String(a.n).padStart(3)} bruto ${pct(a.brutoPct, 3).padStart(8)} exp $${fmt(a.exp).padStart(8)}  ·  NO lo tocó n=${String(b.n).padStart(3)} bruto ${pct(b.brutoPct, 3).padStart(8)} exp $${fmt(b.exp).padStart(8)}  ·  Welch p=${w ? n2(w.p, 4) : "-"}`);
  }

  /* ══════════ A.ter · ¿ALPHA O BETA? ══════════
   * Entrar a mercado sube la exposición media de golpe. El control obligatorio
   * es comparar contra estar comprado y listo: buy & hold de los 38 papeles en
   * partes iguales, medido en pesos, escalado a la misma exposición media. */
  console.log(`\n===== A.ter · ¿ALPHA O BETA? · contra buy & hold de los 38 en pesos =====`);
  out.Ater = {};
  const BH = {};
  for (const vn of ["IS", "OOS"]) {
    BH[vn] = buyHold(CTX[vn], ccl);
    const b = BH[vn];
    out.Ater[`_bh/${vn}`] = b;
    console.log(`  [${vn}] buy & hold equiponderado de ${b.n} papeles en pesos: media ${pct(b.totalPct, 1)} total → ${n2(b.mensualPct)}%/mes · mediana ${pct(b.medianaPct, 1)} → ${n2(b.medianaMensualPct)}%/mes · SPY en pesos ${pct(b.spyTotalPct, 1)} → ${n2(b.spyMensualPct)}%/mes (maxDD ${n2(b.spyMaxDDpct, 1)}%, Sharpe ${n2(b.spySharpe)})`);
    console.log(`        índice equiponderado con rebalanceo diario: ${pct(b.idxTotalPct, 1)} total → ${n2(b.idxMensualPct)}%/mes · maxDD ${n2(b.idxMaxDDpct, 1)}% · Sharpe ${n2(b.idxSharpe)} · peor papel ${b.peor.s} ${pct(b.peor.r, 0)} · mejor ${b.mejor.s} ${pct(b.mejor.r, 0)}`);
  }
  console.log(`  benchmark primario = SPY en pesos (el más conservador de los tres: la media`);
  console.log(`  equiponderada la inflan NVDA/PLTR/MSTR y la mediana queda en el medio).`);
  console.log(`  ${"variante".padEnd(11)} ${"conv".padEnd(6)} ${"vn".padEnd(4)} ${"mensual".padStart(8)} ${"expoMed".padStart(8)} ${"SPY·expo".padStart(9)} ${"exceso".padStart(8)} ${"EW·expo".padStart(8)} ${"papel/op".padStart(9)} ${"CCL/op".padStart(8)}`);
  for (const conv of CONVS) for (const v of VARIANTES) for (const vn of ["IS", "OOS"]) {
    const x = AGR[`${v.id}|${conv}|${vn}`].m.cocos;
    const bench = BH[vn].spyMensualPct * x.expoMedia;
    const benchEW = BH[vn].mensualPct * x.expoMedia;
    const exceso = x.mensualPct - bench;
    out.Ater[`${v.id}|${conv}|${vn}`] = {
      mensual: x.mensualPct, expoMedia: x.expoMedia, benchmarkSpy: bench, exceso, benchmarkEW: benchEW,
      spyMensual: BH[vn].spyMensualPct, bhMensual: BH[vn].mensualPct, papelPct: x.brutoSinCclPct, cclPct: x.cclPct,
    };
    if (conv === convDom || v.id === "nivel") {
      console.log(`  ${v.id.padEnd(11)} ${conv.padEnd(6)} ${vn.padEnd(4)} ${n2(x.mensualPct).padStart(7)}% ${n2(x.expoMedia, 2).padStart(8)} ${n2(bench).padStart(8)}% ${n2(exceso).padStart(7)}% ${n2(benchEW).padStart(7)}% ${pct(x.brutoSinCclPct, 3).padStart(9)} ${pct(x.cclPct, 3).padStart(8)}`);
    }
  }

  /* ══════════ C · BARRIDO DE TAMAÑO ══════════ */
  console.log(`\n===== C · BARRIDO DE TAMAÑO · MAX_POS_PCT × tope de posiciones simultáneas =====`);
  console.log(`  (agresividad base = nivel exacto · convención ${convDom} · sin spread · CON apalancamiento permitido)`);
  const CAPS = [0.20, 0.30, 0.40, 0.50, 0.60];
  const POSS = [3, 5, 8, 10];
  out.C = {};
  for (const vn of ["IS", "OOS"]) {
    console.log(`\n  [${vn}] ${"cap".padStart(4)} ${"pos".padStart(4)} ${"n".padStart(4)} ${"mensual".padStart(8)} ${"maxDD".padStart(7)} ${"expoMax".padStart(8)} ${"expoMed".padStart(8)} ${"apal.req".padStart(9)} ${"sinApal".padStart(8)} ${"c/funding".padStart(8)} ${"Sharpe".padStart(7)}`);
    for (const cp of CAPS) for (const mp of POSS) {
      const techo = cp * mp;
      const r = correr(vn, { variante: VARIANTES[0], conv: convDom, capPct: cp, maxPos: mp, maxGross: Math.max(1, techo), spread: 0 });
      const x = r.m.cocos;
      const apal = x.expoMax;
      out.C[`${cp}|${mp}|${vn}`] = {
        capPct: cp, maxPos: mp, vn, n: x.n, mensual: x.mensualPct, maxDD: x.maxDDpct,
        expoMax: x.expoMax, expoMedia: x.expoMedia, compMax: x.compMax, sharpe: x.sharpe,
        sinApal: x.expoMax <= 1.05, apalReq: apal, opsMes: x.opsMes, brutoPct: x.brutoPct,
        apalMedia: x.apalMedia, costoFunding: x.costoFundingMensual, mensualConFunding: x.mensualConFunding,
        tamMedio: x.tamMedio, win: x.winRate, total: x.total,
      };
      console.log(`       ${pct(cp, 0).padStart(4)} ${String(mp).padStart(4)} ${String(x.n).padStart(4)} ${n2(x.mensualPct).padStart(7)}% ${n2(x.maxDDpct, 1).padStart(6)}% ${n2(x.expoMax, 2).padStart(8)} ${n2(x.expoMedia, 2).padStart(8)} ${(x.expoMax <= 1.05 ? "—" : n2(x.expoMax, 2) + "x").padStart(9)} ${(x.expoMax <= 1.05 ? "SÍ" : "NO").padStart(8)} ${n2(x.mensualConFunding).padStart(7)}% ${n2(x.sharpe).padStart(7)}`);
    }
  }

  /* ══════════ D · LA GRILLA COMBINADA ══════════ */
  console.log(`\n===== D · GRILLA COMBINADA · agresividad × tamaño (5 posiciones, convención ${convDom}, sin spread) =====`);
  out.D = {};
  for (const apalOn of [true, false]) {
    console.log(`\n  ### ${apalOn ? "CON apalancamiento permitido (exposición hasta cap×5)" : "SIN apalancamiento (exposición tope 100% del capital)"}`);
    for (const vn of ["IS", "OOS"]) {
      const filas = [];
      for (const v of VARIANTES) {
        const fila = { variante: v.id, celdas: {} };
        for (const cp of CAPS) {
          const r = correr(vn, { variante: v, conv: convDom, capPct: cp, maxPos: MAX_POS, maxGross: apalOn ? Math.max(1, cp * MAX_POS) : 1, spread: 0 });
          const x = r.m.cocos;
          fila.celdas[cp] = {
            mensual: x.mensualPct, maxDD: x.maxDDpct, n: x.n, expoMax: x.expoMax, expoMedia: x.expoMedia,
            sinApal: x.expoMax <= 1.05, sharpe: x.sharpe, opsMes: x.opsMes, brutoPct: x.brutoPct,
            netoPct: x.netoPct, tamMedio: x.tamMedio, llenado: x.llenado, win: x.winRate,
            srDiario: x.srDiario, rets: x.rets, total: x.total, apalMedia: x.apalMedia, costoFunding: x.costoFundingMensual, mensualConFunding: x.mensualConFunding,
          };
          out.D[`${apalOn ? "apal" : "noapal"}|${v.id}|${cp}|${vn}`] = { ...fila.celdas[cp], rets: undefined, variante: v.id, capPct: cp, vn, apal: apalOn };
        }
        filas.push(fila);
      }
      console.log(`\n  [${vn}] retorno mensual neto en Cocos (%) · entre paréntesis el max drawdown (%)`);
      console.log(`  ${"variante".padEnd(11)} ${CAPS.map((c) => (pct(c, 0) + "").padStart(17)).join("")}`);
      for (const f of filas) {
        console.log(`  ${f.variante.padEnd(11)} ${CAPS.map((c) => {
          const x = f.celdas[c];
          const marca = x.mensual >= 3 ? "*" : " ";
          const ap = x.sinApal ? " " : "^";
          return `${marca}${n2(x.mensual).padStart(6)}(${n2(x.maxDD, 1).padStart(4)})${ap}`.padStart(17);
        }).join("")}`);
      }
      console.log(`         * = llega o supera 3%/mes   ^ = necesita apalancamiento (exposición > 100%)`);
      if (!out.D._grillas) out.D._grillas = {};
      out.D._grillas[`${apalOn ? "apal" : "noapal"}|${vn}`] = filas.map((f) => ({
        variante: f.variante,
        celdas: Object.fromEntries(Object.entries(f.celdas).map(([k, v]) => [k, { ...v, rets: undefined }])),
      }));
    }
  }

  /* ── D.bis · las celdas que llegan a 3% y qué cuesta sostenerlas ── */
  console.log(`\n  --- D.bis · TODAS las celdas que llegan o superan 3%/mes, con su apalancamiento y su funding ---`);
  console.log(`  (funding = caución tomadora all-in 0,069% por día corrido sobre la parte de la exposición`);
  console.log(`   que excede el capital propio — INFORME-COCOS §6. El P&L de la grilla NO lo tiene cobrado.)`);
  console.log(`  ${"celda".padEnd(34)} ${"mensual".padStart(8)} ${"apalMax".padStart(8)} ${"apalMed".padStart(8)} ${"funding".padStart(8)} ${"neto".padStart(8)} ${"maxDD".padStart(7)}`);
  const tresPct = Object.entries(out.D).filter(([k, c]) => c && c.mensual >= 3).sort((a, b) => b[1].mensual - a[1].mensual);
  out.Dbis = {};
  for (const [k, c] of tresPct) {
    out.Dbis[k] = c;
    console.log(`  ${k.padEnd(34)} ${n2(c.mensual).padStart(7)}% ${n2(c.expoMax, 2).padStart(8)} ${n2(c.expoMedia, 2).padStart(8)} ${n2(c.costoFunding).padStart(7)}% ${n2(c.mensualConFunding).padStart(7)}% ${n2(c.maxDD, 1).padStart(6)}%`);
  }
  if (!tresPct.length) console.log(`  (ninguna)`);

  /* ══════════ E · WALK-FORWARD ESTRICTO ══════════ */
  console.log(`\n===== E · WALK-FORWARD ESTRICTO =====`);
  /* CRITERIO PRE-DECLARADO, fijado antes de mirar el OOS:
   *   se elige la celda con MAYOR retorno mensual neto en Cocos del IN-SAMPLE
   *   entre las alcanzables SIN apalancamiento (exposición bruta máxima <= 105%
   *   del capital; el margen de 5 puntos es porque un fill a mercado se ejecuta
   *   a un precio distinto del que reservó la orden y el bruto abierto puede
   *   pasarse unos puntos de la reserva), con al menos 30 trades en el IS.
   *   Empate → menor drawdown.
   *   Se EXCLUYE `mkt-close` de las candidatas: es la versión optimista del
   *   fill a mercado (asume ejecución instantánea al cierre de la barra que
   *   generó la señal) y la consigna es quedarse con la pesimista, `mkt-open`.
   *   mkt-close se reporta igual en todas las tablas, como cota superior.
   *   Se reporta además la mejor celda del IS sin la restricción de
   *   apalancamiento.
   * La celda ganadora del IS es la que se corre y reporta en el OOS. No se
   * elige mirando el OOS. */
  const candidatas = [];
  for (const v of VARIANTES) for (const cp of CAPS) for (const apalOn of [true, false]) {
    const k = `${apalOn ? "apal" : "noapal"}|${v.id}|${cp}|IS`;
    const c = out.D[k];
    if (c) candidatas.push({ ...c, clave: k, apalOn });
  }
  const sinOptimista = candidatas.filter((c) => c.variante !== "mkt-close");
  const elegibles = sinOptimista.filter((c) => c.expoMax <= 1.05 && c.n >= 30);
  elegibles.sort((a, b) => (b.mensual - a.mensual) || (a.maxDD - b.maxDD));
  const libres = [...sinOptimista].sort((a, b) => (b.mensual - a.mensual) || (a.maxDD - b.maxDD));
  const elegida = elegibles[0], mejorLibre = libres[0];
  console.log(`  criterio pre-declarado: mayor mensual del IS entre las celdas SIN apalancamiento (expoMax<=1,05) y con n>=30, excluyendo mkt-close (la versión optimista del fill a mercado).`);
  console.log(`  ELEGIDA (IS): ${elegida.variante} · cap ${pct(elegida.capPct, 0)} · ${convDom} · 5 posiciones → IS ${n2(elegida.mensual)}%/mes · DD ${n2(elegida.maxDD, 1)}% · n=${elegida.n} · expoMax ${n2(elegida.expoMax, 2)}`);
  console.log(`  (mejor del IS sin restricción de apalancamiento: ${mejorLibre.variante} · cap ${pct(mejorLibre.capPct, 0)} → ${n2(mejorLibre.mensual)}%/mes · DD ${n2(mejorLibre.maxDD, 1)}% · expoMax ${n2(mejorLibre.expoMax, 2)})`);

  const varOf = (id) => VARIANTES.find((v) => v.id === id);
  const runElegida = (vn, spread = 0) => correr(vn, {
    variante: varOf(elegida.variante), conv: convDom, capPct: elegida.capPct,
    maxPos: MAX_POS, maxGross: elegida.apalOn ? Math.max(1, elegida.capPct * MAX_POS) : 1, spread,
  });
  const runLibre = (vn, spread = 0) => correr(vn, {
    variante: varOf(mejorLibre.variante), conv: convDom, capPct: mejorLibre.capPct,
    maxPos: MAX_POS, maxGross: mejorLibre.apalOn ? Math.max(1, mejorLibre.capPct * MAX_POS) : 1, spread,
  });
  const eIS = runElegida("IS"), eOOS = runElegida("OOS");
  const lIS = runLibre("IS"), lOOS = runLibre("OOS");
  out.E = {
    criterio: "mayor mensual neto Cocos en IS entre celdas con exposición bruta máxima <= 100% y n>=30; desempate por menor drawdown",
    convDominante: convDom,
    elegida: { variante: elegida.variante, capPct: elegida.capPct, conv: convDom, maxPos: MAX_POS, apal: elegida.apalOn },
    mejorLibre: { variante: mejorLibre.variante, capPct: mejorLibre.capPct, conv: convDom, maxPos: MAX_POS, apal: mejorLibre.apalOn },
    resultado: {},
  };
  for (const [nm, r] of [["elegida/IS", eIS], ["elegida/OOS", eOOS], ["libre/IS", lIS], ["libre/OOS", lOOS]]) {
    const x = r.m.cocos;
    out.E.resultado[nm] = {
      n: x.n, llenado: x.llenado, opsMes: x.opsMes, brutoPct: x.brutoPct, netoPct: x.netoPct,
      tamMedio: x.tamMedio, mensual: x.mensualPct, win: x.winRate, payoff: x.payoff, sharpe: x.sharpe,
      maxDD: x.maxDDpct, expoMax: x.expoMax, expoMedia: x.expoMedia, total: x.total,
      apalMedia: x.apalMedia, costoFunding: x.costoFundingMensual, mensualConFunding: x.mensualConFunding,
      papelPct: x.brutoSinCclPct, cclPct: x.cclPct,
      benchmarkBH: BH[nm.endsWith("IS") ? "IS" : "OOS"].spyMensualPct * x.expoMedia,
      exceso: x.mensualPct - BH[nm.endsWith("IS") ? "IS" : "OOS"].spyMensualPct * x.expoMedia,
    };
    const o = out.E.resultado[nm];
    console.log(`  ${nm.padEnd(12)} n=${String(x.n).padStart(3)} · llenado ${pct(x.llenado).padStart(6)} · ops/mes ${n2(x.opsMes, 1).padStart(5)} · bruto/op ${pct(x.brutoPct, 3).padStart(8)} · mensual ${n2(x.mensualPct).padStart(6)}% · DD ${n2(x.maxDDpct, 1).padStart(5)}% · Sharpe ${n2(x.sharpe).padStart(6)} · expoMax ${n2(x.expoMax, 2)} · expoMed ${n2(x.expoMedia, 2)} · B&H·expo ${n2(o.benchmarkBH).padStart(6)}% · exceso ${n2(o.exceso).padStart(6)}%`);
  }
  console.log(`  BASE de referencia: IS ${n2(BASE.IS.m.cocos.mensualPct)}%/mes · OOS ${n2(BASE.OOS.m.cocos.mensualPct)}%/mes`);

  /* ── E.2 · modelos nulos de la celda elegida ── */
  if (!SIN_NULO) {
    console.log(`\n  --- E.2 · modelos nulos de la celda elegida (${DRAWS} sorteos, semilla ${SEED}) ---`);
    out.E.nulos = {};
    const rnd = mulberry32(SEED);

    /* Nulo 1 · SELECCIÓN DE ÓRDENES. La variante agresiva llena K de las N
     * señales emitidas. El nulo llena K señales elegidas AL AZAR entre las N,
     * a mercado (apertura de la barra siguiente), con el mismo tamaño. Si la
     * variante real no le gana, "las que bajaron al nivel" no son mejores que
     * "cualquiera comprada a mercado": el llenado sería sólo exposición. */
    for (const vn of ["IS", "OOS"]) {
      const r = vn === "IS" ? eIS : eOOS;
      const K = r.m.cocos.n, N = ORD[vn].length;
      const real = r.m.cocos.mensualPct;
      const nulos = [];
      const idx = ORD[vn].map((_, i) => i);
      for (let b = 0; b < DRAWS; b++) {
        const sel = new Set(sorteoK(idx, N, K, rnd));
        const s = simular(ORD[vn], CTX[vn], ccl, {
          variante: varOf("mkt-open"), conv: convDom, capPct: elegida.capPct, maxPos: MAX_POS,
          maxGross: elegida.apalOn ? Math.max(1, elegida.capPct * MAX_POS) : 1, spread: 0,
          light: true, soloIdx: sel,
        });
        const tot = s.trades.reduce((acc, tr) => acc + tr.legs.reduce((z, l) => z + l.pnl.cocos, 0), 0);
        nulos.push((tot / CAPITAL / CTX[vn].meses) * 100);
      }
      const u = ubicar(real, nulos);
      out.E.nulos[`seleccion/${vn}`] = { K, N, ...u };
      console.log(`    nulo selección · ${vn}: real ${n2(real)}% · mediana nulo ${n2(u.med)}% · percentil ${pct(u.percentil)} · p=${n2(u.p1cola, 4)} · p5-p95 ${n2(u.p05)} a ${n2(u.p95)}`);
    }

    /* Nulo 2 · EXPOSICIÓN. ¿La celda elegida le gana al caso base corrido con
     * la misma exposición bruta media? Es la perilla que mató al filtro de
     * volatilidad en INFORME.md §10, ahora del lado de arriba. */
    for (const vn of ["IS", "OOS"]) {
      const r = vn === "IS" ? eIS : eOOS;
      const objetivo = r.m.cocos.expoMedia;
      let mejor = null;
      for (let cp = 0.04; cp <= 1.5001; cp += 0.02) {
        const s = correr(vn, { variante: VARIANTES[0], conv: convDom, capPct: Math.round(cp * 100) / 100, maxPos: MAX_POS, maxGross: Math.max(1, cp * MAX_POS), spread: 0 }, true);
        const d = Math.abs(s.m.cocos.expoMedia - objetivo);
        if (!mejor || d < mejor.d) mejor = { d, cp: Math.round(cp * 100) / 100, m: s.m.cocos };
      }
      out.E.nulos[`exposicion/${vn}`] = {
        objetivoExpoMedia: objetivo, capPctEquivalente: mejor.cp,
        baseMensual: mejor.m.mensualPct, baseDD: mejor.m.maxDDpct, baseExpoMedia: mejor.m.expoMedia,
        baseExpoMax: mejor.m.expoMax, realMensual: r.m.cocos.mensualPct, realDD: r.m.cocos.maxDDpct,
        delta: r.m.cocos.mensualPct - mejor.m.mensualPct,
      };
      console.log(`    nulo exposición · ${vn}: la elegida usa expo media ${n2(objetivo, 2)}x → el BASE con cap ${pct(mejor.cp, 0)} usa ${n2(mejor.m.expoMedia, 2)}x y da ${n2(mejor.m.mensualPct)}%/mes (DD ${n2(mejor.m.maxDDpct, 1)}%) vs la elegida ${n2(r.m.cocos.mensualPct)}% (DD ${n2(r.m.cocos.maxDDpct, 1)}%) · Δ ${n2(r.m.cocos.mensualPct - mejor.m.mensualPct)} pp`);
    }

    /* Nulo 3 · BOOTSTRAP DE BLOQUES sobre la diferencia diaria de equity
     * (elegida − base), bloques de 10 ruedas, para un intervalo de confianza
     * de la mejora mensual. */
    for (const vn of ["IS", "OOS"]) {
      const r = vn === "IS" ? eIS : eOOS;
      const a = r.sim.equity, b = BASE[vn].sim.equity;
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
      const real = r.m.cocos.mensualPct - BASE[vn].m.cocos.mensualPct;
      out.E.nulos[`bootstrap/${vn}`] = {
        deltaReal: real, p05: muestras[Math.floor(DRAWS * 0.05)], p50: muestras[Math.floor(DRAWS * 0.5)],
        p95: muestras[Math.floor(DRAWS * 0.95)], pLeq0: muestras.filter((x) => x <= 0).length / DRAWS, dias: d.length,
      };
      const o = out.E.nulos[`bootstrap/${vn}`];
      console.log(`    bootstrap bloques · ${vn}: Δ real ${n2(real)} pp/mes · IC90 [${n2(o.p05)}, ${n2(o.p95)}] · p(Δ<=0) ${n2(o.pLeq0, 3)}`);
    }
  }

  /* ══════════ F · SENSIBILIDAD AL SPREAD ══════════ */
  console.log(`\n===== F · SENSIBILIDAD AL SPREAD DEL CEDEAR =====`);
  /* Calibración: cedear_fv_log (Supabase, sólo lectura, 1.750.080 filas,
   * 209 CEDEARs, 09/06 → 18/09/2026). Horquilla media (ask−bid)/mid de los
   * papeles del universo de 38: MSFT 0,170% · META 0,169% · MU 0,158% ·
   * NVDA 0,179% · MELI 0,180% · GOOGL 0,188% · MCD 0,191% · VIST 0,195% ·
   * TSLA 0,195% · AAPL 0,196% · UBER 0,198% · ORCL 0,218% · V 0,220% ·
   * PLTR 0,226% · IBM 0,231% · KO 0,232% · AMZN 0,232% · HPQ 0,241% ·
   * NFLX 0,246% · AMD 0,255% · AVGO 0,261% · MSTR 0,262% · WMT 0,292% ·
   * ADBE 0,295% · INTC 0,310% · COIN 0,360% · VST 0,376% · XOM 0,386% ·
   * QCOM 0,431% · HUT 0,443% · MRVL 0,453% · MRNA 0,869% · JNJ 0,969%.
   * Ponderada por cantidad de observaciones da ≈ 0,25%. Ése es el caso
   * central del barrido; 0,10% es el optimista de los cinco más líquidos y
   * 0,50% el pesimista. */
  const SPREADS = [0, 0.001, 0.0025, 0.005];
  out.F = { calibracion: { fuente: "supabase cedear_fv_log (solo lectura)", obs: 1750080, syms: 209, desde: "2026-06-09", hasta: "2026-09-18", mediaPonderada: 0.0025, rango: [0.00158, 0.00969] }, filas: {} };
  console.log(`  supuesto: se paga MEDIA horquilla en cada punta que cruza. La salida SIEMPRE cruza`);
  console.log(`  (el stop se vende contra el bid); la entrada cruza sólo si la orden es marketable`);
  console.log(`  (a mercado, o límite por encima del último precio). Calibración: media ponderada 0,25%.`);
  for (const nm of ["base", "elegida", "mejorLibre"]) {
    for (const vn of ["IS", "OOS"]) {
      const fila = {};
      for (const sp of SPREADS) {
        let r;
        if (nm === "base") r = correr(vn, { variante: VARIANTES[0], conv: convDom, capPct: CAP_PCT, maxPos: MAX_POS, maxGross: 1, spread: sp });
        else if (nm === "elegida") r = runElegida(vn, sp);
        else r = runLibre(vn, sp);
        fila[sp] = { mensual: r.m.cocos.mensualPct, dd: r.m.cocos.maxDDpct, n: r.m.cocos.n, costoPct: r.m.cocos.costoPct, cruzadas: r.m.cocos.cruzadas };
      }
      out.F.filas[`${nm}/${vn}`] = fila;
      console.log(`  ${nm.padEnd(11)} ${vn.padEnd(4)} ${SPREADS.map((s) => `${pct(s, 2)} → ${n2(fila[s].mensual).padStart(6)}%`).join("   ")}`);
    }
  }

  /* ══════════ G · DSR ══════════ */
  console.log(`\n===== G · DEFLATED SHARPE RATIO con el N actualizado =====`);
  const Nprev = prevCo.E.N;                    // 174
  const nNuevas = CELDAS.size;
  const N = Nprev + nNuevas;
  const Nparanoico = prevCo.E.Nparanoico + nNuevas;
  const sigPrev = prevCo.E.sigmaSR.cocos;      // 3,6560e-2, reconstruido sobre 160 variantes
  const srsNuevas = [...CELDAS.values()].map((x) => x.srCocos).filter((x) => x != null);
  const sigNuevas = stdev(srsNuevas);
  console.log(`  celdas nuevas evaluadas en este anexo: ${nNuevas} (variante × convención × capPct × maxPos × apalancamiento × ventana, deduplicadas)`);
  console.log(`  N ${Nprev} → ${N} · paranoico ${prevCo.E.Nparanoico} → ${Nparanoico}`);
  console.log(`  σ(SR) Cocos: publicado ${sigPrev.toExponential(4)} (160 variantes previas) · de las ${srsNuevas.length} celdas nuevas ${sigNuevas.toExponential(4)}`);
  out.G = { Nprev, nNuevas, N, Nparanoico, sigmaPrev: sigPrev, sigmaNuevas: sigNuevas, filas: {} };
  const agregar = (nombre, m, nrets) => {
    const d1 = dsr(m.rets, m.srDiario, sigPrev, N);
    const d2 = dsr(m.rets, m.srDiario, sigNuevas, N);
    const d3 = dsr(m.rets, m.srDiario, sigPrev, Nparanoico);
    const d0 = dsr(m.rets, m.srDiario, sigPrev, Nprev);
    out.G.filas[nombre] = {
      n: m.n, sharpe: m.sharpe, mensual: m.mensualPct,
      dsrN174: d0 ? d0.dsr : null, dsr: d1 ? d1.dsr : null,
      dsrSigmaNuevas: d2 ? d2.dsr : null, dsrParanoico: d3 ? d3.dsr : null,
      sr0: d1 ? d1.sr0 : null,
    };
    console.log(`    ${nombre.padEnd(34)} n=${String(m.n).padStart(3)} SR ${n2(m.sharpe).padStart(6)} · DSR(N=${Nprev}) ${d0 ? d0.dsr.toFixed(4) : "-"} → DSR(N=${N}) ${d1 ? d1.dsr.toFixed(4) : "-"} · σ nuevas ${d2 ? d2.dsr.toFixed(4) : "-"} · paranoico ${d3 ? d3.dsr.toFixed(4) : "-"}`);
  };
  agregar("base 20%/5 · IS", BASE.IS.m.cocos);
  agregar("base 20%/5 · OOS", BASE.OOS.m.cocos);
  agregar(`elegida (${elegida.variante}/${pct(elegida.capPct, 0)}) · IS`, eIS.m.cocos);
  agregar(`elegida (${elegida.variante}/${pct(elegida.capPct, 0)}) · OOS`, eOOS.m.cocos);
  agregar(`mejor libre (${mejorLibre.variante}/${pct(mejorLibre.capPct, 0)}) · IS`, lIS.m.cocos);
  agregar(`mejor libre (${mejorLibre.variante}/${pct(mejorLibre.capPct, 0)}) · OOS`, lOOS.m.cocos);

  /* ── huella de reproducibilidad ── */
  const digest = (() => {
    const nums = [];
    const walk = (o) => {
      if (o == null) return;
      if (typeof o === "number") { nums.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { if (k === "generado" || k.startsWith("_")) continue; walk(o[k]); } }
    };
    walk({ A: out.A, B: out.B, Abis: out.Abis, C: out.C, D: out.D, E: out.E, F: out.F, G: out.G });
    let h = 2166136261 >>> 0;
    for (const v of nums) {
      const s = Number.isFinite(v) ? v.toExponential(12) : String(v);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { nNumeros: nums.length, fnv1a: h.toString(16) };
  })();
  out.digest = digest;
  console.log(`\nhuella de reproducibilidad: ${digest.nNumeros} números · FNV-1a ${digest.fnv1a}`);
  fs.writeFileSync(path.join(DIR, "results-agresividad.json"), JSON.stringify(out, null, 1));
  console.log(`listo en ${((Date.now() - t0) / 1000).toFixed(1)} s → results-agresividad.json`);
}

main();
