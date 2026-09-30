/* cocos2-diag2.js — referencia: las mismas variantes con el stop TÉCNICO del
 * motor (régimen anterior al 29/09) y trailing +2R, mismos rails de 20M/2M.
 * Sirve para leer cuánto del resultado es el stop ATR y cuánto el target. */
import { IS, OOS, LIMPIOS_38, VARIANTES, cargar, atrTabla, contexto, ordenesDe, simular, metricas } from "./cocos2-lib.js";
const n2 = (x, d = 2) => (x == null || Number.isNaN(x) ? "-" : x.toFixed(d));
const pc = (x, d = 2) => (x == null ? "-" : (x * 100).toFixed(d) + "%");
const all = cargar(LIMPIOS_38); const U = new Set(all.syms); const atrDe = atrTabla(all.daily);
const CTX = { IS: contexto(all.hourly, U, IS), OOS: contexto(all.hourly, U, OOS) };
const ORD = { IS: ordenesDe(all.senales, U, CTX.IS, atrDe), OOS: ordenesDe(all.senales, U, CTX.OOS, atrDe) };
console.log("===== referencia: stop TÉCNICO + trailing 2R (sin ATR), rails 20M/2M, Cocos, spread 0,10% =====");
console.log("| variante | n IS | op IS | mensual IS | t/mes IS | n OOS | op OOS | mensual OOS | t/mes OOS | stop% IS | stop% OOS |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const nombre of ["A  res + parcial 50%", "B  todo +1,0%", "B  todo +1,5%", "B  todo +2,0%", "B  todo +3,0%", "B  todo mitad de camino", "B  todo en la res (sin parcial)"]) {
  const m = {};
  for (const vn of ["IS", "OOS"]) m[vn] = metricas(simular(ORD[vn], CTX[vn], atrDe, all.ccl, { variante: VARIANTES[nombre], spread: 0.001, trailAtr: false, stopTec: true }), CTX[vn].meses);
  const st = (x) => pc(((x.ultimaSalida.stop || 0) + (x.ultimaSalida.trailing || 0)) / x.n, 0);
  console.log(`| ${nombre} | ${m.IS.n} | ${pc(m.IS.retMedio)} | ${n2(m.IS.mensualPct)}% | ${n2(m.IS.tMes)} | ${m.OOS.n} | ${pc(m.OOS.retMedio)} | ${n2(m.OOS.mensualPct)}% | ${n2(m.OOS.tMes)} | ${st(m.IS)} | ${st(m.OOS)} |`);
}
