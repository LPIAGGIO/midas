// Serverless: fundamentals de acciones USA (= subyacentes de CEDEARs) desde
// Yahoo Finance quoteSummary. Yahoo exige cookie + crumb; ese baile se hace
// acá (server-side) porque el browser no puede por CORS.
//
// Usage:
//   GET /api/fundamentals?tickers=AAPL,MSFT,NVDA
//
// Devuelve { data: [{ticker, price, mcap, trailPE, fwdPE, ps, pb, evEbitda,
//   evRev, netMrg, grossMrg, opMrg, revGrw, earnGrw, roe, de, cash, debt,
//   fcf, rec, divRate, divYield, exDiv, payDate}], errors:[...] }. divRate=US$/acción
//   anual, exDiv/payDate=unix(s). Cache 6h (los fundamentals cambian por trimestre).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MODULES = "summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents";

async function getAuth() {
  const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
  const sc = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
  const cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, "Cookie": cookie },
  });
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("no se pudo obtener crumb de Yahoo");
  return { cookie, crumb };
}

const raw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));

async function fetchOne(t, auth) {
  const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=${MODULES}&crumb=${encodeURIComponent(auth.crumb)}`;
  const r = await fetch(u, { headers: { "User-Agent": UA, "Cookie": auth.cookie } });
  const j = await r.json();
  const res = j?.quoteSummary?.result?.[0];
  if (!res) return null;
  const sd = res.summaryDetail || {}, ks = res.defaultKeyStatistics || {}, fd = res.financialData || {}, ap = res.assetProfile || {}, ce = res.calendarEvents || {};
  return {
    ticker: t,
    sector: ap.sector || null, industry: ap.industry || null,
    price: raw(fd.currentPrice), mcap: raw(sd.marketCap),
    trailPE: raw(sd.trailingPE), fwdPE: raw(sd.forwardPE),
    ps: raw(sd.priceToSalesTrailing12Months), pb: raw(ks.priceToBook),
    evEbitda: raw(ks.enterpriseToEbitda), evRev: raw(ks.enterpriseToRevenue),
    netMrg: raw(fd.profitMargins), grossMrg: raw(fd.grossMargins), opMrg: raw(fd.operatingMargins),
    revGrw: raw(fd.revenueGrowth), earnGrw: raw(fd.earningsGrowth),
    roe: raw(fd.returnOnEquity), de: raw(fd.debtToEquity),
    cash: raw(fd.totalCash), debt: raw(fd.totalDebt), fcf: raw(fd.freeCashflow),
    rec: fd.recommendationKey || null,
    // Dividendos: divRate = US$/acción anual; divYield = fracción; exDiv/payDate = unix (s).
    divRate: raw(sd.dividendRate) ?? raw(sd.trailingAnnualDividendRate),
    divYield: raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield),
    exDiv: raw(ce.exDividendDate) ?? raw(sd.exDividendDate),
    payDate: raw(ce.dividendDate),
  };
}

/* Tasa del bono del Tesoro a 10 años (^TNX, viene ×10 en Yahoo → el chart ya
 * devuelve el porcentaje, ej 4.68). Es la vara ABSOLUTA de valuación: el
 * earnings yield de una acción (la inversa del P/E) se compara contra esta
 * tasa para saber cuánta prima te pagan por asumir riesgo de acciones. Sin
 * esto, "barato" solo se puede definir contra otras acciones — y en 2000
 * estaban todas caras a la vez. Mismo fetch que hace el worker del snapshot,
 * replicado acá para que el modo en vivo (↻ Actualizar / tickers custom)
 * traiga el dato igual que el snapshot. */
async function fetchUs10y() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d", { headers: { "User-Agent": UA } });
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" ? Math.round(p * 100) / 100 : null;
  } catch { return null; }
}

/* ── Modo CONTEXTO DE MERCADO ──────────────────────────────────────────────
 *
 * Una foto de las variables que fijan la "temperatura" antes de operar:
 * curva de tasas de EE.UU., estructura temporal del VIX, liderazgo entre
 * índices y commodities. Idea tomada del checklist de @RudolphTrading
 * (16/08/2026), adaptada.
 *
 * Vive colgado de /api/fundamentals y no en su propio endpoint porque el plan
 * Hobby de Vercel topea en 12 funciones serverless y ya estamos en 12.
 *
 * Usa el endpoint `chart` (no exige el baile de cookie+crumb) y toma el cierre
 * previo de las BARRAS, nunca de `meta.chartPreviousClose`: ese campo devuelve
 * el cierre anterior al RANGO pedido, no el de ayer, y ya nos hizo leer mal una
 * variación diaria el 13/08.
 */
const MERCADO_SERIES = {
  // El 2 años va con 2YY=F (futuro del rendimiento): Yahoo no publica un índice
  // ^TWO. Sin él sólo se podía calcular 10a−3m, y el spread que mira el mercado
  // es el 10s2s.
  tasas:    { y2: "2YY=F", m3: "^IRX", y5: "^FVX", y10: "^TNX", y30: "^TYX" },
  vix:      { d9: "^VIX9D", d30: "^VIX", m3: "^VIX3M", m6: "^VIX6M" },
  indices:  { sp500: "^GSPC", nasdaq: "^IXIC", russell: "^RUT" },
  commodities: { wti: "CL=F", oro: "GC=F", cobre: "HG=F" },
  // HYG = bonos basura, LQD = grado de inversión. El cociente es un termómetro
  // de apetito por riesgo en el mercado de crédito. Ver el comentario del front
  // sobre cómo se lee: NO es lo que parece.
  credito:  { hyg: "HYG", lqd: "LQD" },
  divisas:  { dxy: "DX-Y.NYB" },
};

async function serieCorta(sym) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10d`,
      { headers: { "User-Agent": UA } }
    );
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res) return null;
    const cierres = (res.indicators?.quote?.[0]?.close || []).filter((x) => x != null);
    if (!cierres.length) return null;
    const last = res.meta?.regularMarketPrice ?? cierres[cierres.length - 1];
    // El cierre "de ayer" es la penúltima barra si la última es la de hoy.
    const prev = cierres.length > 1 ? cierres[cierres.length - 2] : null;
    return {
      v: Math.round(last * 10000) / 10000,
      prev: prev != null ? Math.round(prev * 10000) / 10000 : null,
      chg: prev ? Math.round((last / prev - 1) * 100 * 100) / 100 : null,
    };
  } catch { return null; }
}

