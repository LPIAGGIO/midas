/**
 * cocos-sync / operaciones: carga en Midas las operaciones EJECUTADAS hoy en
 * la cuenta de Cocos (API de Primary), como "puentes del día" — lo mismo que
 * hace el importador del ReporteOperaciones de Matriz (extra.source =
 * 'csv_matriz'): la posición entra con su caja (trigger trg_cash_from_import)
 * y se retira sola cuando el extracto de la comitente cubre esa fecha.
 *
 * POR QUE (LP 30/09/2026): vendió OKLO en Matriz y Midas no se enteró hasta
 * que subiera un archivo. Además el bot de Cocos opera en esa cuenta y sus
 * operaciones tienen que verse en la cartera. El extracto sigue mandando:
 * esto es solo el puente del día.
 *
 * QUE CARGA: CEDEARs y acciones de BYMA ("MERV - XMEV - TICKER - plazo") y,
 * desde el 01/10/2026, FUTUROS de ROFEX (DLR/ORO/WTI; LP: "que actualice las
 * cosas que se operan en Matriz"). Bonos, cauciones y opciones NO: siguen
 * entrando por el extracto.
 *
 * FUTUROS: en ROFEX cada orden tiene su propio orderId y su propio acumulado
 * (no hay cadenas con prefijo). Una orden se carga apenas tiene algo
 * ejecutado y, si después ejecuta más, se ACTUALIZA la misma fila (se busca
 * por matriz_order_id). Operar un futuro no mueve caja (el trigger
 * trg_cash_from_import los saltea): su caja son los ajustes diarios.
 *
 * Una orden modificada en Matriz genera varias órdenes con el mismo prefijo
 * de orderId y cantidad ejecutada ACUMULADA: se toma una fila por cadena
 * (la de mayor acumulado). Solo cadenas terminadas (sin órdenes vivas), así
 * la cantidad y la caja no quedan a medias. Dedup por cadena y por clOrdId.
 *
 * SOLO LECTURA en Primary. Escribe en positions de LP.
 *   node operaciones.js --dry-run
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const BASE = "https://api.cocos.xoms.com.ar";
const CUENTA = process.env.COCOS_CUENTA || "72404";
const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661"; // LP
const DRY = process.argv.includes("--dry-run");
const UA = { "User-Agent": "Mozilla/5.0" };
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const hoyArt = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);

function leerEnv() {
  const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  const raw = (k) => { const m = txt.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim() : null; };
  const b64 = (k) => { const v = raw(k); return v ? Buffer.from(v, "base64").toString("utf8") : null; };
  return { user: b64("COCOS_API_USER_B64"), pass: b64("COCOS_API_PASS_B64"), sbUrl: raw("SUPABASE_URL"), sbKey: raw("SUPABASE_SERVICE_ROLE_KEY") };
}
async function token(env) {
  const r = await fetch(`${BASE}/auth/getToken`, { method: "POST", headers: { "X-Username": env.user, "X-Password": env.pass }, redirect: "manual" });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) throw new Error(`login rechazado (HTTP ${r.status})`);
  return t;
}
async function simbolos(url) {
  try { const r = await fetch(url, { headers: UA }); const a = await r.json(); return new Set((a || []).map((x) => String(x.symbol || "").toUpperCase())); }
  catch { return null; }
}
const VIVA = /NEW|PENDING|PARTIALLY_FILLED/i;

async function main() {
  const env = leerEnv();
  const t = await token(env);
  const r = await fetch(`${BASE}/rest/order/all?accountId=${CUENTA}`, { headers: { "X-Auth-Token": t } });
  if (r.status !== 200) throw new Error(`order/all: HTTP ${r.status}`);
  const j = await r.json();
  const hoy = hoyArt(), hoyCompacto = hoy.replace(/-/g, "");
  // Cadenas: órdenes BYMA de hoy agrupadas por prefijo de orderId.
  const cadenas = new Map();
  for (const o of j.orders || []) {
    const sym = o.instrumentId?.symbol || "";
    const m = /^MERV - XMEV - ([A-Z0-9.]+) - (24hs|CI|48hs)$/i.exec(sym);
    if (!m) continue;
    if (!String(o.transactTime || "").startsWith(hoyCompacto)) continue;
    const pref = String(o.orderId || "").split("-")[0];
    if (!pref || pref === "NONE") continue;
    const clave = `${pref}|${o.side}|${sym}`;
    const c = cadenas.get(clave) || { pref, side: o.side, ticker: m[1].toUpperCase(), plazo: m[2], ordenes: [] };
    c.ordenes.push(o);
    cadenas.set(clave, c);
  }
  const [ced, acc] = await Promise.all([simbolos("https://data912.com/live/arg_cedears"), simbolos("https://data912.com/live/arg_stocks")]);
  // Sin feed no se cargan CEDEARs ni acciones a ciegas, pero los futuros no
  // dependen de esa clasificación y se cargan igual.
  const sinFeed = !ced || !acc;
  if (sinFeed) log("sin feed para clasificar CEDEAR / acción: salteo BYMA en esta corrida");

  const sb = createClient(env.sbUrl, env.sbKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });
  const { data: existentes, error: e0 } = await sb.from("positions").select("id,extra,quantity,entry_price").eq("user_id", USER_ID).eq("broker", "cocos").eq("entry_date", hoy);
  if (e0) throw new Error(`positions: ${e0.message}`);
  const yaCadena = new Set(), yaCl = new Set();
  for (const p of existentes || []) { if (p.extra?.matriz_chain) yaCadena.add(p.extra.matriz_chain); if (p.extra?.matriz_cl_ord_id) yaCl.add(p.extra.matriz_cl_ord_id); if (p.extra?.matriz_order_id) yaCadena.add(String(p.extra.matriz_order_id).split("-")[0]); }

  let nuevas = 0;
  for (const c of sinFeed ? [] : cadenas.values()) {
    const top = c.ordenes.reduce((a, o) => ((Number(o.cumQty) || 0) > (Number(a.cumQty) || 0) ? o : a), c.ordenes[0]);
    const qty = Number(top.cumQty) || 0;
    if (qty <= 0) continue;                                   // nada ejecutado
    if (c.ordenes.some((o) => VIVA.test(o.status || ""))) { log(`${c.ticker} ${c.side}: cadena con orden viva, espero`); continue; }
    if (yaCadena.has(c.pref) || c.ordenes.some((o) => yaCl.has(o.clOrdId))) continue; // ya cargada
    const tipo = ced.has(c.ticker) ? "cedear" : acc.has(c.ticker) ? "stock" : null;
    if (!tipo) { log(`${c.ticker}: no es CEDEAR ni acción (v1 no lo carga; entra por el extracto)`); continue; }
    const px = Number(top.avgPx);
    if (!(px > 0)) { log(`${c.ticker}: sin precio promedio, no cargo`); continue; }
    const fila = {
      user_id: USER_ID, instrument_type: tipo, operation_type: c.side === "SELL" ? "sell" : "buy",
      ticker: c.ticker, quantity: qty, entry_price: Math.round(px * 10000) / 10000, entry_currency: "ARS",
      entry_date: hoy, settlement: /24hs/i.test(c.plazo) ? "T1" : /48hs/i.test(c.plazo) ? "T2" : "T0", broker: "cocos", notes: null,
      extra: { source: "csv_matriz", matriz_account: CUENTA, matriz_order_id: top.orderId, matriz_cl_ord_id: top.clOrdId, matriz_chain: c.pref, via: "api_primary", origen: top.originatingUsername === "ISV_PBCP" ? "bot" : "matriz" },   // ISV_PBCP = la API (el bot); ISV_MATRIZ4 o el numero de usuario = LP desde Matriz
    };
    log(`${DRY ? "(dry) " : ""}cargo ${fila.operation_type} ${qty} ${c.ticker} @ ${fila.entry_price} (${tipo}, ${fila.settlement})`);
    if (DRY) continue;
    const { error } = await sb.from("positions").insert(fila);
    if (error) { log(`insert ${c.ticker}: ${error.message}`); continue; }
    nuevas++;
  }
  // ── Futuros de ROFEX ──
  let futNuevas = 0, futActualizadas = 0, futOrdenes = 0;
  const porOrden = new Map();
  for (const p of existentes || []) if (p.extra?.matriz_order_id) porOrden.set(String(p.extra.matriz_order_id), p);
  for (const o of j.orders || []) {
    const sym = String(o.instrumentId?.symbol || "").toUpperCase();
    const m = /^(DLR|ORO|WTI)\/([A-Z]{3}\d{2})$/.exec(sym);
    if (!m) continue;
    if (!String(o.transactTime || "").startsWith(hoyCompacto)) continue;
    const oid = String(o.orderId || "");
    const qty = Number(o.cumQty) || 0, px = Number(o.avgPx) || 0;
    if (!oid || oid === "NONE" || qty <= 0 || !(px > 0)) continue;
    futOrdenes++;
    const previa = porOrden.get(oid) || (existentes || []).find((p) => o.clOrdId && p.extra?.matriz_cl_ord_id === o.clOrdId);
    if (previa) {
      // Solo se actualiza una fila que cargó ESTE puente; una importada a mano se respeta.
      if (previa.extra?.via !== "api_primary" || (Number(previa.quantity) === qty && Math.abs(Number(previa.entry_price) - px) < 1e-6)) continue;
      log(`${DRY ? "(dry) " : ""}actualizo ${m[1]}${m[2]} ${o.side}: ${previa.quantity} → ${qty} @ ${px}`);
      if (DRY) continue;
      const { error } = await sb.from("positions").update({ quantity: qty, entry_price: px }).eq("id", previa.id).eq("user_id", USER_ID);
      if (error) log(`update ${sym}: ${error.message}`); else futActualizadas++;
      continue;
    }
    const fila = {
      user_id: USER_ID, instrument_type: "future", operation_type: o.side === "SELL" ? "sell" : "buy",
      ticker: `${m[1]}${m[2]}`, quantity: qty, entry_price: px, entry_currency: m[1] === "DLR" ? "ARS" : "USD-MEP",
      entry_date: hoy, settlement: "CI", broker: "cocos", notes: null,
      extra: { source: "csv_matriz", matriz_account: CUENTA, matriz_order_id: oid, matriz_cl_ord_id: o.clOrdId, via: "api_primary", origen: o.originatingUsername === "ISV_PBCP" ? "bot" : "matriz",
        ...(m[1] === "ORO" ? { contract_size: 1 } : m[1] === "WTI" ? { contract_size: 10 } : {}) },   // DLR: default 1.000
    };
    log(`${DRY ? "(dry) " : ""}cargo futuro ${fila.operation_type} ${qty} ${fila.ticker} @ ${px}`);
    if (DRY) continue;
    const { error } = await sb.from("positions").insert(fila);
    if (error) { log(`insert ${fila.ticker}: ${error.message}`); continue; }
    futNuevas++;
  }
  log(`operaciones de hoy: ${cadenas.size} cadenas BYMA · ${nuevas} nuevas cargadas · futuros: ${futOrdenes} órdenes con ejecución, ${futNuevas} nuevas, ${futActualizadas} actualizadas`);
  // Si entró algo, se refresca la foto de la cuenta para que el cartel de
  // control (Matriz ahora vs Midas ahora) no quede comparando contra una foto vieja.
  if (!DRY && nuevas + futNuevas + futActualizadas > 0) {
    try { require("child_process").execFileSync(process.execPath, [path.join(__dirname, "worker.js")], { cwd: __dirname, timeout: 60000, stdio: "ignore" }); log("foto de la cuenta actualizada"); }
    catch (e) { log(`foto: ${e.message}`); }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(`[${new Date().toISOString()}] fatal:`, e.message); process.exit(1); });
