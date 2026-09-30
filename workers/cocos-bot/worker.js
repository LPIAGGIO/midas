/**
 * Worker cocos-bot: el bot de niveles operando en la cuenta de COCOS (72404)
 * por la API oficial de Primary (xOMS, el backend de Matriz). Arranca el
 * 30/09/2026 por pedido de LP ("mañana arrancamos con el bot en matriz cocos").
 *
 * QUE OPERA: las MISMAS señales filtradas que el libro real de IOL (score >= 7,
 * R:R >= 2, a favor de tendencia, régimen risk_on o mixto con score 8 y R:R
 * 2,5 a mitad de tamaño, sin balance en 3 días). No genera señales propias:
 * las lee del libro SOMBRA de niveles-auto (paper_iol_trades, modo='shadow'),
 * que graba TODA señal con score, R:R, régimen y contra-tendencia, sin límite
 * de capital. Así este bot no toca el worker que maneja la plata de IOL.
 *
 * RAILS (LP 29/09): $2.000.000 por papel, $20.000.000 abiertos como máximo,
 * swing permitido (queda de un día para otro), máximo 6 entradas por día,
 * una posición por papel, freno de pérdida diaria. Stop a 1,5×ATR(14) que
 * solo sube; venta de la mitad a mitad de camino al target; target en la
 * resistencia o tapado a +X% (COCOS_BOT_TARGET_PCT, lo fija el backtest).
 *
 * EJECUCION: todo por estado de la orden en Primary. Una compra existe solo
 * cuando Primary dice FILLED; nunca por cruce de precio. Antes de cualquier
 * VENTA se consultan las órdenes activas del papel: si ya hay una, se adopta
 * en vez de mandar otra (evita quedar vendido dos veces tras un reinicio).
 *
 * LLAVES: COCOS_BOT_REAL=1 en .env (sin eso no manda órdenes) y
 * linked_brokers.bot_enabled del broker 'cocos' (false = no abre posiciones
 * nuevas; los stops de lo abierto se siguen manejando). Apagar del todo:
 * pm2 stop cocos-bot.
 *
 * PRUEBA DE PLOMERIA (COCOS_BOT_PROBAR=1): el primer minuto de rueda manda
 * 1 CEDEAR líquido a compra 20% debajo del mercado, verifica que Primary la
 * acepte, la cancela y verifica la cancelación. Si algo falla, el bot no
 * opera ese día y avisa por Telegram.
 *
 * Costo Cocos: sin comisión; derechos BYMA 0,050% + IVA por punta (0,044% si
 * compra y venta son el mismo día). Los stops cruzan el book (pagan spread).
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

/* ───────── configuración ───────── */
const ENV = leerEnv();
const BASE = "https://api.cocos.xoms.com.ar";
const CUENTA = ENV.COCOS_CUENTA || "72404";
const USER_ID = ENV.COCOS_BOT_USER || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
/* LIBRO: 'cocos' = el bot real. 'cocos_sombra' = la misma maquinaria SIN
 * filtro de señales (toma todo soporte con stop y target válidos, como el
 * sombra de IOL) y SIN órdenes reales: REAL queda en false por código, no
 * por configuración, así una instancia sombra nunca puede operar. Sirve para
 * comparar al fin del día filtro contra sin filtro con las reglas de Cocos. */
const LIBRO = ENV.COCOS_BOT_LIBRO === "cocos_sombra" ? "cocos_sombra" : "cocos";
const SOMBRA = LIBRO === "cocos_sombra";
const REAL = !SOMBRA && ENV.COCOS_BOT_REAL === "1";
const PROBAR = !SOMBRA && ENV.COCOS_BOT_PROBAR !== "0";
const TG_ON = !SOMBRA && ENV.COCOS_BOT_TG !== "0";
const CAP = Number(ENV.COCOS_BOT_CAP || 20_000_000);
const MAX_POS_ARS = Number(ENV.COCOS_BOT_MAX_POS_ARS || 2_000_000);
// Tope de entradas: por HORA (ventana movil de 60 min), pedido de LP
// 30/09/2026 ("6 por dia no es necesario, maximo 6 por hora"). El tope por
// dia queda opcional (0 = sin tope); el freno real es el capital (20M / 2M).
const MAX_HORA = Number(ENV.COCOS_BOT_MAX_HORA || 6);
const MAX_DIA = Number(ENV.COCOS_BOT_MAX_DIA || 0);
const STOP_ATR = Number(ENV.COCOS_BOT_STOP_ATR ?? 1.5);
const TARGET_PCT = Number(ENV.COCOS_BOT_TARGET_PCT || 0);        // 0 = resistencia
const TP_PARCIAL = Number(ENV.COCOS_BOT_TP_PARCIAL ?? 0.5);       // 0 apaga
// Trailing del stop por ATR (sube con el precio). El backtest cocos2 (29/09)
// mostro que el trailing saca el 33-38% de los trades en -2/-4% antes de la
// resistencia y que apagarlo mejora todas las variantes en IS y OOS; es un
// hallazgo post-hoc, asi que queda como parametro y lo decide LP.
const TRAILING = ENV.COCOS_BOT_TRAILING !== "0";
// Puntaje minimo del filtro. 7 = el del bot de IOL. LP pidio probar 6 el
// 30/09/2026; backtest cocos3-score: con 6 se duplican las operaciones y el
// resultado fuera de muestra queda en cero (ni mejor ni peor que 7, nada
// significativo), con mas drawdown. El resto del filtro no cambia.
const MIN_SCORE = Number(ENV.COCOS_BOT_MIN_SCORE || 7);
const PERDIDA_DIA = Number(ENV.COCOS_BOT_PERDIDA_DIA_ARS || 600_000); // 3% de 20M
const CONFIRM_ENTRADA_MS = 150_000;
const CONFIRM_SALIDA_MS = Number(ENV.COCOS_BOT_SALIDA_CONFIRM_MS || 10 * 60_000);
const DERIVA_MAX = 0.006;            // recolocar la compra si el CCL corrió el límite
const RECOLOC_COOLDOWN_MS = 30 * 60_000;
const IVA = 1.21;
const FEE_SWING = 0.0005 * IVA;      // 0,0605% por punta
const FEE_INTRADIA = 0.00044 * IVA;  // 0,053% por punta
const UNIVERSO = new Set(String(ENV.COCOS_BOT_TICKERS || ENV.IOL_BOT_TICKERS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
// Acciones argentinas con ADR: el local no es un CEDEAR del mismo papel y el
// ratio pasa por el CCL. Fuera de este bot (v1).
const ARG_LOCAL = new Set(["GGAL", "YPFD", "PAMP", "BMA", "CEPU", "EDN", "TGSU2", "LOMA", "BBAR", "SUPV", "CRESY", "IRSA", "TECO2", "VIST", "TXAR", "ALUA", "COME", "TGNO4", "MIRG", "BYMA"]);
const UA = { "User-Agent": "Mozilla/5.0" };
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const diaAr = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const hhmmAr = () => { const s = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }); return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5)); };
const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5; };

