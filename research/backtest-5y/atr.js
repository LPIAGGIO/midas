/* atr.js — test de STOPS POR ATR sobre el backtest de 5 años (pedido de LP,
 * 22/09/2026). Ver INFORME-ATR.md.
 *
 * Pregunta: ¿alejar el stop reduce los stop-outs lo suficiente como para
 * compensar pérdidas más grandes y posiciones más chicas?
 *
 * Configuraciones (idénticas salvo el stop; MISMO flujo de órdenes: el gate se
 * evalúa sobre el kit original del motor, así el conjunto de señales no cambia):
 *   geo     · stop geométrico del motor (abajo del soporte) — el caso base
 *   atr1.5  · stop = entrada − 1,5 × ATR(14) diario
 *   atr2    · stop = entrada − 2   × ATR(14)
 *   atr2.5  · stop = entrada − 2,5 × ATR(14)
 * Target y TP parcial (50% del camino al target) no se tocan. El trailing es en
 * unidades de R = entrada − stop, como en el bot, así que con un stop más ancho
 * el trailing también arranca más lejos. Es parte del efecto y se reporta.
 *
 * Sizing = regla real: qty = CAPITAL·RISK(1,5%)/distancia al stop, tope
 * MAX_POS_PCT(20%), tope de capital libre.
 *
 * ATR(14) Wilder sobre la DIARIA con barras t < día de la señal (point-in-time:
 * la rueda en curso no está cerrada).
 *
 * Stop con fix del gap: si la barra abre debajo del stop, llena a la apertura
 * (Math.min(stop, open)), igual que simulate.js desde el 20/09.
 *
 * Nulo: ROTACIÓN CIRCULAR de la serie ATR% de cada papel sobre el calendario
 * de la ventana (mismo j para todos los papeles), enumeración exacta de las T
 * rotaciones → p exacto. H0: alinear el ancho del stop con la volatilidad
 * CORRIENTE del papel no vale más que usar el ATR del mismo papel en otra
 * fecha (misma distribución de anchos, desalineada).
 *
 * Uso: node atr.js  → escribe results-atr.json y run-atr.log (vía tee)
 * Local. No toca VPS ni Supabase.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatePasa, loadSeries, loadCcl } from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");

/* ── constantes: IDÉNTICAS a simulate.js ── */
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
  gold: 0.005 * IVA + DERECHOS,       // 1,121% ida y vuelta
  platinum: 0.003 * IVA + DERECHOS,   // 0,721%
  cocos: 0.0005 * IVA,                // 0,121%
};
const TIERS = ["gold", "platinum", "cocos"];
const IS = ["2023-10-19", "2025-06-30"], OOS = ["2025-07-01", "2026-09-17"];
const VENTANAS = { IS, OOS };
const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TRUNCA_DAILY = { OKLO: "2024-05-10", RGTI: "2022-03-01", SATL: "2022-01-01", KEEL: "2026-04-06", LAR: "2025-01-27" };
const KS = [1.5, 2, 2.5];
const N_PREV = 395;   // contador acumulado del proyecto antes de este test

const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
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
function dsr(rets, srDiario, sigmaSR, N) {
  if (!rets || rets.length < 20 || srDiario == null || !(sigmaSR > 0) || !(N > 1)) return null;
  const n = rets.length, m = mean(rets), sd = stdev(rets);
  const g3 = mean(rets.map((r) => ((r - m) / sd) ** 3));
  const g4 = mean(rets.map((r) => ((r - m) / sd) ** 4));
  const gamma = 0.5772156649;
  const sr0 = sigmaSR * ((1 - gamma) * normInv(1 - 1 / N) + gamma * normInv(1 - 1 / (N * Math.E)));
  const den = Math.sqrt(Math.max(1e-12, 1 - g3 * srDiario + ((g4 - 1) / 4) * srDiario ** 2));
  return { sr0, dsr: normCdf(((srDiario - sr0) * Math.sqrt(n - 1)) / den) };
}

