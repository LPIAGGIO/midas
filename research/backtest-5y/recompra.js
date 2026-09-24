/* recompra.js — ¿conviene recomprar la mitad vendida en el TP parcial?
 *
 * Tres bloques, en este orden:
 *   A) medición descriptiva: para cada trade que llegó al TP parcial, ¿el
 *      precio volvió al nivel de entrada antes de resolverse? ¿y cómo terminó?
 *   B) simulación de la regla de recompra (2 variantes de nivel) contra el base.
 *   C) el costo de oportunidad: ¿el saldo liberado por el TP parcial tenía uso?
 *
 * Reusa engine.js y el cache signals.json que genera simulate.js. Todo local:
 * no toca VPS, Supabase ni nada vivo. ESM.
 *
 *   node recompra.js --solo-is    → sólo in-sample (para definir A, B y C)
 *   node recompra.js              → IS + OOS, escribe results-recompra.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatePasa, loadSeries, loadCcl } from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = new Set(process.argv.slice(2));
const SOLO_IS = ARGS.has("--solo-is");

/* ── constantes: IDÉNTICAS a simulate.js (no tocar) ── */
const CAPITAL = 7_000_000;
const RISK = 0.015;
const MAX_POS = 5;
const MAX_DIA = 5;
const CAP_PCT = 0.20;
const VENTANA_H = 48;
const TP_FRAC = 0.5;
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;                 // 0,0605% — segunda pata intradía
const FEE = {
  gold: 0.005 * IVA + DERECHOS,                // 0,6655%
  platinum: 0.003 * IVA + DERECHOS,            // 0,4235%
  black: 0.001 * IVA + DERECHOS,               // 0,1815%
};
const TIERS = ["gold", "platinum", "black"];

const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";

const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];

const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/* ─────────────────────────── carga ─────────────────────────── */
function cargarHourly() {
  const syms = fs.readdirSync(path.join(DATA, "hourly"))
    .filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  const hourly = {};
  for (const s of syms) { const h = loadSeries(DATA, "hourly", s); if (h) hourly[s] = h; }
  return hourly;
}

function cargarSenales() {
  const f = path.join(DIR, "signals.json");
  if (!fs.existsSync(f)) throw new Error("falta signals.json — correr antes: node simulate.js");
  return JSON.parse(fs.readFileSync(f, "utf8")).senales;
}

/* ───────────────────────── simulador ─────────────────────────
 * Copia de simular() de simulate.js con dos cambios:
 *   1. la posición pasa a tener LOTES (la original y, si hay, la recomprada),
 *      porque cada lote tiene su propio precio y su propia fecha de entrada
 *      (de ahí sale la bonificación intradía de la segunda pata);
 *   2. instrumentación: para cada trade con TP parcial se registra si el precio
 *      volvió al nivel de entrada (y al nivel entrada-stop), cuándo, y cómo
 *      terminó el trade.
 * Con recompra = null el resultado es numéricamente idéntico al base. */
