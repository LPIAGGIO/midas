/**
 * Worker fondos — datos de la pantalla Fondos (Fase 1: ETF con CEDEAR).
 *
 * Tres modos, cada uno con su cron de PM2 (ver ecosystem.config.js):
 *
 *   --perfil    lun-vie 08:15 ART, antes de que abra BYMA: los cierres de
 *               data912 (CEDEAR) y de Yahoo (ETF) son de la misma rueda.
 *               Arma el universo (los CEDEAR cuyo subyacente Yahoo marca como
 *               ETF), baja perfil, rendimientos, volatilidad y dividendos, y
 *               deriva el ratio del CEDEAR. Escribe `fondos` y `fondos_cedear`.
 *   --holdings  todos los días 07:30: composición. State Street publica el
 *               archivo diario (SPY, DIA, XL*); el resto sale del N-PORT de la
 *               SEC (trimestral, 60 días de atraso). Solo baja un N-PORT si el
 *               accession cambió. Escribe `fondos_holdings` y actualiza
 *               `fondos` (fuente, fecha, países).
 *   --maestro   día 1 de cada mes: CUSIP y sector de los subyacentes de
 *               CEDEAR en `valores_maestro` (Comafi + State Street + Yahoo
 *               assetProfile). El front lo usa para el sector de la cartera y
 *               para cruzar por emisor.
 *
 *   --dry-run   no escribe nada; --solo SMH,SPY limita el universo;
 *   --forzar    (con --holdings) rebaja el N-PORT aunque no haya cambiado.
 *
 * Fuentes probadas el 17/10/2026 desde el VPS (docs/fondos-diseno.md). NO
 * andan: CSV de iShares (devuelve HTML) y API de Vanguard (301 a HTML); para
 * ellos queda el N-PORT.
 *
 * RATIO: no hay fuente oficial completa. Se deriva como
 *   round(precio_USD × CCL_ref / precio_CEDEAR)
 * con CCL_ref = mediana del CCL implícito de las anclas de EJEC_RATIOS. Si el
 * ETF está en la planilla de Comafi manda Comafi (los 15 que coinciden dieron
 * igual el 17/10). Si un día el derivado se aparta más de 2% del guardado no
 * se pisa: queda el guardado y se marca dudoso (split o dato podrido; lo mira
 * una persona). La pantalla no muestra precio implícito con ratio dudoso.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const XLSX = require("xlsx");

const ARGS = process.argv.slice(2);
const DRY = ARGS.includes("--dry-run");
const FORZAR = ARGS.includes("--forzar"); // rebaja el N-PORT aunque el accession no haya cambiado
const MODO = ["--perfil", "--holdings", "--maestro"].find((m) => ARGS.includes(m));
const SOLO = (() => {
  const i = ARGS.indexOf("--solo");
  return i >= 0 && ARGS[i + 1] ? new Set(ARGS[i + 1].split(",").map((s) => s.trim().toUpperCase())) : null;
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws },
});

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const UA_SEC = "Midas Research lpiaggio@gmail.com"; // EDGAR exige contacto real
const HOY = new Date().toISOString().slice(0, 10);

async function pedir(url, { headers = {}, tipo = "json", intentos = 3, ...rest } = {}) {
  let ultimo;
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA_WEB, ...headers }, redirect: "follow", ...rest });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (tipo === "json") return await r.json();
      if (tipo === "text") return await r.text();
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      ultimo = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw new Error(`${url.slice(0, 90)}: ${ultimo?.message}`);
}

// ── Universo y clasificación ──────────────────────────────────────────────
// Anclas para el CCL de referencia (mismas que EJEC_RATIOS del front).
const ANCLAS = { AAPL: 20, MSFT: 30, NVDA: 24, KO: 5, AMZN: 144, META: 24, GOOGL: 58 };

// Los que no presentan N-PORT y cuya "composición" es el activo mismo.
const TRUSTS = {
  GLD: { tipo: "trust", nombre: "Oro físico" },
  SLV: { tipo: "trust", nombre: "Plata física" },
  IBIT: { tipo: "trust", nombre: "Bitcoin" },
  ETHA: { tipo: "trust", nombre: "Ether" },
  USO: { tipo: "trust", nombre: "Futuros de petróleo WTI" },
  CORN: { tipo: "trust", nombre: "Futuros de maíz" },
  SOYB: { tipo: "trust", nombre: "Futuros de soja" },
  GSG: { tipo: "trust", nombre: "Futuros de commodities (S&P GSCI)" },
  VXX: { tipo: "ETN", nombre: "Futuros de VIX (ETN: es deuda de Barclays, no un fondo)" },
};
const UIT = new Set(["SPY", "DIA"]); // fondos de inversión por unidad: sin N-PORT

/* Comparador elegido a mano (decisión de LP del 17/10: índice de referencia
 * por fondo, con SPY al lado como costo de oportunidad y la categoría de Yahoo
 * solo como dato). Los índices sectoriales del S&P no tienen historia en
 * Yahoo, así que los XL* (salvo XLRE) quedan solo contra SPY. Los índices en
 * otra moneda se pasan a USD con el tipo de cambio de Yahoo: fx = moneda
 * local por USD, salvo inv (EURUSD = USD por EUR). */
