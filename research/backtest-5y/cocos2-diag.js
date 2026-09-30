/* cocos2-diag.js — diagnósticos del anexo COCOS2: POR QUÉ cada variante dio lo
 * que dio. Reusa cocos2-lib.js. Salida a consola (se pega en el informe).
 *   node cocos2-diag.js
 */
import {
  CAPITAL, IS, OOS, LIMPIOS_38, VARIANTES,
  cargar, atrTabla, contexto, ordenesDe, simular, metricas, mean, median, stdev, tstat,
} from "./cocos2-lib.js";

const n2 = (x, d = 2) => (x == null || Number.isNaN(x) ? "-" : x.toFixed(d));
const pc = (x, d = 2) => (x == null ? "-" : (x * 100).toFixed(d) + "%");
const fmt = (x) => (x == null ? "-" : Math.round(x).toLocaleString("es-AR"));

const all = cargar(LIMPIOS_38);
const U = new Set(all.syms);
const atrDe = atrTabla(all.daily);
const CTX = { IS: contexto(all.hourly, U, IS), OOS: contexto(all.hourly, U, OOS) };
const ORD = { IS: ordenesDe(all.senales, U, CTX.IS, atrDe), OOS: ordenesDe(all.senales, U, CTX.OOS, atrDe) };

/* 1. geometría de las órdenes: qué tan lejos está el stop ATR, la resistencia y el spot */
console.log("===== 1. geometría de las órdenes gateadas =====");
for (const vn of ["IS", "OOS"]) {
  const o = ORD[vn];
  const atrPct = o.map((x) => x.atr0 / x.entry), resPct = o.map((x) => x.res / x.entry - 1), tecPct = o.map((x) => 1 - x.stopTec / x.entry);
  const spotPct = o.filter((x) => x.spot > 0).map((x) => x.spot / x.entry - 1);
  console.log(`[${vn}] n=${o.length} · ATR%/entrada mediana ${pc(median(atrPct))} (media ${pc(mean(atrPct))}) → stop 1,5×ATR a ${pc(1.5 * median(atrPct))} · stop TÉCNICO mediana ${pc(median(tecPct))} · resistencia a ${pc(median(resPct))} (p25 ${pc([...resPct].sort((a, b) => a - b)[Math.floor(resPct.length / 4)])}) · spot arriba de la entrada ${pc(median(spotPct))}`);
  console.log(`      resistencia < +1% en ${pc(resPct.filter((x) => x < 0.01).length / resPct.length, 1)} de las órdenes · < +1,5% en ${pc(resPct.filter((x) => x < 0.015).length / resPct.length, 1)} · < +3% en ${pc(resPct.filter((x) => x < 0.03).length / resPct.length, 1)} · mitad de camino < +1,5% en ${pc(resPct.filter((x) => x / 2 < 0.015).length / resPct.length, 1)}`);
}

