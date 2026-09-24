/* nulo.js — ¿el filtro de régimen SELECCIONA trades o sólo RECORTA exposición?
 *
 * El INFORME.md concluye que "base + vol20 baja" es la única recomendación
 * defendible, y de paso admite que mejora "porque opera menos, no porque opere
 * mejor". Esa admisión nunca se testeó. En un sistema con expectativa NEGATIVA
 * sacar trades al azar mejora el mensual por pura aritmética. Acá se mide si
 * el filtro le gana al azar.
 *
 * Bloques:
 *   A) dos modelos nulos (trades al azar / bloques de calendario al azar)
 *   B) expectancy de lo que el filtro DEJA PASAR contra lo que BLOQUEA
 *   C) auditoría de lookahead en las etiquetas de régimen + re-corrida sin él
 *   D) fase del apagado: ¿reenciende tarde? contra un nulo de reencendido
 *
 * Reusa engine.js y el cache signals.json que genera simulate.js. Todo local:
 * no toca VPS, Supabase ni nada vivo. ESM.
 *
 *   node nulo.js                 → corrida completa, escribe results-nulo.json
 *   node nulo.js --draws=500     → menos sorteos (para iterar rápido)
 *
 * SEMILLA DEL GENERADOR: 20260917 (mulberry32). Anotada a propósito: con esa
 * semilla los números de este informe se reproducen exactos.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatePasa, loadSeries, loadCcl, emaOf, emaStep } from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = process.argv.slice(2);
const argN = (k, d) => {
  const a = ARGS.find((x) => x.startsWith(`--${k}=`));
  return a ? Number(a.split("=")[1]) : d;
};
const DRAWS = argN("draws", 5000);
const SEED = 20260917;

/* ─────────────────────── PRNG reproducible ─────────────────────── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── constantes: IDÉNTICAS a simulate.js (no tocar) ── */
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
const DIAS_REGIME = 126;

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

/* ── features de SPY, parametrizado por ajuste y por rezago (bloque C) ── */
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
 * Copia de simular() de simulate.js con dos cambios de forma, ninguno de
 * fondo: (1) el mapa de barras y la línea de tiempo se construyen UNA vez por
 * (universo, ventana) y se reusan en los 5.000 sorteos — si no, cada sorteo
 * pagaría de nuevo la construcción, que es el 95% del costo; (2) la línea de
 * tiempo es la del universo completo y no la de los símbolos efectivamente
 * usados, para que el denominador de meses sea EL MISMO en el filtro real y en
 * cada sorteo (si no, un sorteo con menos símbolos tendría menos meses y el
 * mensual saldría inflado). El chequeo del arranque verifica que eso no mueve
 * ningún número contra results.json. */
function construirCtx(bars, universo, desde, hasta) {
  const tsSet = new Set(); const barAt = {};
  for (const s of universo) {
    if (!bars[s]) continue;
    barAt[s] = new Map();
    for (const b of bars[s]) {
      if (b.t < desde || b.t > hasta) continue;
      tsSet.add(b.ts * 1000); barAt[s].set(b.ts * 1000, b);
    }
  }
  const timeline = [...tsSet].sort((a, b) => a - b);
  const dias = [...new Set(timeline.map((t) => dia(t / 1000)))].sort();
  const meses = dias.length ? (new Date(dias[dias.length - 1]) - new Date(dias[0])) / (365.25 / 12 * 86400000) : 1;
  return { barAt, timeline, dias, meses, tFin: timeline.length ? timeline[timeline.length - 1] : 0, bars, desde, hasta };
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

function simular(ordenes, ctx, ccl, { light = false, exitMode = "intrabar", capPct = CAP_PCT } = {}) {
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
          sym: p.sym, qty: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          notional: p.qty * p.entry * p.rIn, notional0: p.qty * p.entry * p.rIn,
          legs: [], tpDone: false,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia,
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

/* ─────────────────────────── métricas ─────────────────────────── */
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
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    sharpe, maxDDpct: dd * 100, srDiario: sd > 0 ? m / sd : null, rets,
  };
}
const mensualLight = (sim, tier, meses) => (sim.realized[tier] / CAPITAL / Math.max(meses, 1e-9)) * 100;

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

/* test de diferencia de medias de Welch, p a dos colas por aproximación normal
 * (con n de 40-150 por grupo la t y la normal difieren en la 3ª decimal) */
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return null;
  const ma = mean(a), mb = mean(b), sa = stdev(a), sb = stdev(b);
  const se = Math.sqrt(sa * sa / na + sb * sb / nb);
  const t = se > 0 ? (ma - mb) / se : 0;
  const df = se > 0 ? (sa * sa / na + sb * sb / nb) ** 2 /
    ((sa * sa / na) ** 2 / (na - 1) + (sb * sb / nb) ** 2 / (nb - 1)) : 0;
  return { na, nb, ma, mb, sa, sb, se, t, df, p2: 2 * (1 - normCdf(Math.abs(t))) };
}