function leerEnv() {
  // El .env se lee del directorio de TRABAJO, no del archivo: la instancia
  // sombra corre en ~/workers/cocos-sombra con worker.js enlazado al del bot,
  // y con __dirname habria leido el .env del bot REAL (REAL=1).
  const ruta = fs.existsSync(path.join(process.cwd(), ".env")) ? path.join(process.cwd(), ".env") : path.join(__dirname, ".env");
  const txt = fs.readFileSync(ruta, "utf8");
  const o = {};
  for (const l of txt.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
  const b64 = (k) => (o[k] ? Buffer.from(o[k], "base64").toString("utf8") : null);
  o.user = b64("COCOS_API_USER_B64"); o.pass = b64("COCOS_API_PASS_B64");
  return o;
}
if (!ENV.user || !ENV.pass) { console.error("faltan credenciales de Cocos"); process.exit(1); }
if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) { console.error("falta Supabase"); process.exit(1); }
const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });

/* ───────── Primary REST ───────── */
let _tok = null, _tokAt = 0;
async function token(forzar = false) {
  if (_tok && !forzar && Date.now() - _tokAt < 20 * 60_000) return _tok;
  const r = await fetch(`${BASE}/auth/getToken`, { method: "POST", headers: { "X-Username": ENV.user, "X-Password": ENV.pass }, redirect: "manual" });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) throw new Error(`login Primary rechazado (HTTP ${r.status})`);
  _tok = t; _tokAt = Date.now();
  return t;
}
async function api(metodo, ruta, reintento = true) {
  const t = await token();
  const r = await fetch(`${BASE}${ruta}`, { method: metodo, headers: { "X-Auth-Token": t }, redirect: "manual" });
  if ((r.status === 401 || r.status === 302) && reintento) { await token(true); return api(metodo, ruta, false); }
  if (r.status === 429 && reintento) { await new Promise((ok) => setTimeout(ok, 3000)); return api(metodo, ruta, false); }
  // La documentación de Primary usa GET para enviar y cancelar órdenes; si
  // este servidor pide POST, se reintenta con el otro método una vez.
  if ((r.status === 405 || r.status === 404) && reintento && /\/rest\/order\/(newSingleOrder|cancelById)/.test(ruta)) return api(metodo === "GET" ? "POST" : "GET", ruta, false);
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* no json */ }
  if (r.status !== 200) throw new Error(`${ruta.split("?")[0]}: HTTP ${r.status} ${txt.slice(0, 160)}`);
  if (j?.status && j.status !== "OK") throw new Error(`${ruta.split("?")[0]}: ${j.status} ${j.message || j.description || ""}`.trim());
  return j;
}
const simbolo = (tk) => `MERV - XMEV - ${tk.toUpperCase()} - 24hs`;
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

const _tick = new Map();
async function tickDe(tk) {
  const hit = _tick.get(tk);
  if (hit != null) return hit;
  const j = await api("GET", `/rest/instruments/detail?${q({ marketId: "ROFX", symbol: simbolo(tk) })}`);
  const t = Number(j?.instrument?.minPriceIncrement) || 1;
  _tick.set(tk, t);
  return t;
}
const alTick = (px, tick, modo) => { const n = px / tick; const k = modo === "arriba" ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9); return Math.round(k * tick * 1000) / 1000; };

/* LIBRO LOCAL. Primary limita /rest/marketdata/get POR USUARIO (HTTP 429 el
 * 30/09/2026, con el bot real y la sombra compartiendo el cupo). Por eso:
 *  - por defecto el libro sale de data912 (una consulta trae bid/ask/último de
 *    TODOS los CEDEARs, cache 20 s): alcanza para dimensionar, calcular el
 *    ratio y ver si el dólar corrió el límite;
 *  - Primary (preciso=true) solo para poner el precio de una VENTA del bot
 *    real y para la prueba de plomería, con cache de 8 s;
 *  - la sombra NUNCA le pide precios a Primary: no le gasta cupo al real. */