/* ── carga ── */
const syms = fs.readdirSync(path.join(DATA, "hourly")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const daily = {}, hourly = {};
for (const s of syms) {
  const d = loadSeries(DATA, "daily", s), h = loadSeries(DATA, "hourly", s);
  if (!d || !h) continue;
  daily[s] = TRUNCA_DAILY[s] ? d.filter((b) => b.t >= TRUNCA_DAILY[s]) : d;
  hourly[s] = h;
}
const senales = JSON.parse(fs.readFileSync(path.join(DIR, "signals.json"), "utf8")).senales;
const ccl = loadCcl(DATA);
const U38 = new Set(LIMPIOS_38.filter((s) => daily[s]));
const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
const prevCo = JSON.parse(fs.readFileSync(path.join(DIR, "results-cocos.json"), "utf8"));

/* ── ATR(14) Wilder y desvío diario (20 ruedas) point-in-time ──
 * volDe(sym, d) → { atrPct, sigma } usando sólo barras diarias con t < d. */
const VOL = {};
for (const s of Object.keys(daily)) {
  const D = daily[s];
  const atr = new Array(D.length).fill(null), sig = new Array(D.length).fill(null);
  let a = null;
  for (let i = 1; i < D.length; i++) {
    const tr = Math.max(D[i].h - D[i].l, Math.abs(D[i].h - D[i - 1].c), Math.abs(D[i].l - D[i - 1].c));
    if (i < 14) continue;
    if (i === 14) { let sm = 0; for (let k = 1; k <= 14; k++) sm += Math.max(D[k].h - D[k].l, Math.abs(D[k].h - D[k - 1].c), Math.abs(D[k].l - D[k - 1].c)); a = sm / 14; }
    else a = (a * 13 + tr) / 14;
    atr[i] = a / D[i].c;
    if (i >= 20) { const r = []; for (let k = i - 19; k <= i; k++) r.push(D[k].c / D[k - 1].c - 1); sig[i] = stdev(r); }
  }
  VOL[s] = { t: D.map((b) => b.t), atr, sig };
}
function volDe(sym, d) {
  const v = VOL[sym]; if (!v) return null;
  let lo = 0, hi = v.t.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (v.t[m] < d) { r = m; lo = m + 1; } else hi = m - 1; }
  return r < 0 ? null : { atrPct: v.atr[r], sigma: v.sig[r] };
}

/* ── contexto por ventana ── */
function construirCtx(universo, [desde, hasta]) {
  const tsSet = new Set(); const barAt = {}, serie = {};
  for (const s of universo) {
    if (!hourly[s]) continue;
    barAt[s] = new Map(); serie[s] = [];
    for (const b of hourly[s]) {
      if (b.t < desde || b.t > hasta) continue;
      tsSet.add(b.ts * 1000); barAt[s].set(b.ts * 1000, b); serie[s].push(b);
    }
  }
  const timeline = [...tsSet].sort((a, b) => a - b);
  const dias = [...new Set(timeline.map((t) => dia(t / 1000)))].sort();
  const meses = (new Date(dias[dias.length - 1]) - new Date(dias[0])) / (365.25 / 12 * 86400000);
  return { barAt, serie, timeline, dias, meses, tFin: timeline[timeline.length - 1], desde, hasta };
}

const gateBase = (s) => {
  const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
  return g.ok ? { riskMult: g.riskMult } : null;
};