function simular(senales, bars, ccl, opts) {
  const {
    universo, desde, hasta, filtro, recompra = null, // null | "entry" | "mid"
    rcOrden = "pre",   // "pre": la recompra se llena ANTES de juzgar el stop de
                       // la misma barra (realista: para llegar al stop el precio
                       // tuvo que cruzar el límite). "post": el stop gana.
    stopMult = 1, tgtMult = 1, exitMode = "intrabar", capPct = CAP_PCT, label = "",
  } = opts;
  const rArs = (d) => ccl(d) || 1;

  const usados = new Set();
  const ordenes = [];
  for (const s of senales) {
    if (!universo.has(s.sym)) continue;
    if (s.dia < desde || s.dia > hasta) continue;
    const f = filtro(s);
    if (!f) continue;
    const R = s.entry - s.stop, T = s.target - s.entry;
    ordenes.push({
      ...s, riskMult: f.riskMult ?? 1,
      stop: s.entry - R * stopMult, target: s.entry + T * tgtMult,
      created: s.ts * 1000 + 1,
    });
    usados.add(s.sym);
  }
  ordenes.sort((a, b) => a.created - b.created);

  const tsSet = new Set();
  const barAt = {};
  for (const s of usados) {
    if (!bars[s]) continue;
    barAt[s] = new Map();
    for (const b of bars[s]) {
      if (b.t < desde || b.t > hasta) continue;
      tsSet.add(b.ts * 1000); barAt[s].set(b.ts * 1000, b);
    }
  }
  const timeline = [...tsSet].sort((a, b) => a - b);
  const tFin = timeline.length ? timeline[timeline.length - 1] : 0;

  const pend = new Map(), open = new Map();
  const trades = [], legs = [];
  const skips = { openSym: 0, dupPend: 0, posMax: 0, entradasDia: 0, qtyCero: 0, reemplazadas: 0, expiradas: 0, sinFill: 0, sinBarras: 0 };
  // instrumentación del bloque C
  const skipsDet = [];        // cada skip por posMax/caja, con el estado de la cartera
  const cajaApretada = [];    // órdenes donde la restricción de caja recortó el tamaño
  const entradasDia = new Map();
  const realized = Object.fromEntries(TIERS.map((t) => [t, 0]));
  const equity = [];
  let oi = 0;
  let nRecompras = 0;

  const qtyDe = (pos) => pos.lots.reduce((s, l) => s + l.qty, 0);
  const notionalDe = (pos) => {
    let s = pos.lots.reduce((a, l) => a + l.qty * l.entryPx * l.rIn, 0);
    if (pos.rcViva) s += pos.rcQty * pos.rcLevel * pos.rIn;   // la orden límite reserva caja
    return s;
  };
  const comprometido = () => {
    let s = 0;
    for (const p of pend.values()) s += p.notional;
    for (const p of open.values()) s += notionalDe(p);
    return s;
  };
  const conTpAbierto = () => {
    let n = 0;
    for (const p of open.values()) if (p.tpDone) n++;
    return n;
  };
  const feeLeg = (n, tier, bonif) => n * (bonif ? DERECHOS : FEE[tier]);

  const cerrarLote = (pos, lot, qty, px, ts, reason, tag) => {
    const d = dia(ts / 1000);
    const rOut = rArs(d);
    const intradia = dia(lot.entryTs / 1000) === d;   // bonificación por lote
    const entN = qty * lot.entryPx * lot.rIn;
    const outN = qty * px * rOut;
    const leg = {
      sym: pos.sym, qty, reason, tag, entryTs: lot.entryTs, exitTs: ts,
      entryPx: lot.entryPx, exitPx: px, entN, bruto: outN - entN,
      brutoSinCcl: qty * (px - lot.entryPx) * lot.rIn,
      pnl: {}, fees: {},
    };
    for (const tier of TIERS) {
      const f = feeLeg(entN, tier, false) + feeLeg(outN, tier, intradia);
      leg.fees[tier] = f;
      leg.pnl[tier] = outN - entN - f;
      realized[tier] += leg.pnl[tier];
    }
    lot.qty -= qty;
    legs.push(leg); pos.legs.push(leg);
  };
  const cerrarTodo = (pos, px, ts, reason) => {
    for (const lot of pos.lots) if (lot.qty > 0) cerrarLote(pos, lot, lot.qty, px, ts, reason, lot.tag);
    pos.salidaFinal = reason;
    pos.exitTs = ts;
  };

  for (const t of timeline) {
    // 1) llegan señales
    while (oi < ordenes.length && ordenes[oi].created <= t) {
      const o = ordenes[oi++];
      if (!barAt[o.sym]) { skips.sinBarras++; continue; }
      if (open.has(o.sym)) { skips.openSym++; continue; }
      const prev = pend.get(o.sym);
      if (prev && Math.abs(prev.entry - o.entry) / o.entry < 0.005) { skips.dupPend++; continue; }
      if (prev) { pend.delete(o.sym); skips.reemplazadas++; }
      if (pend.size + open.size >= MAX_POS) {
        skips.posMax++;
        skipsDet.push({
          motivo: "posMax", sym: o.sym, dia: dia(o.created / 1000), ts: o.created,
          score: o.score, rr: o.rr, conTp: conTpAbierto(),
          libre: CAPITAL - comprometido(),
        });
        continue;
      }
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) { skips.entradasDia++; continue; }
      const rIn = rArs(d);
      const riesgoU = (o.entry - o.stop) * rIn;
      if (!(riesgoU > 0)) { skips.qtyCero++; continue; }
      const qRiesgo = (CAPITAL * RISK * o.riskMult) / riesgoU;
      const qTope = (CAPITAL * capPct) / (o.entry * rIn);
      const qCaja = Math.max(0, CAPITAL - comprometido()) / (o.entry * rIn);
      let qty = Math.min(qRiesgo, qTope, qCaja);
      if (!(qty > 0)) {
        skips.qtyCero++;
        skipsDet.push({ motivo: "sinCaja", sym: o.sym, dia: d, ts: o.created, score: o.score, rr: o.rr, conTp: conTpAbierto(), libre: CAPITAL - comprometido() });
        continue;
      }
      if (qCaja < Math.min(qRiesgo, qTope) - 1e-9) {
        cajaApretada.push({ sym: o.sym, dia: d, recorte: 1 - qCaja / Math.min(qRiesgo, qTope), conTp: conTpAbierto() });
      }
      entradasDia.set(d, (entradasDia.get(d) || 0) + 1);
      pend.set(o.sym, { ...o, qty, rIn, notional: qty * o.entry * rIn });
    }

    // 2) pendientes: expiración y fill
    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); skips.expiradas++; continue; }
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
          rcViva: false, rcLevel: null, rcQty: 0, rcCreated: null, rcFillTs: null, rcFillPx: null,
          volvioEntrada: null, volvioMid: null, barrasPostTp: 0, minPostTp: Infinity,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }

    // 3) abiertas: stop → recompra → TP parcial → target → trailing
    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs) continue;   // la barra del fill no se juzga de nuevo
      const hi = exitMode === "close" ? b.c : b.h;
      const lo = exitMode === "close" ? b.c : b.l;

      // instrumentación (bloque A): ¿volvió al nivel de entrada después del TP?
      if (pos.tpDone && t > pos.tpTs) {
        pos.barrasPostTp++;
        pos.minPostTp = Math.min(pos.minPostTp, b.l);
        if (pos.volvioEntrada == null && b.l <= pos.entryPx) {
          pos.volvioEntrada = { ts: t, barras: pos.barrasPostTp, horas: (t - pos.tpTs) / 3600000 };
        }
        if (pos.volvioMid == null && b.l <= pos.midStop) {
          pos.volvioMid = { ts: t, barras: pos.barrasPostTp, horas: (t - pos.tpTs) / 3600000 };
        }
      }

      // recompra: orden límite viva desde la barra SIGUIENTE al TP parcial
      // (mismo anti-lookahead que las entradas) hasta que el trade se cierre.
      const fillRc = () => {
        if (!(pos.rcViva && t > pos.rcCreated && lo <= pos.rcLevel)) return;
        const rIn = rArs(dia(t / 1000));
        pos.lots.push({ qty: pos.rcQty, entryPx: pos.rcLevel, entryTs: t, rIn, tag: "rc" });
        pos.rcViva = false; pos.rcFillTs = t; pos.rcFillPx = pos.rcLevel;
        nRecompras++;
      };
      if (rcOrden === "pre") fillRc();

      // stop (pesimista: si la barra tocó las dos puntas, gana el stop)
      if (lo <= pos.stop) {
        pos.rcViva = false;
        cerrarTodo(pos, pos.stop, t, pos.stop > pos.stopIni ? "trailing" : "stop");
        open.delete(sym); continue;
      }

      if (rcOrden === "post") fillRc();

      // TP parcial a mitad de camino
      if (TP_FRAC > 0 && !pos.tpDone) {
        const nivel = pos.entryPx + TP_FRAC * (pos.target - pos.entryPx);
        if (hi >= nivel) {
          const q = pos.qtyOrig / 2;
          cerrarLote(pos, pos.lots[0], q, Math.min(nivel, pos.target), t, "tp_parcial", "orig");
          pos.tpDone = true; pos.tpTs = t; pos.tpQty = q;
          if (recompra) {
            pos.rcViva = true; pos.rcQty = q; pos.rcCreated = t;
            pos.rcLevel = recompra === "entry" ? pos.entryPx : pos.midStop;
          }
        }
      }
      if (hi >= pos.target) {
        pos.rcViva = false;
        cerrarTodo(pos, pos.target, t, "target");
        open.delete(sym); continue;
      }
      // trailing desde +2R, nunca baja
      const k = Math.floor((hi - pos.entryPx) / pos.R);
      if (k >= 2 && pos.entryPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (k - 2) * pos.R;
    }

    // 4) equity diaria
    const d = dia(t / 1000);
    let unreal = 0;
    for (const [sym, pos] of open) {
      const b = barAt[sym].get(t);
      for (const lot of pos.lots) if (lot.qty > 0) unreal += lot.qty * ((b ? b.c : lot.entryPx) - lot.entryPx) * lot.rIn;
    }
    const row = { dia: d, comp: comprometido(), eq: {} };
    for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
    if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row;
    else equity.push(row);
  }

  skips.sinFill += pend.size;
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || bars[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    pos.rcViva = false;
    cerrarTodo(pos, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (equity.length) {
    const last = equity[equity.length - 1];
    for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier];
  }

  return { label, opts: { desde, hasta, recompra }, trades, legs, skips, skipsDet, cajaApretada, equity, nSenales: ordenes.length, nRecompras };
}

