// analizar.mjs — compara el P&L del libro sombra (simulacion original) contra la re-ejecucion
// con el libro real del CEDEAR (estricto: c_ask<=L / c_bid>=T ; laxo: c_last con volumen).
// Entrada: data/sim.csv, data/strict.csv, data/laxo.csv (ver validar.sql, sim.sql, data/extraer.mjs)
// Salida: data/resultados.json + resumen por consola.
import fs from "node:fs";

const D = new URL("./data/", import.meta.url);
const FEE = 0.0005 * 1.21;          // derechos de mercado Cocos por punta (0,121% ida y vuelta)
const COB_MIN = 0.8;                // cobertura minima del log para dar por verificada una NO-ejecucion

const rd = (f) => fs.readFileSync(new URL(f, D), "utf8").trim().split("\n").map((l) => l.split(","));
const ts = (s) => s ? new Date(Date.UTC(2026, +s.slice(0, 2) - 1, +s.slice(2, 4), +s.slice(5, 7), +s.slice(7, 9), +s.slice(9, 11))) : null;
const num = (s) => (s === "" || s == null ? null : Number(s));

// ---------- simulacion original ----------
const sim = new Map();
for (const r of rd("sim.csv")) {
  sim.set(r[0], {
    leg: r[0], pid: r[1], tk: r[2], why: r[3], qty: +r[4], pxE: +r[5], pxS: +r[6], pnlAlt: num(r[7]),
    created: ts(r[8]), entry: ts(r[9]), exit: ts(r[10]), pIntra: r[11] === "1", entryUsd: +r[13], exitUsd: +r[14],
    target: +r[15], stop: +r[16], stopIni: +r[17], ratio: +r[18], pxOrden: num(r[19]),
  });
}
// P&L Cocos de la pata segun el sim. Las hijas tp_parcial NO traen pnl_ars_alt (el worker no lo graba):
// se recalcula con la misma formula que usa el worker para los padres.
const pnlSimLeg = (s) => s.pnlAlt ?? Math.round((s.pxS - s.pxE) * s.qty - (s.pxE + s.pxS) * s.qty * FEE);

function cargarVal(file) {
  const m = new Map();
  for (const r of rd(file)) {
    m.set(r[0], {
      leg: r[0], pid: r[1], tk: r[2], why: r[3], qty: +r[4], L: +r[5], T: num(r[6]), nlog: +r[7], nrun: +r[8],
      askFill: num(r[9]), minAsk: num(r[10]), te: ts(r[11]), teOrd: ts(r[12]), tb: ts(r[13]), pb: num(r[14]),
      tt: ts(r[15]), tS: ts(r[16]), pStop: num(r[17]), tLast: ts(r[18]), pLast: num(r[19]),
    });
  }
  return m;
}
const val = { estricto: cargarVal("strict.csv"), laxo: cargarVal("laxo.csv") };

// ---------- posiciones ----------
const pos = new Map();
for (const s of sim.values()) {
  if (!pos.has(s.pid)) pos.set(s.pid, { pid: s.pid, legs: [] });
  pos.get(s.pid).legs.push(s);
}
for (const p of pos.values()) {
  const par = p.legs.find((l) => l.why !== "tp_parcial");
  Object.assign(p, {
    tk: par.tk, why: par.why, conTp: p.legs.length > 1, intra: par.pIntra, created: par.created, entry: par.entry,
    exit: new Date(Math.max(...p.legs.map((l) => l.exit))), L: par.pxE,
    qty: p.legs.reduce((a, l) => a + l.qty, 0),
  });
  p.notional = p.qty * p.L;
  p.pnlSim = p.legs.reduce((a, l) => a + pnlSimLeg(l), 0);
  const v = val.estricto.get(par.leg);
  p.nlog = v.nlog; p.nrun = v.nrun; p.cob = v.nrun ? v.nlog / v.nrun : 0;
  p.askFill = v.askFill; p.minAsk = v.minAsk; p.teOrd = v.teOrd;
}