/* órdenes base (stop geométrico) de la ventana, con el ATR de cada una */
function ordenesBase(ctx) {
  const out = [];
  for (const s of senales) {
    if (!U38.has(s.sym) || s.dia < ctx.desde || s.dia > ctx.hasta) continue;
    const f = gateBase(s);
    if (!f) continue;
    const v = volDe(s.sym, s.dia) || {};
    out.push({ ...s, riskMult: f.riskMult ?? 1, stopGeo: s.stop, atrPct: v.atrPct, sigma: v.sigma, created: s.ts * 1000 + 1 });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}
/* aplica la regla de stop. atrOf(o) permite inyectar el ATR rotado del nulo. */
function conStop(base, k, atrOf = (o) => o.atrPct) {
  if (k == null) return base.map((o) => ({ ...o, stop: o.stopGeo }));
  return base.map((o) => {
    const a = atrOf(o);
    return { ...o, stop: a != null ? o.entry * (1 - k * a) : o.stopGeo };
  });
}

/* ── simulador: copia de simulate.js CON el fix del gap + exposición y
 * registro de sizing. Sin tier black (no pedido); con cocos. ── */
function simular(ordenes, ctx, { light = false } = {}) {
  const { barAt, timeline, tFin } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const entradasDia = new Map();
  const realized = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const equity = [];
  let oi = 0;
  const comprometido = () => { let s = 0; for (const p of pend.values()) s += p.notional; for (const p of open.values()) s += p.notional; return s; };
  const abierto = () => { let s = 0; for (const p of open.values()) s += p.notional; return s; };
  const feeLeg = (n, tier, bonif) => n * (bonif ? DERECHOS : FEE[tier]);
  const cerrarPata = (pos, qty, px, ts, reason) => {
    const d = dia(ts / 1000);
    const rOut = rArs(d);
    const intradia = dia(pos.entryTs / 1000) === d;
    const entN = qty * pos.entryPx * pos.rIn, outN = qty * px * rOut;
    const leg = { reason, entN, bruto: outN - entN, brutoSinCcl: qty * (px - pos.entryPx) * pos.rIn, horas: (ts - pos.entryTs) / 3600000, pnl: {}, fees: {} };
    for (const tier of TIERS) {
      const f = feeLeg(entN, tier, false) + feeLeg(outN, tier, intradia);
      leg.fees[tier] = f; leg.pnl[tier] = outN - entN - f; realized[tier] += leg.pnl[tier];
    }
    legs.push(leg); pos.legs.push(leg);
  };
  for (const t of timeline) {
    while (oi < ordenes.length && ordenes[oi].created <= t) {
      const o = ordenes[oi++];
      if (!barAt[o.sym]) continue;
      if (open.has(o.sym)) continue;
      const prv = pend.get(o.sym);
      if (prv && Math.abs(prv.entry - o.entry) / o.entry < 0.005) continue;
      if (prv) pend.delete(o.sym);
      if (pend.size + open.size >= MAX_POS) continue;
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) continue;
      const rIn = rArs(d);
      const riesgoU = (o.entry - o.stop) * rIn;
      if (!(riesgoU > 0)) continue;
      const qRisk = (CAPITAL * RISK * o.riskMult) / riesgoU;
      const qCap = (CAPITAL * CAP_PCT) / (o.entry * rIn);
      const qLibre = Math.max(0, CAPITAL - comprometido()) / (o.entry * rIn);
      const qty = Math.min(qRisk, qCap, qLibre);
      if (!(qty > 0)) continue;
      const manda = qty === qRisk ? "riesgo" : qty === qCap ? "tope20" : "capitalLibre";
      entradasDia.set(d, (entradasDia.get(d) || 0) + 1);
      pend.set(o.sym, { ...o, qty, rIn, manda, notional: qty * o.entry * rIn });
    }
    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); continue; }
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (b.l <= p.entry) {
        pend.delete(sym);
        const pos = {
          sym: p.sym, qty: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          notional: p.qty * p.entry * p.rIn, legs: [], tpDone: false, manda: p.manda,
          riesgoPct: p.qty * (p.entry - p.stop) * p.rIn / CAPITAL,
          stopPct: (p.entry - p.stop) / p.entry, stopGeoPct: (p.entry - p.stopGeo) / p.entry,
          atrPct: p.atrPct, sigma: p.sigma, tamPct: p.qty * p.entry * p.rIn / CAPITAL,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }
    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b || t === pos.entryTs) continue;
      if (b.l <= pos.stop) {
        // FIX DEL GAP (simulate.js 20/09): si abre debajo del stop, llena a la apertura
        cerrarPata(pos, pos.qty, Math.min(pos.stop, b.o), t, pos.stop > pos.stopIni ? "trailing" : "stop");
        open.delete(sym); continue;
      }
      if (TP_FRAC > 0 && !pos.tpDone) {
        const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
        if (b.h >= nivel) { const q = pos.qty / 2; cerrarPata(pos, q, Math.min(nivel, pos.target), t, "tp_parcial"); pos.qty -= q; pos.notional = pos.qty * pos.entryPx * pos.rIn; pos.tpDone = true; }
      }
      if (b.h >= pos.target) { cerrarPata(pos, pos.qty, pos.target, t, "target"); open.delete(sym); continue; }
      const kk = Math.floor((b.h - pos.entryPx) / pos.R);
      if (kk >= 2 && pos.entryPx + (kk - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (kk - 2) * pos.R;
    }
    if (!light) {
      const d = dia(t / 1000);
      let unreal = 0;
      for (const [sym, pos] of open) { const b = barAt[sym].get(t); unreal += pos.qty * ((b ? b.c : pos.entryPx) - pos.entryPx) * pos.rIn; }
      const row = { dia: d, expo: abierto(), eq: {} };
      for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
      if (equity.length && equity[equity.length - 1].dia === d) { row.expo = Math.max(row.expo, equity[equity.length - 1].expo); equity[equity.length - 1] = row; }
      else equity.push(row);
    }
  }
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || hourly[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    cerrarPata(pos, pos.qty, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (!light && equity.length) { const last = equity[equity.length - 1]; for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier]; }
  return { trades, legs, equity, realized };
}

