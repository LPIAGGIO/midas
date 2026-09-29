/**
 * Worker fundamentals-snapshot: snapshot diario de fundamentals de los
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
 * Schedule: PM2 cron_restart lunes a viernes 07:00 ART (ver ecosystem.config.js;
 * era semanal hasta el 11/08/2026). Override manual:
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
  "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,NFLX,AVGO,KO,MELI,JPM,V,MA,WMT,JNJ,PG,XOM,DIS,COIN,PLTR,MSTR,QCOM,MU,INTC,ORCL,CRM,NKE,BA,CRWV,IREN,SNDK,SPCX,NU,LLY,CAT";

// Espejo de FUND_SEGUIMIENTOS: small caps en observación (sin plata puesta).
// Corren en la misma pasada para que acumulen historia en fundamentals_history
// desde el dia 1 — sin eso, dentro de tres meses no se puede contestar si una
// se abarató contra SI MISMA, que es la unica vara que sirve para papeles asi.
// El front las separa en su propia lista; acá van juntas porque el upsert es
// por ticker y no se pisan.
const FUND_SEGUIMIENTOS = "AMPG,SHAZ,OUST,CCXI,WYFI,WULF,POET,ONDS,OPTX,ALAB,RMBS,MRVL,PENG,CORZ,NBIS";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const MODULES = "summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,earningsTrend";
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

/* Crecimiento de varios años y dilución (filtro estilo Peter Lynch, 29/09/2026).
 * El quoteSummary solo trae el crecimiento del último trimestre contra el
 * mismo del año anterior; para "EPS creciendo 15% anual varios años" y "cuánto
 * se diluye el accionista" hace falta la serie anual, que Yahoo expone en el
 * endpoint fundamentals-timeseries (mismo cookie+crumb).
 *   epsCagr / revCagr: crecimiento anual compuesto del EPS diluido y de las
 *     ventas entre el primer año con base positiva y el último (Yahoo da hasta
 *     4 años, así que es un CAGR de 2-3 años, no los 5 de Finviz).
 *   shrYoY: acciones diluidas promedio del último trimestre contra el de un
 *     año antes. Positivo = el accionista se diluye (emisión, SBC); negativo =
 *     recompras.
 *   sbcPct: compensación en acciones de los últimos 12 meses sobre ventas.
 *   grwFwd: crecimiento esperado del EPS del próximo año fiscal (consenso). */
const SERIE_TYPES = "annualDilutedEPS,annualTotalRevenue,annualDilutedAverageShares,quarterlyDilutedAverageShares,trailingStockBasedCompensation";

async function fetchSerie(t, auth) {
  const p2 = Math.floor(Date.now() / 1000), p1 = p2 - 6 * 365 * 86400;
  const u = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(t)}?symbol=${encodeURIComponent(t)}&type=${SERIE_TYPES}&period1=${p1}&period2=${p2}&crumb=${encodeURIComponent(auth.crumb)}`;
  const r = await fetch(u, { headers: { "User-Agent": UA, "Cookie": auth.cookie } });
  const j = await r.json();
  const by = {};
  for (const s of j?.timeseries?.result || []) {
    const k = s?.meta?.type?.[0];
    if (!k) continue;
    by[k] = (s[k] || [])
      .filter((x) => x && x.asOfDate && x.reportedValue && Number.isFinite(x.reportedValue.raw))
      .map((x) => ({ d: x.asOfDate, v: x.reportedValue.raw }))
      .sort((a, b) => (a.d < b.d ? -1 : 1));
  }
  return by;
}

const diasEntre = (a, b) => (new Date(b) - new Date(a)) / 86400000;

// CAGR desde el primer año con base positiva (el EPS negativo no tiene tasa de
// crecimiento) hasta el último, con al menos 2 años de distancia.
function cagr(arr) {
  if (!arr || arr.length < 3) return { v: null, anios: null };
  const last = arr[arr.length - 1];
  if (!(last.v > 0)) return { v: null, anios: null };
  for (const p of arr) {
    const anios = Math.round(diasEntre(p.d, last.d) / 365.25);
    if (anios < 2) break;
    if (p.v > 0) return { v: Math.pow(last.v / p.v, 1 / anios) - 1, anios };
  }
  return { v: null, anios: null };
}

// Dilución interanual: último trimestre contra el más cercano a un año antes;
// si faltan trimestres, los dos últimos años.
function dilucion(by) {
  const q = by.quarterlyDilutedAverageShares || [];
  if (q.length >= 2) {
    const last = q[q.length - 1];
    let prev = null, mejor = Infinity;
    for (const p of q) {
      const dd = Math.abs(diasEntre(p.d, last.d) - 365);
      if (dd < 75 && dd < mejor) { prev = p; mejor = dd; }
    }
    if (prev && prev.v > 0) return last.v / prev.v - 1;
  }
  const a = by.annualDilutedAverageShares || [];
  if (a.length >= 2 && a[a.length - 2].v > 0) return a[a.length - 1].v / a[a.length - 2].v - 1;
  return null;
}

function lynchDe(by, fd, et) {
  const eps = cagr(by.annualDilutedEPS), rev = cagr(by.annualTotalRevenue);
  const sbc = (by.trailingStockBasedCompensation || []).slice(-1)[0]?.v;
  const ventas = raw(fd?.totalRevenue);
  const fwd = (et?.trend || []).find((x) => x?.period === "+1y");
  return {
    epsCagr: eps.v, epsAnios: eps.anios,
    revCagr: rev.v, revAnios: rev.anios,
    shrYoY: dilucion(by),
    sbcPct: sbc != null && ventas > 0 ? sbc / ventas : null,
    grwFwd: raw(fwd?.growth),
  };
}

async function fetchOne(t, auth) {
  const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(t)}?modules=${MODULES}&crumb=${encodeURIComponent(auth.crumb)}`;
  // La serie anual va en paralelo; si falla, la fila sale igual sin las
  // columnas de varios años.
  const [r, by] = await Promise.all([
    fetch(u, { headers: { "User-Agent": UA, "Cookie": auth.cookie } }),
    fetchSerie(t, auth).catch(() => ({})),
  ]);
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
    ...lynchDe(by, fd, res.earningsTrend),
  };
}