async function contextoMercado() {
  const out = {};
  for (const [grupo, mapa] of Object.entries(MERCADO_SERIES)) {
    const claves = Object.keys(mapa);
    const vals = await Promise.all(claves.map((k) => serieCorta(mapa[k])));
    out[grupo] = {};
    claves.forEach((k, i) => { out[grupo][k] = vals[i]; });
  }
  // El ratio de crédito se calcula acá y no en el front: así el front recibe un
  // número listo y no tiene que saber que HYG y LQD se dividen entre sí.
  const h = out.credito?.hyg, l = out.credito?.lqd;
  if (h?.v && l?.v) {
    const ratio = h.v / l.v;
    const prev = (h.prev && l.prev) ? h.prev / l.prev : null;
    out.credito.ratio = {
      v: Math.round(ratio * 10000) / 10000,
      prev: prev != null ? Math.round(prev * 10000) / 10000 : null,
      chg: prev ? Math.round((ratio / prev - 1) * 100 * 100) / 100 : null,
    };
  }
  return out;
}

export default async function handler(req, res) {
  if (String(req.query?.mode || "") === "market") {
    try {
      const data = await contextoMercado();
      // 5 min: es contexto, no precio de ejecución. No hace falta más fresco.
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=900");
      return res.status(200).json({ data, fetchedAt: new Date().toISOString() });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Modo PRECIO liviano: ?price=SPY,QQQ,AEM → { prices: { SYM: number } }.
  // Usa el endpoint chart (no exige crumb) para traer regularMarketPrice. Sirve
  // de fallback del subyacente USD cuando data912 USA no lo tiene (ETFs, ADRs).
  const priceQ = String(req.query?.price || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  if (priceQ.length) {
    const prices = {};
    await Promise.all(priceQ.map(async (s) => {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=1d`, { headers: { "User-Agent": UA } });
        const j = await r.json();
        const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
        if (Number.isFinite(p)) prices[s] = p;
      } catch { /* salteo el que falle */ }
    }));
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json({ prices });
  }

  const tickers = String(req.query?.tickers || "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 60);
  if (!tickers.length) return res.status(400).json({ error: "Falta ?tickers=AAPL,MSFT,..." });

  try {
    const auth = await getAuth();
    const data = [], errors = [];
    // de a 8 en paralelo para no excederse del timeout ni que Yahoo limite
    for (let i = 0; i < tickers.length; i += 8) {
      const chunk = tickers.slice(i, i + 8);
      const results = await Promise.all(chunk.map(async (t) => {
        try { return await fetchOne(t, auth); } catch { return { __err: t }; }
      }));
      for (const r of results) {
        if (!r) continue;
        if (r.__err) errors.push(r.__err); else data.push(r);
      }
    }
    // La tasa a 10 años viaja adentro de cada fila (igual que en el snapshot):
    // así el front la tiene sin una consulta extra y queda pegada al múltiplo
    // del mismo momento. Si Yahoo no la da, las filas van sin el campo y la
    // pantalla muestra "—" en la prima.
    const us10y = await fetchUs10y();
    if (us10y != null) { for (const r of data) r.us10y = us10y; }
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json({ data, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
