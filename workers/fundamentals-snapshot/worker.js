/**
 * Worker fundamentals-snapshot: snapshot semanal de fundamentals de los
 * subyacentes USA (= CEDEARs) en la tabla Supabase `fundamentals_snapshot`.
 *
 * POR QUÉ: la pantalla "Fundamentals CEDEARs" pegaba en vivo a Yahoo en cada
 * carga (crumb dance). Yahoo es flaky y a veces devuelve vacío → pantalla en
 * blanco. Este worker persiste un snapshot que la pantalla lee primero (rápido
 * y confiable), con "última actualización" visible. El botón ↻ Actualizar y las
 * consultas de tickers custom siguen pegando en vivo.
 *
 * FUENTE: Yahoo Finance quoteSummary (mismo baile cookie+crumb que
 * api/fundamentals.js). Idempotente: upsert por ticker.
 *
 * UNIVERSO: debe espejar FUND_UNIVERSE del front (MidasTerminal.jsx). Si agregás
 * un ticker allá, agregalo acá.
 *
 * Schedule: PM2 cron_restart lunes 07:00 ART (ver ecosystem.config.js). Los
 * fundamentals cambian por trimestre; semanal alcanza y sobra. Override manual:
 *   TICKERS=AAPL,MSFT node worker.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Verifica .env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

// Espejo de FUND_UNIVERSE en MidasTerminal.jsx.
const FUND_UNIVERSE =
  "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,NFLX,AVGO,KO,MELI,JPM,V,MA,WMT,JNJ,PG,XOM,DIS,COIN,PLTR,MSTR,QCOM,MU,INTC,ORCL,CRM,NKE,BA,CRWV,IREN,SNDK,SPCX";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MODULES = "summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents";
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

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
    divRate: raw(sd.dividendRate) ?? raw(sd.trailingAnnualDividendRate),
    divYield: raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield),
    exDiv: raw(ce.exDividendDate) ?? raw(sd.exDividendDate),
    payDate: raw(ce.dividendDate),
  };
}

async function main() {
  log("fundamentals-snapshot arrancando");
  const tickers = String(process.env.TICKERS || FUND_UNIVERSE)
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

  const auth = await getAuth();
  const rows = [], errors = [];
  // de a 8 en paralelo, como el endpoint serverless, para no gatillar el rate
  // limit de Yahoo.
  for (let i = 0; i < tickers.length; i += 8) {
    const chunk = tickers.slice(i, i + 8);
    const results = await Promise.all(chunk.map(async (t) => {
      try { return await fetchOne(t, auth); } catch { return { __err: t }; }
    }));
    for (const r of results) {
      if (!r) continue;
      if (r.__err) errors.push(r.__err); else rows.push(r);
    }
  }

  if (!rows.length) throw new Error("Yahoo no devolvió ningún dato; no piso el snapshot");
  // Sanidad mínima: al menos la mitad del universo tiene que haber venido.
  if (rows.length < tickers.length / 2) {
    throw new Error(`solo ${rows.length}/${tickers.length} tickers OK; abortando para no dejar snapshot degradado`);
  }

  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ ticker: r.ticker, data: r, fetched_at: now }));
  const { error } = await supabase.from("fundamentals_snapshot").upsert(payload, { onConflict: "ticker" });
  if (error) throw new Error(`upsert: ${error.message}`);

  log(`snapshot OK: ${rows.length} tickers${errors.length ? `, ${errors.length} fallaron (${errors.join(",")})` : ""}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] fatal:`, err.message || err);
    process.exit(1);
  });
