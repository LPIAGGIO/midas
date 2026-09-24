/* barrido.js — ¿el barrido de un soporte se distingue del quiebre EN EL MOMENTO
 * DE ENTRAR?
 *
 * Origen: INFORME-TIMESTOP.md §4 dejó documentado que el motor re-deriva una
 * zona de soporte DISTINTA en la barra inmediatamente posterior al fill en el
 * 79% de los trades (85/110 IS + 75/92 OOS), y quedó abierta la pregunta de si
 * eso es una propiedad real de la señal o un artefacto de la granularidad
 * horaria. La hipótesis de microestructura: cuando el precio perfora un
 * soporte a veces lo BARRE (penetra poco y revierte) y a veces lo ROMPE
 * (penetra y sigue). Si son dos regímenes distinguibles en el momento del
 * fill, el bot está comprando en los dos sin diferenciarlos.
 *
 * Bloques:
 *   A) descriptivo: penetración post-entrada normalizada por ATR14, deciles,
 *      cruce con el camino de salida, y test de bimodalidad
 *   B) EL TEST PRIMARIO, PRE-REGISTRADO, UNA SOLA COMPARACIÓN: expectancy de
 *      "la zona aguanta" contra "la zona cedió", evaluado en la barra del fill
 *   C) cinco features point-in-time, lista cerrada, exploratorio
 *   D) el nulo de descarte aleatorio para todo corte que parezca prometedor
 *   E) artefacto o propiedad: el 79% recalculado con 4 tolerancias
 *
 * TODO local. No toca VPS, Supabase, ni ninguna tabla viva. ESM.
 *
 * Uso:
 *   node barrido.js                → corrida completa → results-barrido.json
 *   node barrido.js --draws=500    → menos sorteos (para probar rápido)
 *   node barrido.js --sinDSR       → saltea la reconstrucción del N (la cara)
 *
 * Reusa engine.js y el cache signals.json. El chequeo de arranque reproduce el
 * 38/base de INFORME.md (IS y OOS) con Δ = 0, el replayer reproduce el P&L de
 * la cartera trade por trade, y la reconstrucción de equity a partir de los
 * legs reproduce la curva diaria del caso base.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LB, ZONE_TOL, allPivots, clusterZones, buildDailyCtx, analyzeKit, gatePasa,
  scoreZone, patternAtZone, loadSeries, loadCcl, emaOf, emaStep, rsi14,
} from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = process.argv.slice(2);
const argN = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? Number(a.split("=")[1]) : d;
};
const DRAWS = argN("draws", 5000);
const SIN_DSR = ARGS.includes("--sinDSR");
const SEED = 20260917;                 // misma semilla que INFORME-NULO

/* ─────────────────────── PRNG reproducible ─────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── constantes: IDÉNTICAS a simulate.js / nulo.js (no tocar) ── */
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
  gold: 0.005 * IVA + DERECHOS,        // 0,6655%
  platinum: 0.003 * IVA + DERECHOS,    // 0,4235%
  black: 0.001 * IVA + DERECHOS,       // 0,1815%
};
const TIERS = ["gold", "platinum", "black"];
const DIAS_DAILY = 252, DIAS_HOURLY = 30;

const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";
const VENTANAS = { IS: [IS_DESDE, IS_HASTA], OOS: [OOS_DESDE, OOS_HASTA] };

const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TRUNCA_DAILY = { OKLO: "2024-05-10", RGTI: "2022-03-01", SATL: "2022-01-01", KEEL: "2026-04-06", LAR: "2025-01-27" };

/* el barrido de H que se reporta entero, sin elegir el mejor */
const HS = [8, 16, 24, 48, 72, 120, 168, 240];

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

/* ── features de SPY (sólo se usan para reconstruir el N del DSR) ── */
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

/* ────────────────── simulador (ctx precomputado) ──────────────────
 * Copia de simular() de nulo.js (que a su vez es la de simulate.js) con UN
 * agregado: el cierre post-fill. Dos formas:
 *   maxBarras  → time-stop por reloj: se cierra a mercado (cierre de la barra)
 *                cuando la posición lleva H barras horarias DEL PAPEL desde el
 *                fill. La barra del fill no cuenta (igual que en el resto del
 *                simulador, que no la juzga).
 *   razonMuerta(sym, t, pos) → true si en esta barra el motor ya no generaría
 *                la señal: se cierra a mercado.
 * El chequeo se hace DESPUÉS de stop / TP parcial / target / trailing: si la
 * barra tocó una salida real, gana la salida real. Sólo se cierra a mercado lo
 * que de verdad seguía abierto al cierre de esa barra. */
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
    out.push({
      ...s, riskMult: f.riskMult ?? 1,
      stop: s.entry - R * stopMult, target: s.entry + T * tgtMult,
      created: s.ts * 1000 + 1,
    });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}

function simular(ordenes, ctx, ccl, { light = false, exitMode = "intrabar", capPct = CAP_PCT, maxBarras = null, maxHorasCal = null, razonMuerta = null } = {}) {
  const { barAt, timeline, tFin, bars } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const skips = { openSym: 0, dupPend: 0, posMax: 0, entradasDia: 0, qtyCero: 0, reemplazadas: 0, expiradas: 0, sinFill: 0, sinBarras: 0 };
  const entradasDia = new Map();
  const realized = { gold: 0, platinum: 0, black: 0 };
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
      sym: pos.sym, qty, reason, entryTs: pos.entryTs, exitTs: ts,
      entN, bruto: outN - entN, brutoSinCcl: qty * (px - pos.entryPx) * pos.rIn,
      pnl: {}, fees: {},
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
        pend.delete(sym);
        const pos = {
          sym: p.sym, qty: p.qty, qty0: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          notional: p.qty * p.entry * p.rIn, legs: [], tpDone: false, barras: 0,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia, tsSenal: p.ts,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }

    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs) continue;
      pos.barras++;                       // barras de MERCADO del papel desde el fill
      const hi = exitMode === "close" ? b.c : b.h;
      const lo = exitMode === "close" ? b.c : b.l;
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
      // ── el agregado de este informe ──
      if (maxBarras != null && pos.barras >= maxBarras) {
        cerrarPata(pos, pos.qty, b.c, t, "timestop");
        open.delete(sym); continue;
      }
      if (maxHorasCal != null && (t - pos.entryTs) / 3600000 >= maxHorasCal) {
        cerrarPata(pos, pos.qty, b.c, t, "timestop");
        open.delete(sym); continue;
      }
      if (razonMuerta && razonMuerta(sym, t, pos)) {
        cerrarPata(pos, pos.qty, b.c, t, "razon_muerta");
        open.delete(sym); continue;
      }
    }

    if (!light) {
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
  return { trades, legs, skips, equity, realized, nSenales: ordenes.length };
}

/* ── replayer de UN trade, aislado de la cartera ────────────────────────
 * Camina las barras del papel desde el fill con las mismas reglas del
 * simulador y permite forzar un cierre a mercado en la barra `corte`
 * (1 = la primera barra después del fill). Con corte = null reproduce
 * exactamente lo que hizo la cartera — eso se verifica al arrancar.
 * Se usa para el time-stop AISLADO (mismo set de trades que el base, sin el
 * efecto de segundo orden de liberar la silla antes) y para los 5.000 sorteos
 * del nulo, que serían impagables re-simulando la cartera entera. */
function replayTrade(pos, ctx, ccl, corte = null) {
  const arr = ctx.serie[pos.sym], i0 = ctx.idx[pos.sym].get(pos.entryTs);
  const rArs = (d) => ccl(d) || 1;
  const out = { legs: [], pnl: { gold: 0, platinum: 0, black: 0 }, bruto: 0, entN: 0, barras: 0, salida: [] };
  let qty = pos.qty0, stop = pos.stopIni, tpDone = false;
  const cerrar = (q, px, ts, reason) => {
    const d = dia(ts / 1000);
    const intradia = dia(pos.entryTs / 1000) === d;
    const entN = q * pos.entryPx * pos.rIn;
    const outN = q * px * rArs(d);
    out.entN += entN; out.bruto += outN - entN;
    for (const tier of TIERS) out.pnl[tier] += outN - entN - (entN * FEE[tier] + outN * (intradia ? DERECHOS : FEE[tier]));
    out.salida.push(reason);
    out.legs.push({ qty: q, px, ts, reason });
  };
  let nb = 0;
  for (let k = i0 + 1; k < arr.length; k++) {
    const b = arr[k], t = b.ts * 1000;
    nb++; out.barras = nb;
    if (b.l <= stop) { cerrar(qty, stop, t, stop > pos.stopIni ? "trailing" : "stop"); return out; }
    if (TP_FRAC > 0 && !tpDone) {
      const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
      if (b.h >= nivel) { cerrar(qty / 2, Math.min(nivel, pos.target), t, "tp_parcial"); qty -= qty / 2; tpDone = true; }
    }
    if (b.h >= pos.target) { cerrar(qty, pos.target, t, "target"); return out; }
    const kk = Math.floor((b.h - pos.entryPx) / pos.R);
    if (kk >= 2 && pos.entryPx + (kk - 2) * pos.R > stop) stop = pos.entryPx + (kk - 2) * pos.R;
    if (corte != null && nb >= corte) { cerrar(qty, b.c, t, "timestop"); return out; }
  }
  const ult = arr[arr.length - 1];
  cerrar(qty, ult ? ult.c : pos.entryPx, ctx.tFin, "fin_ventana");
  return out;
}

/* primera barra (1 = la siguiente al fill) en la que ya pasaron Hc horas
 * CORRIDAS desde el fill; null si el trade no llega a vivir tanto */