// ---------- re-ejecucion ----------
function reejecutar(p, modo) {
  const V = val[modo];
  const v0 = V.get(p.legs.find((l) => l.why !== "tp_parcial").leg);
  if (p.nlog === 0) return { estado: "sin_datos" };
  if (!v0.te) return { estado: p.cob >= COB_MIN ? "no_lleno" : "indeterminada" };
  let pnl = 0, abierta = false, tEnd = v0.te, detalle = [];
  for (const l of p.legs) {
    const v = V.get(l.leg);
    let px, t, como;
    if (l.why === "target") {
      if (v.tt && (!v.tS || v.tt <= v.tS)) { px = v.T; t = v.tt; como = "target_T"; }
      else if (v.tS) { px = v.pStop; t = v.tS; como = "stop_tras_target_fallido"; }
      else { px = v.pLast; t = v.tLast; como = "abierta_marcada"; abierta = true; }
    } else {
      if (v.pb) { px = v.pb; t = v.tb; como = "bid"; }
      else { px = v.pLast; t = v.tLast; como = "abierta_marcada"; abierta = true; }
    }
    const pl = (px - p.L) * l.qty - (p.L + px) * l.qty * FEE;
    pnl += pl;
    if (t > tEnd) tEnd = t;
    detalle.push({ leg: l.leg, why: l.why, qty: l.qty, px, t, como, pnl: Math.round(pl), pnlSim: pnlSimLeg(l), pxSim: l.pxS });
  }
  return { estado: "existe", te: v0.te, tEnd, pnl: Math.round(pnl), abierta, detalle };
}
for (const p of pos.values()) for (const m of ["estricto", "laxo"]) p[m] = reejecutar(p, m);

// ---------- estadisticas ----------
const isoWeek = (d) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 864e5 + 1) / 7);
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const med = (a) => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };

// items: [{r (retorno sobre notional), pnl, week}]
function stats(items) {
  const n = items.length;
  if (!n) return { n: 0 };
  const r = items.map((x) => x.r);
  const byW = new Map();
  for (const x of items) { if (!byW.has(x.week)) byW.set(x.week, []); byW.get(x.week).push(x.r); }
  const wk = [...byW.entries()].sort((a, b) => a[0] - b[0]).map(([w, a]) => ({ w, n: a.length, media: mean(a) }));
  const wm = wk.map((x) => x.media);
  return {
    n, mediaPct: 100 * mean(r), medianaPct: 100 * med(r), desvioPct: n > 1 ? 100 * sd(r) : null,
    tOp: n > 1 ? mean(r) / (sd(r) / Math.sqrt(n)) : null,
    semanas: wk.length, tSemana: wk.length > 1 ? mean(wm) / (sd(wm) / Math.sqrt(wm.length)) : null,
    porSemana: wk.map((x) => ({ semana: x.w, n: x.n, mediaPct: +(100 * x.media).toFixed(3) })),
    winRatePct: 100 * r.filter((x) => x > 0).length / n,
    pnlTotal: Math.round(items.reduce((a, x) => a + x.pnl, 0)),
    notionalTotal: Math.round(items.reduce((a, x) => a + x.notional, 0)),
  };
}
const P = [...pos.values()];
const cub = P.filter((p) => p.nlog > 0);
const itemSim = (p) => ({ r: p.pnlSim / p.notional, pnl: p.pnlSim, week: isoWeek(p.entry), notional: p.notional, p });
const itemVal = (m) => (p) => ({ r: p[m].pnl / p.notional, pnl: p[m].pnl, week: isoWeek(p[m].te), notional: p.notional, p });

// Cota con minimos diarios de BYMA (Cocos) para las posiciones sin log o con cobertura baja:
// si en ningun dia entre la creacion y el cierre el minimo del CEDEAR llego a L, la compra es IMPOSIBLE.
// Si llego, es POSIBLE (no probada). Para la cota optimista se les regala el P&L del sim.
const DIAS = ["09-04", "09-07", "09-08", "09-09", "09-10", "09-11", "09-14", "09-15", "09-16", "09-17", "09-18", "09-21", "09-22", "09-23", "09-24", "09-25", "09-28", "09-29"];
const minDia = {};
for (const l of fs.readFileSync(new URL("minimos_diarios_bcba.txt", D), "utf8").split("\n")) {
  if (!l.trim() || l.startsWith("#")) continue;
  const [tk, ...v] = l.trim().split(/\s+/);
  minDia[tk] = Object.fromEntries(DIAS.map((d, i) => [d, +v[i]]));
}
for (const p of P) {
  if (p.estricto.estado !== "sin_datos" && p.estricto.estado !== "indeterminada") continue;
  const d0 = p.created.toISOString().slice(5, 10), d1 = p.exit.toISOString().slice(5, 10);
  const lows = DIAS.filter((d) => d >= d0 && d <= d1).map((d) => minDia[p.tk]?.[d]).filter((x) => x > 0);
  p.cotaDiaria = !lows.length ? "sin_dato" : Math.min(...lows) <= p.L ? "posible" : "imposible";
}
const noCub = P.filter((p) => p.cotaDiaria);
const versiones = {
  "sim_todas": P.map(itemSim),
  "sim_cubiertas": cub.map(itemSim),
  "estricto": cub.filter((p) => p.estricto.estado === "existe").map(itemVal("estricto")),
  "laxo": cub.filter((p) => p.laxo.estado === "existe").map(itemVal("laxo")),
  // la mas generosa posible: estricto + TODAS las no verificables cuyo minimo diario toco L, con el P&L del sim
  "estricto_cota_optimista": [
    ...cub.filter((p) => p.estricto.estado === "existe").map(itemVal("estricto")),
    ...noCub.filter((p) => p.cotaDiaria === "posible").map(itemSim),
  ],
};
const cortes = {
  todas: () => true,
  intradia: (x) => x.p.intra, overnight: (x) => !x.p.intra,
  "padre=target": (x) => x.p.why === "target", "padre=stop": (x) => x.p.why === "stop", "padre=trailing": (x) => x.p.why === "trailing",
  "con_tp_parcial": (x) => x.p.conTp, "sin_tp_parcial": (x) => !x.p.conTp,
};
const R = { conteos: {}, stats: {}, descomp: {}, capital: {}, entrada: {} };
for (const [k, it] of Object.entries(versiones)) {
  R.stats[k] = {};
  for (const [c, f] of Object.entries(cortes)) R.stats[k][c] = stats(it.filter(f));
}