// Una consulta por feed cada 50 s; tras una falla se espera 60 s antes de
// reintentar (sin esto, cada orden viva reintentaba en la misma pasada y se
// mandaban rafagas justo cuando el proveedor rechazaba).
async function bajarFeed(nombre, url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
let _loc = { t: 0, m: {}, prox: 0 };
async function libroLocal(tk) {
  if (Date.now() >= _loc.prox) {
    try {
      const arr = await bajarFeed("arg_cedears", "https://data912.com/live/arg_cedears");
      const m = {};
      for (const it of arr || []) { const sy = String(it?.symbol || "").toUpperCase(); if (sy) m[sy] = { bid: Number(it.px_bid) || null, ask: Number(it.px_ask) || null, last: Number(it.c) || null }; }
      if (Object.keys(m).length > 50) { _loc.m = m; _loc.t = Date.now(); }
      _loc.prox = Date.now() + 50_000;
    } catch (e) { _loc.prox = Date.now() + 60_000; log(`arg_cedears: ${e.message} (uso el último dato, de hace ${Math.round((Date.now() - _loc.t) / 1000)} s)`); }
  }
  return _loc.m[tk.toUpperCase()] || null;
}
const _libP = new Map();
async function libroPrimary(tk) {
  const hit = _libP.get(tk);
  if (hit && Date.now() - hit.t < 8000) return hit.v;
  const j = await api("GET", `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: simbolo(tk), entries: "BI,OF,LA", depth: 1 })}`);
  const md = j?.marketData || {};
  const v = { bid: Number(md.BI?.[0]?.price) || null, ask: Number(md.OF?.[0]?.price) || null, last: Number(md.LA?.price) || null };
  _libP.set(tk, { v, t: Date.now() });
  return v;
}
/* WEBSOCKET DE PRIMARY (30/09/2026). Se suscribe a todos los CEDEARs del
 * universo (mas cualquier papel con orden o posicion viva) y mantiene el
 * libro en memoria. Si se corta, reconecta solo con token nuevo. Un libro
 * del websocket vale mientras la conexion recibio ALGO en los ultimos 2 min
 * (los papeles poco operados pueden no cambiar en minutos; la conexion
 * entera sin mensajes es lo que indica que algo esta caido). */
const WebSocket = require("ws");
const wsLibro = new Map();
let wsConn = null, wsUltimoMsg = 0, wsReintento = 0, wsSuscriptos = new Set();
function wsSimbolos() {
  const tks = [...UNIVERSO].filter((tk) => !ARG_LOCAL.has(tk));
  for (const tk of wsSuscriptos) if (!tks.includes(tk)) tks.push(tk);
  return tks;
}
async function wsConectar() {
  try {
    const t = await token();
    const ws = new WebSocket(BASE.replace("https://", "wss://") + "/", { headers: { "X-Auth-Token": t } });
    wsConn = ws;
    ws.on("open", () => {
      wsReintento = 0;
      const products = wsSimbolos().map((tk) => ({ symbol: simbolo(tk), marketId: "ROFX" }));
      ws.send(JSON.stringify({ type: "smd", level: 1, entries: ["BI", "OF", "LA"], products, depth: 1 }));
      log(`[ws] Primary conectado · ${products.length} CEDEARs suscriptos`);
    });
    ws.on("message", (d) => {
      wsUltimoMsg = Date.now();
      let j; try { j = JSON.parse(d.toString()); } catch { return; }
      if (j.type !== "Md") return;
      const tk = String(j.instrumentId?.symbol || "").split(" - ")[2];
      if (!tk) return;
      const md = j.marketData || {};
      const prev = wsLibro.get(tk) || {};
      wsLibro.set(tk, {
        bid: Number(md.BI?.[0]?.price) || prev.bid || null,
        ask: Number(md.OF?.[0]?.price) || prev.ask || null,
        last: Number(md.LA?.price) || prev.last || null,
        t: Date.now(),
      });
    });
    const caida = (m) => { if (wsConn !== ws) return; wsConn = null; const esp = Math.min(60_000, 5_000 * (1 + wsReintento++)); log(`[ws] Primary desconectado (${m}); reconecto en ${esp / 1000} s`); setTimeout(wsConectar, esp); };
    ws.on("close", (c) => caida(`close ${c}`));
    ws.on("error", (e) => caida(e.message));
  } catch (e) {
    const esp = Math.min(60_000, 5_000 * (1 + wsReintento++));
    log(`[ws] no pude conectar (${e.message}); reintento en ${esp / 1000} s`);
    setTimeout(wsConectar, esp);
  }
}
function wsSuscribirExtra(tk) {
  if (wsSuscriptos.has(tk) || UNIVERSO.has(tk)) return;
  wsSuscriptos.add(tk);
  if (wsConn && wsConn.readyState === 1) {
    const products = wsSimbolos().map((x) => ({ symbol: simbolo(x), marketId: "ROFX" }));
    wsConn.send(JSON.stringify({ type: "smd", level: 1, entries: ["BI", "OF", "LA"], products, depth: 1 }));
  }
}
const wsVivo = () => wsConn && wsConn.readyState === 1 && Date.now() - wsUltimoMsg < 120_000;

async function libro(tk, preciso = false) {
  const vacio = { bid: null, ask: null, last: null };
  // 1) websocket de Primary: tiempo real, sin cupo
  const w = wsLibro.get(tk.toUpperCase());
  if (wsVivo() && w && (w.bid > 0 || w.last > 0)) return { bid: w.bid, ask: w.ask, last: w.last };
  // 2) respaldos: como antes
  if (SOMBRA) return (await libroLocal(tk)) || vacio;
  if (preciso) { try { return await libroPrimary(tk); } catch (e) { log(`[cocos ${tk}] libro Primary: ${e.message} — uso data912`); return (await libroLocal(tk)) || vacio; } }
  const loc = await libroLocal(tk);
  if (loc && (loc.last > 0 || loc.bid > 0)) return loc;
  return libroPrimary(tk);
}
async function ordenNueva(tk, lado, qty, px) {
  const j = await api("GET", `/rest/order/newSingleOrder?${q({ marketId: "ROFX", symbol: simbolo(tk), price: px, orderQty: qty, ordType: "LIMIT", side: lado, timeInForce: "DAY", account: CUENTA, cancelPrevious: false, iceberg: false })}`);
  const o = j?.order || {};
  if (!o.clientId) throw new Error(`Primary no devolvió clientId (${JSON.stringify(j).slice(0, 200)})`);
  return `${o.clientId}|${o.proprietary || ""}`;
}
async function ordenEstado(id) {
  const [clOrdId, proprietary] = String(id).split("|");
  const j = await api("GET", `/rest/order/id?${q({ clOrdId, proprietary })}`);
  return j?.order || null;
}
async function ordenCancelar(id) {
  const [clOrdId, proprietary] = String(id).split("|");
  await api("GET", `/rest/order/cancelById?${q({ clOrdId, proprietary })}`);
}
async function ordenesActivas() {
  try { const j = await api("GET", `/rest/order/actives?${q({ accountId: CUENTA })}`); return j?.orders || []; }
  catch { const j = await api("GET", `/rest/order/all?${q({ accountId: CUENTA })}`); return (j?.orders || []).filter((o) => /NEW|PARTIALLY_FILLED|PENDING/i.test(o.status || "")); }
}
async function disponible24() {
  const j = await api("GET", `/rest/risk/accountReport/${CUENTA}`);
  const d = j?.accountData?.detailedAccountReports?.["1"];
  return Number(d?.availableToOperate?.total) || 0;
}
const FINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "EXPIRED"]);

/* ───────── datos de mercado externos ───────── */
let _usd = { t: 0, m: {}, prox: 0 };
async function usdPrecios() {
  if (Date.now() < _usd.prox) return _usd.m;
  try {
    const arr = await bajarFeed("usa_stocks", "https://data912.com/live/usa_stocks");
    const m = {};
    for (const it of arr || []) { const s = String(it?.symbol || "").toUpperCase(); if (s && Number(it.c) > 0) m[s] = Number(it.c); }
    if (Object.keys(m).length > 100) { _usd.m = m; _usd.t = Date.now(); }
    _usd.prox = Date.now() + 50_000;
  } catch (e) { _usd.prox = Date.now() + 60_000; log(`usa_stocks: ${e.message} (uso el último dato, de hace ${Math.round((Date.now() - _usd.t) / 1000)} s)`); }
  return _usd.m;
}
// RESPALDO: si el feed en dólares lleva más de 150 s sin actualizarse, los
// papeles con orden o posición viva se consultan de a uno en Yahoo. Así un
// stop no queda vigilado con un precio viejo si data912 se cae un rato.
const _yh = new Map();
async function usdConRespaldo(vivas) {
  const usd = await usdPrecios();
  if (Date.now() - _usd.t <= 150_000) return usd;
  const copia = { ...usd };
  for (const sym of new Set(vivas.map((v) => String(v.sym).toUpperCase()))) {
    const hit = _yh.get(sym);
    if (hit && Date.now() - hit.t < 40_000) { copia[sym] = hit.v; continue; }
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`, { headers: UA, signal: AbortSignal.timeout(8000) });
      const v = (await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (v > 0) { _yh.set(sym, { v, t: Date.now() }); copia[sym] = v; }
    } catch { /* sigue con el dato viejo */ }
  }
  if (avisoRespaldo !== Math.floor(Date.now() / 600_000)) { avisoRespaldo = Math.floor(Date.now() / 600_000); log(`feed en dólares viejo (${Math.round((Date.now() - _usd.t) / 1000)} s): precios de Yahoo para ${[..._yh.keys()].join(", ") || "nadie"}`); }
  return copia;
}
let avisoRespaldo = null;
const _atr = new Map();
async function atr14(sym) {
  const c = _atr.get(sym);
  if (c && Date.now() - c.t < 3600_000) return c.atr;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2mo`, { headers: UA });
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const qq = res?.indicators?.quote?.[0] || {};
    const hoy = new Date().toISOString().slice(0, 10);
    let b = (res?.timestamp || []).map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), h: qq.high?.[i], l: qq.low?.[i], c: qq.close?.[i] })).filter((x) => x.h != null && x.l != null && x.c != null);
    if (b.length && b[b.length - 1].d === hoy) b = b.slice(0, -1);
    const tr = [];
    for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
    const u = tr.slice(-14);
    if (!u.length) return c?.atr ?? null;
    const atr = u.reduce((a, v) => a + v, 0) / u.length;
    _atr.set(sym, { atr, t: Date.now() });
    return atr;
  } catch { return c?.atr ?? null; }
}
const _earn = new Map();
async function earningsCerca(tk) {
  const hit = _earn.get(tk);
  if (hit && Date.now() - hit.t < 6 * 3600_000) return hit.v;
  let v = false;
  const { data, error } = await supabase.from("ticker_context").select("earnings_date").eq("ticker", tk).maybeSingle();
  if (error) v = true;
  else if (data && !data.earnings_date) v = true;
  else if (data?.earnings_date) { const dias = (new Date(data.earnings_date + "T12:00:00") - Date.now()) / 86400000; v = dias >= -1 && dias <= 3; }
  _earn.set(tk, { v, t: Date.now() });
  return v;
}

