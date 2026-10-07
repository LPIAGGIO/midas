"use strict";
/* ─────────────────────────────────────────────────────────────────────────
 * caucion-tomadora — cubre con caución a 1 día el descubierto en pesos que
 * dejan las grillas de scalp en las dos cuentas de Cocos (LP, 06/10/2026:
 * "un bot para toma de caución, que chequee siempre; si ve que cae fuerte
 * que tome, si no que tome a un precio lógico antes de las 16:30"; el
 * descubierto sin cubrir es lo que el broker no tolera).
 *
 * Cada minuto, en rueda, por cuenta:
 *   descubierto = −(saldo contado en pesos según Cocos) + AJUSTE_APP (la app
 *                 muestra ~400k más negativo que la API: comisiones del día)
 *   cubierto    = cauciones tomadoras de HOY (órdenes BUY sobre PESOS - 1D:
 *                 ejecutadas + vivas), incluidas las que cargue LP a mano
 *   faltante    = descubierto + BUFFER − cubierto, redondeado a 10.000
 * y decide:
 *   - OPORTUNA: desde HORA_OPORTUNA, si la mejor punta colocadora (la tasa a
 *     la que se puede tomar ya) está en o debajo de UMBRAL → toma el faltante.
 *   - LÍMITE: desde HORA_LIMITE toma el faltante a la mejor punta, sí o sí
 *     (si la tasa supera TOPE avisa, pero toma igual: el descubierto sin
 *     cubrir sale más caro).
 * La orden se manda LIMIT al precio de la mejor punta colocadora; si en 3
 * minutos no se ejecutó, se cancela y se manda de nuevo a la punta del
 * momento (hasta 4 veces). Nunca toma si el saldo contado es positivo ni
 * más de MAX_DIA por cuenta por día. Archivo STOP = no manda nada.
 *
 * Modos: `node worker.js --chequeo` (muestra todo, no manda) · CAUCION_REAL=1
 * en .env para mandar órdenes de verdad (lo prende LP) · sin esa variable,
 * simula. Credenciales: las de cocos-bot (72404) y cocos-cuenta2 (3893);
 * Telegram y Supabase salen del .env de cocos-bot.
 * ───────────────────────────────────────────────────────────────────────── */
const fs = require("fs");
const path = require("path");
const MODS = path.join(__dirname, "..", "cocos-bot", "node_modules");
const WebSocket = require(path.join(MODS, "ws"));
const { createClient } = require(path.join(MODS, "@supabase/supabase-js"));

function leerEnv(ruta) {
  const o = {};
  if (!fs.existsSync(ruta)) return o;
  for (const l of fs.readFileSync(ruta, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); }
  return o;
}
const PROPIO = leerEnv(path.join(__dirname, ".env"));
const BASE_ENV = leerEnv(path.join(__dirname, "..", "cocos-bot", ".env"));
const b64 = (o, k) => (o[k] ? Buffer.from(o[k], "base64").toString("utf8") : null);
const CUENTAS = [
  { nombre: "72404", env: BASE_ENV },
  { nombre: "3893", env: leerEnv(path.join(__dirname, "..", "cocos-cuenta2", ".env")) },
].map((c) => ({ nombre: c.env.COCOS_CUENTA || c.nombre, user: b64(c.env, "COCOS_API_USER_B64"), pass: b64(c.env, "COCOS_API_PASS_B64"), tok: null, tokAt: 0, hoy: null, tomado: 0, ultAviso: 0 }));

