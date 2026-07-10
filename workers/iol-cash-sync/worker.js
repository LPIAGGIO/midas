"use strict";

/* ---------------------------------------------------------------
 * Worker: iol-cash-sync
 *
 * Corre cada ~15 min (PM2 cron). Para cada cuenta IOL activa:
 *   1. Lee el access_token desde linked_brokers (Supabase).
 *   2. Llama a /api/v2/estadocuenta de IOL.
 *   3. Guarda una FOTO del cash en broker_cash_snapshots - una fila
 *      por subcuenta (ARS, USD MEP, USD CCL).
 *
 * NO refresca el token - de eso se encarga el keep-alive en Supabase.
 * Si el token esta vencido o IOL devuelve 401, el worker saltea esa
 * cuenta y loguea; el keep-alive la revive en su proxima corrida.
 *
 * Modo prueba: "node worker.js --dry-run" hace todo (incluso llama a
 * IOL) pero NO escribe en la base. Loguea el JSON crudo de IOL.
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
const FETCH_TIMEOUT_MS = 15000;
const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[iol-cash-sync] FATAL: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
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

// Deriva la moneda del tipo de cuenta IOL si no viene un campo explicito.
function currencyOf(tipo, monedaField) {
  if (monedaField) {
    const m = String(monedaField).toLowerCase();
    if (m.includes("peso")) return "ARS";
    if (m.includes("dolar") || m.includes("usd")) return "USD";
  }
  const t = String(tipo || "").toLowerCase();
  if (t.includes("peso")) return "ARS";
  if (t.includes("dolar")) return "USD";
  return "ARS";
}

// Parsea un objeto "cuenta" de /estadocuenta a una fila de snapshot.
// Best-effort: IOL puede usar distintos nombres de campo. Guardamos el
// objeto crudo completo en "raw", asi nada se pierde y podemos afinar
// el parser despues de ver el JSON real en los logs.
function parseCuenta(cuenta) {
  const accountType = cuenta.tipo || cuenta.Tipo || "desconocido";
  const accountId = cuenta.numero != null ? String(cuenta.numero) : null;
  const currency = currencyOf(accountType, cuenta.moneda);

  // total = cash total de la subcuenta. Probamos saldo / disponible / total.
  let total =
    numOrNull(cuenta.saldo) ??
    numOrNull(cuenta.disponible) ??
    numOrNull(cuenta.total);

  // available = disponible inmediato (liquidez CI).
  let available = numOrNull(cuenta.disponible);

  // Si no hubo nada arriba, miramos el bucket 'inmediato' de saldos[].
  const saldos = Array.isArray(cuenta.saldos) ? cuenta.saldos : [];
  const inmediato = saldos.find((s) =>
    String(s && s.liquidacion ? s.liquidacion : "")
      .toLowerCase()
      .includes("inmediato")
  );
  if (inmediato) {
    if (available == null) {
      available =
        numOrNull(inmediato.disponible) ??
        numOrNull(inmediato.saldo) ??
        numOrNull(inmediato.disponibleOperar);
    }
    if (total == null) {
      total = numOrNull(inmediato.saldo) ?? available;
    }
  }

  if (total == null) total = 0;
  return { accountType, accountId, currency, total, available };
}

// ----- Fetch /estadocuenta -----
async function fetchEstadoCuenta(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${IOL_BASE}/api/v2/estadocuenta`, {
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

  let resp;
  try {
    resp = await fetchEstadoCuenta(link.access_token);
  } catch (e) {
    warn(`${tag}: error de red llamando /estadocuenta: ${e.message}`);
    return;
  }

  if (resp.status === 401) {
    warn(`${tag}: /estadocuenta devolvio 401 - token rechazado, salteo; lo revive el keep-alive`);
    return;
  }
  if (!resp.ok) {
    warn(`${tag}: /estadocuenta HTTP ${resp.status} - salteo`);
    return;
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    warn(`${tag}: la respuesta de /estadocuenta no es JSON valido - salteo`);
    return;
  }

  // Log del JSON crudo - clave para afinar el parser con datos reales.
  info(`${tag}: /estadocuenta (crudo):\n${JSON.stringify(data, null, 2)}`);

  const cuentas = Array.isArray(data.cuentas) ? data.cuentas : [];
  if (cuentas.length === 0) {
    warn(`${tag}: /estadocuenta no trae 'cuentas' - nada para guardar`);
    return;
  }

  const now = new Date().toISOString();
  const rows = [];
  for (const cuenta of cuentas) {
    const p = parseCuenta(cuenta);
    info(`${tag}: ${p.accountType} (${p.currency}) - total=${p.total} disponible=${p.available}`);
    rows.push({
      user_id: link.user_id,
      broker: "iol",
      account_id: p.accountId,
      account_type: p.accountType,
      currency: p.currency,
      total: p.total,
      available: p.available,
      raw: cuenta,
      snapshot_at: now,
    });
  }

  if (DRY_RUN) {
    info(`${tag}: [DRY-RUN] se guardarian ${rows.length} subcuenta(s) - no se escribe nada`);
    return;
  }

  const { error: upErr } = await supabase
    .from("broker_cash_snapshots")
    .upsert(rows, { onConflict: "user_id,broker,account_type" });
  if (upErr) {
    err(`${tag}: error guardando snapshot: ${upErr.message}`);
    return;
  }
  info(`${tag}: ${rows.length} subcuenta(s) guardadas en broker_cash_snapshots.`);
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
