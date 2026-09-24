/* cocos.js — el mismo estudio, con la tarifa de COCOS como cuarta columna.
 *
 * Todo el proyecto backtest-5y se corrió con las tres tarifas de IOL (Gold,
 * Platinum, Black). Nunca se corrió la de Cocos, que es donde LP también opera
 * y donde el broker NO cobra comisión: se pagan sólo los derechos de mercado
 * más IVA. La constante sale TAL CUAL del worker
 * (`workers/niveles-auto/worker.js`, bloque "En Cocos no hay comision del
 * broker: se paga solo esto"):
 *
 *     const FEE_COCOS = 0.0005 * IVA;        // 0,0605% por punta
 *
 * o sea 0,121% de ida y vuelta, contra 1,121% de Gold. Y sin bonificación
 * intradiaria que modelar: como no hay comisión de broker, las dos patas
 * cuestan igual (el worker lo dice explícito en el bloque de cierre).
 *
 * Bloques:
 *   0) chequeo de consistencia: gold/platinum/black tienen que reproducir
 *      results.json número por número. Si no, se aborta.
 *   A) caso base, 38 limpios, 4 tarifas, IS y OOS
 *   B) universo de 50 con alta real + sesgo de selección recalculado
 *   C) descomposición del bruto: cuánto puso el CCL y cuánto el papel
 *   D) las cinco hipótesis muertas, re-corridas con Cocos y pasadas por el nulo
 *   E) DSR con el N actualizado
 *
 * Reusa engine.js y el cache signals.json. Todo local: no toca VPS, Supabase
 * ni nada vivo. ESM.
 *
 *   node cocos.js                → corrida completa → results-cocos.json
 *   node cocos.js --draws=500    → menos sorteos (para iterar)
 *   node cocos.js --sinDSR       → saltea la reconstrucción del N (la cara)
 *
 * SEMILLA: 20260917 (mulberry32), la misma de todos los anexos.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LB, ZONE_TOL, allPivots, buildDailyCtx, analyzeKit, gatePasa, clusterZones,
  scoreZone, patternAtZone, loadSeries, loadCcl, emaOf, emaStep,
} from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = process.argv.slice(2);
const argN = (k, d) => { const a = ARGS.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split("=")[1]) : d; };
const DRAWS = argN("draws", 5000);
const SIN_DSR = ARGS.includes("--sinDSR");
const SEED = 20260917;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── constantes: IDÉNTICAS a simulate.js / nulo.js / timestop.js ── */
const CAPITAL = 7_000_000;
const RISK = 0.015;
const MAX_POS = 5;
const MAX_DIA = 5;
const CAP_PCT = 0.20;
const VENTANA_H = 48;
const TP_FRAC = 0.5;
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;                 // 0,0605% — derechos de mercado + IVA
const FEE = {
  gold: 0.005 * IVA + DERECHOS,                // 0,6655%
  platinum: 0.003 * IVA + DERECHOS,            // 0,4235%
  black: 0.001 * IVA + DERECHOS,               // 0,1815%
  cocos: 0.0005 * IVA,                         // 0,0605% — FEE_COCOS del worker
};
const TIERS = ["gold", "platinum", "black", "cocos"];
const DIAS_DAILY = 252, DIAS_HOURLY = 30, DIAS_REGIME = 126;

const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";
const VENTANAS = { IS: [IS_DESDE, IS_HASTA], OOS: [OOS_DESDE, OOS_HASTA] };

const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TRUNCA_DAILY = { OKLO: "2024-05-10", RGTI: "2022-03-01", SATL: "2022-01-01", KEEL: "2026-04-06", LAR: "2025-01-27" };
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

/* ── features de SPY (copia literal de nulo.js) ── */
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

/* ────────────────── ctx / órdenes / simulador ──────────────────
 * Copia de timestop.js (que es la de nulo.js, que es la de simulate.js) con
 * UN cambio: TIERS incluye "cocos". El chequeo de arranque verifica que las
 * tres tarifas de IOL siguen dando exactamente lo publicado. */
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