const REAL = PROPIO.CAUCION_REAL === "1";
const CHEQUEO = process.argv.includes("--chequeo");
const UMBRAL = Number(PROPIO.CAUCION_UMBRAL || 17);            // TNA: a esta tasa o menos, toma antes
const TOPE = Number(PROPIO.CAUCION_TOPE || 35);                // arriba de esto avisa (pero toma igual en la hora límite)
const HORA_OPORTUNA = Number(PROPIO.CAUCION_HORA_OPORTUNA || 1200);
const HORA_LIMITE = Number(PROPIO.CAUCION_HORA_LIMITE || 1612);
const HORA_FIN = Number(PROPIO.CAUCION_HORA_FIN || 1628);
// Margen sobre el descubierto. Las grillas operan a 24 hs: no mueven el contado del día, así que alcanza con 0.
const BUFFER = Number(PROPIO.CAUCION_BUFFER_ARS || 0);
const AJUSTE_APP = Number(PROPIO.CAUCION_AJUSTE_APP_ARS || 0);       // 07/10: la app y la API dan el mismo contado
const MAX_DIA = Number(PROPIO.CAUCION_MAX_DIA_ARS || 150_000_000);
const MINIMO = 100_000;                                         // lote mínimo del instrumento
const SIMBOLO = "MERV - XMEV - PESOS - 1D";
const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const BASE = "https://api.cocos.xoms.com.ar";

const log = (...a) => console.log(`[${new Date().toISOString()}] [caucion]`, ...a);
const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const hhmmAr = () => { const s = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }); return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5)); };
const diaAr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5; };
const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

