// Soportes en velas TRIMESTRALES del universo del bot (30/09/2026, cierre de
// trimestre). Pregunta de LP: cuáles están en soporte trimestral y cierran
// arriba; hipótesis: "las que cierran arriba del soporte van para arriba".
// Datos: Yahoo mensual (ajustado por splits) agregado a trimestres calendario.
//   node soportes.mjs
const TICKERS = "AAPL,MSFT,GOOGL,META,AMZN,NVDA,TSLA,NFLX,ADBE,ORCL,IBM,HPQ,MU,SNDK,AMD,INTC,AVGO,QCOM,MRVL,ARM,ADI,PLTR,NBIS,IREN,RGTI,KEEL,COIN,MSTR,HUT,XOM,VST,OKLO,GPRK,LAC,LAR,KO,MCD,WMT,JNJ,MRNA,V,NU,MELI,UBER,SPCX,SATL,GGAL,VIST".split(",");
const UA = { "User-Agent": "Mozilla/5.0" };
const TOL = 0.03;      // el mínimo del trimestre llegó a 3% o menos del nivel
const PROF = 0.10;     // …y no lo perforó más de 10% (si no, no es "tocar")

async function trimestres(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1mo&range=12y`, { headers: UA });
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators.quote[0];
  const m = new Map();
  (res.timestamp || []).forEach((t, i) => {
    if (q.close[i] == null || q.high[i] == null || q.low[i] == null) return;
    const d = new Date(t * 1000);   // sin corrimiento: la barra "en vivo" de hoy (30/09) caia en octubre
    const k = `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    const b = m.get(k);
    if (!b) m.set(k, { k, o: q.open[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i] });
    else { b.h = Math.max(b.h, q.high[i]); b.l = Math.min(b.l, q.low[i]); b.c = q.close[i]; }
  });
  const arr = [...m.values()];
  const px = res.meta.regularMarketPrice;
  if (arr.length && px > 0) { const u = arr[arr.length - 1]; u.c = px; u.h = Math.max(u.h, px); u.l = Math.min(u.l, px); }
  return arr;
}

// Niveles conocidos ANTES del trimestre i: pisos y techos trimestrales (pivote
// con un trimestre a cada lado, confirmado: el pivote es i-2 o anterior).
function niveles(b, i) {
  const out = [];
  for (let p = 1; p <= i - 2; p++) {
    if (b[p].l < b[p - 1].l && b[p].l < b[p + 1].l) out.push({ tipo: "piso", v: b[p].l, k: b[p].k });
    if (b[p].h > b[p - 1].h && b[p].h > b[p + 1].h) out.push({ tipo: "techo", v: b[p].h, k: b[p].k });
  }
  return out;
}
// ¿El trimestre i tocó un nivel? Devuelve el nivel más alto tocado.
function toque(b, i) {
  const c = b[i];
  const cand = niveles(b, i).filter((n) => c.l <= n.v * (1 + TOL) && c.l >= n.v * (1 - PROF) && b[i - 1].c > n.v * (1 - PROF));
  if (!cand.length) return null;
  return cand.sort((x, y) => y.v - x.v)[0];
}

const filas = [], ev = { sostuvo: [], rompio: [], todos: [] };
for (const tk of TICKERS) {
  let b;
  try { b = await trimestres(tk); } catch { b = null; }
  if (!b || b.length < 5) { filas.push({ tk, nota: `solo ${b ? b.length : 0} trimestres de historia` }); continue; }
  const n = b.length - 1, cq = b[n];
  // estudio histórico (sin el trimestre en curso)
  for (let i = 4; i < n; i++) {
    const sig = b[i + 1].c / b[i].c - 1;
    if (i + 1 === n) continue;                 // el siguiente todavía no cerró: afuera
    ev.todos.push(sig);
    const t = toque(b, i);
    if (!t) continue;
    (b[i].c >= t.v ? ev.sostuvo : ev.rompio).push({ tk, k: b[i].k, sig });
  }
  const t = toque(b, n);
  const nivs = niveles(b, n).filter((x) => x.v < cq.c).sort((x, y) => y.v - x.v);
  const abajo = nivs[0] || null;
  const rango = cq.h - cq.l;
  filas.push({
    tk, px: cq.c, o: cq.o, h: cq.h, l: cq.l, trim: (cq.c / cq.o - 1) * 100,
    posRango: rango > 0 ? ((cq.c - cq.l) / rango) * 100 : null,
    toque: t, sostiene: t ? cq.c >= t.v : null, sobre: t ? (cq.c / t.v - 1) * 100 : null,
    soporteAbajo: abajo, distAbajo: abajo ? (cq.c / abajo.v - 1) * 100 : null, nq: b.length,
  });
  await new Promise((r) => setTimeout(r, 120));
}

