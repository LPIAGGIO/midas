/* fino.js — ¿con granularidad más fina, la variable "la barra del fill cerró
 * arriba o abajo del nivel" se vuelve ACCIONABLE?
 *
 * `INFORME-BARRIDO.md` §3 y §5 dejaron el hallazgo más limpio del proyecto y
 * su muerte en la misma página: la variable separa de verdad (p = 0,0998 IS y
 * p = 0,0001 OOS, percentil 95,4 y 100,0 contra el nulo, DSR 0,911) pero se
 * observa al cierre de la hora en la que el bot YA compró, o sea hasta 60
 * minutos tarde, y ejecutarla ahí empeora las dos ventanas y las dos tarifas.
 *
 * La pregunta de este anexo: si en vez de esperar al cierre de la hora se
 * pudiera decidir a los 5, 10 o 15 minutos del fill, ¿el signo se da vuelta?
 *
 * ESTO ES UN ESTUDIO DE FACTIBILIDAD. Contesta si vale la pena conseguir datos
 * finos de verdad, NO si la regla funciona. Ver §1 del informe.
 *
 * Muestra: las señales REALES del libro paper/sombra del bot
 * (`research/backtest-reglas/paper_trades_export.json`), no los trades del
 * backtest de 5 años (de ésos caen ~13 en la ventana de 60 días, no alcanza).
 * Barras: 5m de `research/backtest-reglas/data` (60 días) y 1m de `data-1m`
 * (7 días, bajadas por `bajar1m.js`).
 *
 * Todo local. NO toca el VPS, ni Supabase, ni ninguna tabla viva.
 *
 * Uso:
 *   node fino.js                  → corrida completa → results-fino.json
 *   node fino.js --draws=N        → cambia los sorteos del nulo (default 5000)
 *   node fino.js --sin1m          → saltea el bloque D (control de 1 minuto)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REGLAS = path.join(DIR, "..", "backtest-reglas");
const DATA5 = path.join(REGLAS, "data");
const DATA1 = path.join(DIR, "data-1m");

const ARGS = process.argv.slice(2);
const DRAWS = Number((ARGS.find((a) => a.startsWith("--draws=")) || "").split("=")[1]) || 5000;
const SIN_1M = ARGS.includes("--sin1m");
const SEMILLA = 20260917;

/* ── RNG: mulberry32, la misma semilla de INFORME-NULO / TIMESTOP / BARRIDO ── */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── constantes: idénticas a simulate.js / barrido.js y al worker ── */
const CAPITAL = 7_000_000;
const IVA = 1.21;
const DERECHOS = 0.0005 * IVA;                 // 0,0605% — segunda pata bonificada
const FEE = {
  gold: 0.005 * IVA + DERECHOS,                // 0,6655%
  platinum: 0.003 * IVA + DERECHOS,            // 0,4235%
  black: 0.001 * IVA + DERECHOS,               // 0,1815%
};
const TIERS = ["gold", "platinum", "black"];
const TP_FRAC = 0.5;                           // TP parcial al 50% del camino
const CONFIRM_MIN = 10;                        // confirmación de salida del worker: 10 minutos
const SYM_MAP = { YPFD: "YPF", GGAL: "GGAL" };

/* la grilla de horizontes del enunciado y la grilla completa de offsets que
 * usa el nulo ("un momento al azar dentro de la misma ventana") */
const H_GRID = [5, 10, 15, 20, 30, 45, 60];
const OFFSETS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
const H_GRID_1M = [1, 3, 5, 10];
const OFFSETS_1M = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 30, 45, 60];