/* percentil del valor real dentro de la distribución nula + p de una cola
 * (p = P(nulo >= real): chico = el filtro le gana al azar) */
function ubicar(real, nulos) {
  const B = nulos.length;
  const menores = nulos.filter((x) => x < real).length;
  const iguales = nulos.filter((x) => x === real).length;
  const pct = (menores + 0.5 * iguales) / B;
  const p = (nulos.filter((x) => x >= real).length + 1) / (B + 1);
  const s = [...nulos].sort((x, y) => x - y);
  return {
    percentil: pct, p1cola: p, B,
    med: s[Math.floor(B / 2)], p05: s[Math.floor(B * 0.05)], p95: s[Math.floor(B * 0.95)],
    mediaNulo: mean(nulos), sdNulo: stdev(nulos), real,
  };
}

/* ── sorteo de K de N sin reemplazo (Fisher-Yates parcial) ── */
function sorteoK(idx, N, K, rnd) {
  for (let i = 0; i < K; i++) { const j = i + Math.floor(rnd() * (N - i)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  return idx.slice(0, K);
}

/* ── colocación al azar de bloques contiguos preservando duraciones ──
 * D días, m bloques de largos L (suma S). Se sortean los m+1 huecos: los
 * interiores con al menos 1 día (si no, dos bloques vecinos se fusionarían y
 * la distribución de duraciones dejaría de ser la real). Composición uniforme
 * por barras y estrellas. */
function colocarBloques(D, L, rnd) {
  const m = L.length;
  if (!m) return [];
  const S = L.reduce((s, x) => s + x, 0);
  let sep = 1, F = D - S - (m - 1);
  if (F < 0) { sep = 0; F = D - S; }           // no entran separados: se permite pegarlos
  if (F < 0) return null;
  const cortes = [];
  for (let i = 0; i < m; i++) cortes.push(Math.floor(rnd() * (F + 1)));
  cortes.sort((a, b) => a - b);
  const huecos = [];
  let prev = 0;
  for (const c of cortes) { huecos.push(c - prev); prev = c; }
  huecos.push(F - prev);
  const orden = L.slice();
  for (let i = orden.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = orden[i]; orden[i] = orden[j]; orden[j] = t; }
  const out = [];
  let pos = huecos[0];
  for (let i = 0; i < m; i++) {
    out.push([pos, pos + orden[i] - 1]);
    pos += orden[i] + (i < m - 1 ? sep + huecos[i + 1] : 0);
  }
  return out;
}

/* bloques contiguos de `false` dentro de una máscara booleana por día */
function bloquesOff(mask) {
  const out = [];
  let i = 0;
  while (i < mask.length) {
    if (!mask[i]) { let j = i; while (j + 1 < mask.length && !mask[j + 1]) j++; out.push([i, j]); i = j + 1; }
    else i++;
  }
  return out;
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
  console.log(`series ${all.syms.length} · señales ${senales.length} · universo limpio ${U38.size} · sorteos ${DRAWS} · semilla ${SEED}`);

  const out = { generado: new Date().toISOString(), semilla: SEED, draws: DRAWS };

  /* ── features y umbrales ── */
  const FA = featuresSpy({ useAdj: true, lag: 1 });          // el del informe
  const FC = featuresSpy({ useAdj: false, lag: 1 });         // close crudo (bloque C)
  const F0 = featuresSpy({ useAdj: true, lag: 0 });          // SIN rezago (bloque C)

  const volMedIS = (() => {
    const v = senales.filter((s) => s.dia <= IS_HASTA && s.vol != null).map((s) => s.vol).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })();
  console.log(`volMedIS (por señal, como simulate.js) = ${volMedIS} · results.json dice ${prev.volMedIS} · ${volMedIS === prev.volMedIS ? "COINCIDE" : "NO COINCIDE"}`);

  // mediana del IS pero por RUEDA, no por señal (una señal por día pesa igual
  // que 40 señales del mismo día)
  const volMedISdia = (() => {
    const v = [];
    for (const d of FA.dias) { if (d > IS_HASTA || d < IS_DESDE) continue; const f = FA.feat.get(d); if (f && f.vol != null) v.push(f.vol); }
    v.sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })();

  // mediana EXPANSIVA point-in-time: en la rueda D, la mediana de toda la vol
  // conocida hasta D-1 (nada del futuro, ni siquiera del futuro del IS)
  const volMedExp = (() => {
    const m = new Map(); const acum = [];
    for (const d of FA.dias) {
      const f = FA.feat.get(d);
      if (acum.length >= 60) { const s = [...acum].sort((a, b) => a - b); m.set(d, s[Math.floor(s.length / 2)]); }
      if (f && f.vol != null) acum.push(f.vol);
    }
    return m;
  })();
  // mediana MÓVIL de 252 ruedas, también point-in-time: no arrastra 2022 como
  // la expansiva, así que es la versión PIT más parecida en nivel a la del
  // informe. Es la comparación justa.
  const volMed252 = (() => {
    const m = new Map(); const acum = [];
    for (const d of FA.dias) {
      const f = FA.feat.get(d);
      if (acum.length >= 120) { const s = acum.slice(-252).sort((a, b) => a - b); m.set(d, s[Math.floor(s.length / 2)]); }
      if (f && f.vol != null) acum.push(f.vol);
    }
    return m;
  })();
  // cuantiles de la vol del IS (por rueda), para el barrido de exposición
  const volQ = (q) => {
    const v = [];
    for (const d of FA.dias) { if (d > IS_HASTA || d < IS_DESDE) continue; const f = FA.feat.get(d); if (f && f.vol != null) v.push(f.vol); }
    v.sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * q))] : null;
  };
  console.log(`umbral vol · por señal ${n2(volMedIS, 4)} · por rueda ${n2(volMedISdia, 4)} · expansivo al 30/06/2025 ${n2(volMedExp.get(IS_HASTA), 4)} · expansivo al 17/09/2026 ${n2(volMedExp.get(FA.dias[FA.dias.length - 1]), 4)}`);
  out.umbrales = { volMedIS, volMedISdia, volMedExpFinIS: volMedExp.get(IS_HASTA), volMedExpFin: volMedExp.get(FA.dias[FA.dias.length - 1]) };

  /* ── gates ── */
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

  // condición a nivel RUEDA (la que usa el nulo de bloques). Para vol y EMA es
  // idéntica a la de la señal (el feature es diario). Para el régimen del
  // worker, que cambia intradía, se toma la mayoría de las barras del día.
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
    // chequeo: el régimen recalculado tiene que coincidir con el del cache
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
  console.log(`\n===== CHEQUEO: la línea de tiempo canónica no mueve ningún número =====`);
  const chequeo = [];
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
  for (const [gn, g] of Object.entries(GATES_CHK)) {
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const ord = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, g);
      const sim = simular(ord, ctx, ccl);
      const m = metricas(sim, "gold", ctx.meses);
      const ref = prev.corridas[`${mapaPrev[gn]}/${vn}`];
      const dm = ref ? m.mensualPct - ref.metricas.gold.mensualPct : null;
      const dn = ref ? m.n - ref.metricas.gold.n : null;
      chequeo.push({ gate: gn, vn, n: m.n, mensual: m.mensualPct, dMensual: dm, dN: dn });
      console.log(`  ${(gn + "/" + vn).padEnd(42)} n=${String(m.n).padStart(4)} (Δ${dn}) mensual ${n2(m.mensualPct).padStart(6)}% (Δ${dm == null ? "-" : dm.toExponential(1)})`);
    }
  }
  out.chequeoTimeline = chequeo;

  /* ══════════════════ A) MODELOS NULOS ══════════════════ */
  console.log(`\n===== A · MODELOS NULOS · ${DRAWS} sorteos por celda · semilla ${SEED} =====`);
  out.A = {};
  const rnd = mulberry32(SEED);

  for (const par of PARES) {
    out.A[par.nombre] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, par.gp);
      const hijo = padre.filter((o) => par.cond(o));
      const N = padre.length, K = hijo.length;
      if (!K || K === N) { console.log(`  ${par.nombre}/${vn}: K=${K} N=${N}, no hay nada que sortear`); continue; }

      const simReal = simular(hijo, ctx, ccl);
      const mrG = metricas(simReal, "gold", ctx.meses), mrB = metricas(simReal, "black", ctx.meses);

      // ── Nulo 1: K trades al azar de los N ──
      const idx = [...Array(N).keys()];
      const n1G = [], n1B = [], n1n = [];
      for (let b = 0; b < DRAWS; b++) {
        const sel = sorteoK(idx, N, K, rnd).sort((a, b2) => a - b2).map((i) => padre[i]);
        const s = simular(sel, ctx, ccl, { light: true });
        n1G.push(mensualLight(s, "gold", ctx.meses));
        n1B.push(mensualLight(s, "black", ctx.meses));
        n1n.push(s.trades.length);
      }

      // ── Nulo 2: mismos días apagados, en bloques contiguos al azar ──
      const dias = ctx.dias;
      const maskReal = dias.map((d) => par.dc(d));
      const offs = bloquesOff(maskReal);
      const largos = offs.map(([a, b]) => b - a + 1);
      const diasOff = largos.reduce((s, x) => s + x, 0);
      const offSetReal = new Set();
      for (const [a, b] of offs) for (let i = a; i <= b; i++) offSetReal.add(dias[i]);
      const hijoDia = padre.filter((o) => !offSetReal.has(o.dia));
      const simRealDia = simular(hijoDia, ctx, ccl);
      const mrdG = metricas(simRealDia, "gold", ctx.meses), mrdB = metricas(simRealDia, "black", ctx.meses);

      const n2G = [], n2B = [], n2n = [];
      let fallos = 0;
      for (let b = 0; b < DRAWS; b++) {
        const col = colocarBloques(dias.length, largos, rnd);
        if (!col) { fallos++; continue; }
        const off = new Set();
        for (const [a, z] of col) for (let i = a; i <= z && i < dias.length; i++) off.add(dias[i]);
        const sel = padre.filter((o) => !off.has(o.dia));
        const s = simular(sel, ctx, ccl, { light: true });
        n2G.push(mensualLight(s, "gold", ctx.meses));
        n2B.push(mensualLight(s, "black", ctx.meses));
        n2n.push(s.trades.length);
      }

      const rec = {
        N, K, fraccion: K / N, nTradesReal: mrG.n, mensualReal: { gold: mrG.mensualPct, black: mrB.mensualPct },
        expReal: { gold: mrG.expectancy, black: mrB.expectancy },
        nulo1: { gold: ubicar(mrG.mensualPct, n1G), black: ubicar(mrB.mensualPct, n1B), nTradesMedio: mean(n1n) },
        bloques: { cant: offs.length, diasOff, diasTot: dias.length, largos, largoMed: largos.length ? mean(largos) : 0, fallos },
        realDia: { n: mrdG.n, gold: mrdG.mensualPct, black: mrdB.mensualPct },
        nulo2: { gold: ubicar(mrdG.mensualPct, n2G), black: ubicar(mrdB.mensualPct, n2B), nTradesMedio: mean(n2n) },
      };
      out.A[par.nombre][vn] = rec;
      const u1 = rec.nulo1.gold, u2 = rec.nulo2.gold, u1b = rec.nulo1.black, u2b = rec.nulo2.black;
      console.log(`  ${(par.nombre + " / " + vn).padEnd(40)} señales ${K}/${N} (${pct(K / N)}) · trades ${mrG.n}`);
      console.log(`     nulo1 (trades al azar)   gold real ${n2(u1.real).padStart(6)}% mediana nulo ${n2(u1.med).padStart(6)}% pctil ${pct(u1.percentil).padStart(6)} p=${u1.p1cola.toFixed(4)} | black pctil ${pct(u1b.percentil).padStart(6)} p=${u1b.p1cola.toFixed(4)}`);
      console.log(`     nulo2 (bloques al azar)  gold real ${n2(u2.real).padStart(6)}% mediana nulo ${n2(u2.med).padStart(6)}% pctil ${pct(u2.percentil).padStart(6)} p=${u2.p1cola.toFixed(4)} | black pctil ${pct(u2b.percentil).padStart(6)} p=${u2b.p1cola.toFixed(4)}`);
      console.log(`     bloques apagados: ${offs.length} bloques, ${diasOff}/${dias.length} ruedas (${pct(diasOff / dias.length)}), largo medio ${n2(rec.bloques.largoMed, 1)} ruedas, máximo ${Math.max(...largos, 0)}`);
    }
  }

  /* ══════════════════ B) ¿SELECCIONA O SÓLO RECORTA? ══════════════════ */
  console.log(`\n===== B · EXPECTANCY DE LO QUE PASA CONTRA LO QUE BLOQUEA =====`);
  out.B = {};
  for (const par of PARES) {
    out.B[par.nombre] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, par.gp);
      const sim = simular(padre, ctx, ccl);
      const pasa = { gold: [], black: [], bruto: [] }, bloq = { gold: [], black: [], bruto: [] };
      for (const t of sim.trades) {
        const g = par.cond(t) ? pasa : bloq;
        g.gold.push(t.legs.reduce((s, l) => s + l.pnl.gold, 0));
        g.black.push(t.legs.reduce((s, l) => s + l.pnl.black, 0));
        g.bruto.push(t.legs.reduce((s, l) => s + l.bruto, 0) / t.notional0);
      }
      const w = { gold: welch(pasa.gold, bloq.gold), black: welch(pasa.black, bloq.black), bruto: welch(pasa.bruto, bloq.bruto) };
      out.B[par.nombre][vn] = { nPasa: pasa.gold.length, nBloq: bloq.gold.length, welch: w };
      if (!w.gold) { console.log(`  ${par.nombre}/${vn}: n insuficiente`); continue; }
      console.log(`  ${(par.nombre + " / " + vn).padEnd(40)} pasa n=${w.gold.na} bloquea n=${w.gold.nb}`);
      console.log(`     gold  media $${fmt(w.gold.ma).padStart(9)} vs $${fmt(w.gold.mb).padStart(9)} · sd $${fmt(w.gold.sa)}/$${fmt(w.gold.sb)} · t=${n2(w.gold.t)} p=${w.gold.p2.toFixed(3)}`);
      console.log(`     black media $${fmt(w.black.ma).padStart(9)} vs $${fmt(w.black.mb).padStart(9)} · t=${n2(w.black.t)} p=${w.black.p2.toFixed(3)}`);
      console.log(`     bruto/nocional ${pct(w.bruto.ma, 3)} vs ${pct(w.bruto.mb, 3)} · t=${n2(w.bruto.t)} p=${w.bruto.p2.toFixed(3)}`);
    }
  }

  /* ══════════════════ C) LOOKAHEAD EN LAS ETIQUETAS ══════════════════ */
  console.log(`\n===== C · LOOKAHEAD EN LAS ETIQUETAS DE RÉGIMEN =====`);
  out.C = {};

  // C.0 — ¿el rezago de 1 día está realmente aplicado?
  {
    let ok = 0, tot = 0, mal = 0;
    for (const s of senales) {
      const esp = FA.feat.get(s.dia), sinLag = F0.feat.get(s.dia);
      if (!esp) continue;
      tot++;
      if ((esp.vol == null ? null : esp.vol) === s.vol) ok++;
      if (sinLag && sinLag.vol != null && s.vol != null && Math.abs(sinLag.vol - s.vol) < 1e-9 && Math.abs((esp.vol ?? -1) - sinLag.vol) > 1e-9) mal++;
    }
    console.log(`  rezago de 1 rueda: la vol de la señal coincide con la de D-1 en ${ok}/${tot} señales (con la de D en ${mal})`);
    out.C.rezago = { ok, tot, mal };
  }

  // C.1 — el umbral: mediana del IS congelada (como está) vs expansiva PIT
  const variantesVol = {
    "vol20 baja (umbral del informe: mediana IS por señal)": (s) => s.vol != null && s.vol <= volMedIS,
    "vol20 baja (mediana IS por rueda)": (s) => s.vol != null && s.vol <= volMedISdia,
    "vol20 baja (mediana EXPANSIVA point-in-time)": (s) => {
      const u = volMedExp.get(s.dia);
      return u != null && s.vol != null && s.vol <= u;
    },
    "vol20 baja (mediana MÓVIL 252 ruedas, point-in-time)": (s) => {
      const u = volMed252.get(s.dia);
      return u != null && s.vol != null && s.vol <= u;
    },
    "vol20 baja (close crudo, sin adjclose)": (s) => {
      const f = FC.feat.get(s.dia);
      return !!(f && f.vol != null && f.vol <= volMedIS);
    },
  };
  out.C.variantes = {};
  const nuevasSR = [];
  for (const [vnm, cond] of Object.entries(variantesVol)) {
    out.C.variantes[vnm] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const ord = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, conj(gateBase, cond));
      const sim = simular(ord, ctx, ccl);
      const mg = metricas(sim, "gold", ctx.meses), mb = metricas(sim, "black", ctx.meses);
      out.C.variantes[vnm][vn] = {
        n: mg.n, nSenales: ord.length, mensualGold: mg.mensualPct, mensualBlack: mb.mensualPct,
        expGold: mg.expectancy, sharpeGold: mg.sharpe, srG: mg.srDiario, srB: mb.srDiario, ddGold: mg.maxDDpct,
      };
      if (vnm !== "vol20 baja (umbral del informe: mediana IS por señal)") nuevasSR.push({ nombre: `${vnm}/${vn}`, sr: mg.srDiario, srB: mb.srDiario, rets: mg.rets, retsB: mb.rets, shG: mg.sharpe, shB: mb.sharpe });
      console.log(`  ${(vnm + " / " + vn).padEnd(58)} señales ${String(ord.length).padStart(4)} trades ${String(mg.n).padStart(4)} mensual gold ${n2(mg.mensualPct).padStart(6)}% black ${n2(mb.mensualPct).padStart(6)}% exp/trade ${fmt(mg.expectancy).padStart(9)}`);
    }
  }

  // C.2 — el nulo del filtro SIN lookahead (mediana expansiva), sólo la celda clave
  console.log(`  --- nulos de las variantes point-in-time ---`);
  out.C.nuloPIT = {};
  for (const [pitN, condPIT, dcPIT] of [
    ["expansiva", variantesVol["vol20 baja (mediana EXPANSIVA point-in-time)"],
      (d) => { const f = FA.feat.get(d), u = volMedExp.get(d); return !!(f && f.vol != null && u != null && f.vol <= u); }],
    ["móvil 252", variantesVol["vol20 baja (mediana MÓVIL 252 ruedas, point-in-time)"],
      (d) => { const f = FA.feat.get(d), u = volMed252.get(d); return !!(f && f.vol != null && u != null && f.vol <= u); }],
  ]) {
    out.C.nuloPIT[pitN] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const padre = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase);
      const hijo = padre.filter(condPIT);
      const N = padre.length, K = hijo.length;
      const mr = metricas(simular(hijo, ctx, ccl), "gold", ctx.meses);
      const idx = [...Array(N).keys()];
      const n1 = [];
      for (let b = 0; b < DRAWS; b++) {
        const sel = sorteoK(idx, N, K, rnd).sort((a, b2) => a - b2).map((i) => padre[i]);
        n1.push(mensualLight(simular(sel, ctx, ccl, { light: true }), "gold", ctx.meses));
      }
      const dias = ctx.dias, mask = dias.map(dcPIT), offs = bloquesOff(mask);
      const largos = offs.map(([a, b]) => b - a + 1);
      const offSet = new Set(); for (const [a, b] of offs) for (let i = a; i <= b; i++) offSet.add(dias[i]);
      const mrd = metricas(simular(padre.filter((o) => !offSet.has(o.dia)), ctx, ccl), "gold", ctx.meses);
      const n2a = [];
      for (let b = 0; b < DRAWS; b++) {
        const col = colocarBloques(dias.length, largos, rnd);
        if (!col) continue;
        const off = new Set(); for (const [a, z] of col) for (let i = a; i <= z && i < dias.length; i++) off.add(dias[i]);
        n2a.push(mensualLight(simular(padre.filter((o) => !off.has(o.dia)), ctx, ccl, { light: true }), "gold", ctx.meses));
      }
      const u1 = ubicar(mr.mensualPct, n1), u2 = ubicar(mrd.mensualPct, n2a);
      out.C.nuloPIT[pitN][vn] = { N, K, nulo1: u1, nulo2: u2, bloques: offs.length, diasOff: largos.reduce((s, x) => s + x, 0), diasTot: dias.length };
      console.log(`    ${pitN}/${vn}: señales ${K}/${N} · nulo1 real ${n2(u1.real)}% pctil ${pct(u1.percentil)} p=${u1.p1cola.toFixed(4)} · nulo2 real ${n2(u2.real)}% pctil ${pct(u2.percentil)} p=${u2.p1cola.toFixed(4)}`);
    }
  }

  // C.3 — la perilla de exposición: el mensual contra el CUANTIL del umbral.
  // Si el mensual mejora monótonamente al apretar el umbral, sin importar
  // dónde se lo ponga, entonces lo que se está moviendo es la exposición.
  console.log(`  --- C.3 · el mensual contra el cuantil del umbral (perilla de exposición) ---`);
  out.C.barridoCuantil = {};
  for (const q of [0.25, 0.35, 0.50, 0.65, 0.75]) {
    const u = volQ(q);
    out.C.barridoCuantil[q] = { umbral: u };
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const ord = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, conj(gateBase, (s) => s.vol != null && s.vol <= u));
      const sim = simular(ord, ctx, ccl);
      const mg = metricas(sim, "gold", ctx.meses), mb = metricas(sim, "black", ctx.meses);
      out.C.barridoCuantil[q][vn] = { nSenales: ord.length, n: mg.n, gold: mg.mensualPct, black: mb.mensualPct, exp: mg.expectancy, dd: mg.maxDDpct };
      if (q !== 0.50) nuevasSR.push({ nombre: `vol20 baja q${q}/${vn}`, sr: mg.srDiario, srB: mb.srDiario, rets: mg.rets, retsB: mb.rets, shG: mg.sharpe, shB: mb.sharpe });
      console.log(`    q=${q} (umbral ${n2(u, 4)}) ${vn}: señales ${String(ord.length).padStart(4)} trades ${String(mg.n).padStart(4)} mensual gold ${n2(mg.mensualPct).padStart(6)}% black ${n2(mb.mensualPct).padStart(6)}% exp/trade ${fmt(mg.expectancy).padStart(9)} DD ${n2(mg.maxDDpct, 1)}%`);
    }
  }

  /* ══════════════════ D) FASE DEL APAGADO ══════════════════ */
  console.log(`\n===== D · FASE DEL APAGADO: ¿reenciende tarde? =====`);
  out.D = {};
  // series de referencia: SPY (lo que mira el filtro) y una canasta equiponderada
  // de los 38 (lo que el bot opera de verdad)
  const spyD = loadSeries(DATA, "daily", "SPY", { useAdj: true });
  const spyC = new Map(spyD.map((b) => [b.t, b.c]));
  const canasta = (() => {
    const porDia = new Map();
    for (const s of U38) {
      const d = all.daily[s]; if (!d) continue;
      for (let i = 1; i < d.length; i++) {
        if (!(d[i - 1].c > 0)) continue;
        const r = d[i].c / d[i - 1].c - 1;
        const a = porDia.get(d[i].t) || { s: 0, n: 0 };
        a.s += r; a.n++; porDia.set(d[i].t, a);
      }
    }
    const dias = [...porDia.keys()].sort();
    const m = new Map(); let idx = 100;
    for (const d of dias) { const a = porDia.get(d); idx *= 1 + a.s / a.n; m.set(d, idx); }
    return m;
  })();

  for (const [serieN, serie] of [["SPY", spyC], ["canasta 38", canasta]]) {
    out.D[serieN] = {};
    for (const vn of ["IS", "OOS"]) {
      const ctx = CTX[vn];
      const dias = ctx.dias.filter((d) => serie.has(d));
      const C = dias.map((d) => serie.get(d));
      const mask = dias.map((d) => dCond.volBaja(d));
      const offs = bloquesOff(mask);
      const det = [];
      for (const [a, b] of offs) {
        if (a === 0) continue;                    // bloque pegado al borde izquierdo
        const r = b + 1;
        if (r >= dias.length) continue;           // bloque censurado a la derecha
        let mi = a, mv = C[a];
        for (let i = a; i <= b; i++) if (C[i] < mv) { mv = C[i]; mi = i; }
        det.push({
          desde: dias[a], hasta: dias[b], largo: b - a + 1,
          pxApagado: C[a - 1], pxMin: mv, diaMin: dias[mi],
          caidaPct: mv / C[a - 1] - 1, barrasAlMin: mi - (a - 1),
          pxReenc: C[r], rebotePct: mv > 0 ? C[r] / mv - 1 : null, barrasDelMin: r - mi,
          capturaRebote: C[a - 1] > mv ? (C[r] - mv) / (C[a - 1] - mv) : null,
          fwd10: C[Math.min(r + 10, C.length - 1)] / C[r] - 1,
          fwd20: C[Math.min(r + 20, C.length - 1)] / C[r] - 1,
          a, b, r, mi,
        });
      }
      if (!det.length) { console.log(`  ${serieN}/${vn}: sin bloques evaluables`); continue; }

      // nulo: reencender en un punto uniformemente al azar dentro del bloque
      // (soporte {a..b+1}, que incluye la elección real b+1)
      const realF10 = mean(det.map((x) => x.fwd10)), realF20 = mean(det.map((x) => x.fwd20));
      const realBDM = mean(det.map((x) => x.barrasDelMin));
      const nF10 = [], nF20 = [], nBDM = [];
      for (let k = 0; k < DRAWS; k++) {
        let s10 = 0, s20 = 0, sb = 0;
        for (const x of det) {
          const rr = x.a + Math.floor(rnd() * (x.b - x.a + 2));
          s10 += C[Math.min(rr + 10, C.length - 1)] / C[rr] - 1;
          s20 += C[Math.min(rr + 20, C.length - 1)] / C[rr] - 1;
          sb += rr - x.mi;
        }
        nF10.push(s10 / det.length); nF20.push(s20 / det.length); nBDM.push(sb / det.length);
      }
      const u10 = ubicar(realF10, nF10), u20 = ubicar(realF20, nF20), ub = ubicar(realBDM, nBDM);
      out.D[serieN][vn] = {
        bloques: det.length,
        caidaMedia: mean(det.map((x) => x.caidaPct)), caidaMediana: det.map((x) => x.caidaPct).sort((a, b) => a - b)[Math.floor(det.length / 2)],
        barrasAlMinMedia: mean(det.map((x) => x.barrasAlMin)),
        reboteMedio: mean(det.map((x) => x.rebotePct)), barrasDelMinMedia: realBDM,
        capturaRebote: mean(det.filter((x) => x.capturaRebote != null).map((x) => x.capturaRebote)),
        fwd10: u10, fwd20: u20, barrasDelMinNulo: ub, det,
      };
      console.log(`  ${serieN}/${vn}: ${det.length} bloques apagados evaluables`);
      console.log(`     del apagado al mínimo: ${pct(mean(det.map((x) => x.caidaPct)), 2)} en ${n2(mean(det.map((x) => x.barrasAlMin)), 1)} ruedas · del mínimo al reencendido: ${pct(mean(det.map((x) => x.rebotePct)), 2)} en ${n2(realBDM, 1)} ruedas`);
      console.log(`     captura del rebote al reencender (0=mínimo, 1=precio del apagado): ${n2(out.D[serieN][vn].capturaRebote, 2)}`);
      console.log(`     retorno a 10 ruedas DESPUÉS del reencendido: real ${pct(realF10, 2)} vs nulo ${pct(u10.mediaNulo, 2)} · pctil ${pct(u10.percentil)} p=${u10.p1cola.toFixed(4)}`);
      console.log(`     retorno a 20 ruedas DESPUÉS del reencendido: real ${pct(realF20, 2)} vs nulo ${pct(u20.mediaNulo, 2)} · pctil ${pct(u20.percentil)} p=${u20.p1cola.toFixed(4)}`);
      console.log(`     ruedas desde el mínimo hasta reencender: real ${n2(realBDM, 1)} vs nulo ${n2(ub.mediaNulo, 1)} (pctil ${pct(ub.percentil)})`);
    }
  }

  /* ══════════════════ DSR con el N actualizado ══════════════════ */
  console.log(`\n===== DSR · N actualizado =====`);
  const srsG = [], srsB = [];
  for (const k of Object.keys(prev.corridas)) {
    if (prev.corridas[k]._sr != null) srsG.push(prev.corridas[k]._sr);
    if (prev.corridas[k]._srB != null) srsB.push(prev.corridas[k]._srB);
  }
  // las 50 celdas del barrido (results.json guardó sólo el Sharpe gold)
  const mults = [0.7, 0.85, 1, 1.15, 1.3];
  let chkSweep = 0;
  for (const vn of ["IS", "OOS"]) {
    const ctx = CTX[vn];
    for (const sm of mults) for (const tm of mults) {
      const ord = construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gateBase, sm, tm);
      const s = simular(ord, ctx, ccl);
      const mg = metricas(s, "gold", ctx.meses), mb = metricas(s, "black", ctx.meses);
      srsG.push(mg.srDiario); srsB.push(mb.srDiario);
      const ref = prev.sweep[`${vn}/s${sm}/t${tm}`];
      if (ref && Math.abs(ref.sharpe - mg.sharpe) < 1e-9) chkSweep++;
    }
  }
  // las 8 de INFORME-RECOMPRA
  const NUEVAS_RC = ["rc-entrada", "rc-entrada-stop", "rc-entrada/stop-gana", "rc-entrada-stop/stop-gana"];
  for (const vn of ["IS", "OOS"]) for (const rn of NUEVAS_RC) {
    const v = prevRc.B[vn][rn];
    if (v && v._sr != null) srsG.push(v._sr);
    if (v && v._srB != null) srsB.push(v._srB);
  }
  const nPrev = srsG.length;
  const sigPrevG = stdev(srsG), sigPrevB = stdev(srsB);
  console.log(`  reconstrucción del N anterior: ${nPrev} (informe: ${prevRc.dsr.N}) · sigma gold ${sigPrevG.toExponential(4)} (informe ${prevRc.dsr.sigmaSR.toExponential(4)}) · black ${sigPrevB.toExponential(4)} (informe ${prevRc.dsr.sigmaSRblack.toExponential(4)}) · sweep ${chkSweep}/50`);

  for (const v of nuevasSR) { srsG.push(v.sr); if (v.srB != null) srsB.push(v.srB); }
  const N = nPrev + nuevasSR.length;
  const sigG = stdev(srsG), sigB = stdev(srsB);
  console.log(`  N ${nPrev} → ${N} (+${nuevasSR.length} variantes nuevas de este informe) · sigma gold ${sigG.toExponential(4)} · black ${sigB.toExponential(4)}`);
  out.dsr = { Nprevio: nPrev, N, sigmaSR: sigG, sigmaSRblack: sigB, chequeoSweep: chkSweep, filas: {} };

  const filasDsr = [];
  for (const vn of ["IS", "OOS"]) {
    for (const [nm, gt] of [["base", gateBase], ["base + vol20 baja", conj(gateBase, cVolBaja)]]) {
      const ctx = CTX[vn];
      const sim = simular(construirOrdenes(senales, U38, ctx.desde, ctx.hasta, gt), ctx, ccl);
      const mg = metricas(sim, "gold", ctx.meses), mb = metricas(sim, "black", ctx.meses);
      filasDsr.push({ nombre: `${nm}/${vn}`, shG: mg.sharpe, shB: mb.sharpe, rets: mg.rets, retsB: mb.rets, sr: mg.srDiario, srB: mb.srDiario });
    }
  }
  for (const v of nuevasSR) filasDsr.push(v);
  for (const f of filasDsr) {
    const dG = dsr(f.rets, f.sr, sigG, N), dB = dsr(f.retsB ?? f.rets, f.srB ?? f.sr, sigB, N);
    out.dsr.filas[f.nombre] = {
      sharpeGold: f.shG, dsrGold: dG ? dG.dsr : null,
      sharpeBlack: f.shB, dsrBlack: dB ? dB.dsr : null,
    };
    console.log(`  ${f.nombre.padEnd(56)} gold SR ${n2(f.shG).padStart(6)} DSR ${dG ? dG.dsr.toFixed(5) : "-"} · black SR ${n2(f.shB).padStart(6)} DSR ${dB ? dB.dsr.toFixed(5) : "-"}`);
  }

  fs.writeFileSync(path.join(DIR, "results-nulo.json"), JSON.stringify(out, null, 1));
  console.log(`\nresults-nulo.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
