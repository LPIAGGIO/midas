/* cocos3-score.js — ¿conviene bajar el puntaje mínimo del filtro de 7 a 6?
 * (pedido de LP 30/09/2026, en rueda: "bajalo a 6 y vemos").
 * Misma maquinaria del anexo COCOS2 (cocos2-lib.js), configuración del bot de
 * Cocos de HOY: stop 1,5×ATR FIJO (sin trailing), target en la resistencia con
 * venta de la mitad a mitad de camino, 20M / 2M por papel, costos Cocos,
 * spread 0,10% en stops. Solo cambia el puntaje mínimo (y se mira aparte la
 * banda MARGINAL: las señales que entrarían con 6 y hoy quedan afuera).
 *   node cocos3-score.js
 * Todo local; no toca nada vivo ni los archivos existentes. */
import { IS, OOS, LIMPIOS_38, VARIANTES, cargar, atrTabla, contexto, simular, metricas } from "./cocos2-lib.js";

const n2 = (x, d = 2) => (x == null || Number.isNaN(x) ? "-" : x.toFixed(d));
const pc = (x, d = 2) => (x == null ? "-" : (x * 100).toFixed(d) + "%");
const all = cargar(LIMPIOS_38); const U = new Set(all.syms); const atrDe = atrTabla(all.daily);
const CTX = { IS: contexto(all.hourly, U, IS), OOS: contexto(all.hourly, U, OOS) };

// el gate del worker, con el puntaje mínimo como parámetro
const gate = (minScore, soloBanda = null, minRR = 2) => (s) => {
  const mixtoOk = s.regime === "mixto" && s.score >= 8 && s.rr != null && s.rr >= 2.5;
  const regimenOk = s.regime === "risk_on" || mixtoOk;
  const okScore = soloBanda != null ? s.score === soloBanda : s.score >= minScore;
  const ok = s.entry != null && okScore && s.rr != null && s.rr >= minRR && !s.ct && regimenOk && s.stop != null && s.stop > 0 && s.stop < s.entry && s.target != null;
  return ok ? { riskMult: mixtoOk ? 0.5 : 1 } : null;
};
function ordenes(ctx, g) {
  const out = [];
  for (const s of all.senales) {
    if (!U.has(s.sym) || s.dia < ctx.desde || s.dia > ctx.hasta) continue;
    const f = g(s); if (!f) continue;
    const a = atrDe(s.sym, s.dia); if (!(a > 0)) continue;
    const spotBar = ctx.barAt[s.sym]?.get(s.ts * 1000);
    out.push({ sym: s.sym, ts: s.ts, dia: s.dia, entry: s.entry, res: s.target, stopTec: s.stop, score: s.score, rr: s.rr, regime: s.regime, riskMult: f.riskMult ?? 1, atr0: a, spot: spotBar ? spotBar.c : null, created: s.ts * 1000 + 1 });
  }
  return out.sort((a, b) => a.created - b.created);
}
const V = VARIANTES["A  res + parcial 50%"];
const correr = (g, vn) => { const o = ordenes(CTX[vn], g); const sim = simular(o, CTX[vn], atrDe, all.ccl, { variante: V, spread: 0.001, trailAtr: false, stopTec: false }); return { ord: o.length, m: metricas(sim, CTX[vn].meses), skips: sim.skips }; };

console.log("config: stop 1,5×ATR fijo · target resistencia + parcial 50% · 20M / 2M · Cocos · spread stops 0,10%");
console.log(`ventanas: IS ${IS.join(" → ")} (${n2(CTX.IS.meses, 1)} meses) · OOS ${OOS.join(" → ")} (${n2(CTX.OOS.meses, 1)} meses)\n`);
console.log("| filtro | señales IS | ops IS | por op IS | acierto IS | mensual IS | t/op IS | señales OOS | ops OOS | por op OOS | acierto OOS | mensual OOS | t/op OOS | t/mes OOS | DD OOS |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
const casos = [
  ["puntaje ≥8", gate(8)], ["puntaje ≥7 (hoy)", gate(7)], ["puntaje ≥6", gate(6)], ["puntaje ≥5", gate(5)],
  ["SOLO puntaje 6 (lo que se suma)", gate(0, 6)], ["SOLO puntaje 5", gate(0, 5)], ["SOLO puntaje 7", gate(0, 7)],
  ["puntaje ≥6 y R:R ≥3", gate(6, null, 3)], ["puntaje ≥7 y R:R ≥3", gate(7, null, 3)],
];
for (const [nom, g] of casos) {
  const a = correr(g, "IS"), b = correr(g, "OOS");
  console.log(`| ${nom} | ${a.ord} | ${a.m.n} | ${pc(a.m.retMedio)} | ${pc(a.m.winRate, 0)} | ${n2(a.m.mensualPct)}% | ${n2(a.m.tTrade)} | ${b.ord} | ${b.m.n} | ${pc(b.m.retMedio)} | ${pc(b.m.winRate, 0)} | ${n2(b.m.mensualPct)}% | ${n2(b.m.tTrade)} | ${n2(b.m.tMes)} | ${n2(b.m.maxDDpct, 1)}% |`);
  if (nom === "puntaje ≥6") console.log(`|   (órdenes salteadas ≥6 · IS ${JSON.stringify(a.skips)} · OOS ${JSON.stringify(b.skips)}) |`);
}