function metricas(sim, tier, meses) {
  const porTrade = sim.trades.map((tr) => tr.legs.reduce((s, l) => s + l.pnl[tier], 0));
  const n = porTrade.length;
  const total = porTrade.reduce((s, x) => s + x, 0);
  const rets = [];
  for (let i = 1; i < sim.equity.length; i++) rets.push(sim.equity[i].eq[tier] / sim.equity[i - 1].eq[tier] - 1);
  const m = mean(rets), sd = stdev(rets);
  let peak = -Infinity, dd = 0;
  for (const e of sim.equity) { peak = Math.max(peak, e.eq[tier]); dd = Math.max(dd, (peak - e.eq[tier]) / peak); }
  const notional = sim.legs.reduce((s, l) => s + l.entN, 0);
  const bruto = sim.legs.reduce((s, l) => s + l.bruto, 0), brutoSinCcl = sim.legs.reduce((s, l) => s + l.brutoSinCcl, 0);
  return {
    n, total, expectancy: n ? total / n : null,
    brutoPct: notional > 0 ? bruto / notional : null, papelPct: notional > 0 ? brutoSinCcl / notional : null,
    cclPct: notional > 0 ? (bruto - brutoSinCcl) / notional : null,
    horasMed: med(sim.trades.map((tr) => tr.legs[tr.legs.length - 1].horas)),
    expPctNocional: notional > 0 ? total / notional : null,
    winRate: n ? porTrade.filter((x) => x > 0).length / n : null,
    mensualPct: (total / CAPITAL / meses) * 100,
    sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : null, srDiario: sd > 0 ? m / sd : null,
    maxDDpct: dd * 100, rets,
  };
}
function salidas(sim) {
  const c = { stop: 0, trailing: 0, target: 0, fin_ventana: 0 }; let conParcial = 0;
  for (const tr of sim.trades) {
    const fin = tr.legs[tr.legs.length - 1].reason;
    c[fin] = (c[fin] || 0) + 1;
    if (tr.legs.some((l) => l.reason === "tp_parcial")) conParcial++;
  }
  const n = sim.trades.length || 1;
  return { stopPct: c.stop / n, trailingPct: c.trailing / n, targetPct: c.target / n, finPct: c.fin_ventana / n, conParcialPct: conParcial / n, cuentas: c };
}
function sizing(sim) {
  const t = sim.trades;
  const n = t.length || 1;
  return {
    mandaTope20: t.filter((x) => x.manda === "tope20").length / n,
    mandaRiesgo: t.filter((x) => x.manda === "riesgo").length / n,
    mandaLibre: t.filter((x) => x.manda === "capitalLibre").length / n,
    riesgoMed: med(t.map((x) => x.riesgoPct)), riesgoMin: Math.min(...t.map((x) => x.riesgoPct)), riesgoMax: Math.max(...t.map((x) => x.riesgoPct)),
    tamMed: med(t.map((x) => x.tamPct)),
    stopPctMed: med(t.map((x) => x.stopPct)),
    stopSigmaMed: med(t.filter((x) => x.sigma > 0).map((x) => x.stopPct / x.sigma)),
    stopSigmaMedia: mean(t.filter((x) => x.sigma > 0).map((x) => x.stopPct / x.sigma)),
    stopAtrMed: med(t.filter((x) => x.atrPct > 0).map((x) => x.stopPct / x.atrPct)),
    // P(tocar el stop en un día) aprox. bajo normal: 2·Φ(−z) (principio de reflexión)
    pTocaDiaMed: med(t.filter((x) => x.sigma > 0).map((x) => 2 * normCdf(-x.stopPct / x.sigma))),
  };
}
function benchmarkSpy(ctx) {
  const arr = ctx.serie.SPY; const m = new Map();
  for (const b of arr) m.set(b.t, b.c * (ccl(b.t) || 1));
  const ds = [...m.keys()].sort();
  const tot = m.get(ds[ds.length - 1]) / m.get(ds[0]) - 1;
  return { totalPct: tot, mensualPct: (tot / ctx.meses) * 100 };
}
function ubicar(real, nulos) {
  const B = nulos.length, s = [...nulos].sort((x, y) => x - y);
  return {
    percentil: (nulos.filter((x) => x < real).length + 0.5 * nulos.filter((x) => x === real).length) / B,
    p1cola: (nulos.filter((x) => x >= real).length + 1) / (B + 1), B,
    med: s[Math.floor(B / 2)], p05: s[Math.floor(B * 0.05)], p95: s[Math.floor(B * 0.95)], real,
  };
}

