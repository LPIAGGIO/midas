/**
 * Worker telegram-notifier: servicio permanente (24/7) que conecta Midas con
 * Telegram. Vincula cuentas (deep-link) y dispara notificaciones server-side.
 *
 * Loops:
 *   1) LINKING (long-poll getUpdates): /start <code> (vincular), /stop (pausar),
 *      /ping, /help, y comandos de consulta on-demand: /pnl, /dlr, /canje.
 *   2) ALERTAS (cada 30s): evalua, por usuario y segun sus preferencias
 *      (notification_prefs.prefs jsonb), cada categoria:
 *        - price_alerts        (alertas de precio multinivel; default ON)
 *        - scalping_dlr        (calendario JUL-JUN + reversion z-score; solo en rueda)
 *        - desarbitrajes       (spread del canje de soberanos > umbral)
 *        - futures_adjustments (ajustes diarios pendientes de confirmar)
 *        - vencimientos        (futuro front / lecaps / boncaps por vencer)
 *        - eod_summary         (resumen de cierre, 1 vez/dia habil a la hora elegida)
 *
 * Anti-spam: cada disparo recurrente chequea notification_log (cooldown por
 * dedup_key). Las price_alerts son one-shot (triggered_at) con claim atomico.
 *
 * Resolucion de precio: espejo del front (api/mtr-md.js para futuros DLR,
 * data912 para el resto).
 *
 * Env (.env): TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!TOKEN || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan env vars (TELEGRAM_BOT_TOKEN / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

const API = `https://api.telegram.org/bot${TOKEN}`;
const ALERT_INTERVAL_MS = 30 * 1000;
const POLL_TIMEOUT_S = 30;
const FUTURE_MULT = 1000; // DLR: 1000 USD por contrato

// Parametros de senales (defaults; el front usa los mismos).
const CAL_BAND = [25, 31];      // spread calendario entre meses consecutivos del frente
const Z_THRESHOLD = 2;          // reversion z-score sobre cada contrato del frente (mes actual + 2)
const Z_MIN_MOVE_PCT = 0.3;     // ...además el desvío debe ser >= este % del precio (sino es ruido de centésimas)
const OUTLIER_PCT = 0.25;       // contrato vs mediana Var% de la curva: PUSH solo si se aparta >= esto (~4 pesos)
const Z_BUF_MAX = 40, Z_BUF_MIN = 20;
const DESARB_SPREAD_PCT = 1.5;  // umbral spread del canje (alto: el cross-bond real es ~0, el resto es ruido de precios stale)
const VENC_DAYS = 7;            // avisar si vence en <= N dias
const EOD_DEFAULT_HOUR = 18;    // hora ART del resumen de cierre
const EOD_WAIT_HOURS = 3;       // horas que el resumen espera el settle oficial de A3
const EOD_WAIT_IMPORT_H = 1;    // horas que espera el import del dia del usuario

// Ultimo import del usuario: el mas nuevo entre el libro y el ReporteOperaciones
// (csv_matriz). Devuelve { ts, esDeHoy } o null si nunca importo — a quien no
// usa importacion no se lo hace esperar.
async function lastImportInfo(userId, dateStr) {
  const [a, b] = await Promise.all([
    supabase.from("libro_movimientos").select("created_at").eq("user_id", userId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("positions").select("created_at").eq("user_id", userId)
      .filter("extra->>source", "eq", "csv_matriz")
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const ts = [a.data?.created_at, b.data?.created_at].filter(Boolean).sort().pop();
  if (!ts) return null;
  const art = new Date(new Date(ts).toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const y = art.getFullYear(), m = String(art.getMonth() + 1).padStart(2, "0"), d = String(art.getDate()).padStart(2, "0");
  return {
    esDeHoy: `${y}-${m}-${d}` === dateStr,
    hhmm: `${String(art.getHours()).padStart(2, "0")}:${String(art.getMinutes()).padStart(2, "0")}`,
    ddmm: `${d}/${m}`,
  };
}

// Cooldowns (ms) para no repetir la misma senal.
const CD = {
  scalping: 30 * 60 * 1000,
  desarb: 60 * 60 * 1000,
  vencimiento: 20 * 60 * 60 * 1000, // ~1 vez/dia por ticker
};

/* ─────────────── Telegram ─────────────── */

async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error(`[tg:${method}]`, j.description || r.status);
  return j;
}
const sendMessage = (chatId, text) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });

/* ─────────────── Tiempo ART ─────────────── */

function artParts() {
  const ar = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const y = ar.getFullYear(), m = String(ar.getMonth() + 1).padStart(2, "0"), d = String(ar.getDate()).padStart(2, "0");
  return { dateStr: `${y}-${m}-${d}`, hour: ar.getHours(), minute: ar.getMinutes(), dow: ar.getDay() };
}
const isBizDay = (dow) => dow !== 0 && dow !== 6;
// Rueda de futuros DLR: 10-15 ART, lun-vie.
function inRueda() {
  const p = artParts();
  return isBizDay(p.dow) && p.hour >= 10 && p.hour < 15;
}
// Rueda de bonos BYMA: ~11-17 ART, lun-vie (para no disparar canje con precios stale).
function inBymaHours() {
  const p = artParts();
  return isBizDay(p.dow) && p.hour >= 11 && p.hour < 17;
}
const PLAZO_LABEL = { "000": "CI", "001": "24hs", "002": "48hs" };

/* ─────────────── Vencimientos (port de bondMaturities/dlrContracts) ─────────────── */

const MONTH_LETTER = { E: 1, F: 2, M: 3, A: 4, Y: 5, J: 6, L: 7, G: 8, S: 9, O: 10, N: 11, D: 12 };
const MONTH_AR = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12 };

// Bonos CER que LP tiene y no estan en el registry de carry (se agregan a mano).
const CER_REGISTRY = { TZX27: "2027-06-30", TZXD7: "2027-12-15", TZXO7: "2027-10-30" };
const BOND_REGISTRY_DATES = {
  S15Y6: "2026-05-15", S29Y6: "2026-05-29", S17L6: "2026-07-17", S31L6: "2026-07-31",
  S14G6: "2026-08-14", S31G6: "2026-08-31", S30S6: "2026-09-30", S30O6: "2026-10-30", S30N6: "2026-11-30",
  T30J6: "2026-06-30", T15E7: "2027-01-15", T30A7: "2027-04-30", T31Y7: "2027-05-31", T30J7: "2027-06-30",
  TTM26: "2026-03-16", TTJ26: "2026-06-30", TTS26: "2026-09-15", TTD26: "2026-12-15",
};
function lastBusinessDayOfMonth(year, month) {
  const d = new Date(Date.UTC(year, month, 0));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
// Resuelve maturityDate (ISO) de un ticker. null si no se conoce.
function maturityOf(ticker) {
  const t = (ticker || "").toUpperCase().trim();
  if (BOND_REGISTRY_DATES[t]) return BOND_REGISTRY_DATES[t];
  if (CER_REGISTRY[t]) return CER_REGISTRY[t];
  // Futuro DLR: DLR + MES_AR + AA
  let m = /^DLR([A-Z]{3})(\d{2})$/.exec(t);
  if (m && MONTH_AR[m[1]]) return lastBusinessDayOfMonth(2000 + parseInt(m[2], 10), MONTH_AR[m[1]]);
  // TT + letra + 2 digitos
  m = /^TT([EFMAYJLGSOND])(\d{2})$/.exec(t);
  if (m && MONTH_LETTER[m[1]]) return `${2000 + parseInt(m[2], 10)}-${String(MONTH_LETTER[m[1]]).padStart(2, "0")}-30`;
  // [ST] + DD + letra + 1 digito
  m = /^([ST])(\d{2})([EFMAYJLGSOND])(\d)$/.exec(t);
  if (m && MONTH_LETTER[m[3]]) {
    const day = parseInt(m[2], 10);
    if (day >= 1 && day <= 31) return `${2020 + parseInt(m[4], 10)}-${String(MONTH_LETTER[m[3]]).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return null;
}
// Dias calendario hasta vencimiento. Negativo = YA vencio (clave: sin el
// Math.max(0,...) de antes, que dejaba a las letras vencidas en "0 dias" para
// siempre y las spameaba a diario). null si no hay fecha.
function daysToMaturity(maturityDate) {
  if (!maturityDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(maturityDate + "T00:00:00");
  return Math.round((exp - today) / 86400000);
}

/* ─────────────── Precios (espejo del front) ─────────────── */

const LAST_FRESH_MS = 30 * 60 * 1000, LAST_INTRADAY_MS = 36 * 60 * 60 * 1000;
const isDlrFuture = (t) => /^(DLR)([A-Z]{3})(\d{2})$/.test((t || "").toUpperCase().trim().replace("/", ""));
const symbolToApp = (s) => (s || "").replace("/", "");

function futurePrice(row, nowMs) {
  const last = row.last != null ? Number(row.last) : null;
  const bid = row.bid != null ? Number(row.bid) : null;
  const offer = row.ask != null ? Number(row.ask) : null;
  const settlement = row.settlement != null ? Number(row.settlement) : null;
  const midpoint = bid != null && offer != null ? (bid + offer) / 2 : null;
  const lastAge = row.last_ts ? nowMs - new Date(row.last_ts).getTime() : Infinity;
  if (last != null && lastAge <= LAST_FRESH_MS) return last;
  if (midpoint != null) return midpoint;
  if (last != null && lastAge <= LAST_INTRADAY_MS) return last;
  if (settlement != null) return settlement;
  return null;
}

// Devuelve { price, settle, reference } de mtr_market_data. `reference` es el
// CIERRE ANTERIOR oficial de A3 (precio de referencia = settle de ayer), que
// viene siempre en sync con el feed — se usa para el P&L del día en vez de la
// tabla histórica (que puede quedar con huecos si el worker de captura se saltea
// un día por feed atrasado, como pasó el 14-15/07/2026 → daba ajustes fantasma).
async function loadFutures() {
  const { data, error } = await supabase.from("mtr_market_data").select("*");
  if (error) { console.error("[futures]", error.message); return { price: {}, settle: {}, reference: {} }; }
  const nowMs = Date.now(), price = {}, settle = {}, reference = {};
  for (const row of data || []) {
    const app = symbolToApp(row.symbol);
    const p = futurePrice(row, nowMs);
    if (p != null) price[app] = p;
    if (row.settlement != null) settle[app] = Number(row.settlement);
    if (row.reference != null) reference[app] = Number(row.reference);
  }
  return { price, settle, reference };
}

// { symbol: { c, pct } } desde data912 (bonos/letras/acciones/cedears).
let _d912cache = null, _d912ts = 0;
async function loadData912() {
  if (_d912cache && Date.now() - _d912ts < 12000) return _d912cache;
  const SRC = ["arg_bonds", "arg_notes", "arg_stocks", "arg_cedears"].map((s) => `https://data912.com/live/${s}`);
  const map = {};
  await Promise.all(SRC.map(async (url) => {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Midas/0.1" } });
      if (!r.ok) return;
      for (const x of (await r.json()) || []) {
        if (x && x.symbol && x.c != null) map[x.symbol] = { c: Number(x.c), pct: x.pct_change != null ? Number(x.pct_change) : null };
      }
    } catch (e) { console.error("[data912]", e.message); }
  }));
  _d912cache = map; _d912ts = Date.now();
  return map;
}

// Ultimo settle por ticker ANTERIOR a la fecha dada (para P&L del dia).
async function loadYestSettles(beforeDate) {
  const { data } = await supabase.from("futures_settlements_history")
    .select("ticker,settle_date,settlement").lt("settle_date", beforeDate)
    .order("settle_date", { ascending: false });
  const m = {};
  for (const r of data || []) if (!(r.ticker in m)) m[r.ticker] = Number(r.settlement);
  return m;
}

/* ─────────────── Cooldown / log ─────────────── */

async function recentlySent(userId, kind, dedupKey, withinMs) {
  const since = new Date(Date.now() - withinMs).toISOString();
  const { data } = await supabase.from("notification_log").select("id")
    .eq("user_id", userId).eq("kind", kind).eq("dedup_key", dedupKey).gt("sent_at", since).limit(1);
  return Boolean(data && data.length);
}
function logSent(userId, kind, dedupKey, title, body) {
  return supabase.from("notification_log").insert({ user_id: userId, kind, dedup_key: dedupKey, title, body });
}

/* ─────────────── Posiciones ─────────────── */

// { user_id: [ {type, ticker, net} ] } consolidado (net != 0, sin FCI).
async function loadPositions(userIds) {
  const { data } = await supabase.from("positions")
    .select("user_id,instrument_type,ticker,quantity,operation_type").in("user_id", userIds);
  const byUser = {};
  const acc = {};
  for (const p of data || []) {
    const k = `${p.user_id}|${p.instrument_type}|${p.ticker}`;
    if (!acc[k]) acc[k] = { user_id: p.user_id, type: p.instrument_type, ticker: p.ticker, net: 0 };
    const q = Number(p.quantity) || 0;
    acc[k].net += p.operation_type === "sell" ? -q : q;
  }
  for (const v of Object.values(acc)) {
    if (Math.abs(v.net) < 1e-6 || v.type === "fci") continue;
    (byUser[v.user_id] = byUser[v.user_id] || []).push(v);
  }
  return byUser;
}

// Lotes CRUDOS (sin consolidar): para el P&L del dia completo de futuros
// (MTM del neto + realizado de hoy) hace falta entry_date y entry_price.
async function loadPositionsRaw(userIds) {
  const { data } = await supabase.from("positions")
    .select("user_id,instrument_type,ticker,quantity,entry_price,entry_date,operation_type").in("user_id", userIds);
  const byUser = {};
  for (const p of data || []) (byUser[p.user_id] = byUser[p.user_id] || []).push(p);
  return byUser;
}

/* P&L del dia de UN futuro (por ticker) settle-based, a partir de los lotes
 * crudos. Devuelve:
 *   dayPnl      = MTM completo del dia = realizado de hoy + MTM del neto abierto
 *                 (lote arrastrado vs settle de ayer; lote de hoy vs su entrada).
 *   realizedToday = solo lo realizado por trades de HOY que cerraron posicion
 *                 (motor de costo promedio, cronologico).
 */
function futuresTickerDay(lotes, settleToday, settleYest, todayStr) {
  const mult = FUTURE_MULT;
  let dayPnl = 0;
  for (const p of lotes) {
    const q = Number(p.quantity) || 0;
    if (!q) continue;
    const sign = p.operation_type === "sell" ? -1 : 1;
    const base = (p.entry_date === todayStr && Number(p.entry_price) > 0)
      ? Number(p.entry_price) : settleYest;
    if (base == null || !Number.isFinite(base)) continue;
    dayPnl += sign * (settleToday - base) * q * mult;
  }
  // Realizado de hoy: motor de costo promedio recorriendo cronologicamente.
  const sorted = lotes.slice().sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0));
  let posQty = 0, avg = 0, realizedToday = 0;
  for (const p of sorted) {
    const q = (Number(p.quantity) || 0) * (p.operation_type === "sell" ? -1 : 1);
    if (!q) continue;
    const price = Number(p.entry_price) || 0;
    const isToday = p.entry_date === todayStr;
    if (posQty === 0 || Math.sign(posQty) === Math.sign(q)) {
      const newQty = posQty + q;
      avg = newQty !== 0 ? (avg * Math.abs(posQty) + price * Math.abs(q)) / Math.abs(newQty) : 0;
      posQty = newQty;
    } else {
      const closeQty = Math.min(Math.abs(q), Math.abs(posQty));
      const pnl = (posQty > 0 ? (price - avg) : (avg - price)) * closeQty * mult;
      if (isToday) realizedToday += pnl;
      const remainder = Math.abs(q) - closeQty;
      posQty = posQty + q;
      if (remainder > 0) avg = price; // flipo: nueva posicion al precio del trade
    }
  }
  return { dayPnl, realizedToday };
}

