// Objeción de Pablo sobre VIST (30/09/2026): 7 meses / 3 trimestres fallando
// en el mismo techo. ¿Qué pasó históricamente, en el universo del bot, después
// de TRES trimestres seguidos con máximos casi iguales (techo plano) y cierre
// del último lejos del techo? ¿Rompe para arriba o pierde el piso del rango?
//   node techo-plano.mjs
const TICKERS = "AAPL,MSFT,GOOGL,META,AMZN,NVDA,TSLA,NFLX,ADBE,ORCL,IBM,HPQ,MU,SNDK,AMD,INTC,AVGO,QCOM,MRVL,ARM,ADI,PLTR,NBIS,IREN,RGTI,KEEL,COIN,MSTR,HUT,XOM,VST,OKLO,GPRK,LAC,LAR,KO,MCD,WMT,JNJ,MRNA,V,NU,MELI,UBER,SATL,GGAL,VIST,YPF,PAM,BMA,CEPU,TGS,EDN,LOMA,BBAR,SUPV".split(",");
const UA = { "User-Agent": "Mozilla/5.0" };
async function trimestres(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1mo&range=15y`, { headers: UA });
  const res = (await r.json())?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators.quote[0], m = new Map();
  (res.timestamp || []).forEach((t, i) => {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    const d = new Date(t * 1000), k = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    const b = m.get(k);
    if (!b) m.set(k, { k, o: q.open[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    else { b.h = Math.max(b.h, q.high[i]); b.l = Math.min(b.l, q.low[i]); b.c = q.close[i]; }
  });
  return [...m.values()];
}
const TOL = 0.05;   // los tres máximos dentro de 5% entre sí
const casos = [], base = [];
let vist = null;
for (const tk of TICKERS) {
  let b; try { b = await trimestres(tk); } catch { b = null; }
  if (!b || b.length < 8) continue;
  const n = b.length - 1;
  for (let i = 3; i <= n; i++) {
    const hs = [b[i - 2].h, b[i - 1].h, b[i].h], techo = Math.max(...hs), piso = Math.min(b[i - 2].l, b[i - 1].l, b[i].l);
    const plano = (techo - Math.min(...hs)) / techo <= TOL;
    const subidaPrevia = b[i - 2].o / b[i - 3].o - 1;                 // venía subiendo antes del rango
    const posCierre = (b[i].c - piso) / (techo - piso);               // dónde cierra dentro del rango
    const ev = { tk, k: b[i].k, techo, piso, posCierre, subidaPrevia, ancho: techo / piso - 1 };
    if (tk === "VIST" && i === n) { vist = ev; continue; }
    if (i + 2 > n) continue;                                          // necesito 2 trimestres siguientes cerrados
    const s1 = b[i + 1], s2 = b[i + 2];
    const out = {
      ...ev,
      r1: s1.c / b[i].c - 1, r2: s2.c / b[i].c - 1,
      rompeArriba: Math.max(s1.h, s2.h) > techo * 1.01,
      pierdePiso: Math.min(s1.l, s2.l) < piso * 0.99,
      primero: null,
    };
    // cuál pasa primero (a resolución trimestral: el trimestre en que ocurre)
    const a1 = s1.h > techo * 1.01, p1 = s1.l < piso * 0.99, a2 = s2.h > techo * 1.01, p2 = s2.l < piso * 0.99;
    out.primero = a1 && !p1 ? "arriba" : p1 && !a1 ? "abajo" : a1 && p1 ? "ambos" : a2 && !p2 ? "arriba" : p2 && !a2 ? "abajo" : a2 && p2 ? "ambos" : "ninguno";
    base.push(out.r1);
    if (plano) casos.push(out);
  }
  await new Promise((r) => setTimeout(r, 100));
}
const p1 = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const resumen = (nom, a) => {
  if (!a.length) return console.log(`${nom}: sin casos`);
  const med = (k) => a.reduce((s, v) => s + v[k], 0) / a.length;
  const cnt = (f) => `${Math.round((a.filter(f).length / a.length) * 100)}%`;
  console.log(`${nom.padEnd(44)} n=${String(a.length).padStart(3)} · trim+1 ${p1(med("r1"))} · trim+2 ${p1(med("r2"))} · primero rompe arriba ${cnt((x) => x.primero === "arriba")} · primero pierde el piso ${cnt((x) => x.primero === "abajo")} · ambos ${cnt((x) => x.primero === "ambos")} · ninguno ${cnt((x) => x.primero === "ninguno")}`);
};
console.log("VIST hoy:", vist ? `techo ${vist.techo.toFixed(2)} · piso ${vist.piso.toFixed(2)} · cierra en el ${(vist.posCierre * 100).toFixed(0)}% del rango · ancho del rango ${p1(vist.ancho)} · subida previa ${p1(vist.subidaPrevia)}` : "no cumple 'techo plano' con tolerancia 5%");
console.log(`\nbase: todos los trimestres, retorno siguiente ${p1(base.reduce((s, v) => s + v, 0) / base.length)} (n=${base.length})\n`);
resumen("techo plano 3 trimestres (todos)", casos);
resumen("… y cierra en la mitad de ABAJO del rango", casos.filter((x) => x.posCierre < 0.5));
resumen("… y cierra en el tercio de ABAJO", casos.filter((x) => x.posCierre < 0.34));
resumen("… y cierra en la mitad de ARRIBA", casos.filter((x) => x.posCierre >= 0.5));
resumen("… mitad de abajo y venía de subir >30%", casos.filter((x) => x.posCierre < 0.5 && x.subidaPrevia > 0.3));
resumen("… mitad de abajo, rango ancho (>25%)", casos.filter((x) => x.posCierre < 0.5 && x.ancho > 0.25));
