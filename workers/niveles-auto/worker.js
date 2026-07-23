/**
 * Worker niveles-auto: análisis técnico automático de papeles → alertas BOT
 * en la pantalla "Alertas TV · Bot" de Midas.
 *
 * Dos disparadores:
 *  1. MANUAL (pre-compra): filas pending en tv_analysis_queue (las carga LP
 *     desde la pantalla ANTES de comprar → le dice a cuánto conviene entrar).
 *  2. PORTFOLIO (post-compra): posiciones cedear/stock NUEVAS (últimas 24h)
 *     de cualquier broker EXCEPTO 'iol' (el test de momentum no se toca),
 *     que no tengan ya un análisis en la cola.
 *
 * Para cada ticker: velas del subyacente USA vía Yahoo (diario 1y + 60m 1mes),
 * pivotes con confirmación (misma lógica que el Pine "Midas Niveles Auto"):
 *  - Soporte diario  → alerta dir=down "zona de COMPRA"
 *  - Resistencia diaria → alerta dir=up "venta / tomar ganancia"
 *  - Niveles horarios como afinación si están más cerca del precio.
 * Conversión a ARS: usd × CCL ÷ ratio, con ratio DERIVADO en vivo del feed
 * (data912: cedear ARS vs subyacente USD) — sin mapa hardcodeado.
 *
 * Idempotente: no duplica alertas AUTO no disparadas del mismo ticker+nivel;
 * al recalcular, borra las AUTO viejas no disparadas y crea las nuevas.
 * Schedule: PM2 cron cada 5 min, lun-vie 10:00-18:55 ART (ecosystem.config.js).
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const LB = 5; // barras de confirmación del pivote (igual que el Pine)

// Acciones argentinas → su ADR en NYSE (ratio = acciones locales por ADR).
// El nivel se calcula sobre el ADR (más líquido) y se traduce: local = adr_usd × CCL ÷ ratio.
const ARG_ADR = {
  YPFD: { adr: "YPF", r: 1 }, GGAL: { adr: "GGAL", r: 10 }, PAMP: { adr: "PAM", r: 25 },
  BMA: { adr: "BMA", r: 10 }, CEPU: { adr: "CEPU", r: 10 }, EDN: { adr: "EDN", r: 20 },
  LOMA: { adr: "LOMA", r: 5 }, SUPV: { adr: "SUPV", r: 5 }, TGSU2: { adr: "TGS", r: 5 },
  CRES: { adr: "CRESY", r: 10 }, IRSA: { adr: "IRS", r: 10 }, BBAR: { adr: "BBAR", r: 3 },
  TECO2: { adr: "TEO", r: 5 },
};

// Contexto fundamental del ticker (Yahoo quoteSummary, mismo baile cookie+crumb
// del worker fundamentals-snapshot): próxima fecha de earnings + target promedio
// de analistas + recomendación. Se guarda en ticker_context para la pantalla.
let _yAuth = null;
async function yahooAuth() {
  if (_yAuth) return _yAuth;
  const r = await fetch("https://fc.yahoo.com", { headers: UA });
  const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
  const cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, Cookie: cookie } });
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("sin crumb Yahoo");
  _yAuth = { cookie, crumb };
  return _yAuth;
}
const yraw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));
async function tickerContext(symUsa, tk) {
  try {
    const a = await yahooAuth();
    const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symUsa)}?modules=calendarEvents,financialData&crumb=${encodeURIComponent(a.crumb)}`;
    const r = await fetch(u, { headers: { ...UA, Cookie: a.cookie } });
    const j = await r.json();
    const res = j?.quoteSummary?.result?.[0];
    if (!res) return;
    const eDates = res.calendarEvents?.earnings?.earningsDate || [];
    const eRaw = yraw(eDates[0]);
    const earnings = eRaw ? new Date(eRaw * 1000).toISOString().slice(0, 10) : null;
    const target = yraw(res.financialData?.targetMeanPrice);
    const reco = res.financialData?.recommendationKey || null;
    await supabase.from("ticker_context").upsert({ ticker: tk, earnings_date: earnings, target_mean: target, recommendation: reco, updated_at: new Date().toISOString() }, { onConflict: "ticker" });
  } catch (e) { log(`[contexto ${tk}] ${e.message}`); }
}

async function yahooCandles(sym, interval, range) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`, { headers: UA });
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) return null;
  const q = res.indicators?.quote?.[0] || {};
  const out = [];
  for (let i = 0; i < (res.timestamp || []).length; i++) {
    if (q.high?.[i] != null && q.low?.[i] != null && q.close?.[i] != null) out.push({ h: q.high[i], l: q.low[i], c: q.close[i] });
  }
  return out.length ? out : null;
}

// Último pivote confirmado (máximo local con LB barras a cada lado).
function pivots(candles, lb = LB) {
  let res = null, sop = null;
  for (let i = lb; i < candles.length - lb; i++) {
    let isHi = true, isLo = true;
    for (let k = i - lb; k <= i + lb; k++) {
      if (candles[k].h > candles[i].h) isHi = false;
      if (candles[k].l < candles[i].l) isLo = false;
      if (!isHi && !isLo) break;
    }
    if (isHi) res = candles[i].h;
    if (isLo) sop = candles[i].l;
  }
  return { res, sop };
}

async function main(scanPortfolio = true) {
  // CCL + feeds para ratio en vivo
  const [dolRes, usaRes, cedRes] = await Promise.all([
    fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).then((r) => r.json()).catch(() => null),
    fetch("https://data912.com/live/usa_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/arg_cedears", { headers: UA }).then((r) => r.json()).catch(() => []),
  ]);
  const ccl = Number(dolRes?.venta) || Number(dolRes?.compra);
  if (!ccl) { log("sin CCL, abort"); return; }
  const usdPx = {}, arsPx = {};
  for (const it of usaRes || []) if (it?.symbol && Number(it.c) > 0) usdPx[it.symbol.toUpperCase()] = Number(it.c);
  for (const it of cedRes || []) if (it?.symbol && Number(it.c) > 0) arsPx[it.symbol.toUpperCase()] = Number(it.c);

  // 1. Cola manual pendiente — colapsando duplicados por usuario+ticker (si LP
  // encoló dos veces el mismo papel, se analiza UNA vez y se marcan todos).
  const { data: queue } = await supabase.from("tv_analysis_queue").select("*").eq("status", "pending").limit(20);
  const seen = new Set();
  const jobs = [];
  for (const q of queue || []) {
    const tk = q.ticker.toUpperCase().trim();
    const key = q.user_id + "|" + tk;
    if (seen.has(key)) {
      await supabase.from("tv_analysis_queue").update({ status: "done", processed_at: new Date().toISOString(), result: { dup: true } }).eq("id", q.id);
      continue;
    }
    seen.add(key);
    jobs.push({ ...q, ticker: tk });
  }

  // Escaneo automático de posiciones: DESACTIVADO a pedido de LP (23/07).
  // Un import de Cocos marcaría todo el portfolio como "nuevo" y dispararía
  // análisis masivos. El flujo es 100% manual: LP encola papel por papel desde
  // la pantalla (buscador / selector de cartera). scanPortfolio queda ignorado.
  void scanPortfolio;

  if (!jobs.length) return;

  for (const job of jobs) {
    const tk = job.ticker;
    try {
      // Resolver el símbolo a analizar: CEDEAR/acción USA directo; acción
      // argentina con ADR → el ADR; sin ADR → la especie local .BA (en ARS).
      const adrInfo = ARG_ADR[tk] || null;
      const symUsa = adrInfo ? adrInfo.adr : tk;
      let daily = await yahooCandles(symUsa, "1d", "1y");
      let hourly = daily ? await yahooCandles(symUsa, "60m", "1mo") : null;
      let modo = adrInfo ? "adr" : "usa";
      if (!daily) {
        daily = await yahooCandles(tk + ".BA", "1d", "1y");
        hourly = daily ? await yahooCandles(tk + ".BA", "60m", "1mo") : null;
        modo = "local_ars";
        if (!daily) throw new Error("sin velas Yahoo (ni USA, ni ADR, ni .BA)");
      }
      const d = pivots(daily, LB);
      const h = hourly ? pivots(hourly, LB) : { res: null, sop: null };
      // Nivel ESTRUCTURAL: pivote grande (confirmación 20) sobre el año entero —
      // los "850 de MU": la zona de batalla que el pivote corto no ve.
      const big = pivots(daily, 20);
      const spot = modo === "usa" ? (usdPx[tk] ?? daily[daily.length - 1].c) : daily[daily.length - 1].c;

      // Contexto fundamental (earnings + target analistas) en paralelo, no bloquea.
      tickerContext(symUsa, tk).catch(() => {});

      // Nivel de compra = soporte más CERCANO por debajo del precio (el horario
      // afina si está entre el diario y el precio). Venta = resistencia más
      // cercana por encima.
      const sops = [d.sop, h.sop].filter((x) => x != null && x < spot);
      const ress = [d.res, h.res].filter((x) => x != null && x > spot);
      const buyLvl = sops.length ? Math.max(...sops) : null;
      const sellLvl = ress.length ? Math.min(...ress) : null;

      // Conversión a ARS según el modo.
      let toArs, usdShown;
      if (modo === "usa") {
        const ratio = arsPx[tk] > 0 && usdPx[tk] > 0 ? Math.max(1, Math.round((usdPx[tk] * ccl) / arsPx[tk])) : null;
        if (!ratio) throw new Error("sin ratio (no está el CEDEAR en el feed)");
        toArs = (usd) => Math.round((usd * ccl) / ratio);
        usdShown = (x) => Math.round(x * 100) / 100;
      } else if (modo === "adr") {
        toArs = (usd) => Math.round((usd * ccl) / adrInfo.r);
        usdShown = (x) => Math.round(x * 100) / 100;
      } else {
        toArs = (ars) => Math.round(ars); // niveles ya en pesos (.BA)
        usdShown = () => null;
      }

      // Limpiar alertas AUTO previas NO disparadas de este ticker/usuario
      // (LIKE 'AUTO%' cubre el formato viejo "AUTO análisis:" y el nuevo "AUTO ·")
      await supabase.from("price_alerts").delete().eq("user_id", job.user_id).eq("ticker", tk).eq("origen", "tv").is("triggered_at", null).like("nota", "AUTO%");

      const unit = modo === "local_ars" ? "$" : "US$";
      const mk = (lvl, dir, nota) => ({
        user_id: job.user_id, ticker: tk, price: toArs(lvl),
        dir, nota, usd_ref: usdShown(lvl), canal: "screen", origen: "tv",
      });
      const fmt = (x) => x.toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const rows = [];
      if (buyLvl) rows.push(mk(buyLvl, "down", `AUTO · soporte ${unit}${fmt(buyLvl)} · pivote ${buyLvl === d.sop ? "diario" : "horario"}${modo === "adr" ? " · ADR " + adrInfo.adr : ""}`));
      if (sellLvl) rows.push(mk(sellLvl, "up", `AUTO · resistencia ${unit}${fmt(sellLvl)} · pivote ${sellLvl === d.res ? "diario" : "horario"}${modo === "adr" ? " · ADR " + adrInfo.adr : ""}`));
      // Estructurales: solo si están al menos 3% más allá del nivel corto (si no, duplican).
      if (big.sop != null && big.sop < spot && (!buyLvl || big.sop < buyLvl * 0.97)) {
        rows.push(mk(big.sop, "down", `AUTO · soporte ESTRUCTURAL ${unit}${fmt(big.sop)} · pivote mayor del año`));
      }
      // Sin NINGÚN soporte debajo (papel haciendo mínimos nuevos): fallback al
      // mínimo de 52 semanas como referencia de piso — y si el precio YA está
      // ahí, no hay red: eso también es información.
      if (!buyLvl && (big.sop == null || big.sop >= spot)) {
        const yrLow = Math.min(...daily.map((c) => c.l));
        if (yrLow < spot * 0.995) {
          rows.push(mk(yrLow, "down", `AUTO · piso del año ${unit}${fmt(yrLow)} · mínimo 52 semanas (sin soporte de pivote debajo: mínimos nuevos)`));
        }
      }
      if (big.res != null && big.res > spot && (!sellLvl || big.res > sellLvl * 1.03)) {
        rows.push(mk(big.res, "up", `AUTO · resistencia ESTRUCTURAL ${unit}${fmt(big.res)} · pivote mayor del año`));
      }
      if (rows.length) { const { error } = await supabase.from("price_alerts").insert(rows); if (error) throw new Error(error.message); }

      await supabase.from("tv_analysis_queue").update({
        status: "done", processed_at: new Date().toISOString(),
        result: { modo, spot, buy: buyLvl, sell: sellLvl, daily: d, hourly: h, ccl },
      }).eq("id", job.id);
      log(`${tk} [${modo}]: compra ${buyLvl ? buyLvl.toFixed(2) : "-"} / venta ${sellLvl ? sellLvl.toFixed(2) : "-"}`);
    } catch (e) {
      await supabase.from("tv_analysis_queue").update({ status: "error", processed_at: new Date().toISOString(), result: { error: e.message } }).eq("id", job.id);
      log(`${tk} ERROR: ${e.message}`);
    }
  }
}

// Loop persistente: la COLA manual se procesa SIEMPRE (cada 60s, 24/7 — LP
// puede pedir un análisis un domingo a la noche y lo tiene en un minuto).
// El escaneo de posiciones nuevas corre solo en horario ampliado de mercado.
function inMarketWindow() {
  const ar = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const dow = ar.getDay(), hr = ar.getHours();
  return dow >= 1 && dow <= 5 && hr >= 10 && hr < 19;
}

async function loop() {
  log("niveles-auto persistente arrancando (cola cada 60s; portfolio solo en mercado)");
  let lastPortfolioScan = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const scanPortfolio = inMarketWindow() && Date.now() - lastPortfolioScan > 5 * 60 * 1000;
      await main(scanPortfolio);
      if (scanPortfolio) lastPortfolioScan = Date.now();
    } catch (e) { console.error("[loop]", e.message); }
    await new Promise((r) => setTimeout(r, 60 * 1000));
  }
}

loop();
