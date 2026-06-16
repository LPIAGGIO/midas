// Serverless: fundamentals de acciones USA (= subyacentes de CEDEARs) desde
// Yahoo Finance quoteSummary. Yahoo exige cookie + crumb; ese baile se hace
// acá (server-side) porque el browser no puede por CORS.
//
// Usage:
//   GET /api/fundamentals?tickers=AAPL,MSFT,NVDA
//
// Devuelve { data: [{ticker, price, mcap, trailPE, fwdPE, ps, pb, evEbitda,
//   evRev, netMrg, grossMrg, opMrg, revGrw, earnGrw, roe, de, cash, debt,
//   fcf, rec}], errors:[...] }. Cache 6h (los fundamentals cambian por trimestre).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MODULES = "summaryDetail,defaultKeyStatistics,financialData";

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
  const sd = res.summaryDetail || {}, ks = res.defaultKeyStatistics || {}, fd = res.financialData || {};
  return {
    ticker: t,
    price: raw(fd.currentPrice), mcap: raw(sd.marketCap),
    trailPE: raw(sd.trailingPE), fwdPE: raw(sd.forwardPE),
    ps: raw(sd.priceToSalesTrailing12Months), pb: raw(ks.priceToBook),
    evEbitda: raw(ks.enterpriseToEbitda), evRev: raw(ks.enterpriseToRevenue),
    netMrg: raw(fd.profitMargins), grossMrg: raw(fd.grossMargins), opMrg: raw(fd.operatingMargins),
    revGrw: raw(fd.revenueGrowth), earnGrw: raw(fd.earningsGrowth),
    roe: raw(fd.returnOnEquity), de: raw(fd.debtToEquity),
    cash: raw(fd.totalCash), debt: raw(fd.totalDebt), fcf: raw(fd.freeCashflow),
    rec: fd.recommendationKey || null,
  };
}

export default async function handler(req, res) {
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
    res.setHeader("Cache-Control", "public, s-maxage=21600, stale-while-revalidate=86400");
    return res.status(200).json({ data, errors });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