/* ═══════════════════════════════ main ═══════════════════════════════ */
const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pc = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : Number(n).toFixed(d));
const t0 = Date.now();
const out = { generado: new Date().toISOString(), config: { KS, CAPITAL, RISK, CAP_PCT, IS, OOS }, filas: {}, nulo: {}, chequeo: {} };
const CTX = { IS: construirCtx(U38, IS), OOS: construirCtx(U38, OOS) };
const BASE = { IS: ordenesBase(CTX.IS), OOS: ordenesBase(CTX.OOS) };
const BENCH = { IS: benchmarkSpy(CTX.IS), OOS: benchmarkSpy(CTX.OOS) };
console.log(`universo ${U38.size} · órdenes IS ${BASE.IS.length} OOS ${BASE.OOS.length} · sin ATR: ${BASE.IS.filter((o) => o.atrPct == null).length}/${BASE.OOS.filter((o) => o.atrPct == null).length}`);
console.log(`SPY en pesos B&H: IS ${n2(BENCH.IS.mensualPct)}%/mes · OOS ${n2(BENCH.OOS.mensualPct)}%/mes`);

/* chequeo de consistencia: geo tiene que reproducir results.json (con fix del gap) */
for (const vn of ["IS", "OOS"]) {
  const sim = simular(conStop(BASE[vn], null), CTX[vn]);
  const mG = metricas(sim, "gold", CTX[vn].meses), mP = metricas(sim, "platinum", CTX[vn].meses);
  const ref = prev.corridas[`38/base/${vn}`].metricas;
  const ok = mG.n === ref.gold.n && Math.abs(mG.mensualPct - ref.gold.mensualPct) < 1e-9 && Math.abs(mP.mensualPct - ref.platinum.mensualPct) < 1e-9;
  out.chequeo[vn] = { n: mG.n, refN: ref.gold.n, gold: mG.mensualPct, refGold: ref.gold.mensualPct, ok };
  console.log(`[chequeo ${vn}] geo n=${mG.n} (ref ${ref.gold.n}) · gold ${mG.mensualPct.toFixed(6)} (ref ${ref.gold.mensualPct.toFixed(6)}) · ${ok ? "REPRODUCE" : "NO REPRODUCE"}`);
  if (!ok) throw new Error("ABORTA: el caso geométrico no reproduce results.json");
}