const COMPARADORES = {
  SPY: ["^SP500TR", "S&P 500 con dividendos"],
  IVV: ["^SP500TR", "S&P 500 con dividendos"],
  ESGU: ["^SP500TR", "S&P 500 con dividendos"],
  SPHQ: ["^SP500TR", "S&P 500 con dividendos"],
  IVW: ["^SP500TR", "S&P 500 con dividendos"],
  IVE: ["^SP500TR", "S&P 500 con dividendos"],
  VIG: ["^SP500TR", "S&P 500 con dividendos"],
  SPXL: ["^SP500TR", "S&P 500 con dividendos", "el ETF es 3x diario: no sigue 3x del índice en plazos largos"],
  SH: ["^SP500TR", "S&P 500 con dividendos", "el ETF es -1x diario"],
  RSP: ["^SPXEW", "S&P 500 equiponderado", "índice de precio, sin dividendos"],
  QQQ: ["^NDX", "Nasdaq-100", "índice de precio, sin dividendos"],
  TQQQ: ["^NDX", "Nasdaq-100", "índice de precio; el ETF es 3x diario"],
  PSQ: ["^NDX", "Nasdaq-100", "índice de precio; el ETF es -1x diario"],
  ARKK: ["^NDX", "Nasdaq-100", "índice de precio, sin dividendos"],
  DIA: ["^DJI", "Dow Jones Industrial", "índice de precio, sin dividendos"],
  IWM: ["^RUT", "Russell 2000", "índice de precio, sin dividendos"],
  IJH: ["^SP400", "S&P MidCap 400", "índice de precio, sin dividendos"],
  SMH: ["^SOX", "PHLX Semiconductor (SOX)", "índice de precio; SMH sigue al MVIS US Listed Semiconductor 25, que no está en Yahoo"],
  XLRE: ["^SP500-60", "S&P 500 Real Estate", "índice de precio, sin dividendos"],
  EWZ: ["^BVSP", "Bovespa en USD", "índice de precio en BRL pasado a USD con BRL=X", "BRL=X"],
  EWJ: ["^N225", "Nikkei 225 en USD", "índice de precio en JPY pasado a USD con JPY=X", "JPY=X"],
  EWY: ["^KS11", "KOSPI en USD", "índice de precio en KRW pasado a USD con KRW=X", "KRW=X"],
  FXI: ["^HSI", "Hang Seng en USD", "índice de precio en HKD pasado a USD; FXI sigue al FTSE China 50", "HKD=X"],
  IEUR: ["^STOXX", "STOXX Europe 600 en USD", "índice de precio en EUR pasado a USD con EURUSD=X", "EURUSD=X", true],
  BBCA: ["^GSPTSE", "S&P/TSX en USD", "índice de precio en CAD pasado a USD con CAD=X", "CAD=X"],
  GLD: ["GC=F", "Oro (futuro continuo)"],
  GDX: ["GC=F", "Oro (futuro continuo)", "mineras contra el metal"],
  SLV: ["SI=F", "Plata (futuro continuo)"],
  COPX: ["HG=F", "Cobre (futuro continuo)", "mineras contra el metal"],
  USO: ["CL=F", "WTI (futuro continuo)", "el ETF rola futuros: pierde contra el spot en curva en contango"],
  IBIT: ["BTC-USD", "Bitcoin"],
  ETHA: ["ETH-USD", "Ether"],
  VXX: ["^VIX", "VIX (spot)", "el ETN rola futuros de VIX y se derrite contra el spot"],
  IBB: ["^NBI", "Nasdaq Biotechnology", "índice de precio, sin dividendos"],
  GSG: ["^SPGSCI", "S&P GSCI"],
  CORN: ["ZC=F", "Maíz (futuro continuo)"],
  SOYB: ["ZS=F", "Soja (futuro continuo)"],
};