/* ─────────────── Contexto del loop ─────────────── */

function prefOn(prefs, key, defaultOn) {
  const v = (prefs || {})[key];
  return defaultOn ? v !== false : v === true;
}

async function loadContext() {
  const { data: links } = await supabase.from("telegram_links")
    .select("user_id,chat_id").not("chat_id", "is", null).eq("enabled", true);
  if (!links || !links.length) return { users: [] };
  const ids = links.map((l) => l.user_id);
  const { data: prefRows } = await supabase.from("notification_prefs").select("user_id,prefs").in("user_id", ids);
  const prefsBy = Object.fromEntries((prefRows || []).map((p) => [p.user_id, p.prefs || {}]));
  const users = links.map((l) => ({ userId: l.user_id, chatId: l.chat_id, prefs: prefsBy[l.user_id] || {} }));
  return { users };
}

/* ─────────────── Evaluadores ─────────────── */

async function evalPriceAlerts(users, fut) {
  const subs = users.filter((u) => prefOn(u.prefs, "price_alerts", true));
  if (!subs.length) return;
  const ids = subs.map((u) => u.userId);
  // canal='screen' (Alertas TV): disparan SOLO en la pantalla de Midas, el bot
  // no las toca (y tampoco las reclama — el front las marca al cruzar).
  const { data: alerts } = await supabase.from("price_alerts")
    .select("id,user_id,ticker,price,dir,canal").is("triggered_at", null).in("user_id", ids).neq("canal", "screen");
  if (!alerts || !alerts.length) return;
  const chatBy = Object.fromEntries(subs.map((u) => [u.userId, u.chatId]));
  let d912 = null;
  if (alerts.some((a) => !isDlrFuture(a.ticker))) d912 = await loadData912();
  for (const a of alerts) {
    const tk = (a.ticker || "").toUpperCase().trim();
    const price = isDlrFuture(tk) ? fut.price[tk] : (d912 && d912[a.ticker] ? d912[a.ticker].c : null);
    if (price == null) continue;
    const level = Number(a.price);
    if (!(a.dir === "up" ? price >= level : price <= level)) continue;
    const { data: claimed } = await supabase.from("price_alerts")
      .update({ triggered_at: new Date().toISOString() }).eq("id", a.id).is("triggered_at", null).select("id");
    if (!claimed || !claimed.length) continue;
    await sendMessage(chatBy[a.user_id],
      `${a.dir === "up" ? "🎯 ▲" : "🛑 ▼"} <b>${a.ticker}</b>\nPrecio <b>${price}</b> cruzo tu alerta (${a.dir === "up" ? "sube a" : "baja a"} ${level}).`);
    await logSent(a.user_id, "price_alert", `${a.ticker}|${level}|${a.dir}`, `${a.ticker} ${level}`, `precio ${price}`);
    console.log(`[alert] ${a.user_id} ${a.ticker} ${a.dir} ${level} @ ${price}`);
  }
}

// Senales de scalping DLR (market-wide; solo en rueda con precios vivos).
// Cubre el mes en curso + los 2 siguientes (los 3 contratos DLR del frente).
const MES_COD = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const MES_NOM = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
function parseDlr(t) {
  const m = /^DLR([A-Z]{3})(\d{2})$/.exec(t);
  if (!m) return null;
  const mi = MES_COD.indexOf(m[1]);
  if (mi < 0) return null;
  return { ticker: t, mi, ord: Number(m[2]) * 12 + mi, nombre: MES_NOM[mi] };
}
// Los N contratos DLR del frente (mes actual + siguientes) que tengan precio vivo.
function frontDlr(fut, n = 3) {
  const now = new Date();
  const curOrd = (now.getFullYear() % 100) * 12 + now.getMonth();
  return Object.keys(fut.price)
    .map(parseDlr).filter(Boolean)
    .filter((c) => c.ord >= curOrd && fut.price[c.ticker] != null)
    .sort((a, b) => a.ord - b.ord)
    .slice(0, n);
}
// Var% diaria (último vs settlement previo, = la Var de Matriz) de cada contrato
// DLR de la curva + la mediana de la curva. La curva entera da el "consenso" del día;
// el contrato que más se aparta de esa mediana es el desalineado (caro/barato).
function curveVar(fut) {
  const all = Object.keys(fut.price).map(parseDlr).filter(Boolean)
    .map((c) => { const p = fut.price[c.ticker], s = fut.settle[c.ticker]; return (p != null && s != null && s > 0) ? { ...c, p, s, varPct: ((p - s) / s) * 100 } : null; })
    .filter(Boolean).sort((a, b) => a.ord - b.ord);
  let median = null;
  if (all.length) {
    const v = all.map((c) => c.varPct).sort((a, b) => a - b);
    median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  }
  return { all, median };
}

