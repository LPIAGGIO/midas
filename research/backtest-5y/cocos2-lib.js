/* cocos2-lib.js — motor de cartera para el anexo COCOS2 (targets cortos,
 * promediar hacia abajo, escalonado en recuperación). Ver INFORME-COCOS2.md.
 *
 * Es una copia GENERALIZADA del simulador de simulate.js / atr.js: misma
 * secuencia (llegan órdenes → pendientes expiran o llenan → abiertas: stop
 * primero con el fix del gap, después ventas, después trailing → equity
 * diaria), pero cada posición es una lista de LOTES (para promediar) y una
 * lista de VENTAS parciales (para los targets escalonados).
 *
 * Todo local. No toca VPS, Supabase ni archivos existentes del backtest.
 * ESM (package.json de Midas es "type":"module").
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSeries, loadCcl, gatePasa } from "./engine.js";

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(DIR, "data");

/* ─────────────── rails pedidos para TODAS las variantes ─────────────── */
export const CAPITAL = 20_000_000;   // ARS
export const SLOT = 2_000_000;       // tope por papel (ARS); mixto → mitad
export const MAX_DIA = 6;            // entradas por día
export const VENTANA_H = 48;         // la orden límite vive 48 h
export const ATR_MULT = 1.5;         // stop = entrada − 1,5 × ATR14 diario
export const RISK = 0.015;           // sólo para el diagnóstico "¿manda el tope?"

/* ─────────────── costos Cocos ───────────────
 * Derechos BYMA + IVA. Swing 0,0605% por punta; si compra y venta caen el
 * mismo día, 0,053% por punta (las DOS patas). Entradas y targets son límites
 * que descansan (no pagan spread). Stops, trailing, cierre de ventana y las
 * compras a mercado de la variante D cruzan el book: pagan `spread`. */
export const FEE_SWING = 0.000605;
export const FEE_INTRADIA = 0.00053;

/* walk-forward (idéntico a simulate.js) */
export const IS = ["2023-10-19", "2025-06-30"];
export const OOS = ["2025-07-01", "2026-09-17"];

export const LIMPIOS_38 = ["MU", "GGAL", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN", "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST", "MCD", "VIST", "MSTR", "HUT", "MRNA", "UBER", "IBM", "QCOM", "MRVL", "PLTR", "ADBE", "COIN", "NFLX", "ADI", "HPQ", "WMT", "V", "GPRK", "SPY", "QQQ"];

export const dia = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
export const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
export function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
export function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; }
export const tstat = (a) => { const sd = stdev(a); return a.length > 1 && sd > 0 ? mean(a) / sd * Math.sqrt(a.length) : null; };

/* ───────────────────────────── carga ───────────────────────────── */
export function cargar(universo = LIMPIOS_38) {
  const daily = {}, hourly = {};
  for (const s of universo) {
    const d = loadSeries(DATA, "daily", s), h = loadSeries(DATA, "hourly", s);
    if (!d || !h) continue;
    daily[s] = d; hourly[s] = h;
  }
  const ccl = loadCcl(DATA);
  const senales = JSON.parse(fs.readFileSync(path.join(DIR, "signals.json"), "utf8")).senales
    .filter((s) => daily[s.sym]);
  return { syms: Object.keys(daily), daily, hourly, ccl, senales };
}

/* ATR14 SIMPLE sobre ruedas CERRADAS (copia de atr14() del worker, parche del
 * 29/09/2026): promedio de los últimos 14 true ranges de las barras diarias
 * con fecha ESTRICTAMENTE anterior al día pedido. Point-in-time. */
export function atrTabla(daily) {
  const T = {};
  for (const s of Object.keys(daily)) {
    const D = daily[s];
    const tr = new Array(D.length).fill(null);
    for (let i = 1; i < D.length; i++) tr[i] = Math.max(D[i].h - D[i].l, Math.abs(D[i].h - D[i - 1].c), Math.abs(D[i].l - D[i - 1].c));
    const atr = new Array(D.length).fill(null);   // atr[i] = ATR usando barras <= i
    for (let i = 14; i < D.length; i++) { let sm = 0; for (let k = i - 13; k <= i; k++) sm += tr[k]; atr[i] = sm / 14; }
    T[s] = { t: D.map((b) => b.t), atr };
  }
  return (sym, d) => {
    const v = T[sym]; if (!v) return null;
    let lo = 0, hi = v.t.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (v.t[m] < d) { r = m; lo = m + 1; } else hi = m - 1; }
    return r < 0 ? null : v.atr[r];
  };
}