// conteos de estados
for (const m of ["estricto", "laxo"]) {
  const c = {};
  for (const p of P) c[p[m].estado] = (c[p[m].estado] || 0) + 1;
  c.abiertas_marcadas = P.filter((p) => p[m].abierta).length;
  R.conteos[m] = c;
}
R.conteos.posiciones = P.length; R.conteos.patas = sim.size; R.conteos.cubiertas = cub.length;
R.conteos.sinDatosTickers = [...new Set(P.filter((p) => p.nlog === 0).map((p) => p.tk))];
R.conteos.coberturaBaja = P.filter((p) => p.nlog > 0 && p.cob < COB_MIN).length;
R.conteos.estrictoSiLimiteFueraPxOrden = cub.filter((p) => p.teOrd).length;
R.conteos.cotaDiaria = {};
for (const p of noCub) {
  const k = p.estricto.estado + ":" + p.cotaDiaria;
  R.conteos.cotaDiaria[k] ??= { n: 0, pnlSim: 0 };
  R.conteos.cotaDiaria[k].n++; R.conteos.cotaDiaria[k].pnlSim += p.pnlSim;
}

// descomposicion (sobre cubiertas): total sim - total validado = A (posiciones que no existieron) + B (salidas peores en las que si)
for (const m of ["estricto", "laxo"]) {
  const simTot = cub.reduce((a, p) => a + p.pnlSim, 0);
  const noEx = cub.filter((p) => p[m].estado !== "existe");
  const ex = cub.filter((p) => p[m].estado === "existe");
  const A = noEx.reduce((a, p) => a + p.pnlSim, 0);
  const Bsim = ex.reduce((a, p) => a + p.pnlSim, 0), Bval = ex.reduce((a, p) => a + p[m].pnl, 0);
  // B por tipo de pata
  const porTipo = {};
  for (const p of ex) for (const d of p[m].detalle) {
    const k = d.why + ":" + d.como;
    porTipo[k] ??= { n: 0, pnlSim: 0, pnlVal: 0 };
    porTipo[k].n++; porTipo[k].pnlSim += d.pnlSim; porTipo[k].pnlVal += d.pnl;
  }
  // de las que no existieron: cuantas ganaban en el sim
  R.descomp[m] = {
    simTotalCubiertas: simTot, validadoTotal: Bval, diferencia: simTot - Bval,
    A_noExistieron: { n: noEx.length, pnlSim: A, ganadorasSim: noEx.filter((p) => p.pnlSim > 0).length,
      indeterminadas: noEx.filter((p) => p[m].estado === "indeterminada").length,
      pnlSimIndeterminadas: noEx.filter((p) => p[m].estado === "indeterminada").reduce((a, p) => a + p.pnlSim, 0) },
    B_existieron: { n: ex.length, pnlSim: Bsim, pnlVal: Bval, diferencia: Bsim - Bval, porTipo },
    // sesgo de seleccion: retorno medio sim de las que llenaron vs las que no
    retSimMedioLlenaron: 100 * mean(ex.map((p) => p.pnlSim / p.notional)),
    retSimMedioNoLlenaron: noEx.length ? 100 * mean(noEx.map((p) => p.pnlSim / p.notional)) : null,
  };
}