const zbufs = {};      // ticker -> buffer de precios para el z-score (uno por contrato)
const calState = {};   // par(far.ticker) -> "low"|"mid"|"high" (hysteresis del spread)
const outlierState = {}; // ticker -> "caro"|"align"|"barato" (hysteresis del outlier de curva)
function buildScalpingSignals(fut) {
  const sigs = [];
  const fronts = frontDlr(fut, 3);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // (1) Spread calendario entre meses CONSECUTIVOS (jul-jun, ago-jul). SOLO avisa
  //     cuando CRUZA fuera de la banda con margen (hysteresis) — un movimiento real,
  //     no por quedar medio peso del borde ni por estar parado siempre en un nivel.
  //     El texto da la lectura accionable: qué mes quedó caro y cuánto debería ceder.
  const [lo, hi] = CAL_BAND, MARGIN = 1;
  for (let i = 0; i + 1 < fronts.length; i++) {
    const near = fronts[i], far = fronts[i + 1];
    const pn = fut.price[near.ticker], pf = fut.price[far.ticker];
    if (pn == null || pf == null) continue;
    const cal = pf - pn;
    const key = far.ticker, prev = calState[key] || "mid";
    let cur = prev;
    if (cal < lo - MARGIN) cur = "low";
    else if (cal > hi + MARGIN) cur = "high";
    else if (cal > lo + 0.5 && cal < hi - 0.5) cur = "mid";
    calState[key] = cur;
    if (cur === prev || cur === "mid") continue; // solo en la TRANSICION a fuera de banda
    if (cur === "low")
      sigs.push({ key: `cal_low_${key}`, text: `📐 <b>Dólar futuro: ${cap(near.nombre)} y ${cap(far.nombre)} se juntaron</b>\nEl de ${far.nombre} (${pf}) quedó solo <b>${cal.toFixed(1)} pesos</b> por encima del de ${near.nombre} (${pn}); lo normal es ${lo} a ${hi}.\nLectura: el de ${near.nombre} quedó caro frente al de ${far.nombre} — para volver al rango tendría que ceder ~${(lo - cal).toFixed(1)} pesos (o el de ${far.nombre} subir otro tanto).` });
    else
      sigs.push({ key: `cal_high_${key}`, text: `📐 <b>Dólar futuro: ${cap(near.nombre)} y ${cap(far.nombre)} se separaron</b>\nEl de ${far.nombre} (${pf}) quedó <b>${cal.toFixed(1)} pesos</b> por encima del de ${near.nombre} (${pn}); lo normal es ${lo} a ${hi}.\nLectura: el de ${far.nombre} quedó caro frente al de ${near.nombre} — para volver al rango tendría que ceder ~${(cal - hi).toFixed(1)} pesos (o el de ${near.nombre} subir otro tanto).` });
  }

  // (2) Reversión: cada contrato del frente contra su propio promedio reciente.
  //     Pide |z|>=Z_THRESHOLD Y que el desvío sea ECONOMICAMENTE relevante
  //     (>= Z_MIN_MOVE_PCT del precio). Sin ese piso, con futuros casi planos la SD
  //     intradía es ínfima y un z alto era 1 peso de ruido (0,06%) — el caso que
  //     mostró LP: "junio se despegó de 1466,1 a 1467". El % filtra esas centésimas.
  for (const c of fronts) {
    const px = fut.price[c.ticker];
    if (px == null) continue;
    const buf = (zbufs[c.ticker] || (zbufs[c.ticker] = []));
    buf.push(px);
    while (buf.length > Z_BUF_MAX) buf.shift();
    if (buf.length < Z_BUF_MIN) continue;
    const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
    const sd = Math.sqrt(buf.reduce((a, b) => a + (b - mean) ** 2, 0) / buf.length);
    if (sd <= 0) continue;
    const z = (px - mean) / sd;
    const movePct = (Math.abs(px - mean) / px) * 100;
    if (Math.abs(z) >= Z_THRESHOLD && movePct >= Z_MIN_MOVE_PCT)
      sigs.push({ key: `z_${c.ticker}_${z > 0 ? "high" : "low"}`, text: `🔄 <b>Dólar futuro de ${c.nombre}: movimiento brusco</b>\nEl dólar futuro de ${c.nombre} (${px}) se ${z > 0 ? "despegó hacia arriba" : "despegó hacia abajo"} de su promedio reciente (${mean.toFixed(1)}) — un ${movePct.toFixed(2)}%. Se movió más rápido de lo normal y suele tender a volver hacia ese promedio.` });
  }

  // (3) Contrato DESALINEADO de la curva: cada mes del frente contra la mediana de
  //     Var% de TODA la curva DLR. El que más se aparta es el caro/barato. PUSH solo
  //     en la transición a desalineado con umbral OUTLIER_PCT (sino el ruido de ~1 peso
  //     —dentro de la punta— spamea); los desvíos chicos se ven on-demand con /dlr.
  const cv = curveVar(fut);
  if (cv.median != null && cv.all.length >= 3) {
    const frontSet = new Set(fronts.map((c) => c.ticker));
    for (const c of cv.all) {
      if (!frontSet.has(c.ticker)) continue;
      const dev = c.varPct - cv.median;
      const prev = outlierState[c.ticker] || "align";
      let cur = prev;
      if (dev > OUTLIER_PCT) cur = "caro";
      else if (dev < -OUTLIER_PCT) cur = "barato";
      else if (Math.abs(dev) < OUTLIER_PCT - 0.05) cur = "align";
      outlierState[c.ticker] = cur;
      if (cur === prev || cur === "align") continue; // solo en la transición a desalineado
      const pesos = ((Math.abs(dev) / 100) * c.p).toFixed(1);
      if (cur === "caro")
        sigs.push({ key: `out_${c.ticker}_caro`, text: `📊 <b>Dólar futuro de ${c.nombre}: caro vs la curva</b>\nHoy se movió por encima del resto de la curva (${c.varPct.toFixed(2)}% vs ${cv.median.toFixed(2)}% de mediana): quedó relativamente caro. Para alinearse tendría que ceder ~${pesos} pesos.` });
      else
        sigs.push({ key: `out_${c.ticker}_barato`, text: `📊 <b>Dólar futuro de ${c.nombre}: barato vs la curva</b>\nHoy se movió por debajo del resto de la curva (${c.varPct.toFixed(2)}% vs ${cv.median.toFixed(2)}% de mediana): quedó relativamente barato. Para alinearse tendría que subir ~${pesos} pesos.` });
    }
  }
  return sigs;
}
async function evalScalping(users, fut) {
  const subs = users.filter((u) => prefOn(u.prefs, "scalping_dlr", false));
  if (!subs.length || !inRueda()) return;
  const sigs = buildScalpingSignals(fut);
  if (!sigs.length) return;
  for (const u of subs) {
    for (const s of sigs) {
      if (await recentlySent(u.userId, "scalping", s.key, CD.scalping)) continue;
      await sendMessage(u.chatId, `${s.text}\n\n<i>Es solo un aviso de algo que Midas detectó y está midiendo. No es una recomendación de compra ni venta.</i>`);
      await logSent(u.userId, "scalping", s.key, "scalping", s.text.replace(/<[^>]+>/g, ""));
      console.log(`[scalping] ${u.userId} ${s.key}`);
    }
  }
}

async function evalDesarb(users) {
  const subs = users.filter((u) => prefOn(u.prefs, "desarbitrajes", false));
  if (!subs.length || !inBymaHours()) return;
  // PUNTAS EJECUTABLES (data912): solo avisamos si el mejor de venta supera al
  // mejor de compra por mas que el costo del rulo (~0,5%). El enfoque viejo
  // (ultimo precio MAE de sovereign_mep_canje) cantaba falsos por asincronia
  // intradia aunque las patas fueran del mismo dia (ej: AL30 vs GD35 con last
  // de momentos distintos del dia daba 3,7% fantasma). Esto es el canje REAL.
  const { bestBuy, bestSell, arbPct } = await fetchDolarBonds();
  if (arbPct == null || arbPct <= CANJE_PUSH_PCT) return;
  const f = (n) => Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const key = `${bestBuy.label}-${bestSell.label}`;
  const text = `⚡ <b>Canje real ${arbPct.toFixed(2)}%</b> (> Black ~0,4%)\nComprar USD por <b>${bestBuy.label}</b> a $${f(bestBuy.compra)}, vender por <b>${bestSell.label}</b> a $${f(bestSell.venta)}.\n<i>Puntas ejecutables, neto de cruzar. Confirma antes de operar.</i>`;
  for (const u of subs) {
    if (await recentlySent(u.userId, "desarb", key, CD.desarb)) continue;
    await sendMessage(u.chatId, text);
    await logSent(u.userId, "desarb", key, "canje real", `arb ${arbPct.toFixed(2)}`);
    console.log(`[desarb-real] ${u.userId} ${arbPct.toFixed(2)} ${bestBuy.label}->${bestSell.label}`);
  }
}

async function evalAdjustments(users) {
  const subs = users.filter((u) => prefOn(u.prefs, "futures_adjustments", false));
  if (!subs.length) return;
  const ids = subs.map((u) => u.userId);
  const { data: adjs } = await supabase.from("futures_daily_adjustments")
    .select("id,user_id,ticker,adjustment_date,estimated_amount").eq("status", "pending").in("user_id", ids);
  if (!adjs || !adjs.length) return;
  const chatBy = Object.fromEntries(subs.map((u) => [u.userId, u.chatId]));
  const byUser = {};
  for (const a of adjs) (byUser[a.user_id] = byUser[a.user_id] || []).push(a);
  for (const [uid, list] of Object.entries(byUser)) {
    const fresh = [];
    for (const a of list) if (!(await recentlySent(uid, "adjustment", a.id, CD.vencimiento))) fresh.push(a);
    if (!fresh.length) continue;
    const lines = fresh.map((a) => `• ${a.ticker} ${a.adjustment_date}: ${a.estimated_amount != null ? "$" + Math.round(Number(a.estimated_amount)).toLocaleString("es-AR") : "s/d"}`).join("\n");
    await sendMessage(chatBy[uid], `📋 <b>Ajustes de futuros pendientes</b> de confirmar:\n${lines}\nConfirmalos en Midas → Portfolio.`);
    for (const a of fresh) await logSent(uid, "adjustment", a.id, `ajuste ${a.ticker}`, a.adjustment_date);
    console.log(`[adjustment] ${uid} x${fresh.length}`);
  }
}

async function evalVencimientos(users, positionsBy) {
  const subs = users.filter((u) => prefOn(u.prefs, "vencimientos", false));
  if (!subs.length) return;
  for (const u of subs) {
    const pos = positionsBy[u.userId] || [];
    for (const p of pos) {
      const days = daysToMaturity(maturityOf(p.ticker));
      if (days == null || days < 0 || days > VENC_DAYS) continue; // vencidas: no alertar
      const key = `${p.ticker}`;
      if (await recentlySent(u.userId, "vencimiento", key, CD.vencimiento)) continue;
      const extra = p.type === "future" ? " — rola el contrato si queres mantener la posicion." : "";
      await sendMessage(u.chatId, `⏰ <b>${p.ticker}</b> vence en <b>${days} dia${days === 1 ? "" : "s"}</b>${extra}`);
      await logSent(u.userId, "vencimiento", key, `vence ${p.ticker}`, `${days}d`);
      console.log(`[vencimiento] ${u.userId} ${p.ticker} ${days}d`);
    }
  }
}

/* ─────────────── Resumen de cierre (EOD) ─────────────── */

// ¿Ya publico el mercado el ajuste (settle) de HOY? El feed marca settlement_ts
// con la fecha del settle; si coincide con hoy, el cierre de futuros ya esta.
async function futuresSettledToday(dateStr) {
  const { data } = await supabase.from("mtr_market_data")
    .select("settlement_ts").like("symbol", "DLR/%").not("settlement_ts", "is", null)
    .order("settlement_ts", { ascending: false }).limit(1);
  if (!data || !data.length || !data[0].settlement_ts) return false;
  return String(data[0].settlement_ts).slice(0, 10) === dateStr;
}