function barraDeHoras(pos, ctx, Hc, vida) {
  const arr = ctx.serie[pos.sym], i0 = ctx.idx[pos.sym].get(pos.entryTs);
  for (let k = 1; k <= vida; k++) {
    const b = arr[i0 + k];
    if (!b) return null;
    if ((b.ts * 1000 - pos.entryTs) / 3600000 >= Hc) return k;
  }
  return null;
}

/* ───────────── motor barra por barra, por símbolo (para el bloque D) ─────
 * Copia de analizadorRapido() de simulate.js, con dos cambios de forma:
 * devuelve también las piezas intermedias (para poder evaluar el nivel
 * ORIGINAL y no sólo la zona más cercana al spot) y cachea el contexto diario
 * por símbolo, porque acá se salta entre papeles dentro de la misma rueda. */
function analizadorPorSimbolo(D, H) {
  const pivH = allPivots(H, LB, "h");
  const cumV = new Array(H.length + 1).fill(0);
  for (let k = 0; k < H.length; k++) cumV[k + 1] = cumV[k] + H[k].v;
  const lo = (arr, idx) => {
    let a = 0, b = arr.length;
    while (a < b) { const m = (a + b) >> 1; if (arr[m].i < idx) a = m + 1; else b = m; }
    return a;
  };
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
      const sel = (arr) => {
        const out = [];
        for (let k = lo(arr, h0 + LB); k < arr.length && arr[k].i <= conf; k++) out.push(fixVr(arr[k]));
        return out;
      };
      return { ctx, partial, hourly: H.slice(h0, i + 1), hourPivs: { his: sel(pivH.his), los: sel(pivH.los) }, spot: bar.c };
    },
  };
}

/* ── evaluación del NIVEL ORIGINAL (variante "ancla" del bloque D) ────────
 * analyzeKit() sólo puntúa la zona más cercana debajo del spot. Acá hace
 * falta puntuar la zona en la que el bot COMPRÓ, esté donde esté el precio.
 * Esto es una copia de la segunda mitad de analyzeKit() con la zona fijada por
 * el nivel de entrada en vez de por el spot. */
function evalAncla({ ctx, partial, hourly, hourPivs, spot }, ancla) {
  const dailyFull = partial ? [...ctx.win, partial] : ctx.win;
  const closes = partial ? [...ctx.closes, partial.c] : ctx.closes;
  const emas = partial
    ? { 21: emaStep(ctx.ema[21], partial.c, 21), 50: emaStep(ctx.ema[50], partial.c, 50), 200: emaStep(ctx.ema[200], partial.c, 200) }
    : ctx.ema;
  const supZ = clusterZones([...ctx.dp.los, ...hourPivs.los]);
  const resZ = clusterZones([...ctx.dp.his, ...hourPivs.his]);
  let atr = 0;
  for (let i = Math.max(1, dailyFull.length - 14); i < dailyFull.length; i++) {
    atr += Math.max(dailyFull[i].h - dailyFull[i].l, Math.abs(dailyFull[i].h - dailyFull[i - 1].c), Math.abs(dailyFull[i].l - dailyFull[i - 1].c));
  }
  atr /= Math.min(14, dailyFull.length - 1);

  // ¿sigue existiendo la zona donde compró? (techo dentro de ±0,6%, la misma
  // tolerancia con la que el motor agrupa pivotes en una zona)
  // la zona MÁS CERCANA al nivel original, no la primera dentro de la
  // tolerancia: dos zonas vecinas pueden tener el techo a menos de 0,6% una de
  // otra y agarrar la de abajo cambia el score (self-check: sin esto el
  // evaluador reproduce el score de la señal en 93/205 en vez de en casi todas)
  let z = null, mejor = Infinity;
  for (const zz of supZ) {
    const d = Math.abs(zz.hi - ancla) / ancla;
    if (d <= ZONE_TOL && d < mejor) { mejor = d; z = zz; }
  }
  if (!z) return { zona: false, motivo: "zona disuelta", score: null, rr: null };
  // OJO: NO se testea "spot por debajo del piso de la zona" como muerte. La
  // perforación del soporte ya la cubre el stop, que está 0,7% por debajo del
  // piso; agregarla acá sería un segundo stop disfrazado y mataría la mitad de
  // los trades en la barra siguiente al fill por pura mecánica (el fill ocurre
  // justo cuando el precio toca el techo de la zona y la entra).

  const below = supZ.filter((x) => x.hi < z.lo * 0.995);
  const stopLvl = below.length ? below[below.length - 1].lo * 0.993 : z.hi - atr;
  const sellsAbove = resZ.filter((x) => x.lo > spot * 1.001);
  const sellZone = sellsAbove.length ? sellsAbove[0] : null;
  const rr = sellZone && stopLvl && z.hi - stopLvl > 0
    ? Math.round(((sellZone.lo - z.hi) / (z.hi - stopLvl)) * 10) / 10 : null;

  const sc = scoreZone(z, emas);
  const pat = patternAtZone(dailyFull, z, "sup") || (hourly ? patternAtZone(hourly, z, "sup") : null);
  if (pat && pat.bull) sc.score += 1;
  if (ctx.div.bull) sc.score += 1;
  if (ctx.poc && Math.abs(ctx.poc - z.avg) / z.avg <= 0.01) sc.score += 1;
  // volEnZona: igual que analyzeKit, devuelve null (y NO ajusta el score) si
  // la zona tiene un solo pivote (lo === hi). Sin este detalle, las zonas de un
  // toque se comían un -1 que el motor no aplica.
  if (ctx.prof && z.hi > z.lo) {
    let acc = 0;
    for (const b of ctx.prof.bins) {
      const ov = Math.min(z.hi, b.hi) - Math.max(z.lo, b.lo);
      if (ov > 0) acc += b.pct * (ov / (b.hi - b.lo));
    }
    if (acc >= 6) sc.score += 1; else if (acc < 1.5) sc.score -= 1;
  }
  if (ctx.estr === "alcista") sc.score += 1; else if (ctx.estr === "bajista") sc.score -= 1;
  const low20 = Math.min(...dailyFull.slice(-20).map((c) => c.l));
  const ct = ctx.estr === "bajista" && dailyFull[dailyFull.length - 1].l <= low20 * 1.01;
  if (ct) sc.score = Math.min(sc.score, 4);
  const score = Math.max(1, Math.min(10, sc.score));

  return { zona: true, ct, score, rr };
}
/* motivo de muerte según la variante: D2 = el gate entero sobre el nivel
 * original; D3 = sólo el nivel (sin la condición de R:R, que después del fill
 * está contaminada: el target es "la resistencia más cercana ARRIBA DEL SPOT",
 * y el fill baja el spot, así que puede aparecer una resistencia intermedia y
 * el R:R se desploma sin que al soporte le haya pasado nada) */
function motivoMuerte(an, conRR) {
  if (!an.zona) return an.motivo || "zona disuelta";
  if (an.ct) return "contra-tendencia";
  if (an.score < 7) return "score < 7";
  if (conRR && (an.rr == null || an.rr < 2)) return "R:R < 2";
  return null;
}

/* ─────────────────────────── métricas y estadística ─────────────────── */
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
  const notional = sim.legs.reduce((s, l) => s + l.entN, 0);
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, expectancy: n ? total / n : null,
    brutoPct: notional > 0 ? sim.legs.reduce((s, l) => s + l.bruto, 0) / notional : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    sharpe, maxDDpct: dd * 100, srDiario: sd > 0 ? m / sd : null, rets,
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

/* rangos con empates promediados */
function rangos(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const rr = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = rr;
    i = j + 1;
  }
  return r;
}

/* Spearman + p a dos colas (aproximación t → normal; con n de 90-200 la
 * diferencia contra la t exacta está en la 3ª decimal) */
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

/* percentil del valor real dentro de la distribución nula + p de una cola
 * (p = P(nulo >= real): chico = la regla le gana al azar) */
function ubicar(real, nulos) {
  const B = nulos.length;
  const menores = nulos.filter((x) => x < real).length;
  const iguales = nulos.filter((x) => x === real).length;
  const s = [...nulos].sort((x, y) => x - y);
  return {
    percentil: (menores + 0.5 * iguales) / B,
    p1cola: (nulos.filter((x) => x >= real).length + 1) / (B + 1),
    B, med: s[Math.floor(B / 2)], p05: s[Math.floor(B * 0.05)], p95: s[Math.floor(B * 0.95)],
    mediaNulo: mean(nulos), sdNulo: stdev(nulos), real,
  };
}

function sorteoK(idx, N, K, rnd) {
  for (let i = 0; i < K; i++) { const j = i + Math.floor(rnd() * (N - i)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx.slice(0, K);
}

/* ─────────────────────────────── main ─────────────────────────────── */
const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pct = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));

/* ── t de Student: CDF por beta incompleta ───────────────────────────────
 * INFORME-NULO e INFORME-TIMESTOP usan la aproximación normal para el p de
 * Welch, que con n de 40-150 por grupo difiere en la 3ª decimal. Acá algunos
 * grupos tienen n = 20 (cuartiles de 94 trades), donde la normal ya miente en
 * la 2ª: se usa la t exacta y se reporta también la normal para poder
 * comparar contra los informes anteriores. */
function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-16;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function ibeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
// P(|T_df| >= |t|)
const tP2 = (t, df) => (!(df > 0) ? 1 : !isFinite(t) ? 0 : ibeta(df / 2, 0.5, df / (df + t * t)));

