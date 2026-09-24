/* simulate.js — backtest histórico del motor del bot niveles-auto sobre las
 * series bajadas en data/ (ver INVENTARIO.md). TODO local: no toca VPS,
 * Supabase ni ningún sistema vivo. ESM.
 *
 * Uso:
 *   node simulate.js              → corre todo y escribe results.json
 *   node simulate.js --coincidencia → sólo el chequeo del port contra las
 *                                     señales reales de los últimos 60 días
 *   node simulate.js --resenales   → fuerza regenerar el cache de señales
 *
 * Flujo:
 *   1. genera el flujo CRUDO de señales (todo soporte con stop y target
 *      válidos, sin filtrar) recorriendo las barras horarias ticker por
 *      ticker con el motor portado (engine.js). Se cachea en signals.json.
 *   2. sobre ese flujo aplica gates (el del worker y las variantes de
 *      régimen) y simula la cartera con las reglas de ejecución del worker.
 *   3. métricas por tier de comisión, walk-forward IS/OOS, barrido de
 *      robustez y Deflated Sharpe.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LB, allPivots, buildDailyCtx, analyzeKit, gatePasa, regimenDe,
  loadSeries, loadCcl, emaOf, emaStep, analyzeAsOf,
} from "./engine.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(DIR, "data");
const ARGS = new Set(process.argv.slice(2));
// RANKING: con que criterio se reparte el cupo cuando compiten varias senales.
// "" = orden de llegada (lo que hace el worker hoy). El resto son las variantes
// a medir. "azar" es el CONTROL: si rinde igual que las demas, el criterio no
// importa y hay que quedarse con el mas simple.
const RANKING = process.env.RANKING || "";
let _sem = Number(process.env.SEMILLA || 12345);   // azar reproducible
const rnd = () => ((_sem = (_sem * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const CRITERIO = {
  holgura: (a, b) => (b.holgura - a.holgura) || (b.rr - a.rr) || (b.score - a.score),
  rr:      (a, b) => (b.rr - a.rr) || (b.score - a.score),
  score:   (a, b) => (b.score - a.score) || (b.rr - a.rr),
  azar:    () => rnd() - 0.5,
};

/* ───────────────────────── constantes (del worker) ───────────────────── */
const CAPITAL = 7_000_000;            // ARS, el capital real de LP hoy
const RISK = 0.015;                   // BOT_RISK: 1,5% por trade
const MAX_POS = 5;                    // MAX_POS_REAL
const MAX_DIA = 5;                    // MAX_ENTRADAS_DIA_REAL
const CAP_PCT = 0.20;                 // MAX_POS_PCT_REAL
const VENTANA_H = 48;                 // BOT_VENTANA_H
const TP_FRAC = 0.5;                  // TP_PARCIAL_FRAC_CAMINO
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;                                  // 0,0605%
const FEE = {                                                    // por punta
  gold: 0.005 * IVA + DERECHOS,        // 0,6655%
  platinum: 0.003 * IVA + DERECHOS,    // 0,4235%
  black: 0.001 * IVA + DERECHOS,       // 0,1815%
  // COCOS (agregado 22/09/2026, pedido de LP: ver los CUATRO escenarios).
  // Plan Pro: aranceles fijos mensuales ya hundidos -> costo marginal por
  // trade = SOLO derechos de mercado + IVA. Medido con boletos reales.
  cocos: DERECHOS,                     // 0,0605% por punta = 0,121% ida y vuelta
};
const TIERS = ["gold", "platinum", "black", "cocos"];

/* ventana del motor */
const DIAS_DAILY = 252;   // Yahoo range=1y
const DIAS_HOURLY = 30;   // Yahoo range=1mo sobre 60m
const DIAS_REGIME = 126;  // Yahoo range=6mo para SPY/QQQ

/* walk-forward */
const IS_DESDE = "2023-10-19", IS_HASTA = "2025-06-30";
const OOS_DESDE = "2025-07-01", OOS_HASTA = "2026-09-17";

/* universos (INVENTARIO.md §5) */
const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];
const TODOS = null; // se completa con los 50 archivos

/* Cáscaras de SPAC y símbolos reciclados (INVENTARIO §4): la DIARIA vieja no
 * es la empresa. Se trunca para que la ventana de 1 año no arrastre el trust
 * a US$10 ni la historia del emisor anterior. */
const TRUNCA_DAILY = {
  OKLO: "2024-05-10",   // de-SPAC
  RGTI: "2022-03-01",
  SATL: "2022-01-01",
  KEEL: "2026-04-06",   // símbolo reciclado: desde donde arranca el horario
  LAR: "2025-01-27",
};