/* contexto de una ventana: barras por símbolo indexadas por ts, timeline */
export function contexto(hourly, universo, [desde, hasta]) {
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

/* el filtro del bot, textual (gatePasa de engine.js). El R:R que mira es el
 * de la señal, calculado con el stop TÉCNICO; el stop de ejecución es el ATR. */
export const gateBase = (s) => {
  const g = gatePasa({ buy: s.entry, stop: s.stop, target: s.target, score: s.score, rr: s.rr, contraTendencia: !!s.ct }, s.regime);
  return g.ok ? { riskMult: g.riskMult } : null;
};

/* órdenes gateadas de la ventana, con el ATR del día de la señal */
export function ordenesDe(senales, universo, ctx, atrDe) {
  const out = [];
  for (const s of senales) {
    if (!universo.has(s.sym) || s.dia < ctx.desde || s.dia > ctx.hasta) continue;
    const f = gateBase(s); if (!f) continue;
    const a = atrDe(s.sym, s.dia);
    if (!(a > 0)) continue;
    const spotBar = ctx.barAt[s.sym]?.get(s.ts * 1000);
    out.push({
      sym: s.sym, ts: s.ts, dia: s.dia, entry: s.entry, res: s.target, stopTec: s.stop,
      score: s.score, rr: s.rr, regime: s.regime, riskMult: f.riskMult ?? 1,
      atr0: a, spot: spotBar ? spotBar.c : null,
      created: s.ts * 1000 + 1,   // disponible recién en la barra siguiente
    });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}

/* ───────────────────────── variantes ─────────────────────────
 * modo:  "uno"   → un solo lote (A y B)
 *        "prom"  → promediar hacia abajo: 4 lotes de SLOT/4, a −1/−2/−3 ATR (C)
 *        "recup" → escalonado en recuperación: 4 lotes, se agregan al cierre
 *                  horario que recupera el nivel después de un cierre debajo (D)
 * salida: "res"        → todo en la resistencia
 *         "resParcial" → mitad al 50% del camino, resto en la resistencia (bot hoy)
 *         "pct:X"      → todo a min(resistencia, promedio × (1+X))
 *         "mitadCamino"→ todo al 50% del camino a la resistencia
 *         "mitad15res" → mitad a +1,5%, resto en la resistencia
 *         "escalonado" → 1/4 a +1%, 1/4 a +2%, 1/4 a +3%, 1/4 en la resistencia
 * Los "+X%" son sobre el precio PROMEDIO de los lotes llenos. */
export const VARIANTES = {
  "A  res + parcial 50%":       { modo: "uno", salida: "resParcial" },
  "B  todo +1,0%":              { modo: "uno", salida: "pct:0.010" },
  "B  todo +1,5%":              { modo: "uno", salida: "pct:0.015" },
  "B  todo +2,0%":              { modo: "uno", salida: "pct:0.020" },
  "B  todo +3,0%":              { modo: "uno", salida: "pct:0.030" },
  "B  todo mitad de camino":    { modo: "uno", salida: "mitadCamino" },
  "B  mitad +1,5% / resto res": { modo: "uno", salida: "mitad15res" },
  "B  todo en la res (sin parcial)": { modo: "uno", salida: "res" },
  "C1 prom → res":              { modo: "prom", salida: "res" },
  "C2 prom → +1,5% del prom":   { modo: "prom", salida: "pct:0.015" },
  "C3 prom → escalonado":       { modo: "prom", salida: "escalonado" },
  "D1 recup → res":             { modo: "recup", salida: "res" },
  "D2 recup → +1,5% del prom":  { modo: "recup", salida: "pct:0.015" },
};

function nivelesVenta(pos, salida) {
  const avg = pos.avgPx, res = pos.res;
  const cap = (x) => Math.min(res, avg * (1 + x));
  switch (salida) {
    case "res": return [{ frac: 1, px: res, tag: "res" }];
    case "resParcial": return [{ frac: 0.5, px: pos.entry0 + 0.5 * (res - pos.entry0), tag: "tp50" }, { frac: 1, px: res, tag: "res" }];
    case "mitadCamino": return [{ frac: 1, px: pos.entry0 + 0.5 * (res - pos.entry0), tag: "mitadCamino" }];
    case "mitad15res": return [{ frac: 0.5, px: cap(0.015), tag: "tp1.5" }, { frac: 1, px: res, tag: "res" }];
    case "escalonado": return [{ frac: 0.25, px: cap(0.01), tag: "tp1" }, { frac: 0.25, px: cap(0.02), tag: "tp2" }, { frac: 0.25, px: cap(0.03), tag: "tp3" }, { frac: 1, px: res, tag: "res" }];
    default: {
      const m = /^pct:([\d.]+)$/.exec(salida);
      if (!m) throw new Error("salida desconocida " + salida);
      return [{ frac: 1, px: cap(Number(m[1])), tag: "tp" + (Number(m[1]) * 100).toFixed(1) }];
    }
  }
}

/* ─────────────────────── simulador ─────────────────────── */
export function simular(ordenes, ctx, atrDe, ccl, { variante, spread = 0.001, label = "", light = false, trailAtr = true, stopTec = false }) {
  const { modo, salida } = variante;
  const { barAt, timeline, tFin } = ctx;
  const rArs = (d) => ccl(d) || 1;
  const pend = new Map(), open = new Map();
  const trades = [];
  const entradasDia = new Map();
  const skips = { openSym: 0, dupPend: 0, entradasDia: 0, sinCapital: 0, reemplazadas: 0, expiradas: 0, sinFill: 0 };
  let realized = 0;
  const equity = [];
  let oi = 0;
  const reservado = () => { let s = 0; for (const p of pend.values()) s += p.slot; for (const p of open.values()) s += p.slot; return s; };

  const feeRate = (lotDia, exitDia) => (lotDia === exitDia ? FEE_INTRADIA : FEE_SWING);

  // vende `qty` del lote más viejo al más nuevo (FIFO), cada porción con su
  // propio CCL de entrada y su propia regla intradía.
  const vender = (pos, qty, px, ts, reason, cruza) => {
    const d = dia(ts / 1000), rOut = rArs(d);
    const pxEf = cruza ? px * (1 - spread) : px;
    let resta = qty, bruto = 0, papel = 0, fees = 0, entN = 0;
    while (resta > 1e-12 && pos.lots.length) {
      const L = pos.lots[0];
      const q = Math.min(resta, L.qty);
      const eN = q * L.px * L.rIn, oN = q * pxEf * rOut;
      const fr = feeRate(L.dia, d);
      fees += eN * fr + oN * fr;
      bruto += oN - eN; papel += q * (pxEf - L.px) * L.rIn; entN += eN;
      L.qty -= q; resta -= q;
      if (L.qty <= 1e-12) pos.lots.shift();
    }
    const pnl = bruto - fees;
    realized += pnl;
    pos.qty = pos.lots.reduce((s, L) => s + L.qty, 0);
    pos.legs.push({ reason, qty, px: pxEf, ts, bruto, papel, fees, pnl, entN });
    pos.pnl += pnl; pos.bruto += bruto; pos.papel += papel; pos.fees += fees;
    if (pos.qty <= 1e-12) { pos.exitTs = ts; open.delete(pos.sym); }
  };
  const comprar = (pos, notional, px, ts, cruza, tag) => {
    const d = dia(ts / 1000), rIn = rArs(d);
    const pxEf = cruza ? px * (1 + spread) : px;
    const qty = notional / (pxEf * rIn);
    pos.lots.push({ qty, px: pxEf, rIn, dia: d, ts, tag });
    pos.qty += qty; pos.invertido += qty * pxEf * rIn;
    const tot = pos.lots.reduce((s, L) => s + L.qty * L.px, 0), tq = pos.lots.reduce((s, L) => s + L.qty, 0);
    pos.avgPx = tot / tq; pos.nLotes++; pos.lastBuyTs = ts;
    pos.avgHist.push(pos.avgPx);
  };

  for (const t of timeline) {
    // 1) llegan señales → órdenes límite pendientes (orden de llegada, como el worker)
    while (oi < ordenes.length && ordenes[oi].created <= t) {
      const o = ordenes[oi++];
      if (!barAt[o.sym]) continue;
      if (open.has(o.sym)) { skips.openSym++; continue; }
      const prv = pend.get(o.sym);
      if (prv && Math.abs(prv.entry - o.entry) / o.entry < 0.005) { skips.dupPend++; continue; }
      if (prv) { pend.delete(o.sym); skips.reemplazadas++; }
      const d = dia(o.created / 1000);
      if ((entradasDia.get(d) || 0) >= MAX_DIA) { skips.entradasDia++; continue; }
      const slotPedido = SLOT * o.riskMult;
      const libre = CAPITAL - reservado();
      const slot = Math.min(slotPedido, libre);
      if (slot < slotPedido * 0.25) { skips.sinCapital++; continue; }   // sin polvo
      entradasDia.set(d, (entradasDia.get(d) || 0) + 1);
      pend.set(o.sym, { ...o, slot });
    }

    // 2) pendientes: expiración y fill del PRIMER lote (límite: se llena al nivel)
    for (const [sym, p] of [...pend]) {
      if (t - p.created > VENTANA_H * 3600 * 1000) { pend.delete(sym); skips.expiradas++; continue; }
      const b = barAt[sym].get(t);
      if (!b) continue;
      if (b.l <= p.entry) {
        pend.delete(sym);
        // stopTec=true: diagnóstico con el stop TÉCNICO del motor (el régimen anterior al 29/09)
        const stop0 = stopTec ? p.stopTec : p.entry - ATR_MULT * p.atr0;
        if (!(stop0 > 0)) continue;
        const pos = {
          sym, slot: p.slot, entry0: p.entry, res: p.res, atr0: p.atr0, entryTs: t, dia: p.dia,
          score: p.score, rr: p.rr, regime: p.regime, riskMult: p.riskMult, spot: p.spot,
          lots: [], qty: 0, invertido: 0, avgPx: p.entry, nLotes: 0, avgHist: [],
          stop: stop0, stopIni: stop0, stopBase: stop0, R: p.entry - stop0, stopReset: 0,
          legs: [], pnl: 0, bruto: 0, papel: 0, fees: 0,
          ventas: null, qtyRef: null, tramos: [], inBreak: false, minBreak: null, exitTs: null,
          // diagnóstico: ¿el tope de 2M manda contra el sizing por riesgo (1,5% × 20M / stop)?
          mandaTope: (CAPITAL * RISK * p.riskMult) / (ATR_MULT * p.atr0 / p.entry) >= p.slot,
        };
        const nTramo = modo === "uno" ? 1 : 4;
        comprar(pos, p.slot / nTramo, p.entry, t, false, "L1");
        if (modo === "prom") for (let k = 1; k < 4; k++) pos.tramos.push({ px: p.entry - k * p.atr0, notional: p.slot / 4, tag: "L" + (k + 1) });
        pos.ventas = nivelesVenta(pos, salida);
        pos.qtyRef = pos.qty;
        open.set(sym, pos); trades.push(pos);
      }
    }

    // 3) abiertas
    for (const [sym, pos] of [...open]) {
      const b = barAt[sym].get(t);
      if (!b || t === pos.entryTs) continue;   // la barra del fill no se juzga de nuevo
      const d = dia(t / 1000);

      // 3a) C: tramos de promedio (límites que descansan debajo). Llenan antes del
      // stop porque están 0,5 ATR arriba de él; después se reevalúa el stop.
      if (modo === "prom" && pos.tramos.length && !pos.legs.length) {
        while (pos.tramos.length && b.l <= pos.tramos[0].px) {
          const tr = pos.tramos.shift();
          comprar(pos, tr.notional, tr.px, t, false, tr.tag);
          pos.stop = pos.stopBase = tr.px - ATR_MULT * pos.atr0;   // stop único bajo el ÚLTIMO tramo
          pos.stopReset++;
          pos.ventas = nivelesVenta(pos, salida);   // los +X% son sobre el promedio nuevo
          pos.qtyRef = pos.qty;
        }
      }
      // D: durante la ruptura se sigue el mínimo
      if (modo === "recup" && pos.inBreak) pos.minBreak = Math.min(pos.minBreak, b.l);

      // 3b) stop primero (pesimista) con el fix del gap: si abre debajo, llena a la apertura
      if (b.l <= pos.stop) {
        const px = Math.min(pos.stop, b.o);
        vender(pos, pos.qty, px, t, pos.stop > pos.stopBase * 1.0000001 ? "trailing" : "stop", true);
        continue;
      }

      // 3c) ventas límite, de la más baja a la más alta. Si en ESTA barra se
      // llenó un tramo, la venta recién se evalúa en la siguiente (el orden
      // intrabarra mínimo→máximo no se conoce; pesimista).
      if (pos.ventas && pos.lastBuyTs !== t) {
        while (pos.ventas.length && b.h >= pos.ventas[0].px) {
          const v = pos.ventas.shift();
          if (!pos.legs.length) { pos.qtyRef = pos.qty; pos.tramos = []; }   // primera venta: se cancelan los tramos
          const q = v.frac >= 1 || !pos.ventas.length ? pos.qty : Math.min(pos.qty, pos.qtyRef * v.frac);
          vender(pos, q, v.px, t, v.tag, false);
          if (!open.has(sym)) break;
        }
        if (!open.has(sym)) continue;
      }

      // 3d) D: ruptura / recuperación al cierre horario
      if (modo === "recup" && !pos.legs.length) {
        if (!pos.inBreak && b.c < pos.entry0) { pos.inBreak = true; pos.minBreak = b.l; }
        else if (pos.inBreak && b.c > pos.entry0) {
          pos.inBreak = false;
          if (pos.nLotes < 4) {
            comprar(pos, pos.slot / 4, b.c, t, true, "R" + (pos.nLotes + 1));   // compra a mercado: paga spread
            pos.stop = pos.stopBase = pos.minBreak - ATR_MULT * pos.atr0;   // 1,5 ATR bajo el mínimo de la ruptura
            pos.stopReset++;
            pos.ventas = nivelesVenta(pos, salida);
            pos.qtyRef = pos.qty;
          }
        }
      }

      // 3e) trailing: ATR vivo (cierre − 1,5 × ATR del día) y +2R del worker; nunca baja.
      // En C y D el trailing recién se activa cuando el cierre está ARRIBA del
      // primer nivel de entrada: mientras la posición promedia, el stop es el
      // único "bajo el último tramo" (si no, cualquier rebote entre tramos lo
      // subiría y el tramo siguiente no podría llenarse nunca). Ver informe.
      const aLive = atrDe(sym, d) || pos.atr0;
      const sAtr = b.c - ATR_MULT * aLive;
      if (trailAtr && sAtr > pos.stop && (modo === "uno" || b.c > pos.entry0)) pos.stop = sAtr;
      const k = Math.floor((b.h - pos.avgPx) / pos.R);
      if (k >= 2 && pos.avgPx + (k - 2) * pos.R > pos.stop) pos.stop = pos.avgPx + (k - 2) * pos.R;
    }

    // 4) equity diaria (marca al cierre, con el CCL de entrada de cada lote)
    if (!light) {
      const d = dia(t / 1000);
      let unreal = 0, expo = 0;
      for (const [sym, pos] of open) {
        const b = barAt[sym].get(t);
        for (const L of pos.lots) { unreal += L.qty * ((b ? b.c : L.px) - L.px) * L.rIn; expo += L.qty * L.px * L.rIn; }
      }
      const row = { dia: d, eq: CAPITAL + realized + unreal, expo };
      if (equity.length && equity[equity.length - 1].dia === d) equity[equity.length - 1] = row; else equity.push(row);
    }
  }
  skips.sinFill = pend.size;
  for (const [sym, pos] of [...open]) {
    const b = barAt[sym].get(tFin) || ctx.serie[sym].filter((x) => x.ts * 1000 <= tFin).pop();
    vender(pos, pos.qty, b ? b.c : pos.avgPx, tFin, "fin_ventana", true);
  }
  if (!light && equity.length) equity[equity.length - 1] = { ...equity[equity.length - 1], eq: CAPITAL + realized, expo: 0 };
  return { label, trades, equity, skips, realized, nOrdenes: ordenes.length };
}

/* ─────────────────────────── métricas ─────────────────────────── */
export function metricas(sim, meses) {
  const T = sim.trades;
  const n = T.length;
  const rets = T.map((t) => t.pnl / t.invertido);          // % sobre nocional invertido
  const total = T.reduce((s, t) => s + t.pnl, 0);
  const inv = T.reduce((s, t) => s + t.invertido, 0);
  const bruto = T.reduce((s, t) => s + t.bruto, 0), papel = T.reduce((s, t) => s + t.papel, 0), fees = T.reduce((s, t) => s + t.fees, 0);
  // serie mensual sobre los 20M (cierre de mes calendario de la equity)
  const porMes = new Map();
  for (const e of sim.equity) porMes.set(e.dia.slice(0, 7), e.eq);
  const mk = [...porMes.keys()].sort();
  const mens = [];
  let prev = CAPITAL;
  for (const m of mk) { mens.push((porMes.get(m) - prev) / CAPITAL); prev = porMes.get(m); }
  const dRets = [];
  for (let i = 1; i < sim.equity.length; i++) dRets.push(sim.equity[i].eq / sim.equity[i - 1].eq - 1);
  let peak = -Infinity, dd = 0;
  for (const e of sim.equity) { peak = Math.max(peak, e.eq); dd = Math.max(dd, (peak - e.eq) / peak); }
  const horas = T.map((t) => (t.exitTs - t.entryTs) / 3600000);
  const salidas = {};
  for (const t of T) { const k = t.legs.map((l) => l.reason).join("+"); salidas[k] = (salidas[k] || 0) + 1; }
  const ult = {};
  for (const t of T) { const k = t.legs[t.legs.length - 1].reason; ult[k] = (ult[k] || 0) + 1; }
  const sdD = stdev(dRets), mD = mean(dRets);
  return {
    n, retMedio: n ? mean(rets) : null, retMediana: median(rets), winRate: n ? rets.filter((x) => x > 0).length / n : null,
    tTrade: tstat(rets), tMes: tstat(mens), nMeses: mens.length,
    mensualPct: (total / CAPITAL / meses) * 100, total, invertido: inv,
    brutoPct: inv ? bruto / inv : null, papelPct: inv ? papel / inv : null, cclPct: inv ? (bruto - papel) / inv : null, costoPct: inv ? fees / inv : null,
    maxDDpct: dd * 100, sharpe: sdD > 0 ? (mD / sdD) * Math.sqrt(252) : null, srDiario: sdD > 0 ? mD / sdD : null, dRets,
    horasMed: median(horas), lotesMed: n ? mean(T.map((t) => t.nLotes)) : null,
    invMed: median(T.map((t) => t.invertido)),
    expoMedia: sim.equity.length ? mean(sim.equity.map((e) => e.expo)) / CAPITAL : null,
    mandaTope: n ? T.filter((t) => t.mandaTope).length / n : null,
    salidas, ultimaSalida: ult, mens,
  };
}

// Deflated Sharpe Ratio (Bailey & López de Prado 2014), copia de simulate.js
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
export function normInv(p) {
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
export function dsr(rets, srDiario, sigmaSR, N) {
  if (!rets || rets.length < 20 || srDiario == null || !(sigmaSR > 0) || !(N > 1)) return null;
  const n = rets.length, m = mean(rets), sd = stdev(rets);
  const g3 = mean(rets.map((r) => ((r - m) / sd) ** 3));
  const g4 = mean(rets.map((r) => ((r - m) / sd) ** 4));
  const gamma = 0.5772156649;
  const sr0 = sigmaSR * ((1 - gamma) * normInv(1 - 1 / N) + gamma * normInv(1 - 1 / (N * Math.E)));
  const den = Math.sqrt(Math.max(1e-12, 1 - g3 * srDiario + ((g4 - 1) / 4) * srDiario ** 2));
  return { sr0, dsr: normCdf(((srDiario - sr0) * Math.sqrt(n - 1)) / den) };
}

/* ─────────── control E: mismas señales, fechas barajadas ───────────
 * Permutación de los timestamps ENTRE las señales gateadas (semilla): cada
 * señal conserva su papel, su geometría relativa (entrada % debajo del spot,
 * resistencia % arriba de la entrada, riskMult) y recibe la fecha de otra. El
 * spot nuevo es el cierre de la barra horaria de SU papel en la fecha
 * prestada; el ATR es el de ese día. Se preserva el calendario de las señales
 * (cuándo hubo muchas, cuándo pocas) y se rompe el soporte concreto. */
export function mkRnd(seed) { let s = seed >>> 0; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); }
export function barajar(ordenes, ctx, atrDe, rnd, modo = "perm") {
  const base = ordenes.filter((o) => o.spot > 0);
  const tsPool = base.map((o) => o.ts);
  if (modo === "perm") for (let i = tsPool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [tsPool[i], tsPool[j]] = [tsPool[j], tsPool[i]]; }
  const out = [];
  for (let k = 0; k < base.length; k++) {
    const o = base[k];
    const S = ctx.serie[o.sym]; if (!S || !S.length) continue;
    let bar;
    if (modo === "perm") {
      const ts = tsPool[k];
      // barra de SU papel en ese ts (o la anterior más cercana)
      let lo = 0, hi = S.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (S[m].ts <= ts) { r = m; lo = m + 1; } else hi = m - 1; }
      if (r < 0) continue; bar = S[r];
    } else bar = S[Math.floor(rnd() * S.length)];
    const a = atrDe(o.sym, bar.t); if (!(a > 0)) continue;
    const entry = bar.c * (o.entry / o.spot);
    out.push({ ...o, ts: bar.ts, dia: bar.t, entry, res: entry * (o.res / o.entry), atr0: a, spot: bar.c, created: bar.ts * 1000 + 1 });
  }
  out.sort((a, b) => a.created - b.created);
  return out;
}