/* ───────── Telegram ───────── */
let _chat = null;
async function tg(texto) {
  if (!TG_ON || !ENV.TELEGRAM_BOT_TOKEN) return;
  try {
    if (!_chat) { const { data } = await supabase.from("telegram_links").select("chat_id").eq("user_id", USER_ID).eq("enabled", true).maybeSingle(); _chat = data?.chat_id || null; }
    if (!_chat) return;
    await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: _chat, text: texto, parse_mode: "HTML" }) });
  } catch (e) { log(`telegram: ${e.message}`); }
}

/* ───────── estado ───────── */
const vistas = new Set();          // ids de filas shadow ya evaluadas
const reintentos = new Map();      // id de señal → intentos fallidos por error transitorio
const cand = new Map();            // "tp_id"/"exit_id" → ts de la primera lectura
const pAnterior = new Map();       // trade id → último precio USD leído
const salidas = new Map();         // trade id → { id, kind, qty, pxArs, placedAt }
const recolocada = new Map();      // trade id → ts
let plomeriaOk = !PROBAR, plomeriaDia = null, plomeriaIntento = 0, avisoPerdida = null, avisoApagado = null;
let arranque = new Date().toISOString();
if (SOMBRA) { const d = new Date(); d.setUTCHours(13, 30, 0, 0); if (d.getTime() < Date.now()) arranque = d.toISOString(); }

async function botHabilitado() {
  const { data } = await supabase.from("linked_brokers").select("bot_enabled").eq("user_id", USER_ID).eq("broker", "cocos").maybeSingle();
  return data?.bot_enabled === true;
}

/* ───────── prueba de plomería ───────── */
async function probarPlomeria() {
  const hoy = diaAr(new Date());
  if (plomeriaDia === hoy) return plomeriaOk;
  // Primary puede tardar en levantar a la mañana (mantenimiento nocturno):
  // si la prueba falla se reintenta cada 10 min hasta las 11:30 antes de dar
  // el día por perdido.
  plomeriaIntento++;
  const ultimo = hhmmAr() >= 1130 || plomeriaIntento >= 7;
  if (ultimo) plomeriaDia = hoy;
  const tk = "AAPL";
  try {
    const lb = await libro(tk, true);
    const ref = lb.bid || lb.last;
    if (!(ref > 0)) throw new Error("sin libro para la prueba");
    const tick = await tickDe(tk);
    const px = alTick(ref * 0.8, tick, "abajo");
    if (!REAL) { log(`[prueba] (sin COCOS_BOT_REAL) habría mandado 1 × ${tk} a ${pesos(px)}`); plomeriaOk = true; return true; }
    const id = await ordenNueva(tk, "BUY", 1, px);
    await new Promise((r) => setTimeout(r, 3000));
    const o1 = await ordenEstado(id);
    if (!o1 || !/NEW|PENDING/i.test(o1.status || "")) throw new Error(`estado tras colocar: ${o1?.status} ${o1?.text || ""}`);
    await ordenCancelar(id);
    await new Promise((r) => setTimeout(r, 3000));
    const o2 = await ordenEstado(id);
    if (!o2 || o2.status !== "CANCELLED") throw new Error(`no confirmó la cancelación: ${o2?.status} ${o2?.text || ""}`);
    plomeriaOk = true;
    plomeriaDia = hoy;
    log(`[prueba] OK: 1 × ${tk} a ${pesos(px)} aceptada (${o1.status}) y cancelada (${o2.status})`);
    await tg(`<b>COCOS BOT · prueba OK</b>\nPrimary aceptó y canceló una orden de 1 × ${tk} a ${pesos(px)}. El bot opera hoy.`);
  } catch (e) {
    plomeriaOk = false;
    log(`[prueba] FALLO (intento ${plomeriaIntento}): ${e.message}`);
    if (ultimo) await tg(`<b>COCOS BOT · prueba FALLÓ</b>\n${e.message}\nHoy NO abre posiciones nuevas. Revisar en Matriz si quedó alguna orden de 1 × AAPL colgada.`);
    else { await tg(`<b>COCOS BOT · prueba falló, reintento en 10 min</b>\n${e.message}`); await new Promise((r) => setTimeout(r, 9 * 60_000)); }
  }
  return plomeriaOk;
}

/* ───────── señales ───────── */
function parseSenal(s) {
  const t = String(s || "");
  const rgm = (/rgm (\w+)/.exec(t) || [])[1] || null;
  return { rgm, contra: /CONTRA-TENDENCIA/.test(t) };
}
async function buscarSenales() {
  // Fuentes: el libro SOMBRA (toda señal, con score/R:R/régimen para
  // filtrar acá) y los libros REAL y PAPER de IOL (ya filtrados por
  // niveles-auto). El sombra no repite una señal mientras tiene posición en
  // ese papel; los otros dos cubren ese hueco. Dedup por papel y nivel.
  const { data: rows } = await supabase.from("paper_iol_trades")
    .select("id,ticker,sym,senal,score,rr,entry_limit,stop,target,created_at,modo")
    .in("modo", ["shadow", "real", "paper"]).in("status", ["pending", "open"]).gte("created_at", arranque)
    .order("created_at", { ascending: true }).limit(80);
  for (const r of rows || []) {
    if (vistas.has(r.id)) continue;
    vistas.add(r.id);
    const tk = String(r.ticker || "").toUpperCase();
    const clave = `${tk}@${Math.round(Number(r.entry_limit) * 200)}`;   // mismo nivel (±0,5%)
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    const score = Number(r.score) || 0, rr = Number(r.rr) || 0;
    const faltas = [];
    if (!UNIVERSO.has(tk)) faltas.push("fuera del universo");
    if (ARG_LOCAL.has(tk)) faltas.push("acción argentina (v1 solo CEDEARs)");
    let riskMult = 1;
    if (SOMBRA) {
      // sin filtro: solo universo y que sea CEDEAR (ya chequeado arriba)
    } else if (r.modo === "shadow") {
      const { rgm, contra } = parseSenal(r.senal);
      const mixtoOk = rgm === "mixto" && score >= 8 && rr >= 2.5;
      if (score < MIN_SCORE) faltas.push(`score ${score}`);
      if (rr < 2) faltas.push(`R:R ${rr}`);
      if (contra) faltas.push("contra tendencia");
      if (!(rgm === "risk_on" || mixtoOk)) faltas.push(`régimen ${rgm}`);
      if (mixtoOk) riskMult = 0.5;
    } else if (/regimen mixto/i.test(r.senal || "")) riskMult = 0.5;
    if (faltas.length) { log(`[señal ${tk}] no califica: ${faltas.join(" · ")}`); continue; }
    if (!SOMBRA && await earningsCerca(tk)) { log(`[señal ${tk}] no califica: balance en 3 días`); continue; }
    try { await entrar(r, tk, riskMult); }
    catch (e) {
      const n = (reintentos.get(r.id) || 0) + 1; reintentos.set(r.id, n);
      log(`[señal ${tk}] error al entrar (${e.message})${n < 5 ? " — reintento en la próxima pasada" : " — abandono"}`);
      if (n < 5) { vistas.delete(r.id); vistas.delete(clave); }
    }
  }
}

