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
const CAL_BAND = [25, 31];      // spread calendario JUL-JUN
const Z_THRESHOLD = 2;          // reversion z-score sobre JUN26
const Z_BUF_MAX = 40, Z_BUF_MIN = 20;
const DESARB_SPREAD_PCT = 1.5;  // umbral spread del canje (alto: el cross-bond real es ~0, el resto es ruido de precios stale)
const VENC_DAYS = 7;            // avisar si vence en <= N dias
const EOD_DEFAULT_HOUR = 18;    // hora ART del resumen de cierre

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
// Dias hasta vencimiento (T+1, igual que el front). null si no hay fecha.
function daysToMaturity(maturityDate) {
  if (!maturityDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const exp = new Date(maturityDate + "T00:00:00");
  return Math.max(0, Math.round((exp - today) / 86400000) - 1);
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

// Devuelve { price: {app:precio}, settle: {app:settlement} } de mtr_market_data.
async function loadFutures() {
  const { data, error } = await supabase.from("mtr_market_data").select("*");
  if (error) { console.error("[futures]", error.message); return { price: {}, settle: {} }; }
  const nowMs = Date.now(), price = {}, settle = {};
  for (const row of data || []) {
    const app = symbolToApp(row.symbol);
    const p = futurePrice(row, nowMs);
    if (p != null) price[app] = p;
    if (row.settlement != null) settle[app] = Number(row.settlement);
  }
  return { price, settle };
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
  const { data: alerts } = await supabase.from("price_alerts")
    .select("id,user_id,ticker,price,dir").is("triggered_at", null).in("user_id", ids);
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
const zbuf = [];
function buildScalpingSignals(fut) {
  const jun = fut.price["DLRJUN26"], jul = fut.price["DLRJUL26"];
  const sigs = [];
  if (jun != null && jul != null) {
    const cal = jul - jun;
    if (cal < CAL_BAND[0]) sigs.push({ key: "cal_low", text: `📐 Spread calendario JUL-JUN comprimido: <b>${cal.toFixed(1)}</b> (banda ${CAL_BAND[0]}-${CAL_BAND[1]}).` });
    else if (cal > CAL_BAND[1]) sigs.push({ key: "cal_high", text: `📐 Spread calendario JUL-JUN ancho: <b>${cal.toFixed(1)}</b> (banda ${CAL_BAND[0]}-${CAL_BAND[1]}).` });
  }
  if (jun != null) {
    zbuf.push(jun);
    while (zbuf.length > Z_BUF_MAX) zbuf.shift();
    if (zbuf.length >= Z_BUF_MIN) {
      const mean = zbuf.reduce((a, b) => a + b, 0) / zbuf.length;
      const sd = Math.sqrt(zbuf.reduce((a, b) => a + (b - mean) ** 2, 0) / zbuf.length);
      if (sd > 0) {
        const z = (jun - mean) / sd;
        if (Math.abs(z) >= Z_THRESHOLD)
          sigs.push({ key: z > 0 ? "z_high" : "z_low", text: `🔄 Reversion JUN26: z=<b>${z.toFixed(2)}</b> (precio ${jun} vs media ${mean.toFixed(1)}). ${z > 0 ? "Estirado arriba" : "Estirado abajo"}.` });
      }
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
      await sendMessage(u.chatId, `${s.text}\n<i>Senal estructural EN VALIDACION — candidata, no es orden.</i>`);
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
      if (days == null || days > VENC_DAYS) continue;
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
  let subtotal = 0, realizedSum = 0; const fl = [];
  for (const [ticker, lotes] of Object.entries(byTicker)) {
    const net = lotes.reduce((s, p) => s + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0), 0);
    const tradedToday = lotes.some((p) => p.entry_date === dateStr);
    // Saltear futuros vencidos/cerrados (neto 0) sin actividad hoy (ABR26/MAY26).
    if (Math.abs(net) < 1e-6 && !tradedToday) continue;
    const sToday = fut.settle[ticker], sYest = yest[ticker];
    if (sToday == null || sYest == null) {
      if (Math.abs(net) < 1e-6) continue;
      fl.push(`• ${ticker} (${net > 0 ? "+" : ""}${net}): s/settle`); continue;
    }
    const { dayPnl, realizedToday } = futuresTickerDay(lotes, sToday, sYest, dateStr);
    subtotal += dayPnl; realizedSum += realizedToday;
    const realTxt = Math.abs(realizedToday) > 1 ? ` · realiz. aprox ${money(realizedToday)}` : "";
    const ctx = tradedToday ? `  (incl. intradía)` : `  (${sYest}→${sToday})`;
    fl.push(`• ${ticker} (neto ${net > 0 ? "+" : ""}${net}): ${money(dayPnl)}${ctx}${realTxt}`);
  }
  if (!fl.length) return null;
  const realLine = Math.abs(realizedSum) > 1 ? `\n  ↳ de eso, realizado hoy (cerrado, aprox): <b>${money(realizedSum)}</b>` : "";
  const block = `<b>Futuros DLR — P&L del dia</b>\n${fl.join("\n")}\nSubtotal: <b>${money(subtotal)}</b>${realLine}`;
  return { block, subtotal, realizedSum };
}

// Aviso de CIERRE DE FUTUROS (15hs): solo el bloque de futuros. null si el user
// no tiene futuros con algo para mostrar.
async function buildFuturesSummary(userId, rawBy, fut) {
  const { dateStr } = artParts();
  const raw = rawBy[userId] || [];
  const money = (n) => `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("es-AR")}`;
  const futRes = await futuresDayBlock(raw, fut, dateStr, money);
  if (!futRes) return null;
  return `📊 <b>Cierre de futuros ${dateStr}</b>\n\n${futRes.block}\n<i>Ajuste de cierre de hoy vs ayer (como Matriz). El "realizado" es aprox (costo prom).</i>`;
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

  lines.push(`\n<b>TOTAL del dia: ${money(grand)}</b>`);
  lines.push(`<i>Futuros settle-based (como Cocos); el P&L del dia YA incluye lo cerrado. El "realizado" es aprox (costo prom), puede diferir del detalle FIFO de la app. Tenencias por variacion data912. FCI no incluidos.</i>`);
  return lines.join("\n");
}

async function evalEodScheduled(users) {
  const subs = users.filter((u) => prefOn(u.prefs, "eod_summary", false));
  if (!subs.length) return;
  const p = artParts();
  if (!isBizDay(p.dow)) return;
  const positionsBy = await loadPositionsRaw(subs.map((u) => u.userId));
  const fut = await loadFutures();
  for (const u of subs) {
    const hour = Number((u.prefs || {}).eod_hour) || EOD_DEFAULT_HOUR;
    if (p.hour !== hour) continue;
    if (await recentlySent(u.userId, "eod", p.dateStr, 23 * 60 * 60 * 1000)) continue;
    const txt = await buildEodSummary(u.userId, positionsBy, fut);
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

/* ─────────────── Loop principal de alertas ─────────────── */

async function alertLoop() {
  try {
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
  } catch (e) {
    console.error("[alertLoop]", e.message);
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

async function cmdDlr(chatId) {
  const fut = await loadFutures();
  const jun = fut.price["DLRJUN26"], jul = fut.price["DLRJUL26"];
  const cal = jun != null && jul != null ? (jul - jun).toFixed(1) : "s/d";
  await sendMessage(chatId, `💵 <b>DLR</b>\nJUN26: ${jun ?? "s/d"}\nJUL26: ${jul ?? "s/d"}\nSpread calendario JUL-JUN: <b>${cal}</b>${inRueda() ? "" : "\n<i>(mercado cerrado — settlement)</i>"}`);
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

async function cmdDolar(chatId) {
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
  if (text.startsWith("/dlr")) { await cmdDlr(chatId); return; }
  if (text.startsWith("/canje")) { await cmdCanje(chatId); return; }
  if (text.startsWith("/dolar") || text.startsWith("/dólar") || text.startsWith("/mep")) { await cmdDolar(chatId); return; }
  if (text.startsWith("/ping")) { await sendMessage(chatId, "pong"); return; }
  if (text.startsWith("/help")) {
    await sendMessage(chatId, "Comandos:\n/pnl — resumen de cierre\n/dlr — dolar futuro + spread\n/dolar — mejor bono para comprar/vender USD\n/canje — desarbitrajes MEP\n/stop — pausar\n/start &lt;codigo&gt; — vincular\n\nLa activacion y preferencias se manejan en Midas → Configuracion → Notificaciones.");
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

module.exports = { buildEodSummary, buildFuturesSummary, futuresSettledToday, loadPositions, loadPositionsRaw, loadFutures, loadData912, supabase };