/* Tasa del bono del Tesoro a 10 años (^TNX, viene ×10 en Yahoo). Es la vara
 * ABSOLUTA de valuación: el earnings yield de una acción (la inversa del
 * P/E) se compara contra esta tasa para saber cuánta prima te pagan por
 * asumir riesgo de acciones. Sin este número, "barato" solo puede definirse
 * contra otras acciones — y en 2000 todas estaban caras a la vez. */
async function fetchUs10y() {
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5ETNX?interval=1d&range=5d", { headers: { "User-Agent": UA } });
    const j = await r.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    return typeof p === "number" ? Math.round(p * 100) / 100 : null;
  } catch { return null; }
}

async function main() {
  log("fundamentals-snapshot arrancando");
  const tickers = [...new Set(
    String(process.env.TICKERS || `${FUND_UNIVERSE},${FUND_SEGUIMIENTOS}`)
      .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
  )];

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

  // La tasa a 10 años viaja adentro de cada fila: así el front la tiene sin
  // una consulta extra y queda congelada en la historia junto al múltiplo del
  // día (la prima de ese momento es lo que importa, no la de hoy).
  const us10y = await fetchUs10y();
  if (us10y != null) { for (const r of rows) r.us10y = us10y; }
  log(`bono 10Y EE.UU.: ${us10y != null ? us10y + "%" : "no disponible"}`);

  const now = new Date().toISOString();
  const payload = rows.map((r) => ({ ticker: r.ticker, data: r, fetched_at: now }));
  const { error } = await supabase.from("fundamentals_snapshot").upsert(payload, { onConflict: "ticker" });
  if (error) throw new Error(`upsert: ${error.message}`);

  // Además del snapshot vigente (que se pisa cada semana), acumular HISTORIA:
  // una fila por ticker y fecha. Sin esto no se puede responder si un papel
  // está caro o barato contra SU PROPIA historia — solo contra los otros de
  // la lista, que es una vara mucho más pobre. Se empezó el 11/08/2026.
  const hoy = now.slice(0, 10);
  const hist = rows.map((r) => ({ ticker: r.ticker, snapshot_date: hoy, data: r }));
  const { error: eh } = await supabase.from("fundamentals_history")
    .upsert(hist, { onConflict: "ticker,snapshot_date" });
  if (eh) log(`historia: ${eh.message}`); // no aborta: el snapshot vigente ya quedó guardado

  log(`snapshot OK: ${rows.length} tickers${errors.length ? `, ${errors.length} fallaron (${errors.join(",")})` : ""}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] fatal:`, err.message || err);
    process.exit(1);
  });