// Bloque de futuros (P&L del dia settle-based por ticker). Reutilizado por el
// resumen EOD (18hs) y el aviso de cierre de futuros (15hs). null si no hay nada.
async function futuresDayBlock(raw, fut, dateStr, money) {
  const futLotes = raw.filter((p) => p.instrument_type === "future");
  if (!futLotes.length) return null;
  const yest = await loadYestSettles(dateStr);
  const byTicker = {};
  for (const p of futLotes) (byTicker[p.ticker] = byTicker[p.ticker] || []).push(p);
  let subtotal = 0; const fl = [];
  for (const [ticker, lotes] of Object.entries(byTicker)) {
    const net = lotes.reduce((s, p) => s + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0), 0);
    const tradedToday = lotes.some((p) => p.entry_date === dateStr);
    // Saltear futuros vencidos/cerrados (neto 0) sin actividad hoy (ABR26/MAY26).
    if (Math.abs(net) < 1e-6 && !tradedToday) continue;
    // Cierre de ayer: preferimos el `reference` del feed (settle anterior oficial
    // de A3, siempre en sync); si falta, caemos a la tabla histórica.
    const sToday = fut.settle[ticker];
    const sYest = (fut.reference && fut.reference[ticker] != null) ? fut.reference[ticker] : yest[ticker];
    if (sToday == null || sYest == null) {
      if (Math.abs(net) < 1e-6) continue;
      fl.push(`• ${ticker} (${net > 0 ? "+" : ""}${net}): s/settle`); continue;
    }
    const { dayPnl } = futuresTickerDay(lotes, sToday, sYest, dateStr);
    subtotal += dayPnl;
    const ctx = tradedToday ? `  (incl. intradía)` : `  (${sYest}→${sToday})`;
    fl.push(`• ${ticker} (neto ${net > 0 ? "+" : ""}${net}): ${money(dayPnl)}${ctx}`);
  }
  if (!fl.length) return null;
  const block = `<b>Futuros DLR — P&L del dia</b>\n${fl.join("\n")}\nSubtotal: <b>${money(subtotal)}</b>`;
  return { block, subtotal };
}

// Aviso de CIERRE DE FUTUROS (15hs): solo el bloque de futuros. null si el user
// no tiene futuros con algo para mostrar.
async function buildFuturesSummary(userId, rawBy, fut) {
  const { dateStr } = artParts();
  const raw = rawBy[userId] || [];
  const money = (n) => `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("es-AR")}`;
  const futRes = await futuresDayBlock(raw, fut, dateStr, money);
  if (!futRes) return null;
  return `📊 <b>Cierre de futuros ${dateStr}</b>\n\n${futRes.block}\n<i>Ajuste de cierre de hoy vs ayer (como Matriz).</i>`;
}

// Realizado de HOY de CONTADO (CEDEARs/acciones/bonos/ON) por ticker: motor de
// costo promedio cronologico, suma el realizado de los cierres de hoy. Captura los
// round-trips intradia que ya no son tenencia (neto 0) — ej. SPCX, que el bloque
// de Tenencias saltea por estar plano. Bonos/ON dividen /100 VN.
function contadoRealizedToday(positions, dateStr) {
  const CONT = ["bond_ars", "bond_usd", "on", "stock", "cedear"];
  const byT = {};
  // Clave broker|ticker: un round-trip cerrado en Cocos debe detectarse aunque
  // el MISMO ticker siga abierto en IOL (antes se mezclaban los lotes de los
  // dos brokers y el cierre de Cocos desaparecía del resumen).
  for (const p of positions || []) {
    if (!CONT.includes(p?.instrument_type) || !p.ticker) continue;
    const key = (p.broker || "manual") + "|" + p.ticker;
    (byT[key] = byT[key] || []).push(p);
  }
  const out = {};
  for (const [ticker, lotes] of Object.entries(byT)) {
    const per100 = ["bond_ars", "bond_usd", "on"].includes(lotes[0].instrument_type);
    const sorted = lotes.slice().sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0));
    let posQty = 0, avg = 0, realized = 0;
    for (const p of sorted) {
      const q = (Number(p.quantity) || 0) * (p.operation_type === "sell" ? -1 : 1);
      if (!q) continue;
      const price = Number(p.entry_price) || 0;
      const isToday = p.entry_date === dateStr;
      if (posQty === 0 || Math.sign(posQty) === Math.sign(q)) {
        const newQty = posQty + q;
        avg = newQty !== 0 ? (avg * Math.abs(posQty) + price * Math.abs(q)) / Math.abs(newQty) : 0;
        posQty = newQty;
      } else {
        const closeQty = Math.min(Math.abs(q), Math.abs(posQty));
        const pnl = (posQty > 0 ? (price - avg) : (avg - price)) * closeQty / (per100 ? 100 : 1);
        if (isToday) realized += pnl;
        const remainder = Math.abs(q) - closeQty;
        posQty = posQty + q;
        if (remainder > 0) avg = price;
      }
    }
    if (Math.abs(realized) > 0.005) out[ticker] = realized;
  }
  return out;
}