/* Welch, con p a dos colas por t exacta (p2) y por normal (p2norm, que es la
 * convención de los informes anteriores). */
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return null;
  const ma = mean(a), mb = mean(b), sa = stdev(a), sb = stdev(b);
  const se = Math.sqrt((sa * sa) / na + (sb * sb) / nb);
  const t = se > 0 ? (ma - mb) / se : 0;
  const df = se > 0
    ? ((sa * sa) / na + (sb * sb) / nb) ** 2 / (((sa * sa) / na) ** 2 / (na - 1) + ((sb * sb) / nb) ** 2 / (nb - 1))
    : 0;
  return { na, nb, ma, mb, sa, sb, se, t, df, p2: tP2(t, df), p2norm: 2 * (1 - normCdf(Math.abs(t))) };
}

/* cuantiles con interpolación lineal (tipo 7) */
function cuantil(v, q) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}

/* ── equity diaria reconstruida a partir de los legs de un SUBCONJUNTO de
 * trades del caso base. Replica paso por paso lo que hace simular(): los legs
 * se realizan en su exitTs, las abiertas se marcan al cierre de la barra y la
 * última fila del día final va sin no-realizado. Se verifica al arrancar: con
 * el set COMPLETO tiene que reproducir la curva del caso base. */
function equityDeTrades(trs, ctx) {
  const { barAt, timeline } = ctx;
  const porTs = new Map();
  const entraEn = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const tr of trs) {
    push(entraEn, tr.entryTs, tr);
    for (const l of tr.legs) push(porTs, l.exitTs, { tr, leg: l });
  }
  const realized = { gold: 0, platinum: 0, black: 0 };
  const abiertas = new Map();
  const equity = [];
  for (const t of timeline) {
    for (const tr of entraEn.get(t) || []) abiertas.set(tr, tr.qty0);
    for (const { tr, leg } of porTs.get(t) || []) {
      for (const tier of TIERS) realized[tier] += leg.pnl[tier];
      const q = (abiertas.get(tr) ?? 0) - leg.qty;
      if (q > 1e-9) abiertas.set(tr, q); else abiertas.delete(tr);
    }
    let unreal = 0;
    for (const [tr, q] of abiertas) {
      const b = barAt[tr.sym].get(t);
      unreal += q * ((b ? b.c : tr.entryPx) - tr.entryPx) * tr.rIn;
    }
    const d = dia(t / 1000);
    const row = { dia: d, eq: {} };
    for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
    if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row;
    else equity.push(row);
  }
  if (equity.length) {
    const last = equity[equity.length - 1];
    for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier];
  }
  return equity;
}

/* métricas de un subconjunto de trades, sin re-simular la cartera (el "modo
 * aislado" de INFORME-TIMESTOP §B: el mismo set de trades, sin el efecto de
 * segundo orden de liberar la silla antes) */
function metricasSub(trs, ctx) {
  const equity = equityDeTrades(trs, ctx);
  const sim = { trades: trs, legs: trs.flatMap((t) => t.legs), equity };
  return Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
}

/* mezcla de 2 gaussianas por EM, para el test de bimodalidad (BIC contra una
 * sola componente). Determinista: arranca en los cuantiles 1/4 y 3/4. */
function em2(x, iters = 500) {
  const n = x.length;
  if (n < 20) return null;
  const m = mean(x), sd = stdev(x);
  let mu1 = cuantil(x, 0.25), mu2 = cuantil(x, 0.75), s1 = sd / 2, s2 = sd / 2, w = 0.5;
  const dn = (v, mu, s) => Math.exp(-((v - mu) ** 2) / (2 * s * s)) / (s * Math.sqrt(2 * Math.PI));
  for (let it = 0; it < iters; it++) {
    const r = x.map((v) => {
      const a = w * dn(v, mu1, s1), b = (1 - w) * dn(v, mu2, s2);
      return a + b > 0 ? a / (a + b) : 0.5;
    });
    const sr = r.reduce((s, v) => s + v, 0);
    if (!(sr > 1e-9) || !(n - sr > 1e-9)) break;
    mu1 = x.reduce((s, v, i) => s + r[i] * v, 0) / sr;
    mu2 = x.reduce((s, v, i) => s + (1 - r[i]) * v, 0) / (n - sr);
    s1 = Math.max(1e-6, Math.sqrt(x.reduce((s, v, i) => s + r[i] * (v - mu1) ** 2, 0) / sr));
    s2 = Math.max(1e-6, Math.sqrt(x.reduce((s, v, i) => s + (1 - r[i]) * (v - mu2) ** 2, 0) / (n - sr)));
    w = sr / n;
  }
  const ll2 = x.reduce((s, v) => s + Math.log(Math.max(1e-300, w * dn(v, mu1, s1) + (1 - w) * dn(v, mu2, s2))), 0);
  const ll1 = x.reduce((s, v) => s + Math.log(Math.max(1e-300, dn(v, m, sd))), 0);
  return {
    n, mu1, s1, mu2, s2, w, ll1, ll2,
    bic1: -2 * ll1 + 2 * Math.log(n), bic2: -2 * ll2 + 5 * Math.log(n),
    sep: Math.abs(mu2 - mu1) / Math.sqrt((s1 * s1 + s2 * s2) / 2),
    // ¿la mezcla ajustada tiene DOS modas de verdad? Que el BIC prefiera dos
    // componentes no alcanza: una mezcla de dos gaussianas con los centros
    // pegados es unimodal, y el BIC igual la elige por asimetría.
    modos: contarModas((v) => w * dn(v, mu1, s1) + (1 - w) * dn(v, mu2, s2), Math.min(mu1, mu2) - 4 * sd, Math.max(mu1, mu2) + 4 * sd),
  };
}
function contarModas(f, a, b, pasos = 4000) {
  let modos = 0, p = -Infinity, p2 = -Infinity;
  for (let i = 0; i <= pasos; i++) {
    const v = f(a + ((b - a) * i) / pasos);
    if (p > p2 && p > v) modos++;
    p2 = p; p = v;
  }
  return modos;
}
/* densidad kernel gaussiana + ancho de banda crítico (Silverman 1981): el h
 * más chico que deja UNA sola moda. Si el crítico está cerca del h de
 * referencia, las modas extra del h de referencia son ruido de muestra. */
function kdeModas(x) {
  const n = x.length;
  const m = mean(x), sd = stdev(x);
  const s = [...x].sort((a, b) => a - b);
  const iqr = s[Math.floor(n * 0.75)] - s[Math.floor(n * 0.25)];
  const hRef = 0.9 * Math.min(sd, iqr / 1.34) * Math.pow(n, -0.2);
  const dn = (v, mu, h) => Math.exp(-((v - mu) ** 2) / (2 * h * h)) / (h * Math.sqrt(2 * Math.PI));
  const dens = (h) => (v) => x.reduce((acc, u) => acc + dn(v, u, h), 0) / n;
  const lo = s[0] - 4 * sd, hi = s[n - 1] + 4 * sd;
  const modasCon = (h) => contarModas(dens(h), lo, hi, 4000);
  let a = hRef / 8, b = hRef * 8;
  if (modasCon(b) > 1) return { hRef, modasRef: modasCon(hRef), hCrit: null, ratio: null };
  for (let it = 0; it < 40; it++) { const mid = (a + b) / 2; if (modasCon(mid) > 1) a = mid; else b = mid; }
  return { hRef, modasRef: modasCon(hRef), hCrit: b, ratio: b / hRef };
}

