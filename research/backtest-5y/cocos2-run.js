/* cocos2-run.js — anexo COCOS2: targets cortos, promediar hacia abajo y
 * escalonado en recuperación, con la tarifa de Cocos, stop 1,5×ATR trailing
 * y los rails de 20M / 2M por papel. Ver INFORME-COCOS2.md.
 *
 *   node cocos2-run.js                → todo, escribe cocos2-results.json y cocos2-run.log
 *   node cocos2-run.js --draws=N      → sorteos del control E (default 200)
 *   node cocos2-run.js --sinControl   → saltea el bloque E
 *
 * Todo local. No toca VPS ni Supabase ni archivos existentes.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DIR, CAPITAL, SLOT, IS, OOS, LIMPIOS_38, VARIANTES,
  cargar, atrTabla, contexto, ordenesDe, simular, metricas, dsr, stdev, mean, mkRnd, barajar,
} from "./cocos2-lib.js";

const ARGS = process.argv.slice(2);
const arg = (k, d) => { const a = ARGS.find((x) => x.startsWith(k + "=")); return a ? Number(a.split("=")[1]) : d; };
const DRAWS = arg("--draws", 200);
const SIN_CONTROL = ARGS.includes("--sinControl");
const SEMILLA = 20260929;

const logLines = [];
const log = (...a) => { const s = a.join(" "); console.log(s); logLines.push(s); };
const n2 = (x, d = 2) => (x == null || Number.isNaN(x) ? "-" : x.toFixed(d));
const pc = (x, d = 1) => (x == null ? "-" : (x * 100).toFixed(d) + "%");
const fmt = (x) => (x == null ? "-" : Math.round(x).toLocaleString("es-AR"));

const t0 = Date.now();
const all = cargar(LIMPIOS_38);
const U = new Set(all.syms);
const atrDe = atrTabla(all.daily);
log(`símbolos ${all.syms.length} · señales crudas del cache para el universo: ${all.senales.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const CTX = { IS: contexto(all.hourly, U, IS), OOS: contexto(all.hourly, U, OOS) };
const ORD = { IS: ordenesDe(all.senales, U, CTX.IS, atrDe), OOS: ordenesDe(all.senales, U, CTX.OOS, atrDe) };
log(`órdenes gateadas (score≥7, R:R≥2 técnico, sin CT, régimen): IS ${ORD.IS.length} · OOS ${ORD.OOS.length}  (atr.js reportó 528 / 371 con el mismo gate y universo)`);
log(`meses: IS ${n2(CTX.IS.meses, 1)} · OOS ${n2(CTX.OOS.meses, 1)} · rails: capital ${fmt(CAPITAL)} · slot ${fmt(SLOT)} · 6 entradas/día · ventana 48h · stop 1,5×ATR14 trailing`);

/* ── chequeos internos de coherencia (abortan si algo no cierra) ── */
function chequear(sim, nombre) {
  for (const t of sim.trades) {
    const vendido = t.legs.reduce((s, l) => s + l.qty, 0);
    const comprado = t.invertido;
    if (t.qty > 1e-6) throw new Error(`${nombre}: ${t.sym} quedó con qty ${t.qty}`);
    if (!(t.invertido <= t.slot * 1.0021 + 1)) throw new Error(`${nombre}: ${t.sym} invirtió ${t.invertido} > slot ${t.slot}`);
    if (!(vendido > 0) || !(comprado > 0)) throw new Error(`${nombre}: ${t.sym} sin patas`);
    if (t.exitTs == null) throw new Error(`${nombre}: ${t.sym} sin exitTs`);
  }
  const eq = sim.equity[sim.equity.length - 1].eq;
  if (Math.abs(eq - (CAPITAL + sim.realized)) > 1) throw new Error(`${nombre}: equity final ${eq} != capital+realizado`);
}

/* ── corridas principales ── */
const out = { generado: new Date().toISOString(), semilla: SEMILLA, rails: { CAPITAL, SLOT }, ordenes: { IS: ORD.IS.length, OOS: ORD.OOS.length }, corridas: {}, control: {}, dsr: {} };
const filas = {};   // nombre → { IS: m, OOS: m, IS20: m, OOS20: m }
for (const [nombre, v] of Object.entries(VARIANTES)) {
  filas[nombre] = {};
  for (const vn of ["IS", "OOS"]) {
    for (const sp of [0.001, 0.002]) {
      const sim = simular(ORD[vn], CTX[vn], atrDe, all.ccl, { variante: v, spread: sp, label: nombre });
      chequear(sim, `${nombre}/${vn}/${sp}`);
      const m = metricas(sim, CTX[vn].meses);
      const key = vn + (sp === 0.002 ? "20" : "");
      filas[nombre][key] = m;
      out.corridas[`${nombre}/${key}`] = {
        ...m, dRets: undefined, mens: m.mens, skips: sim.skips, nOrdenes: sim.nOrdenes,
        trades: sim.trades.map((t) => ({
          sym: t.sym, dia: t.dia, score: t.score, rr: t.rr, regime: t.regime, nLotes: t.nLotes, invertido: Math.round(t.invertido),
          pnl: Math.round(t.pnl), ret: t.pnl / t.invertido, horas: (t.exitTs - t.entryTs) / 3600000, salida: t.legs.map((l) => l.reason).join("+"),
        })),
      };
    }
  }
}