async function buildEodSummary(userId, rawBy, fut) {
  const { dateStr } = artParts();
  const raw = rawBy[userId] || [];
  if (!raw.length) return `📊 <b>Cierre ${dateStr}</b>\nNo tenes posiciones.`;
  const money = (n) => `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("es-AR")}`;
  const lines = [`📊 <b>Cierre ${dateStr}</b>`];
  let grand = 0;

  // ── Futuros: P&L del dia (settle-based). Ver futuresDayBlock (reutilizado por
  //    el aviso de cierre de futuros de las 15hs).
  const futRes = await futuresDayBlock(raw, fut, dateStr, money);
  if (futRes) { grand += futRes.subtotal; lines.push(`\n${futRes.block}`); }

  // ── Tenencias (bonos/acciones): P&L del dia EN PESOS (variacion data912).
  const tenencias = raw.filter((p) => ["bond_ars", "bond_usd", "on", "stock", "cedear"].includes(p.instrument_type));
  if (tenencias.length) {
    const d912 = await loadData912();
    const netByTicker = {};
    const typeByTicker = {};
    for (const p of tenencias) {
      netByTicker[p.ticker] = (netByTicker[p.ticker] || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
      typeByTicker[p.ticker] = p.instrument_type;
    }
    let subtotal = 0; const bl = [];
    for (const [ticker, net] of Object.entries(netByTicker)) {
      if (Math.abs(net) < 1e-6) continue;
      // Letras/bonos YA VENCIDOS: no son tenencia (el cobro entró a la caja
      // como Renta y Amortización); quedaban listados como "s/precio" eterno.
      const mDays = daysToMaturity(maturityOf(ticker));
      if (mDays != null && mDays < 0) continue;
      const d = d912[ticker];
      if (!d || d.c == null || d.pct == null) { bl.push(`• ${ticker}: s/precio`); continue; }
      const prev = d.c / (1 + d.pct / 100);
      // Bonos/ON cotizan c/100 VN → dividir por 100. Acciones y CEDEARs van por
      // unidad → NO dividir (antes se dividía a todo y los CEDEARs salían 100x chicos).
      const per100 = ["bond_ars", "bond_usd", "on"].includes(typeByTicker[ticker]);
      const pnl = ((d.c - prev) * net) / (per100 ? 100 : 1);
      subtotal += pnl;
      bl.push(`• ${ticker}: ${money(pnl)} (${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(2)}%)`);
    }
    grand += subtotal;
    lines.push(`\n<b>Tenencias — P&L del dia</b>\n${bl.join("\n")}\nSubtotal: <b>${money(subtotal)}</b>`);
  }

  // ── Cerrado hoy (contado): realizado de round-trips de hoy que ya no son tenencia
  //    (neto 0) — ej. SPCX. Sin esto, una ganancia intradia grande se perdia del total.
  //    Solo tickers en neto 0 (totalmente cerrados): el MTM de lo que sigue abierto
  //    ya va en Tenencias, así no se pisa.
  // Neto por broker|ticker (misma clave que contadoRealizedToday): el cierre
  // de un round-trip en Cocos cuenta aunque el ticker siga abierto en IOL.
  const netAll = {};
  for (const p of raw) {
    if (!["bond_ars", "bond_usd", "on", "stock", "cedear"].includes(p?.instrument_type) || !p.ticker) continue;
    const key = (p.broker || "manual") + "|" + p.ticker;
    netAll[key] = (netAll[key] || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
  }
  const realToday = contadoRealizedToday(raw, dateStr);
  const rtEntries = Object.entries(realToday).filter(([k]) => Math.abs(netAll[k] || 0) < 1e-6);
  if (rtEntries.length) {
    let subtotal = 0; const bl = [];
    for (const [key, pnl] of rtEntries) {
      const [bk, ticker] = key.split("|");
      subtotal += pnl; bl.push(`• ${ticker}${bk && bk !== "manual" ? ` (${bk.toUpperCase()})` : ""}: ${money(pnl)}`);
    }
    grand += subtotal;
    lines.push(`\n<b>Cerrado hoy (contado) — realizado</b>\n${bl.join("\n")}\nSubtotal: <b>${money(subtotal)}</b>`);
  }

  lines.push(`\n<b>TOTAL del dia: ${money(grand)}</b>`);
  return lines.join("\n");
}

// El resumen sale a la hora elegida (18hs por defecto), PERO si el usuario
// tiene futuros espera a que A3 publique el ajuste del dia: a las 18 muchas
// veces todavia no esta y el P&L de futuros saldria contra el ultimo precio
// operado en vez del settle oficial. Se reintenta hora a hora hasta
// EOD_WAIT_HOURS; si a esa altura sigue sin publicarse, sale igual avisando
// que el ajuste es provisorio (mejor un resumen marcado que ninguno).
// Tiene futuros que pesan en el resumen de hoy? Mismo criterio que
// futuresDayBlock: neto abierto distinto de cero, u operados hoy. Un DLR
// vencido hace meses no debe hacer esperar el settle.
function futurosVivos(raw, dateStr) {
  const net = {};
  let hoy = false;
  for (const p of raw) {
    if (p.instrument_type !== "future") continue;
    if (p.entry_date === dateStr) hoy = true;
    net[p.ticker] = (net[p.ticker] || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
  }
  return hoy || Object.values(net).some((q) => Math.abs(q) > 1e-6);
}

async function evalEodScheduled(users) {
  const subs = users.filter((u) => prefOn(u.prefs, "eod_summary", false));
  if (!subs.length) return;
  const p = artParts();
  if (!isBizDay(p.dow)) return;
  const positionsBy = await loadPositionsRaw(subs.map((u) => u.userId));
  const fut = await loadFutures();
  let settled = null;   // se consulta una sola vez por vuelta, y solo si hace falta
  for (const u of subs) {
    const hour = Number((u.prefs || {}).eod_hour) || EOD_DEFAULT_HOUR;
    if (p.hour < hour || p.hour > hour + EOD_WAIT_HOURS) continue;
    if (await recentlySent(u.userId, "eod", p.dateStr, 23 * 60 * 60 * 1000)) continue;
    let provisorio = false;
    const tieneFuturos = futurosVivos(positionsBy[u.userId] || [], p.dateStr);
    if (tieneFuturos) {
      if (settled === null) settled = await futuresSettledToday(p.dateStr);
      if (!settled) {
        if (p.hour < hour + EOD_WAIT_HOURS) { console.log(`[eod] ${u.userId} espera settle`); continue; }
        provisorio = true;
      }
    }
    // Espera del IMPORT del dia: el resumen tiene que salir sobre lo que el
    // usuario cargo, no sobre la foto de ayer. LP sube el CSV "tipo 17 y pico";
    // si el resumen salia 18:00 clavadas y el import llegaba 18:20, iba viejo.
    // Se espera hasta una hora; despues sale igual, diciendo de cuando son los
    // datos. Quien nunca importo no espera nada.
    const imp = await lastImportInfo(u.userId, p.dateStr);
    if (imp && !imp.esDeHoy && p.hour < hour + EOD_WAIT_IMPORT_H) {
      console.log(`[eod] ${u.userId} espera import del dia (ultimo: ${imp.ddmm} ${imp.hhmm})`);
      continue;
    }
    let txt = await buildEodSummary(u.userId, positionsBy, fut);
    if (provisorio) txt += "\n\n<i>A3 todavia no publico el ajuste del dia: el P&L de futuros es provisorio.</i>";
    if (imp) {
      txt += imp.esDeHoy
        ? `\n<i>Datos: tu import de hoy ${imp.hhmm}.</i>`
        : `\n<i>Ojo: sin import de hoy — datos hasta el del ${imp.ddmm} ${imp.hhmm}.</i>`;
    }
    await sendMessage(u.chatId, txt);
    await logSent(u.userId, "eod", p.dateStr, "cierre", "resumen diario");
    console.log(`[eod] ${u.userId} ${p.dateStr}`);
  }
}

// Aviso de CIERRE DE FUTUROS a las 15hs (cuando el mercado publica el ajuste).
// Ventana 15-17hs: dispara el primer loop donde el settle de HOY ya esta
// publicado (sino el P&L saldria 0/stale), una sola vez por dia (dedup).
async function evalFuturesCloseScheduled(users) {
  const p = artParts();
  if (!isBizDay(p.dow)) return;
  if (p.hour < 15 || p.hour > 17) return;
  const subs = users.filter((u) => prefOn(u.prefs, "futures_close", true));
  if (!subs.length) return;
  if (!(await futuresSettledToday(p.dateStr))) return; // el cierre todavia no se publico
  const positionsBy = await loadPositionsRaw(subs.map((u) => u.userId));
  const fut = await loadFutures();
  for (const u of subs) {
    if (await recentlySent(u.userId, "fut_close", p.dateStr, 23 * 60 * 60 * 1000)) continue;
    const txt = await buildFuturesSummary(u.userId, positionsBy, fut);
    if (!txt) continue; // sin futuros
    await sendMessage(u.chatId, txt);
    await logSent(u.userId, "fut_close", p.dateStr, "cierre futuros", "resumen futuros");
    console.log(`[fut_close] ${u.userId} ${p.dateStr}`);
  }
}

/* ─────────────── Aviso al admin de usuarios nuevos ─────────────── */
// Cada perfil nuevo (no registrado en notification_log kind='new_user') dispara
// un DM a TODOS los admins (admin_users) que tengan Telegram linkeado, y se
// marca como avisado. Los preexistentes se backfillearon para no spamear.
async function checkNewUsers() {
  try {
    const { data: admins } = await supabase.from("admin_users").select("user_id");
    if (!admins || !admins.length) return;
    const adminIds = admins.map((a) => a.user_id);
    const { data: links } = await supabase.from("telegram_links").select("chat_id").in("user_id", adminIds);
    const adminChats = [...new Set((links || []).map((l) => l.chat_id).filter(Boolean))];
    if (!adminChats.length) return;
    const { data: sent } = await supabase.from("notification_log").select("dedup_key").eq("kind", "new_user");
    const known = new Set((sent || []).map((r) => r.dedup_key));
    const { data: profiles } = await supabase.from("profiles").select("id, email, display_name, created_at").order("created_at", { ascending: true });
    for (const p of profiles || []) {
      if (known.has(p.id)) continue;
      const who = p.display_name || p.email || p.id;
      const extra = p.email && p.display_name ? ` (${p.email})` : "";
      const msg = `🆕 <b>Nuevo usuario en Midas</b>\n${who}${extra}`;
      for (const chat of adminChats) await sendMessage(chat, msg);
      await supabase.from("notification_log").insert({ user_id: adminIds[0], kind: "new_user", dedup_key: p.id, title: "nuevo usuario", body: p.email || "" });
      console.log(`[new_user] avisado admin: ${who}`);
    }
  } catch (e) { console.error("[checkNewUsers]", e.message); }
}

/* ─────────────── Serie diaria de riesgo país ─────────────── */
// argentinadatos (que daba la serie histórica) murió en jul-2026; ámbito solo
// publica el último valor. Logueamos acá el valor diario en riesgo_pais_history
// para reconstruir la serie (la usa el Semáforo del Merval para la tendencia
// 21 ruedas). Una vez por día (flag en memoria; upsert idempotente por fecha).
let _rpLoggedDate = null;
async function logRiesgoPais() {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
    if (_rpLoggedDate === today) return;
    const r = await fetch("https://mercados.ambito.com//riesgopais/variacion", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!r.ok) return;
    const j = await r.json();
    const valor = Number(String(j?.ultimo || "").replace(/\./g, "").replace(",", "."));
    const m = String(j?.fecha || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
    const fecha = m ? `${m[3]}-${m[2]}-${m[1]}` : today;
    if (!Number.isFinite(valor) || valor <= 0) return;
    const { error } = await supabase.from("riesgo_pais_history").upsert({ fecha, valor }, { onConflict: "fecha" });
    if (!error) { _rpLoggedDate = today; console.log(`[riesgo_pais] ${fecha} ${valor}`); }
  } catch (e) { console.error("[logRiesgoPais]", e.message); }
}

/* ─────────────── Loop principal de alertas ─────────────── */

async function alertLoop() {
  try {
    await checkNewUsers();
    await logRiesgoPais();
    const { users } = await loadContext();
    if (!users.length) return;
    const fut = await loadFutures();
    await evalPriceAlerts(users, fut);
    await evalScalping(users, fut);
    await evalDesarb(users);
    await evalAdjustments(users);
    const needVenc = users.some((u) => prefOn(u.prefs, "vencimientos", false));
    if (needVenc) {
      const positionsBy = await loadPositions(users.map((u) => u.userId));
      await evalVencimientos(users, positionsBy);
    }
    await evalEodScheduled(users);
    await evalFuturesCloseScheduled(users);
    await evalMorningBrief(users);
    await evalAperturaByma(users);
    await evalCampanasTarde(users);
  } catch (e) {
    console.error("[alertLoop]", e.message);
  }
}

/* ─────────────── Brief matinal (9AM, dias habiles) ───────────────
 *
 * Panorama pre-BYMA: Asia ya cerro, los futuros de USA operan, Argentina abre
 * 10:30. Tres bloques: (1) los papeles en cartera con el pre-market o el
 * cierre anterior del SUBYACENTE en USA, mas su proximo balance si cae en 7
 * dias; (2) cierre de Asia; (3) futuros de USA + VIX.
 *
 * Los precios salen de Yahoo (chart v8). El % del dia se calcula contra la
 * serie DIARIA (ultimos dos cierres), no contra meta.chartPreviousClose, que
 * viene desfasado en varios simbolos (el KOSPI llego a mostrar +3,02% cuando
 * el movimiento real era +2,08%). */
const YA_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
// Acciones argentinas -> su ADR (los CEDEARs ya usan el mismo ticker que USA).
const BRIEF_ADR = { GGAL: "GGAL", YPFD: "YPF", PAMP: "PAM", TXAR: "TX", BMA: "BMA", CEPU: "CEPU", EDN: "EDN", LOMA: "LOMA", SUPV: "SUPV" };

async function yahooBrief(sym) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=8d`, { headers: YA_UA });
    if (!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const meta = res?.meta || {};
    const ts = res?.timestamp || [];
    const c = res?.indicators?.quote?.[0]?.close || [];
    const pts = ts.map((t, i) => Number(c[i])).filter((v) => Number.isFinite(v) && v > 0);
    if (pts.length < 2) return null;
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    const pre = Number(meta.preMarketPrice) || null;
    return {
      px: last, pct: (last / prev - 1) * 100,
      pre, prePct: pre ? (pre / last - 1) * 100 : null,
    };
  } catch { return null; }
}

function briefPct(x) { return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}%`; }

async function buildMorningBrief(userId) {
  // (1) cartera: contado con neto > 0, colapsando brokers
  const { data: pos } = await supabase.from("positions")
    .select("ticker,instrument_type,operation_type,quantity")
    .eq("user_id", userId).in("instrument_type", ["cedear", "stock"]);
  const net = new Map();
  for (const p of pos || []) {
    const q = (Number(p.quantity) || 0) * (p.operation_type === "sell" ? -1 : 1);
    net.set(p.ticker, (net.get(p.ticker) || 0) + q);
  }
  const tks = [...net.entries()].filter(([, q]) => q > 1e-9).map(([t]) => t).sort();
  if (!tks.length) return null;

  // proximos balances (7 dias) de esos papeles
  const hoy = artParts().dateStr;
  const en7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { data: earn } = await supabase.from("earnings_calendar")
    .select("ticker,earnings_date").in("ticker", tks.map((t) => BRIEF_ADR[t] || t))
    .gte("earnings_date", hoy).lte("earnings_date", en7);
  const earnBy = {};
  for (const e of earn || []) earnBy[e.ticker] = e.earnings_date;

  const filas = [];
  for (const tk of tks) {
    const q = await yahooBrief(BRIEF_ADR[tk] || tk);
    if (!q) { filas.push(`• ${tk}: s/d`); continue; }
    let l = `• <b>${tk}</b> ${briefPct(q.pct)}`;
    if (q.prePct != null && Math.abs(q.prePct) >= 0.05) l += ` · pre ${briefPct(q.prePct)}`;
    const ed = earnBy[BRIEF_ADR[tk] || tk];
    if (ed) l += ` · balance ${ed.slice(8, 10)}/${ed.slice(5, 7)}`;
    filas.push(l);
  }

  // (2) Asia (cerrada a esta hora) y (3) futuros USA
  const ASIA = [["^N225", "Nikkei"], ["^KS11", "KOSPI"], ["^HSI", "HangSeng"], ["000001.SS", "Shanghai"]];
  const USA = [["ES=F", "S&P fut"], ["NQ=F", "Nasdaq fut"], ["^VIX", "VIX"], ["GC=F", "Oro"]];
  const asia = [], usa = [];
  for (const [sym, nom] of ASIA) { const q = await yahooBrief(sym); if (q) asia.push(`${nom} ${briefPct(q.pct)}`); }
  for (const [sym, nom] of USA) { const q = await yahooBrief(sym); if (q) usa.push(`${nom} ${briefPct(q.pct)}`); }

  return `<b>Brief 9AM</b> — panorama pre-apertura\n\n` +
    `<b>Tu cartera (subyacente USA, cierre de ayer${filas.some((f) => f.includes("pre ")) ? " y pre-market" : ""})</b>\n${filas.join("\n")}\n\n` +
    (asia.length ? `<b>Asia (cerrado)</b>\n${asia.join(" · ")}\n\n` : "") +
    (usa.length ? `<b>USA (futuros ahora)</b>\n${usa.join(" · ")}\n\n` : "") +
    `BYMA abre 10:30.`;
}

async function evalMorningBrief(users) {
  const p = artParts();
  if (!isBizDay(p.dow) || p.hour !== 9) return;
  for (const u of users) {
    // Opt-in, como el resto del catalogo: la UI de Notificaciones muestra el
    // toggle apagado por defecto y el worker tiene que coincidir, o el usuario
    // recibiria un brief que su pantalla dice que esta desactivado.
    if (!prefOn(u.prefs, "morning_brief", false)) continue;
    if (await recentlySent(u.userId, "morning", p.dateStr, 20 * 60 * 60 * 1000)) continue;
    try {
      const txt = await buildMorningBrief(u.userId);
      if (!txt) continue;   // sin cartera de contado: no hay brief que armar
      await sendMessage(u.chatId, txt);
      await logSent(u.userId, "morning", p.dateStr, "brief 9am", "panorama pre-apertura");
      console.log(`[morning] ${u.userId} ${p.dateStr}`);
    } catch (e) { console.error("[morning]", e.message); }
  }
}

/* ─────────────── Avisos de apertura BYMA (10:00 y 10:30) ───────────────
 *
 * Dos toques del mismo ritual, un solo toggle (byma_open, opt-in):
 *   10:00 — arranca el pre-market/subasta. Va con los futuros de USA del
 *           momento y el dolar, que es lo que se mira antes de operar.
 *   10:30 — abrio la rueda continua.
 * Dedup por kind distinto (byma_pre / byma_open) para que cada uno salga una
 * sola vez por dia. */
async function snapshotAperturaExtra() {
  const partes = [];
  try {
    const fut = [];
    for (const [sym, nom] of [["ES=F", "S&P"], ["NQ=F", "Nasdaq"]]) {
      const q = await yahooBrief(sym);
      if (q) fut.push(`${nom} ${briefPct(q.pct)}`);
    }
    if (fut.length) partes.push(`Futuros USA: ${fut.join(" · ")}`);
  } catch { /* sin futuros */ }
  try {
    const r = await fetch("https://dolarapi.com/v1/dolares");
    if (r.ok) {
      const data = await r.json();
      const by = {}; for (const d of data) by[d.casa] = d;
      const fInt = (x) => (x == null ? "—" : Math.round(Number(x)).toLocaleString("es-AR"));
      const linea = ["oficial", "bolsa", "contadoconliqui"].map((k) => {
        const d = by[k]; if (!d) return null;
        const nom = k === "oficial" ? "Oficial" : k === "bolsa" ? "MEP" : "CCL";
        return `${nom} ${fInt(d.venta)}`;
      }).filter(Boolean).join(" · ");
      if (linea) partes.push(`Dolar: ${linea}`);
    }
  } catch { /* sin dolar */ }
  return partes.length ? "\n" + partes.join("\n") : "";
}

async function evalAperturaByma(users) {
  const p = artParts();
  if (!isBizDay(p.dow)) return;
  const subs = users.filter((u) => prefOn(u.prefs, "byma_open", false));
  if (!subs.length) return;

  // 10:00 — pre-market. Ventana de una hora entera (hour==10) con dedup, pero
  // el texto solo corresponde ANTES de las 10:30; despues de la apertura ya no
  // tiene sentido mandar "arranca la subasta".
  if (p.hour === 10 && p.minute < 30) {
    const extra = await snapshotAperturaExtra();
    for (const u of subs) {
      if (await recentlySent(u.userId, "byma_pre", p.dateStr, 20 * 60 * 60 * 1000)) continue;
      await sendMessage(u.chatId, `<b>10:00 — pre-market BYMA</b>\nArranca la subasta de apertura. La rueda continua abre 10:30.${extra}`);
      await logSent(u.userId, "byma_pre", p.dateStr, "pre-market", "10:00");
    }
  }

  // 10:30 — apertura de la rueda continua.
  if ((p.hour === 10 && p.minute >= 30) || p.hour === 11) {
    for (const u of subs) {
      if (await recentlySent(u.userId, "byma_open", p.dateStr, 20 * 60 * 60 * 1000)) continue;
      await sendMessage(u.chatId, `<b>10:30 — abrio BYMA</b>\nRueda continua hasta las 17:00.`);
      await logSent(u.userId, "byma_open", p.dateStr, "apertura", "10:30");
    }
  }
}

/* ─────────────── Campanas de la tarde (14:50 / 15 / 16 / 17) ───────────────
 *
 * El ritmo de la tarde en cuatro toques, un toggle (campanas_tarde, opt-in):
 *   14:50  faltan 10 min para el cierre de futuros — con el front DLR al
 *          momento, que es lo que se mira para decidir un ajuste de ultima
 *   15:00  cerraron los futuros (el settle oficial sale mas tarde; el aviso
 *          con P&L firme es el de "cierre de futuros" de siempre)
 *   16:00  recordatorio de caucion, con la tasa a 1 dia si esta en el feed
 *   17:00  cerro BYMA
 * Cada uno con su kind de dedup. Ventanas acotadas: el "faltan 10 minutos"
 * despues de las 15 es mentira, no se manda tarde. */
async function evalCampanasTarde(users) {
  const p = artParts();
  if (!isBizDay(p.dow)) return;
  const subs = users.filter((u) => prefOn(u.prefs, "campanas_tarde", false));
  if (!subs.length) return;

  const manda = async (kind, hastaHora, texto) => {
    for (const u of subs) {
      if (await recentlySent(u.userId, kind, p.dateStr, 20 * 60 * 60 * 1000)) continue;
      await sendMessage(u.chatId, texto);
      await logSent(u.userId, kind, p.dateStr, kind, p.dateStr);
    }
  };

  // 14:50-14:59 — la ventana es estricta: pasadas las 15 el mensaje es falso.
  if (p.hour === 14 && p.minute >= 50) {
    let extra = "";
    try {
      const fut = await loadFutures();
      const partes = [];
      // Los TRES DEL FRENTE por vencimiento real. Un sort alfabetico daria
      // AGO26/DIC26/ENE27 — contratos vencidos o lejanos, no lo que se opera.
      const MES = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12 };
      const venc = (tk) => {
        const m = tk.match(/^DLR([A-Z]{3})(\d{2})$/);
        return m && MES[m[1]] ? Number("20" + m[2]) * 100 + MES[m[1]] : 999999;
      };
      const hoyYm = (() => { const q = artParts().dateStr; return Number(q.slice(0, 4)) * 100 + Number(q.slice(5, 7)); })();
      const frente = Object.keys(fut.price || {})
        .filter((tk) => venc(tk) >= hoyYm)
        .sort((a, b) => venc(a) - venc(b))
        .slice(0, 3);
      for (const tk of frente) {
        const last = fut.price[tk], ref = fut.reference?.[tk];
        if (!(last > 0)) continue;
        const varPct = ref > 0 ? ` (${last >= ref ? "+" : "−"}${Math.abs((last / ref - 1) * 100).toFixed(2)}%)` : "";
        partes.push(`${tk} ${last.toLocaleString("es-AR")}${varPct}`);
      }
      if (partes.length) extra = `\n${partes.join(" · ")}`;
    } catch { /* sin feed */ }
    await manda("t1450", 15, `<b>14:50 — faltan 10 min para el cierre de futuros</b>\nUltima ventana para ajustar posiciones DLR. Cierran 15:00.${extra}`);
  }

  // 15:00-15:59
  if (p.hour === 15) {
    await manda("t1500", 16, `<b>15:00 — cerraron los futuros</b>\nEl settle oficial se publica mas tarde; cuando este, llega el aviso de cierre con el P&L firme.`);
  }

  // 16:00-16:59 — la caucion se toma con la rueda todavia abierta.
  if (p.hour === 16) {
    let tasa = "";
    try {
      const { data } = await supabase.from("mtr_market_data")
        .select("reference").eq("symbol", "CAARS/1D").maybeSingle();
      if (Number(data?.reference) > 0) tasa = ` Tasa a 1 dia ahora: ${Number(data.reference).toFixed(1)}% TNA.`;
    } catch { /* sin tasa */ }
    await manda("t1600", 17, `<b>16:00 — ventana de caucion</b>\nSi hay que tomar caucion para cubrir saldos de hoy, este es el momento.${tasa}`);
  }

  // 17:00-17:59
  if (p.hour === 17) {
    await manda("t1700", 18, `<b>17:00 — cerro BYMA</b>\nFin de la rueda continua. Resumen del dia: /pnl cuando quieras; el de las 18 llega solo si lo tenes activado.`);
  }
}

/* ─────────────── Comandos on-demand (consulta) ─────────────── */

async function userByChat(chatId) {
  const { data } = await supabase.from("telegram_links").select("user_id").eq("chat_id", String(chatId)).maybeSingle();
  return data ? data.user_id : null;
}

async function cmdPnl(chatId) {
  const userId = await userByChat(chatId);
  if (!userId) { await sendMessage(chatId, "No estas vinculado. Vincula desde Midas → Configuracion → Notificaciones."); return; }
  const positionsBy = await loadPositionsRaw([userId]);
  const fut = await loadFutures();
  await sendMessage(chatId, await buildEodSummary(userId, positionsBy, fut));
}

// /momentum — la cartera momentum real (CEDEARs en IOL): valor actual vs costo,
// papel por papel, con precios live de data912.
async function cmdMomentum(chatId) {
  const userId = await userByChat(chatId);
  if (!userId) { await sendMessage(chatId, "No estas vinculado. Vincula desde Midas → Configuracion → Notificaciones."); return; }
  const { data: pos } = await supabase.from("positions")
    .select("ticker,operation_type,quantity,entry_price")
    .eq("user_id", userId).eq("broker", "iol").eq("instrument_type", "cedear");
  if (!pos || !pos.length) { await sendMessage(chatId, "Sin posiciones CEDEAR en IOL."); return; }
  const agg = {};
  for (const p of pos) {
    const q = (Number(p.quantity) || 0) * (p.operation_type === "sell" ? -1 : 1);
    const a = agg[p.ticker] || (agg[p.ticker] = { net: 0, cost: 0 });
    a.net += q;
    if (q > 0) a.cost += q * (Number(p.entry_price) || 0);
  }
  const d912 = await loadData912();
  const money0 = (n) => `$${Math.round(Math.abs(n)).toLocaleString("es-AR")}`;
  let totAct = 0, totIni = 0; const rows = [];
  for (const [tk, a] of Object.entries(agg).sort()) {
    if (a.net <= 0) continue;
    const px = d912[tk]?.c;
    const act = px != null ? a.net * px : a.cost;
    totAct += act; totIni += a.cost;
    const pct = a.cost > 0 ? ((act / a.cost - 1) * 100) : null;
    rows.push(`• ${tk} ×${a.net}: ${money0(act)}${pct != null ? ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)` : " (s/precio)"}`);
  }
  const rend = totAct - totIni;
  const rendPct = totIni > 0 ? (rend / totIni) * 100 : 0;
  await sendMessage(chatId,
    `📈 <b>Momentum IOL</b>\n${rows.join("\n")}\n\nValor: <b>${money0(totAct)}</b> · Costo: ${money0(totIni)}\nResultado: <b>${rend >= 0 ? "+" : "−"}${money0(rend)} (${rendPct >= 0 ? "+" : ""}${rendPct.toFixed(2)}%)</b>`);
}

// /portfolio — la cartera COMPLETA separada por broker: contado con precio
// live, FCI a VCP, futuros (MTM del día, no suman valor: van por margen) y
// cauciones. Total general + P&L del día en $ y %.
async function cmdPortfolio(chatId) {
  const userId = await userByChat(chatId);
  if (!userId) { await sendMessage(chatId, "No estas vinculado. Vincula desde Midas → Configuracion → Notificaciones."); return; }
  const { data: pos } = await supabase.from("positions")
    .select("ticker,broker,instrument_type,operation_type,quantity,entry_price")
    .eq("user_id", userId);
  if (!pos || !pos.length) { await sendMessage(chatId, "Sin posiciones."); return; }
  const d912 = await loadData912();
  const fut = await loadFutures();
  const m0 = (n) => `$${Math.round(Math.abs(n)).toLocaleString("es-AR")}`;
  const sgn = (n) => `${n >= 0 ? "+" : "−"}${m0(n)}`;

  // FCI: último y anteúltimo VCP por fondo (para valor y variación del día).
  const fciNames = [...new Set(pos.filter((p) => p.instrument_type === "fci").map((p) => (p.ticker || "").split("|")[0]))];
  const fciVcp = {};
  for (const name of fciNames) {
    const { data: q } = await supabase.from("fci_quotes").select("fecha,vcp").eq("fondo", name).order("fecha", { ascending: false }).limit(2);
    if (q && q.length) fciVcp[name] = { last: Number(q[0].vcp), prev: q[1] ? Number(q[1].vcp) : null };
  }

  // Agrupar por broker|tipo|ticker (neto + costo de compras).
  const agg = {};
  for (const p of pos) {
    const q = (Number(p.quantity) || 0) * (p.operation_type === "sell" ? -1 : 1);
    const key = `${p.broker || "manual"}|${p.instrument_type}|${p.ticker}`;
    const a = agg[key] || (agg[key] = { broker: p.broker || "manual", type: p.instrument_type, ticker: p.ticker, net: 0, cost: 0 });
    a.net += q;
    if (q > 0) a.cost += q * (Number(p.entry_price) || 0);
  }

  const byBroker = {};
  let grandVal = 0, grandDay = 0;
  for (const a of Object.values(agg)) {
    if (Math.abs(a.net) < 1e-9) continue;
    const B = byBroker[a.broker] || (byBroker[a.broker] = { lines: [], futLines: [], val: 0, day: 0 });
    if (a.type === "future") {
      const cur = fut.price[a.ticker] ?? fut.settle[a.ticker] ?? null;
      const ref = fut.reference[a.ticker] ?? null;
      const day = (cur != null && ref != null) ? (cur - ref) * a.net * 1000 : null;
      if (day != null) { B.day += day; grandDay += day; }
      B.futLines.push(`• ${a.ticker} neto ${a.net > 0 ? "+" : ""}${a.net}: día ${day != null ? sgn(day) : "s/precio"}`);
      continue;
    }
    if (a.type === "caucion") {
      // Caución: capital con signo (colocadora suma, tomadora resta). El interés
      // devengado fino queda para Midas web.
      const cap = a.cost || a.net;
      B.lines.push(`• Caución: ${sgn(cap)}`);
      B.val += cap; grandVal += cap;
      continue;
    }
    if (a.type === "fci") {
      const name = (a.ticker || "").split("|")[0];
      const v = fciVcp[name];
      const val = v ? a.net * v.last : a.cost;
      const day = (v && v.prev) ? a.net * (v.last - v.prev) : 0;
      B.val += val; B.day += day; grandVal += val; grandDay += day;
      B.lines.push(`• ${name.replace(/ - Clase.*/, "")} (FCI): ${m0(val)}${v && v.prev ? ` (${((v.last / v.prev - 1) * 100).toFixed(2)}% día)` : ""}`);
      continue;
    }
    // Contado: cedear/stock/bond/on/letra
    if (a.net <= 0) continue;
    // Letras/bonos ya vencidos: no son tenencia (el cobro está en la caja).
    const mDays = daysToMaturity(maturityOf(a.ticker));
    if (mDays != null && mDays < 0) continue;
    const d = d912[a.ticker];
    const per100 = ["bond_ars", "bond_usd", "on"].includes(a.type) ? 100 : 1;
    if (!d || d.c == null) { B.lines.push(`• ${a.ticker} ×${a.net}: s/precio`); continue; }
    const val = (a.net * d.c) / per100;
    const prev = d.pct != null ? d.c / (1 + d.pct / 100) : null;
    const day = prev != null ? (a.net * (d.c - prev)) / per100 : 0;
    B.val += val; B.day += day; grandVal += val; grandDay += day;
    B.lines.push(`• ${a.ticker} ×${a.net}: ${m0(val)}${d.pct != null ? ` (${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(2)}%)` : ""}`);
  }

  const parts = [`💼 <b>Portfolio</b>`];
  for (const [bk, B] of Object.entries(byBroker).sort()) {
    if (!B.lines.length && !B.futLines.length) continue;
    parts.push(`\n<b>${bk.toUpperCase()}</b>`);
    if (B.lines.length) parts.push(B.lines.join("\n"));
    if (B.futLines.length) parts.push(`<i>Futuros (MTM, van por margen):</i>\n${B.futLines.join("\n")}`);
    parts.push(`Subtotal: <b>${m0(B.val)}</b> · día ${sgn(B.day)}`);
  }
  const dayPct = grandVal > 0 ? (grandDay / grandVal) * 100 : 0;
  parts.push(`\n<b>TOTAL: ${m0(grandVal)}</b>\nDía: <b>${sgn(grandDay)} (${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}%)</b>\n<i>El total no incluye caja ni el nocional de futuros; el día de futuros sí está en el P&L.</i>`);
  await sendMessage(chatId, parts.join("\n"));
}

async function cmdDlr(chatId) {
  const fut = await loadFutures();
  const fronts = frontDlr(fut, 3);
  if (!fronts.length) { await sendMessage(chatId, "💵 <b>Dólar futuro</b>\nSin precios por ahora."); return; }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const cv = curveVar(fut);
  const vmap = {}; for (const c of cv.all) vmap[c.ticker] = c.varPct;
  const lines = fronts.map((c) => {
    const v = vmap[c.ticker];
    const vtxt = v == null ? "" : ` (${v >= 0 ? "+" : ""}${v.toFixed(2)}%)`;
    return `${cap(c.nombre)}: <b>${fut.price[c.ticker]}</b>${vtxt}`;
  });
  const spreads = [];
  for (let i = 0; i + 1 < fronts.length; i++) {
    const pn = fut.price[fronts[i].ticker], pf = fut.price[fronts[i + 1].ticker];
    if (pn != null && pf != null) spreads.push(`${cap(fronts[i].nombre)} → ${cap(fronts[i + 1].nombre)}: <b>+${(pf - pn).toFixed(1)} pesos</b>`);
  }
  // El más desalineado de la curva (entre los del frente), aunque sea por poco.
  let outTxt = "";
  if (cv.median != null) {
    let best = null;
    for (const c of cv.all) {
      if (!fronts.some((f) => f.ticker === c.ticker)) continue;
      const dev = c.varPct - cv.median;
      if (!best || Math.abs(dev) > Math.abs(best.dev)) best = { c, dev };
    }
    if (best && Math.abs(best.dev) >= 0.03) {
      const pesos = ((Math.abs(best.dev) / 100) * best.c.p).toFixed(1);
      outTxt = `\n\n<i>Más desalineado: ${cap(best.c.nombre)} — ${best.dev > 0 ? "caro" : "barato"} ~${pesos} pesos vs la curva (su Var ${best.c.varPct.toFixed(2)}% vs ${cv.median.toFixed(2)}% de mediana).</i>`;
    }
  }
  const body = `💵 <b>Dólar futuro</b>\n${lines.join("\n")}${spreads.length ? `\n\nDiferencia entre meses:\n${spreads.join("\n")}` : ""}${outTxt}${inRueda() ? "" : "\n\n<i>(mercado cerrado — valores de settlement)</i>"}`;
  await sendMessage(chatId, body);
}

async function cmdCanje(chatId) {
  const { data: rows } = await supabase.from("sovereign_mep_canje").select("plazo,spread_pct,comprar_pesos_vender_dolar,vender_dolar_caro").order("spread_pct", { ascending: false }).limit(5);
  if (!rows || !rows.length) { await sendMessage(chatId, "Sin datos de canje ahora."); return; }
  const lines = rows.map((r) => `• ${r.plazo}: ${Number(r.spread_pct).toFixed(2)}% (${r.comprar_pesos_vender_dolar} → ${r.vender_dolar_caro})`).join("\n");
  await sendMessage(chatId, `🔁 <b>Canje MEP soberanos</b> (top spreads):\n${lines}\n<i>Indicativo.</i>`);
}

// Decision-support: mejor bono soberano para comprar/vender USD AHORA, con
// puntas EJECUTABLES (data912 arg_bonds). Comprar USD = comprás el bono en $
// (ask$) y lo vendés en D (bidD) → ask$/bidD, el más bajo. Vender al revés.
const DOLAR_PAIRS = [["AL30", "AL30D"], ["GD30", "GD30D"], ["AL35", "AL35D"], ["GD35", "GD35D"], ["GD38", "GD38D"], ["AE38", "AE38D"], ["AL41", "AL41D"], ["GD41", "GD41D"]];
const CANJE_PUSH_PCT = 0.4; // umbral de alerta: canje real neto del costo BLACK (~0,1% × 4 patas)

// Trae puntas EJECUTABLES (data912 arg_bonds) y calcula el mejor bono para
// comprar/vender USD. Compartido por /dolar y la alerta de canje real.
//   compra (dolarizar) = ask$ / bidD  → el más bajo gana
//   venta  (pesificar) = bid$ / askD  → el más alto gana
async function fetchDolarBonds() {
  let bonds = [];
  try {
    const r = await fetch("https://data912.com/live/arg_bonds", { headers: { "User-Agent": "Midas/0.1" } });
    if (r.ok) bonds = await r.json();
  } catch (e) { console.error("[dolar]", e.message); }
  const bySym = {};
  for (const x of bonds || []) if (x && x.symbol) bySym[x.symbol] = x;
  const rows = [];
  for (const [ars, mep] of DOLAR_PAIRS) {
    const a = bySym[ars], m = bySym[mep];
    if (!a || !m) continue;
    const bidA = Number(a.px_bid), askA = Number(a.px_ask), bidM = Number(m.px_bid), askM = Number(m.px_ask);
    const compra = askA > 0 && bidM > 0 ? askA / bidM : null;
    const venta = bidA > 0 && askM > 0 ? bidA / askM : null;
    if (compra == null && venta == null) continue;
    rows.push({ label: ars, compra, venta });
  }
  const buys = rows.filter((r) => r.compra != null);
  const sells = rows.filter((r) => r.venta != null);
  const bestBuy = buys.length ? buys.reduce((x, y) => (y.compra < x.compra ? y : x)) : null;
  const bestSell = sells.length ? sells.reduce((x, y) => (y.venta > x.venta ? y : x)) : null;
  const arbPct = bestBuy && bestSell ? (bestSell.venta / bestBuy.compra - 1) * 100 : null;
  return { rows, bestBuy, bestSell, arbPct };
}

async function cmdMep(chatId) {
  const { rows, bestBuy, bestSell, arbPct } = await fetchDolarBonds();
  if (!rows.length) { await sendMessage(chatId, "Sin puntas de bonos ahora (¿mercado cerrado?)."); return; }
  const f = (n) => (n == null ? "s/d" : Number(n).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  let msg = "💵 <b>Dólar vía bonos</b> (puntas ejecutables)";
  if (bestBuy) msg += `\n\n🟢 <b>Comprar USD</b>: $${f(bestBuy.compra)} vía <b>${bestBuy.label}</b> (el más barato)`;
  if (bestSell) msg += `\n🔴 <b>Vender USD</b>: $${f(bestSell.venta)} vía <b>${bestSell.label}</b> (el más caro)`;
  if (arbPct != null) {
    msg += arbPct > CANJE_PUSH_PCT
      ? `\n\n⚡ Canje real ${arbPct.toFixed(2)}% (> costo Black ~0,4%). Confirmá puntas.`
      : `\n\nSin canje: ${arbPct.toFixed(2)}% (no cubre el costo Black ~0,4% del rulo).`;
  }
  msg += "\n<i>Comprar = comprás el bono en $ y lo vendés en D; vender al revés. Incluye cruzar puntas.</i>";
  await sendMessage(chatId, msg);
}

// /dolar — cotizaciones de los distintos dólares en tiempo real (dolarapi).
const DOLAR_ORDER = ["oficial", "mayorista", "tarjeta", "bolsa", "contadoconliqui", "blue", "cripto"];
const DOLAR_NOMBRE = { oficial: "Oficial", mayorista: "Mayorista", tarjeta: "Tarjeta", bolsa: "MEP", contadoconliqui: "CCL", blue: "Blue", cripto: "Cripto" };
const DOLAR_EMOJI = { oficial: "🏛", mayorista: "🏦", tarjeta: "💳", bolsa: "📈", contadoconliqui: "🌐", blue: "💙", cripto: "🪙" };
async function cmdDolar(chatId) {
  let data = [];
  try { const r = await fetch("https://dolarapi.com/v1/dolares"); if (r.ok) data = await r.json(); } catch (e) { console.error("[dolar]", e.message); }
  if (!data.length) { await sendMessage(chatId, "Sin cotizaciones de dólar ahora."); return; }
  const fInt = (n) => (n == null ? "—" : Math.round(Number(n)).toLocaleString("es-AR"));
  const byCasa = {}; for (const d of data) byCasa[d.casa] = d;
  const seen = new Set();
  const rows = [];
  for (const k of DOLAR_ORDER) { const d = byCasa[k]; if (!d) continue; seen.add(k); rows.push({ name: DOLAR_NOMBRE[k] || d.nombre, venta: d.venta, compra: d.compra }); }
  for (const d of data) if (!seen.has(d.casa)) rows.push({ name: d.nombre, venta: d.venta, compra: d.compra });
  // Tabla monospace alineada con <code> (no <pre>): mantiene la alineación SIN el
  // botón "copy" que <pre> agrega arriba (que se veía mal en el celu).
  const header = `${"".padEnd(10)}${"venta".padStart(7)}${"compra".padStart(9)}`;
  const body = rows.map((r) => `${r.name.padEnd(10)}${fInt(r.venta).padStart(7)}${(r.compra != null ? fInt(r.compra) : "—").padStart(9)}`).join("\n");
  await sendMessage(chatId, `💵 <b>Dólar — cotizaciones</b>\n<code>${header}\n${body}</code>`);
}

// /futuros — todos los futuros DLR con precio del momento y variación del día.
async function cmdFuturos(chatId) {
  const fut = await loadFutures();
  const cv = curveVar(fut);
  if (!cv.all.length) { await sendMessage(chatId, "Sin precios de futuros ahora."); return; }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // Solo contratos VIVOS (mes en curso en adelante); los vencidos (ej. MAY26) quedan
  // en el feed con last=settle (+0,00%) y son ruido.
  const now = new Date();
  const curOrd = (now.getFullYear() % 100) * 12 + now.getMonth();
  const sorted = cv.all.filter((c) => c.ord >= curOrd).sort((a, b) => a.ord - b.ord);
  if (!sorted.length) { await sendMessage(chatId, "Sin futuros vigentes ahora."); return; }
  const lines = sorted.map((c) => {
    const chg = c.p - c.s; // variación del día en pesos (vs settle anterior)
    return `${cap(c.nombre)}: <b>${c.p}</b>  ${chg >= 0 ? "+" : "−"}${Math.abs(chg).toFixed(1)} (${c.varPct >= 0 ? "+" : ""}${c.varPct.toFixed(2)}%)`;
  });
  await sendMessage(chatId, `📈 <b>Futuros DLR</b> — precio y variación del día\n${lines.join("\n")}${inRueda() ? "" : "\n<i>(mercado cerrado — valores de settlement)</i>"}`);
}

// /rfx — futuros en cartera del usuario (long/short).
async function cmdRfx(chatId) {
  const userId = await userByChat(chatId);
  if (!userId) { await sendMessage(chatId, "No estas vinculado. Vincula desde Midas → Configuracion → Notificaciones."); return; }
  const positionsBy = await loadPositionsRaw([userId]);
  const raw = positionsBy[userId] || [];
  const fut = await loadFutures();
  const net = {};
  for (const p of raw) {
    if (p.instrument_type !== "future" || !p.ticker) continue;
    net[p.ticker] = (net[p.ticker] || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
  }
  const tickers = Object.keys(net).filter((t) => Math.abs(net[t]) >= 1e-6).sort();
  if (!tickers.length) { await sendMessage(chatId, "📈 <b>Futuros en cartera (ROFEX)</b>\nNo tenés futuros abiertos."); return; }
  const lines = tickers.map((t) => {
    const n = net[t];
    const px = fut.price[t];
    return `${t}: <b>${n > 0 ? "LONG" : "SHORT"} ${Math.abs(n)}</b>${px != null ? ` · últ ${px}` : ""}`;
  });
  await sendMessage(chatId, `📈 <b>Futuros en cartera (ROFEX)</b>\n${lines.join("\n")}\n<i>Long = comprado / Short = vendido. Cantidad en contratos.</i>`);
}

/* ─────────────── Linking + comandos ─────────────── */

let offset = 0;
async function handleUpdate(u) {
  offset = Math.max(offset, u.update_id + 1);
  const msg = u.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const username = msg.from && msg.from.username ? msg.from.username : null;

  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (!code) {
      await sendMessage(chatId, "Hola, soy <b>Midas Alertas</b>.\n\nVincula tu cuenta desde Midas → <b>Configuracion → Notificaciones</b> → <b>Conectar Telegram</b>.\n\nComandos: /pnl (resumen), /dlr (dolar futuro), /dolar (mejor bono USD), /canje (desarbitrajes), /stop (pausar).");
      return;
    }
    const nowIso = new Date().toISOString();
    const { data: link } = await supabase.from("telegram_links").select("user_id")
      .eq("link_code", code).gt("link_code_expires_at", nowIso).maybeSingle();
    if (!link) { await sendMessage(chatId, "Ese codigo es invalido o vencio. Genera uno nuevo desde Midas → Configuracion → Notificaciones."); return; }
    await supabase.from("telegram_links").update({
      chat_id: String(chatId), tg_username: username, linked_at: nowIso,
      link_code: null, link_code_expires_at: null, enabled: true, updated_at: nowIso,
    }).eq("user_id", link.user_id);
    await sendMessage(chatId, "✅ <b>Vinculado.</b> Vas a recibir las notificaciones que elijas en Midas. Probá /pnl o /dlr. Para pausar, /stop.");
    console.log(`[link] user ${link.user_id} -> chat ${chatId}`);
    return;
  }
  if (text.startsWith("/stop")) {
    await supabase.from("telegram_links").update({ enabled: false, updated_at: new Date().toISOString() }).eq("chat_id", String(chatId));
    await sendMessage(chatId, "Notificaciones pausadas. Reactivalas desde Midas → Configuracion → Notificaciones.");
    return;
  }
  if (text.startsWith("/pnl") || text.startsWith("/resumen")) { await cmdPnl(chatId); return; }
  if (text.startsWith("/momentum") || text.startsWith("/cartera")) { await cmdMomentum(chatId); return; }
  if (text.startsWith("/portfolio")) { await cmdPortfolio(chatId); return; }
  if (text.startsWith("/futuros")) { await cmdFuturos(chatId); return; }
  if (text.startsWith("/rfx")) { await cmdRfx(chatId); return; }
  if (text.startsWith("/dlr")) { await cmdDlr(chatId); return; }
  if (text.startsWith("/canje")) { await cmdCanje(chatId); return; }
  if (text.startsWith("/mep")) { await cmdMep(chatId); return; }
  if (text.startsWith("/dolar") || text.startsWith("/dólar")) { await cmdDolar(chatId); return; }
  if (text.startsWith("/ping")) { await sendMessage(chatId, "pong"); return; }
  if (text.startsWith("/help")) {
    await sendMessage(chatId, "Comandos:\n/pnl — resumen del dia (todo)\n/portfolio — cartera completa por broker con total y % del dia\n/momentum — cartera momentum IOL: valor y resultado\n/futuros — todos los futuros DLR: precio y variacion del dia\n/rfx — tus futuros en cartera (long/short)\n/dolar — cotizaciones de los distintos dolares\n/dlr — dolar futuro del frente + spread\n/mep — mejor bono para comprar/vender USD\n/canje — desarbitrajes MEP\n/stop — pausar\n/start &lt;codigo&gt; — vincular\n\nLa activacion y preferencias se manejan en Midas → Configuracion → Notificaciones.");
    return;
  }
}

async function pollLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const r = await fetch(`${API}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}`);
      const j = await r.json();
      if (j.ok && Array.isArray(j.result))
        for (const u of j.result) { try { await handleUpdate(u); } catch (e) { console.error("[handleUpdate]", e.message); } }
    } catch (e) {
      console.error("[pollLoop]", e.message);
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

/* ─────────────── Arranque ─────────────── */
// Solo levanta los loops si se ejecuta directo (no si lo importa un diag/test,
// para no abrir un segundo getUpdates que chocaria con la instancia PM2).
if (require.main === module) {
  console.log("[telegram-notifier] arrancando. alert interval", ALERT_INTERVAL_MS / 1000, "s");
  pollLoop();
  alertLoop();
  setInterval(alertLoop, ALERT_INTERVAL_MS);
}

module.exports = { buildEodSummary, buildFuturesSummary, futuresSettledToday, loadPositions, loadPositionsRaw, loadFutures, loadData912, buildScalpingSignals, frontDlr, curveVar, supabase };
