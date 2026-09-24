/* timestop.js — ¿el bot tiene que cortar los trades que se hacen largos?
 *
 * Hipótesis: Locke & Mann, "Professional Trader Discipline and Trade
 * Disposition" (JFE 2005). Sobre 334 traders de pits del CME, los que cerraban
 * rápido —perdedores Y ganadores— rendían mejor los 6 meses siguientes. La
 * lectura del paper es que la disciplina no es "cortá pérdidas y dejá correr
 * ganancias" sino SALIR CUANDO LA RAZÓN ORIGINAL DEL TRADE DESAPARECIÓ.
 *
 * El bot de niveles tiene expiry de 48 h ANTES del fill pero NINGÚN time-stop
 * DESPUÉS del fill. Este script testea:
 *   A) descriptivo: P&L por duración, controlado por camino de salida
 *   B) la regla cruda: time-stop de H horas de mercado post-fill
 *   C) el nulo: ¿selecciona o sólo recorta exposición?
 *   D) la versión con mecanismo: salir cuando el motor ya no generaría la señal
 *
 * TODO local. No toca VPS, Supabase, ni ninguna tabla viva. ESM.
 *
 * Uso:
 *   node timestop.js                 → corrida completa → results-timestop.json
 *   node timestop.js --draws=500     → menos sorteos (para probar rápido)
 *   node timestop.js --sinD          → saltea el bloque D (el caro)
 *
 * Reusa engine.js y el cache signals.json. El chequeo de arranque reproduce el
 * 38/base de INFORME.md (IS y OOS) con Δ = 0, y el replayer de trades
 * reproduce leg por leg el P&L de la cartera.
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
const SIN_D = ARGS.includes("--sinD");
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

function main() {
  const t0 = Date.now();
  const all = cargarTodo();
  const senales = cargarSenales();
  const ccl = loadCcl(DATA);
  const U38 = new Set(LIMPIOS_38.filter((s) => all.syms.includes(s)));
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
  const prevRc = JSON.parse(fs.readFileSync(path.join(DIR, "results-recompra.json"), "utf8"));
  const prevNu = JSON.parse(fs.readFileSync(path.join(DIR, "results-nulo.json"), "utf8"));
  console.log(`series ${all.syms.length} · señales ${senales.length} · universo limpio ${U38.size} · sorteos ${DRAWS} · semilla ${SEED}`);

  const rnd = mulberry32(SEED);
  const out = { generado: new Date().toISOString(), semilla: SEED, draws: DRAWS, Hs: HS };

  const gateBase = (s) => {
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };

  const CTX = {};
  for (const vn of ["IS", "OOS"]) CTX[vn] = construirCtx(all.hourly, U38, ...VENTANAS[vn]);

  /* ══════════ 0 · chequeo de arranque: el base reproduce INFORME.md ══════ */
  console.log(`\n===== 0 · CHEQUEO DE ARRANQUE =====`);
  const BASE = {};
  out.chequeo = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    const ord = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase);
    const sim = simular(ord, ctx, ccl);
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    BASE[vn] = { ctx, ord, sim, m };
    const ref = prev.corridas[`38/base/${vn}`].metricas.gold;
    const d1 = Math.abs(m.gold.mensualPct - ref.mensualPct), d2 = Math.abs(m.gold.total - ref.total);
    out.chequeo[vn] = { mensual: m.gold.mensualPct, ref: ref.mensualPct, dMensual: d1, dTotal: d2, n: m.gold.n, nRef: ref.n };
    console.log(`  ${vn}: trades ${m.gold.n} (informe ${ref.n}) · mensual gold ${n2(m.gold.mensualPct)}% (informe ${n2(ref.mensualPct)}%) · Δ=${d1.toExponential(1)} · ΔP&L=${d2.toExponential(1)}`);
  }

  // el replayer tiene que reproducir el P&L de la cartera trade por trade
  let okRep = 0, totRep = 0, maxDif = 0;
  for (const vn of ["IS", "OOS"]) {
    for (const tr of BASE[vn].sim.trades) {
      totRep++;
      const r = replayTrade(tr, BASE[vn].ctx, ccl, null);
      const real = tr.legs.reduce((s, l) => s + l.pnl.gold, 0);
      const dif = Math.abs(r.pnl.gold - real);
      maxDif = Math.max(maxDif, dif);
      if (dif < 1e-6) okRep++;
    }
  }
  out.chequeo.replay = { ok: okRep, tot: totRep, maxDif };
  console.log(`  replayer de trades == cartera en ${okRep}/${totRep} trades (máxima diferencia $${maxDif.toExponential(2)})`);

  /* ══════════ A · DESCRIPTIVO: P&L por duración ══════════ */
  console.log(`\n===== A · P&L POR DURACIÓN (sin aplicar ninguna regla nueva) =====`);
  out.A = {};
  const TR = {};   // trades enriquecidos por ventana
  for (const vn of ["IS", "OOS"]) {
    const ctx = BASE[vn].ctx;
    TR[vn] = BASE[vn].sim.trades.map((tr) => {
      const r = replayTrade(tr, ctx, ccl, null);
      const legs = tr.legs;
      const entN = legs.reduce((s, l) => s + l.entN, 0);
      const bruto = legs.reduce((s, l) => s + l.bruto, 0);
      const salida = legs.map((l) => l.reason).join("+");
      const exitTs = legs[legs.length - 1].exitTs;
      return {
        sym: tr.sym, dia: tr.dia, score: tr.score, rr: tr.rr, salida,
        vida: r.barras,                                   // barras de mercado del papel
        horasCal: (exitTs - tr.entryTs) / 3600000,        // horas corridas (lo que reporta INFORME.md)
        entN, bruto, brutoPct: entN > 0 ? bruto / entN : 0,
        gold: legs.reduce((s, l) => s + l.pnl.gold, 0),
        black: legs.reduce((s, l) => s + l.pnl.black, 0),
      };
    });

    const arr = TR[vn];
    const ord = [...arr].sort((a, b) => a.vida - b.vida);
    const deciles = [];
    for (let d = 0; d < 10; d++) {
      const a = Math.floor((d * ord.length) / 10), b = Math.floor(((d + 1) * ord.length) / 10);
      const g = ord.slice(a, b);
      if (!g.length) continue;
      const vidas = g.map((x) => x.vida).sort((p, q) => p - q);
      deciles.push({
        decil: d + 1, n: g.length,
        vidaMin: vidas[0], vidaMax: vidas[vidas.length - 1], vidaMed: vidas[Math.floor(vidas.length / 2)],
        horasCalMed: g.map((x) => x.horasCal).sort((p, q) => p - q)[Math.floor(g.length / 2)],
        win: g.filter((x) => x.gold > 0).length / g.length,
        winBruto: g.filter((x) => x.bruto > 0).length / g.length,
        gold: mean(g.map((x) => x.gold)), black: mean(g.map((x) => x.black)),
        brutoPct: g.reduce((s, x) => s + x.bruto, 0) / g.reduce((s, x) => s + x.entN, 0),
        salidas: g.reduce((a2, x) => { a2[x.salida] = (a2[x.salida] || 0) + 1; return a2; }, {}),
      });
    }
    const sp = {
      todos: spearman(arr.map((x) => x.vida), arr.map((x) => x.brutoPct)),
      todosGold: spearman(arr.map((x) => x.vida), arr.map((x) => x.gold)),
      ganadores: spearman(arr.filter((x) => x.bruto > 0).map((x) => x.vida), arr.filter((x) => x.bruto > 0).map((x) => x.brutoPct)),
      perdedores: spearman(arr.filter((x) => x.bruto <= 0).map((x) => x.vida), arr.filter((x) => x.bruto <= 0).map((x) => x.brutoPct)),
    };
    // Spearman ESTRATIFICADO por camino de salida: se rankea dentro de cada
    // camino y se juntan los rangos. Es el control contra el artefacto obvio
    // (los stops son cortos por construcción, los targets son largos).
    const porSalida = {};
    for (const x of arr) (porSalida[x.salida] = porSalida[x.salida] || []).push(x);
    const zx = [], zy = [];
    for (const g of Object.values(porSalida)) {
      if (g.length < 5) continue;
      const rv = rangos(g.map((x) => x.vida)), rp = rangos(g.map((x) => x.brutoPct));
      const n = g.length;
      for (let i = 0; i < n; i++) { zx.push((rv[i] - (n + 1) / 2) / n); zy.push((rp[i] - (n + 1) / 2) / n); }
    }
    sp.estratificado = spearman(zx, zy);
    sp.porSalida = {};
    for (const [k, g] of Object.entries(porSalida)) {
      if (g.length < 5) continue;
      sp.porSalida[k] = {
        n: g.length, sp: spearman(g.map((x) => x.vida), g.map((x) => x.brutoPct)),
        vidaMed: g.map((x) => x.vida).sort((p, q) => p - q)[Math.floor(g.length / 2)],
        gold: mean(g.map((x) => x.gold)),
      };
    }
    const vidas = arr.map((x) => x.vida).sort((a, b) => a - b);
    const horas = arr.map((x) => x.horasCal).sort((a, b) => a - b);
    out.A[vn] = {
      n: arr.length, deciles, spearman: sp,
      vidaMed: vidas[Math.floor(vidas.length / 2)], vidaProm: mean(vidas), vidaP90: vidas[Math.floor(vidas.length * 0.9)],
      horasCalMed: horas[Math.floor(horas.length / 2)], horasCalProm: mean(horas), horasCalP90: horas[Math.floor(horas.length * 0.9)],
    };
    console.log(`\n  --- ${vn} · ${arr.length} trades · vida en BARRAS DE MERCADO: mediana ${out.A[vn].vidaMed} promedio ${n2(out.A[vn].vidaProm, 1)} p90 ${out.A[vn].vidaP90}`);
    console.log(`      (en horas CORRIDAS, que es lo que reporta INFORME.md: mediana ${n2(out.A[vn].horasCalMed, 0)} promedio ${n2(out.A[vn].horasCalProm, 0)} p90 ${n2(out.A[vn].horasCalP90, 0)})`);
    console.log(`  decil  n  vida(med)  win%  bruto%  gold/trade  black/trade  caminos`);
    for (const d of deciles) {
      console.log(`   ${String(d.decil).padStart(2)}  ${String(d.n).padStart(3)}  ${String(d.vidaMed).padStart(4)} (${d.vidaMin}-${d.vidaMax})  ${pct(d.win).padStart(6)}  ${pct(d.brutoPct, 2).padStart(7)}  ${fmt(d.gold).padStart(10)}  ${fmt(d.black).padStart(10)}  ${JSON.stringify(d.salidas)}`);
    }
    console.log(`  Spearman vida vs bruto%: rho ${n2(sp.todos.rho, 3)} p ${n2(sp.todos.p2, 4)} · vs P&L gold: rho ${n2(sp.todosGold.rho, 3)} p ${n2(sp.todosGold.p2, 4)}`);
    console.log(`  ...ganadores (bruto>0, n=${sp.ganadores?.n}): rho ${n2(sp.ganadores?.rho, 3)} p ${n2(sp.ganadores?.p2, 4)} · perdedores (n=${sp.perdedores?.n}): rho ${n2(sp.perdedores?.rho, 3)} p ${n2(sp.perdedores?.p2, 4)}`);
    console.log(`  ...ESTRATIFICADO por camino de salida (n=${sp.estratificado?.n}): rho ${n2(sp.estratificado?.rho, 3)} p ${n2(sp.estratificado?.p2, 4)}`);
    for (const [k, v] of Object.entries(sp.porSalida)) {
      console.log(`      ${k.padEnd(20)} n=${String(v.n).padStart(3)} vida med ${String(v.vidaMed).padStart(4)} gold/trade ${fmt(v.gold).padStart(9)} rho ${n2(v.sp.rho, 3)} p ${n2(v.sp.p2, 4)}`);
    }
  }

  // tabla controlada por camino de salida, IS+OOS juntos (para tener n)
  console.log(`\n  --- control por camino de salida · IS+OOS · terciles de duración dentro de cada camino ---`);
  const juntos = [...TR.IS, ...TR.OOS];
  out.A.control = {};
  const porSal = {};
  for (const x of juntos) (porSal[x.salida] = porSal[x.salida] || []).push(x);
  for (const [k, g0] of Object.entries(porSal)) {
    if (g0.length < 9) continue;
    const g = [...g0].sort((a, b) => a.vida - b.vida);
    out.A.control[k] = [];
    for (let i = 0; i < 3; i++) {
      const a = Math.floor((i * g.length) / 3), b = Math.floor(((i + 1) * g.length) / 3);
      const t = g.slice(a, b);
      const vv = t.map((x) => x.vida).sort((p, q) => p - q);
      const row = {
        tercil: i + 1, n: t.length, vidaMed: vv[Math.floor(vv.length / 2)],
        win: t.filter((x) => x.gold > 0).length / t.length,
        gold: mean(t.map((x) => x.gold)), black: mean(t.map((x) => x.black)),
        brutoPct: t.reduce((s, x) => s + x.bruto, 0) / t.reduce((s, x) => s + x.entN, 0),
      };
      out.A.control[k].push(row);
      console.log(`   ${k.padEnd(20)} T${row.tercil} n=${String(row.n).padStart(3)} vida med ${String(row.vidaMed).padStart(4)} win ${pct(row.win).padStart(6)} bruto ${pct(row.brutoPct, 2).padStart(7)} gold ${fmt(row.gold).padStart(9)} black ${fmt(row.black).padStart(9)}`);
    }
  }

  /* ══════════ B · EL BARRIDO DE H ══════════ */
  console.log(`\n===== B · TIME-STOP DE H HORAS POST-FILL =====`);
  out.B = {};
  const nuevasSR = [];
  /* Dos relojes. El enunciado pide horas DE MERCADO; se corre también el
   * reloj de horas CORRIDAS porque la cola de duraciones que motivó la
   * hipótesis (mediana 24, p90 144 en INFORME.md) está medida en horas
   * corridas, y porque con el reloj de mercado la mitad de arriba del barrido
   * no corta nada (ningún trade del base vive 120 barras de mercado). */
  const RELOJES = [
    { id: "mercado", etiq: "H = barras horarias DEL PAPEL desde el fill", opt: (H) => ({ maxBarras: H }) },
    { id: "corrido", etiq: "H = horas CORRIDAS desde el fill", opt: (H) => ({ maxHorasCal: H }) },
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
  const mono = (v) => {
    let cre = true, dec = true;
    for (let i = 1; i < v.length; i++) { if (v[i] < v[i - 1] - 1e-12) cre = false; if (v[i] > v[i - 1] + 1e-12) dec = false; }
    return cre ? "creciente en H (a menor H, peor)" : dec ? "decreciente en H (a menor H, mejor)" : "NO monótono";
  };
  for (const rel of RELOJES) {
    out.B[rel.id] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = BASE[vn].ctx, ord = BASE[vn].ord, base = BASE[vn].m;
      out.B[rel.id][vn] = { base: Object.fromEntries(TIERS.map((t) => [t, { mensual: base[t].mensualPct, total: base[t].total, n: base[t].n, win: base[t].winRate, payoff: base[t].payoff, sharpe: base[t].sharpe, dd: base[t].maxDDpct }])) };
      console.log(`\n  --- ${rel.etiq} · ${vn} (base: n=${base.gold.n} mensual gold ${n2(base.gold.mensualPct)}% plat ${n2(base.platinum.mensualPct)}% black ${n2(base.black.mensualPct)}%) ---`);
      console.log(`     H  trades  x-TS  win%   pay  ─ gold ─  ─ plat ─  ─ black ─   Sharpe    DD%    ΔP&L gold cartera   ΔP&L gold aislado`);
      for (const H of HS) {
        const sim = simular(ord, ctx, ccl, rel.opt(H));
        const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
        const nTS = sim.legs.filter((l) => l.reason === "timestop").length;
        // aislado: mismo set de trades del base, cortado por la regla, sin el
        // efecto de segundo orden de liberar la silla antes
        const cortes = cortesDe(rel.id, vn, H);
        const aisl = { gold: 0, platinum: 0, black: 0 }, aislBase = { gold: 0, platinum: 0, black: 0 };
        BASE[vn].sim.trades.forEach((tr, i) => {
          const r = replayTrade(tr, ctx, ccl, cortes.get(i) ?? null);
          for (const t of TIERS) { aisl[t] += r.pnl[t]; aislBase[t] += tr.legs.reduce((s, l) => s + l.pnl[t], 0); }
        });
        const noop = nTS === 0 && cortes.size === 0;
        out.B[rel.id][vn][`H${H}`] = {
          n: m.gold.n, nTimestop: nTS, nCortadosAislado: cortes.size, noop,
          win: m.gold.winRate, payoff: m.gold.payoff, sharpe: m.gold.sharpe, dd: m.gold.maxDDpct,
          mensual: Object.fromEntries(TIERS.map((t) => [t, m[t].mensualPct])),
          total: Object.fromEntries(TIERS.map((t) => [t, m[t].total])),
          deltaCartera: Object.fromEntries(TIERS.map((t) => [t, m[t].total - base[t].total])),
          deltaAislado: Object.fromEntries(TIERS.map((t) => [t, aisl[t] - aislBase[t]])),
          mensualAislado: Object.fromEntries(TIERS.map((t) => [t, (aisl[t] / CAPITAL / ctx.meses) * 100])),
          brutoPct: m.gold.brutoPct,
        };
        // una H que no corta NADA es literalmente el caso base: no es una
        // configuración nueva y no entra en el N del DSR
        if (!noop) nuevasSR.push({ nombre: `timestop ${rel.id} H=${H}/${vn}`, sr: m.gold.srDiario, srB: m.black.srDiario, rets: m.gold.rets, retsB: m.black.rets, shG: m.gold.sharpe, shB: m.black.sharpe });
        console.log(`   ${String(H).padStart(3)}  ${String(m.gold.n).padStart(5)}  ${String(nTS).padStart(4)}  ${pct(m.gold.winRate).padStart(5)}  ${n2(m.gold.payoff).padStart(4)}  ${n2(m.gold.mensualPct).padStart(6)}%  ${n2(m.platinum.mensualPct).padStart(6)}%  ${n2(m.black.mensualPct).padStart(6)}%  ${n2(m.gold.sharpe).padStart(6)}  ${n2(m.gold.maxDDpct, 1).padStart(5)}  ${fmt(m.gold.total - base.gold.total).padStart(18)}  ${fmt(aisl.gold - aislBase.gold).padStart(18)}${noop ? "   (no corta nada = base)" : ""}`);
      }
      const mg = HS.map((H) => out.B[rel.id][vn][`H${H}`].mensual.gold);
      const ma = HS.map((H) => out.B[rel.id][vn][`H${H}`].mensualAislado.gold);
      out.B[rel.id][vn].monotonia = { cartera: mono(mg), aislado: mono(ma), serieCartera: mg, serieAislada: ma };
      console.log(`   monotonía del mensual gold contra H: cartera ${mono(mg)} · aislado ${mono(ma)}`);
    }
  }

  /* ══════════ C · EL NULO ══════════
   * Dos nulos, los dos sobre el SET DE TRADES DEL BASE (sin re-simular la
   * cartera: así el nulo y la regla real mueven exactamente las mismas piezas
   * y la comparación no mezcla el efecto de segundo orden de liberar la silla
   * antes, que se reporta aparte en el bloque B).
   *   nulo 1 (el del enunciado): K trades al azar de TODOS, cerrados a mercado
   *           en un momento uniforme dentro de su vida real.
   *   nulo 2 (más exigente): los MISMOS K trades que la regla trunca, pero
   *           cortados en un momento al azar de su vida en vez de en H. Aísla
   *           "importa CUÁNDO cortar" de "importa A QUIÉN cortar".
   */
  console.log(`\n===== C · EL NULO · ¿selecciona o sólo recorta? (${DRAWS} sorteos, semilla ${SEED}) =====`);
  out.C = {};

  function correrNulo(vn, cortesReales, etiqueta) {
    // cortesReales: Map(indiceTrade → barraDeCorte) de la regla real
    const ctx = BASE[vn].ctx, trades = BASE[vn].sim.trades;
    const vidas = TR[vn].map((x) => x.vida);
    const baseP = Object.fromEntries(TIERS.map((t) => [t, trades.map((tr) => tr.legs.reduce((s, l) => s + l.pnl[t], 0))]));
    const baseTot = Object.fromEntries(TIERS.map((t) => [t, baseP[t].reduce((s, x) => s + x, 0)]));
    // real
    const realTot = Object.fromEntries(TIERS.map((t) => [t, baseTot[t]]));
    const cacheReal = new Map();
    for (const [i, c] of cortesReales) {
      const r = replayTrade(trades[i], ctx, ccl, c);
      cacheReal.set(i, r);
      for (const t of TIERS) realTot[t] += r.pnl[t] - baseP[t][i];
    }
    const K = cortesReales.size;
    const elegibles = [...cortesReales.keys()];
    const mens = (v) => (v / CAPITAL / ctx.meses) * 100;
    const res = { K, n: trades.length, realMensual: Object.fromEntries(TIERS.map((t) => [t, mens(realTot[t])])), baseMensual: Object.fromEntries(TIERS.map((t) => [t, mens(baseTot[t])])) };
    if (!K) return res;
    for (const [nn, pool] of [["nulo1", [...trades.keys()]], ["nulo2", elegibles]]) {
      const dist = { gold: [], black: [] };
      const idx = [...pool];
      for (let b = 0; b < DRAWS; b++) {
        const sel = sorteoK(idx, idx.length, Math.min(K, idx.length), rnd);
        const tot = { gold: baseTot.gold, black: baseTot.black };
        for (const i of sel) {
          const L = vidas[i];
          const u = 1 + Math.floor(rnd() * Math.max(1, L));   // uniforme entre el fill y la salida real
          const r = replayTrade(trades[i], ctx, ccl, u);
          tot.gold += r.pnl.gold - baseP.gold[i];
          tot.black += r.pnl.black - baseP.black[i];
        }
        dist.gold.push(mens(tot.gold)); dist.black.push(mens(tot.black));
      }
      res[nn] = { gold: ubicar(res.realMensual.gold, dist.gold), black: ubicar(res.realMensual.black, dist.black) };
    }
    console.log(`   ${etiqueta.padEnd(28)} ${vn} K=${String(K).padStart(3)} real ${n2(res.realMensual.gold).padStart(6)}% (base ${n2(res.baseMensual.gold)}%) · nulo1 pctil ${pct(res.nulo1.gold.percentil).padStart(6)} p=${res.nulo1.gold.p1cola.toFixed(4)} · nulo2 pctil ${pct(res.nulo2.gold.percentil).padStart(6)} p=${res.nulo2.gold.p1cola.toFixed(4)} · black nulo2 pctil ${pct(res.nulo2.black.percentil)}`);
    return res;
  }

  out.C.timestop = {};
  for (const rel of RELOJES) {
    out.C.timestop[rel.id] = {};
    for (const vn of ["IS", "OOS"]) {
      out.C.timestop[rel.id][vn] = {};
      for (const H of HS) {
        const cortes = cortesDe(rel.id, vn, H);
        if (!cortes.size) continue;
        out.C.timestop[rel.id][vn][`H${H}`] = correrNulo(vn, cortes, `${rel.id} H=${H}`);
      }
    }
  }

  /* ══════════ D · LA VERSIÓN FIEL AL PAPER: "razón muerta" ══════════ */
  out.D = {};
  if (!SIN_D) {
    console.log(`\n===== D · SALIDA POR "RAZÓN MUERTA" (el motor ya no generaría la señal) =====`);
    const ANA = {};
    const getAna = (sym) => {
      if (!ANA[sym]) ANA[sym] = analizadorPorSimbolo(all.daily[sym], all.hourly[sym]);
      return ANA[sym];
    };
    // D1 (literal del enunciado): la señal VIGENTE del motor ya no es ésta
    // D2 (ancla): el NIVEL ORIGINAL dejó de calificar como soporte operable
    const evaluar = (sym, tms, entry) => {
      const a = getAna(sym);
      const i = a.idxDe(tms);
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
      const m2 = motivoMuerte(an, true), m3 = motivoMuerte(an, false);
      return {
        D1: m1 != null, D2: m2 != null, D3: m3 != null,
        motivoD1: m1, motivoD2: m2, motivoD3: m3,
      };
    };
    const MODOS = {
      D1: "el motor ya no emite ESTA señal (lectura literal)",
      D2: "el nivel original ya no califica (score >= 7 y R:R >= 2)",
      D3: "el nivel original ya no califica, sin la condición de R:R",
    };

    /* self-check: evaluado en la barra de la SEÑAL, el evaluador anclado tiene
     * que devolver el mismo score y el mismo R:R que emitió el motor. Si no,
     * el "ancla" estaría midiendo otra cosa y todo el bloque D no valdría. */
    let okA = 0, totA = 0, difS = 0, difR = 0;
    for (const vn of ["IS", "OOS"]) for (const tr of BASE[vn].sim.trades) {
      totA++;
      const a = getAna(tr.sym), i = a.idxDe(tr.tsSenal * 1000);
      if (i == null) continue;
      const pz = a.piezas(i);
      if (!pz) continue;
      const an = evalAncla(pz, tr.entryPx);
      if (an.score === tr.score && an.rr === tr.rr) okA++;
      else { if (an.score !== tr.score) difS++; if (an.rr !== tr.rr) difR++; }
    }
    out.D.selfCheckAncla = { ok: okA, tot: totA, difScore: difS, difRR: difR };
    console.log(`  [self-check] el evaluador anclado reproduce score y R:R de la señal en ${okA}/${totA} trades (difieren: score ${difS}, R:R ${difR})`);

    for (const modo of ["D1", "D2", "D3"]) {
      out.D[modo] = { definicion: MODOS[modo] };
      console.log(`\n  --- ${modo}: ${MODOS[modo]} ---`);
      for (const vn of ["IS", "OOS"]) {
        const ctx = BASE[vn].ctx, ord = BASE[vn].ord;
        const muerta = (sym, t, pos) => {
          const e = evaluar(sym, t, pos.entryPx);
          return e ? e[modo] : false;
        };
        const sim = simular(ord, ctx, ccl, { razonMuerta: muerta });
        const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
        const nRM = sim.legs.filter((l) => l.reason === "razon_muerta").length;
        // versión aislada sobre el set base: primera barra con la razón muerta
        const cortes = new Map();
        const vidasCorte = [], motivos = {};
        BASE[vn].sim.trades.forEach((tr, i) => {
          const arr = ctx.serie[tr.sym], i0 = ctx.idx[tr.sym].get(tr.entryTs);
          const L = TR[vn][i].vida;
          for (let k = 1; k <= L; k++) {
            const b = arr[i0 + k];
            if (!b) break;
            const e = evaluar(tr.sym, b.ts * 1000, tr.entryPx);
            if (e && e[modo]) {
              cortes.set(i, k); vidasCorte.push(k);
              const mm = e["motivo" + modo];
              motivos[mm] = (motivos[mm] || 0) + 1;
              break;
            }
          }
        });
        const nul = correrNulo(vn, cortes, `razón muerta ${modo}`);
        const base = BASE[vn].m;
        out.D[modo][vn] = {
          n: m.gold.n, nRazonMuerta: nRM, win: m.gold.winRate, payoff: m.gold.payoff,
          sharpe: m.gold.sharpe, dd: m.gold.maxDDpct,
          mensual: Object.fromEntries(TIERS.map((t) => [t, m[t].mensualPct])),
          total: Object.fromEntries(TIERS.map((t) => [t, m[t].total])),
          deltaCartera: Object.fromEntries(TIERS.map((t) => [t, m[t].total - base[t].total])),
          cortesAislado: cortes.size, motivos,
          barraCorteMediana: vidasCorte.length ? [...vidasCorte].sort((a, b) => a - b)[Math.floor(vidasCorte.length / 2)] : null,
          barraCorteP90: vidasCorte.length ? [...vidasCorte].sort((a, b) => a - b)[Math.floor(vidasCorte.length * 0.9)] : null,
          nulo: nul,
        };
        nuevasSR.push({ nombre: `razón muerta ${modo}/${vn}`, sr: m.gold.srDiario, srB: m.black.srDiario, rets: m.gold.rets, retsB: m.black.rets, shG: m.gold.sharpe, shB: m.black.sharpe });
        console.log(`   ${modo}/${vn}: trades ${m.gold.n} · cierres por razón muerta ${nRM} · mensual gold ${n2(m.gold.mensualPct)}% (base ${n2(base.gold.mensualPct)}%) black ${n2(m.black.mensualPct)}% (base ${n2(base.black.mensualPct)}%) · Sharpe ${n2(m.gold.sharpe)} · DD ${n2(m.gold.maxDDpct, 1)}% · ΔP&L gold ${fmt(m.gold.total - base.gold.total)}`);
        console.log(`       aislado: corta ${cortes.size}/${BASE[vn].sim.trades.length} trades, barra de corte mediana ${out.D[modo][vn].barraCorteMediana} p90 ${out.D[modo][vn].barraCorteP90} · motivos ${JSON.stringify(motivos)}`);
      }
    }
  }

  /* ══════════ E · DSR con el N actualizado ══════════ */
  console.log(`\n===== E · DSR · N actualizado =====`);
  const srsG = [], srsB = [];
  for (const k of Object.keys(prev.corridas)) {
    if (prev.corridas[k]._sr != null) srsG.push(prev.corridas[k]._sr);
    if (prev.corridas[k]._srB != null) srsB.push(prev.corridas[k]._srB);
  }
  const mults = [0.7, 0.85, 1, 1.15, 1.3];
  let chkSweep = 0;
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
  // las 16 de INFORME-NULO (4 variantes del umbral × 2 + 4 cuantiles × 2)
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
  const nPrev = srsG.length;
  const sigPrevG = stdev(srsG), sigPrevB = stdev(srsB);
  console.log(`  reconstrucción del N anterior: ${nPrev} (informe: ${prevNu.dsr.N}) · sigma gold ${sigPrevG.toExponential(4)} (informe ${prevNu.dsr.sigmaSR.toExponential(4)}) · black ${sigPrevB.toExponential(4)} (informe ${prevNu.dsr.sigmaSRblack.toExponential(4)}) · sweep ${chkSweep}/50`);

  for (const v of nuevasSR) { srsG.push(v.sr); if (v.srB != null) srsB.push(v.srB); }
  const N = nPrev + nuevasSR.length;
  const sigG = stdev(srsG), sigB = stdev(srsB);
  console.log(`  N ${nPrev} → ${N} (+${nuevasSR.length} variantes nuevas) · sigma gold ${sigG.toExponential(4)} · black ${sigB.toExponential(4)}`);
  out.dsr = { Nprevio: nPrev, N, sigmaSR: sigG, sigmaSRblack: sigB, chequeoSweep: chkSweep, reconstruccion: { sigPrevG, sigPrevB, refN: prevNu.dsr.N, refG: prevNu.dsr.sigmaSR, refB: prevNu.dsr.sigmaSRblack }, filas: {} };

  const filas = [];
  for (const vn of ["IS", "OOS"]) {
    const m = BASE[vn].m;
    filas.push({ nombre: `base/${vn}`, shG: m.gold.sharpe, shB: m.black.sharpe, rets: m.gold.rets, retsB: m.black.rets, sr: m.gold.srDiario, srB: m.black.srDiario });
  }
  for (const v of nuevasSR) filas.push(v);
  for (const f of filas) {
    const dG = dsr(f.rets, f.sr, sigG, N), dB = dsr(f.retsB ?? f.rets, f.srB ?? f.sr, sigB, N);
    out.dsr.filas[f.nombre] = { sharpeGold: f.shG, dsrGold: dG ? dG.dsr : null, sharpeBlack: f.shB, dsrBlack: dB ? dB.dsr : null };
    console.log(`  ${f.nombre.padEnd(34)} gold SR ${n2(f.shG).padStart(6)} DSR ${dG ? dG.dsr.toFixed(5) : "-"} · black SR ${n2(f.shB).padStart(6)} DSR ${dB ? dB.dsr.toFixed(5) : "-"}`);
  }

  fs.writeFileSync(path.join(DIR, "results-timestop.json"), JSON.stringify(out, null, 1));
  console.log(`\nresults-timestop.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
