"use strict";

/* ---------------------------------------------------------------
 * Worker: iol-positions-sync
 *
 * Corre cada 30 min (PM2 cron). Para cada cuenta IOL activa:
 *   1. Lee el access_token desde linked_brokers (Supabase).
 *   2. Llama a /api/v2/portafolio/{pais} de IOL (argentina y
 *      estados_Unidos).
 *   3. ESPEJA las tenencias en la tabla positions, con broker='iol':
 *        - inserta las nuevas
 *        - actualiza cantidad / precio de las que ya estaban
 *        - borra las que IOL ya no reporta (lo que el usuario vendio)
 *
 * Reglas de seguridad:
 *   - Solo toca filas con broker='iol'. NUNCA toca posiciones
 *     manuales (todas las escrituras filtran por broker='iol').
 *   - No setea current_price: de eso se encarga el sistema de
 *     precios de Midas, igual que con cualquier posicion manual.
 *   - Si alguna llamada a IOL falla, NO borra nada (para no borrar
 *     de mas por un error de red); solo inserta y actualiza.
 *   - Si la API devuelve 0 activos pero teniamos posiciones,
 *     tampoco borra (probable blip de la API).
 *
 * NO refresca el token - de eso se encarga el keep-alive en
 * Supabase. Si el token esta vencido o IOL devuelve 401, saltea
 * esa cuenta y loguea; el keep-alive la revive despues.
 *
 * Modo prueba: "node worker.js --dry-run" hace todo (incluso llama
 * a IOL) pero NO escribe en la base. Loguea el JSON crudo y el plan
 * de reconciliacion (cuantas filas insertaria/actualizaria/borraria).
 * --------------------------------------------------------------- */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Polyfill de WebSocket - supabase-js lo necesita en Node < 22.
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = require("ws");
}

// ----- Config -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const IOL_BASE = "https://api.invertironline.com";
const PAISES = ["argentina", "estados_Unidos"];
const FETCH_TIMEOUT_MS = 20000;
const DRY_RUN = process.argv.includes("--dry-run");

// Fecha de hoy en horario argentino (UTC-3). Se usa como entry_date de
// las posiciones sincronizadas: IOL no informa la fecha de compra en su
// API de portafolio, asi que estampamos la fecha en que vimos la
// posicion por primera vez. Argentina no tiene DST: el offset -3h es fijo.
const TODAY_ART = new Date(Date.now() - 3 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[iol-positions-sync] FATAL: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ----- Logging -----
function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}
const info = (m) => log("INFO", m);
const warn = (m) => log("WARN", m);
const err = (m) => log("ERROR", m);

// ----- Helpers -----
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// IOL titulo.tipo -> positions.instrument_type (respeta el CHECK de
// la tabla). Valores validos: bond_ars, bond_usd, on, stock, cedear,
// future, option, caucion, fci, usd, crypto. Si no se puede mapear,
// devuelve null y el worker saltea esa tenencia (con warning).
function mapInstrumentType(tipoRaw, moneda) {
  const t = String(tipoRaw || "").toLowerCase();
  const esUSD = String(moneda || "").toLowerCase().includes("dolar");
  if (t.includes("accion")) return "stock";
  if (t.includes("cedear")) return "cedear";
  if (t.includes("obligacion")) return "on";
  if (t.includes("fondo")) return "fci";
  if (t.includes("opcion")) return "option";
  if (t.includes("futuro")) return "future";
  if (t.includes("titulo") || t.includes("bono") || t.includes("letra")) {
    return esUSD ? "bond_usd" : "bond_ars";
  }
  return null;
}

function currencyOf(moneda) {
  return String(moneda || "").toLowerCase().includes("dolar") ? "USD" : "ARS";
}

// Parsea un "activo" del portafolio IOL a los campos de positions.
function parseActivo(activo) {
  const titulo = activo.titulo || activo.Titulo || {};
  const ticker = titulo.simbolo || titulo.Simbolo || null;
  const tipoRaw = titulo.tipo || titulo.Tipo || null;
  const moneda = titulo.moneda || titulo.Moneda || null;
  return {
    ticker,
    tipoRaw,
    moneda,
    instrument_type: mapInstrumentType(tipoRaw, moneda),
    quantity: numOrNull(activo.cantidad),
    entry_price: numOrNull(activo.ppc), // ppc = precio promedio de compra
    entry_currency: currencyOf(moneda),
    raw: activo,
  };
}