/* ─────────────────────────── métricas (copiadas) ─────────────────────── */
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
function metricas(sim, tier) {
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
  const d0 = sim.equity.length ? sim.equity[0].dia : null, d1 = sim.equity.length ? sim.equity[sim.equity.length - 1].dia : null;
  const meses = d0 && d1 ? (new Date(d1) - new Date(d0)) / (365.25 / 12 * 86400000) : 1;
  const notional = sim.legs.reduce((s, l) => s + l.entN, 0);
  const fees = sim.legs.reduce((s, l) => s + l.fees[tier], 0);
  const rc = sim.legs.filter((l) => l.tag === "rc");
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, notional, fees,
    nRecompras: rc.length,
    pnlRecompra: rc.reduce((s, l) => s + l.pnl[tier], 0),
    feesRecompra: rc.reduce((s, l) => s + l.fees[tier], 0),
    brutoRecompra: rc.reduce((s, l) => s + l.bruto, 0),
    notionalRecompra: rc.reduce((s, l) => s + l.entN, 0),
    brutoPctRecompra: rc.length ? rc.reduce((s, l) => s + l.bruto, 0) / rc.reduce((s, l) => s + l.entN, 0) : null,
    costoPctRecompra: rc.length ? rc.reduce((s, l) => s + l.fees[tier], 0) / rc.reduce((s, l) => s + l.entN, 0) : null,
    rcSalidas: rc.reduce((a, l) => { a[l.reason] = (a[l.reason] || 0) + 1; return a; }, {}),
    rcGanadoras: rc.filter((l) => l.pnl[tier] > 0).length,
    expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    sharpe, maxDDpct: dd * 100, meses,
    srDiario: sd > 0 ? m / sd : null, rets,
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

/* ───────────────────── A: tabla cruzada descriptiva ───────────────────── */
function bloqueA(sim, etiqueta) {
  const conTp = sim.trades.filter((t) => t.tpDone);
  const celdas = {};   // "si|target" → {n, gold, black, horas[]}
  const push = (k, tr) => {
    const c = celdas[k] = celdas[k] || { n: 0, gold: 0, black: 0, horas: [], barras: [] };
    c.n++;
    c.gold += tr.legs.reduce((s, l) => s + l.pnl.gold, 0);
    c.black += tr.legs.reduce((s, l) => s + l.pnl.black, 0);
  };
  const horasVolvio = [], barrasVolvio = [];
  for (const tr of conTp) {
    const volvio = tr.volvioEntrada ? "si" : "no";
    push(`${volvio}|${tr.salidaFinal}`, tr);
    if (tr.volvioEntrada) { horasVolvio.push(tr.volvioEntrada.horas); barrasVolvio.push(tr.volvioEntrada.barras); }
  }
  const nVolvio = conTp.filter((t) => t.volvioEntrada).length;
  const nMid = conTp.filter((t) => t.volvioMid).length;
  // el retroceso y la muerte del trade en la MISMA barra horaria: ahí la
  // recompra se llena y el stop la liquida acto seguido
  const nMismaBarra = conTp.filter((t) => t.volvioEntrada && t.volvioEntrada.ts === t.exitTs).length;
  const sort = (a) => [...a].sort((x, y) => x - y);
  const med = (a) => (a.length ? sort(a)[Math.floor(a.length / 2)] : null);
  return {
    etiqueta, nConTp: conTp.length, nVolvioEntrada: nVolvio, nVolvioMid: nMid, nMismaBarra,
    horasMedianaVolvio: med(horasVolvio), barrasMedianaVolvio: med(barrasVolvio),
    horasP90Volvio: horasVolvio.length ? sort(horasVolvio)[Math.floor(horasVolvio.length * 0.9)] : null,
    celdas,
    trades: conTp.map((t) => ({
      sym: t.sym, dia: t.dia, salida: t.salidaFinal,
      volvio: !!t.volvioEntrada, volvioMid: !!t.volvioMid,
      horas: t.volvioEntrada ? t.volvioEntrada.horas : null,
      barras: t.volvioEntrada ? t.volvioEntrada.barras : null,
      gold: Math.round(t.legs.reduce((s, l) => s + l.pnl.gold, 0)),
      black: Math.round(t.legs.reduce((s, l) => s + l.pnl.black, 0)),
    })),
  };
}

/* ───────────────────── C: ¿el saldo liberado tenía uso? ───────────────── */
function bloqueC(sim) {
  const posMax = sim.skipsDet.filter((s) => s.motivo === "posMax");
  const sinCaja = sim.skipsDet.filter((s) => s.motivo === "sinCaja");
  const conTp = posMax.filter((s) => s.conTp > 0);
  // fill rate: de las órdenes que llegaron a colocarse, cuántas se llenaron
  const colocadas = sim.trades.length + sim.skips.expiradas + sim.skips.sinFill;
  return {
    posMax: posMax.length, posMaxConTpAbierto: conTp.length,
    sinCaja: sinCaja.length, sinCajaConTpAbierto: sinCaja.filter((s) => s.conTp > 0).length,
    cajaApretada: sim.cajaApretada.length,
    cajaApretadaConTp: sim.cajaApretada.filter((c) => c.conTp > 0).length,
    recorteMedio: sim.cajaApretada.length ? mean(sim.cajaApretada.map((c) => c.recorte)) : null,
    colocadas, fillRate: colocadas ? sim.trades.length / colocadas : null,
    detalle: conTp.map((s) => ({ sym: s.sym, dia: s.dia, score: s.score, conTp: s.conTp, libre: Math.round(s.libre) })),
  };
}

/* ───────────────────────────── main ───────────────────────────── */
const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pct = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : n.toFixed(d));