const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/* ───────────────────────────── carga ───────────────────────────── */
function listarSimbolos() {
  return fs.readdirSync(path.join(DATA, "hourly"))
    .filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

function cargarTodo() {
  const syms = listarSimbolos();
  const daily = {}, hourly = {};
  for (const s of syms) {
    const d = loadSeries(DATA, "daily", s);
    const h = loadSeries(DATA, "hourly", s);
    if (!d || !h) continue;
    daily[s] = TRUNCA_DAILY[s] ? d.filter((b) => b.t >= TRUNCA_DAILY[s]) : d;
    hourly[s] = h;
  }
  return { syms: Object.keys(daily), daily, hourly };
}

/* ─────────────────── régimen del worker, barra por barra ────────────────
 * SPY y QQQ contra su EMA50 sobre la ventana de 6 meses de diaria, con el
 * cierre parcial de la rueda en curso (igual que el worker, que ve el precio
 * de hoy). Se cachea la EMA de la ventana completa por día. */
function construirRegimen(daily, hourly, timeline) {
  const out = new Map(); // ts → "risk_on"|"mixto"|"risk_off"
  const spyD = daily.SPY, qqqD = daily.QQQ, spyH = hourly.SPY, qqqH = hourly.QQQ;
  if (!spyD || !qqqD) return out;
  const hMap = (arr) => new Map(arr.map((b) => [b.ts, b.c]));
  const spyHm = hMap(spyH), qqqHm = hMap(qqqH);
  const emaCache = new Map(); // dia → {spy, qqq}
  const idxD = (arr, d) => { // último índice con t < d
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

/* ─────────── features de régimen propios (para los filtros a testear) ───
 * Sobre la DIARIA de SPY con adjclose (INVENTARIO §6: es la única que corrige
 * splits y dividendos). EMA200/EMA50 recursivas sobre toda la historia (5
 * años), no sobre una ventana corta — acá no estamos replicando al worker,
 * estamos definiendo un filtro. */
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
  const f = new Map(); // dia → {above200, above50, vol}
  for (let i = 0; i < spy.length; i++) {
    f.set(spy[i].t, {
      above200: e200[i] != null ? c[i] >= e200[i] : null,
      above50: e50[i] != null ? c[i] >= e50[i] : null,
      vol: vol[i],
    });
  }
  // el dato del día D sólo se conoce al cierre → se usa el de D-1 (sin lookahead)
  const lag = new Map();
  for (let i = 1; i < spy.length; i++) lag.set(spy[i].t, f.get(spy[i - 1].t));
  return lag;
}

/* ───────────────── generación del flujo crudo de señales ───────────────
 * Recorre cada barra horaria y corre el motor. Cachea el contexto diario
 * (una vez por rueda) y los pivotes horarios (precalculados sobre la serie
 * completa) — el resultado es idéntico al camino lento salvo por la barra
 * parcial en la confirmación de pivotes diarios (ver README). */
function analizadorRapido(D, H) {
  const pivH = allPivots(H, LB, "h");     // pivotes de TODA la serie horaria
  const cumV = new Array(H.length + 1).fill(0);
  for (let k = 0; k < H.length; k++) cumV[k + 1] = cumV[k] + H[k].v;
  const lo = (arr, idx) => { // primer elemento con .i >= idx
    let a = 0, b = arr.length;
    while (a < b) { const m = (a + b) >> 1; if (arr[m].i < idx) a = m + 1; else b = m; }
    return a;
  };
  const cache = new Map();
  return (i, spotOverride) => {
    const bar = H[i], d = bar.t;
    let ctx = cache.get(d);
    if (ctx === undefined) {
      const win = [];
      for (let k = D.length - 1; k >= 0; k--) { if (D[k].t < d) win.unshift(D[k]); if (win.length >= DIAS_DAILY) break; }
      ctx = win.length >= 60 ? buildDailyCtx(win) : null;
      cache.clear();          // sólo hace falta la rueda en curso
      cache.set(d, ctx);
    }
    if (!ctx) return null;
    // barra parcial de la rueda en curso
    let j = i; while (j > 0 && H[j - 1].t === d) j--;
    let ph = -Infinity, pl = Infinity, pv = 0;
    for (let k = j; k <= i; k++) { ph = Math.max(ph, H[k].h); pl = Math.min(pl, H[k].l); pv += H[k].v; }
    const partial = { ts: H[j].ts, t: d, o: H[j].o, h: ph, l: pl, c: bar.c, v: pv };
    // ventana horaria de 1 mes + pivotes confirmados dentro de ella
    const desde = bar.ts - DIAS_HOURLY * 86400;
    let h0 = i; while (h0 > 0 && H[h0 - 1].ts >= desde) h0--;
    const conf = i - LB;  // pivote confirmado si su índice <= conf
    // el pivote necesita sus LB barras de cada lado DENTRO de la ventana que
    // ve el worker (Yahoo 60m/1mo), igual que allPivots()
    // vr = volumen del pivote contra la SMA20 previa, truncada en el borde
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
    return analyzeKit({
      ctx, partial, hourly: H.slice(h0, i + 1),
      hourPivs: { his: sel(pivH.his), los: sel(pivH.los) },
      spot: spotOverride ?? bar.c,
    });
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
      // dedup igual que paperSignal: misma señal si el nivel está a <0,5%;
      // pasadas 48h la pendiente muere y el nivel se vuelve a emitir.
      const msTs = bar.ts * 1000;
      if (ultEntry != null && Math.abs(kit.buy - ultEntry) / kit.buy < 0.005 && msTs - ultTs <= VENTANA_H * 3600 * 1000) continue;
      ultEntry = kit.buy; ultTs = msTs;
      const rg = regimen.get(bar.ts) || null;
      const ft = feats.get(d) || {};
      senales.push({
        sym, ts: bar.ts, dia: d, entry: kit.buy, stop: kit.stop, target: kit.target,
        score: kit.score, rr: kit.rr, tipo: kit.tipo, estr: kit.estr, rsi: kit.rsi,
        atr: kit.atr,   // para la holgura del stop (criterio de ranking)
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

/* ─────────────────────── simulador de cartera ─────────────────────── */
function simular(senales, bars, ccl, opts) {
  const {
    universo, desde, hasta, filtro, stopMult = 1, tgtMult = 1,
    exitMode = "intrabar", capPct = CAP_PCT, label = "",
  } = opts;
  const rArs = (d) => ccl(d) || 1;   // pesos por dólar del subyacente (conv=1)

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
      created: s.ts * 1000 + 1,   // disponible recién en la barra siguiente
      // Holgura: cuantos ATR hay entre la compra y el stop. Criterio de ranking.
      holgura: s.atr > 0 ? (R * stopMult) / s.atr : 0,
    });
    usados.add(s.sym);
  }
  ordenes.sort((a, b) => a.created - b.created);

  // el reloj de la simulación es la ventana pedida (IS u OOS), no toda la
  // serie: si no, los meses del denominador y el Sharpe salen diluidos.
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
      sym: pos.sym, qty, reason, entryTs: pos.entryTs, exitTs: ts,
      entryPx: pos.entryPx, exitPx: px, entN, bruto: outN - entN,
      // el mismo bruto pero con el CCL de la ENTRADA en las dos patas: la
      // diferencia contra `bruto` es lo que puso el dólar, no el papel.
      brutoSinCcl: qty * (px - pos.entryPx) * pos.rIn,
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
    // 1) llegan señales
    const lote = [];
    while (oi < ordenes.length && ordenes[oi].created <= t) lote.push(ordenes[oi++]);
    // RANKING=1: cuando varias senales compiten por el mismo cupo, entra la de
    // stop mas holgado en vez de la que llego primero. Sin esto el reparto es
    // por orden de llegada, que es lo que hacia el worker (orden alfabetico).
    if (RANKING && CRITERIO[RANKING] && lote.length > 1) lote.sort(CRITERIO[RANKING]);
    for (const o of lote) {
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

    // 2) pendientes: expiración y fill
    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); skips.expiradas++; continue; }
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (b.l <= p.entry) {
        pend.delete(sym);
        const pos = {
          sym: p.sym, qty: p.qty, entryPx: p.entry, entryTs: t, rIn: p.rIn,
          stop: p.stop, stopIni: p.stop, target: p.target, R: p.entry - p.stop,
          notional: p.qty * p.entry * p.rIn, legs: [], tpDone: false,
          score: p.score, rr: p.rr, regime: p.regime, dia: p.dia,
        };
        open.set(sym, pos); trades.push(pos);
      }
    }

    // 3) abiertas: stop → target → TP parcial → trailing
    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (t === pos.entryTs) continue;   // la barra del fill no se juzga de nuevo
      const hi = exitMode === "close" ? b.c : b.h;
      const lo = exitMode === "close" ? b.c : b.l;
      // stop primero (pesimista: si la barra tocó las dos puntas, gana el stop)
      //
      // FIX 20/09/2026 — EL STOP NO PAGABA GAPS (lo detectó INFORME-PLACEBO §3).
      // Antes se cerraba en `pos.stop` exacto siempre que `lo <= pos.stop`,
      // aunque la barra hubiera abierto 3% más abajo. Eso convertía el stop en
      // una orden límite y regalaba el gap. El bot real sale A MERCADO cuando
      // salta el stop, así que sufre el gap de verdad.
      // Corregido: si la barra ABRE debajo del stop, se ejecuta en la apertura.
      // Cuesta 0,33 pp/mes y deja el caso base de Cocos en −0,071% (IS) y
      // +0,030% (OOS), contra los +0,260/+0,324 que se venían reportando.
      if (lo <= pos.stop) {
        const pxSalida = (exitMode === "close") ? pos.stop : Math.min(pos.stop, b.o);
        cerrarPata(pos, pos.qty, pxSalida, t, pos.stop > pos.stopIni ? "trailing" : "stop");
        open.delete(sym); continue;
      }
      // TP parcial a mitad de camino, y después el target con el resto
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
      // trailing desde +2R, nunca baja (se actualiza al cierre de la barra)
      const k = Math.floor((hi - pos.entryPx) / pos.R);
      if (k >= 2 && pos.entryPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.entryPx + (k - 2) * pos.R;
    }

    // 4) equity diaria
    const d = dia(t / 1000);
    let unreal = 0;
    for (const [sym, pos] of open) {
      const b = barAt[sym].get(t);
      unreal += pos.qty * ((b ? b.c : pos.entryPx) - pos.entryPx) * pos.rIn;
    }
    const row = { dia: d, comp: comprometido(), eq: {} };
    for (const tier of TIERS) row.eq[tier] = CAPITAL + realized[tier] + unreal;
    if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row;
    else equity.push(row);
  }

  // cierre de la ventana
  skips.sinFill += pend.size;
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || bars[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    cerrarPata(pos, pos.qty, b ? b.c : pos.entryPx, tFin, "fin_ventana");
    open.delete(sym);
  }
  if (equity.length) {   // la marca final ya no tiene abiertas
    const last = equity[equity.length - 1];
    for (const tier of TIERS) last.eq[tier] = CAPITAL + realized[tier];
  }

  return { label, opts: { desde, hasta, stopMult, tgtMult, exitMode, capPct }, trades, legs, skips, equity, nSenales: ordenes.length };
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
function normInv(p) { // Acklam
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
  const bruto = sim.legs.reduce((s, l) => s + l.bruto, 0);
  const brutoSinCcl = sim.legs.reduce((s, l) => s + l.brutoSinCcl, 0);
  const notional = sim.legs.reduce((s, l) => s + l.entN, 0);
  const fees = sim.legs.reduce((s, l) => s + l.fees[tier], 0);
  const horas = sim.legs.map((l) => (l.exitTs - l.entryTs) / 3600000).sort((a, b) => a - b);
  return {
    n, winRate: n ? wins.length / n : null,
    payoff: losses.length && wins.length ? mean(wins) / Math.abs(mean(losses)) : null,
    total, bruto, brutoSinCcl, notional, fees,
    brutoPct: notional > 0 ? bruto / notional : null,
    brutoSinCclPct: notional > 0 ? brutoSinCcl / notional : null,
    costoPct: notional > 0 ? fees / notional : null,
    horasMed: horas.length ? horas[Math.floor(horas.length / 2)] : null,
    horasProm: horas.length ? mean(horas) : null,
    horasP90: horas.length ? horas[Math.floor(horas.length * 0.9)] : null,
    expectancy: n ? total / n : null,
    mensualPct: (total / CAPITAL / Math.max(meses, 1e-9)) * 100,
    sharpe, maxDDpct: dd * 100, meses,
    srDiario: sd > 0 ? m / sd : null, nRet: rets.length,
    rets,
  };
}

// Deflated Sharpe Ratio (Bailey & López de Prado 2014), sobre retornos diarios.
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

/* ─────────────── chequeo del port contra las señales reales ───────────── */
function chequeoCoincidencia({ daily, hourly }) {
  const f = path.join(DIR, "..", "backtest-reglas", "nivel_track_export.json");
  if (!fs.existsSync(f)) return { error: "no está nivel_track_export.json" };
  const rows = JSON.parse(fs.readFileSync(f, "utf8"));
  // lote = todo lo que el worker emitió en una misma pasada del ticker
  const lotes = new Map();
  for (const r of rows) {
    const k = r.ticker + "|" + r.created_at;
    if (!lotes.has(k)) lotes.set(k, []);
    lotes.get(k).push(r);
  }
  const res = {
    lotes: 0, evaluados: 0,
    // (a) con el spot que anotó el worker: mide FIDELIDAD del port
    conSpotReal: { sop1: 0, sop2: 0, stop1: 0, tgt1: 0, score: 0, scoreN: 0 },
    // (b) con el cierre de la barra horaria: es lo que usa el backtest
    conCierreBarra: { sop1: 0, sop2: 0, stop1: 0, tgt1: 0 },
    sinBuy: 0, det: [],
  };
  const cerca = (a, b, tol) => a != null && b != null && Math.abs(a - b) / b <= tol;
  for (const [k, lote] of lotes) {
    const ticker = k.split("|")[0];
    const sym = lote[0].sym || ticker;
    if (!hourly[sym] || !daily[sym]) continue;
    const sops = lote.filter((r) => /^soporte/.test(r.tipo) && r.dir === "down" && Number(r.level) > 0);
    if (!sops.length) continue;
    res.lotes++;
    const ts = new Date(lote[0].created_at).getTime() / 1000;
    const H = hourly[sym];
    // última barra CERRADA antes de la señal (si tomáramos la barra que
    // contiene el instante de la señal estaríamos usando su cierre futuro)
    let i = -1;
    for (let kk = H.length - 1; kk >= 0; kk--) { if (H[kk].ts + 3600 <= ts) { i = kk; break; } }
    if (i < 300) continue;
    const spotReal = Number(lote[0].spot) > 0 ? Number(lote[0].spot) : null;
    const kitA = analyzeAsOf(daily[sym], H, i, { spot: spotReal ?? undefined });
    const kitB = analyzeAsOf(daily[sym], H, i);
    if (!kitA || !kitB) continue;
    res.evaluados++;
    const realSop = sops.map((r) => Number(r.level));
    const realStop = lote.filter((r) => r.tipo === "stop").map((r) => Number(r.level));
    const realTgt = lote.filter((r) => r.tipo === "resistencia").map((r) => Number(r.level));
    for (const [tag, kit] of [["conSpotReal", kitA], ["conCierreBarra", kitB]]) {
      const mios = [kit.buy, kit.swing].filter((x) => x != null);
      const hit = (tol) => realSop.some((lv) => mios.some((m) => cerca(m, lv, tol)));
      const ok1 = hit(0.01);
      if (ok1) res[tag].sop1++;
      if (hit(0.02)) res[tag].sop2++;
      const stOk = realStop.some((lv) => cerca(kit.stop, lv, 0.01));
      const tgOk = realTgt.some((lv) => cerca(kit.target, lv, 0.01));
      if (stOk) res[tag].stop1++;
      if (tgOk) res[tag].tgt1++;
      // condicionales: si el soporte coincide, ¿coincide el resto del kit?
      if (ok1) {
        res[tag].cond = res[tag].cond || { n: 0, stop: 0, tgt: 0, kit: 0 };
        res[tag].cond.n++;
        if (stOk) res[tag].cond.stop++;
        if (tgOk) res[tag].cond.tgt++;
        if (stOk && tgOk) res[tag].cond.kit++;
      }
    }
    if (kitA.buy == null) res.sinBuy++;
    const sc = sops.find((r) => cerca(kitA.buy, Number(r.level), 0.01));
    if (sc && sc.score != null) { res.conSpotReal.scoreN++; if (sc.score === kitA.score) res.conSpotReal.score++; }
    if (res.det.length < 25 && !realSop.some((lv) => cerca(kitA.buy, lv, 0.01) || cerca(kitA.swing, lv, 0.01))) {
      res.det.push({ ticker, fecha: lote[0].created_at.slice(0, 16), real: realSop, mio: kitA.buy, swing: kitA.swing, spotReal, spotBarra: kitB.spot });
    }
  }
  return res;
}

/* Chequeo fino contra paper_iol_trades: ahí está el kit COMPLETO de cada
 * señal operada (entry_limit / stop_inicial / target exactos), sin el dedup
 * que deja incompletos los lotes de nivel_track. El spot del momento se toma
 * del lote de nivel_track más cercano (±30 min) del mismo ticker. */
function chequeoPaper({ daily, hourly }) {
  const fT = path.join(DIR, "..", "backtest-reglas", "paper_trades_export.json");
  const fN = path.join(DIR, "..", "backtest-reglas", "nivel_track_export.json");
  if (!fs.existsSync(fT)) return { error: "falta paper_trades_export.json" };
  const trades = JSON.parse(fs.readFileSync(fT, "utf8"))
    .filter((t) => t.entry_limit > 0 && t.stop_inicial > 0 && t.target > 0);
  const tracks = fs.existsSync(fN) ? JSON.parse(fs.readFileSync(fN, "utf8")) : [];
  const porTicker = new Map();
  for (const r of tracks) {
    if (!(Number(r.spot) > 0)) continue;
    if (!porTicker.has(r.ticker)) porTicker.set(r.ticker, []);
    porTicker.get(r.ticker).push({ ts: new Date(r.created_at).getTime(), spot: Number(r.spot) });
  }
  const res = { total: trades.length, evaluados: 0, conSpot: 0, entry1: 0, entry2: 0, stop1: 0, tgt1: 0, kit3: 0, det: [] };
  const cerca = (a, b, tol) => a != null && b != null && Math.abs(a - b) / b <= tol;
  for (const t of trades) {
    const sym = t.sym === "YPFD" ? "YPF" : t.sym;
    if (!hourly[sym] || !daily[sym]) continue;
    const ms = new Date(t.created_at).getTime(), ts = ms / 1000;
    const H = hourly[sym];
    let i = -1;
    for (let k = H.length - 1; k >= 0; k--) { if (H[k].ts + 3600 <= ts) { i = k; break; } }
    if (i < 300) continue;
    const cands = (porTicker.get(t.ticker) || []).filter((x) => Math.abs(x.ts - ms) <= 30 * 60 * 1000);
    const spot = cands.length ? cands.sort((a, b) => Math.abs(a.ts - ms) - Math.abs(b.ts - ms))[0].spot : null;
    const kit = analyzeAsOf(daily[sym], H, i, { spot: spot ?? undefined });
    if (!kit) continue;
    res.evaluados++;
    if (spot) res.conSpot++;
    const e1 = cerca(kit.buy, Number(t.entry_limit), 0.01) || cerca(kit.swing, Number(t.entry_limit), 0.01);
    if (e1) res.entry1++;
    if (cerca(kit.buy, Number(t.entry_limit), 0.02) || cerca(kit.swing, Number(t.entry_limit), 0.02)) res.entry2++;
    if (e1) {
      const s1 = cerca(kit.stop, Number(t.stop_inicial), 0.01);
      const g1 = cerca(kit.target, Number(t.target), 0.01);
      if (s1) res.stop1++;
      if (g1) res.tgt1++;
      if (s1 && g1) res.kit3++;
    } else if (res.det.length < 15) {
      res.det.push({ tk: t.ticker, fecha: t.created_at.slice(0, 16), realEntry: t.entry_limit, mio: kit.buy, swing: kit.swing, spot });
    }
  }
  return res;
}

/* ─────────── self-check: camino rápido vs camino lento del motor ─────── */
function chequeoMotor({ syms, daily, hourly }, regimen, feats) {
  const muestra = [];
  const rnd = (n) => Math.floor(Math.random() * n);
  const cand = syms.filter((s) => hourly[s].length > 3000);
  for (let k = 0; k < 40; k++) {
    const sym = cand[rnd(cand.length)];
    const i = 400 + rnd(hourly[sym].length - 420);
    muestra.push([sym, i]);
  }
  let ok = 0, dif = [];
  for (const [sym, i] of muestra) {
    const lento = analyzeAsOf(daily[sym], hourly[sym], i);
    const rap = analizadorRapido(daily[sym], hourly[sym])(i);
    if (!lento || !rap) continue;
    const same = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) / Math.max(1e-9, Math.abs(b)) < 1e-9);
    if (same(rap.buy, lento.buy) && same(rap.stop, lento.stop) && same(rap.target, lento.target) && rap.score === lento.score) ok++;
    else dif.push({ sym, i, rap: { b: rap.buy, s: rap.score, st: rap.stop, t: rap.target }, lento: { b: lento.buy, s: lento.score, st: lento.stop, t: lento.target } });
  }
  return { muestra: muestra.length, ok, dif: dif.slice(0, 5) };
}