async function abiertasCocos() {
  const { data } = await supabase.from("paper_iol_trades").select("*").eq("modo", LIBRO).in("status", ["pending", "open"]);
  return data || [];
}
async function perdidaHoy(vivas, usd) {
  const hoyIni = new Date(); hoyIni.setUTCHours(3, 0, 0, 0);
  const { data: cerr } = await supabase.from("paper_iol_trades").select("pnl_ars").eq("modo", LIBRO).eq("status", "closed").gte("exit_ts", hoyIni.toISOString());
  let t = (cerr || []).reduce((s, r) => s + (Number(r.pnl_ars) || 0), 0);
  for (const v of vivas) {
    if (v.status !== "open") continue;
    const p = usd[String(v.sym).toUpperCase()], r = Number(v.ratio);
    if (p > 0 && r > 0) t += (p * r - Number(v.px_ars_entrada)) * Number(v.qty);
  }
  return t;
}

async function entrar(sig, tk, riskMult) {
  const sym = String(sig.sym || tk).toUpperCase();
  const entry = Number(sig.entry_limit), targetSig = Number(sig.target), stopTec = Number(sig.stop);
  if (!(entry > 0 && targetSig > entry)) return;
  const vivas = await abiertasCocos();
  if (vivas.some((v) => String(v.ticker).toUpperCase() === tk)) { log(`[señal ${tk}] ya hay posición u orden viva en Cocos`); return; }
  const hoyIni = new Date(); hoyIni.setUTCHours(3, 0, 0, 0);
  const { count: nHoy } = await supabase.from("paper_iol_trades").select("id", { count: "exact", head: true }).eq("modo", LIBRO).gte("created_at", hoyIni.toISOString());
  if (MAX_DIA > 0 && (nHoy ?? 0) >= MAX_DIA) { log(`[señal ${tk}] tope de ${MAX_DIA} entradas por día`); return; }
  const { count: nHora } = await supabase.from("paper_iol_trades").select("id", { count: "exact", head: true }).eq("modo", LIBRO).gte("created_at", new Date(Date.now() - 3600_000).toISOString());
  if ((nHora ?? 0) >= MAX_HORA) { log(`[señal ${tk}] tope de ${MAX_HORA} entradas por hora`); return; }
  const usd = await usdPrecios();
  const p = usd[sym];
  // Precio en pesos: de Primary (el mismo libro donde se ejecuta la orden).
  const lb = await libro(tk, true);
  const local = lb.last || lb.bid;
  if (!(p > 0 && local > 0)) { log(`[señal ${tk}] sin precio USD o local, no dimensiono a ciegas`); return; }
  const ratio = local / p;
  const tick = await tickDe(tk);
  const limArs = alTick(entry * ratio, tick, "abajo");
  const a = await atr14(sym);
  const stop = STOP_ATR > 0 && a > 0 && entry - STOP_ATR * a > 0 ? entry - STOP_ATR * a : stopTec;
  const target = TARGET_PCT > 0 ? Math.min(targetSig, entry * (1 + TARGET_PCT)) : targetSig;
  const notMax = MAX_POS_ARS * riskMult;
  let qty = Math.floor(notMax / limArs);
  const comprometido = vivas.reduce((s, v) => s + Number(v.px_ars_entrada || v.px_ars_orden || 0) * Number(v.qty || 0), 0);
  if (comprometido + qty * limArs > CAP) qty = Math.floor((CAP - comprometido) / limArs);
  if (qty < 1) { log(`[señal ${tk}] sin capital: comprometido ${pesos(comprometido)} de ${pesos(CAP)}`); return; }
  const perd = await perdidaHoy(vivas, usd);
  if (PERDIDA_DIA > 0 && perd <= -PERDIDA_DIA) {
    if (avisoPerdida !== diaAr(new Date())) { avisoPerdida = diaAr(new Date()); await tg(`<b>COCOS BOT · freno diario</b>\nPérdida del día ${pesos(perd)} supera ${pesos(PERDIDA_DIA)}: no abro más posiciones hoy.`); }
    log(`[señal ${tk}] freno diario: pérdida ${pesos(perd)}`); return;
  }
  if (!plomeriaOk) { log(`[señal ${tk}] la prueba de plomería falló hoy: no coloco`); return; }
  if (!SOMBRA && !(await botHabilitado())) { if (avisoApagado !== diaAr(new Date())) { avisoApagado = diaAr(new Date()); log("bot_enabled=false para cocos: sin entradas nuevas"); } return; }
  if (REAL) {
    const disp = await disponible24().catch(() => null);
    if (disp != null && disp < qty * limArs * 1.01) {
      const qMax = Math.floor((disp * 0.985) / limArs);
      if (qMax < 1) { log(`[señal ${tk}] sin saldo en Cocos (${pesos(disp)} disponibles a 24hs)`); return; }
      qty = Math.min(qty, qMax);
    }
  }
  let brokerId = null;
  if (REAL) {
    try { brokerId = await ordenNueva(tk, "BUY", qty, limArs); }
    catch (e) { log(`[señal ${tk}] la compra fue RECHAZADA: ${e.message}`); await tg(`<b>COCOS BOT · compra rechazada ${tk}</b>\n${e.message}`); return; }
  }
  const { data: fila, error } = await supabase.from("paper_iol_trades").insert({
    ticker: tk, sym, senal: `COCOS · ${sig.senal || ""}`.replace("SIN FILTRO · ", ""), score: sig.score, rr: sig.rr,
    status: "pending", qty, entry_limit: entry, stop, stop_inicial: stop, target, r_value: entry - stop,
    modo: LIBRO, perfil: "cocos", ratio: Math.round(ratio * 100) / 100, px_ars_orden: limArs,
    broker_order_id: brokerId, regla_salida: TP_PARCIAL > 0 ? "trailing_atr+tp50" : "trailing_atr",
    nota_sim: `Orden límite ${qty} × ${pesos(limArs)} (US$${entry.toFixed(2)} × ratio ${ratio.toFixed(2)}). Stop ${STOP_ATR}×ATR US$${stop.toFixed(2)} · target US$${target.toFixed(2)}${TARGET_PCT > 0 && target < targetSig ? ` (tapado a +${(TARGET_PCT * 100).toFixed(1)}%)` : ""}.${REAL ? "" : " SIMULADA (COCOS_BOT_REAL≠1)."}`,
  }).select("id").single();
  if (error) { log(`[señal ${tk}] insert falló: ${error.message}`); if (brokerId) await ordenCancelar(brokerId).catch(() => {}); return; }
  log(`[cocos ${tk}] ORDEN ${REAL ? "REAL" : "SIMULADA"}: ${qty} × ${pesos(limArs)} (US$${entry.toFixed(2)}) · stop ${stop.toFixed(2)} · target ${target.toFixed(2)} · compromete ${pesos(qty * limArs)} · id ${fila.id}`);
  await tg(`<b>COCOS BOT · ORDEN ${tk}</b>${REAL ? "" : " (simulada)"}\nCompra ${qty} × ${pesos(limArs)} (US$${entry.toFixed(2)}) · total ${pesos(qty * limArs)}\nStop US$${stop.toFixed(2)} ≈ ${pesos(stop * ratio)} · Target US$${target.toFixed(2)} ≈ ${pesos(target * ratio)}\n${sig.senal || ""}`);
}