/* ─────────────────────────────── main ─────────────────────────────── */
function main() {
  const t0 = Date.now();
  const all = cargarTodo();
  const senales = cargarSenales();
  const ccl = loadCcl(DATA);
  const U38 = new Set(LIMPIOS_38.filter((s) => all.syms.includes(s)));
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
  const prevRc = JSON.parse(fs.readFileSync(path.join(DIR, "results-recompra.json"), "utf8"));
  const prevNu = JSON.parse(fs.readFileSync(path.join(DIR, "results-nulo.json"), "utf8"));
  const prevTs = JSON.parse(fs.readFileSync(path.join(DIR, "results-timestop.json"), "utf8"));
  console.log(`series ${all.syms.length} · señales ${senales.length} · universo limpio ${U38.size} · sorteos ${DRAWS} · semilla ${SEED}`);

  const out = { generado: new Date().toISOString(), semilla: SEED, draws: DRAWS };
  const gateBase = (s) => {
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };

  /* ══════════ 0 · CHEQUEO DE ARRANQUE ══════════ */
  console.log(`\n===== 0 · CHEQUEO DE ARRANQUE =====`);
  const BASE = {};
  out.chequeo = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = construirCtx(all.hourly, U38, ...VENTANAS[vn]);
    const ord = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase);
    const sim = simular(ord, ctx, ccl);
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    BASE[vn] = { ctx, ord, sim, m };
    const ref = prev.corridas[`38/base/${vn}`].metricas.gold;
    const d1 = Math.abs(m.gold.mensualPct - ref.mensualPct), d2 = Math.abs(m.gold.total - ref.total);
    out.chequeo[vn] = { mensual: m.gold.mensualPct, ref: ref.mensualPct, dMensual: d1, dTotal: d2, n: m.gold.n, nRef: ref.n };
    console.log(`  ${vn}: trades ${m.gold.n} (informe ${ref.n}) · mensual gold ${n2(m.gold.mensualPct)}% (informe ${n2(ref.mensualPct)}%) · Δ=${d1.toExponential(1)} · ΔP&L=${d2.toExponential(1)}`);
  }
  let okRep = 0, totRep = 0, maxDif = 0;
  for (const vn of ["IS", "OOS"]) for (const tr of BASE[vn].sim.trades) {
    totRep++;
    const r = replayTrade(tr, BASE[vn].ctx, ccl, null);
    const dif = Math.abs(r.pnl.gold - tr.legs.reduce((s, l) => s + l.pnl.gold, 0));
    maxDif = Math.max(maxDif, dif);
    if (dif < 1e-6) okRep++;
  }
  out.chequeo.replay = { ok: okRep, tot: totRep, maxDif };
  console.log(`  replayer de trades == cartera en ${okRep}/${totRep} trades (máxima diferencia $${maxDif.toExponential(2)})`);
  let okEq = 0, totEq = 0, maxEq = 0;
  for (const vn of ["IS", "OOS"]) {
    const eq = equityDeTrades(BASE[vn].sim.trades, BASE[vn].ctx), ref = BASE[vn].sim.equity;
    for (let i = 0; i < Math.max(eq.length, ref.length); i++) {
      totEq++;
      const d = eq[i] && ref[i] && eq[i].dia === ref[i].dia ? Math.abs(eq[i].eq.gold - ref[i].eq.gold) : Infinity;
      maxEq = Math.max(maxEq, d);
      if (d < 1e-6) okEq++;
    }
  }
  out.chequeo.equity = { ok: okEq, tot: totEq, maxDif: maxEq };
  console.log(`  equity reconstruida == simulador en ${okEq}/${totEq} ruedas (máxima diferencia $${maxEq.toExponential(2)})`);

  /* ══════════ 1 · MEDICIÓN POINT-IN-TIME SOBRE LOS 205 TRADES ══════════ */
  console.log(`\n===== 1 · MEDICIÓN POINT-IN-TIME SOBRE LOS 205 TRADES =====`);
  const ANA = {};
  const getAna = (sym) => (ANA[sym] || (ANA[sym] = analizadorPorSimbolo(all.daily[sym], all.hourly[sym])));
  const TOLS = [0.0025, 0.005, 0.01, 0.02];
  const NPREV = 40;   // ventana fija del feature 4 (barrido previo). NO se barre.
  const TR = {};
  let okZona = 0, totZona = 0;

  for (const vn of ["IS", "OOS"]) {
    const ctx = BASE[vn].ctx;
    TR[vn] = BASE[vn].sim.trades.map((tr) => {
      const a = getAna(tr.sym);
      const legs = tr.legs;
      const entN = legs.reduce((s, l) => s + l.entN, 0);
      const bruto = legs.reduce((s, l) => s + l.bruto, 0);
      const salida = legs.map((l) => l.reason).join("+");
      const vida = replayTrade(tr, ctx, ccl, null).barras;
      const iFill = a.idxDe(tr.entryTs);
      const H = all.hourly[tr.sym];

      // (a) la zona ORIGINAL, tal como la emitió el motor en la barra de la señal
      const iSen = a.idxDe(tr.tsSenal * 1000);
      let zona = null;
      if (iSen != null) { const pz = a.piezas(iSen); if (pz) { const k = analyzeKit(pz); zona = k.buyZone || null; } }
      totZona++;
      if (zona && Math.abs(zona.hi - tr.entryPx) / tr.entryPx < 1e-9) okZona++;

      // (b) el motor evaluado EN LA BARRA DEL FILL (el test primario) y en la
      //     barra SIGUIENTE al fill (el 79% de INFORME-TIMESTOP)
      const evalEn = (i) => {
        if (i == null) return null;
        const pz = a.piezas(i);
        if (!pz) return null;
        const k = analyzeKit(pz);
        return { buy: k.buy, score: k.score, rr: k.rr, atr: k.atr, spot: k.spot, ct: k.contraTendencia };
      };
      const enFill = evalEn(iFill);
      const enSig = evalEn(iFill != null && iFill + 1 < H.length ? iFill + 1 : null);
      const mismaCon = (e, tol) => (e == null || e.buy == null ? false : Math.abs(e.buy - tr.entryPx) / tr.entryPx <= tol);

      // (c) penetración: cuánto más abajo del nivel llegó el precio
      const arr = ctx.serie[tr.sym], i0 = ctx.idx[tr.sym].get(tr.entryTs);
      let minDesdeFill = arr[i0].l, minPostFill = Infinity;
      for (let k = 1; k <= vida; k++) {
        const b = arr[i0 + k];
        if (!b) break;
        minDesdeFill = Math.min(minDesdeFill, b.l);
        minPostFill = Math.min(minPostFill, b.l);
      }
      const atr = enFill && enFill.atr > 0 ? enFill.atr : null;
      const barFill = arr[i0];

      // (d) los cinco features, todos medibles en o antes de la barra del fill
      // f1: profundidad YA ocurrida al momento del fill. OJO: el simulador
      //     llena al nivel exacto, así que (nivel − precio de fill) es CERO
      //     por construcción; lo observable es lo que penetró la barra del
      //     fill → (nivel − low de la barra)/ATR14.
      const f1 = atr ? (tr.entryPx - barFill.l) / atr : null;
      // f2: barras desde el PRIMER toque de la zona dentro de la ventana de
      //     NPREV barras previas al fill (0 = no hubo toque previo en esa
      //     ventana, o sea que la barra del fill es el primer toque)
      let f2 = 0;
      if (zona && iFill != null) {
        for (let k = Math.max(0, iFill - NPREV); k < iFill; k++) {
          if (H[k].l <= zona.hi) { f2 = iFill - k; break; }
        }
      }
      // f3: volumen de la barra del fill sobre la media de las 20 previas
      let f3 = null;
      if (iFill != null && iFill >= 20) {
        let s = 0;
        for (let k = iFill - 20; k < iFill; k++) s += H[k].v;
        const avg = s / 20;
        f3 = avg > 0 ? barFill.v / avg : null;
      }
      // f4: ¿la zona ya había sido tocada en las últimas NPREV barras?
      const f4 = f2 > 0 ? 1 : 0;
      // f5: posición del fill dentro del rango de su barra
      const rng = barFill.h - barFill.l;
      const f5 = rng > 0 ? (tr.entryPx - barFill.l) / rng : null;

      return {
        sym: tr.sym, dia: tr.dia, score: tr.score, rr: tr.rr, salida, vida,
        entN, bruto, brutoPct: entN > 0 ? bruto / entN : 0,
        gold: legs.reduce((s, l) => s + l.pnl.gold, 0),
        platinum: legs.reduce((s, l) => s + l.pnl.platinum, 0),
        black: legs.reduce((s, l) => s + l.pnl.black, 0),
        entry: tr.entryPx, stopIni: tr.stopIni, atr,
        zonaLo: zona ? zona.lo : null, zonaHi: zona ? zona.hi : null,
        penAtr: atr ? (tr.entryPx - minDesdeFill) / atr : null,
        penPostAtr: atr && isFinite(minPostFill) ? (tr.entryPx - minPostFill) / atr : null,
        penPct: (tr.entryPx - minDesdeFill) / tr.entryPx,
        stopAtr: atr ? (tr.entryPx - tr.stopIni) / atr : null,
        aguanta: mismaCon(enFill, 0.005) ? 1 : 0,
        buyFill: enFill ? enFill.buy : null, spotFill: enFill ? enFill.spot : null,
        buySig: enSig ? enSig.buy : null,
        aguantaTol: Object.fromEntries(TOLS.map((t) => [t, mismaCon(enFill, t) ? 1 : 0])),
        aguantaSigTol: Object.fromEntries(TOLS.map((t) => [t, mismaCon(enSig, t) ? 1 : 0])),
        sinNivelFill: enFill && enFill.buy == null ? 1 : 0,
        sinNivelSig: enSig && enSig.buy == null ? 1 : 0,
        distFill: enFill && enFill.buy != null ? (tr.entryPx - enFill.buy) / tr.entryPx : null,
        distSig: enSig && enSig.buy != null ? (tr.entryPx - enSig.buy) / tr.entryPx : null,
        f1, f2, f3, f4, f5,
        _tr: tr,
      };
    });
  }
  out.selfCheckZona = { ok: okZona, tot: totZona };
  console.log(`  la zona reconstruida en la barra de la señal reproduce el nivel de entrada en ${okZona}/${totZona} trades`);
  const TODOS = [...TR.IS, ...TR.OOS];
  console.log(`  trades sin ATR14 utilizable: ${TODOS.filter((x) => x.atr == null).length} · sin zona reconstruida: ${TODOS.filter((x) => x.zonaHi == null).length}`);

  /* ══════════ A · DESCRIPTIVO: LA PENETRACIÓN ══════════ */
  console.log(`\n===== A · PENETRACIÓN POST-ENTRADA, NORMALIZADA POR ATR14 =====`);
  out.A = {};
  const CAMINOS = ["stop", "tp_parcial+stop", "tp_parcial+target", "tp_parcial+trailing"];
  const nombreCamino = (s) => (CAMINOS.includes(s) ? s : "otros");
  for (const vn of ["IS", "OOS"]) {
    const arr = TR[vn].filter((x) => x.penAtr != null);
    const ordp = [...arr].sort((a, b) => a.penAtr - b.penAtr);
    const deciles = [];
    for (let d = 0; d < 10; d++) {
      const a = Math.floor((d * ordp.length) / 10), b = Math.floor(((d + 1) * ordp.length) / 10);
      const g = ordp.slice(a, b);
      if (!g.length) continue;
      deciles.push({
        decil: d + 1, n: g.length,
        penMin: g[0].penAtr, penMax: g[g.length - 1].penAtr,
        penMed: cuantil(g.map((x) => x.penAtr), 0.5),
        penPctMed: cuantil(g.map((x) => x.penPct), 0.5),
        vidaMed: cuantil(g.map((x) => x.vida), 0.5),
        win: g.filter((x) => x.gold > 0).length / g.length,
        brutoPct: g.reduce((s, x) => s + x.bruto, 0) / g.reduce((s, x) => s + x.entN, 0),
        gold: mean(g.map((x) => x.gold)), black: mean(g.map((x) => x.black)),
        caminos: g.reduce((a2, x) => { const k = nombreCamino(x.salida); a2[k] = (a2[k] || 0) + 1; return a2; }, {}),
      });
    }
    const porCamino = {};
    for (const x of arr) {
      const k = nombreCamino(x.salida);
      (porCamino[k] = porCamino[k] || []).push(x);
    }
    const camRows = Object.entries(porCamino).map(([k, g]) => ({
      camino: k, n: g.length,
      penMed: cuantil(g.map((x) => x.penAtr), 0.5),
      penP10: cuantil(g.map((x) => x.penAtr), 0.1),
      penP90: cuantil(g.map((x) => x.penAtr), 0.9),
      penProm: mean(g.map((x) => x.penAtr)),
      gold: mean(g.map((x) => x.gold)),
    })).sort((a, b) => b.n - a.n);
    const pens = arr.map((x) => x.penAtr);
    const mix = em2(pens);
    out.A[vn] = {
      n: arr.length, deciles, porCamino: camRows,
      stopAtrMed: cuantil(arr.map((x) => x.stopAtr), 0.5),
      cuantiles: Object.fromEntries([0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95].map((q) => [q, cuantil(pens, q)])),
      bimodal: mix, kde: kdeModas(pens),
      // censura: cuántos trades tienen la penetración pegada al stop (el stop
      // corta la excursión, así que la cola derecha está truncada ahí)
      pegadosAlStop: arr.filter((x) => x.stopAtr != null && x.penAtr >= x.stopAtr * 0.98).length,
    };
    console.log(`\n  --- ${vn} · ${arr.length} trades · penetración en ATR14 (dist. entrada→stop mediana ${n2(out.A[vn].stopAtrMed)} ATR) ---`);
    console.log(`  decil  n   pen(med)  rango        pen% med  vida  win%   bruto%   gold/trade   caminos`);
    for (const d of deciles) {
      console.log(`   ${String(d.decil).padStart(2)}  ${String(d.n).padStart(3)}  ${n2(d.penMed).padStart(7)}  ${n2(d.penMin).padStart(5)}-${n2(d.penMax).padEnd(5)}  ${pct(d.penPctMed, 2).padStart(7)}  ${String(d.vidaMed).padStart(4)}  ${pct(d.win).padStart(5)}  ${pct(d.brutoPct, 2).padStart(7)}  ${fmt(d.gold).padStart(10)}   ${JSON.stringify(d.caminos)}`);
    }
    console.log(`  por camino de salida:`);
    for (const r of camRows) console.log(`   ${r.camino.padEnd(22)} n=${String(r.n).padStart(3)} pen p10/med/p90 ${n2(r.penP10)}/${n2(r.penMed)}/${n2(r.penP90)} ATR · gold ${fmt(r.gold)}`);
    console.log(`  cuantiles de la penetración: ${Object.entries(out.A[vn].cuantiles).map(([q, v]) => `p${Math.round(q * 100)}=${n2(v)}`).join(" ")}`);
    if (mix) console.log(`  bimodalidad (EM 2 gaussianas): centros ${n2(mix.mu1)} y ${n2(mix.mu2)} ATR · peso ${pct(mix.w)} · separación ${n2(mix.sep)} sd · BIC 1 comp ${n2(mix.bic1, 1)} vs 2 comp ${n2(mix.bic2, 1)} → ${mix.bic2 < mix.bic1 ? "gana 2 componentes" : "gana 1 componente"} · MODAS de la mezcla ajustada: ${mix.modos}`);
    const kd = out.A[vn].kde;
    console.log(`  densidad kernel: h de referencia ${n2(kd.hRef, 3)} → ${kd.modasRef} modas · h crítico para 1 moda ${kd.hCrit == null ? "-" : n2(kd.hCrit, 3)} (×${n2(kd.ratio)} el de referencia)`);
    console.log(`  trades con la penetración pegada al stop (>=98% de la distancia al stop): ${out.A[vn].pegadosAlStop}/${arr.length}`);
  }

  /* ══════════ B · EL TEST PRIMARIO ══════════ */
  console.log(`\n===== B · TEST PRIMARIO: "LA ZONA AGUANTA" vs "LA ZONA CEDIÓ" (evaluado EN LA BARRA DEL FILL) =====`);
  out.B = {};
  for (const vn of ["IS", "OOS"]) {
    const arr = TR[vn];
    const ag = arr.filter((x) => x.aguanta === 1), ce = arr.filter((x) => x.aguanta === 0);
    const w = {
      gold: welch(ag.map((x) => x.gold), ce.map((x) => x.gold)),
      black: welch(ag.map((x) => x.black), ce.map((x) => x.black)),
      bruto: welch(ag.map((x) => x.brutoPct), ce.map((x) => x.brutoPct)),
    };
    out.B[vn] = {
      nAguanta: ag.length, nCede: ce.length, pctAguanta: ag.length / arr.length,
      welch: w,
      winAguanta: ag.length ? ag.filter((x) => x.gold > 0).length / ag.length : null,
      winCede: ce.length ? ce.filter((x) => x.gold > 0).length / ce.length : null,
      penAguanta: ag.length ? cuantil(ag.map((x) => x.penAtr).filter((v) => v != null), 0.5) : null,
      penCede: ce.length ? cuantil(ce.map((x) => x.penAtr).filter((v) => v != null), 0.5) : null,
      caminosAguanta: ag.reduce((a, x) => { const k = nombreCamino(x.salida); a[k] = (a[k] || 0) + 1; return a; }, {}),
      caminosCede: ce.reduce((a, x) => { const k = nombreCamino(x.salida); a[k] = (a[k] || 0) + 1; return a; }, {}),
    };
    const b = out.B[vn];
    console.log(`\n  --- ${vn} · aguanta ${ag.length} (${pct(b.pctAguanta)}) vs cedió ${ce.length} ---`);
    for (const tier of ["gold", "black"]) {
      const ww = w[tier];
      if (!ww) { console.log(`   ${tier}: n insuficiente`); continue; }
      console.log(`   ${tier.padEnd(6)} expectancy aguanta ${fmt(ww.ma).padStart(10)} vs cedió ${fmt(ww.mb).padStart(10)} · dif ${fmt(ww.ma - ww.mb).padStart(10)} · t ${n2(ww.t)} df ${n2(ww.df, 1)} · p (t) ${ww.p2.toFixed(4)} · p (normal) ${ww.p2norm.toFixed(4)}`);
    }
    console.log(`   bruto/nocional: aguanta ${pct(w.bruto.ma, 3)} vs cedió ${pct(w.bruto.mb, 3)} · p ${w.bruto.p2.toFixed(4)}`);
    console.log(`   win aguanta ${pct(b.winAguanta)} vs cedió ${pct(b.winCede)} · penetración mediana ${n2(b.penAguanta)} vs ${n2(b.penCede)} ATR`);
    console.log(`   caminos aguanta ${JSON.stringify(b.caminosAguanta)} · cedió ${JSON.stringify(b.caminosCede)}`);
  }

  /* B.2 · el control obvio: ¿qué está midiendo "aguanta"?
   * El motor mantiene la zona sólo si el techo sigue por debajo del spot, o
   * sea si la barra del fill CERRÓ por encima del nivel (× 1,001). Hay que
   * medir cuánto de la partición es eso y nada más, porque si coinciden, el
   * test primario no está midiendo la lógica de zonas del motor sino algo
   * mucho más simple: si el papel está arriba o abajo del nivel una hora
   * después de comprarlo. */
  console.log(`\n  --- B.2 · control: "aguanta" contra la regla cruda "la barra del fill cerró arriba del nivel" ---`);
  out.B.control = {};
  for (const vn of ["IS", "OOS"]) {
    const arr = TR[vn];
    const cl = (x) => (x.spotFill != null && x.spotFill > x.entry * 1.001 ? 1 : 0);
    const mat = { ag1cl1: 0, ag1cl0: 0, ag0cl1: 0, ag0cl0: 0 };
    for (const x of arr) mat[`ag${x.aguanta}cl${cl(x)}`]++;
    const hi = arr.filter((x) => cl(x) === 1), lo = arr.filter((x) => cl(x) === 0);
    const disc = arr.filter((x) => x.aguanta === 0 && cl(x) === 1);
    const w = welch(hi.map((x) => x.gold), lo.map((x) => x.gold));
    out.B.control[vn] = {
      matriz: mat, acuerdo: (mat.ag1cl1 + mat.ag0cl0) / arr.length,
      nArriba: hi.length, nAbajo: lo.length,
      goldArriba: mean(hi.map((x) => x.gold)), goldAbajo: mean(lo.map((x) => x.gold)),
      blackArriba: mean(hi.map((x) => x.black)), blackAbajo: mean(lo.map((x) => x.black)),
      welch: w,
      nDiscrepan: disc.length, goldDiscrepan: disc.length ? mean(disc.map((x) => x.gold)) : null,
      cierreMenosNivelAtrMed: cuantil(arr.map((x) => (x.spotFill - x.entry) / x.atr), 0.5),
    };
    const o = out.B.control[vn];
    console.log(`   ${vn}: acuerdo ${pct(o.acuerdo)} (${JSON.stringify(mat)}) · cerró arriba n=${o.nArriba} gold ${fmt(o.goldArriba)} vs abajo n=${o.nAbajo} gold ${fmt(o.goldAbajo)} · p ${w ? w.p2.toFixed(4) : "-"}`);
    console.log(`        los ${o.nDiscrepan} que cierran arriba y el motor igual cambia de zona: gold medio ${fmt(o.goldDiscrepan)} · (cierre−nivel)/ATR mediano ${n2(o.cierreMenosNivelAtrMed, 3)}`);
  }

  /* ══════════ C · LOS CINCO FEATURES (EXPLORATORIO) ══════════ */
  console.log(`\n===== C · CINCO FEATURES POINT-IN-TIME · EXPLORATORIO, LISTA CERRADA =====`);
  out.C = {};
  const FEATURES = [
    { id: "f1", etiq: "profundidad ya penetrada al fill (nivel-low)/ATR14", bin: false },
    { id: "f2", etiq: `barras desde el primer toque de la zona (ventana ${NPREV})`, bin: false },
    { id: "f3", etiq: "volumen de la barra del fill / media 20 barras", bin: false },
    { id: "f4", etiq: `la zona ya fue tocada en las últimas ${NPREV} barras`, bin: true },
    { id: "f5", etiq: "posición del fill en el rango de su barra (fill-low)/(high-low)", bin: false },
  ];
  /* Cuartiles POR RANGO (cuatro grupos del mismo tamaño), no por valor de
   * corte. Hace falta porque f2 está topeado en NPREV y tiene una masa grande
   * de empates justo en el tope: con cortes por valor, el cuartil alto sale
   * VACÍO. El orden de desempate es el de la cartera (determinista). */
  const cuartilizar = (arr, id) => {
    const v = arr.filter((x) => x[id] != null);
    const ord = v.map((x, i) => [x[id], i, x]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((z) => z[2]);
    const gr = [[], [], [], []];
    for (let q = 0; q < 4; q++) {
      const a = Math.floor((q * ord.length) / 4), b = Math.floor(((q + 1) * ord.length) / 4);
      gr[q] = ord.slice(a, b);
    }
    const cortes = gr.slice(0, 3).map((g) => (g.length ? g[g.length - 1][id] : null));
    const empates = gr.map((g) => (g.length ? new Set(g.map((x) => x[id])).size : 0));
    return { cortes, gr, empates, nDistintos: new Set(v.map((x) => x[id])).size };
  };
  for (const f of FEATURES) {
    out.C[f.id] = { etiq: f.etiq, bin: f.bin };
    console.log(`\n  --- ${f.id}: ${f.etiq} ---`);
    for (const vn of ["IS", "OOS", "POOL"]) {
      const arr = vn === "POOL" ? TODOS : TR[vn];
      if (f.bin) {
        const hi = arr.filter((x) => x[f.id] === 1), lo = arr.filter((x) => x[f.id] === 0);
        const w = { gold: welch(hi.map((x) => x.gold), lo.map((x) => x.gold)), black: welch(hi.map((x) => x.black), lo.map((x) => x.black)) };
        out.C[f.id][vn] = { grupos: [{ q: "no", n: lo.length, gold: mean(lo.map((x) => x.gold)), black: mean(lo.map((x) => x.black)), win: lo.length ? lo.filter((x) => x.gold > 0).length / lo.length : null }, { q: "sí", n: hi.length, gold: mean(hi.map((x) => x.gold)), black: mean(hi.map((x) => x.black)), win: hi.length ? hi.filter((x) => x.gold > 0).length / hi.length : null }], welch: w };
        console.log(`   [${vn.padEnd(4)}] no: n=${lo.length} gold ${fmt(mean(lo.map((x) => x.gold)))} · sí: n=${hi.length} gold ${fmt(mean(hi.map((x) => x.gold)))} · p (sí vs no) ${w.gold ? w.gold.p2.toFixed(4) : "-"}`);
      } else {
        const { cortes, gr } = cuartilizar(arr, f.id);
        const rows = gr.map((g, i) => ({
          q: i + 1, n: g.length,
          gold: g.length ? mean(g.map((x) => x.gold)) : null,
          black: g.length ? mean(g.map((x) => x.black)) : null,
          brutoPct: g.length ? g.reduce((s, x) => s + x.bruto, 0) / g.reduce((s, x) => s + x.entN, 0) : null,
          win: g.length ? g.filter((x) => x.gold > 0).length / g.length : null,
        }));
        const w = { gold: welch(gr[3].map((x) => x.gold), gr[0].map((x) => x.gold)), black: welch(gr[3].map((x) => x.black), gr[0].map((x) => x.black)) };
        out.C[f.id][vn] = { cortes, grupos: rows, welch: w };
        console.log(`   [${vn.padEnd(4)}] cortes ${cortes.map((c) => n2(c, 3)).join(" / ")}`);
        for (const r of rows) console.log(`          Q${r.q} n=${String(r.n).padStart(3)} gold ${fmt(r.gold).padStart(10)} black ${fmt(r.black).padStart(10)} bruto ${pct(r.brutoPct, 2).padStart(7)} win ${pct(r.win).padStart(6)}`);
        console.log(`          Q4 vs Q1 · gold dif ${fmt(w.gold ? w.gold.ma - w.gold.mb : null)} t ${n2(w.gold?.t)} p ${w.gold ? w.gold.p2.toFixed(4) : "-"} · black p ${w.black ? w.black.p2.toFixed(4) : "-"}`);
      }
    }
  }

  /* ══════════ D · EL NULO DE DESCARTE ALEATORIO ══════════
   * Para un corte que deja pasar K de los N trades del base, el nulo saca al
   * azar (N-K) trades y mide el mensual de los que quedan. 5.000 sorteos.
   * Todo en modo AISLADO (mismo set de trades, sin re-simular la cartera):
   * así el corte real y el nulo mueven exactamente las mismas piezas. */
  console.log(`\n===== D · NULO DE DESCARTE ALEATORIO (${DRAWS} sorteos, semilla ${SEED}) =====`);
  out.D = {};
  const rnd = mulberry32(SEED);
  const mensualDe = (sub, ctx, tier) => (sub.reduce((s, x) => s + x[tier], 0) / CAPITAL / ctx.meses) * 100;
  const correrNulo = (etiqueta, vn, keep) => {
    const arr = TR[vn], ctx = BASE[vn].ctx, N = arr.length;
    const sub = arr.filter(keep);
    const K = sub.length;
    if (K === 0 || K === N) return null;
    const real = { gold: mensualDe(sub, ctx, "gold"), black: mensualDe(sub, ctx, "black") };
    const base = { gold: mensualDe(arr, ctx, "gold"), black: mensualDe(arr, ctx, "black") };
    const idx = arr.map((_, i) => i);
    const nul = { gold: [], black: [] };
    for (let b = 0; b < DRAWS; b++) {
      const sel = sorteoK(idx, N, K, rnd);
      let g = 0, bl = 0;
      for (const i of sel) { g += arr[i].gold; bl += arr[i].black; }
      nul.gold.push((g / CAPITAL / ctx.meses) * 100);
      nul.black.push((bl / CAPITAL / ctx.meses) * 100);
    }
    const res = {
      etiqueta, vn, N, K, descartados: N - K, real, base,
      nulo: { gold: ubicar(real.gold, nul.gold), black: ubicar(real.black, nul.black) },
      expReal: { gold: sub.reduce((s, x) => s + x.gold, 0) / K, black: sub.reduce((s, x) => s + x.black, 0) / K },
      expBase: { gold: arr.reduce((s, x) => s + x.gold, 0) / N, black: arr.reduce((s, x) => s + x.black, 0) / N },
    };
    console.log(`   ${etiqueta.padEnd(34)} ${vn} K=${String(K).padStart(3)}/${N} · mensual real ${n2(real.gold).padStart(6)}% (base ${n2(base.gold)}%) · nulo mediana ${n2(res.nulo.gold.med).padStart(6)}% · pctil ${pct(res.nulo.gold.percentil).padStart(6)} p=${res.nulo.gold.p1cola.toFixed(4)} · black pctil ${pct(res.nulo.black.percentil)}`);
    return res;
  };
  const CORTES = [
    { id: "solo aguanta (test primario)", keep: (x) => x.aguanta === 1 },
    { id: "solo cedió (test primario)", keep: (x) => x.aguanta === 0 },
    // el control de B.2, que es casi la misma partición pero sin pasar por el
    // motor. Cuenta como configuración mirada y entra en el N del DSR.
    { id: "control: cerró arriba del nivel", keep: (x) => x.spotFill != null && x.spotFill > x.entry * 1.001 },
    { id: "control: cerró abajo del nivel", keep: (x) => !(x.spotFill != null && x.spotFill > x.entry * 1.001) },
  ];
  // los cortes de los cinco features: cuartil alto y cuartil bajo de cada uno
  for (const f of FEATURES) {
    if (f.bin) {
      CORTES.push({ id: `${f.id} = sí`, keep: (x) => x[f.id] === 1 });
      CORTES.push({ id: `${f.id} = no`, keep: (x) => x[f.id] === 0 });
    } else {
      CORTES.push({ id: `${f.id} Q4 (alto)`, needQ: f.id, lado: 3 });
      CORTES.push({ id: `${f.id} Q1 (bajo)`, needQ: f.id, lado: 0 });
    }
  }
  // membresía de cuartil por rango, la misma que usa el bloque C
  const keepDe = (c, vn) => {
    if (!c.needQ) return c.keep;
    const s = new Set(cuartilizar(TR[vn], c.needQ).gr[c.lado]);
    return (x) => s.has(x);
  };
  out.D.cortes = {};
  for (const c of CORTES) {
    out.D.cortes[c.id] = {};
    for (const vn of ["IS", "OOS"]) out.D.cortes[c.id][vn] = correrNulo(c.id, vn, keepDe(c, vn));
  }

  /* El corte implementable, que NO es gratis. El test primario se evalúa al
   * CIERRE de la barra del fill, o sea que el bot ya compró: la versión
   * realizable no es "no tomar el trade" sino "tomarlo y soltarlo al cierre de
   * esa barra", con la vuelta de comisión completa (segunda pata bonificada
   * porque es el mismo día). Los nulos de arriba, como todos los de este
   * proyecto, miden el corte gratis; esto mide lo que costaría de verdad. */
  console.log(`\n  --- el mismo corte, pero IMPLEMENTABLE (soltar al cierre de la barra del fill lo que cedió) ---`);
  out.D.implementable = {};
  for (const vn of ["IS", "OOS"]) {
    const arr = TR[vn], ctx = BASE[vn].ctx;
    const dump = (x) => {
      const tr = x._tr, b = ctx.barAt[tr.sym].get(tr.entryTs);
      const entN = tr.qty0 * tr.entryPx * tr.rIn;
      const outN = tr.qty0 * (b ? b.c : tr.entryPx) * tr.rIn;
      const r = {};
      for (const tier of TIERS) r[tier] = outN - entN - (entN * FEE[tier] + outN * DERECHOS);
      return r;
    };
    const tot = { gold: 0, black: 0 }, totBase = { gold: 0, black: 0 };
    let nDump = 0;
    for (const x of arr) {
      totBase.gold += x.gold; totBase.black += x.black;
      if (x.aguanta === 1) { tot.gold += x.gold; tot.black += x.black; }
      else { const d = dump(x); tot.gold += d.gold; tot.black += d.black; nDump++; }
    }
    const men = (v) => (v / CAPITAL / ctx.meses) * 100;
    out.D.implementable[vn] = {
      nDump, mensualReal: { gold: men(tot.gold), black: men(tot.black) },
      mensualBase: { gold: men(totBase.gold), black: men(totBase.black) },
      mensualCorteGratis: { gold: men(arr.filter((x) => x.aguanta === 1).reduce((s, x) => s + x.gold, 0)), black: men(arr.filter((x) => x.aguanta === 1).reduce((s, x) => s + x.black, 0)) },
    };
    const o = out.D.implementable[vn];
    console.log(`   ${vn}: suelta ${nDump} trades · mensual gold ${n2(o.mensualReal.gold)}% (corte gratis ${n2(o.mensualCorteGratis.gold)}% · base ${n2(o.mensualBase.gold)}%) · black ${n2(o.mensualReal.black)}% (gratis ${n2(o.mensualCorteGratis.black)}% · base ${n2(o.mensualBase.black)}%)`);
  }

  /* ══════════ E · ARTEFACTO O PROPIEDAD ══════════ */
  console.log(`\n===== E · EL 79% CON DISTINTAS TOLERANCIAS DE "MISMA ZONA" =====`);
  out.E = { tolerancias: TOLS, filas: [] };
  for (const cuando of ["fill", "siguiente"]) {
    for (const vn of ["IS", "OOS", "POOL"]) {
      const arr = vn === "POOL" ? TODOS : TR[vn];
      const campo = cuando === "fill" ? "aguantaTol" : "aguantaSigTol";
      const sinNivel = arr.filter((x) => x[cuando === "fill" ? "sinNivelFill" : "sinNivelSig"] === 1).length;
      const row = { cuando, vn, n: arr.length, sinNivel, rederiva: {}, mantiene: {} };
      for (const t of TOLS) {
        const mant = arr.filter((x) => x[campo][t] === 1).length;
        row.mantiene[t] = mant;
        row.rederiva[t] = (arr.length - mant) / arr.length;
      }
      const dist = arr.map((x) => (cuando === "fill" ? x.distFill : x.distSig)).filter((v) => v != null);
      row.distMed = cuantil(dist, 0.5);
      row.distP25 = cuantil(dist, 0.25);
      row.distP75 = cuantil(dist, 0.75);
      out.E.filas.push(row);
      console.log(`   ${cuando === "fill" ? "barra del FILL " : "barra SIGUIENTE"} ${vn.padEnd(4)} n=${String(row.n).padStart(3)} · re-deriva otra zona: ${TOLS.map((t) => `±${(t * 100).toFixed(2)}% → ${pct(row.rederiva[t])}`).join(" · ")} · sin nivel ${sinNivel} · distancia del nuevo nivel p25/med/p75 ${pct(row.distP25, 2)}/${pct(row.distMed, 2)}/${pct(row.distP75, 2)}`);
    }
  }
  /* Réplica EXACTA del número de INFORME-TIMESTOP §4: ahí el 79% no es "la
   * barra siguiente al fill" sino "de los trades que D1 mató, el motivo fue
   * que el motor re-derivó otra zona", y el corte se busca en la PRIMERA barra
   * de la vida del trade en la que alguna condición de D1 se dispara (mediana
   * 1, p90 2). Se recorre igual, con las cuatro tolerancias. */
  console.log(`\n  --- réplica exacta del 79%: primera barra en que se dispara D1, motivo = "re-derivó otra zona" ---`);
  out.E.replica = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = BASE[vn].ctx;
    const acc = Object.fromEntries(TOLS.map((t) => [t, { corta: 0, rederiva: 0, otros: {}, barras: [] }]));
    TR[vn].forEach((x, i) => {
      const tr = BASE[vn].sim.trades[i];
      const a = getAna(tr.sym), i0 = a.idxDe(tr.entryTs);
      const pend = new Set(TOLS);
      for (let k = 1; k <= x.vida && pend.size; k++) {
        const pz = a.piezas(i0 + k);
        if (!pz) break;
        const kit = analyzeKit(pz);
        for (const t of [...pend]) {
          let m = null;
          if (!kit || kit.buy == null) m = "sin nivel";
          else if (Math.abs(kit.buy - tr.entryPx) / tr.entryPx > t) m = "el motor re-derivó otra zona";
          else if (kit.contraTendencia) m = "contra-tendencia";
          else if (kit.score < 7) m = "score < 7";
          else if (kit.rr == null || kit.rr < 2) m = "R:R < 2";
          if (!m) continue;
          acc[t].corta++;
          acc[t].barras.push(k);
          if (m === "el motor re-derivó otra zona") acc[t].rederiva++;
          else acc[t].otros[m] = (acc[t].otros[m] || 0) + 1;
          pend.delete(t);
        }
      }
    });
    out.E.replica[vn] = {};
    for (const t of TOLS) {
      const a = acc[t];
      out.E.replica[vn][t] = {
        n: TR[vn].length, corta: a.corta, rederiva: a.rederiva, otros: a.otros,
        pctSobreCortados: a.corta ? a.rederiva / a.corta : null,
        pctSobreTodos: a.rederiva / TR[vn].length,
        barraMed: a.barras.length ? cuantil(a.barras, 0.5) : null,
        barraP90: a.barras.length ? cuantil(a.barras, 0.9) : null,
      };
      const r = out.E.replica[vn][t];
      console.log(`   ${vn.padEnd(4)} ±${(t * 100).toFixed(2)}%: D1 corta ${r.corta}/${r.n} · de esos, re-derivó otra zona ${r.rederiva} (${pct(r.pctSobreCortados)}) · sobre los ${r.n}: ${pct(r.pctSobreTodos)} · barra de corte med/p90 ${r.barraMed}/${r.barraP90} · otros motivos ${JSON.stringify(r.otros)}`);
    }
  }
  for (const t of TOLS) {
    const a = out.E.replica.IS[t], b = out.E.replica.OOS[t];
    out.E.replica[`POOL_${t}`] = {
      corta: a.corta + b.corta, rederiva: a.rederiva + b.rederiva,
      pctSobreCortados: (a.rederiva + b.rederiva) / (a.corta + b.corta),
      pctSobreTodos: (a.rederiva + b.rederiva) / (a.n + b.n),
    };
    const p = out.E.replica[`POOL_${t}`];
    console.log(`   POOL ±${(t * 100).toFixed(2)}%: ${p.rederiva}/${p.corta} de los cortados = ${pct(p.pctSobreCortados)} · sobre los 205 = ${pct(p.pctSobreTodos)}`);
  }
  // el número publicado en INFORME-TIMESTOP, para el contraste
  out.E.refTimestop = {
    IS: prevTs.D?.D1?.IS?.motivos || null,
    OOS: prevTs.D?.D1?.OOS?.motivos || null,
  };

  /* ══════════ F · DSR CON EL N ACTUALIZADO ══════════ */
  console.log(`\n===== F · DSR · N de 132 a ? =====`);
  out.dsr = null;
  if (!SIN_DSR) {
    const srsG = [], srsB = [];
    for (const k of Object.keys(prev.corridas)) {
      if (prev.corridas[k]._sr != null) srsG.push(prev.corridas[k]._sr);
      if (prev.corridas[k]._srB != null) srsB.push(prev.corridas[k]._srB);
    }
    const mults = [0.7, 0.85, 1, 1.15, 1.3];
    let chkSweep = 0;
    const CTX = { IS: BASE.IS.ctx, OOS: BASE.OOS.ctx };
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      for (const sm of mults) for (const tm of mults) {
        const o = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase, sm, tm);
        const s = simular(o, ctx, ccl);
        const mg = metricas(s, "gold", ctx.meses), mb = metricas(s, "black", ctx.meses);
        srsG.push(mg.srDiario); srsB.push(mb.srDiario);
        const ref = prev.sweep[`${vn}/s${sm}/t${tm}`];
        if (ref && Math.abs(ref.sharpe - mg.sharpe) < 1e-9) chkSweep++;
      }
    }
    const NUEVAS_RC = ["rc-entrada", "rc-entrada-stop", "rc-entrada/stop-gana", "rc-entrada-stop/stop-gana"];
    for (const vn of ["IS", "OOS"]) for (const rn of NUEVAS_RC) {
      const v = prevRc.B[vn][rn];
      if (v && v._sr != null) srsG.push(v._sr);
      if (v && v._srB != null) srsB.push(v._srB);
    }
    const FA = featuresSpy({ useAdj: true, lag: 1 }), FC = featuresSpy({ useAdj: false, lag: 1 });
    const volMedIS = (() => {
      const v = senales.filter((s) => s.dia <= IS_HASTA && s.vol != null).map((s) => s.vol).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : null;
    })();
    const volMedISdia = (() => {
      const v = [];
      for (const d of FA.dias) { if (d > IS_HASTA || d < IS_DESDE) continue; const f = FA.feat.get(d); if (f && f.vol != null) v.push(f.vol); }
      v.sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null;
    })();
    const medPIT = (minN, ventana) => {
      const m = new Map(); const acum = [];
      for (const d of FA.dias) {
        const f = FA.feat.get(d);
        if (acum.length >= minN) { const s = (ventana ? acum.slice(-ventana) : [...acum]).sort((a, b) => a - b); m.set(d, s[Math.floor(s.length / 2)]); }
        if (f && f.vol != null) acum.push(f.vol);
      }
      return m;
    };
    const volMedExp = medPIT(60, null), volMed252 = medPIT(120, 252);
    const volQ = (q) => {
      const v = [];
      for (const d of FA.dias) { if (d > IS_HASTA || d < IS_DESDE) continue; const f = FA.feat.get(d); if (f && f.vol != null) v.push(f.vol); }
      v.sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : null;
    };
    const conj = (g, extra) => (s) => { const r = g(s); return r && extra(s) ? r : null; };
    const condsNulo = [
      (s) => s.vol != null && s.vol <= volMedISdia,
      (s) => { const u = volMedExp.get(s.dia); return u != null && s.vol != null && s.vol <= u; },
      (s) => { const u = volMed252.get(s.dia); return u != null && s.vol != null && s.vol <= u; },
      (s) => { const f = FC.feat.get(s.dia); return !!(f && f.vol != null && f.vol <= volMedIS); },
    ];
    for (const cond of condsNulo) for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const s = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, conj(gateBase, cond)), ctx, ccl);
      srsG.push(metricas(s, "gold", ctx.meses).srDiario); srsB.push(metricas(s, "black", ctx.meses).srDiario);
    }
    for (const q of [0.25, 0.35, 0.65, 0.75]) {
      const u = volQ(q);
      for (const vn of ["IS", "OOS"]) {
        const ctx = CTX[vn];
        const s = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, conj(gateBase, (x) => x.vol != null && x.vol <= u)), ctx, ccl);
        srsG.push(metricas(s, "gold", ctx.meses).srDiario); srsB.push(metricas(s, "black", ctx.meses).srDiario);
      }
    }
    const nNulo = srsG.length;
    // las 32 de INFORME-TIMESTOP: 26 del barrido de H (las 6 que no cortan
    // nada son idénticas al base y no cuentan) + 6 de razón muerta
    const RELOJES = [
      { id: "mercado", opt: (H) => ({ maxBarras: H }) },
      { id: "corrido", opt: (H) => ({ maxHorasCal: H }) },
    ];
    const cortesDe = (rel, vn, H) => {
      const m = new Map();
      BASE[vn].sim.trades.forEach((tr, i) => {
        const vida = TR[vn][i].vida;
        if (rel === "mercado") { if (vida > H) m.set(i, H); }
        else { const k = barraDeHoras(tr, BASE[vn].ctx, H, vida); if (k != null && k < vida) m.set(i, k); }
      });
      return m;
    };
    let nTs = 0;
    for (const rel of RELOJES) for (const vn of ["IS", "OOS"]) for (const H of HS) {
      const ctx = BASE[vn].ctx, ord = BASE[vn].ord;
      const s = simular(ord, ctx, ccl, rel.opt(H));
      const nTS = s.legs.filter((l) => l.reason === "timestop").length;
      if (nTS === 0 && cortesDe(rel.id, vn, H).size === 0) continue;
      srsG.push(metricas(s, "gold", ctx.meses).srDiario); srsB.push(metricas(s, "black", ctx.meses).srDiario);
      nTs++;
    }
    const evaluarD = (sym, tms, entry) => {
      const a = getAna(sym), i = a.idxDe(tms);
      if (i == null) return null;
      const pz = a.piezas(i);
      if (!pz) return null;
      const kit = analyzeKit(pz);
      let m1 = null;
      if (!kit || kit.buy == null) m1 = "sin nivel";
      else if (Math.abs(kit.buy - entry) / entry > 0.005) m1 = "el motor re-derivó otra zona";
      else if (kit.contraTendencia) m1 = "contra-tendencia";
      else if (kit.score < 7) m1 = "score < 7";
      else if (kit.rr == null || kit.rr < 2) m1 = "R:R < 2";
      const an = evalAncla(pz, entry);
      return { D1: m1 != null, D2: motivoMuerte(an, true) != null, D3: motivoMuerte(an, false) != null };
    };
    let nRm = 0;
    for (const modo of ["D1", "D2", "D3"]) for (const vn of ["IS", "OOS"]) {
      const ctx = BASE[vn].ctx, ord = BASE[vn].ord;
      const s = simular(ord, ctx, ccl, { razonMuerta: (sym, t, pos) => { const e = evaluarD(sym, t, pos.entryPx); return e ? e[modo] : false; } });
      srsG.push(metricas(s, "gold", ctx.meses).srDiario); srsB.push(metricas(s, "black", ctx.meses).srDiario);
      nRm++;
    }
    const nPrev = srsG.length;
    const sigPrevG = stdev(srsG), sigPrevB = stdev(srsB);
    console.log(`  reconstrucción del N anterior: ${nPrev} (informe: ${prevTs.dsr.N}) · sigma gold ${sigPrevG.toExponential(4)} (informe ${prevTs.dsr.sigmaSR.toExponential(4)}) · black ${sigPrevB.toExponential(4)} (informe ${prevTs.dsr.sigmaSRblack.toExponential(4)}) · sweep ${chkSweep}/50 · timestop ${nTs} · razón muerta ${nRm}`);

    // las NUEVAS de este informe: los 24 cortes del bloque D, evaluados en
    // modo aislado (la equity se reconstruye con los legs de los trades que el
    // corte deja pasar)
    const nuevas = [];
    for (const c of CORTES) {
      for (const vn of ["IS", "OOS"]) {
        const sub = TR[vn].filter(keepDe(c, vn)).map((x) => x._tr);
        if (!sub.length) continue;
        const m = metricasSub(sub, BASE[vn].ctx);
        nuevas.push({
          nombre: `${c.id}/${vn}`, sr: m.gold.srDiario, srB: m.black.srDiario,
          rets: m.gold.rets, retsB: m.black.rets, shG: m.gold.sharpe, shB: m.black.sharpe,
          mensual: m.gold.mensualPct, n: m.gold.n,
        });
      }
    }
    for (const v of nuevas) { if (v.sr != null) srsG.push(v.sr); if (v.srB != null) srsB.push(v.srB); }
    const N = nPrev + nuevas.length;
    const sigG = stdev(srsG), sigB = stdev(srsB);
    console.log(`  N ${nPrev} → ${N} (+${nuevas.length} configuraciones nuevas) · sigma gold ${sigG.toExponential(4)} · black ${sigB.toExponential(4)}`);
    out.dsr = { Nprevio: nPrev, N, sigmaSR: sigG, sigmaSRblack: sigB, chequeoSweep: chkSweep, reconstruccion: { sigPrevG, sigPrevB, refN: prevTs.dsr.N, refG: prevTs.dsr.sigmaSR, refB: prevTs.dsr.sigmaSRblack }, filas: {} };

    const filas = [];
    for (const vn of ["IS", "OOS"]) {
      const m = BASE[vn].m;
      filas.push({ nombre: `base/${vn}`, shG: m.gold.sharpe, shB: m.black.sharpe, rets: m.gold.rets, retsB: m.black.rets, sr: m.gold.srDiario, srB: m.black.srDiario });
    }
    for (const v of nuevas) filas.push(v);
    for (const f of filas) {
      const dG = dsr(f.rets, f.sr, sigG, N), dB = dsr(f.retsB ?? f.rets, f.srB ?? f.sr, sigB, N);
      out.dsr.filas[f.nombre] = { n: f.n ?? null, sharpeGold: f.shG, dsrGold: dG ? dG.dsr : null, sharpeBlack: f.shB, dsrBlack: dB ? dB.dsr : null };
      console.log(`  ${f.nombre.padEnd(36)} gold SR ${n2(f.shG).padStart(6)} DSR ${dG ? dG.dsr.toFixed(5) : "-"} · black SR ${n2(f.shB).padStart(6)} DSR ${dB ? dB.dsr.toFixed(5) : "-"}`);
    }
  }

  /* ── huella de reproducibilidad: un digest de los números que importan ── */
  const digest = (() => {
    const nums = [];
    const walk = (o) => {
      if (o == null) return;
      if (typeof o === "number") { nums.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { if (k === "generado") continue; walk(o[k]); } }
    };
    walk({ A: out.A, B: out.B, C: out.C, D: out.D, E: out.E, dsr: out.dsr });
    let h = 2166136261 >>> 0;
    for (const v of nums) {
      const s = Number.isFinite(v) ? v.toExponential(12) : String(v);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { nNumeros: nums.length, fnv1a: h.toString(16) };
  })();
  out.digest = digest;
  console.log(`\nhuella de reproducibilidad: ${digest.nNumeros} números · FNV-1a ${digest.fnv1a}`);

  for (const vn of ["IS", "OOS"]) TR[vn].forEach((x) => { delete x._tr; });
  out.trades = TR;
  fs.writeFileSync(path.join(DIR, "results-barrido.json"), JSON.stringify(out, null, 1));
  console.log(`results-barrido.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