/* ───────────────────────────── main ───────────────────────────── */
const fmt = (n) => (n == null ? "-" : Math.round(n).toLocaleString("es-AR"));
const pct = (n, d = 1) => (n == null ? "-" : (n * 100).toFixed(d) + "%");
const n2 = (n, d = 2) => (n == null ? "-" : n.toFixed(d));

function main() {
  const t0 = Date.now();
  const all = cargarTodo();
  console.log(`series cargadas: ${all.syms.length} símbolos`);

  if (ARGS.has("--coincidencia")) {
    const c = chequeoCoincidencia(all);
    console.log(JSON.stringify({ ...c, det: c.det?.slice(0, 3) }, null, 1));
    const p = chequeoPaper(all);
    console.log("paper_trades:", JSON.stringify({ ...p, det: p.det?.slice(0, 5) }, null, 1));
    return;
  }

  const timeline = [...new Set(all.hourly.SPY.map((b) => b.ts))].sort((a, b) => a - b);
  const regimen = construirRegimen(all.daily, all.hourly, timeline);
  const feats = featuresSpy();
  const regCount = {};
  for (const v of regimen.values()) regCount[v] = (regCount[v] || 0) + 1;
  console.log(`régimen del worker por barra: ${JSON.stringify(regCount)}`);

  // 0. self-check del motor
  const chk = chequeoMotor(all, regimen, feats);
  console.log(`[self-check motor] rápido == lento en ${chk.ok}/${chk.muestra} barras al azar`);

  // 1. señales
  const cacheF = path.join(DIR, "signals.json");
  let senales, stats;
  if (!ARGS.has("--resenales") && fs.existsSync(cacheF)) {
    const j = JSON.parse(fs.readFileSync(cacheF, "utf8"));
    senales = j.senales; stats = j.stats;
    console.log(`señales del cache: ${senales.length}`);
  } else {
    const g = generarSenales(all, regimen, feats);
    senales = g.senales; stats = g.stats;
    fs.writeFileSync(cacheF, JSON.stringify({ generado: new Date().toISOString(), stats, senales }));
    console.log(`señales generadas: ${senales.length} (${JSON.stringify(stats)}) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // 2. universos
  const U38 = new Set(LIMPIOS_38.filter((s) => all.syms.includes(s)));
  const U50 = new Set(all.syms);
  console.log(`universo limpio: ${U38.size} · universo completo: ${U50.size}`);

  // 3. gates
  const gateBase = (s) => {           // el filtro EXACTO del worker
    const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
    return g.ok ? { riskMult: g.riskMult } : null;
  };
  const gateSinRegimen = (s) => (s.score >= 7 && s.rr >= 2 && !s.ct ? { riskMult: 1 } : null);
  const volMedIS = (() => {
    const v = senales.filter((s) => s.dia <= IS_HASTA && s.vol != null).map((s) => s.vol).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  })();
  const conj = (g, extra) => (s) => { const r = g(s); return r && extra(s) ? r : null; };
  const GATES = {
    "base (worker)": gateBase,
    "sin régimen": gateSinRegimen,
    "sin régimen + SPY>EMA200": conj(gateSinRegimen, (s) => s.s200 === 1),
    "sin régimen + SPY>EMA50": conj(gateSinRegimen, (s) => s.s50 === 1),
    "sin régimen + vol20 baja": conj(gateSinRegimen, (s) => s.vol != null && s.vol <= volMedIS),
    "base + SPY>EMA200": conj(gateBase, (s) => s.s200 === 1),
    "base + SPY>EMA50": conj(gateBase, (s) => s.s50 === 1),
    "base + vol20 baja": conj(gateBase, (s) => s.vol != null && s.vol <= volMedIS),
    "sin régimen + SPY<EMA200 (control)": conj(gateSinRegimen, (s) => s.s200 === 0),
    "sin régimen + vol20 alta (control)": conj(gateSinRegimen, (s) => s.vol != null && s.vol > volMedIS),
  };

  const out = {
    generado: new Date().toISOString(), selfCheck: chk, stats,
    volMedIS, universos: { limpios: [...U38], todos: [...U50] },
    regimen: regCount, corridas: {}, sweep: {}, dsr: {}, coincidencia: null,
  };
  const variantes = [];   // para el DSR: cada simulación mirada cuenta

  const correr = (nombre, universo, gate, ventana, extra = {}) => {
    const [desde, hasta] = ventana;
    const sim = simular(senales, all.hourly, ccl, { universo, desde, hasta, filtro: gate, label: nombre, ...extra });
    const m = {};
    for (const tier of TIERS) m[tier] = metricas(sim, tier);
    const rec = {
      nombre, desde, hasta, nSenales: sim.nSenales, skips: sim.skips,
      salidas: sim.legs.reduce((a, l) => { a[l.reason] = (a[l.reason] || 0) + 1; return a; }, {}),
      metricas: Object.fromEntries(TIERS.map((t) => [t, { ...m[t], rets: undefined }])),
      _rets: m.gold.rets, _sr: m.gold.srDiario,
      _retsB: m.black.rets, _srB: m.black.srDiario,
      porSym: sim.trades.reduce((a, t) => { a[t.sym] = (a[t.sym] || 0) + 1; return a; }, {}),
      trades: sim.trades.map((t) => ({
        sym: t.sym, dia: t.dia, score: t.score, rr: t.rr, regime: t.regime,
        pnl: Object.fromEntries(TIERS.map((tt) => [tt, Math.round(t.legs.reduce((s, l) => s + l.pnl[tt], 0))])),
        salida: t.legs.map((l) => l.reason).join("+"),
      })),
    };
    variantes.push(rec);
    return rec;
  };

  const ccl = loadCcl(DATA);

  // 3a. caso base, walk-forward, los 38 limpios
  console.log(`\n===== CASO BASE · 38 limpios · gate del worker =====`);
  for (const [vn, ventana] of [["IS", [IS_DESDE, IS_HASTA]], ["OOS", [OOS_DESDE, OOS_HASTA]]]) {
    const r = correr(`38/base/${vn}`, U38, gateBase, ventana);
    out.corridas[r.nombre] = r;
    const g = r.metricas.gold;
    console.log(`[${vn}] señales ${r.nSenales} · trades ${g.n} · salidas ${JSON.stringify(r.salidas)} · horas de tenencia mediana/promedio/p90 ${n2(g.horasMed, 1)}/${n2(g.horasProm, 1)}/${n2(g.horasP90, 1)} · skips ${JSON.stringify(r.skips)}`);
    console.log(`   BRUTO (antes de comisiones) $${fmt(g.bruto)} = ${pct(g.brutoPct, 3)} del nocional · sin el aporte del CCL ${pct(g.brutoSinCclPct, 3)} · costo de ida y vuelta ${pct(g.costoPct, 3)} (gold)`);
    for (const tier of TIERS) {
      const m = r.metricas[tier];
      console.log(`   ${tier.padEnd(9)} mensual ${n2(m.mensualPct)}% · P&L $${fmt(m.total)} (comisiones $${fmt(m.fees)}) · win ${pct(m.winRate)} · payoff ${n2(m.payoff)} · Sharpe ${n2(m.sharpe)} · maxDD ${n2(m.maxDDpct)}%`);
    }
  }

  // 3b. sesgo de selección: 50 con alta real
  console.log(`\n===== SESGO DE SELECCIÓN · 50 con alta real =====`);
  for (const [vn, ventana] of [["IS", [IS_DESDE, IS_HASTA]], ["OOS", [OOS_DESDE, OOS_HASTA]]]) {
    const r = correr(`50/base/${vn}`, U50, gateBase, ventana);
    out.corridas[r.nombre] = r;
    const m = r.metricas.gold;
    console.log(`[${vn}] trades ${m.n} · mensual gold ${n2(m.mensualPct)}% · P&L $${fmt(m.total)} · win ${pct(m.winRate)} · Sharpe ${n2(m.sharpe)}`);
  }

  // 3c. filtros de régimen (IS primero; el OOS se mira al final, sin retocar)
  console.log(`\n===== FILTROS DE RÉGIMEN · 38 limpios · (vol mediana IS = ${n2(volMedIS, 3)}) =====`);
  for (const [gn, g] of Object.entries(GATES)) {
    const ris = correr(`38/${gn}/IS`, U38, g, [IS_DESDE, IS_HASTA]);
    out.corridas[ris.nombre] = ris;
    const m = ris.metricas.gold;
    console.log(`[IS ] ${gn.padEnd(36)} n=${String(m.n).padStart(4)} mensual ${n2(m.mensualPct).padStart(6)}% exp/trade ${fmt(m.expectancy).padStart(9)} win ${pct(m.winRate).padStart(6)} Sharpe ${n2(m.sharpe).padStart(6)} DD ${n2(m.maxDDpct).padStart(5)}%`);
  }
  for (const [gn, g] of Object.entries(GATES)) {
    const ro = correr(`38/${gn}/OOS`, U38, g, [OOS_DESDE, OOS_HASTA]);
    out.corridas[ro.nombre] = ro;
    const m = ro.metricas.gold;
    console.log(`[OOS] ${gn.padEnd(36)} n=${String(m.n).padStart(4)} mensual ${n2(m.mensualPct).padStart(6)}% exp/trade ${fmt(m.expectancy).padStart(9)} win ${pct(m.winRate).padStart(6)} Sharpe ${n2(m.sharpe).padStart(6)} DD ${n2(m.maxDDpct).padStart(5)}%`);
  }

  // 3d. robustez: stop y target ±30%
  console.log(`\n===== ROBUSTEZ · stop y target ±30% (gate base, 38 limpios) =====`);
  const mults = [0.7, 0.85, 1, 1.15, 1.3];
  for (const vn of ["IS", "OOS"]) {
    const ventana = vn === "IS" ? [IS_DESDE, IS_HASTA] : [OOS_DESDE, OOS_HASTA];
    console.log(`--- ${vn} (mensual % gold) ---`);
    console.log("stop\\tgt  " + mults.map((m) => String(m).padStart(8)).join(""));
    for (const sm of mults) {
      const fila = [];
      for (const tm of mults) {
        const r = correr(`38/sweep/${vn}/s${sm}t${tm}`, U38, gateBase, ventana, { stopMult: sm, tgtMult: tm });
        out.sweep[`${vn}/s${sm}/t${tm}`] = { mensual: r.metricas.gold.mensualPct, n: r.metricas.gold.n, win: r.metricas.gold.winRate, sharpe: r.metricas.gold.sharpe };
        fila.push(n2(r.metricas.gold.mensualPct).padStart(8));
      }
      console.log(String(sm).padEnd(10) + fila.join(""));
    }
  }

  // 3e. variante de confirmación de salida (cierre de barra en vez de intrabar)
  console.log(`\n===== VARIANTE · salida confirmada al cierre de la barra =====`);
  for (const vn of ["IS", "OOS"]) {
    const ventana = vn === "IS" ? [IS_DESDE, IS_HASTA] : [OOS_DESDE, OOS_HASTA];
    const r = correr(`38/base-cierre/${vn}`, U38, gateBase, ventana, { exitMode: "close" });
    out.corridas[r.nombre] = r;
    const m = r.metricas.gold;
    console.log(`[${vn}] trades ${m.n} · mensual gold ${n2(m.mensualPct)}% · win ${pct(m.winRate)} · Sharpe ${n2(m.sharpe)}`);
  }

  // 3f. corte por score y por régimen (diagnóstico, no es una variante)
  console.log(`\n===== CORTE POR SCORE Y RÉGIMEN (base 38, IS+OOS juntos) =====`);
  const tds = [...(out.corridas["38/base/IS"]?.trades || []), ...(out.corridas["38/base/OOS"]?.trades || [])];
  const grupo = (fn, titulo) => {
    const g = {};
    for (const t of tds) { const k = fn(t); (g[k] = g[k] || []).push(t); }
    const filas = Object.entries(g).sort().map(([k, v]) => {
      const s = v.reduce((a, x) => a + x.pnl.gold, 0), sb = v.reduce((a, x) => a + x.pnl.black, 0);
      const w = v.filter((x) => x.pnl.gold > 0).length;
      return `${k}: n=${v.length} win=${pct(w / v.length)} gold=$${fmt(s)} (${fmt(s / v.length)}/trade) black=$${fmt(sb)}`;
    });
    console.log(` ${titulo}\n   ` + filas.join("\n   "));
    return g;
  };
  out.corteScore = grupo((t) => "score " + t.score, "por score");
  out.corteRegimen = grupo((t) => "rgm " + t.regime, "por régimen del worker");
  out.corteSalida = grupo((t) => t.salida, "por camino de salida");
  out.corteAnio = grupo((t) => t.dia.slice(0, 4), "por año");
  for (const k of ["corteScore", "corteRegimen", "corteSalida", "corteAnio"]) {
    out[k] = Object.fromEntries(Object.entries(out[k]).map(([kk, v]) => [kk, {
      n: v.length, gold: Math.round(v.reduce((a, x) => a + x.pnl.gold, 0)),
      black: Math.round(v.reduce((a, x) => a + x.pnl.black, 0)),
      win: v.filter((x) => x.pnl.gold > 0).length / v.length,
    }]));
  }

  // 4. DSR sobre el caso base OOS, contando TODAS las variantes miradas
  const N = variantes.length;
  const srs = variantes.map((v) => v._sr).filter((x) => x != null);
  const sigmaSR = stdev(srs);
  const sigmaSRb = stdev(variantes.map((v) => v._srB).filter((x) => x != null));
  for (const nombre of ["38/base/IS", "38/base/OOS", "50/base/IS", "50/base/OOS"]) {
    const v = out.corridas[nombre];
    if (!v) continue;
    const d = dsr(v._rets, v._sr, sigmaSR, N);
    const db = dsr(v._retsB, v._srB, sigmaSRb, N);
    out.dsr[nombre] = d ? { ...d, N, sigmaSR, sharpeAnual: v.metricas.gold.sharpe } : null;
    out.dsr[nombre + " (black)"] = db ? { ...db, N, sigmaSR: sigmaSRb, sharpeAnual: v.metricas.black.sharpe } : null;
  }
  // el mejor filtro de régimen en IS, deflactado en OOS
  const mejorIS = variantes.filter((v) => v.nombre.startsWith("38/") && v.nombre.endsWith("/IS") && !v.nombre.includes("sweep") && !v.nombre.includes("control"))
    .sort((a, b) => (b.metricas.gold.sharpe ?? -9) - (a.metricas.gold.sharpe ?? -9))[0];
  if (mejorIS) {
    const nombreOOS = mejorIS.nombre.replace(/\/IS$/, "/OOS");
    const vo = out.corridas[nombreOOS];
    out.dsr.mejorIS = { nombre: mejorIS.nombre, sharpeIS: mejorIS.metricas.gold.sharpe };
    if (vo) out.dsr.mejorOOS = { nombre: nombreOOS, sharpe: vo.metricas.gold.sharpe, ...(dsr(vo._rets, vo._sr, sigmaSR, N) || {}), N };
  }
  console.log(`\n===== DSR · N=${N} variantes evaluadas · sigma(SR diario entre variantes)=${sigmaSR.toExponential(3)} =====`);
  for (const k of Object.keys(out.dsr)) console.log(`  ${k}: ${JSON.stringify(out.dsr[k])}`);

  // 5. chequeo del port
  console.log(`\n===== COINCIDENCIA DEL PORT (60 días reales) =====`);
  out.coincidencia = chequeoCoincidencia(all);
  out.coincidenciaPaper = chequeoPaper(all);
  const c = out.coincidencia, cp = out.coincidenciaPaper;
  console.log(`nivel_track: ${c.evaluados} lotes · soporte <=1% ${c.conSpotReal.sop1} (${pct(c.conSpotReal.sop1 / c.evaluados)}) · <=2% ${c.conSpotReal.sop2} · con cierre de barra en vez del spot real: ${c.conCierreBarra.sop1} (${pct(c.conCierreBarra.sop1 / c.evaluados)})`);
  console.log(`paper_trades: ${cp.evaluados} señales · entrada <=1% ${cp.entry1} (${pct(cp.entry1 / cp.evaluados)}) · <=2% ${cp.entry2} · condicional stop ${cp.stop1}/${cp.entry1} · target ${cp.tgt1}/${cp.entry1} · kit completo ${cp.kit3}`);

  for (const v of variantes) { delete v._rets; delete v._retsB; }
  fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(out, null, 1));
  console.log(`\nresults.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main();