/* las cuatro configuraciones */
const CONFIGS = [["geo", null], ...KS.map((k) => [`atr${k}`, k])];
const SRS_NUEVAS = [];
for (const vn of ["IS", "OOS"]) {
  console.log(`\n===== ${vn} (${CTX[vn].meses.toFixed(1)} meses) =====`);
  for (const [nm, k] of CONFIGS) {
    const sim = simular(conStop(BASE[vn], k), CTX[vn]);
    const fila = { salidas: salidas(sim), sizing: sizing(sim), tiers: {} };
    const expoMedia = mean(sim.equity.map((e) => e.expo / CAPITAL));
    fila.expoMedia = expoMedia;
    fila.benchSpy = BENCH[vn].mensualPct * expoMedia;
    for (const tier of TIERS) {
      const m = metricas(sim, tier, CTX[vn].meses);
      fila.tiers[tier] = { ...m, rets: undefined, exceso: m.mensualPct - fila.benchSpy };
      if (k != null) SRS_NUEVAS.push({ nm, vn, tier, sr: m.srDiario, rets: m.rets });
      fila.tiers[tier]._rets = m.rets;
    }
    out.filas[`${nm}/${vn}`] = fila;
    const s = fila.salidas, z = fila.sizing;
    console.log(`${nm.padEnd(7)} n=${String(fila.tiers.gold.n).padStart(3)} · stop ${pc(s.stopPct).padStart(6)} trail ${pc(s.trailingPct).padStart(6)} target ${pc(s.targetPct).padStart(6)} fin ${pc(s.finPct).padStart(5)} (con parcial ${pc(s.conParcialPct)}) · win ${pc(fila.tiers.gold.winRate)} · expo ${n2(expoMedia)}x · SPY·expo ${n2(fila.benchSpy)}%`);
    console.log(`        sizing: tope20 manda ${pc(z.mandaTope20)} · riesgo manda ${pc(z.mandaRiesgo)} · libre ${pc(z.mandaLibre)} · riesgo real med ${pc(z.riesgoMed, 2)} [${pc(z.riesgoMin, 2)}–${pc(z.riesgoMax, 2)}] · tam med ${pc(z.tamMed)} · stop med ${pc(z.stopPctMed, 2)} = ${n2(z.stopSigmaMed)}σ (media ${n2(z.stopSigmaMedia)}σ) = ${n2(z.stopAtrMed)} ATR · P(toca en 1 día) med ${pc(z.pTocaDiaMed)}`);
    { const m = fila.tiers.gold; console.log(`        bruto ${pc(m.brutoPct, 3)} del nocional = papel ${pc(m.papelPct, 3)} + CCL ${pc(m.cclPct, 3)} · tenencia mediana ${n2(m.horasMed, 0)} h`); }
    for (const tier of TIERS) {
      const m = fila.tiers[tier];
      console.log(`        ${tier.padEnd(9)} exp/trade $${fmt(m.expectancy).padStart(8)} (${pc(m.expPctNocional, 3)} del nocional) · total $${fmt(m.total).padStart(10)} · ${n2(m.mensualPct).padStart(6)}%/mes · Sharpe ${n2(m.sharpe).padStart(6)} · DD ${n2(m.maxDDpct).padStart(5)}% · exceso vs SPY ${n2(m.exceso).padStart(6)} pp`);
    }
  }
}

/* descomposición: ¿cuánto es sizing y cuánto es la salida? Variante de
 * diagnóstico: stop ATR para las SALIDAS pero con el tamaño que hubiera tenido
 * con el stop geométrico (misma qty). No es una configuración candidata. */