const f2 = (x) => (x == null ? "—" : x.toFixed(2));
const p1 = (x) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`);
console.log("\n=== A) TOCARON un soporte trimestral este trimestre y CIERRAN ARRIBA ===");
for (const f of filas.filter((x) => x.toque && x.sostiene).sort((a, b) => a.sobre - b.sobre))
  console.log(`${f.tk.padEnd(5)} precio ${f2(f.px).padStart(9)} · soporte ${f2(f.toque.v).padStart(9)} (${f.toque.tipo} ${f.toque.k}) · mínimo trim ${f2(f.l).padStart(9)} · cierra ${p1(f.sobre)} arriba · trimestre ${p1(f.trim)} · cierre en el ${f.posRango?.toFixed(0)}% del rango`);
console.log("\n=== B) TOCARON un soporte trimestral y están cerrando ABAJO (rotura) ===");
for (const f of filas.filter((x) => x.toque && !x.sostiene).sort((a, b) => a.sobre - b.sobre))
  console.log(`${f.tk.padEnd(5)} precio ${f2(f.px).padStart(9)} · soporte ${f2(f.toque.v).padStart(9)} (${f.toque.tipo} ${f.toque.k}) · ${p1(f.sobre)} · trimestre ${p1(f.trim)}`);
console.log("\n=== C) No tocaron soporte; el más cercano abajo ===");
for (const f of filas.filter((x) => x.px && !x.toque).sort((a, b) => (a.distAbajo ?? 999) - (b.distAbajo ?? 999)))
  console.log(`${f.tk.padEnd(5)} precio ${f2(f.px).padStart(9)} · soporte abajo ${f.soporteAbajo ? f2(f.soporteAbajo.v).padStart(9) + ` (${f.soporteAbajo.tipo} ${f.soporteAbajo.k})` : "  ninguno"} · a ${p1(f.distAbajo)} · trimestre ${p1(f.trim)}`);
console.log("\n=== D) Sin historia suficiente ===");
console.log(filas.filter((x) => x.nota).map((x) => `${x.tk} (${x.nota})`).join(" · ") || "ninguno");

const est = (a) => { const n = a.length; if (!n) return null; const m = a.reduce((s, v) => s + v, 0) / n; const sd = Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, n - 1)); const s = [...a].sort((x, y) => x - y); return { n, media: m * 100, mediana: s[Math.floor(n / 2)] * 100, pos: (a.filter((v) => v > 0).length / n) * 100, t: sd > 0 ? m / (sd / Math.sqrt(n)) : 0 }; };
console.log("\n=== ESTUDIO HISTÓRICO: retorno del TRIMESTRE SIGUIENTE (mismos papeles, hasta 12 años) ===");
for (const [nom, a] of [["todos los trimestres", ev.todos], ["tocó soporte y cerró ARRIBA", ev.sostuvo.map((x) => x.sig)], ["tocó soporte y cerró ABAJO", ev.rompio.map((x) => x.sig)]]) {
  const e = est(a);
  console.log(`${nom.padEnd(30)} n=${String(e?.n ?? 0).padStart(4)} · media ${p1(e?.media)} · mediana ${p1(e?.mediana)} · suben ${e ? e.pos.toFixed(0) : "—"}% · t ${e ? e.t.toFixed(2) : "—"}`);
}
// la diferencia que importa: sostuvo vs todos
const a = ev.sostuvo.map((x) => x.sig), b = ev.todos;
const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length;
const va = a.reduce((s, v) => s + (v - ma) ** 2, 0) / (a.length - 1), vb = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (b.length - 1);
console.log(`diferencia (cerró arriba − todos): ${p1((ma - mb) * 100)} · t ${((ma - mb) / Math.sqrt(va / a.length + vb / b.length)).toFixed(2)}`);
const porAnio = {}; for (const x of ev.sostuvo) { const y = x.k.slice(0, 4); (porAnio[y] ||= []).push(x.sig); }
console.log("por año (cerró arriba): " + Object.entries(porAnio).sort().map(([y, v]) => `${y}: n${v.length} ${p1((v.reduce((s, q) => s + q, 0) / v.length) * 100)}`).join(" · "));
