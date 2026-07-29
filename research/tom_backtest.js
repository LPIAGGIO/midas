// Backtest Turn-of-the-Month (McConnell & Xu) extendido 2006-2026 sobre SPY
// TOM = última rueda del mes + primeras 3 del siguiente. Costos CEDEAR Cocos:
// derechos+IVA ~0,053% por pata → 0,106% por round-trip mensual.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const RT_COST = 0.00106;

async function candles(sym, fromISO) {
  const p1 = Math.floor(new Date(fromISO).getTime() / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=${p1}&period2=${p2}`, { headers: UA });
  const j = await r.json();
  const res = j.chart.result[0];
  const adj = res.indicators.adjclose?.[0]?.adjclose || res.indicators.quote[0].close;
  const out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (adj[i] != null) out.push({ d: new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), c: adj[i] });
  }
  return out;
}

function stats(rets) {
  const n = rets.length;
  const mu = rets.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mu) ** 2, 0) / (n - 1));
  return { n, mu, sd };
}

function analyze(cs, label) {
  // rank de cada rueda dentro de su mes + flag de última rueda del mes
  const rets = [];
  for (let i = 1; i < cs.length; i++) rets.push({ d: cs[i].d, r: cs[i].c / cs[i - 1].c - 1 });
  const monthOf = (d) => d.slice(0, 7);
  const rankInMonth = new Map();
  let cur = "", k = 0;
  for (const x of rets) { if (monthOf(x.d) !== cur) { cur = monthOf(x.d); k = 0; } k++; rankInMonth.set(x.d, k); }
  const isTom = rets.map((x, i) => {
    const last = i + 1 >= rets.length || monthOf(rets[i + 1].d) !== monthOf(x.d);
    return last || rankInMonth.get(x.d) <= 3;
  });
  const tom = rets.filter((_, i) => isTom[i]).map((x) => x.r);
  const rest = rets.filter((_, i) => !isTom[i]).map((x) => x.r);
  const sT = stats(tom), sR = stats(rest);
  const tstat = (sT.mu - sR.mu) / Math.sqrt(sT.sd ** 2 / sT.n + sR.sd ** 2 / sR.n);

  // estrategia: invertido SOLO en TOM, cash el resto; costo RT una vez por mes
  let eqTom = 1, eqBH = 1;
  const monthly = new Map(); // mes → {tom, bh}
  for (let i = 0; i < rets.length; i++) {
    const m = monthOf(rets[i].d);
    if (!monthly.has(m)) monthly.set(m, { tom: 1, bh: 1 });
    const mm = monthly.get(m);
    mm.bh *= 1 + rets[i].r;
    if (isTom[i]) mm.tom *= 1 + rets[i].r;
    eqBH *= 1 + rets[i].r;
    if (isTom[i]) eqTom *= 1 + rets[i].r;
  }
  // costos: un RT por mes en la estrategia TOM
  const months = [...monthly.keys()].length;
  const eqTomNet = eqTom * Math.pow(1 - RT_COST, months);
  const yrs = rets.length / 252;
  const cagr = (eq) => (Math.pow(eq, 1 / yrs) - 1) * 100;

  // Sharpe mensual de cada estrategia (retornos mensuales)
  const mTom = [...monthly.values()].map((m) => m.tom - 1 - RT_COST);
  const mBH = [...monthly.values()].map((m) => m.bh - 1);
  const shp = (arr) => { const s = stats(arr); return (s.mu / s.sd) * Math.sqrt(12); };
  const posDiff = mTom.filter((x, i) => x > 0).length / mTom.length * 100;

  console.log(`\n═══ ${label} (${rets[0].d} → ${rets[rets.length - 1].d}, ${months} meses) ═══`);
  console.log(`TOM:  ${(sT.mu * 100).toFixed(3)}%/día (${sT.n} ruedas)  |  Resto: ${(sR.mu * 100).toFixed(3)}%/día (${sR.n} ruedas)  |  t-stat: ${tstat.toFixed(2)}`);
  console.log(`CAGR buy&hold: ${cagr(eqBH).toFixed(2)}%  |  CAGR TOM bruto: ${cagr(eqTom).toFixed(2)}%  |  TOM neto de costos: ${cagr(eqTomNet).toFixed(2)}%`);
  console.log(`Sharpe mensual — TOM neto: ${shp(mTom).toFixed(2)}  |  buy&hold: ${shp(mBH).toFixed(2)}  |  meses TOM positivos: ${posDiff.toFixed(0)}%`);
  console.log(`Exposición TOM: ~${(sT.n / rets.length * 100).toFixed(0)}% del tiempo`);
}

(async () => {
  const spy = await candles("SPY", "2006-01-01");
  analyze(spy, "SPY 2006-2026 (fuera de muestra del paper)");
  analyze(spy.filter((c) => c.d < "2016-01-01"), "SPY 2006-2015");
  analyze(spy.filter((c) => c.d >= "2016-01-01"), "SPY 2016-2026");
  const qqq = await candles("QQQ", "2006-01-01");
  analyze(qqq, "QQQ 2006-2026");
})();