/* ── helpers ── */
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function stdev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); }
function cuantil(v, q) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
  return s[lo] + (s[hi] - s[lo]) * (h - lo);
}
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
/* t de Student por beta incompleta — mismo código que barrido.js */
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
const tP2 = (t, df) => (!(df > 0) ? 1 : !isFinite(t) ? 0 : ibeta(df / 2, 0.5, df / (df + t * t)));
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return null;
  const ma = mean(a), mb = mean(b), sa = stdev(a), sb = stdev(b);
  const se = Math.sqrt((sa * sa) / na + (sb * sb) / nb);
  const t = se > 0 ? (ma - mb) / se : 0;
  const df = se > 0 ? ((sa * sa) / na + (sb * sb) / nb) ** 2 / (((sa * sa) / na) ** 2 / (na - 1) + ((sb * sb) / nb) ** 2 / (nb - 1)) : 0;
  return { na, nb, ma, mb, se, t, df, p2: tP2(t, df) };
}
const n0 = (x, d = 0) => (x == null || !isFinite(x) ? "-" : x.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (x, d = 2) => (x == null || !isFinite(x) ? "-" : (x * 100).toFixed(d) + "%");
const ars = (x) => (x == null || !isFinite(x) ? "-" : (x < 0 ? "−$" : "+$") + Math.abs(Math.round(x)).toLocaleString("es-AR"));
/* día de rueda ART (UTC−3) — misma convención que backtest-reglas */
const diaAr = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
/* día de sesión NYSE (ET ≈ UTC−4 en verano; sólo se usa para agrupar la rueda) */
const diaNy = (ms) => new Date(ms - 4 * 3600 * 1000).toISOString().slice(0, 10);

/* ── carga de barras ── */
function cargarBarras(dir) {
  const bars = {};
  if (!fs.existsSync(dir)) return bars;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json") || f.startsWith("_") || f === "ccl.json") continue;
    const sym = f.replace(/\.json$/, "");
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const r = j?.chart?.result?.[0];
      const ts = r?.timestamp || [], q = r?.indicators?.quote?.[0] || {};
      const arr = [];
      for (let i = 0; i < ts.length; i++) {
        const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
        if (o == null || h == null || l == null || c == null) continue;
        arr.push({ t: ts[i] * 1000, o, h, l, c });
      }
      arr.sort((a, b) => a.t - b.t);
      if (arr.length) bars[sym] = arr;
    } catch { /* archivo roto: el símbolo cae como sin-datos */ }
  }
  return bars;
}
function cargarCcl() {
  const p = path.join(DATA5, "ccl.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (j.fallback) return { get: () => j.constant, fallback: true };
  const map = new Map();
  for (const r of j) {
    const v = (Number(r.compra) + Number(r.venta)) / 2 || Number(r.venta) || Number(r.compra);
    if (v > 0) map.set(r.fecha, v);
  }
  return {
    fallback: false,
    get: (dateStr) => {
      let d = new Date(dateStr + "T12:00:00Z");
      for (let i = 0; i < 14; i++) {
        const k = d.toISOString().slice(0, 10);
        if (map.has(k)) return map.get(k);
        d = new Date(d.getTime() - 86400000);
      }
      return 1590;
    },
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * LA MUESTRA
 * ═════════════════════════════════════════════════════════════════════════ */
function construirMuestra(bars5, ccl) {
  const raw = JSON.parse(fs.readFileSync(path.join(REGLAS, "paper_trades_export.json"), "utf8"));
  const censo = { total: raw.length, sinFill: 0, kitInvalido: 0, sinBarras: 0, sinSesion60: 0, qtyCero: 0, usables: 0 };

  /* ratio mediano por símbolo, para los pocos trades sin ratio propio */
  const ratios = {};
  for (const t of raw) {
    if (!(Number(t.ratio) > 0)) continue;
    const s = SYM_MAP[t.sym] || t.sym;
    (ratios[s] = ratios[s] || []).push(Number(t.ratio));
  }
  const ratioMed = {};
  for (const s in ratios) { const a = ratios[s].sort((x, y) => x - y); ratioMed[s] = a[Math.floor(a.length / 2)]; }

  const out = [];
  for (const t of raw) {
    if (!t.entry_ts) { censo.sinFill++; continue; }
    const entry = Number(t.entry_limit), stop = Number(t.stop_inicial), target = Number(t.target);
    if (!(entry > 0 && stop > 0 && target > 0 && stop < entry && target > entry)) { censo.kitInvalido++; continue; }
    const sym = SYM_MAP[t.sym] || t.sym;
    const arr = bars5[sym];
    if (!arr) { censo.sinBarras++; continue; }
    const ft = Date.parse(t.entry_ts);
    /* índice de la primera barra ESTRICTAMENTE posterior al fill: la barra que
     * contiene el fill no se usa para decidir nada (su cierre ya es posterior
     * al fill, pero por menos de 5 minutos: entraría como H<5 encubierto) */
    let i0 = arr.findIndex((b) => b.t > ft);
    if (i0 < 0) { censo.sinBarras++; continue; }
    /* la ventana de decisión (60 minutos) tiene que caber ENTERA en la misma
     * sesión: si el fill es cerca del cierre, el horizonte no es observable ese
     * día y "esperar" significaría cruzar la noche, que es otra cosa */
    const d0 = diaNy(ft);
    const ultSesion = (() => { let u = null; for (let i = i0; i < arr.length && diaNy(arr[i].t) === d0; i++) u = arr[i].t; return u; })();
    if (!(ultSesion && ultSesion - ft >= 60 * 60000)) { censo.sinSesion60++; continue; }
    const qty = Number(t.qty);
    if (!(qty >= 1)) { censo.qtyCero++; continue; }
    const rIn = Number(t.ratio) > 0 ? Number(t.ratio) : (ratioMed[sym] || ccl.get(diaAr(ft)));
    const entryPx = Number(t.entry_price) > 0 ? Number(t.entry_price) : entry;
    out.push({
      id: t.id, sym, ticker: t.ticker, modo: t.modo,
      ft, i0, qty, rIn,
      level: entry,             // el NIVEL: lo que la variable compara contra el precio
      entryPx,                  // el precio al que se llenó de verdad
      stopIni: stop, target,
      R: entry - stop,
      exitReasonLibro: t.exit_reason, statusLibro: t.status,
    });
    censo.usables++;
  }
  out.sort((a, b) => a.ft - b.ft);
  return { trades: out, censo, ratioMed };
}

/* ══════════════════════════════════════════════════════════════════════════
 * EL REPLAY DE UN TRADE, AISLADO, SOBRE BARRAS DE CUALQUIER TAMAÑO
 *   - gestión NUEVA del worker: TP parcial de la mitad al 50% del camino,
 *     trailing desde +2R que nunca baja, stop/target con confirmación de 10
 *     minutos (= 2 barras de 5m, = 10 barras de 1m).
 *   - cutTs: si se pasa, al PRIMER cierre de barra >= cutTs se suelta lo que
 *     quede de la posición a ese cierre ("soltar a los H minutos"). El corte se
 *     evalúa DESPUÉS de la gestión normal de esa barra: si el stop ya se
 *     ejecutó ahí, no hay nada que soltar.
 * ═════════════════════════════════════════════════════════════════════════ */
function replay(tr, arr, confirmBars, cutTs) {
  let qty = tr.qty, stop = tr.stopIni, tpDone = false, tpCand = false, exitCand = 0;
  const legs = [];
  const cerrar = (q, px, ts, reason) => {
    legs.push({ qty: q, exitPx: px, exitTs: ts, reason, intradia: diaAr(tr.ft) === diaAr(ts) });
  };
  let cortado = false;
  for (let i = tr.i0; i < arr.length; i++) {
    const bar = arr[i], c = bar.c;
    /* trailing desde +2R, nunca baja */
    const k = Math.floor((c - tr.entryPx) / tr.R);
    if (k >= 2 && tr.entryPx + (k - 2) * tr.R > stop) stop = tr.entryPx + (k - 2) * tr.R;
    /* TP parcial */
    if (!tpDone && qty >= 2) {
      const nivelTp = tr.entryPx + TP_FRAC * (tr.target - tr.entryPx);
      if (c >= nivelTp && c < tr.target) {
        if (tpCand) {
          const q = Math.floor(qty / 2);
          cerrar(q, c, bar.t, "tp_parcial");
          qty -= q; tpDone = true; tpCand = false;
        } else tpCand = true;
      } else tpCand = false;
    }
    /* salida stop / trailing / target, con confirmación */
    let reason = null;
    if (c <= stop) reason = stop > tr.stopIni ? "trailing" : "stop";
    else if (c >= tr.target) reason = "target";
    if (reason) {
      exitCand++;
      if (exitCand > confirmBars) {
        const exitPx = reason === "target" ? tr.target : Math.min(stop, c);
        cerrar(qty, exitPx, bar.t, reason);
        return { legs, cortado, cerradoEn: bar.t, idxSalida: i };
      }
    } else exitCand = 0;
    /* el corte de horizonte */
    if (cutTs != null && !cortado && bar.t >= cutTs) {
      cerrar(qty, c, bar.t, "soltado");
      cortado = true;
      return { legs, cortado, cerradoEn: bar.t, idxSalida: i };
    }
  }
  /* fin de datos: se marca a mercado en la última barra */
  const last = arr[arr.length - 1];
  cerrar(qty, last.c, last.t, "fin_datos");
  return { legs, cortado, cerradoEn: last.t, idxSalida: arr.length - 1 };
}

/* P&L en ARS de un replay, por tarifa.
 * sinBonifSoltada: la pata "soltado" paga comisión plena aunque sea del mismo
 * día. Sirve para medir cuánto del efecto es señal y cuánto es el mero
 * calendario de la bonificación intradiaria. */
function pnlDe(tr, res, sinBonifSoltada = false) {
  const entN = (q) => q * tr.entryPx * tr.rIn;
  const o = { gold: 0, platinum: 0, black: 0, bruto: 0, notional: 0, fees: { gold: 0, platinum: 0, black: 0 } };
  for (const l of res.legs) {
    const e = entN(l.qty), s = l.qty * l.exitPx * tr.rIn;
    o.bruto += s - e;
    o.notional += e;
    const bonif = l.intradia && !(sinBonifSoltada && l.reason === "soltado");
    for (const tier of TIERS) {
      const f = e * FEE[tier] + s * (bonif ? DERECHOS : FEE[tier]);
      o.fees[tier] += f;
      o[tier] += s - e - f;
    }
  }
  return o;
}

/* métricas de un conjunto de P&L por trade */
function metricasConjunto(pnls, notionales) {
  const tot = {}, res = {};
  const N = pnls.length;
  const notTot = notionales.reduce((s, x) => s + x, 0);
  for (const tier of TIERS) {
    const v = pnls.map((p) => p[tier]);
    const total = v.reduce((s, x) => s + x, 0);
    res[tier] = {
      n: N, total,
      expectancy: N ? total / N : null,
      winRate: N ? v.filter((x) => x > 0).length / N : null,
      retConjunto: notTot > 0 ? total / notTot : null,
      mensualCapital: (total / CAPITAL) * 100,   // sobre $7M, sin anualizar: la ventana son ~1,2 meses
    };
  }
  tot.notional = notTot;
  return { ...res, notional: notTot };
}

/* ══════════════════════════════════════════════════════════════════════════
 * MAIN
 * ═════════════════════════════════════════════════════════════════════════ */
function main() {
  const t0 = Date.now();
  const out = { generado: new Date().toISOString(), semilla: SEMILLA, draws: DRAWS };
  console.log(`=== fino.js · ¿la variable del INFORME-BARRIDO se vuelve accionable con granularidad fina? ===`);
  console.log(`semilla ${SEMILLA} · ${DRAWS} sorteos por celda\n`);

  const ccl = cargarCcl();
  const bars5 = cargarBarras(DATA5);
  console.log(`barras 5m: ${Object.keys(bars5).length} símbolos · ${Object.values(bars5).reduce((s, a) => s + a.length, 0).toLocaleString("es-AR")} barras`);
  const rango5 = (() => { const a = bars5[Object.keys(bars5)[0]]; return [new Date(a[0].t).toISOString().slice(0, 16), new Date(a[a.length - 1].t).toISOString().slice(0, 16)]; })();
  console.log(`  rango: ${rango5[0]} → ${rango5[1]}`);

  const { trades, censo } = construirMuestra(bars5, ccl);
  out.censo = censo;
  console.log(`\n===== 0 · LA MUESTRA =====`);
  console.log(`  registros del libro: ${censo.total}`);
  console.log(`  descartados: sin fill ${censo.sinFill} · kit inválido ${censo.kitInvalido} · sin barras ${censo.sinBarras} · sin 60' de sesión tras el fill ${censo.sinSesion60} · qty<1 ${censo.qtyCero}`);
  console.log(`  USABLES: ${censo.usables}`);
  const porModo = {};
  for (const t of trades) porModo[t.modo] = (porModo[t.modo] || 0) + 1;
  console.log(`  por modo: ${JSON.stringify(porModo)}`);
  const fts = trades.map((t) => t.ft).sort((a, b) => a - b);
  console.log(`  ventana de fills: ${new Date(fts[0]).toISOString().slice(0, 16)} → ${new Date(fts[fts.length - 1]).toISOString().slice(0, 16)}`);
  const syms = new Set(trades.map((t) => t.sym));
  console.log(`  símbolos: ${syms.size}`);
  out.muestra = {
    n: trades.length, porModo, simbolos: syms.size,
    desde: new Date(fts[0]).toISOString(), hasta: new Date(fts[fts.length - 1]).toISOString(),
    rangoBarras5m: rango5,
  };

  /* ── chequeo de arranque: el replay contra el desenlace que registró el libro ── */
  const CONF5 = CONFIRM_MIN / 5;   // 2 barras
  const baseRes = trades.map((tr) => replay(tr, bars5[tr.sym], CONF5, null));
  const basePnl = baseRes.map((r, i) => pnlDe(trades[i], r));
  const notionales = basePnl.map((p) => p.notional);
  const motivo = (r) => r.legs[r.legs.length - 1].reason;
  {
    const cerrados = trades.map((t, i) => ({ t, r: baseRes[i] })).filter((x) => x.t.statusLibro === "closed" && x.t.exitReasonLibro);
    const norm = (s) => (/target/.test(s) ? "target" : /trailing/.test(s) ? "trailing" : /stop/.test(s) ? "stop" : s);
    let ok = 0;
    for (const x of cerrados) if (norm(x.t.exitReasonLibro) === norm(motivo(x.r))) ok++;
    console.log(`  chequeo: motivo de salida del replay 5m vs el que registró el libro → ${ok}/${cerrados.length} (${(100 * ok / cerrados.length).toFixed(1)}%)`);
    out.chequeoMotivo = { ok, n: cerrados.length };
    const cnt = {};
    for (const r of baseRes) cnt[motivo(r)] = (cnt[motivo(r)] || 0) + 1;
    console.log(`  motivos del replay base: ${JSON.stringify(cnt)}`);
    out.motivosBase = cnt;
  }

  /* ════════════════ BLOQUE A · la variable a 5 minutos ════════════════ */
  console.log(`\n===== A · LA VARIABLE RECONSTRUIDA A 5 MINUTOS =====`);
  /* veredicto(h) = ¿el cierre de la primera barra con t >= fill+h está arriba
   * del nivel? (true = arriba). Es la versión fina de "la barra del fill cerró
   * arriba del nivel" de INFORME-BARRIDO §3. */
  function barraEn(arr, i0, ft, offsetMin) {
    const objetivo = ft + offsetMin * 60000;
    for (let i = i0; i < arr.length; i++) if (arr[i].t >= objetivo) return i;
    return -1;
  }
  function veredictos(tr, arr, offs) {
    const v = {};
    for (const h of offs) {
      const i = barraEn(arr, tr.i0, tr.ft, h);
      v[h] = i < 0 ? null : { idx: i, ts: arr[i].t, arriba: arr[i].c >= tr.level, c: arr[i].c, lagReal: (arr[i].t - tr.ft) / 60000 };
    }
    return v;
  }
  const VER = trades.map((tr) => veredictos(tr, bars5[tr.sym], OFFSETS));

  /* el veredicto de la HORA DE RELOJ, que es el que mide INFORME-BARRIDO:
   * el fill cae dentro de una barra horaria y la variable se observa al cierre
   * de ESA barra, o sea entre 0 y 60 minutos después (≈30 en promedio) */
  const VER_HORA = trades.map((tr, k) => {
    const arr = bars5[tr.sym];
    const cierreHora = Math.ceil((tr.ft + 1) / 3600000) * 3600000;   // próximo :00 UTC
    const i = barraEn(arr, tr.i0, tr.ft, (cierreHora - tr.ft) / 60000);
    if (i < 0) return null;
    return { idx: i, ts: arr[i].t, arriba: arr[i].c >= tr.level, lagReal: (arr[i].t - tr.ft) / 60000 };
  });
  {
    const lags = VER_HORA.filter(Boolean).map((v) => v.lagReal);
    console.log(`  lag del veredicto "cierre de la hora de reloj" (el de INFORME-BARRIDO): p25 ${cuantil(lags, .25).toFixed(0)}' · mediana ${cuantil(lags, .5).toFixed(0)}' · p75 ${cuantil(lags, .75).toFixed(0)}' · n=${lags.length}`);
    out.lagHoraReloj = { p25: cuantil(lags, .25), p50: cuantil(lags, .5), p75: cuantil(lags, .75), n: lags.length };
  }

  /* A.1 · tiempo hasta determinación: el primer h de la grilla de 5' a partir
   * del cual el veredicto ya no cambia hasta el minuto 60 */
  const detMin = [], concord60 = {}, flips = [];
  for (const h of OFFSETS) concord60[h] = 0;
  let nDet = 0;
  for (let k = 0; k < trades.length; k++) {
    const v = VER[k];
    if (!v[60]) continue;
    const final = v[60].arriba;
    let det = 60, cambios = 0;
    for (let j = OFFSETS.length - 1; j >= 0; j--) {
      const h = OFFSETS[j];
      if (!v[h]) break;
      if (v[h].arriba === final) det = h; else break;
    }
    for (let j = 1; j < OFFSETS.length; j++) if (v[OFFSETS[j]] && v[OFFSETS[j - 1]] && v[OFFSETS[j]].arriba !== v[OFFSETS[j - 1]].arriba) cambios++;
    detMin.push(det); flips.push(cambios); nDet++;
    for (const h of OFFSETS) if (v[h] && v[h].arriba === final) concord60[h]++;
  }
  detMin.sort((a, b) => a - b);
  const A1 = {
    n: nDet,
    p25: cuantil(detMin, .25), mediana: cuantil(detMin, .5), p75: cuantil(detMin, .75), p90: cuantil(detMin, .9),
    media: mean(detMin),
    det5: detMin.filter((x) => x === 5).length,
    flipsMedia: mean(flips), flipsCero: flips.filter((x) => x === 0).length,
  };
  console.log(`  tiempo-hasta-determinación (minutos desde el fill; el veredicto ya no cambia hasta el minuto 60), n=${nDet}:`);
  console.log(`    p25 ${A1.p25.toFixed(0)}' · MEDIANA ${A1.mediana.toFixed(0)}' · p75 ${A1.p75.toFixed(0)}' · p90 ${A1.p90.toFixed(0)}' · media ${A1.media.toFixed(1)}'`);
  console.log(`    determinado ya en la 1ª barra (5'): ${A1.det5}/${nDet} (${pct(A1.det5 / nDet, 1)}) · sin ningún cambio de signo en los 60': ${A1.flipsCero}/${nDet} · cambios de signo promedio ${A1.flipsMedia.toFixed(2)}`);
  console.log(`  concordancia del veredicto a los H' con el veredicto del minuto 60:`);
  const filasConc = OFFSETS.map((h) => ({ h, conc: concord60[h] / nDet }));
  console.log(`    ${filasConc.map((f) => `${f.h}'→${pct(f.conc, 1)}`).join(" · ")}`);
  /* concordancia contra el veredicto de la hora de reloj */
  const concHora = {};
  for (const h of OFFSETS) concHora[h] = 0;
  let nHora = 0;
  for (let k = 0; k < trades.length; k++) {
    const vh = VER_HORA[k];
    if (!vh) continue;
    nHora++;
    for (const h of OFFSETS) if (VER[k][h] && VER[k][h].arriba === vh.arriba) concHora[h]++;
  }
  console.log(`  concordancia del veredicto a los H' con el de la HORA DE RELOJ (n=${nHora}):`);
  console.log(`    ${OFFSETS.map((h) => `${h}'→${pct(concHora[h] / nHora, 1)}`).join(" · ")}`);
  /* reparto arriba/abajo en cada H */
  const reparto = {};
  for (const h of OFFSETS) {
    const vs = VER.map((v) => v[h]).filter(Boolean);
    reparto[h] = { n: vs.length, arriba: vs.filter((v) => v.arriba).length };
  }
  console.log(`  reparto arriba/abajo: ${OFFSETS.map((h) => `${h}'→${reparto[h].arriba}/${reparto[h].n}`).join(" · ")}`);
  out.A = { determinacion: A1, concordancia60: filasConc, concordanciaHora: OFFSETS.map((h) => ({ h, conc: concHora[h] / nHora })), reparto, distribucion: detMin };

  /* ════════════════ la matriz de soltadas forzadas ════════════════
   * P[k][h] = P&L del trade k si se lo suelta SÍ O SÍ al primer cierre >= fill+h.
   * Si para entonces ya salió solo (stop/target), el resultado es el base.
   * Con esta matriz se arma todo: el bloque B, el nulo del C y el control D. */
  function matrizSoltadas(trades, bars, confirmBars, offs, verd) {
    const M = {};
    for (const h of offs) {
      M[h] = trades.map((tr, k) => {
        const v = verd[k][h];
        if (!v) return null;
        const r = replay(tr, bars[tr.sym], confirmBars, v.ts);
        return { pnl: pnlDe(tr, r), pnlSinBonif: pnlDe(tr, r, true), solto: r.cortado, motivo: r.legs[r.legs.length - 1].reason };
      });
    }
    return M;
  }
  const M5 = matrizSoltadas(trades, bars5, CONF5, OFFSETS, VER);

  /* chequeo de consistencia interna: si no se soltó (porque ya había salido),
   * el P&L tiene que ser idéntico al base */
  {
    let iguales = 0, chequeados = 0;
    for (const h of OFFSETS) for (let k = 0; k < trades.length; k++) {
      const m = M5[h][k];
      if (!m || m.solto) continue;
      chequeados++;
      if (Math.abs(m.pnl.gold - basePnl[k].gold) < 1e-6) iguales++;
    }
    console.log(`  chequeo: soltadas que no llegaron a ejecutarse reproducen el base → ${iguales}/${chequeados}`);
    out.chequeoMatriz = { iguales, chequeados };
  }

  /* ════════════════ BLOQUE B · el barrido de horizontes ════════════════ */
  console.log(`\n===== B · BARRIDO DE HORIZONTES (soltar si a los H' el precio está ABAJO del nivel) =====`);
  const mBase = metricasConjunto(basePnl, notionales);
  console.log(`  BASE (no hacer nada): n=${mBase.gold.n} · nocional $${n0(mBase.notional)} `);
  for (const tier of TIERS) {
    const m = mBase[tier];
    console.log(`    ${tier.padEnd(9)} total ${ars(m.total)} · retorno del conjunto ${pct(m.retConjunto, 3)} · expectancy ${ars(m.expectancy)} · win ${pct(m.winRate, 1)}`);
  }

  function aplicarRegla(h, verd, M, idxs, sinBonif = false) {
    /* la regla: si a los h' el precio está ABAJO del nivel → soltar; si no, base */
    const pnls = [], nots = [], sueltos = [];
    for (const k of idxs) {
      const v = verd[k][h];
      if (!v) { pnls.push(basePnl[k]); nots.push(notionales[k]); continue; }
      if (v.arriba) { pnls.push(basePnl[k]); nots.push(notionales[k]); }
      else {
        const m = M[h][k], p = sinBonif ? m.pnlSinBonif : m.pnl;
        pnls.push(p); nots.push(p.notional);
        if (m.solto) sueltos.push(k);
      }
    }
    return { m: metricasConjunto(pnls, nots), sueltos, pnls };
  }

  const idxTodos = trades.map((_, i) => i);
  const B = { base: mBase, filas: [] };
  console.log(`\n  H(min) | soltados |    Gold: ret / exp / win / Δret   |   Platinum Δret |   Black: ret / exp / win / Δret`);
  for (const h of H_GRID) {
    const r = aplicarRegla(h, VER, M5, idxTodos);
    const fila = { h, soltados: r.sueltos.length, abajo: reparto[h].n - reparto[h].arriba };
    for (const tier of TIERS) {
      fila[tier] = {
        total: r.m[tier].total, ret: r.m[tier].retConjunto, exp: r.m[tier].expectancy, win: r.m[tier].winRate,
        dRet: r.m[tier].retConjunto - mBase[tier].retConjunto,
        dExp: r.m[tier].expectancy - mBase[tier].expectancy,
        dTotal: r.m[tier].total - mBase[tier].total,
      };
    }
    /* descomposición del delta: ¿cuánto es precio (bruto) y cuánto es el
     * calendario de la comisión (la pata soltada es intradiaria y por eso
     * bonificada, mientras que el base sale días después y paga plena)? */
    const brutoBase = r.sueltos.reduce((s, k) => s + basePnl[k].bruto, 0);
    const brutoRegla = r.sueltos.reduce((s, k) => s + M5[h][k].pnl.bruto, 0);
    const feeBase = r.sueltos.reduce((s, k) => s + basePnl[k].fees.gold, 0);
    const feeRegla = r.sueltos.reduce((s, k) => s + M5[h][k].pnl.fees.gold, 0);
    fila.descomposicion = { dBruto: brutoRegla - brutoBase, dFeeGold: feeBase - feeRegla, dTotalGold: fila.gold.dTotal };
    const rSB = aplicarRegla(h, VER, M5, idxTodos, true);
    fila.sinBonif = { goldRet: rSB.m.gold.retConjunto, goldDRet: rSB.m.gold.retConjunto - mBase.gold.retConjunto, blackDRet: rSB.m.black.retConjunto - mBase.black.retConjunto };
    B.filas.push(fila);
    console.log(`  ${String(h).padStart(6)} | ${String(fila.soltados).padStart(8)} | ${pct(fila.gold.ret, 3).padStart(8)} ${ars(fila.gold.exp).padStart(10)} ${pct(fila.gold.win, 1).padStart(6)} ${pct(fila.gold.dRet, 3).padStart(8)} | ${pct(fila.platinum.dRet, 3).padStart(8)} | ${pct(fila.black.ret, 3).padStart(8)} ${ars(fila.black.exp).padStart(10)} ${pct(fila.black.win, 1).padStart(6)} ${pct(fila.black.dRet, 3).padStart(8)}`);
  }
  console.log(`\n  Descomposición del delta Gold (sólo sobre los trades soltados) y variante SIN bonificación intradiaria en la soltada:`);
  console.log(`  H(min) | Δ total Gold | de eso, Δ bruto | de eso, Δ comisión | Δret Gold sin bonif | Δret Black sin bonif`);
  for (const f of B.filas) {
    console.log(`  ${String(f.h).padStart(6)} | ${ars(f.descomposicion.dTotalGold).padStart(12)} | ${ars(f.descomposicion.dBruto).padStart(15)} | ${ars(f.descomposicion.dFeeGold).padStart(18)} | ${pct(f.sinBonif.goldDRet, 3).padStart(19)} | ${pct(f.sinBonif.blackDRet, 3).padStart(20)}`);
  }

  /* partición 30/30: NO es un walk-forward de verdad (una sola ventana de
   * régimen, y la segunda mitad se mira igual), pero al menos dice si el signo
   * del delta aguanta partiendo la muestra en dos por fecha de fill */
  {
    const orden = idxTodos.slice().sort((a, b) => trades[a].ft - trades[b].ft);
    const corte = Math.floor(orden.length / 2);
    const mitades = { primera: orden.slice(0, corte), segunda: orden.slice(corte) };
    B.split = { corteFecha: new Date(trades[orden[corte]].ft).toISOString().slice(0, 10), filas: [] };
    console.log(`\n  Partición 30/30 por fecha de fill (corte ${B.split.corteFecha}; n ${mitades.primera.length} / ${mitades.segunda.length}) — INDICATIVO, no es walk-forward:`);
    console.log(`  H(min) | 1ª mitad: base→regla Gold (Δ) | 2ª mitad: base→regla Gold (Δ)`);
    for (const h of H_GRID) {
      const f = { h };
      for (const [nom, idxs] of Object.entries(mitades)) {
        const b = metricasConjunto(idxs.map((k) => basePnl[k]), idxs.map((k) => notionales[k]));
        const r = aplicarRegla(h, VER, M5, idxs);
        f[nom] = { n: idxs.length, base: b.gold.retConjunto, regla: r.m.gold.retConjunto, d: r.m.gold.retConjunto - b.gold.retConjunto, dBlack: r.m.black.retConjunto - b.black.retConjunto, soltados: r.sueltos.length };
      }
      B.split.filas.push(f);
      console.log(`  ${String(h).padStart(6)} | ${pct(f.primera.base, 3).padStart(8)} → ${pct(f.primera.regla, 3).padStart(8)} (${pct(f.primera.d, 3)}) | ${pct(f.segunda.base, 3).padStart(8)} → ${pct(f.segunda.regla, 3).padStart(8)} (${pct(f.segunda.d, 3)})`);
    }
  }

  /* el chequeo de consistencia con INFORME-BARRIDO: el veredicto de la HORA DE
   * RELOJ, que es exactamente el que mide el informe anterior */
  {
    const pnls = [], nots = [];
    let sueltos = 0;
    for (let k = 0; k < trades.length; k++) {
      const vh = VER_HORA[k];
      if (!vh || vh.arriba) { pnls.push(basePnl[k]); nots.push(notionales[k]); continue; }
      const r = replay(trades[k], bars5[trades[k].sym], CONF5, vh.ts);
      const p = pnlDe(trades[k], r);
      pnls.push(p); nots.push(p.notional);
      if (r.cortado) sueltos++;
    }
    const m = metricasConjunto(pnls, nots);
    B.cierreHora = { soltados: sueltos };
    for (const tier of TIERS) B.cierreHora[tier] = { ret: m[tier].retConjunto, exp: m[tier].expectancy, win: m[tier].winRate, dRet: m[tier].retConjunto - mBase[tier].retConjunto };
    console.log(`\n  CHEQUEO DE CONSISTENCIA · veredicto al cierre de la HORA DE RELOJ (lo que mide INFORME-BARRIDO §5; lag mediano ${out.lagHoraReloj.p50.toFixed(0)}'):`);
    console.log(`    soltados ${sueltos} · Gold ret ${pct(B.cierreHora.gold.ret, 3)} (Δ ${pct(B.cierreHora.gold.dRet, 3)}) · Black ret ${pct(B.cierreHora.black.ret, 3)} (Δ ${pct(B.cierreHora.black.dRet, 3)})`);
  }

  /* corte crudo, sin costo de ejecución: "quedarse sólo con los que están
   * arriba del nivel a los H'", para separar señal de costo (es el corte
   * GRATIS de INFORME-BARRIDO §5, que no es implementable) */
  B.gratis = [];
  for (const h of H_GRID) {
    const idxArriba = idxTodos.filter((k) => VER[k][h] && VER[k][h].arriba);
    const idxAbajo = idxTodos.filter((k) => VER[k][h] && !VER[k][h].arriba);
    const mA = metricasConjunto(idxArriba.map((k) => basePnl[k]), idxArriba.map((k) => notionales[k]));
    const mB2 = metricasConjunto(idxAbajo.map((k) => basePnl[k]), idxAbajo.map((k) => notionales[k]));
    const w = welch(idxArriba.map((k) => basePnl[k].gold), idxAbajo.map((k) => basePnl[k].gold));
    B.gratis.push({
      h, nArriba: idxArriba.length, nAbajo: idxAbajo.length,
      goldArriba: mA.gold.expectancy, goldAbajo: mB2.gold.expectancy,
      retArriba: mA.gold.retConjunto, retAbajo: mB2.gold.retConjunto,
      winArriba: mA.gold.winRate, winAbajo: mB2.gold.winRate,
      t: w ? w.t : null, p: w ? w.p2 : null,
    });
  }
  console.log(`\n  El corte GRATIS (no soltar: directamente no tener los de abajo) — separa señal de costo:`);
  console.log(`  H(min) | n arriba/abajo | Gold exp arriba | Gold exp abajo |  win arr/ab  |     p (Welch)`);
  for (const g of B.gratis) {
    console.log(`  ${String(g.h).padStart(6)} | ${String(g.nArriba).padStart(6)}/${String(g.nAbajo).padEnd(7)} | ${ars(g.goldArriba).padStart(15)} | ${ars(g.goldAbajo).padStart(14)} | ${pct(g.winArriba, 0).padStart(5)}/${pct(g.winAbajo, 0).padEnd(5)} | ${g.p != null ? g.p.toFixed(4) : "-"}`);
  }
  out.B = B;

  /* ════════════════ BLOQUE C · el nulo ════════════════ */
  console.log(`\n===== C · EL NULO (soltar la misma cantidad, al azar, en un momento al azar de la ventana) =====`);
  const rnd = mulberry32(SEMILLA);
  function nulo(h, K, metricaReal, modo) {
    /* modo "libre": trades al azar Y momento al azar dentro de los 60'
     * modo "mismoH": trades al azar, pero soltados exactamente a los h' */
    const dist = { gold: [], black: [] };
    const n = trades.length;
    const orden = idxTodos.slice();
    for (let d = 0; d < DRAWS; d++) {
      /* Fisher-Yates parcial para elegir K índices sin reemplazo */
      for (let i = 0; i < K; i++) {
        const j = i + Math.floor(rnd() * (n - i));
        const tmp = orden[i]; orden[i] = orden[j]; orden[j] = tmp;
      }
      const sel = new Set(orden.slice(0, K));
      const pnls = [], nots = [];
      for (const k of idxTodos) {
        if (!sel.has(k)) { pnls.push(basePnl[k]); nots.push(notionales[k]); continue; }
        const hh = modo === "libre" ? OFFSETS[Math.floor(rnd() * OFFSETS.length)] : h;
        const m = M5[hh][k];
        if (!m) { pnls.push(basePnl[k]); nots.push(notionales[k]); continue; }
        pnls.push(m.pnl); nots.push(m.pnl.notional);
      }
      const m = metricasConjunto(pnls, nots);
      dist.gold.push(m.gold.retConjunto);
      dist.black.push(m.black.retConjunto);
    }
    const res = {};
    for (const tier of ["gold", "black"]) {
      const d = dist[tier].slice().sort((a, b) => a - b);
      const real = metricaReal[tier];
      let menores = 0;
      for (const x of d) if (x < real) menores++;
      res[tier] = {
        mediana: cuantil(d, .5), p5: cuantil(d, .05), p95: cuantil(d, .95),
        percentil: menores / d.length,
        p1cola: 1 - menores / d.length,
      };
    }
    return res;
  }
  const C = { modo: "aislado", draws: DRAWS, filas: [] };
  console.log(`  H(min) | K soltados |  Gold real | Gold mediana nulo | percentil | p(1 cola) || Black percentil | p(1 cola)`);
  for (const h of H_GRID) {
    const r = aplicarRegla(h, VER, M5, idxTodos);
    const real = { gold: r.m.gold.retConjunto, black: r.m.black.retConjunto };
    const nl = nulo(h, r.sueltos.length, real, "libre");
    const nm = nulo(h, r.sueltos.length, real, "mismoH");
    const fila = { h, K: r.sueltos.length, real, libre: nl, mismoH: nm };
    C.filas.push(fila);
    console.log(`  ${String(h).padStart(6)} | ${String(fila.K).padStart(10)} | ${pct(real.gold, 3).padStart(10)} | ${pct(nl.gold.mediana, 3).padStart(17)} | ${pct(nl.gold.percentil, 1).padStart(9)} | ${nl.gold.p1cola.toFixed(4).padStart(9)} || ${pct(nl.black.percentil, 1).padStart(15)} | ${nl.black.p1cola.toFixed(4)}`);
  }
  console.log(`  (nulo "mismo H", que aísla la SELECCIÓN de la ventaja de soltar temprano en general):`);
  for (const f of C.filas) console.log(`    H=${String(f.h).padStart(2)}' · Gold percentil ${pct(f.mismoH.gold.percentil, 1).padStart(6)} (p ${f.mismoH.gold.p1cola.toFixed(4)}) · Black percentil ${pct(f.mismoH.black.percentil, 1).padStart(6)} (p ${f.mismoH.black.p1cola.toFixed(4)})`);
  out.C = C;

  /* ════════════════ BLOQUE D · control a 1 minuto ════════════════ */
  out.D = null;
  if (!SIN_1M) {
    console.log(`\n===== D · CONTROL A 1 MINUTO (última semana) =====`);
    const bars1 = cargarBarras(DATA1);
    if (!Object.keys(bars1).length) {
      console.log(`  no hay barras de 1m en ${DATA1} — corré primero: node bajar1m.js`);
    } else {
      const nB = Object.values(bars1).reduce((s, a) => s + a.length, 0);
      const un = bars1[Object.keys(bars1)[0]];
      console.log(`  barras 1m: ${Object.keys(bars1).length} símbolos · ${nB.toLocaleString("es-AR")} barras · rango ${new Date(un[0].t).toISOString().slice(0, 16)} → ${new Date(un[un.length - 1].t).toISOString().slice(0, 16)}`);
      /* submuestra: trades cuyo fill cae dentro de la cobertura de 1m y que
       * tienen 60' de sesión por delante en la serie de 1m */
      const sub = [];
      for (const tr of trades) {
        const arr = bars1[tr.sym];
        if (!arr) continue;
        if (tr.ft < arr[0].t || tr.ft > arr[arr.length - 1].t) continue;
        const i0 = arr.findIndex((b) => b.t > tr.ft);
        if (i0 < 0) continue;
        const d0 = diaNy(tr.ft);
        let ult = null;
        for (let i = i0; i < arr.length && diaNy(arr[i].t) === d0; i++) ult = arr[i].t;
        if (!(ult && ult - tr.ft >= 60 * 60000)) continue;
        sub.push({ ...tr, i0 });
      }
      console.log(`  trades usables con 1m: ${sub.length} (de ${trades.length} de la muestra de 5m)`);
      if (sub.length < 10) {
        console.log(`  n demasiado chico: se reporta el conteo y nada más`);
        out.D = { n: sub.length, suficiente: false };
      } else {
        const CONF1 = CONFIRM_MIN;       // 10 barras de 1m = 10 minutos
        const VER1 = sub.map((tr) => veredictos(tr, bars1[tr.sym], OFFSETS_1M));
        const base1 = sub.map((tr) => replay(tr, bars1[tr.sym], CONF1, null));
        const basePnl1 = base1.map((r, i) => pnlDe(sub[i], r));
        const not1 = basePnl1.map((p) => p.notional);
        const M1 = matrizSoltadas(sub, bars1, CONF1, OFFSETS_1M, VER1);
        const mB1 = metricasConjunto(basePnl1, not1);
        /* determinación a 1 minuto */
        const det1 = [];
        for (let k = 0; k < sub.length; k++) {
          const v = VER1[k];
          if (!v[60]) continue;
          const final = v[60].arriba;
          let det = 60;
          for (let j = OFFSETS_1M.length - 1; j >= 0; j--) {
            const h = OFFSETS_1M[j];
            if (!v[h]) break;
            if (v[h].arriba === final) det = h; else break;
          }
          det1.push(det);
        }
        det1.sort((a, b) => a - b);
        console.log(`  tiempo-hasta-determinación a 1m (n=${det1.length}): p25 ${cuantil(det1, .25).toFixed(0)}' · MEDIANA ${cuantil(det1, .5).toFixed(0)}' · p75 ${cuantil(det1, .75).toFixed(0)}' · p90 ${cuantil(det1, .9).toFixed(0)}'`);
        console.log(`  BASE 1m: n=${mB1.gold.n} · Gold ret ${pct(mB1.gold.retConjunto, 3)} · exp ${ars(mB1.gold.expectancy)} · win ${pct(mB1.gold.winRate, 1)}`);
        const idx1 = sub.map((_, i) => i);
        const filas1 = [];
        console.log(`  H(min) | soltados | Gold ret |   Δ Gold |  Gold exp | win  || Black ret |  Δ Black || descomposición`);
        for (const h of [...H_GRID_1M, 15, 30, 60]) {
          const pnls = [], nots = [], pnlsSB = [], notsSB = [];
          let sueltos = 0, dBruto = 0, dFee = 0;
          for (const k of idx1) {
            const v = VER1[k][h];
            const m = M1[h] ? M1[h][k] : null;
            if (!v || v.arriba || !m) { pnls.push(basePnl1[k]); nots.push(not1[k]); pnlsSB.push(basePnl1[k]); notsSB.push(not1[k]); continue; }
            pnls.push(m.pnl); nots.push(m.pnl.notional);
            pnlsSB.push(m.pnlSinBonif); notsSB.push(m.pnlSinBonif.notional);
            if (m.solto) { sueltos++; dBruto += m.pnl.bruto - basePnl1[k].bruto; dFee += basePnl1[k].fees.gold - m.pnl.fees.gold; }
          }
          const m = metricasConjunto(pnls, nots), mSB = metricasConjunto(pnlsSB, notsSB);
          const f = {
            h, soltados: sueltos,
            gold: { ret: m.gold.retConjunto, exp: m.gold.expectancy, win: m.gold.winRate, dRet: m.gold.retConjunto - mB1.gold.retConjunto },
            black: { ret: m.black.retConjunto, exp: m.black.expectancy, win: m.black.winRate, dRet: m.black.retConjunto - mB1.black.retConjunto },
            platinum: { ret: m.platinum.retConjunto, dRet: m.platinum.retConjunto - mB1.platinum.retConjunto },
            descomposicion: { dBruto, dFeeGold: dFee },
            sinBonif: { goldDRet: mSB.gold.retConjunto - mB1.gold.retConjunto, blackDRet: mSB.black.retConjunto - mB1.black.retConjunto },
          };
          filas1.push(f);
          console.log(`  ${String(h).padStart(6)} | ${String(sueltos).padStart(8)} | ${pct(f.gold.ret, 3).padStart(8)} | ${pct(f.gold.dRet, 3).padStart(8)} | ${ars(f.gold.exp).padStart(9)} | ${pct(f.gold.win, 0).padStart(4)} || ${pct(f.black.ret, 3).padStart(9)} | ${pct(f.black.dRet, 3).padStart(8)} || sin bonif Δgold ${pct(f.sinBonif.goldDRet, 3).padStart(8)} · Δblack ${pct(f.sinBonif.blackDRet, 3).padStart(8)} · Δbruto ${ars(dBruto)} vs Δcomisión ${ars(dFee)}`);
        }
        /* corte gratis a 1m, para ver si la señal cruda sigue estando */
        const gratis1 = [];
        for (const h of [...H_GRID_1M, 15, 30, 60]) {
          const a = idx1.filter((k) => VER1[k][h] && VER1[k][h].arriba);
          const b = idx1.filter((k) => VER1[k][h] && !VER1[k][h].arriba);
          if (a.length < 2 || b.length < 2) { gratis1.push({ h, nArriba: a.length, nAbajo: b.length }); continue; }
          const w = welch(a.map((k) => basePnl1[k].gold), b.map((k) => basePnl1[k].gold));
          gratis1.push({
            h, nArriba: a.length, nAbajo: b.length,
            expArriba: mean(a.map((k) => basePnl1[k].gold)), expAbajo: mean(b.map((k) => basePnl1[k].gold)),
            t: w.t, p: w.p2,
          });
        }
        console.log(`  corte GRATIS a 1m (arriba vs abajo, sin costo de soltar):`);
        for (const g of gratis1) console.log(`    H=${String(g.h).padStart(2)}' · n ${g.nArriba}/${g.nAbajo} · Gold exp ${ars(g.expArriba)} vs ${ars(g.expAbajo)} · p ${g.p != null ? g.p.toFixed(4) : "-"}`);
        out.D = {
          n: sub.length, suficiente: true,
          rango1m: [new Date(un[0].t).toISOString(), new Date(un[un.length - 1].t).toISOString()],
          determinacion: { n: det1.length, p25: cuantil(det1, .25), mediana: cuantil(det1, .5), p75: cuantil(det1, .75), p90: cuantil(det1, .9) },
          base: mB1, filas: filas1, gratis: gratis1,
        };
      }
    }
  }

  /* ════════════════ DSR · N de 160 a 172 ════════════════ */
  console.log(`\n===== E · DSR · N de 160 a 172 =====`);
  const prev = JSON.parse(fs.readFileSync(path.join(DIR, "results-barrido.json"), "utf8"));
  const Nprev = prev.dsr.N, sigG = prev.dsr.sigmaSR, sigB = prev.dsr.sigmaSRblack;
  /* configuraciones NUEVAS que este informe miró: 7 H de la grilla de 5m + el
   * veredicto de la hora de reloj + 4 H de la grilla de 1m = 12 */
  const nNuevas = H_GRID.length + 1 + H_GRID_1M.length;
  const N = Nprev + nNuevas;
  const gamma = 0.5772156649;
  const sr0De = (sig, NN) => sig * ((1 - gamma) * normInv(1 - 1 / NN) + gamma * normInv(1 - 1 / (NN * Math.E)));
  console.log(`  N ${Nprev} → ${N} (+${nNuevas}: ${H_GRID.length} horizontes de 5m + 1 veredicto de hora de reloj + ${H_GRID_1M.length} horizontes de 1m)`);
  console.log(`  σ(SR) se deja en la del informe anterior (gold ${sigG.toExponential(4)} · black ${sigB.toExponential(4)}): las configuraciones nuevas`);
  console.log(`  corren sobre OTRA muestra (60 días del libro paper) y su Sharpe no está en la misma base, así que suman al N pero no a σ.`);
  /* re-deflactado exacto de las corridas del informe anterior: como sólo cambia
   * SR0, se invierte el z del DSR publicado y se lo vuelve a evaluar */
  const recal = {};
  for (const [nombre, f] of Object.entries(prev.dsr.filas)) {
    const row = { sharpeGold: f.sharpeGold, sharpeBlack: f.sharpeBlack, dsrGoldPrev: f.dsrGold, dsrBlackPrev: f.dsrBlack };
    for (const [tier, sig, sh, d] of [["gold", sigG, f.sharpeGold, f.dsrGold], ["black", sigB, f.sharpeBlack, f.dsrBlack]]) {
      if (d == null || sh == null) { row[tier === "gold" ? "dsrGold" : "dsrBlack"] = null; continue; }
      const srD = sh / Math.sqrt(252);
      const s0v = sr0De(sig, Nprev), s0n = sr0De(sig, N);
      const dc = Math.min(Math.max(d, 1e-12), 1 - 1e-12);
      const z = normInv(dc);
      const k = z / (srD - s0v);                 // = sqrt(n−1)/den, invariante al N
      row[tier === "gold" ? "dsrGold" : "dsrBlack"] = normCdf((srD - s0n) * k);
    }
    recal[nombre] = row;
  }
  const mejores = Object.entries(recal).sort((a, b) => (b[1].dsrBlack || 0) - (a[1].dsrBlack || 0)).slice(0, 5);
  console.log(`  re-deflactado de las corridas del informe anterior (sólo cambia SR0):`);
  for (const [nombre, r] of mejores) {
    console.log(`    ${nombre.padEnd(36)} black SR ${r.sharpeBlack != null ? r.sharpeBlack.toFixed(2).padStart(5) : "  -  "} · DSR ${r.dsrBlackPrev != null ? r.dsrBlackPrev.toFixed(4) : "-"} → ${r.dsrBlack != null ? r.dsrBlack.toFixed(4) : "-"} · gold DSR ${r.dsrGoldPrev != null ? r.dsrGoldPrev.toFixed(4) : "-"} → ${r.dsrGold != null ? r.dsrGold.toFixed(4) : "-"}`);
  }
  out.dsr = { Nprev, N, nNuevas, sigmaSR: sigG, sigmaSRblack: sigB, sr0PrevGold: sr0De(sigG, Nprev), sr0Gold: sr0De(sigG, N), sr0PrevBlack: sr0De(sigB, Nprev), sr0Black: sr0De(sigB, N), recalculo: recal };

  /* ── huella de reproducibilidad ── */
  const digest = (() => {
    const nums = [];
    const walk = (o) => {
      if (o == null) return;
      if (typeof o === "number") { nums.push(o); return; }
      if (Array.isArray(o)) { for (const x of o) walk(x); return; }
      if (typeof o === "object") { for (const k of Object.keys(o).sort()) { if (k === "generado") continue; walk(o[k]); } }
    };
    walk({ A: out.A, B: out.B, C: out.C, D: out.D, dsr: out.dsr });
    let h = 2166136261 >>> 0;
    for (const v of nums) {
      const s = Number.isFinite(v) ? v.toExponential(12) : String(v);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { nNumeros: nums.length, fnv1a: h.toString(16) };
  })();
  out.digest = digest;
  console.log(`\nhuella de reproducibilidad: ${digest.nNumeros} números · FNV-1a ${digest.fnv1a}`);

  out.trades = trades.map((t, i) => ({
    sym: t.sym, modo: t.modo, ft: new Date(t.ft).toISOString(), level: t.level, entryPx: t.entryPx,
    qty: t.qty, motivoBase: motivo(baseRes[i]), goldBase: basePnl[i].gold,
    ver: Object.fromEntries(OFFSETS.map((h) => [h, VER[i][h] ? (VER[i][h].arriba ? 1 : 0) : null])),
    verHora: VER_HORA[i] ? (VER_HORA[i].arriba ? 1 : 0) : null,
  }));
  fs.writeFileSync(path.join(DIR, "results-fino.json"), JSON.stringify(out, null, 1));
  console.log(`\nlisto en ${((Date.now() - t0) / 1000).toFixed(1)}s → results-fino.json`);
}

main();