// ── Yahoo ────────────────────────────────────────────────────────────────
let YAUTH = null;
async function yahooAuth() {
  if (YAUTH) return YAUTH;
  const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA_WEB } });
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [];
  const cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const crumb = (await (await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA_WEB, Cookie: cookie },
  })).text()).trim();
  if (!crumb || crumb.startsWith("{") || crumb.length > 40) throw new Error("sin crumb de Yahoo");
  YAUTH = { cookie, crumb };
  return YAUTH;
}
const ysym = (t) => t.replace(/\./g, "-");
const raw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));

async function yahooSpark(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 20) {
    const ch = tickers.slice(i, i + 20);
    try {
      const d = await pedir(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${ch.map((t) => encodeURIComponent(ysym(t))).join(",")}&range=1d&interval=1d`);
      for (const x of d?.spark?.result || []) {
        const m = x?.response?.[0]?.meta;
        if (!m) continue;
        const t = ch.find((c) => ysym(c) === x.symbol) || x.symbol;
        out[t] = { px: m.regularMarketPrice, tipo: m.instrumentType, nombre: m.longName || m.shortName };
      }
    } catch (e) { log("spark", e.message); }
    await sleep(300);
  }
  return out;
}

async function yahooResumen(t, modulos) {
  const a = await yahooAuth();
  const d = await pedir(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ysym(t))}?modules=${modulos}&crumb=${encodeURIComponent(a.crumb)}`,
    { headers: { Cookie: a.cookie } });
  return d?.quoteSummary?.result?.[0] || null;
}

const SERIES = new Map();
async function yahooSerie(sym) {
  if (SERIES.has(sym)) return SERIES.get(sym);
  const d = await pedir(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6y&interval=1d&events=div`);
  const r = d?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const adj = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close || [];
  const pts = [];
  for (let i = 0; i < ts.length; i++) if (adj[i] != null && adj[i] > 0) pts.push([new Date(ts[i] * 1000).toISOString().slice(0, 10), adj[i]]);
  const divs = Object.values(r?.events?.dividends || {}).map((x) => ({ fecha: new Date(x.date * 1000).toISOString().slice(0, 10), monto: x.amount }))
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
  const out = { pts, divs, moneda: r?.meta?.currency };
  SERIES.set(sym, out);
  await sleep(250);
  return out;
}

// Serie en USD: índice en moneda local dividido por el tipo de cambio del día
// (o multiplicado, para EURUSD).
async function serieUsd(sym, fx, inv) {
  const s = await yahooSerie(sym);
  if (!fx) return s.pts;
  const f = (await yahooSerie(fx)).pts;
  const out = [];
  let j = 0;
  for (const [d, v] of s.pts) {
    while (j + 1 < f.length && f[j + 1][0] <= d) j++;
    if (!f[j] || f[j][0] > d) continue;
    out.push([d, inv ? v * f[j][1] : v / f[j][1]]);
  }
  return out;
}

function restarMeses(iso, m) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - m);
  return d.toISOString().slice(0, 10);
}
// Último punto con fecha <= iso.
function enFecha(pts, iso) {
  let lo = 0, hi = pts.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (pts[m][0] <= iso) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}
/* Rendimientos al último cierre común (hasta): 1m, 3m, 1a acumulados y 5a
 * anualizado. Se exige que la serie arranque antes de la fecha pedida: un
 * fondo con 3 años de historia no tiene "5 años". */
function rendimientos(pts, hasta) {
  const i = enFecha(pts, hasta);
  if (i < 0) return null;
  const fin = pts[i][1];
  const r = (m) => {
    const desde = restarMeses(pts[i][0], m);
    if (!pts.length || pts[0][0] > desde) return null;
    const j = enFecha(pts, desde);
    return j >= 0 ? fin / pts[j][1] - 1 : null;
  };
  const r5 = r(60);
  return { m1: r(1), m3: r(3), a1: r(12), a5: r5 == null ? null : Math.pow(1 + r5, 1 / 5) - 1 };
}
function volYCaida(pts) {
  const desde = restarMeses(pts[pts.length - 1][0], 12);
  const w = pts.filter((p) => p[0] >= desde).map((p) => p[1]);
  if (w.length < 150) return { vol: null, caida: null };
  const rs = [];
  for (let k = 1; k < w.length; k++) rs.push(Math.log(w[k] / w[k - 1]));
  const mu = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mu) ** 2, 0) / rs.length);
  let max = w[0], caida = 0;
  for (const v of w) { if (v > max) max = v; caida = Math.min(caida, v / max - 1); }
  return { vol: sd * Math.sqrt(252), caida };
}

// ── Comafi: planilla de emisión con ticker, CUSIP y ratio ───────────────────
async function comafi() {
  try {
    const buf = await pedir("https://www.comafi.com.ar/Multimedios/otros/7281.xlsx?v=2", { tipo: "buf" });
    const wb = XLSX.read(buf, { type: "buffer" });
    const out = {};
    for (const n of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false });
      const h = rows.findIndex((r) => r && String(r[0] || "").startsWith("Identificaci") && /cusip/i.test(String(r[1] || "")));
      if (h < 0) continue;
      for (const r of rows.slice(h + 1)) {
        const t = String(r?.[0] || "").trim().toUpperCase();
        const ratio = Number(String(r?.[2] || "").replace(",", "."));
        if (t && ratio > 0) out[t.replace("/", ".")] = { cusip: String(r[1] || "").trim().toUpperCase(), ratio };
      }
    }
    log(`Comafi: ${Object.keys(out).length} programas`);
    return out;
  } catch (e) { log("Comafi no disponible:", e.message); return {}; }
}

async function cedearsData912() {
  const d = await pedir("https://data912.com/live/arg_cedears");
  const por = {};
  for (const x of d || []) por[x.symbol] = x;
  // El mismo CEDEAR figura en pesos, MEP (sufijo D) y cable (C): me quedo con el de pesos.
  const base = Object.keys(por).filter((s) => !(s.length > 2 && /[DC]$/.test(s) && por[s.slice(0, -1)]));
  return { por, base };
}

// ── upsert en tandas ────────────────────────────────────────────────────
async function upsert(tabla, filas, onConflict, extra = {}) {
  if (DRY) { log(`[dry] ${tabla}: ${filas.length} filas`); return; }
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await supabase.from(tabla).upsert(filas.slice(i, i + 500), { onConflict, ...extra });
    if (error) throw new Error(`${tabla}: ${error.message}`);
  }
}
async function leerTodo(tabla, cols, filtro) {
  let out = [], desde = 0;
  for (;;) {
    let q = supabase.from(tabla).select(cols).order(cols.split(",")[0], { ascending: true }).range(desde, desde + 999);
    if (filtro) q = filtro(q);
    const { data, error } = await q;
    if (error) throw new Error(`${tabla}: ${error.message}`);
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
    desde += 1000;
  }
  return out;
}

// ══ --perfil ══════════════════════════════════════════════════════════════
async function modoPerfil() {
  const { por, base } = await cedearsData912();
  const sp = await yahooSpark([...base, ...Object.keys(ANCLAS)]);
  const ccls = Object.entries(ANCLAS)
    .map(([t, r]) => (por[t]?.c > 0 && sp[t]?.px > 0 ? (por[t].c * r) / sp[t].px : null))
    .filter((x) => x).sort((a, b) => a - b);
  if (ccls.length < 4) throw new Error(`CCL de referencia con ${ccls.length} anclas: no alcanza`);
  const ccl = ccls[Math.floor(ccls.length / 2)];
  let etfs = base.filter((s) => sp[s]?.tipo === "ETF");
  if (SOLO) etfs = etfs.filter((s) => SOLO.has(s));
  log(`CCL ref ${ccl.toFixed(1)} | ${base.length} CEDEARs base, ${etfs.length} ETF`);
  if (etfs.length < (SOLO ? 1 : 40)) throw new Error(`universo chico (${etfs.length}): no piso nada`);

  const cmf = await comafi();
  const mf = await pedir("https://www.sec.gov/files/company_tickers_mf.json", { headers: { "User-Agent": UA_SEC } });
  const sec = {};
  for (const [cik, series, , sym] of mf.data || []) if (!sec[sym]) sec[sym] = { cik: String(cik), series };

  const { data: previos } = await supabase.from("fondos_cedear").select("ticker,ratio,ratio_desde");
  const prev = new Map((previos || []).map((r) => [r.ticker, r]));

  const spy = await yahooSerie("SPY");
  const filasF = [], filasC = [];
  for (const t of etfs) {
    try {
      const r = await yahooResumen(t, "topHoldings,fundProfile,summaryDetail,fundPerformance");
      const serie = await yahooSerie(ysym(t));
      if (!serie.pts.length) throw new Error("sin serie");
      const hasta = serie.pts[serie.pts.length - 1][0];
      const comp = COMPARADORES[t];
      let retComp = null;
      if (comp) {
        try { retComp = rendimientos(await serieUsd(comp[0], comp[3], comp[4]), hasta); } catch (e) { log(`${t} comparador ${comp[0]}: ${e.message}`); }
      }
      const tr = r?.fundPerformance?.trailingReturns || {};
      const trc = r?.fundPerformance?.trailingReturnsCat || {};
      // Yahoo pone 0 donde no tiene el dato (categoría de EWZ, 5 años de IBIT
      // que salió en 2024): un 0,0000 exacto se toma como "sin dato".
      const y4 = (o) => {
        const v = (x) => { const n = raw(x); return n === 0 ? null : n; };
        return { m1: v(o.oneMonth), m3: v(o.threeMonth), a1: v(o.oneYear), a5: v(o.fiveYear) };
      };
      const { vol, caida } = volYCaida(serie.pts);
      const desde12 = restarMeses(HOY, 12);
      const divs = serie.divs.filter((d) => d.fecha > desde12);
      const sect = {};
      for (const s of r?.topHoldings?.sectorWeightings || []) for (const [k, v] of Object.entries(s)) if (raw(v) > 0) sect[k] = raw(v);
      const top10 = (r?.topHoldings?.holdings || []).map((h) => ({ ticker: h.symbol || null, nombre: h.holdingName || null, peso: raw(h.holdingPercent) }));
      const tl = TRUSTS[t]?.tipo || (UIT.has(t) ? "UIT" : "ETF");

      filasF.push({
        ticker: t, universo: "etf_cedear",
        nombre: sp[t]?.nombre || null,
        familia: r?.fundProfile?.family || null,
        categoria: r?.fundProfile?.categoryName || null,
        tipo_legal: tl,
        cik: sec[t]?.cik || null, series_id: sec[t]?.series || null,
        comparador: comp?.[0] || null, comparador_nombre: comp?.[1] || null, comparador_nota: comp?.[2] || null,
        expense_ratio: raw(r?.fundProfile?.feesExpensesInvestment?.annualReportExpenseRatio),
        aum_usd: raw(r?.summaryDetail?.totalAssets),
        yield: raw(r?.summaryDetail?.yield),
        precio_usd: sp[t]?.px ?? null,
        ret: {
          hasta,
          fondo: rendimientos(serie.pts, hasta),
          comp: retComp,
          spy: rendimientos(spy.pts, hasta),
          yahoo: y4(tr), yahoo_fecha: tr?.asOfDate?.fmt || null,
          cat: y4(trc),
        },
        vol_1a: vol, max_caida_1a: caida,
        dividendos: divs, div_12m_usd: divs.length ? divs.reduce((a, d) => a + d.monto, 0) : null,
        sectores: Object.keys(sect).length ? sect : null,
        top10: top10.length ? top10 : null,
        actualizado_at: new Date().toISOString(),
      });

      // Ratio
      const c = por[t]?.c, u = sp[t]?.px;
      if (c > 0 && u > 0) {
        const deriv = (u * ccl) / c;
        const p = prev.get(t);
        let ratio, fuente, dudoso = false;
        if (cmf[t]) { ratio = cmf[t].ratio; fuente = "comafi"; }
        else if (p?.ratio && Math.abs(deriv / p.ratio - 1) <= 0.02) { ratio = Number(p.ratio); fuente = "derivado"; }
        else if (p?.ratio) { ratio = Number(p.ratio); fuente = "derivado"; dudoso = true; log(`${t}: ratio derivado ${deriv.toFixed(2)} contra guardado ${p.ratio}: queda el guardado, dudoso`); }
        else { ratio = Math.max(1, Math.round(deriv)); fuente = "derivado"; }
        const desvio = deriv / ratio - 1;
        if (Math.abs(desvio) > 0.01 || (fuente === "derivado" && ratio > 150)) dudoso = true;
        filasC.push({
          ticker: t, ratio, ratio_fuente: fuente, ratio_derivado: deriv, ratio_desvio: desvio, ratio_dudoso: dudoso,
          ratio_desde: p && Number(p.ratio) === ratio ? p.ratio_desde : HOY,
          cusip: cmf[t]?.cusip || null, ccl_ref: ccl, cedear_ars: c, actualizado_at: new Date().toISOString(),
        });
      }
      log(`${t}: ok${retComp ? "" : comp ? " (sin comparador)" : ""}`);
    } catch (e) { log(`${t}: ERROR ${e.message}`); }
    await sleep(300);
  }
  await upsert("fondos", filasF, "ticker");
  await upsert("fondos_cedear", filasC, "ticker");
  log(`perfil: ${filasF.length} fondos, ${filasC.length} ratios (${filasC.filter((f) => f.ratio_dudoso).map((f) => f.ticker).join(", ") || "ninguno"} dudoso)`);
}

// ══ --holdings ════════════════════════════════════════════════════════════
const normClave = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().slice(0, 80);
const cusipValido = (c) => c && /^[0-9A-Z]{9}$/.test(c) && c !== "000000000" && c !== "N/A";

async function ssga(t) {
  const buf = await pedir(`https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${t.toLowerCase()}.xlsx`, { tipo: "buf" });
  const wb = XLSX.read(buf, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false });
  const asOf = rows.flat().map(String).find((s) => /^As of /i.test(s));
  const m = asOf && /As of (\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(asOf);
  const MES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  if (!m) throw new Error("SSGA sin fecha");
  const fecha = `${m[3]}-${String(MES[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const h = rows.findIndex((r) => r && r[0] === "Name" && r.includes("Weight"));
  if (h < 0) throw new Error("SSGA sin encabezado");
  const H = rows[h];
  const ix = (n) => H.indexOf(n);
  const out = [];
  for (const r of rows.slice(h + 1)) {
    const nombre = r[ix("Name")], peso = Number(r[ix("Weight")]);
    if (!nombre || !Number.isFinite(peso)) continue;
    const cusip = String(r[ix("Identifier")] || "").trim().toUpperCase();
    const tk = String(r[ix("Ticker")] || "").trim().toUpperCase();
    out.push({
      cusip: cusipValido(cusip) ? cusip : null, isin: null,
      ticker: tk && tk !== "-" && !/CASH|USD/.test(tk) ? tk.replace(/\s+/g, ".") : null,
      nombre, peso, pais: null, tipo: null,
    });
  }
  return { fecha, filas: out };
}

async function nportUltimo(series) {
  const atom = await pedir(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${series}&type=NPORT-P&dateb=&owner=include&count=5&output=atom`,
    { headers: { "User-Agent": UA_SEC }, tipo: "text" });
  const href = /<filing-href>([^<]+)<\/filing-href>/.exec(atom)?.[1];
  const acc = /<accession-number>([^<]+)<\/accession-number>/.exec(atom)?.[1];
  if (!href || !acc) return null;
  return { acc, dir: href.replace(/[^/]+$/, "") };
}
async function nportBajar(dir) {
  const x = await pedir(`${dir}primary_doc.xml`, { headers: { "User-Agent": UA_SEC }, tipo: "text" });
  const g = (b, t) => { const m = new RegExp(`<${t}>([^<]*)</${t}>`).exec(b); return m ? m[1].trim() : null; };
  const fecha = g(x, "repPdDate");
  const filas = [];
  const re = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
  let m;
  while ((m = re.exec(x))) {
    const b = m[1];
    const peso = Number(g(b, "pctVal"));
    if (!Number.isFinite(peso)) continue;
    // La garantía en efectivo de los préstamos de títulos (iShares la invierte
    // en BlackRock Cash Funds) figura como tenencia y hace sumar >100%: IBB
    // daba BISXX 11,7% como su "mayor posición". No es cartera del fondo.
    if (/isCashCollateral="Y"/.test(b)) continue;
    const cusip = (g(b, "cusip") || "").toUpperCase();
    const isin = /<isin value="([^"]+)"/.exec(b)?.[1] || null;
    const tk = /<ticker value="([^"]+)"/.exec(b)?.[1] || null;
    filas.push({
      cusip: cusipValido(cusip) ? cusip : null, isin, ticker: tk ? tk.toUpperCase() : null,
      nombre: g(b, "name") || g(b, "title"), peso, pais: g(b, "invCountry"), tipo: g(b, "assetCat"),
    });
  }
  return { fecha, filas, netAssets: Number(g(x, "netAssets")) || null };
}

// Agrega filas repetidas (mismo papel en varias líneas, típico de N-PORT con lotes).
function consolidar(filas) {
  const m = new Map();
  for (const f of filas) {
    const clave = f.cusip || f.isin || normClave(f.nombre);
    if (!clave) continue;
    const ya = m.get(clave);
    if (ya) { ya.peso += f.peso; ya.ticker = ya.ticker || f.ticker; }
    else m.set(clave, { ...f, clave, emisor6: f.cusip ? f.cusip.slice(0, 6) : null });
  }
  return [...m.values()].sort((a, b) => b.peso - a.peso);
}

let FIGI_ULTIMO = 0;
async function openfigi(ids) {
  // Sin clave: 25 pedidos por minuto, hasta 10 ids por pedido.
  const espera = FIGI_ULTIMO + 2600 - Date.now();
  if (espera > 0) await sleep(espera);
  FIGI_ULTIMO = Date.now();
  const body = ids.map((x) => (x.cusip ? { idType: "ID_CUSIP", idValue: x.cusip } : { idType: "ID_ISIN", idValue: x.isin }));
  const d = await pedir("https://api.openfigi.com/v3/mapping", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return d.map((r) => {
    const us = (r?.data || []).find((x) => x.exchCode === "US");
    return us ? us.ticker : null;
  });
}

async function modoHoldings() {
  let fondos = await leerTodo("fondos", "ticker,familia,series_id,tipo_legal,nport_accession,holdings_fecha,top10", (q) => q.eq("universo", "etf_cedear"));
  if (SOLO) fondos = fondos.filter((f) => SOLO.has(f.ticker));
  const maestro = await leerTodo("valores_maestro", "ticker,cusip");
  const porCusip = new Map(maestro.filter((v) => v.cusip).map((v) => [v.cusip, v.ticker]));
  log(`holdings: ${fondos.length} fondos, ${porCusip.size} CUSIP conocidos`);

  for (const f of fondos) {
    const t = f.ticker;
    try {
      const upd = { ticker: t };
      let res = null, fuente = null;

      if (TRUSTS[t]) {
        res = { fecha: HOY, filas: [{ cusip: null, isin: null, ticker: null, nombre: TRUSTS[t].nombre, peso: 100, pais: null, tipo: "commodity" }] };
        fuente = "trust";
      }
      if (!res && /state street|spdr/i.test(f.familia || "")) {
        try { res = await ssga(t); fuente = "ssga"; } catch (e) { log(`${t}: SSGA ${e.message}`); }
      }
      // El N-PORT se mira siempre que haya series: da los países aunque la
      // composición venga de SSGA. Solo se baja si el accession cambió.
      if (f.series_id) {
        const ult = await nportUltimo(f.series_id);
        if (ult && (ult.acc !== f.nport_accession || FORZAR)) {
          const np = await nportBajar(ult.dir);
          const paises = {};
          let tot = 0;
          for (const r of np.filas) if (r.peso > 0 && r.pais) { paises[r.pais] = (paises[r.pais] || 0) + r.peso; tot += r.peso; }
          for (const k of Object.keys(paises)) paises[k] = paises[k] / (tot || 1);
          Object.assign(upd, { nport_fecha: np.fecha, nport_accession: ult.acc, paises: tot ? paises : null });
          if (!res) { res = np; fuente = "nport"; }
          log(`${t}: N-PORT nuevo ${ult.acc} al ${np.fecha} (${np.filas.length} líneas)`);
        } else if (!res && ult) {
          log(`${t}: N-PORT sin cambios (${ult.acc})`);
          continue; // composición guardada vigente
        }
        await sleep(200);
      }
      if (!res) {
        upd.holdings_fuente = f.top10 ? "yahoo" : null;
        upd.holdings_fecha = null; upd.holdings_n = null;
        if (!DRY) await supabase.from("fondos").update(upd).eq("ticker", t);
        log(`${t}: sin composición completa (${f.top10 ? "solo top 10 de Yahoo" : "nada"})`);
        continue;
      }

      const filas = consolidar(res.filas);
      for (const r of filas) if (!r.ticker && r.cusip && porCusip.has(r.cusip)) r.ticker = porCusip.get(r.cusip);
      // Ticker para mostrar: OpenFIGI solo para los 40 primeros sin ticker.
      const faltan = filas.slice(0, 40).filter((r) => !r.ticker && (r.cusip || r.isin) && r.tipo !== "commodity");
      for (let i = 0; i < faltan.length; i += 10) {
        const lote = faltan.slice(i, i + 10);
        try {
          const tks = await openfigi(lote);
          lote.forEach((r, k) => { if (tks[k]) r.ticker = tks[k]; });
        } catch (e) { log(`${t}: OpenFIGI ${e.message}`); }
      }
      const nuevosMaestro = filas.filter((r) => r.ticker && r.cusip && !porCusip.has(r.cusip) && /^[A-Z.]{1,6}$/.test(r.ticker))
        .map((r) => ({ ticker: r.ticker, cusip: r.cusip, emisor6: r.emisor6, nombre: r.nombre, fuente: fuente === "ssga" ? "ssga" : "openfigi" }));
      for (const v of nuevosMaestro) porCusip.set(v.cusip, v.ticker);

      const fecha = res.fecha || HOY;
      const out = filas.map((r) => ({
        fondo: t, fecha, clave: r.clave, fuente, cusip: r.cusip, isin: r.isin, emisor6: r.emisor6,
        ticker: r.ticker, nombre: r.nombre, peso: r.peso, pais: r.pais, tipo: r.tipo,
      }));
      Object.assign(upd, { holdings_fuente: fuente, holdings_fecha: fecha, holdings_n: out.length });

      if (!DRY) {
        if (nuevosMaestro.length) await upsert("valores_maestro", dedupe(nuevosMaestro), "ticker", { ignoreDuplicates: true });
        await upsert("fondos_holdings", out, "fondo,fecha,clave");
        // Se guardan la fecha nueva y la anterior; lo demás se borra.
        const { data: fechas } = await supabase.from("fondos_holdings").select("fecha").eq("fondo", t).order("fecha", { ascending: false }).limit(1000);
        const distintas = [...new Set((fechas || []).map((x) => x.fecha))];
        if (distintas.length > 2) await supabase.from("fondos_holdings").delete().eq("fondo", t).lt("fecha", distintas[1]);
        const { error } = await supabase.from("fondos").update(upd).eq("ticker", t);
        if (error) throw new Error(error.message);
      }
      log(`${t}: ${fuente} al ${fecha}, ${out.length} papeles, top ${out.slice(0, 3).map((r) => `${r.ticker || r.nombre} ${r.peso.toFixed(1)}`).join(" / ")}`);
    } catch (e) { log(`${t}: ERROR ${e.message}`); }
  }
}
function dedupe(filas) {
  const m = new Map();
  for (const f of filas) if (!m.has(f.ticker)) m.set(f.ticker, f);
  return [...m.values()];
}

// ══ --maestro ═════════════════════════════════════════════════════════════
async function modoMaestro() {
  const { base } = await cedearsData912();
  const cmf = await comafi();
  const sp = await yahooSpark(base);
  let acciones = base.filter((s) => sp[s]?.tipo === "EQUITY");
  if (SOLO) acciones = acciones.filter((s) => SOLO.has(s));
  // CUSIP de State Street para el S&P 500 (cubre papeles nuevos que Comafi no tiene, como SNDK).
  const ssgaCusip = {};
  try { for (const r of (await ssga("SPY")).filas) if (r.ticker && r.cusip) ssgaCusip[r.ticker] = r.cusip; } catch (e) { log("SSGA SPY:", e.message); }

  const filas = [];
  for (const t of acciones) {
    const cusip = cmf[t]?.cusip || ssgaCusip[t] || null;
    let p = null;
    try { p = (await yahooResumen(t, "assetProfile"))?.assetProfile || null; } catch (e) { log(`${t}: assetProfile ${e.message}`); }
    filas.push({
      ticker: t, cusip: cusipValido(cusip) ? cusip : null, emisor6: cusipValido(cusip) ? cusip.slice(0, 6) : null,
      nombre: sp[t]?.nombre || null, sector: p?.sector || null, industria: p?.industry || null, pais: p?.country || null,
      fuente: cmf[t] ? "comafi" : ssgaCusip[t] ? "ssga" : "yahoo", actualizado_at: new Date().toISOString(),
    });
    await sleep(250);
  }
  await upsert("valores_maestro", filas, "ticker");
  log(`maestro: ${filas.length} papeles, ${filas.filter((f) => f.cusip).length} con CUSIP, ${filas.filter((f) => f.sector).length} con sector`);
}

(async () => {
  if (!MODO) { console.error("uso: node worker.js --perfil | --holdings | --maestro [--dry-run] [--solo SMH,SPY]"); process.exit(1); }
  const t0 = Date.now();
  try {
    if (MODO === "--perfil") await modoPerfil();
    if (MODO === "--holdings") await modoHoldings();
    if (MODO === "--maestro") await modoMaestro();
    log(`${MODO} listo en ${Math.round((Date.now() - t0) / 1000)} s${DRY ? " (dry-run)" : ""}`);
    process.exit(0);
  } catch (e) {
    log(`${MODO} FALLÓ: ${e.message}`);
    process.exit(1);
  }
})();