function simular(ordenes, ctx, ccl, { light = false, exitMode = "intrabar", capPct = CAP_PCT, maxBarras = null, maxHorasCal = null, razonMuerta = null } = {}) {
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
        pend.delete(sym);
        const pos = {
          sym: p.sym, qty: p.qty, qty0: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          notional: p.qty * p.entry * p.rIn, legs: [], tpDone: false, barras: 0,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia, vol: p.vol, s200: p.s200, s50: p.s50,
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
      if (maxBarras != null && pos.barras >= maxBarras) { cerrarPata(pos, pos.qty, b.c, t, "timestop"); open.delete(sym); continue; }
      if (maxHorasCal != null && (t - pos.entryTs) / 3600000 >= maxHorasCal) { cerrarPata(pos, pos.qty, b.c, t, "timestop"); open.delete(sym); continue; }
      if (razonMuerta && razonMuerta(sym, t, pos)) { cerrarPata(pos, pos.qty, b.c, t, "razon_muerta"); open.delete(sym); continue; }
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

/* ── replayer de UN trade, aislado de la cartera (copia de timestop.js) ── */
function replayTrade(pos, ctx, ccl, corte = null) {
  const arr = ctx.serie[pos.sym], i0 = ctx.idx[pos.sym].get(pos.entryTs);
  const rArs = (d) => ccl(d) || 1;
  const out = { legs: [], pnl: Object.fromEntries(TIERS.map((t) => [t, 0])), bruto: 0, entN: 0, barras: 0, salida: [] };
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
function barraDeHoras(pos, ctx, Hc, vida) {
  const arr = ctx.serie[pos.sym], i0 = ctx.idx[pos.sym].get(pos.entryTs);
  for (let k = 1; k <= vida; k++) {
    const b = arr[i0 + k];
    if (!b) return null;
    if ((b.ts * 1000 - pos.entryTs) / 3600000 >= Hc) return k;
  }
  return null;
}

/* ───────── simulador CON RECOMPRA (copia de recompra.js, con lotes) ─────── */
function simularRc(ordenes, ctx, ccl, { recompra = null, rcOrden = "pre", capPct = CAP_PCT } = {}) {
  const { barAt, timeline, tFin, bars } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const entradasDia = new Map();
  const realized = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const equity = [];
  let oi = 0, nRecompras = 0;

  const notionalDe = (pos) => {
    let s = pos.lots.reduce((a, l) => a + l.qty * l.entryPx * l.rIn, 0);
    if (pos.rcViva) s += pos.rcQty * pos.rcLevel * pos.rIn;
    return s;
  };
  const comprometido = () => {
    let s = 0;
    for (const p of pend.values()) s += p.notional;
    for (const p of open.values()) s += notionalDe(p);
    return s;
  };
  const feeLeg = (n, tier, bonif) => n * (bonif ? DERECHOS : FEE[tier]);
  const cerrarLote = (pos, lot, qty, px, ts, reason, tag) => {
    const d = dia(ts / 1000);
    const rOut = rArs(d);
    const intradia = dia(lot.entryTs / 1000) === d;
    const entN = qty * lot.entryPx * lot.rIn;
    const outN = qty * px * rOut;
    const leg = { sym: pos.sym, qty, reason, tag, entryTs: lot.entryTs, exitTs: ts, entN, bruto: outN - entN, brutoSinCcl: qty * (px - lot.entryPx) * lot.rIn, pnl: {}, fees: {} };
    for (const tier of TIERS) {
      const f = feeLeg(entN, tier, false) + feeLeg(outN, tier, intradia);
      leg.fees[tier] = f; leg.pnl[tier] = outN - entN - f; realized[tier] += leg.pnl[tier];
    }
    lot.qty -= qty;
    legs.push(leg); pos.legs.push(leg);
  };
  const cerrarTodo = (pos, px, ts, reason) => {
    for (const lot of pos.lots) if (lot.qty > 0) cerrarLote(pos, lot, lot.qty, px, ts, reason, lot.tag);
    pos.salidaFinal = reason; pos.exitTs = ts; pos.exitPx = px;
  };

  for (const t of timeline) {
    while (oi < ordenes.length && ordenes[oi].created <= t) {
      const o = ordenes[oi++];
      if (!barAt[o.sym]) continue;
      if (open.has(o.sym)) continue;
      const prev = pend.get(o.sym);
      if (prev && Math.abs(prev.entry - o.entry) / o.entry < 0.005) continue;
      if (prev) pend.delete(o.sym);
      if (pend.size + open.size >= MAX_POS) continue;
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) continue;
      const rIn = rArs(d);
      const riesgoU = (o.entry - o.stop) * rIn;
      if (!(riesgoU > 0)) continue;
      let qty = Math.min((CAPITAL * RISK * o.riskMult) / riesgoU, (CAPITAL * capPct) / (o.entry * rIn), Math.max(0, CAPITAL - comprometido()) / (o.entry * rIn));
      if (!(qty > 0)) continue;
      entradasDia.set(d, (entradasDia.get(d) || 0) + 1);
      pend.set(o.sym, { ...o, qty, rIn, notional: qty * o.entry * rIn });
    }

    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); continue; }
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (b.l <= p.entry) {
        pend.delete(sym);
        const pos = {
          sym: p.sym, qtyOrig: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          midStop: (p.entry + p.stop) / 2,
          lots: [{ qty: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn, tag: "orig" }],
          legs: [], tpDone: false, tpTs: null, tpQty: 0,
          rcViva: false, rcLevel: null, rcQty: 0, rcCreated: null, rcFillTs: null,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }

    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs) continue;
      const hi = b.h, lo = b.l;
      const fillRc = () => {
        if (!(pos.rcViva && t > pos.rcCreated && lo <= pos.rcLevel)) return;
        const rIn = rArs(dia(t / 1000));
        pos.lots.push({ qty: pos.rcQty, entryPx: pos.rcLevel, entryTs: t, rIn, tag: "rc" });
        pos.rcViva = false; pos.rcFillTs = t; nRecompras++;
      };
      if (rcOrden === "pre") fillRc();
      if (lo <= pos.stop) { pos.rcViva = false; cerrarTodo(pos, pos.stop, t, pos.stop > pos.stopIni ? "trailing" : "stop"); open.delete(sym); continue; }
      if (rcOrden === "post") fillRc();
      if (TP_FRAC > 0 && !pos.tpDone) {
        const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
        if (hi >= nivel) {
          const q = pos.qtyOrig / 2;
          cerrarLote(pos, pos.lots[0], q, Math.min(nivel, pos.target), t, "tp_parcial", "orig");
          pos.tpDone = true; pos.tpTs = t; pos.tpQty = q;
          if (recompra) { pos.rcViva = true; pos.rcQty = q; pos.rcCreated = t; pos.rcLevel = recompra === "entry" ? pos.entryPx : pos.midStop; }
        }
      }
      if (hi >= pos.target) { pos.rcViva = false; cerrarTodo(pos, pos.target, t, "target"); open.delete(sym); continue; }
      const k = Math.floor((hi - pos.entryPx) / pos.R);
      if (k >= 2 && pos.entryPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (k - 2) * pos.R;
    }

    const d = dia(t / 1000);
    let unreal = 0;
    for (const [sym, pos] of open) {
      const b = barAt[sym].get(t);
      for (const lot of pos.lots) if (lot.qty > 0) unreal += lot.qty * ((b ? b.c : lot.entryPx) - lot.entryPx) * lot.rIn;
    }
    const row = { dia: d, eq: {} };
    for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
    if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row;
    else equity.push(row);
  }

  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || bars[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    pos.rcViva = false;
    cerrarTodo(pos, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (equity.length) { const last = equity[equity.length - 1]; for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier]; }
  return { trades, legs, equity, realized, nRecompras, nSenales: ordenes.length };
}

/* ── el motor barra por barra por símbolo (para la "razón muerta") ── */
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
function evalAncla({ ctx, partial, hourly, hourPivs, spot }, ancla) {
  const dailyFull = partial ? [...ctx.win, partial] : ctx.win;
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
  let z = null, mejor = Infinity;
  for (const zz of supZ) { const d = Math.abs(zz.hi - ancla) / ancla; if (d <= ZONE_TOL && d < mejor) { mejor = d; z = zz; } }
  if (!z) return { zona: false, motivo: "zona disuelta", score: null, rr: null };
  const below = supZ.filter((x) => x.hi < z.lo * 0.995);
  const stopLvl = below.length ? below[below.length - 1].lo * 0.993 : z.hi - atr;
  const sellsAbove = resZ.filter((x) => x.lo > spot * 1.001);
  const sellZone = sellsAbove.length ? sellsAbove[0] : null;
  const rr = sellZone && stopLvl && z.hi - stopLvl > 0 ? Math.round(((sellZone.lo - z.hi) / (z.hi - stopLvl)) * 10) / 10 : null;
  const sc = scoreZone(z, emas);
  const pat = patternAtZone(dailyFull, z, "sup") || (hourly ? patternAtZone(hourly, z, "sup") : null);
  if (pat && pat.bull) sc.score += 1;
  if (ctx.div.bull) sc.score += 1;
  if (ctx.poc && Math.abs(ctx.poc - z.avg) / z.avg <= 0.01) sc.score += 1;
  if (ctx.prof && z.hi > z.lo) {
    let acc = 0;
    for (const b of ctx.prof.bins) { const ov = Math.min(z.hi, b.hi) - Math.max(z.lo, b.lo); if (ov > 0) acc += b.pct * (ov / (b.hi - b.lo)); }
    if (acc >= 6) sc.score += 1; else if (acc < 1.5) sc.score -= 1;
  }
  if (ctx.estr === "alcista") sc.score += 1; else if (ctx.estr === "bajista") sc.score -= 1;
  const low20 = Math.min(...dailyFull.slice(-20).map((c) => c.l));
  const ct = ctx.estr === "bajista" && dailyFull[dailyFull.length - 1].l <= low20 * 1.01;
  if (ct) sc.score = Math.min(sc.score, 4);
  return { zona: true, ct, score: Math.max(1, Math.min(10, sc.score)), rr };
}
function motivoMuerte(an, conRR) {
  if (!an.zona) return an.motivo || "zona disuelta";
  if (an.ct) return "contra-tendencia";
  if (an.score < 7) return "score < 7";
  if (conRR && (an.rr == null || an.rr < 2)) return "R:R < 2";
  return null;
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
    sharpe, maxDDpct: dd * 100, srDiario: sd > 0 ? m / sd : null, rets, meses,
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
/* equity diaria reconstruida desde los legs de un subconjunto de trades
 * (modo aislado, copia de barrido.js) */
function equityDeTrades(trs, ctx) {
  const porDia = new Map();
  for (const tr of trs) for (const l of tr.legs) {
    const d = dia(l.exitTs / 1000);
    const a = porDia.get(d) || Object.fromEntries(TIERS.map((t) => [t, 0]));
    for (const t of TIERS) a[t] += l.pnl[t];
    porDia.set(d, a);
  }
  const abiertas = trs.map((tr) => ({ tr, ini: dia(tr.entryTs / 1000) }));
  const acum = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const out = [];
  for (const d of ctx.dias) {
    const a = porDia.get(d);
    if (a) for (const t of TIERS) acum[t] += a[t];
    let unreal = 0;
    for (const { tr, ini } of abiertas) {
      if (ini > d) continue;
      const cerrado = tr.legs.every((l) => dia(l.exitTs / 1000) <= d);
      if (cerrado) continue;
      let q = tr.qty0;
      for (const l of tr.legs) if (dia(l.exitTs / 1000) <= d) q -= l.qty;
      if (q <= 0) continue;
      const arr = ctx.serie[tr.sym];
      let px = tr.entryPx;
      for (let k = arr.length - 1; k >= 0; k--) { if (arr[k].t <= d) { px = arr[k].c; break; } }
      unreal += q * (px - tr.entryPx) * tr.rIn;
    }
    const row = { dia: d, eq: {} };
    for (const t of TIERS) row.eq[t] = CAPITAL + acum[t] + unreal;
    out.push(row);
  }
  if (out.length) { const last = out[out.length - 1]; for (const t of TIERS) last.eq[t] = CAPITAL + acum[t]; }
  return out;
}
function metricasSub(trs, ctx) {
  const equity = equityDeTrades(trs, ctx);
  const sim = { trades: trs, legs: trs.flatMap((t) => t.legs), equity };
  return Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
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
  const U50 = new Set(all.syms);
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
  const prevRc = JSON.parse(fs.readFileSync(path.join(DIR, "results-recompra.json"), "utf8"));
  const prevBa = JSON.parse(fs.readFileSync(path.join(DIR, "results-barrido.json"), "utf8"));
  const prevTs = JSON.parse(fs.readFileSync(path.join(DIR, "results-timestop.json"), "utf8"));
  const prevFi = JSON.parse(fs.readFileSync(path.join(DIR, "results-fino.json"), "utf8"));

  console.log(`series ${all.syms.length} · señales ${senales.length} · U38 ${U38.size} · U50 ${U50.size} · sorteos ${DRAWS} · semilla ${SEED}`);
  console.log(`TARIFAS por punta: gold ${pct(FEE.gold, 4)} · platinum ${pct(FEE.platinum, 4)} · black ${pct(FEE.black, 4)} · COCOS ${pct(FEE.cocos, 4)}`);
  console.log(`  ida y vuelta:    gold ${pct(FEE.gold * 2, 4)} · platinum ${pct(FEE.platinum * 2, 4)} · black ${pct(FEE.black * 2, 4)} · COCOS ${pct(FEE.cocos * 2, 4)}`);
  console.log(`  (FEE_COCOS = 0.0005 * IVA, tomado literal de workers/niveles-auto/worker.js)`);

  const out = {
    generado: new Date().toISOString(), semilla: SEED, draws: DRAWS,
    tarifas: Object.fromEntries(TIERS.map((t) => [t, { punta: FEE[t], vuelta: FEE[t] * 2 }])),
    fuenteCocos: "workers/niveles-auto/worker.js · const FEE_COCOS = 0.0005 * IVA",
  };

  const gateBase = (s) => {
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };
  const gateSin = (s) => (s.score >= 7 && s.rr >= 2 && !s.ct ? { riskMult: 1 } : null);
  const conj = (g, extra) => (s) => { const r = g(s); return r && extra(s) ? r : null; };

  /* ══════════ 0 · CHEQUEO DE CONSISTENCIA ══════════ */
  console.log(`\n===== 0 · CHEQUEO DE CONSISTENCIA contra results.json (gold/platinum/black) =====`);
  const CTX = {};
  for (const [vn, [d0, d1]] of Object.entries(VENTANAS)) {
    CTX[`38/${vn}`] = construirCtx(all.hourly, U38, d0, d1);
    CTX[`50/${vn}`] = construirCtx(all.hourly, U50, d0, d1);
  }
  const BASE = {}, chequeo = [];
  let malos = 0;
  for (const u of ["38", "50"]) for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`${u}/${vn}`];
    const uni = u === "38" ? U38 : U50;
    const ord = construirOrdenes(senales, uni, ctx.desde, ctx.hasta, gateBase);
    const sim = simular(ord, ctx, ccl);
    const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
    BASE[`${u}/${vn}`] = { ctx, ord, sim, m, uni };
    const ref = prev.corridas[`${u}/base/${vn}`];
    for (const tier of ["gold", "platinum", "black"]) {
      const r = ref.metricas[tier], x = m[tier];
      const cmp = [
        ["n", x.n, r.n, 0], ["mensual", x.mensualPct, r.mensualPct, 1e-9], ["total", x.total, r.total, 1e-6],
        ["win", x.winRate, r.winRate, 1e-12], ["payoff", x.payoff, r.payoff, 1e-9],
        ["sharpe", x.sharpe, r.sharpe, 1e-9], ["maxDD", x.maxDDpct, r.maxDDpct, 1e-9],
      ];
      for (const [k, a, b, tol] of cmp) {
        const d = a == null && b == null ? 0 : Math.abs(a - b);
        if (!(d <= tol)) { malos++; console.log(`   !! DESCUADRE ${u}/${vn}/${tier}/${k}: mio ${a} vs publicado ${b} (Δ ${d})`); }
        chequeo.push({ run: `${u}/${vn}`, tier, k, mio: a, ref: b, delta: d });
      }
    }
    console.log(`   ${`${u}/base/${vn}`.padEnd(14)} n=${m.gold.n} · gold ${n2(m.gold.mensualPct)}% · plat ${n2(m.platinum.mensualPct)}% · black ${n2(m.black.mensualPct)}% · COCOS ${n2(m.cocos.mensualPct)}%  → ${malos ? "CON DESCUADRES" : "OK"}`);
  }
  out.chequeo = { descuadres: malos, n: chequeo.length };
  if (malos) {
    console.log(`\n*** ABORTA: ${malos} descuadres contra results.json. No se sigue. ***`);
    fs.writeFileSync(path.join(DIR, "results-cocos.json"), JSON.stringify(out, null, 1));
    return;
  }
  console.log(`   ${chequeo.length} comparaciones, 0 descuadres. Gold/Platinum/Black reproducen results.json exacto.`);

  /* ══════════ A · CASO BASE, 38 LIMPIOS, 4 TARIFAS ══════════ */
  console.log(`\n===== A · CASO BASE · 38 limpios · las cuatro tarifas =====`);
  out.A = {};
  for (const vn of ["IS", "OOS"]) {
    const { m } = BASE[`38/${vn}`];
    out.A[vn] = Object.fromEntries(TIERS.map((t) => [t, {
      n: m[t].n, meses: m[t].meses, mensual: m[t].mensualPct, total: m[t].total, fees: m[t].fees,
      win: m[t].winRate, payoff: m[t].payoff, sharpe: m[t].sharpe, dd: m[t].maxDDpct,
      expectancy: m[t].expectancy, costoPct: m[t].costoPct,
    }]));
    console.log(`  [${vn}] trades ${m.gold.n} · ${n2(m.gold.meses, 1)} meses · bruto ${pct(m.gold.brutoPct, 3)} del nocional`);
    for (const t of TIERS) {
      const x = m[t];
      console.log(`    ${t.padEnd(9)} mensual ${n2(x.mensualPct).padStart(6)}% · P&L $${fmt(x.total).padStart(11)} · win ${pct(x.winRate).padStart(6)} · payoff ${n2(x.payoff).padStart(5)} · Sharpe ${n2(x.sharpe).padStart(6)} · maxDD ${n2(x.maxDDpct, 1).padStart(5)}% · costo v/v ${pct(x.costoPct, 3)}`);
    }
  }

  /* ══════════ B · LOS 50 CON ALTA REAL ══════════ */
  console.log(`\n===== B · UNIVERSO DE 50 con fecha de alta real · sesgo de selección =====`);
  out.B = {};
  for (const vn of ["IS", "OOS"]) {
    const m = BASE[`50/${vn}`].m, m38 = BASE[`38/${vn}`].m;
    out.B[vn] = {
      u50: Object.fromEntries(TIERS.map((t) => [t, { n: m[t].n, mensual: m[t].mensualPct, total: m[t].total, win: m[t].winRate, payoff: m[t].payoff, sharpe: m[t].sharpe, dd: m[t].maxDDpct }])),
      brutoPct: m.gold.brutoPct, brutoSinCclPct: m.gold.brutoSinCclPct, cclPct: m.gold.cclPct,
      sesgo: Object.fromEntries(TIERS.map((t) => [t, m[t].mensualPct - m38[t].mensualPct])),
    };
    console.log(`  [${vn}] 50 papeles: trades ${m.gold.n} (38 limpios: ${m38.gold.n}) · bruto ${pct(m.gold.brutoPct, 3)} · sin CCL ${pct(m.gold.brutoSinCclPct, 3)}`);
    for (const t of TIERS) {
      console.log(`    ${t.padEnd(9)} 50 → ${n2(m[t].mensualPct).padStart(6)}%  ·  38 → ${n2(m38[t].mensualPct).padStart(6)}%  ·  sesgo ${n2(m[t].mensualPct - m38[t].mensualPct).padStart(6)} pp · P&L 50 $${fmt(m[t].total).padStart(11)} · Sharpe ${n2(m[t].sharpe).padStart(6)} · DD ${n2(m[t].maxDDpct, 1)}%`);
    }
  }

  /* ══════════ C · DESCOMPOSICIÓN CCL vs PAPEL ══════════ */
  console.log(`\n===== C · DESCOMPOSICIÓN · cuánto puso el dólar y cuánto el papel =====`);
  out.C = {};
  for (const u of ["38", "50"]) for (const vn of ["IS", "OOS"]) {
    const b = BASE[`${u}/${vn}`], m = b.m.gold, ctx = b.ctx;
    // pasaje a mensual: el bruto y sus componentes se llevan a % del capital
    // por mes usando el mismo nocional y los mismos meses de la corrida.
    const aMensual = (x) => (x / CAPITAL / ctx.meses) * 100;
    const notional = m.notional;
    const rec = {
      n: m.n, meses: ctx.meses, notional,
      brutoPct: m.brutoPct, papelPct: m.brutoSinCclPct, cclPct: m.cclPct,
      brutoARS: m.bruto, papelARS: m.brutoSinCcl, cclARS: m.bruto - m.brutoSinCcl,
      mensualBruto: aMensual(m.bruto), mensualPapel: aMensual(m.brutoSinCcl), mensualCcl: aMensual(m.bruto - m.brutoSinCcl),
      mensualCostoCocos: -aMensual(b.m.cocos.fees), mensualNetoCocos: b.m.cocos.mensualPct,
      mensualCostoGold: -aMensual(b.m.gold.fees), mensualNetoGold: b.m.gold.mensualPct,
    };
    out.C[`${u}/${vn}`] = rec;
    console.log(`  ${u}/${vn}: bruto ${pct(m.brutoPct, 3)} = papel ${pct(m.brutoSinCclPct, 3)} + CCL ${pct(m.cclPct, 3)} del nocional`);
    console.log(`     en %/mes del capital: bruto ${n2(rec.mensualBruto)}% = papel ${n2(rec.mensualPapel)}% + dólar ${n2(rec.mensualCcl)}% · costo Cocos ${n2(rec.mensualCostoCocos)}% → neto ${n2(rec.mensualNetoCocos)}%`);
  }

  /* ══════════ D · LAS CINCO HIPÓTESIS ══════════ */
  out.D = {};
  const rnd = mulberry32(SEED);

  /* ── D.1 · la recompra post TP parcial ── */
  console.log(`\n===== D.1 · LA RECOMPRA POST TP PARCIAL =====`);
  out.D.recompra = {};
  const RCS = [["rc-entrada", "entry", "pre"], ["rc-entrada-stop", "mid", "pre"], ["rc-entrada/stop-gana", "entry", "post"], ["rc-entrada-stop/stop-gana", "mid", "post"]];
  const rcSR = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`38/${vn}`], ord = BASE[`38/${vn}`].ord;
    const simB = simularRc(ord, ctx, ccl, { recompra: null });
    const mB = Object.fromEntries(TIERS.map((t) => [t, metricas(simB, t, ctx.meses)]));
    // chequeo: con recompra=null el simulador de lotes tiene que dar el base
    const dB = Math.abs(mB.gold.total - BASE[`38/${vn}`].m.gold.total);
    console.log(`  [${vn}] chequeo del simulador de lotes con recompra=null: Δ P&L gold $${dB.toFixed(6)} · trades ${mB.gold.n}`);
    out.D.recompra[vn] = { chequeoLotes: dB, base: Object.fromEntries(TIERS.map((t) => [t, mB[t].total])), variantes: {} };
    for (const [rn, rc, orden] of RCS) {
      const sim = simularRc(ord, ctx, ccl, { recompra: rc, rcOrden: orden });
      const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
      const rcLegs = sim.legs.filter((l) => l.tag === "rc");
      const pnlRc = Object.fromEntries(TIERS.map((t) => [t, rcLegs.reduce((s, l) => s + l.pnl[t], 0)]));
      const notRc = rcLegs.reduce((s, l) => s + l.entN, 0);
      const brutoRc = rcLegs.reduce((s, l) => s + l.bruto, 0);
      out.D.recompra[vn].variantes[rn] = {
        nRecompras: sim.nRecompras, notionalRc: notRc, brutoRcPct: notRc > 0 ? brutoRc / notRc : null,
        mensual: Object.fromEntries(TIERS.map((t) => [t, m[t].mensualPct])),
        total: Object.fromEntries(TIERS.map((t) => [t, m[t].total])),
        incremental: Object.fromEntries(TIERS.map((t) => [t, m[t].total - mB[t].total])),
        pnlRc, sharpe: Object.fromEntries(TIERS.map((t) => [t, m[t].sharpe])),
        costoRcPct: notRc > 0 ? rcLegs.reduce((s, l) => s + l.fees.cocos, 0) / notRc : null,
      };
      rcSR[`${rn}/${vn}`] = { sr: m.gold.srDiario, srB: m.black.srDiario, srC: m.cocos.srDiario, shC: m.cocos.sharpe, rets: m.cocos.rets };
      console.log(`    ${rn.padEnd(28)} recompras ${String(sim.nRecompras).padStart(3)} · bruto de la recompra ${pct(notRc > 0 ? brutoRc / notRc : null, 3)} · incremental gold $${fmt(m.gold.total - mB.gold.total).padStart(10)} black $${fmt(m.black.total - mB.black.total).padStart(10)} COCOS $${fmt(m.cocos.total - mB.cocos.total).padStart(10)}`);
    }
  }
  // el nulo de la recompra: recomprar en un momento AL AZAR de la vida
  // restante del trade (al cierre de esa barra) en vez de en el nivel elegido.
  // Mide "importa DÓNDE recomprar" contra "recomprar por recomprar".
  console.log(`  --- nulo de la recompra: recomprar en una barra al azar posterior al TP parcial (${DRAWS} sorteos) ---`);
  out.D.recompra.nulo = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`38/${vn}`], ord = BASE[`38/${vn}`].ord;
    const simB = simularRc(ord, ctx, ccl, { recompra: null });
    // candidatos: trades con TP parcial; barras entre el TP (excl.) y la salida
    const cands = [];
    for (const tr of simB.trades) {
      if (!tr.tpDone || tr.tpTs == null) continue;
      const arr = ctx.serie[tr.sym], i0 = ctx.idx[tr.sym].get(tr.tpTs);
      if (i0 == null) continue;
      const bars = [];
      for (let k = i0 + 1; k < arr.length; k++) { const t = arr[k].ts * 1000; if (t > tr.exitTs) break; bars.push(arr[k]); }
      if (!bars.length) continue;
      cands.push({ tr, bars });
    }
    out.D.recompra.nulo[vn] = {};
    for (const [rn, rc] of [["rc-entrada", "entry"], ["rc-entrada-stop", "mid"]]) {
      const real = out.D.recompra[vn].variantes[rn].incremental;
      const K = out.D.recompra[vn].variantes[rn].nRecompras;
      const dist = Object.fromEntries(TIERS.map((t) => [t, []]));
      const idx = cands.map((_, i) => i);
      for (let b = 0; b < DRAWS; b++) {
        const sel = sorteoK(idx, idx.length, Math.min(K, idx.length), rnd);
        const tot = Object.fromEntries(TIERS.map((t) => [t, 0]));
        for (const i of sel) {
          const { tr, bars } = cands[i];
          const bb = bars[Math.floor(rnd() * bars.length)];
          const px = bb.c, tIn = bb.ts * 1000;
          const dIn = dia(tIn / 1000), dOut = dia(tr.exitTs / 1000);
          const rIn = ccl(dIn) || 1, rOut = ccl(dOut) || 1;
          const q = tr.tpQty;
          const entN = q * px * rIn, outN = q * tr.exitPx * rOut;
          const intradia = dIn === dOut;
          for (const t of TIERS) tot[t] += outN - entN - (entN * FEE[t] + outN * (intradia ? DERECHOS : FEE[t]));
        }
        for (const t of TIERS) dist[t].push(tot[t]);
      }
      out.D.recompra.nulo[vn][rn] = { K, nCands: cands.length, ...Object.fromEntries(TIERS.map((t) => [t, ubicar(real[t], dist[t])])) };
      const uc = out.D.recompra.nulo[vn][rn].cocos, ug = out.D.recompra.nulo[vn][rn].gold;
      console.log(`    ${rn.padEnd(20)} ${vn} K=${K}/${cands.length} · COCOS real $${fmt(real.cocos).padStart(9)} vs nulo mediana $${fmt(uc.med).padStart(9)} · pctil ${pct(uc.percentil).padStart(6)} p=${uc.p1cola.toFixed(4)} | gold pctil ${pct(ug.percentil)} p=${ug.p1cola.toFixed(4)}`);
    }
  }
  // y el test directo: ¿el aporte total de la recompra es distinguible de cero?
  // bootstrap sobre los aportes individuales de cada recompra.
  console.log(`  --- bootstrap del aporte individual de cada recompra (¿el total es > 0?) ---`);
  out.D.recompra.bootstrap = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`38/${vn}`], ord = BASE[`38/${vn}`].ord;
    out.D.recompra.bootstrap[vn] = {};
    for (const [rn, rc] of [["rc-entrada", "entry"], ["rc-entrada-stop", "mid"]]) {
      const sim = simularRc(ord, ctx, ccl, { recompra: rc, rcOrden: "pre" });
      const rcLegs = sim.legs.filter((l) => l.tag === "rc");
      const v = Object.fromEntries(TIERS.map((t) => [t, rcLegs.map((l) => l.pnl[t])]));
      const res = {};
      for (const t of TIERS) {
        const a = v[t], n = a.length;
        if (!n) { res[t] = null; continue; }
        let neg = 0;
        const tots = [];
        for (let b = 0; b < DRAWS; b++) {
          let s = 0;
          for (let i = 0; i < n; i++) s += a[Math.floor(rnd() * n)];
          tots.push(s); if (s <= 0) neg++;
        }
        res[t] = { n, total: a.reduce((s, x) => s + x, 0), pMenorIgualCero: (neg + 1) / (DRAWS + 1), sd: stdev(tots) };
      }
      out.D.recompra.bootstrap[vn][rn] = res;
      if (res.cocos) console.log(`    ${rn.padEnd(20)} ${vn} n=${res.cocos.n} · COCOS total $${fmt(res.cocos.total)} · p(total<=0) ${res.cocos.pMenorIgualCero.toFixed(4)} | gold $${fmt(res.gold.total)} p ${res.gold.pMenorIgualCero.toFixed(4)}`);
    }
  }
  // las dos ventanas juntas
  out.D.recompra.juntas = {};
  for (const [rn] of RCS.map((x) => [x[0]])) {
    out.D.recompra.juntas[rn] = Object.fromEntries(TIERS.map((t) => [t,
      out.D.recompra.IS.variantes[rn].incremental[t] + out.D.recompra.OOS.variantes[rn].incremental[t]]));
  }
  console.log(`  --- las dos ventanas juntas (P&L incremental, 35 meses) ---`);
  for (const rn of Object.keys(out.D.recompra.juntas)) {
    const j = out.D.recompra.juntas[rn];
    console.log(`    ${rn.padEnd(28)} gold $${fmt(j.gold).padStart(10)} · plat $${fmt(j.platinum).padStart(10)} · black $${fmt(j.black).padStart(10)} · COCOS $${fmt(j.cocos).padStart(10)}`);
  }

  /* ── D.2 · el time-stop ── */
  console.log(`\n===== D.2 · EL TIME-STOP POST-FILL =====`);
  out.D.timestop = {};
  const TRv = {};
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`38/${vn}`];
    TRv[vn] = BASE[`38/${vn}`].sim.trades.map((tr) => {
      const r = replayTrade(tr, ctx, ccl, null);
      return { vida: r.barras, _tr: tr, ...Object.fromEntries(TIERS.map((t) => [t, tr.legs.reduce((s, l) => s + l.pnl[t], 0)])) };
    });
    // chequeo: el replayer reproduce la cartera trade por trade
    let ok = 0;
    BASE[`38/${vn}`].sim.trades.forEach((tr) => {
      const r = replayTrade(tr, ctx, ccl, null);
      const a = tr.legs.reduce((s, l) => s + l.pnl.gold, 0);
      if (Math.abs(r.pnl.gold - a) < 1e-6) ok++;
    });
    console.log(`  [${vn}] replayer reproduce la cartera en ${ok}/${TRv[vn].length} trades`);
    out.D.timestop[vn] = { replayOk: ok, n: TRv[vn].length, relojes: {} };
  }
  const RELOJES = [{ id: "mercado", opt: (H) => ({ maxBarras: H }) }, { id: "corrido", opt: (H) => ({ maxHorasCal: H }) }];
  const cortesDe = (rel, vn, H) => {
    const m = new Map();
    BASE[`38/${vn}`].sim.trades.forEach((tr, i) => {
      const vida = TRv[vn][i].vida;
      if (rel === "mercado") { if (vida > H) m.set(i, H); }
      else { const k = barraDeHoras(tr, CTX[`38/${vn}`], H, vida); if (k != null && k < vida) m.set(i, k); }
    });
    return m;
  };
  const tsSR = [];
  for (const rel of RELOJES) for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`38/${vn}`], ord = BASE[`38/${vn}`].ord, base = BASE[`38/${vn}`].m;
    out.D.timestop[vn].relojes[rel.id] = {};
    for (const H of HS) {
      const sim = simular(ord, ctx, ccl, rel.opt(H));
      const m = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t, ctx.meses)]));
      const nTS = sim.legs.filter((l) => l.reason === "timestop").length;
      const cortes = cortesDe(rel.id, vn, H);
      const noop = nTS === 0 && cortes.size === 0;
      const aisl = Object.fromEntries(TIERS.map((t) => [t, 0])), aislBase = Object.fromEntries(TIERS.map((t) => [t, 0]));
      BASE[`38/${vn}`].sim.trades.forEach((tr, i) => {
        const r = replayTrade(tr, ctx, ccl, cortes.get(i) ?? null);
        for (const t of TIERS) { aisl[t] += r.pnl[t]; aislBase[t] += tr.legs.reduce((s, l) => s + l.pnl[t], 0); }
      });
      out.D.timestop[vn].relojes[rel.id][`H${H}`] = {
        noop, nTimestop: nTS, nCortados: cortes.size,
        mensual: Object.fromEntries(TIERS.map((t) => [t, m[t].mensualPct])),
        deltaCartera: Object.fromEntries(TIERS.map((t) => [t, m[t].total - base[t].total])),
        deltaAislado: Object.fromEntries(TIERS.map((t) => [t, aisl[t] - aislBase[t]])),
      };
      if (!noop) tsSR.push({ nombre: `timestop ${rel.id} H=${H}/${vn}`, sr: m.gold.srDiario, srB: m.black.srDiario, srC: m.cocos.srDiario });
    }
    const serie = HS.map((H) => out.D.timestop[vn].relojes[rel.id][`H${H}`].mensual.cocos);
    console.log(`  [${vn}/${rel.id}] mensual COCOS por H ${HS.join("/")}: ${serie.map((x) => n2(x)).join(" / ")} (base ${n2(base.cocos.mensualPct)}%)`);
    const dg = HS.map((H) => out.D.timestop[vn].relojes[rel.id][`H${H}`].deltaAislado.gold);
    const dc = HS.map((H) => out.D.timestop[vn].relojes[rel.id][`H${H}`].deltaAislado.cocos);
    console.log(`      Δ aislado gold  : ${dg.map((x) => fmt(x)).join(" / ")}`);
    console.log(`      Δ aislado COCOS : ${dc.map((x) => fmt(x)).join(" / ")}`);
  }
  // el nulo del time-stop (copia de timestop.js C): cortar al azar
  console.log(`  --- nulo del time-stop (${DRAWS} sorteos) ---`);
  out.D.timestop.nulo = {};
  const correrNuloTS = (vn, cortesReales, etiqueta) => {
    const ctx = CTX[`38/${vn}`], trades = BASE[`38/${vn}`].sim.trades;
    const vidas = TRv[vn].map((x) => x.vida);
    const baseP = Object.fromEntries(TIERS.map((t) => [t, trades.map((tr) => tr.legs.reduce((s, l) => s + l.pnl[t], 0))]));
    const baseTot = Object.fromEntries(TIERS.map((t) => [t, baseP[t].reduce((s, x) => s + x, 0)]));
    const realTot = Object.fromEntries(TIERS.map((t) => [t, baseTot[t]]));
    for (const [i, c] of cortesReales) {
      const r = replayTrade(trades[i], ctx, ccl, c);
      for (const t of TIERS) realTot[t] += r.pnl[t] - baseP[t][i];
    }
    const K = cortesReales.size;
    const mens = (v) => (v / CAPITAL / ctx.meses) * 100;
    const res = { K, n: trades.length, realMensual: Object.fromEntries(TIERS.map((t) => [t, mens(realTot[t])])), baseMensual: Object.fromEntries(TIERS.map((t) => [t, mens(baseTot[t])])) };
    if (!K) return res;
    for (const [nn, pool] of [["nulo1", [...trades.keys()]], ["nulo2", [...cortesReales.keys()]]]) {
      const dist = Object.fromEntries(TIERS.map((t) => [t, []]));
      const idx = [...pool];
      for (let b = 0; b < DRAWS; b++) {
        const sel = sorteoK(idx, idx.length, Math.min(K, idx.length), rnd);
        const tot = Object.fromEntries(TIERS.map((t) => [t, baseTot[t]]));
        for (const i of sel) {
          const L = vidas[i];
          const u = 1 + Math.floor(rnd() * Math.max(1, L));
          const r = replayTrade(trades[i], ctx, ccl, u);
          for (const t of TIERS) tot[t] += r.pnl[t] - baseP[t][i];
        }
        for (const t of TIERS) dist[t].push(mens(tot[t]));
      }
      res[nn] = Object.fromEntries(TIERS.map((t) => [t, ubicar(res.realMensual[t], dist[t])]));
    }
    const u = res.nulo2.cocos, ug = res.nulo2.gold;
    console.log(`    ${etiqueta.padEnd(24)} ${vn} K=${String(K).padStart(3)} · COCOS real ${n2(res.realMensual.cocos).padStart(6)}% (base ${n2(res.baseMensual.cocos)}%) · nulo2 pctil ${pct(u.percentil).padStart(6)} p=${u.p1cola.toFixed(4)} | gold pctil ${pct(ug.percentil)}`);
    return res;
  };
  for (const rel of RELOJES) {
    out.D.timestop.nulo[rel.id] = {};
    for (const vn of ["IS", "OOS"]) {
      out.D.timestop.nulo[rel.id][vn] = {};
      for (const H of HS) {
        const cortes = cortesDe(rel.id, vn, H);
        if (!cortes.size) continue;
        out.D.timestop.nulo[rel.id][vn][`H${H}`] = correrNuloTS(vn, cortes, `${rel.id} H=${H}`);
      }
    }
  }

  /* ── D.3 · el corte por zona cedida (INFORME-BARRIDO) ── */
  console.log(`\n===== D.3 · EL CORTE POR ZONA CEDIDA =====`);
  out.D.barrido = {};
  {
    // se reusa la etiqueta `aguanta` ya calculada en results-barrido.json
    // (calcularla de nuevo exigiría re-correr el motor en cada barra de fill).
    // El join es por índice y se verifica contra sym/dia/entN y el P&L gold.
    let okJoin = 0, totJoin = 0;
    for (const vn of ["IS", "OOS"]) {
      const pubs = prevBa.trades[vn], mios = TRv[vn];
      if (pubs.length !== mios.length) { console.log(`   !! largo distinto ${vn}: ${pubs.length} vs ${mios.length}`); continue; }
      pubs.forEach((p, i) => {
        totJoin++;
        const t = mios[i]._tr;
        if (p.sym === t.sym && p.dia === t.dia && Math.abs(p.gold - mios[i].gold) < 1e-6) okJoin++;
        mios[i].aguanta = p.aguanta;
        mios[i].spotFill = p.spotFill;
        mios[i].entry = p.entry;
      });
    }
    console.log(`  join con results-barrido.json: ${okJoin}/${totJoin} trades coinciden en sym/dia/P&L gold`);
    out.D.barrido.join = { ok: okJoin, tot: totJoin };

    const mensualDe = (sub, ctx, tier) => (sub.reduce((s, x) => s + x[tier], 0) / CAPITAL / ctx.meses) * 100;
    const CORTES_B = [
      { id: "solo aguanta (test primario)", keep: (x) => x.aguanta === 1 },
      { id: "solo cedió (test primario)", keep: (x) => x.aguanta === 0 },
      { id: "control: cerró arriba del nivel", keep: (x) => x.spotFill != null && x.spotFill > x.entry * 1.001 },
      { id: "control: cerró abajo del nivel", keep: (x) => !(x.spotFill != null && x.spotFill > x.entry * 1.001) },
    ];
    out.D.barrido.cortes = {};
    for (const c of CORTES_B) {
      out.D.barrido.cortes[c.id] = {};
      for (const vn of ["IS", "OOS"]) {
        const arr = TRv[vn], ctx = CTX[`38/${vn}`], N = arr.length;
        const sub = arr.filter(c.keep), K = sub.length;
        if (!K || K === N) continue;
        const real = Object.fromEntries(TIERS.map((t) => [t, mensualDe(sub, ctx, t)]));
        const base = Object.fromEntries(TIERS.map((t) => [t, mensualDe(arr, ctx, t)]));
        const idx = arr.map((_, i) => i);
        const nul = Object.fromEntries(TIERS.map((t) => [t, []]));
        for (let b = 0; b < DRAWS; b++) {
          const sel = sorteoK(idx, N, K, rnd);
          const acc = Object.fromEntries(TIERS.map((t) => [t, 0]));
          for (const i of sel) for (const t of TIERS) acc[t] += arr[i][t];
          for (const t of TIERS) nul[t].push((acc[t] / CAPITAL / ctx.meses) * 100);
        }
        const res = { N, K, real, base, nulo: Object.fromEntries(TIERS.map((t) => [t, ubicar(real[t], nul[t])])) };
        out.D.barrido.cortes[c.id][vn] = res;
        const u = res.nulo.cocos;
        console.log(`    ${c.id.padEnd(34)} ${vn} K=${String(K).padStart(3)}/${N} · COCOS real ${n2(real.cocos).padStart(6)}% (base ${n2(base.cocos)}%) · nulo mediana ${n2(u.med).padStart(6)}% · pctil ${pct(u.percentil).padStart(6)} p=${u.p1cola.toFixed(4)}`);
      }
    }
    // la versión IMPLEMENTABLE: soltar al cierre de la barra del fill lo que cedió
    console.log(`  --- implementable: soltar al cierre de la barra del fill lo que cedió (paga la vuelta) ---`);
    out.D.barrido.implementable = {};
    for (const vn of ["IS", "OOS"]) {
      const arr = TRv[vn], ctx = CTX[`38/${vn}`];
      const dump = (x) => {
        const tr = x._tr, b = ctx.barAt[tr.sym].get(tr.entryTs);
        const entN = tr.qty0 * tr.entryPx * tr.rIn;
        const outN = tr.qty0 * (b ? b.c : tr.entryPx) * tr.rIn;
        const r = {};
        for (const t of TIERS) r[t] = outN - entN - (entN * FEE[t] + outN * DERECHOS);
        return r;
      };
      const tot = Object.fromEntries(TIERS.map((t) => [t, 0])), totBase = Object.fromEntries(TIERS.map((t) => [t, 0])), gratis = Object.fromEntries(TIERS.map((t) => [t, 0]));
      let nDump = 0;
      for (const x of arr) {
        for (const t of TIERS) totBase[t] += x[t];
        if (x.aguanta === 1) { for (const t of TIERS) { tot[t] += x[t]; gratis[t] += x[t]; } }
        else { const d = dump(x); for (const t of TIERS) tot[t] += d[t]; nDump++; }
      }
      const men = (v) => (v / CAPITAL / ctx.meses) * 100;
      out.D.barrido.implementable[vn] = {
        nDump,
        mensualReal: Object.fromEntries(TIERS.map((t) => [t, men(tot[t])])),
        mensualBase: Object.fromEntries(TIERS.map((t) => [t, men(totBase[t])])),
        mensualGratis: Object.fromEntries(TIERS.map((t) => [t, men(gratis[t])])),
      };
      const o = out.D.barrido.implementable[vn];
      console.log(`    ${vn}: suelta ${nDump} · COCOS ${n2(o.mensualReal.cocos)}% (gratis ${n2(o.mensualGratis.cocos)}% · base ${n2(o.mensualBase.cocos)}%) | gold ${n2(o.mensualReal.gold)}% (base ${n2(o.mensualBase.gold)}%)`);
    }
  }

  /* ── D.4 · el filtro de volatilidad ── */
  console.log(`\n===== D.4 · EL FILTRO DE VOLATILIDAD =====`);
  const FA = featuresSpy({ useAdj: true, lag: 1 });
  const volMedIS = (() => {
    const v = senales.filter((s) => s.dia <= IS_HASTA && s.vol != null).map((s) => s.vol).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })();
  console.log(`  volMedIS = ${volMedIS} · results.json dice ${prev.volMedIS} · ${volMedIS === prev.volMedIS ? "COINCIDE" : "NO COINCIDE"}`);
  const cVolBaja = (s) => s.vol != null && s.vol <= volMedIS;
  const dVolBaja = (d) => { const f = FA.feat.get(d); return !!(f && f.vol != null && f.vol <= volMedIS); };
  out.D.volatilidad = { volMedIS, coincide: volMedIS === prev.volMedIS };
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[`38/${vn}`];
    const padre = BASE[`38/${vn}`].ord;
    const hijo = padre.filter(cVolBaja);
    const N = padre.length, K = hijo.length;
    const simReal = simular(hijo, ctx, ccl);
    const mr = Object.fromEntries(TIERS.map((t) => [t, metricas(simReal, t, ctx.meses)]));
    // nulo 1: K señales al azar
    const idx = [...Array(N).keys()];
    const n1 = Object.fromEntries(TIERS.map((t) => [t, []]));
    for (let b = 0; b < DRAWS; b++) {
      const sel = sorteoK(idx, N, K, rnd).sort((a, b2) => a - b2).map((i) => padre[i]);
      const s = simular(sel, ctx, ccl, { light: true });
      for (const t of TIERS) n1[t].push((s.realized[t] / CAPITAL / ctx.meses) * 100);
    }
    // nulo 2: los mismos días apagados, en bloques contiguos al azar
    const dias = ctx.dias;
    const maskReal = dias.map(dVolBaja);
    const offs = bloquesOff(maskReal);
    const largos = offs.map(([a, b]) => b - a + 1);
    const offSet = new Set();
    for (const [a, b] of offs) for (let i = a; i <= b; i++) offSet.add(dias[i]);
    const hijoDia = padre.filter((o) => !offSet.has(o.dia));
    const simDia = simular(hijoDia, ctx, ccl);
    const mrd = Object.fromEntries(TIERS.map((t) => [t, metricas(simDia, t, ctx.meses)]));
    const n2d = Object.fromEntries(TIERS.map((t) => [t, []]));
    for (let b = 0; b < DRAWS; b++) {
      const col = colocarBloques(dias.length, largos, rnd);
      if (!col) continue;
      const off = new Set();
      for (const [a, z] of col) for (let i = a; i <= z && i < dias.length; i++) off.add(dias[i]);
      const sel = padre.filter((o) => !off.has(o.dia));
      const s = simular(sel, ctx, ccl, { light: true });
      for (const t of TIERS) n2d[t].push((s.realized[t] / CAPITAL / ctx.meses) * 100);
    }
    out.D.volatilidad[vn] = {
      N, K, nTrades: mr.gold.n,
      mensualReal: Object.fromEntries(TIERS.map((t) => [t, mr[t].mensualPct])),
      mensualBase: Object.fromEntries(TIERS.map((t) => [t, BASE[`38/${vn}`].m[t].mensualPct])),
      expReal: Object.fromEntries(TIERS.map((t) => [t, mr[t].expectancy])),
      nulo1: Object.fromEntries(TIERS.map((t) => [t, ubicar(mr[t].mensualPct, n1[t])])),
      bloques: { cant: offs.length, diasOff: largos.reduce((s, x) => s + x, 0), diasTot: dias.length },
      realDia: Object.fromEntries(TIERS.map((t) => [t, mrd[t].mensualPct])),
      nulo2: Object.fromEntries(TIERS.map((t) => [t, ubicar(mrd[t].mensualPct, n2d[t])])),
      srCocos: mr.cocos.srDiario, sharpeCocos: mr.cocos.sharpe, retsCocos: mr.cocos.rets,
    };
    const o = out.D.volatilidad[vn];
    console.log(`  [${vn}] señales ${K}/${N} · trades ${mr.gold.n} · COCOS real ${n2(o.mensualReal.cocos)}% (base ${n2(o.mensualBase.cocos)}%)`);
    console.log(`     nulo1 (señales al azar) COCOS pctil ${pct(o.nulo1.cocos.percentil)} p=${o.nulo1.cocos.p1cola.toFixed(4)} · mediana ${n2(o.nulo1.cocos.med)}% | gold pctil ${pct(o.nulo1.gold.percentil)} p=${o.nulo1.gold.p1cola.toFixed(4)}`);
    console.log(`     nulo2 (bloques al azar) COCOS real ${n2(o.realDia.cocos)}% pctil ${pct(o.nulo2.cocos.percentil)} p=${o.nulo2.cocos.p1cola.toFixed(4)} · mediana ${n2(o.nulo2.cocos.med)}% | gold pctil ${pct(o.nulo2.gold.percentil)} p=${o.nulo2.gold.p1cola.toFixed(4)}`);
  }

  /* ── D.5 · el score >= 9 (post-hoc) ── */
  console.log(`\n===== D.5 · SCORE >= 9 (corte POST-HOC, n chico) =====`);
  out.D.score = { advertencia: "corte post-hoc, elegido mirando los resultados. No es una regla walk-forward." };
  {
    const porScore = {};
    for (const vn of ["IS", "OOS"]) for (const x of TRv[vn]) {
      const k = x._tr.score;
      (porScore[k] = porScore[k] || []).push(x);
    }
    out.D.score.porScore = {};
    for (const k of Object.keys(porScore).sort()) {
      const v = porScore[k];
      out.D.score.porScore[k] = {
        n: v.length, win: v.filter((x) => x.gold > 0).length / v.length,
        ...Object.fromEntries(TIERS.map((t) => [t, { total: v.reduce((s, x) => s + x[t], 0), porTrade: v.reduce((s, x) => s + x[t], 0) / v.length }])),
      };
      const r = out.D.score.porScore[k];
      console.log(`  score ${k}: n=${String(r.n).padStart(3)} win ${pct(r.win).padStart(6)} · gold $${fmt(r.gold.total).padStart(10)} (${fmt(r.gold.porTrade)}/trade) · black $${fmt(r.black.total).padStart(10)} · COCOS $${fmt(r.cocos.total).padStart(10)} (${fmt(r.cocos.porTrade)}/trade)`);
    }
    // el corte y su nulo, por ventana
    out.D.score.corte = {};
    for (const vn of ["IS", "OOS"]) {
      const arr = TRv[vn], ctx = CTX[`38/${vn}`], N = arr.length;
      const sub = arr.filter((x) => x._tr.score >= 9), K = sub.length;
      if (!K || K === N) continue;
      const mensualDe = (s, t) => (s.reduce((a, x) => a + x[t], 0) / CAPITAL / ctx.meses) * 100;
      const real = Object.fromEntries(TIERS.map((t) => [t, mensualDe(sub, t)]));
      const base = Object.fromEntries(TIERS.map((t) => [t, mensualDe(arr, t)]));
      const idx = arr.map((_, i) => i);
      const nul = Object.fromEntries(TIERS.map((t) => [t, []]));
      for (let b = 0; b < DRAWS; b++) {
        const sel = sorteoK(idx, N, K, rnd);
        const acc = Object.fromEntries(TIERS.map((t) => [t, 0]));
        for (const i of sel) for (const t of TIERS) acc[t] += arr[i][t];
        for (const t of TIERS) nul[t].push((acc[t] / CAPITAL / ctx.meses) * 100);
      }
      const m = metricasSub(sub.map((x) => x._tr), ctx);
      out.D.score.corte[vn] = {
        N, K, real, base, nulo: Object.fromEntries(TIERS.map((t) => [t, ubicar(real[t], nul[t])])),
        sharpe: Object.fromEntries(TIERS.map((t) => [t, m[t].sharpe])),
        _sr: Object.fromEntries(TIERS.map((t) => [t, m[t].srDiario])), _rets: m.cocos.rets, _retsG: m.gold.rets, _retsB: m.black.rets,
      };
      const u = out.D.score.corte[vn].nulo.cocos;
      console.log(`  corte score>=9 ${vn}: K=${K}/${N} · COCOS ${n2(real.cocos)}%/mes (base ${n2(base.cocos)}%) · nulo mediana ${n2(u.med)}% pctil ${pct(u.percentil)} p=${u.p1cola.toFixed(4)} · Sharpe cocos ${n2(m.cocos.sharpe)}`);
    }
  }

  /* ══════════ E · DSR ══════════ */
  console.log(`\n===== E · DSR · el N actualizado y σ(SR) para Cocos =====`);
  out.E = null;
  if (!SIN_DSR) {
    const srsG = [], srsB = [], srsC = [];
    const push = (g, b, c) => { if (g != null) srsG.push(g); if (b != null) srsB.push(b); if (c != null) srsC.push(c); };
    // (1) las 76 originales de simulate.js
    const GATES = {
      "base (worker)": gateBase, "sin régimen": gateSin,
      "sin régimen + SPY>EMA200": conj(gateSin, (s) => s.s200 === 1),
      "sin régimen + SPY>EMA50": conj(gateSin, (s) => s.s50 === 1),
      "sin régimen + vol20 baja": conj(gateSin, cVolBaja),
      "base + SPY>EMA200": conj(gateBase, (s) => s.s200 === 1),
      "base + SPY>EMA50": conj(gateBase, (s) => s.s50 === 1),
      "base + vol20 baja": conj(gateBase, cVolBaja),
      "sin régimen + SPY<EMA200 (control)": conj(gateSin, (s) => s.s200 === 0),
      "sin régimen + vol20 alta (control)": conj(gateSin, (s) => s.vol != null && s.vol > volMedIS),
    };
    let nOrig = 0;
    for (const u of ["38", "50"]) for (const vn of ["IS", "OOS"]) {
      const b = BASE[`${u}/${vn}`]; push(b.m.gold.srDiario, b.m.black.srDiario, b.m.cocos.srDiario); nOrig++;
    }
    for (const [gn, g] of Object.entries(GATES)) for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[`38/${vn}`];
      const s = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, g), ctx, ccl);
      push(metricas(s, "gold", ctx.meses).srDiario, metricas(s, "black", ctx.meses).srDiario, metricas(s, "cocos", ctx.meses).srDiario);
      nOrig++;
    }
    const mults = [0.7, 0.85, 1, 1.15, 1.3];
    let chkSweep = 0;
    for (const vn of ["IS", "OOS"]) for (const sm of mults) for (const tm of mults) {
      const ctx = CTX[`38/${vn}`];
      const s = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase, sm, tm), ctx, ccl);
      const mg = metricas(s, "gold", ctx.meses);
      push(mg.srDiario, metricas(s, "black", ctx.meses).srDiario, metricas(s, "cocos", ctx.meses).srDiario);
      const ref = prev.sweep[`${vn}/s${sm}/t${tm}`];
      if (ref && Math.abs(ref.sharpe - mg.sharpe) < 1e-9) chkSweep++;
      nOrig++;
    }
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[`38/${vn}`];
      const s = simular(BASE[`38/${vn}`].ord, ctx, ccl, { exitMode: "close" });
      push(metricas(s, "gold", ctx.meses).srDiario, metricas(s, "black", ctx.meses).srDiario, metricas(s, "cocos", ctx.meses).srDiario);
      nOrig++;
    }
    console.log(`  originales reconstruidas: ${nOrig} (informe: 76) · sweep coincide ${chkSweep}/50`);
    // (2) las 8 de la recompra
    let nRc = 0;
    for (const vn of ["IS", "OOS"]) for (const [rn] of RCS.map((x) => [x[0]])) {
      const k = rcSR[`${rn}/${vn}`];
      if (k) { push(k.sr, k.srB, k.srC); nRc++; }
    }
    // (3) las 16 del nulo (variantes de umbral de volatilidad)
    const FC = featuresSpy({ useAdj: false, lag: 1 });
    const volMedISdia = (() => {
      const v = []; for (const d of FA.dias) { if (d > IS_HASTA || d < IS_DESDE) continue; const f = FA.feat.get(d); if (f && f.vol != null) v.push(f.vol); }
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
      const v = []; for (const d of FA.dias) { if (d > IS_HASTA || d < IS_DESDE) continue; const f = FA.feat.get(d); if (f && f.vol != null) v.push(f.vol); }
      v.sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : null;
    };
    const condsNulo = [
      (s) => s.vol != null && s.vol <= volMedISdia,
      (s) => { const u = volMedExp.get(s.dia); return u != null && s.vol != null && s.vol <= u; },
      (s) => { const u = volMed252.get(s.dia); return u != null && s.vol != null && s.vol <= u; },
      (s) => { const f = FC.feat.get(s.dia); return !!(f && f.vol != null && f.vol <= volMedIS); },
    ];
    let nNu = 0;
    for (const cond of condsNulo) for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[`38/${vn}`];
      const s = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, conj(gateBase, cond)), ctx, ccl);
      push(metricas(s, "gold", ctx.meses).srDiario, metricas(s, "black", ctx.meses).srDiario, metricas(s, "cocos", ctx.meses).srDiario);
      nNu++;
    }
    for (const q of [0.25, 0.35, 0.65, 0.75]) {
      const u = volQ(q);
      for (const vn of ["IS", "OOS"]) {
        const ctx = CTX[`38/${vn}`];
        const s = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, conj(gateBase, (x) => x.vol != null && x.vol <= u)), ctx, ccl);
        push(metricas(s, "gold", ctx.meses).srDiario, metricas(s, "black", ctx.meses).srDiario, metricas(s, "cocos", ctx.meses).srDiario);
        nNu++;
      }
    }
    // (4) las 26 del time-stop que cortan algo
    for (const k of tsSR) push(k.sr, k.srB, k.srC);
    // (5) las 6 de "razón muerta"
    const ANAS = new Map();
    const getAna = (sym) => { if (!ANAS.has(sym)) ANAS.set(sym, analizadorPorSimbolo(all.daily[sym], all.hourly[sym])); return ANAS.get(sym); };
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
      const ctx = CTX[`38/${vn}`], ord = BASE[`38/${vn}`].ord;
      const s = simular(ord, ctx, ccl, { razonMuerta: (sym, t, pos) => { const e = evaluarD(sym, t, pos.entryPx); return e ? e[modo] : false; } });
      push(metricas(s, "gold", ctx.meses).srDiario, metricas(s, "black", ctx.meses).srDiario, metricas(s, "cocos", ctx.meses).srDiario);
      nRm++;
    }
    // (6) los 28 cortes del barrido, en modo aislado
    const cuartilizar = (arr, campo) => {
      const v = arr.map((x, i) => [x[campo], i]).filter(([a]) => a != null).sort((a, b) => a[0] - b[0]);
      const gr = [[], [], [], []];
      v.forEach(([, i], k) => gr[Math.min(3, Math.floor((k * 4) / v.length))].push(arr[i]));
      return { gr };
    };
    const FEATS = ["f1", "f2", "f3", "f4", "f5"];
    // los features viven en results-barrido.json; se copian por índice
    for (const vn of ["IS", "OOS"]) prevBa.trades[vn].forEach((p, i) => { for (const f of FEATS) TRv[vn][i][f] = p[f]; });
    const CORTES_DSR = [
      { id: "solo aguanta", keep: (x) => x.aguanta === 1 },
      { id: "solo cedió", keep: (x) => x.aguanta === 0 },
      { id: "cerró arriba", keep: (x) => x.spotFill != null && x.spotFill > x.entry * 1.001 },
      { id: "cerró abajo", keep: (x) => !(x.spotFill != null && x.spotFill > x.entry * 1.001) },
    ];
    for (const f of FEATS) {
      if (f === "f4") { CORTES_DSR.push({ id: `${f}=sí`, keep: (x) => x[f] === 1 }); CORTES_DSR.push({ id: `${f}=no`, keep: (x) => x[f] === 0 }); }
      else { CORTES_DSR.push({ id: `${f} Q4`, needQ: f, lado: 3 }); CORTES_DSR.push({ id: `${f} Q1`, needQ: f, lado: 0 }); }
    }
    const nuevasBa = [];
    for (const c of CORTES_DSR) for (const vn of ["IS", "OOS"]) {
      let keep = c.keep;
      if (c.needQ) { const set = new Set(cuartilizar(TRv[vn], c.needQ).gr[c.lado]); keep = (x) => set.has(x); }
      const sub = TRv[vn].filter(keep).map((x) => x._tr);
      if (!sub.length) continue;
      const m = metricasSub(sub, CTX[`38/${vn}`]);
      nuevasBa.push({ nombre: `${c.id}/${vn}`, g: m.gold.srDiario, b: m.black.srDiario, c: m.cocos.srDiario, shC: m.cocos.sharpe, retsC: m.cocos.rets, retsG: m.gold.rets, retsB: m.black.rets, shG: m.gold.sharpe, shB: m.black.sharpe, n: m.gold.n });
    }
    for (const v of nuevasBa) push(v.g, v.b, v.c);
    const nRecon = nOrig + nRc + nNu + tsSR.length + nRm + nuevasBa.length;
    const sigG = stdev(srsG), sigB = stdev(srsB), sigC = stdev(srsC);
    console.log(`  reconstrucción: ${nOrig} originales + ${nRc} recompra + ${nNu} nulo + ${tsSR.length} timestop + ${nRm} razón muerta + ${nuevasBa.length} barrido = ${nRecon}`);
    console.log(`  σ(SR) reconstruido: gold ${sigG.toExponential(4)} (informe ${prevFi.dsr.sigmaSR.toExponential(4)}) · black ${sigB.toExponential(4)} (informe ${prevFi.dsr.sigmaSRblack.toExponential(4)}) · COCOS ${sigC.toExponential(4)}`);

    /* El N: la tarifa NO es un grado de libertad buscado en los datos (es un
     * dato del broker), así que re-tarifar 172 configuraciones ya miradas no
     * agrega candidatas — la convención del proyecto es contar cada
     * configuración una vez, no una por tier. Lo ÚNICO nuevo acá es el corte
     * post-hoc por score >= 9 en las dos ventanas. N = 172 + 2 = 174.
     * Se reporta también la versión paranoica (cada tarifa cuenta como una
     * mirada distinta: N = 174 × 2 para las corridas que suman Cocos). */
    const Nprev = prevFi.dsr.N;
    const nNuevas = Object.keys(out.D.score.corte).length;
    const N = Nprev + nNuevas;
    const Nparanoico = Nprev * 2 + nNuevas;
    console.log(`  N ${Nprev} → ${N} (+${nNuevas}: el corte post-hoc score>=9 en las dos ventanas). Paranoico (una mirada por tarifa): ${Nparanoico}`);

    const filas = {};
    const agregar = (nombre, m) => {
      const dC = dsr(m.cocos.rets, m.cocos.srDiario, sigC, N);
      const dCp = dsr(m.cocos.rets, m.cocos.srDiario, sigC, Nparanoico);
      const dB = dsr(m.black.rets, m.black.srDiario, sigB, N);
      filas[nombre] = {
        sharpeCocos: m.cocos.sharpe, dsrCocos: dC ? dC.dsr : null, dsrCocosParanoico: dCp ? dCp.dsr : null,
        sharpeBlack: m.black.sharpe, dsrBlack: dB ? dB.dsr : null, n: m.cocos.n,
      };
      console.log(`    ${nombre.padEnd(38)} cocos SR ${n2(m.cocos.sharpe).padStart(6)} DSR ${dC ? dC.dsr.toFixed(5) : "-"} (paranoico ${dCp ? dCp.dsr.toFixed(5) : "-"}) · black SR ${n2(m.black.sharpe).padStart(6)} DSR ${dB ? dB.dsr.toFixed(5) : "-"}`);
    };
    for (const u of ["38", "50"]) for (const vn of ["IS", "OOS"]) agregar(`${u}/base/${vn}`, BASE[`${u}/${vn}`].m);
    for (const vn of ["IS", "OOS"]) {
      const o = out.D.volatilidad[vn];
      const dC = dsr(o.retsCocos, o.srCocos, sigC, N);
      filas[`base + vol20 baja/${vn}`] = { sharpeCocos: o.sharpeCocos, dsrCocos: dC ? dC.dsr : null, dsrCocosParanoico: (dsr(o.retsCocos, o.srCocos, sigC, Nparanoico) || {}).dsr ?? null, sharpeBlack: null, dsrBlack: null };
      console.log(`    ${`base + vol20 baja/${vn}`.padEnd(38)} cocos SR ${n2(o.sharpeCocos).padStart(6)} DSR ${dC ? dC.dsr.toFixed(5) : "-"}`);
    }
    for (const vn of Object.keys(out.D.score.corte)) {
      const c = out.D.score.corte[vn];
      const dC = dsr(c._rets, c._sr.cocos, sigC, N);
      filas[`score>=9 (post-hoc)/${vn}`] = { sharpeCocos: c.sharpe.cocos, dsrCocos: dC ? dC.dsr : null, dsrCocosParanoico: (dsr(c._rets, c._sr.cocos, sigC, Nparanoico) || {}).dsr ?? null, sharpeBlack: c.sharpe.black, dsrBlack: null, n: c.K };
      console.log(`    ${`score>=9 (post-hoc)/${vn}`.padEnd(38)} cocos SR ${n2(c.sharpe.cocos).padStart(6)} DSR ${dC ? dC.dsr.toFixed(5) : "-"}`);
    }
    for (const v of nuevasBa) {
      const dC = dsr(v.retsC, v.c, sigC, N);
      filas[`${v.nombre} (barrido)`] = { sharpeCocos: v.shC, dsrCocos: dC ? dC.dsr : null, dsrCocosParanoico: (dsr(v.retsC, v.c, sigC, Nparanoico) || {}).dsr ?? null, sharpeBlack: v.shB, dsrBlack: null, n: v.n };
    }
    const mejor = Object.entries(filas).filter(([, r]) => r.dsrCocos != null).sort((a, b) => b[1].dsrCocos - a[1].dsrCocos)[0];
    console.log(`  MEJOR DSR de Cocos: ${mejor[0]} → ${mejor[1].dsrCocos.toFixed(4)} (Sharpe ${n2(mejor[1].sharpeCocos)}) · ¿pasa 0,95? ${mejor[1].dsrCocos >= 0.95 ? "SÍ" : "NO"}`);
    out.E = {
      Nprev, N, Nparanoico, nNuevas, nRecon, chkSweep,
      sigmaSR: { gold: sigG, black: sigB, cocos: sigC },
      refSigma: { gold: prevFi.dsr.sigmaSR, black: prevFi.dsr.sigmaSRblack },
      filas, mejor: { nombre: mejor[0], ...mejor[1] },
    };
  }

  /* ── huella de reproducibilidad ── */
  const digest = (() => {
    const nums = [];
    const walk = (o) => {
      if (o == null) return;
      if (typeof o === "number") { nums.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { if (k === "generado" || k.startsWith("_")) continue; walk(o[k]); } }
    };
    walk({ A: out.A, B: out.B, C: out.C, D: out.D, E: out.E });
    let h = 2166136261 >>> 0;
    for (const v of nums) {
      const s = Number.isFinite(v) ? v.toExponential(12) : String(v);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { nNumeros: nums.length, fnv1a: h.toString(16) };
  })();
  out.digest = digest;
  console.log(`\nhuella de reproducibilidad: ${digest.nNumeros} números · FNV-1a ${digest.fnv1a}`);

  for (const vn of ["IS", "OOS"]) TRv[vn].forEach((x) => { delete x._tr; });
  out.trades = TRv;
  fs.writeFileSync(path.join(DIR, "results-cocos.json"), JSON.stringify(out, null, 1));
  console.log(`results-cocos.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