console.log(`\n===== DIAGNÓSTICO · separar efecto salida vs efecto tamaño (k=2) =====`);
for (const vn of ["IS", "OOS"]) {
  // qty geo: simular con stop geo sólo para sizing es complicado por el capital
  // comprometido; aproximación: riskMult ajustado para que la qty sea la del geo
  const ords = conStop(BASE[vn], 2).map((o) => {
    const rGeo = o.entry - o.stopGeo, rAtr = o.entry - o.stop;
    return { ...o, riskMult: o.riskMult * (rAtr / rGeo) };
  });
  const sim = simular(ords, CTX[vn]);
  const res = {};
  for (const tier of TIERS) res[tier] = metricas(sim, tier, CTX[vn].meses).mensualPct;
  out.filas[`diag-salidaATR2-tamGeo/${vn}`] = { tiers: Object.fromEntries(TIERS.map((t) => [t, { mensualPct: res[t] }])), salidas: salidas(sim), sizing: sizing(sim) };
  console.log(`[${vn}] salida ATR×2 con tamaño geo: gold ${n2(res.gold)} · plat ${n2(res.platinum)} · cocos ${n2(res.cocos)} %/mes · stop ${pc(salidas(sim).stopPct)} · tam med ${pc(sizing(sim).tamMed)}`);
}

/* ══ NULO: rotación circular del ATR% por papel, enumeración exacta ══ */
console.log(`\n===== NULO · rotación circular de la serie ATR (p exacto) =====`);
for (const vn of ["IS", "OOS"]) {
  const ctx = CTX[vn], dias = ctx.dias, T = dias.length;
  const iDia = new Map(dias.map((d, i) => [d, i]));
  // matriz ATR% por papel y día de la ventana (point-in-time)
  const A = {};
  for (const s of U38) A[s] = dias.map((d) => { const v = volDe(s, d); return v ? v.atrPct : null; });
  for (const k of KS) {
    const real = out.filas[`atr${k}/${vn}`].tiers;
    const nul = Object.fromEntries(TIERS.map((t) => [t, []]));
    for (let j = 1; j < T; j++) {
      const atrOf = (o) => {
        const i = iDia.get(o.dia); if (i == null) return o.atrPct;
        const a = A[o.sym][(i + j) % T];
        return a != null ? a : o.atrPct;
      };
      const sim = simular(conStop(BASE[vn], k, atrOf), ctx, { light: true });
      for (const t of TIERS) nul[t].push((sim.realized[t] / CAPITAL / ctx.meses) * 100);
    }
    out.nulo[`atr${k}/${vn}`] = {};
    const lin = [];
    for (const t of TIERS) {
      const u = ubicar(real[t].mensualPct, nul[t]);
      out.nulo[`atr${k}/${vn}`][t] = u;
      lin.push(`${t} real ${n2(u.real)} · nulo med ${n2(u.med)} [${n2(u.p05)}, ${n2(u.p95)}] · pctil ${pc(u.percentil)} · p=${u.p1cola.toFixed(4)}`);
    }
    console.log(`  atr${k}/${vn} (B=${T - 1}):\n    ${lin.join("\n    ")}`);
  }
}

/* ══ DSR con el contador acumulado ══ */
const nNuevas = KS.length * 2;   // 3 configuraciones × 2 ventanas (el geo ya estaba contado)
const N = N_PREV + nNuevas;
const sigPrev = prevCo.E.sigmaSR.cocos;
out.dsr = { Nprev: N_PREV, nNuevas, N, sigmaSR: sigPrev, filas: {} };
console.log(`\n===== DSR · N ${N_PREV} → ${N} · σ(SR) ${sigPrev.toExponential(3)} (publicado, Cocos) =====`);
for (const [nm] of CONFIGS) for (const vn of ["IS", "OOS"]) for (const tier of TIERS) {
  const f = out.filas[`${nm}/${vn}`].tiers[tier];
  const d = dsr(f._rets, f.srDiario, sigPrev, N);
  out.dsr.filas[`${nm}/${vn}/${tier}`] = d ? d.dsr : null;
}
for (const [nm] of CONFIGS) console.log(`  ${nm.padEnd(7)} ` + ["IS", "OOS"].map((vn) => `${vn}: ` + TIERS.map((t) => `${t} ${n2(out.dsr.filas[`${nm}/${vn}/${t}`], 3)}`).join(" ")).join(" | "));

for (const f of Object.values(out.filas)) for (const t of Object.values(f.tiers)) delete t._rets;
fs.writeFileSync(path.join(DIR, "results-atr.json"), JSON.stringify(out, null, 1));
console.log(`\nresults-atr.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