function main() {
  const t0 = Date.now();
  const hourly = cargarHourly();
  const senales = cargarSenales();
  const ccl = loadCcl(DATA);
  const U38 = new Set(LIMPIOS_38.filter((s) => hourly[s]));
  console.log(`señales ${senales.length} · universo ${U38.size}`);

  const gateBase = (s) => {
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };

  const VENTANAS = SOLO_IS
    ? [["IS", [IS_DESDE, IS_HASTA]]]
    : [["IS", [IS_DESDE, IS_HASTA]], ["OOS", [OOS_DESDE, OOS_HASTA]]];
  const VARIANTES = [
    ["base", null, "pre"],
    ["rc-entrada", "entry", "pre"],
    ["rc-entrada-stop", "mid", "pre"],
    ["rc-entrada/stop-gana", "entry", "post"],
    ["rc-entrada-stop/stop-gana", "mid", "post"],
  ];
  const NUEVAS = VARIANTES.slice(1).map(([rn]) => rn);   // las que suman al N del DSR

  const out = { generado: new Date().toISOString(), A: {}, B: {}, C: {}, dsr: {} };
  const sims = {};

  for (const [vn, [desde, hasta]] of VENTANAS) {
    for (const [rn, rc, ord] of VARIANTES) {
      const sim = simular(senales, hourly, ccl, { universo: U38, desde, hasta, filtro: gateBase, recompra: rc, rcOrden: ord, label: `${rn}/${vn}` });
      sims[`${rn}/${vn}`] = sim;
    }
  }

  /* ── A ── */
  console.log(`\n===== A · ¿vuelve al nivel de entrada después del TP parcial? =====`);
  for (const [vn] of VENTANAS) {
    const a = bloqueA(sims[`base/${vn}`], vn);
    out.A[vn] = a;
    console.log(`[${vn}] trades con TP parcial: ${a.nConTp} · volvieron a la ENTRADA: ${a.nVolvioEntrada} (${pct(a.nVolvioEntrada / a.nConTp)}) · llegaron al nivel entrada-stop: ${a.nVolvioMid} (${pct(a.nVolvioMid / a.nConTp)}) · de los que volvieron, murieron en la MISMA barra del retroceso: ${a.nMismaBarra}`);
    console.log(`     mediana hasta el retroceso: ${n2(a.horasMedianaVolvio, 1)} h corridas / ${a.barrasMedianaVolvio} barras · p90 ${n2(a.horasP90Volvio, 1)} h`);
    const desen = ["target", "trailing", "stop", "fin_ventana"];
    console.log(`     ${"volvió".padEnd(8)}` + desen.map((d) => d.padStart(14)).join("") + "         total");
    for (const v of ["si", "no"]) {
      let tn = 0, tg = 0;
      const fila = desen.map((d) => {
        const c = a.celdas[`${v}|${d}`];
        if (!c) return "-".padStart(14);
        tn += c.n; tg += c.gold;
        return `${c.n} / ${fmt(c.gold / c.n)}`.padStart(14);
      });
      console.log(`     ${v.padEnd(8)}` + fila.join("") + `   ${String(tn).padStart(4)} / ${fmt(tg / (tn || 1)).padStart(9)}`);
    }
    console.log(`     (celda = n / P&L gold promedio por trade)`);
  }

  /* ── B ── */
  console.log(`\n===== B · la regla de recompra =====`);
  for (const [vn] of VENTANAS) {
    console.log(`--- ${vn} ---`);
    const base = sims[`base/${vn}`];
    const mBase = Object.fromEntries(TIERS.map((t) => [t, metricas(base, t)]));
    out.B[vn] = {};
    for (const [rn, , ord] of VARIANTES) {
      const sim = sims[`${rn}/${vn}`];
      const m = Object.fromEntries(TIERS.map((t) => [t, { ...metricas(sim, t), rets: undefined }]));
      const mm = Object.fromEntries(TIERS.map((t) => [t, metricas(sim, t)]));
      out.B[vn][rn] = {
        rcOrden: ord, nRecompras: sim.nRecompras, nTrades: sim.trades.length, nSenales: sim.nSenales,
        skips: sim.skips,
        metricas: m,
        delta: Object.fromEntries(TIERS.map((t) => [t, mm[t].total - mBase[t].total])),
        _rets: mm.gold.rets, _sr: mm.gold.srDiario, _retsB: mm.black.rets, _srB: mm.black.srDiario,
      };
      const g0 = mm.gold;
      console.log(` ${rn.padEnd(26)} recompras=${String(sim.nRecompras).padStart(3)} trades=${sim.trades.length} · salidas de la mitad recomprada ${JSON.stringify(g0.rcSalidas)} · bruto de la recompra ${pct(g0.brutoPctRecompra, 3)} del nocional (nocional $${fmt(g0.notionalRecompra)})`);
      for (const t of TIERS) {
        const x = mm[t];
        console.log(`   ${t.padEnd(9)} mensual ${n2(x.mensualPct).padStart(6)}% · P&L $${fmt(x.total).padStart(11)} · win ${pct(x.winRate).padStart(6)} · payoff ${n2(x.payoff).padStart(5)} · Sharpe ${n2(x.sharpe).padStart(6)} · maxDD ${n2(x.maxDDpct).padStart(5)}% · Δ vs base $${fmt(x.total - mBase[t].total).padStart(10)} · P&L de la recompra sola $${fmt(x.pnlRecompra).padStart(10)} (comisiones $${fmt(x.feesRecompra)})`);
      }
    }
  }

  /* ── C ── */
  console.log(`\n===== C · ¿el saldo liberado tenía uso alternativo? =====`);
  for (const [vn] of VENTANAS) {
    const base = sims[`base/${vn}`];
    const c = bloqueC(base);
    const exp = metricas(base, "gold").expectancy;
    const expB = metricas(base, "black").expectancy;
    c.expectancyGold = exp; c.expectancyBlack = expB;
    c.pnlEstimadoGold = c.posMaxConTpAbierto * c.fillRate * exp;
    c.pnlEstimadoBlack = c.posMaxConTpAbierto * c.fillRate * expB;
    out.C[vn] = c;
    console.log(`[${vn}] skips por posMax: ${c.posMax} · de esos, con al menos una posición con TP parcial ya ejecutado: ${c.posMaxConTpAbierto}`);
    console.log(`     skips por falta de caja: ${c.sinCaja} · órdenes cuyo tamaño recortó la caja: ${c.cajaApretada} (de esas, con TP parcial abierto: ${c.cajaApretadaConTp}; recorte medio ${pct(c.recorteMedio)})`);
    console.log(`     fill rate de las órdenes colocadas: ${pct(c.fillRate)} (${base.trades.length}/${c.colocadas}) · expectancy gold $${fmt(exp)} / black $${fmt(expB)}`);
    console.log(`     P&L estimado de las señales recuperables: gold $${fmt(c.pnlEstimadoGold)} · black $${fmt(c.pnlEstimadoBlack)}`);
    if (c.detalle.length) console.log(`     detalle: ${JSON.stringify(c.detalle)}`);
  }

  /* ── DSR con el N actualizado ── */
  if (!SOLO_IS) {
    const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results.json"), "utf8"));
    const srsG = [], srsB = [];
    for (const k of Object.keys(prev.corridas)) {
      if (prev.corridas[k]._sr != null) srsG.push(prev.corridas[k]._sr);
      if (prev.corridas[k]._srB != null) srsB.push(prev.corridas[k]._srB);
    }
    // results.json guarda del barrido sólo el Sharpe gold, así que las 50
    // celdas se vuelven a correr acá para recuperar también su SR en black
    // (si no, sigma(SR) de black sale calculado sobre 26 variantes y no 76).
    const mults = [0.7, 0.85, 1, 1.15, 1.3];
    let chkSweep = 0;
    for (const [vn, [d0, d1]] of [["IS", [IS_DESDE, IS_HASTA]], ["OOS", [OOS_DESDE, OOS_HASTA]]]) {
      for (const sm of mults) for (const tm of mults) {
        const s = simular(senales, hourly, ccl, { universo: U38, desde: d0, hasta: d1, filtro: gateBase, stopMult: sm, tgtMult: tm });
        const mg = metricas(s, "gold"), mb = metricas(s, "black");
        srsG.push(mg.srDiario); srsB.push(mb.srDiario);
        const ref = prev.sweep[`${vn}/s${sm}/t${tm}`];
        if (ref && Math.abs(ref.sharpe - mg.sharpe) < 1e-9) chkSweep++;
      }
    }
    console.log(`\n[chequeo] el barrido reconstruido coincide con results.json en ${chkSweep}/50 celdas`);
    const nPrev = srsG.length;
    // las 4 variantes nuevas (2 niveles de recompra × 2 ventanas)
    const nuevas = [];
    for (const vn of ["IS", "OOS"]) for (const rn of NUEVAS) nuevas.push(out.B[vn][rn]);
    for (const v of nuevas) { srsG.push(v._sr); if (v._srB != null) srsB.push(v._srB); }
    const N = nPrev + nuevas.length;
    const sigG = stdev(srsG), sigB = stdev(srsB);
    console.log(`\n===== DSR · N ${nPrev} → ${N} · sigma(SR diario) gold ${sigG.toExponential(3)} (informe: ${prev.dsr["38/base/IS"].sigmaSR.toExponential(3)}) · black ${sigB.toExponential(3)} (informe: ${prev.dsr["38/base/IS (black)"].sigmaSR.toExponential(3)}) =====`);
    out.dsr.N = N; out.dsr.Nprevio = nPrev; out.dsr.sigmaSR = sigG; out.dsr.sigmaSRblack = sigB;
    out.dsr.chequeoSweep = chkSweep;
    for (const vn of ["IS", "OOS"]) for (const [rn] of VARIANTES) {
      const v = out.B[vn][rn];
      const dG = dsr(v._rets, v._sr, sigG, N), dB = dsr(v._retsB, v._srB, sigB, N);
      out.dsr[`${rn}/${vn}/gold`] = dG ? { ...dG, sharpeAnual: v.metricas.gold.sharpe } : null;
      out.dsr[`${rn}/${vn}/black`] = dB ? { ...dB, sharpeAnual: v.metricas.black.sharpe } : null;
      console.log(`  ${(rn + "/" + vn).padEnd(32)} gold SR ${n2(v.metricas.gold.sharpe).padStart(6)} DSR ${dG ? dG.dsr.toFixed(5) : "-"} · black SR ${n2(v.metricas.black.sharpe).padStart(6)} DSR ${dB ? dB.dsr.toFixed(5) : "-"}`);
    }
    for (const vn of ["IS", "OOS"]) for (const [rn] of VARIANTES) {
      delete out.B[vn][rn]._rets; delete out.B[vn][rn]._retsB;
    }
    fs.writeFileSync(path.join(DIR, "results-recompra.json"), JSON.stringify(out, null, 1));
    console.log(`\nresults-recompra.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.log(`\n[--solo-is] no se escribió nada y no se miró el OOS · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

main();