async function token(c, forzar = false) {
  if (c.tok && !forzar && Date.now() - c.tokAt < 20 * 60_000) return c.tok;
  const r = await fetch(`${BASE}/auth/getToken`, { method: "POST", headers: { "X-Username": c.user, "X-Password": c.pass }, redirect: "manual" });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) throw new Error(`login Primary rechazado (HTTP ${r.status})`);
  c.tok = t; c.tokAt = Date.now();
  return t;
}
async function api(c, ruta, reintento = true) {
  const t = await token(c);
  const r = await fetch(`${BASE}${ruta}`, { headers: { "X-Auth-Token": t }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if ((r.status === 401 || r.status === 302) && reintento) { await token(c, true); return api(c, ruta, false); }
  if (r.status === 429 && reintento && !/newSingleOrder/.test(ruta)) { await dormir(4000); return api(c, ruta, false); }
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* no json */ }
  if (r.status !== 200) throw new Error(`${ruta.split("?")[0]}: HTTP ${r.status} ${txt.slice(0, 160)}`);
  if (j?.status && j.status !== "OK") { const e = new Error(`${ruta.split("?")[0]}: ${j.status} ${j.message || j.description || ""}`.trim()); e.rechazo = true; throw e; }
  return j;
}

let _chat = null;
async function tg(texto) {
  if (!REAL || !BASE_ENV.TELEGRAM_BOT_TOKEN || !BASE_ENV.SUPABASE_URL) return;
  try {
    if (!_chat) {
      const sb = createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
      const { data } = await sb.from("telegram_links").select("chat_id").eq("user_id", USER_ID).eq("enabled", true).maybeSingle();
      _chat = data?.chat_id || null;
    }
    if (_chat) await fetch(`https://api.telegram.org/bot${BASE_ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: _chat, text: texto, parse_mode: "HTML" }) });
  } catch (e) { log(`telegram: ${e.message}`); }
}

/* ───────── lecturas ───────── */
async function saldoContado(c) {
  const j = await api(c, `/rest/risk/accountReport/${c.nombre}`);
  const ci = j?.accountData?.detailedAccountReports?.["0"];
  const ars = ci?.availableToOperate?.cash?.detailedCash?.ARS;
  if (ars == null) throw new Error("sin saldo contado en el informe de cuenta");
  return Number(ars);
}
// Cauciones tomadoras de hoy: ejecutadas (cumQty) + vivas (leavesQty), las del bot y las de LP.
async function caucionesHoy(c) {
  const j = await api(c, `/rest/order/all?accountId=${c.nombre}`);
  const hoy = diaAr().replace(/-/g, "");
  let ejec = 0, vivas = 0; const detalle = [];
  for (const o of j?.orders || []) {
    if (o.instrumentId?.symbol !== SIMBOLO || o.side !== "BUY" || !String(o.transactTime || "").startsWith(hoy)) continue;
    const cum = Number(o.cumQty) || 0, st = String(o.status || "").toUpperCase();
    ejec += cum;
    if (["NEW", "PENDING_NEW", "PARTIALLY_FILLED"].includes(st)) vivas += Number(o.leavesQty) || 0;
    detalle.push(`${Math.round(Number(o.orderQty)).toLocaleString("es-AR")} @${o.price} ${st}${cum ? " ejec " + Math.round(cum).toLocaleString("es-AR") : ""}`);
  }
  return { ejec, vivas, detalle };
}
async function libro(c) {
  const j = await api(c, `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: SIMBOLO, entries: "BI,OF,LA", depth: 1 })}`);
  const md = j?.marketData || {};
  return { tomadores: md.BI?.[0]?.price ?? null, colocadores: md.OF?.[0]?.price ?? null, ultimo: md.LA?.price ?? null };
}

/* ───────── orden ───────── */
async function tomar(c, monto, tasa, motivo) {
  monto = Math.max(MINIMO, Math.ceil(monto / 10_000) * 10_000);
  if (c.tomado + monto > MAX_DIA) { log(`${c.nombre}: ${pesos(monto)} superaría el máximo diario ${pesos(MAX_DIA)}; no tomo`); await tg(`<b>CAUCIÓN ${c.nombre}</b>\nNo tomo ${pesos(monto)}: superaría el máximo diario. Revisar.`); return false; }
  if (!REAL) { log(`${c.nombre}: SIMULADO tomaría ${pesos(monto)} al ${tasa}% (${motivo})`); c.tomado += monto; return true; }
  for (let intento = 1; intento <= 4; intento++) {
    const px = Math.round(tasa * 10) / 10;
    let id;
    try {
      const j = await api(c, `/rest/order/newSingleOrder?${q({ marketId: "ROFX", symbol: SIMBOLO, price: px, orderQty: monto, ordType: "LIMIT", side: "BUY", timeInForce: "DAY", account: c.nombre, cancelPrevious: false, iceberg: false })}`);
      id = j?.order; if (!id?.clientId) throw new Error(`sin clientId: ${JSON.stringify(j).slice(0, 150)}`);
    } catch (e) { log(`${c.nombre}: ERROR al mandar la caución ${pesos(monto)} al ${px}%: ${e.message}`); await tg(`<b>CAUCIÓN ${c.nombre}</b>\nERROR al mandar ${pesos(monto)} al ${px}%: ${e.message}`); return false; }
    log(`${c.nombre}: caución mandada ${pesos(monto)} al ${px}% (${motivo}), intento ${intento}`);
    for (let i = 0; i < 18; i++) {                                   // hasta 3 minutos
      await dormir(10_000);
      const o = (await api(c, `/rest/order/id?${q({ clOrdId: id.clientId, proprietary: id.proprietary || "" })}`).catch(() => null))?.order;
      const st = String(o?.status || "").toUpperCase();
      if (st === "FILLED") { c.tomado += monto; log(`${c.nombre}: caución EJECUTADA ${pesos(monto)} al ${o.avgPx || px}%`); await tg(`<b>CAUCIÓN ${c.nombre}</b>\nTomada: ${pesos(monto)} a 1 día al ${o.avgPx || px}% (${motivo}).`); return true; }
      if (st === "REJECTED") { log(`${c.nombre}: caución RECHAZADA: ${o?.text || ""}`); await tg(`<b>CAUCIÓN ${c.nombre}</b>\nRechazada ${pesos(monto)} al ${px}%: ${o?.text || ""}. Revisar.`); return false; }
    }
    // no se ejecutó: cancelo y voy a la punta nueva
    await api(c, `/rest/order/cancelById?${q({ clOrdId: id.clientId, proprietary: id.proprietary || "" })}`).catch((e) => log(`cancelar: ${e.message}`));
    await dormir(3000);
    const o = (await api(c, `/rest/order/id?${q({ clOrdId: id.clientId, proprietary: id.proprietary || "" })}`).catch(() => null))?.order;
    const cum = Number(o?.cumQty) || 0;
    if (cum > 0) { c.tomado += cum; monto -= cum; log(`${c.nombre}: ejecutó parcial ${pesos(cum)}; faltan ${pesos(monto)}`); if (monto < MINIMO) return true; }
    const l = await libro(c);
    if (l.colocadores == null) { log(`${c.nombre}: sin punta colocadora; reintento en el próximo ciclo`); return false; }
    tasa = l.colocadores + 0.1;
  }
  await tg(`<b>CAUCIÓN ${c.nombre}</b>\nNo pude ejecutar la caución en 4 intentos. Revisar a mano.`);
  return false;
}

/* ───────── ciclo ───────── */
async function cuenta(c) {
  const hm = hhmmAr();
  const saldo = await saldoContado(c);
  const cau = await caucionesHoy(c);
  const descubierto = Math.max(0, -saldo + AJUSTE_APP);
  const cubierto = cau.ejec + cau.vivas + (REAL ? 0 : c.tomado);   // en simulado no hay orden que leer
  const faltante = Math.ceil(Math.max(0, descubierto + BUFFER - cubierto) / 10_000) * 10_000;
  const l = await libro(c);
  const linea = `${c.nombre}: contado ${pesos(saldo)} · descubierto ${pesos(descubierto)} · cubierto ${pesos(cubierto)}${cau.detalle.length ? " (" + cau.detalle.join(" | ") + ")" : ""} · falta ${pesos(faltante)} · caución 1D: tomadores ${l.tomadores ?? "—"} / colocadores ${l.colocadores ?? "—"} / último ${l.ultimo ?? "—"}`;
  if (CHEQUEO) { log(linea); return; }
  if (Date.now() - c.ultAviso > 15 * 60_000) { log(linea); c.ultAviso = Date.now(); }
  if (faltante < MINIMO) return;
  if (fs.existsSync(path.join(__dirname, "STOP"))) return;
  if (l.colocadores == null) { if (hm >= HORA_LIMITE) log(`${c.nombre}: falta ${pesos(faltante)} y no hay punta colocadora`); return; }
  const tasa = l.colocadores;
  if (hm >= HORA_LIMITE) {
    if (tasa > TOPE) await tg(`<b>CAUCIÓN ${c.nombre}</b>\nLa tasa está en ${tasa}% (tope ${TOPE}%). Tomo igual ${pesos(faltante)} para no quedar en descubierto.`);
    await tomar(c, faltante, tasa, `hora límite, tasa ${tasa}%`);
  } else if (hm >= HORA_OPORTUNA && tasa <= UMBRAL) {
    await tomar(c, faltante, tasa, `tasa baja ${tasa}% ≤ ${UMBRAL}%`);
  }
}

async function main() {
  for (const c of CUENTAS) if (!c.user || !c.pass) { console.error(`faltan credenciales de la cuenta ${c.nombre}`); process.exit(1); }
  log(`${REAL ? "*** ÓRDENES REALES ***" : "SIMULADO"} · cuentas ${CUENTAS.map((c) => c.nombre).join(", ")} · toma antes si la tasa ≤ ${UMBRAL}% desde las ${HORA_OPORTUNA} · sí o sí desde las ${HORA_LIMITE} hasta las ${HORA_FIN} · buffer ${pesos(BUFFER)} · ajuste app ${pesos(AJUSTE_APP)} · máximo diario ${pesos(MAX_DIA)}`);
  if (CHEQUEO) { for (const c of CUENTAS) await cuenta(c).catch((e) => log(`${c.nombre}: ${e.message}`)); process.exit(0); }
  for (;;) {
    const hm = hhmmAr();
    for (const c of CUENTAS) { if (c.hoy !== diaAr()) { c.hoy = diaAr(); c.tomado = 0; } }
    if (esHabil() && hm >= 1045 && hm < HORA_FIN) {
      for (const c of CUENTAS) await cuenta(c).catch((e) => log(`${c.nombre}: ${e.message}`));
      await dormir(60_000);
    } else await dormir(5 * 60_000);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