/* ───────── gestión de pendientes ───────── */
async function gestionarPendiente(t, usd) {
  const tk = String(t.ticker).toUpperCase(), sym = String(t.sym).toUpperCase();
  if (!t.broker_order_id) {
    // Simulada: fill cuando el subyacente cruza y el CEDEAR está ofrecido al límite.
    const p = usd[sym]; const lb = await libro(tk);
    if (p > 0 && p <= Number(t.entry_limit) && lb.ask > 0 && lb.ask <= Number(t.px_ars_orden)) await marcarFill(t, Number(t.px_ars_orden), t.qty, usd);
    return;
  }
  const o = await ordenEstado(t.broker_order_id).catch((e) => { log(`[cocos ${tk}] estado: ${e.message}`); return null; });
  if (!o) return;
  const st = String(o.status || "");
  if (st === "FILLED" || (Number(o.cumQty) > 0 && FINAL.has(st))) {
    const cum = Number(o.cumQty) || t.qty;
    await marcarFill(t, Number(o.avgPx) || Number(t.px_ars_orden), cum, usd);
    return;
  }
  if (FINAL.has(st)) {
    await supabase.from("paper_iol_trades").update({ status: "cancelled", exit_reason: st.toLowerCase(), veredicto: "sin_fill", nota_sim: `${t.nota_sim || ""} Primary: ${st} ${o.text || ""}`.trim() }).eq("id", t.id);
    log(`[cocos ${tk}] orden ${st}: ${o.text || ""}`);
    if (st === "REJECTED") await tg(`<b>COCOS BOT · orden rechazada ${tk}</b>\n${o.text || st}`);
    return;
  }
  // Viva: ¿el dólar corrió el límite? Recolocar con cancelación confirmada.
  // Solo con los DOS precios frescos: el CEDEAR de Primary y el subyacente
  // actualizado hace menos de 2 minutos. El 30/09 la orden de NBIS fue y
  // vino entre $13.650 y $13.550 porque el feed en dólares estaba caído y el
  // ratio se calculaba mezclando un precio viejo con uno nuevo.
  if (Date.now() - _usd.t > 120_000 && !(_yh.get(sym) && Date.now() - _yh.get(sym).t < 120_000)) return;
  const p = usd[sym]; const lb = await libro(tk, true);
  const local = lb.last || lb.bid;
  if (!(p > 0 && local > 0)) return;
  const ratio = local / p;
  const deberia = alTick(Number(t.entry_limit) * ratio, await tickDe(tk), "abajo");
  const deriva = Math.abs(deberia / Number(t.px_ars_orden) - 1);
  if (deriva > DERIVA_MAX && Date.now() - (recolocada.get(t.id) || 0) > RECOLOC_COOLDOWN_MS && hhmmAr() < 1630) {
    recolocada.set(t.id, Date.now());
    try {
      await ordenCancelar(t.broker_order_id);
      await new Promise((r) => setTimeout(r, 2500));
      const o2 = await ordenEstado(t.broker_order_id);
      if (Number(o2?.cumQty) > 0) { await marcarFill(t, Number(o2.avgPx), Number(o2.cumQty), usd); return; }
      if (o2?.status !== "CANCELLED") { log(`[cocos ${tk}] no confirmó la cancelación (${o2?.status}); no recoloco`); return; }
      const nuevo = await ordenNueva(tk, "BUY", t.qty, deberia);
      await supabase.from("paper_iol_trades").update({ broker_order_id: nuevo, px_ars_orden: deberia, ratio: Math.round(ratio * 100) / 100, recolocaciones: (t.recolocaciones || 0) + 1 }).eq("id", t.id);
      log(`[cocos ${tk}] recolocada: ${pesos(t.px_ars_orden)} → ${pesos(deberia)} (deriva ${(deriva * 100).toFixed(2)}%)`);
    } catch (e) { log(`[cocos ${tk}] recolocación falló: ${e.message}`); }
  }
}
async function marcarFill(t, pxArs, qty, usd) {
  const sym = String(t.sym).toUpperCase();
  const p = usd[sym]; const ratio = p > 0 ? pxArs / p : Number(t.ratio);
  await supabase.from("paper_iol_trades").update({
    status: "open", qty, entry_price: pxArs / ratio, entry_ts: new Date().toISOString(), px_ars_entrada: Math.round(pxArs), ratio: Math.round(ratio * 100) / 100,
    nota_sim: `${t.nota_sim || ""} ENTRÓ ${qty} × ${pesos(pxArs)}.`.trim(),
  }).eq("id", t.id);
  log(`[cocos ${t.ticker}] ENTRÓ ${qty} × ${pesos(pxArs)}`);
  await tg(`<b>COCOS BOT · ENTRÓ ${t.ticker}</b>\n${qty} × ${pesos(pxArs)} · total ${pesos(pxArs * qty)}\nStop ≈ ${pesos(Number(t.stop) * ratio)} · Target ≈ ${pesos(Number(t.target) * ratio)}`);
}

/* ───────── gestión de abiertas ───────── */
/* LA CUENTA ES COMPARTIDA: LP opera a mano en la misma cuenta 72404 (y suele
 * espejar las señales del bot). Reglas: (1) el bot NUNCA adopta una orden que
 * no colocó él: sus ventas quedan anotadas en la fila como [venta id|kind|
 * qty|px] y se recuperan al reiniciar; (2) antes de vender mira la tenencia
 * real del papel en la cuenta y descuenta las ventas activas ajenas: vende
 * como mucho lo que queda, así nunca deja la cuenta vendida en descubierto. */