// capital: maximo notional simultaneo y operaciones por dia
const dias = new Set(P.map((p) => p.created.toISOString().slice(0, 10)));
for (const [k, it] of Object.entries({ sim: P.map((p) => [p.entry, p.exit, p.legs]), estricto: null, laxo: null })) {
  let ev = [];
  if (k === "sim") {
    for (const p of P) for (const l of p.legs) ev.push([l.entry, +l.qty * p.L], [l.exit, -l.qty * p.L]);
  } else {
    for (const p of cub) if (p[k].estado === "existe") for (const d of p[k].detalle) ev.push([p[k].te, d.qty * p.L], [d.t, -d.qty * p.L]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0, tMax = null;
  for (const [t, dv] of ev) { cur += dv; if (cur > max) { max = cur; tMax = t; } }
  const nPos = k === "sim" ? P.length : cub.filter((p) => p[k].estado === "existe").length;
  const durH = (k === "sim" ? P.map((p) => (p.exit - p.entry) / 36e5) : cub.filter((p) => p[k].estado === "existe").map((p) => (p[k].tEnd - p[k].te) / 36e5));
  R.capital[k] = { maxNotionalSimultaneo: Math.round(max), cuando: tMax, posiciones: nPos, ruedas: dias.size, porRueda: nPos / dias.size,
    notionalMedio: Math.round(mean((k === "sim" ? P : cub.filter((p) => p[k].estado === "existe")).map((p) => p.notional))),
    duracionMedianaHoras: med(durH) };
}

// la entrada: donde estaba el ask del CEDEAR cuando el sim dio el fill
const gapFill = cub.filter((p) => p.askFill).map((p) => p.askFill / p.L - 1);
const gapMiss = cub.filter((p) => p.estricto.estado !== "existe" && p.minAsk).map((p) => p.minAsk / p.L - 1);
R.entrada = {
  conAskAlFill: gapFill.length,
  askSobreL_alFill: { medianaPct: 100 * med(gapFill), p25Pct: 100 * [...gapFill].sort((a, b) => a - b)[Math.floor(gapFill.length * 0.25)],
    p75Pct: 100 * [...gapFill].sort((a, b) => a - b)[Math.floor(gapFill.length * 0.75)], fraccionAskArribaDeL: gapFill.filter((x) => x > 0).length / gapFill.length },
  noLlenadas_minAskSobreL: { n: gapMiss.length, medianaPct: 100 * med(gapMiss), p90Pct: 100 * [...gapMiss].sort((a, b) => a - b)[Math.floor(gapMiss.length * 0.9)] },
  demoraFillReal_min: (() => { const d = cub.filter((p) => p.estricto.estado === "existe").map((p) => (p.estricto.te - p.entry) / 6e4); return { mediana: med(d), antesDelSim: d.filter((x) => x < 0).length, n: d.length }; })(),
};

fs.writeFileSync(new URL("resultados.json", D), JSON.stringify(R, null, 1));
// dump por posicion para auditoria
const out = ["pid,ticker,padre,con_tp,intradia_sim,created,entry_sim,exit_sim,L,qty,notional,cobertura,pnl_sim,estado_estricto,te_estricto,pnl_estricto,estado_laxo,te_laxo,pnl_laxo,ask_al_fill,min_ask"];
for (const p of P) out.push([p.pid, p.tk, p.why, +p.conTp, +p.intra, p.created.toISOString(), p.entry.toISOString(), p.exit.toISOString(), p.L, p.qty, Math.round(p.notional),
  p.cob.toFixed(2), p.pnlSim, p.estricto.estado, p.estricto.te?.toISOString() ?? "", p.estricto.pnl ?? "", p.laxo.estado, p.laxo.te?.toISOString() ?? "", p.laxo.pnl ?? "", p.askFill ?? "", p.minAsk ?? ""].join(","));
fs.writeFileSync(new URL("posiciones.csv", D), out.join("\n") + "\n");

const f = (x, d = 2) => (x == null ? "-" : x.toFixed(d));
console.log("conteos", JSON.stringify(R.conteos));
for (const [k, v] of Object.entries(R.stats)) {
  console.log("\n==", k);
  for (const [c, s] of Object.entries(v)) if (s.n) console.log(`${c.padEnd(16)} n=${String(s.n).padStart(3)} media=${f(s.mediaPct, 3)}% med=${f(s.medianaPct, 3)}% sd=${f(s.desvioPct)}% tOp=${f(s.tOp)} tSem=${f(s.tSemana)} (${s.semanas}sem) win=${f(s.winRatePct, 0)}% pnl=${s.pnlTotal.toLocaleString("es-AR")}`);
}
console.log("\nsemanas:", JSON.stringify(Object.fromEntries(Object.entries(R.stats).map(([k, v]) => [k, v.todas.porSemana]))));
console.log("\ndescomp", JSON.stringify(R.descomp, null, 1));
console.log("\ncapital", JSON.stringify(R.capital, null, 1));
console.log("\nentrada", JSON.stringify(R.entrada, null, 1));