/* 2. retorno por camino de salida, variante por variante */
console.log("\n===== 2. retorno medio por camino de salida (última pata) · spread 0,10% =====");
const SIMS = {};
for (const [nombre, v] of Object.entries(VARIANTES)) {
  SIMS[nombre] = {};
  for (const vn of ["IS", "OOS"]) {
    const sim = simular(ORD[vn], CTX[vn], atrDe, all.ccl, { variante: v, spread: 0.001 });
    SIMS[nombre][vn] = sim;
    const g = {};
    for (const t of sim.trades) { const k = t.legs[t.legs.length - 1].reason; (g[k] = g[k] || []).push(t.pnl / t.invertido); }
    const s = Object.entries(g).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k} n=${v.length} ret ${pc(mean(v))}`).join(" · ");
    console.log(`${nombre.padEnd(32)} ${vn.padEnd(3)} ${s}`);
  }
}

/* 3. C1/C2 por cantidad de lotes, y comparación pareada contra la variante de un lote */
console.log("\n===== 3. promediar: por cantidad de lotes llenos, y pareado contra un solo lote (misma señal) =====");
const key = (t) => t.sym + "|" + t.dia;
for (const [cn, bn] of [["C1 prom → res", "B  todo en la res (sin parcial)"], ["C2 prom → +1,5% del prom", "B  todo +1,5%"], ["C3 prom → escalonado", "A  res + parcial 50%"], ["D1 recup → res", "B  todo en la res (sin parcial)"], ["D2 recup → +1,5% del prom", "B  todo +1,5%"]]) {
  for (const vn of ["IS", "OOS"]) {
    const C = SIMS[cn][vn].trades, B = new Map(SIMS[bn][vn].trades.map((t) => [key(t), t]));
    const porLotes = {};
    for (const t of C) (porLotes[t.nLotes] = porLotes[t.nLotes] || []).push(t);
    const s = Object.entries(porLotes).map(([k, v]) => `${k} lote(s): n=${v.length} ret ${pc(mean(v.map((t) => t.pnl / t.invertido)))} P&L ${fmt(v.reduce((a, t) => a + t.pnl, 0))} win ${pc(v.filter((t) => t.pnl > 0).length / v.length, 0)}`).join(" · ");
    console.log(`${cn.padEnd(28)} ${vn.padEnd(3)} ${s}`);
    // pareado: mismas señales (sym+día) en las dos
    const pares = C.filter((t) => B.has(key(t))).map((t) => ({ c: t, b: B.get(key(t)) }));
    const dif = pares.map((p) => p.c.pnl - p.b.pnl);
    const soloC = C.filter((t) => !B.has(key(t))), soloB = [...B.values()].filter((t) => !C.some((x) => key(x) === key(t)));
    console.log(`   pareado con "${bn}": ${pares.length} señales en común · P&L C ${fmt(pares.reduce((a, p) => a + p.c.pnl, 0))} vs B ${fmt(pares.reduce((a, p) => a + p.b.pnl, 0))} · dif media/señal ${fmt(mean(dif))} (t ${n2(tstat(dif))}) · sólo en C ${soloC.length} (P&L ${fmt(soloC.reduce((a, t) => a + t.pnl, 0))}) · sólo en B ${soloB.length} (P&L ${fmt(soloB.reduce((a, t) => a + t.pnl, 0))})`);
    // en las señales con 2+ lotes: qué hizo B con esa misma señal
    const multi = pares.filter((p) => p.c.nLotes >= 2);
    if (multi.length) console.log(`   en las ${multi.length} señales donde C promedió (2+ lotes): C ${fmt(multi.reduce((a, p) => a + p.c.pnl, 0))} (ret ${pc(mean(multi.map((p) => p.c.pnl / p.c.invertido)))}, win ${pc(multi.filter((p) => p.c.pnl > 0).length / multi.length, 0)}) · B en esas mismas ${fmt(multi.reduce((a, p) => a + p.b.pnl, 0))} (ret ${pc(mean(multi.map((p) => p.b.pnl / p.b.invertido)))}, win ${pc(multi.filter((p) => p.b.pnl > 0).length / multi.length, 0)}, salió por stop en ${pc(multi.filter((p) => /stop|trailing/.test(p.b.legs[p.b.legs.length - 1].reason)).length / multi.length, 0)})`);
  }
}

/* 4. ¿cuánto pesa el trailing ATR? A y B-res sin trailing ATR (sólo +2R), y sin spread */
console.log("\n===== 4. sensibilidad: trailing ATR apagado (queda sólo +2R) · spread 0 =====");
for (const nombre of ["A  res + parcial 50%", "B  todo en la res (sin parcial)", "B  todo +1,5%", "B  todo +3,0%", "C1 prom → res"]) {
  for (const vn of ["IS", "OOS"]) {
    const base = metricas(SIMS[nombre][vn], CTX[vn].meses);
    const sinTrail = metricas(simular(ORD[vn], CTX[vn], atrDe, all.ccl, { variante: VARIANTES[nombre], spread: 0.001, trailAtr: false }), CTX[vn].meses);
    const sinSpread = metricas(simular(ORD[vn], CTX[vn], atrDe, all.ccl, { variante: VARIANTES[nombre], spread: 0 }), CTX[vn].meses);
    const ult = (m) => Object.entries(m.ultimaSalida).map(([k, v]) => `${k} ${pc(v / m.n, 0)}`).join(" ");
    console.log(`${nombre.padEnd(32)} ${vn.padEnd(3)} base ${n2(base.mensualPct)}%/mes (op ${pc(base.retMedio)}, ${ult(base)}) · sin trailing ATR ${n2(sinTrail.mensualPct)}%/mes (op ${pc(sinTrail.retMedio)}, ${ult(sinTrail)}) · sin spread ${n2(sinSpread.mensualPct)}%/mes`);
  }
}

/* 5. la cuenta aritmética de los targets cortos: pérdida media del stop vs ganancia del target */
console.log("\n===== 5. aritmética de los targets cortos =====");
for (const nombre of ["B  todo +1,0%", "B  todo +1,5%", "B  todo +2,0%", "B  todo +3,0%", "B  todo mitad de camino"]) {
  for (const vn of ["IS", "OOS"]) {
    const T = SIMS[nombre][vn].trades;
    const r = (t) => t.pnl / t.invertido;
    const tp = T.filter((t) => /^tp|mitadCamino/.test(t.legs[t.legs.length - 1].reason)), st = T.filter((t) => t.legs[t.legs.length - 1].reason === "stop"), tr = T.filter((t) => t.legs[t.legs.length - 1].reason === "trailing");
    const mesesAll = mean(T.map((t) => (t.exitTs - t.entryTs) / 3600000));
    console.log(`${nombre.padEnd(26)} ${vn.padEnd(3)} target ${pc(tp.length / T.length, 0)} a ${pc(mean(tp.map(r)))} · stop ${pc(st.length / T.length, 0)} a ${pc(mean(st.map(r)))} · trailing ${pc(tr.length / T.length, 0)} a ${pc(mean(tr.map(r)))} · esperanza ${pc(mean(T.map(r)))} · horas media ${n2(mesesAll, 0)} · P&L ${fmt(T.reduce((a, t) => a + t.pnl, 0))}`);
  }
}

/* 6. serie mensual de C1 y A: dónde se ganó */
console.log("\n===== 6. P&L mensual (miles de ARS): A vs C1 vs C2 =====");
for (const vn of ["IS", "OOS"]) {
  const A = metricas(SIMS["A  res + parcial 50%"][vn], CTX[vn].meses), C1 = metricas(SIMS["C1 prom → res"][vn], CTX[vn].meses), C2 = metricas(SIMS["C2 prom → +1,5% del prom"][vn], CTX[vn].meses);
  const meses = [...new Set(SIMS["A  res + parcial 50%"][vn].equity.map((e) => e.dia.slice(0, 7)))].sort();
  console.log(`[${vn}] mes: A / C1 / C2`);
  console.log("  " + meses.map((m, i) => `${m} ${fmt(A.mens[i] * CAPITAL / 1000)}/${fmt(C1.mens[i] * CAPITAL / 1000)}/${fmt(C2.mens[i] * CAPITAL / 1000)}`).join(" · "));
  const top = (m) => { const idx = m.mens.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]); return `mejor mes ${meses[idx[0][1]]} ${fmt(idx[0][0] * CAPITAL / 1000)}k = ${pc(idx[0][0] * CAPITAL / m.total, 0)} del total`; };
  console.log(`  C1: ${top(C1)} · meses positivos ${C1.mens.filter((x) => x > 0).length}/${C1.mens.length} · C2: ${top(C2)} · meses positivos ${C2.mens.filter((x) => x > 0).length}/${C2.mens.length}`);
}

/* 7. C1: concentración por papel */
console.log("\n===== 7. C1 y C2: concentración del P&L por papel =====");
for (const nombre of ["C1 prom → res", "C2 prom → +1,5% del prom"]) for (const vn of ["IS", "OOS"]) {
  const g = {};
  for (const t of SIMS[nombre][vn].trades) g[t.sym] = (g[t.sym] || 0) + t.pnl;
  const tot = Object.values(g).reduce((a, b) => a + b, 0);
  const top = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${fmt(v / 1000)}k`).join(", ");
  const worst = Object.entries(g).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([k, v]) => `${k} ${fmt(v / 1000)}k`).join(", ");
  console.log(`${nombre.padEnd(28)} ${vn.padEnd(3)} total ${fmt(tot / 1000)}k · top5 ${top} · peores ${worst} · papeles con P&L>0: ${Object.values(g).filter((x) => x > 0).length}/${Object.keys(g).length}`);
}