async function tenenciaCuenta(tk) {
  const j = await api("GET", `/rest/risk/detailedPosition/${CUENTA}`);
  const rep = j?.detailedPosition?.report || {};
  let n = 0;
  for (const tipo of Object.values(rep)) for (const [sym, info] of Object.entries(tipo || {})) if (String(sym).toUpperCase() === tk) n += Number(info?.instrumentCurrentSize) || 0;
  return n;
}
async function vendibleDe(t, tk, qty) {
  const acts = await ordenesActivas().catch(() => []);
  const propias = new Set([...salidas.values()].map((s) => String(s.id).split("|")[0]));
  const ajenas = acts.filter((o) => o.side === "SELL" && o.instrumentId?.symbol === simbolo(tk) && !propias.has(o.clOrdId));
  const comprometidoAjeno = ajenas.reduce((a, o) => a + (Number(o.leavesQty) || Number(o.orderQty) || 0), 0);
  const tenencia = await tenenciaCuenta(tk).catch(() => null);
  if (tenencia == null) return qty;
  const libre = Math.max(0, tenencia - comprometidoAjeno);
  if (libre < qty) {
    log(`[cocos ${tk}] la cuenta tiene ${tenencia} y hay ventas ajenas por ${comprometidoAjeno}: vendo ${libre} de ${qty}`);
    await tg(`<b>COCOS BOT · ojo ${tk}</b>\nQuería vender ${qty} pero en la cuenta quedan ${libre} libres (tenencia ${tenencia}, ventas tuyas activas ${comprometidoAjeno}). Vendo ${libre}.`);
  }
  return Math.min(qty, libre);
}
async function vender(t, kind, qty, pxArs) {
  const tk = String(t.ticker).toUpperCase();
  if (salidas.has(t.id)) return;
  let id = null;
  if (REAL) {
    qty = await vendibleDe(t, tk, qty);
    if (qty < 1) { log(`[cocos ${tk}] nada para vender en la cuenta`); return; }
    try { id = await ordenNueva(tk, "SELL", qty, pxArs); }
    catch (e) { log(`[cocos ${tk}] la VENTA fue rechazada: ${e.message}`); await tg(`<b>COCOS BOT · VENTA RECHAZADA ${tk}</b>\n${e.message}\nLa posición sigue ABIERTA (${t.qty}). Reintento en la próxima pasada.`); return; }
    const marca = ` [venta ${id}|${kind}|${qty}|${pxArs}]`;
    await supabase.from("paper_iol_trades").update({ nota_sim: `${t.nota_sim || ""}${marca}` }).eq("id", t.id);
    t.nota_sim = `${t.nota_sim || ""}${marca}`;
  }
  salidas.set(t.id, { id, kind, qty, pxArs, placedAt: Date.now() });
  log(`[cocos ${tk}] venta ${kind}: ${qty} × ${pesos(pxArs)}${REAL ? ` (orden ${id})` : " (simulada)"}`);
}
// Al arrancar: recuperar las ventas del bot que quedaron en curso (reinicio).
async function reconciliarSalidas(vivas) {
  for (const t of vivas) {
    if (t.status !== "open") continue;
    const ms = [...String(t.nota_sim || "").matchAll(/\[venta ([^|\]]+)\|(\w+)\|(\d+)\|([\d.]+)\]/g)];
    if (!ms.length) continue;
    const m = ms[ms.length - 1];
    const o = await ordenEstado(m[1]).catch(() => null);
    if (o && (!FINAL.has(String(o.status)) || String(o.status) === "FILLED")) {
      salidas.set(t.id, { id: m[1], kind: m[2], qty: Number(m[3]), pxArs: Number(m[4]), placedAt: Date.now() });
      log(`[cocos ${t.ticker}] recupero venta ${m[1]} (${o.status})`);
    }
  }
}
async function cerrar(t, kind, qty, pxArs, usd) {
  const tk = String(t.ticker).toUpperCase(), sym = String(t.sym).toUpperCase();
  const pxEnt = Number(t.px_ars_entrada);
  const intradia = t.entry_ts ? diaAr(t.entry_ts) === diaAr(new Date()) : false;
  const fee = FEE_SWING * pxEnt * qty + (intradia ? FEE_INTRADIA : FEE_SWING) * pxArs * qty;
  const pnl = (pxArs - pxEnt) * qty - fee;
  const p = usd[sym]; const ratio = Number(t.ratio) || (p > 0 ? pxArs / p : 1);
  const comun = { px_ars_salida: Math.round(pxArs), exit_price: pxArs / ratio, exit_ts: new Date().toISOString(), fees_ars: Math.round(fee), pnl_ars: Math.round(pnl), fees_ars_alt: Math.round(fee), pnl_ars_alt: Math.round(pnl), tarifa_alt: "cocos", intradia, veredicto: pnl > 0 ? "acierto" : "error", pnl_pct: Math.round((pnl / (pxEnt * qty)) * 10000) / 100 };
  if (kind === "tp_parcial") {
    await supabase.from("paper_iol_trades").insert({ ...comun, ticker: t.ticker, sym: t.sym, senal: t.senal, score: t.score, rr: t.rr, status: "closed", qty, entry_limit: t.entry_limit, entry_price: t.entry_price, entry_ts: t.entry_ts, stop: t.stop, stop_inicial: t.stop_inicial, target: t.target, r_value: t.r_value, modo: LIBRO, perfil: "cocos", ratio: t.ratio, px_ars_entrada: pxEnt, exit_reason: "tp_parcial", regla_salida: "tp50_hijo", broker_order_id: salidas.get(t.id)?.id || null });
    await supabase.from("paper_iol_trades").update({ qty: t.qty - qty, regla_salida: String(t.regla_salida || "") + "+tp50hecho" }).eq("id", t.id);
    await tg(`<b>COCOS BOT · VENTA PARCIAL ${tk}</b>\n${qty} × ${pesos(pxArs)} · P&L ${pnl >= 0 ? "+" : "−"}${pesos(Math.abs(pnl))} · quedan ${t.qty - qty}`);
  } else {
    await supabase.from("paper_iol_trades").update({ ...comun, status: "closed", exit_reason: kind, nota_sim: `${t.nota_sim || ""} Salió por ${kind}: ${qty} × ${pesos(pxArs)}.`.trim() }).eq("id", t.id);
    await tg(`<b>COCOS BOT · SALIÓ ${tk} (${kind})</b>\n${qty} × ${pesos(pxArs)} · P&L ${pnl >= 0 ? "+" : "−"}${pesos(Math.abs(pnl))} (${comun.pnl_pct}%)`);
  }
  log(`[cocos ${tk}] CIERRE ${kind}: ${qty} × ${pesos(pxArs)} · P&L ${pesos(pnl)}`);
  salidas.delete(t.id);
}
async function gestionarAbierta(t, usd) {
  const tk = String(t.ticker).toUpperCase(), sym = String(t.sym).toUpperCase();
  const p = usd[sym];
  if (!(p > 0)) return;
  // 1) hay una venta en curso: seguir su estado
  const s = salidas.get(t.id);
  if (s) {
    if (!REAL || !s.id) { await cerrar(t, s.kind, s.qty, s.pxArs, usd); return; }
    const o = await ordenEstado(s.id).catch(() => null);
    if (!o) return;
    const st = String(o.status || "");
    if (st === "FILLED") { await cerrar(t, s.kind, Number(o.cumQty) || s.qty, Number(o.avgPx) || s.pxArs, usd); return; }
    if (FINAL.has(st)) {
      if (Number(o.cumQty) > 0) { await cerrar(t, s.kind, Number(o.cumQty), Number(o.avgPx) || s.pxArs, usd); return; }
      log(`[cocos ${tk}] la venta quedó ${st} (${o.text || ""}); reintento`); salidas.delete(t.id); return;
    }
    // Viva sin llenar hace más de 3 min: si es stop, bajar al bid actual.
    if (s.kind !== "target" && Date.now() - s.placedAt > 3 * 60_000) {
      const lb = await libro(tk, true);
      if (lb.bid > 0 && lb.bid < s.pxArs) {
        try { await ordenCancelar(s.id); await new Promise((r) => setTimeout(r, 2500)); const o2 = await ordenEstado(s.id); if (o2?.status === "CANCELLED") { salidas.delete(t.id); await vender(t, s.kind, s.qty, alTick(lb.bid, await tickDe(tk), "abajo")); } } catch (e) { log(`[cocos ${tk}] rebajar venta: ${e.message}`); }
      }
    }
    return;
  }
  // 2) trailing 1,5×ATR que solo sube
  let stop = Number(t.stop);
  if (STOP_ATR > 0 && TRAILING) {
    const pRef = Math.min(p, pAnterior.get(t.id) ?? p); pAnterior.set(t.id, p);
    const a = await atr14(sym);
    const sAtr = a > 0 ? pRef - STOP_ATR * a : null;
    if (sAtr != null && sAtr > stop * 1.002) { stop = sAtr; await supabase.from("paper_iol_trades").update({ stop }).eq("id", t.id); log(`[cocos ${tk}] stop sube a US$${stop.toFixed(2)}`); }
  }
  const entry = Number(t.entry_price), target = Number(t.target), ratio = Number(t.ratio) || 1;
  const tick = await tickDe(tk);
  // 3) venta parcial a mitad de camino
  if (TP_PARCIAL > 0 && t.qty >= 2 && !String(t.regla_salida || "").includes("tp50hecho")) {
    const nivel = entry + TP_PARCIAL * (target - entry);
    if (p >= nivel) {
      const c = cand.get("tp_" + t.id);
      if (!c) cand.set("tp_" + t.id, Date.now());
      else if (Date.now() - c >= CONFIRM_ENTRADA_MS) { cand.delete("tp_" + t.id); const lb = await libro(tk, true); const px = alTick(Math.min(nivel * ratio, lb.bid || nivel * ratio), tick, "abajo"); await vender(t, "tp_parcial", Math.floor(t.qty / 2), px); return; }
    } else cand.delete("tp_" + t.id);
  }
  // 4) stop / target
  let kind = null;
  if (p <= stop) kind = stop > Number(t.stop_inicial) + 1e-9 ? "trailing" : "stop";
  else if (p >= target) kind = "target";
  if (!kind) { cand.delete("exit_" + t.id); return; }
  const c = cand.get("exit_" + t.id);
  if (!c) { cand.set("exit_" + t.id, Date.now()); log(`[cocos ${tk}] ${kind} tocado (US$${p.toFixed(2)}) — espero confirmación`); return; }
  if (Date.now() - c < (kind === "target" ? CONFIRM_ENTRADA_MS : CONFIRM_SALIDA_MS)) return;
  cand.delete("exit_" + t.id);
  const lb = await libro(tk, true);
  const teorico = (kind === "target" ? target : Math.min(stop, p)) * ratio;
  const px = alTick(kind === "target" ? Math.max(teorico, lb.bid || 0) : (lb.bid > 0 ? Math.min(teorico, lb.bid) : teorico), tick, "abajo");
  await vender(t, kind, t.qty, px);
}