function tabla(vn) {
  log(`\n===== ${vn} (${n2(CTX[vn].meses, 1)} meses · ${ORD[vn].length} órdenes) · spread 0,10% en stops · Cocos =====`);
  log(`| variante | n | ret medio/op | mediana | win | mensual (20M) | maxDD | t/op | t/mes | papel | CCL | costo | horas med | lotes | mensual c/spread 0,20% |`);
  log(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const nombre of Object.keys(VARIANTES)) {
    const m = filas[nombre][vn], m2 = filas[nombre][vn + "20"];
    log(`| ${nombre} | ${m.n} | ${pc(m.retMedio, 2)} | ${pc(m.retMediana, 2)} | ${pc(m.winRate)} | ${n2(m.mensualPct)}% | ${n2(m.maxDDpct, 1)}% | ${n2(m.tTrade)} | ${n2(m.tMes)} | ${pc(m.papelPct, 2)} | ${pc(m.cclPct, 2)} | ${pc(m.costoPct, 3)} | ${n2(m.horasMed, 0)} | ${n2(m.lotesMed, 2)} | ${n2(m2.mensualPct)}% |`);
  }
}
tabla("IS"); tabla("OOS");

log(`\n===== caminos de salida (última pata) =====`);
for (const nombre of Object.keys(VARIANTES)) {
  const a = filas[nombre].IS, b = filas[nombre].OOS;
  const f = (m) => Object.entries(m.ultimaSalida).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pc(v / m.n, 0)}`).join(", ");
  log(`${nombre.padEnd(32)} IS: ${f(a)}  ·  OOS: ${f(b)}  · tope 2M manda IS ${pc(a.mandaTope, 0)} OOS ${pc(b.mandaTope, 0)} · expo media IS ${pc(a.expoMedia, 0)} OOS ${pc(b.expoMedia, 0)} · invertido mediana IS ${fmt(a.invMed)} OOS ${fmt(b.invMed)}`);
}

/* ── tabla comparativa ordenada por mensual OOS ── */
log(`\n===== COMPARATIVA · ordenada por retorno mensual OOS (spread 0,10%) =====`);
log(`| # | variante | n IS | mensual IS | t/mes IS | n OOS | mensual OOS | t/mes OOS | t/op OOS | DD OOS | OOS c/spread 0,20% |`);
log(`|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
const orden = Object.keys(VARIANTES).sort((a, b) => filas[b].OOS.mensualPct - filas[a].OOS.mensualPct);
orden.forEach((nombre, i) => {
  const a = filas[nombre].IS, b = filas[nombre].OOS, b2 = filas[nombre].OOS20;
  log(`| ${i + 1} | ${nombre} | ${a.n} | ${n2(a.mensualPct)}% | ${n2(a.tMes)} | ${b.n} | ${n2(b.mensualPct)}% | ${n2(b.tMes)} | ${n2(b.tTrade)} | ${n2(b.maxDDpct, 1)}% | ${n2(b2.mensualPct)}% |`);
});
out.rankingOOS = orden;

/* ── DSR: la mejor del IS, deflactada en el OOS con N = variantes miradas ── */
{
  const N = Object.keys(VARIANTES).length;
  const sig = (vn) => stdev(Object.keys(VARIANTES).map((k) => filas[k][vn].srDiario).filter((x) => x != null));
  const mejorIS = Object.keys(VARIANTES).sort((a, b) => filas[b].IS.mensualPct - filas[a].IS.mensualPct)[0];
  const mejorOOS = orden[0];
  for (const [tag, nombre, vn] of [["mejorIS→IS", mejorIS, "IS"], ["mejorIS→OOS", mejorIS, "OOS"], ["mejorOOS→OOS", mejorOOS, "OOS"], ["A→OOS", "A  res + parcial 50%", "OOS"]]) {
    const m = filas[nombre][vn];
    const d = dsr(m.dRets, m.srDiario, sig(vn), N);
    out.dsr[tag] = { nombre, vn, N, sigmaSR: sig(vn), sharpe: m.sharpe, ...(d || {}) };
    log(`DSR ${tag.padEnd(13)} ${nombre.padEnd(32)} Sharpe ${n2(m.sharpe)} · SR0 diario ${d ? d.sr0.toExponential(2) : "-"} · DSR ${d ? n2(d.dsr, 3) : "-"} (N=${N})`);
  }
}

/* ── control E: fechas barajadas ── */
if (!SIN_CONTROL) {
  log(`\n===== CONTROL E · mismas señales, fechas barajadas · ${DRAWS} sorteos · semilla ${SEMILLA} =====`);
  const CTRL = ["A  res + parcial 50%", "B  todo +1,5%", "C1 prom → res", "C2 prom → +1,5% del prom", "C3 prom → escalonado", "D2 recup → +1,5% del prom"];
  for (const modoCtrl of ["perm", "uniforme"]) {
    log(`--- ${modoCtrl === "perm" ? "permutación de fechas entre señales (conserva el calendario)" : "fechas uniformes al azar (rompe también el calendario)"} ---`);
    log(`| variante | ventana | real mensual | nulo media | nulo p5 | nulo p95 | percentil del real | p (nulo ≥ real) | n medio nulo |`);
    log(`|---|---|---:|---:|---:|---:|---:|---:|---:|`);
    for (const nombre of CTRL) {
      for (const vn of ["IS", "OOS"]) {
        const rnd = mkRnd(SEMILLA);
        const vals = [], ns = [];
        for (let k = 0; k < DRAWS; k++) {
          const ord = barajar(ORD[vn], CTX[vn], atrDe, rnd, modoCtrl);
          const sim = simular(ord, CTX[vn], atrDe, all.ccl, { variante: VARIANTES[nombre], spread: 0.001, light: true });
          const total = sim.trades.reduce((s, t) => s + t.pnl, 0);
          vals.push((total / CAPITAL / CTX[vn].meses) * 100); ns.push(sim.trades.length);
        }
        const real = filas[nombre][vn].mensualPct;
        const s = [...vals].sort((a, b) => a - b);
        const pctl = s.filter((x) => x < real).length / s.length;
        const p = s.filter((x) => x >= real).length / s.length;
        out.control[`${modoCtrl}/${nombre}/${vn}`] = { real, media: mean(vals), p5: s[Math.floor(0.05 * s.length)], p95: s[Math.floor(0.95 * s.length)], pctl, p, nMedio: mean(ns), vals };
        log(`| ${nombre} | ${vn} | ${n2(real)}% | ${n2(mean(vals))}% | ${n2(s[Math.floor(0.05 * s.length)])}% | ${n2(s[Math.floor(0.95 * s.length)])}% | ${pc(pctl, 0)} | ${n2(p, 3)} | ${n2(mean(ns), 0)} |`);
      }
    }
  }
  // la pregunta de LP: ¿C le gana a A por el patrón o por el drift? Diferencia
  // pareada C − A sorteo por sorteo (misma permutación para las dos).
  log(`--- diferencia PAREADA (C − A) por sorteo, permutación ---`);
  log(`| par | ventana | real C−A | nulo media | nulo p5 | nulo p95 | percentil del real |`);
  log(`|---|---|---:|---:|---:|---:|---:|`);
  for (const [cn, an] of [["C1 prom → res", "B  todo en la res (sin parcial)"], ["C2 prom → +1,5% del prom", "B  todo +1,5%"], ["C3 prom → escalonado", "A  res + parcial 50%"], ["D2 recup → +1,5% del prom", "B  todo +1,5%"]]) {
    for (const vn of ["IS", "OOS"]) {
      const rnd = mkRnd(SEMILLA);
      const difs = [];
      for (let k = 0; k < DRAWS; k++) {
        const ord = barajar(ORD[vn], CTX[vn], atrDe, rnd, "perm");
        const tot = (nm) => simular(ord, CTX[vn], atrDe, all.ccl, { variante: VARIANTES[nm], spread: 0.001, light: true }).trades.reduce((s, t) => s + t.pnl, 0);
        difs.push(((tot(cn) - tot(an)) / CAPITAL / CTX[vn].meses) * 100);
      }
      const real = filas[cn][vn].mensualPct - filas[an][vn].mensualPct;
      const s = [...difs].sort((a, b) => a - b);
      const pctl = s.filter((x) => x < real).length / s.length;
      out.control[`pareado/${cn} − ${an}/${vn}`] = { real, media: mean(difs), p5: s[Math.floor(0.05 * s.length)], p95: s[Math.floor(0.95 * s.length)], pctl, vals: difs };
      log(`| ${cn} − ${an} | ${vn} | ${n2(real)} | ${n2(mean(difs))} | ${n2(s[Math.floor(0.05 * s.length)])} | ${n2(s[Math.floor(0.95 * s.length)])} | ${pc(pctl, 0)} |`);
    }
  }
}

fs.writeFileSync(path.join(DIR, "cocos2-results.json"), JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(DIR, "cocos2-run.log"), logLines.join("\n") + "\n");
log(`\ncocos2-results.json escrito · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