// ----- Fetch /portafolio -----
async function fetchPortfolio(accessToken, pais) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${IOL_BASE}/api/v2/portafolio/${pais}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ----- Sincronizar una cuenta -----
async function syncOne(link) {
  const tag = `IOL user ${String(link.user_id).slice(0, 8)}`;

  if (!link.access_token) {
    warn(`${tag}: sin access_token guardado - salteo`);
    return;
  }
  if (link.access_expires_at && new Date(link.access_expires_at) < new Date()) {
    warn(`${tag}: access_token vencido (${link.access_expires_at}) - salteo; lo revive el keep-alive`);
    return;
  }

  // 1. Traer el portafolio de cada pais. fetchClean queda en false si
  //    alguna llamada falla -> en ese caso NO se borra nada.
  let fetchClean = true;
  const activos = [];
  for (const pais of PAISES) {
    let resp;
    try {
      resp = await fetchPortfolio(link.access_token, pais);
    } catch (e) {
      warn(`${tag}: error de red en /portafolio/${pais}: ${e.message}`);
      fetchClean = false;
      continue;
    }
    if (resp.status === 401) {
      warn(`${tag}: /portafolio devolvio 401 - token rechazado, salteo la cuenta; lo revive el keep-alive`);
      return;
    }
    if (!resp.ok) {
      warn(`${tag}: /portafolio/${pais} HTTP ${resp.status} - salteo ese pais`);
      fetchClean = false;
      continue;
    }
    let data;
    try {
      data = await resp.json();
    } catch {
      warn(`${tag}: /portafolio/${pais} no es JSON valido - salteo ese pais`);
      fetchClean = false;
      continue;
    }
    info(`${tag}: /portafolio/${pais} (crudo):\n${JSON.stringify(data, null, 2)}`);
    const arr = Array.isArray(data.activos) ? data.activos : [];
    for (const a of arr) activos.push(a);
  }

  // 2. Parsear las tenencias.
  const desired = [];
  for (const activo of activos) {
    const p = parseActivo(activo);
    if (!p.ticker) {
      warn(`${tag}: tenencia sin simbolo - salteo`);
      continue;
    }
    if (p.instrument_type === null) {
      warn(`${tag}: tipo IOL desconocido '${p.tipoRaw}' (${p.ticker}) - salteo; avisame para mapearlo`);
      continue;
    }
    if (p.quantity === null || p.quantity === 0) {
      warn(`${tag}: ${p.ticker} con cantidad ${p.quantity} - salteo`);
      continue;
    }
    info(`${tag}: ${p.ticker} -> ${p.instrument_type} cant=${p.quantity} ppc=${p.entry_price} (${p.entry_currency})`);
    desired.push(p);
  }

  // 3. Leer las posiciones IOL que ya tenemos guardadas.
  const { data: existing, error: exErr } = await supabase
    .from("positions")
    .select("id, ticker, quantity, entry_price, entry_date")
    .eq("user_id", link.user_id)
    .eq("broker", "iol");
  if (exErr) {
    err(`${tag}: error leyendo positions existentes: ${exErr.message}`);
    return;
  }
  const existingRows = existing || [];

  // 4. Reconciliar: insert / update / delete (match por ticker).
  const existingByTicker = new Map(existingRows.map((r) => [r.ticker, r]));
  const desiredTickers = new Set(desired.map((d) => d.ticker));
  const toInsert = [];
  const toUpdate = [];
  const toDelete = [];
  for (const d of desired) {
    const ex = existingByTicker.get(d.ticker);
    if (ex) toUpdate.push({ id: ex.id, existingEntryDate: ex.entry_date, d });
    else toInsert.push(d);
  }
  for (const ex of existingRows) {
    if (!desiredTickers.has(ex.ticker)) toDelete.push(ex);
  }

  info(
    `${tag}: reconciliacion -> ${toInsert.length} a insertar, ` +
      `${toUpdate.length} a actualizar, ${toDelete.length} a borrar`
  );

  // Salvaguarda contra blips de la API: si IOL devolvio 0 activos pero
  // teniamos posiciones guardadas, casi seguro es un glitch (ventana de
  // mantenimiento nocturno, error puntual del feed, etc.). NO borramos
  // -- preferimos quedarnos con datos viejos por una corrida que wipear
  // toda la cartera y dejar al usuario solo con cash. Si el usuario
  // genuinamente vendio TODO, puede borrar a mano; y la proxima corrida
  // con activos no vacios reconcilia normal.
  const apiReturnedEmpty = activos.length === 0;
  const suspiciousWipe = fetchClean && apiReturnedEmpty && existingRows.length > 0;
  if (suspiciousWipe) {
    warn(
      `${tag}: IOL devolvio 0 activos pero teniamos ${existingRows.length} ` +
        `posicion(es) guardada(s) - lo tratamos como blip de la API y NO ` +
        `borramos. Si en serio vendiste todo, borralas a mano desde la UI.`
    );
  }

  if (!fetchClean && toDelete.length > 0) {
    warn(`${tag}: alguna llamada a IOL fallo - NO borro las ${toDelete.length} fila(s) para no borrar de mas`);
  }

  if (DRY_RUN) {
    info(`${tag}: [DRY-RUN] no se escribe nada en positions`);
    return;
  }

  // 5. Aplicar los cambios.
  if (toInsert.length > 0) {
    const rows = toInsert.map((d) => ({
      user_id: link.user_id,
      broker: "iol",
      instrument_type: d.instrument_type,
      ticker: d.ticker,
      quantity: d.quantity,
      entry_price: d.entry_price,
      entry_currency: d.entry_currency,
      operation_type: "buy",
      settlement: "CI",
      entry_date: TODAY_ART,
      extra: { source: "iol-positions-sync", iol: d.raw },
    }));
    const { error: insErr } = await supabase.from("positions").insert(rows);
    if (insErr) err(`${tag}: error insertando posiciones: ${insErr.message}`);
    else info(`${tag}: ${rows.length} posicion(es) insertada(s).`);
  }

  for (const u of toUpdate) {
    const { error: updErr } = await supabase
      .from("positions")
      .update({
        instrument_type: u.d.instrument_type,
        quantity: u.d.quantity,
        entry_price: u.d.entry_price,
        entry_currency: u.d.entry_currency,
        // Preservamos la entry_date original; si nunca se seteo (posicion
        // sincronizada antes de este fix), la estampamos con la de hoy.
        entry_date: u.existingEntryDate || TODAY_ART,
        extra: { source: "iol-positions-sync", iol: u.d.raw },
        updated_at: new Date().toISOString(),
      })
      .eq("id", u.id)
      .eq("broker", "iol"); // doble seguro: solo filas iol
    if (updErr) err(`${tag}: error actualizando ${u.d.ticker}: ${updErr.message}`);
  }
  if (toUpdate.length > 0) info(`${tag}: ${toUpdate.length} posicion(es) actualizada(s).`);

  if (toDelete.length > 0 && fetchClean && !suspiciousWipe) {
    const ids = toDelete.map((r) => r.id);
    const { error: delErr } = await supabase
      .from("positions")
      .delete()
      .in("id", ids)
      .eq("broker", "iol"); // doble seguro: nunca toca posiciones manuales
    if (delErr) err(`${tag}: error borrando posiciones vendidas: ${delErr.message}`);
    else info(`${tag}: ${ids.length} posicion(es) borrada(s) (ya no estan en IOL).`);
  }
}

// ----- Main -----
async function main() {
  info(`Inicio${DRY_RUN ? " - modo DRY-RUN (no escribe nada)" : ""}`);

  const { data: links, error: linksErr } = await supabase
    .from("linked_brokers")
    .select("id, user_id, broker, broker_account_id, access_token, access_expires_at, status")
    .eq("broker", "iol")
    .eq("status", "active");
  if (linksErr) throw new Error(`leyendo linked_brokers: ${linksErr.message}`);

  if (!links || links.length === 0) {
    info("No hay cuentas IOL activas. Nada que hacer.");
    return;
  }
  info(`${links.length} cuenta(s) IOL activa(s) a sincronizar.`);

  for (const link of links) {
    await syncOne(link);
  }

  info("Fin OK.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    err(`Worker abortado: ${e.message}`);
    process.exit(1);
  });