/* ───────── ciclo ───────── */
async function pasada() {
  if (!esHabil()) return;
  const h = hhmmAr();
  if (h < 1030 || h >= 1705) return;
  if (PROBAR && h >= 1031 && plomeriaDia !== diaAr(new Date())) await probarPlomeria();
  const vivas = await abiertasCocos();
  for (const t of vivas) wsSuscribirExtra(String(t.ticker).toUpperCase());
  const usd = await usdConRespaldo(vivas);
  for (const t of vivas) {
    try { if (t.status === "pending") await gestionarPendiente(t, usd); else await gestionarAbierta(t, usd); }
    catch (e) { log(`[cocos ${t.ticker}] ${e.message}`); }
  }
  if (h >= 1035 && h < 1630) await buscarSenales().catch((e) => log(`señales: ${e.message}`));
}

if (process.argv.includes("--chequeo")) {
  (async () => {
    await token(); console.log("login OK");
    console.log("tick OKLO", await tickDe("OKLO"), "· libro REST", await libroPrimary("OKLO"));
    wsConectar(); await new Promise((r) => setTimeout(r, 6000));
    console.log("websocket:", wsVivo() ? "vivo" : "sin mensajes", "· libros recibidos:", wsLibro.size, "· OKLO por ws:", JSON.stringify(wsLibro.get("OKLO") || null));
    const acts = await ordenesActivas(); console.log("órdenes activas:", acts.length);
    const todas = await api("GET", `/rest/order/all?${q({ accountId: CUENTA })}`);
    const ult = (todas?.orders || []).slice(-1)[0];
    if (ult) { const o = await ordenEstado(`${ult.clOrdId}|${ult.proprietary}`); console.log("estado de la última orden:", o?.status, o?.instrumentId?.symbol, o?.side, o?.orderQty, "@", o?.price, "cum", o?.cumQty, "avg", o?.avgPx); }
    console.log("disponible 24hs", pesos(await disponible24()));
    console.log("ATR OKLO", (await atr14("OKLO"))?.toFixed(3), "· earnings cerca OKLO:", await earningsCerca("OKLO"));
    const u = await usdPrecios(); console.log("usa_stocks:", Object.keys(u).length, "símbolos · OKLO", u.OKLO);
    console.log("bot_enabled cocos:", await botHabilitado(), "· universo", UNIVERSO.size, "· REAL", REAL, "· PROBAR", PROBAR);
    process.exit(0);
  })().catch((e) => { console.error("chequeo:", e.message); process.exit(1); });
} else (async () => {
  log(`config: ${fs.existsSync(path.join(process.cwd(), ".env")) ? path.join(process.cwd(), ".env") : path.join(__dirname, ".env")}`);
  log(`cocos-bot arrancando · libro ${LIBRO}${SOMBRA ? " (SIN FILTRO)" : ""} · ${REAL ? "*** ORDENES REALES ***" : "simulado (sin órdenes reales)"} · cuenta ${CUENTA} · cap ${pesos(CAP)} · ${pesos(MAX_POS_ARS)}/papel · ${MAX_HORA} entradas/hora${MAX_DIA > 0 ? ` (tope ${MAX_DIA}/día)` : ""} · stop ${STOP_ATR}×ATR ${TRAILING ? "con trailing" : "FIJO (sin trailing)"} · target ${TARGET_PCT > 0 ? `+${(TARGET_PCT * 100).toFixed(1)}% o resistencia` : "resistencia"} · puntaje ≥${MIN_SCORE} · universo ${UNIVERSO.size} papeles`);
  await token();
  log("login Primary OK");
  wsConectar();
  // Reconciliación al arrancar: las señales shadow anteriores al arranque no
  // se toman (evita entrar tarde en niveles viejos tras un reinicio).
  const vivas = await abiertasCocos();
  log(`filas vivas en el libro cocos: ${vivas.length}`);
  await reconciliarSalidas(vivas).catch((e) => log(`reconciliar: ${e.message}`));
  for (;;) {
    try { await pasada(); } catch (e) { log(`pasada: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 60_000));
  }
})();
