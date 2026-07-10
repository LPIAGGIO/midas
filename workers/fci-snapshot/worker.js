/**
 * fci-snapshot — Worker de snapshot diario de FCIs (Fondos Comunes de Inversión)
 * Midas / Axón Group
 *
 * Fuente: ArgentinaDatos API (proxy de CAFCI, sin auth)
 *   GET https://api.argentinadatos.com/v1/finanzas/fci/{categoria}/{fecha}
 *   categoria : mercadoDinero | rentaVariable | rentaFija | rentaMixta | retornoTotal | otros
 *   fecha     : ultimo | penultimo | YYYY/MM/DD
 *
 * Destino: Supabase, tabla fci_quotes
 *   upsert con onConflict (fecha, fondo, categoria)
 *
 * Uso:
 *   node worker.js                                   # snapshot del último día hábil (6 categorías)
 *   node worker.js --backfill 365                    # backfill de los últimos 365 días corridos
 *   node worker.js --backfill 2025/05/14 2026/05/14  # backfill de un rango explícito
 *
 * Cron sugerido (post-cierre, ~20:30 ART, días hábiles):
 *   30 20 * * 1-5  cd /home/midas/workers/fci-snapshot && node worker.js >> snapshot.log 2>&1
 *
 * Requisitos: Node 18+ (usa fetch global). En Node < 22 hace falta el paquete "ws"
 * (el cliente de supabase-js inicializa RealtimeClient aunque no lo usemos).
 * Variables en .env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

// ---------- Config ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('[fci-snapshot] Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el entorno.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws },
});

const API_BASE = 'https://api.argentinadatos.com/v1/finanzas/fci';

const CATEGORIAS = [
  'mercadoDinero',
  'rentaVariable',
  'rentaFija',
  'rentaMixta',
  'retornoTotal',
  'otros',
];

const UPSERT_CHUNK = 500;     // filas por request de upsert
const REQUEST_DELAY_MS = 350; // pausa entre requests a la API (rate-limit suave)
const MAX_RETRIES = 2;        // reintentos ante 5xx / error de red
const RETRY_DELAY_MS = 1500;  // pausa antes de reintentar

// ---------- Helpers ----------
function log(...args) {
  console.log(`[fci-snapshot ${new Date().toISOString()}]`, ...args);
}
function errlog(...args) {
  console.error(`[fci-snapshot ${new Date().toISOString()}]`, ...args);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Date -> 'YYYY/MM/DD' para la API
function toApiDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// ---------- Fetch ----------
async function fetchCategoria(categoria, fecha) {
  const url = `${API_BASE}/${categoria}/${fecha}`;

  for (let intento = 0; intento <= MAX_RETRIES; intento++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });

      if (res.status === 404) {
        // sin datos para esa fecha/categoria (feriado, fin de semana, etc.)
        return [];
      }
      if (res.status >= 500) {
        // error transitorio del servidor: reintentar
        if (intento < MAX_RETRIES) {
          errlog(`HTTP ${res.status} en ${url}, reintento ${intento + 1}/${MAX_RETRIES}`);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        errlog(`HTTP ${res.status} en ${url}, sin más reintentos`);
        return null;
      }
      if (!res.ok) {
        errlog(`HTTP ${res.status} en ${url}`);
        return null; // null = error real ; [] = vacío legítimo
      }

      const json = await res.json();
      if (!Array.isArray(json)) {
        errlog(`Respuesta no-array en ${url}`);
        return null;
      }
      return json;
    } catch (e) {
      if (intento < MAX_RETRIES) {
        errlog(`Fetch falló en ${url} (${e.message}), reintento ${intento + 1}/${MAX_RETRIES}`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      errlog(`Fetch falló en ${url}:`, e.message);
      return null;
    }
  }
  return null;
}

// ---------- Normalización ----------
function normalizeRow(raw, categoria) {
  // La API hoy NO trae 'tipo'; sí trae 'horizonte'. Guardamos lo que venga.
  if (!raw || !raw.fondo || !raw.fecha) return null;
  if (raw.vcp == null) return null; // sin valor de cuotaparte no sirve, lo descartamos
  return {
    fecha: raw.fecha,            // 'YYYY-MM-DD' (la que reporta el fondo, no la pedida)
    categoria,
    fondo: raw.fondo,
    tipo: raw.tipo ?? null,      // por compatibilidad de schema; hoy viene null
    vcp: raw.vcp,
    ccp: raw.ccp ?? null,
    patrimonio: raw.patrimonio ?? null,
    horizonte: raw.horizonte ?? null,
    fetched_at: new Date().toISOString(),
  };
}

// Deduplica por la clave de conflicto (fecha, fondo, categoria).
// La API a veces repite un fondo dentro de la misma categoría/fecha, y Postgres
// rechaza el batch entero con "ON CONFLICT DO UPDATE command cannot affect row
// a second time". Nos quedamos con la última ocurrencia (last-write-wins).
function dedupeRows(rows) {
  const map = new Map();
  for (const r of rows) {
    map.set(`${r.fecha}|${r.fondo}|${r.categoria}`, r);
  }
  return [...map.values()];
}

// ---------- Upsert ----------
async function upsertRows(rows) {
  let ok = 0;
  for (const part of chunk(rows, UPSERT_CHUNK)) {
    const { error } = await supabase
      .from('fci_quotes')
      .upsert(part, { onConflict: 'fecha,fondo,categoria' });
    if (error) {
      errlog('Upsert falló:', error.message);
    } else {
      ok += part.length;
    }
  }
  return ok;
}

// ---------- Snapshot de una fecha ----------
async function snapshot(fecha) {
  let totalParsed = 0;
  let totalUpserted = 0;

  for (const categoria of CATEGORIAS) {
    const raw = await fetchCategoria(categoria, fecha);
    await sleep(REQUEST_DELAY_MS);

    if (raw === null) {
      errlog(`  ${categoria}: error de fetch, se saltea`);
      continue;
    }
    if (raw.length === 0) {
      log(`  ${categoria}: sin datos`);
      continue;
    }

    const rows = dedupeRows(
      raw.map((r) => normalizeRow(r, categoria)).filter(Boolean)
    );
    totalParsed += rows.length;

    const upserted = await upsertRows(rows);
    totalUpserted += upserted;
    log(`  ${categoria}: ${rows.length} parseadas, ${upserted} upserted`);
  }

  log(`Fecha ${fecha}: ${totalParsed} parseadas, ${totalUpserted} upserted en total`);
  return { totalParsed, totalUpserted };
}

// ---------- Backfill ----------
async function backfill(args) {
  let fechas = [];

  if (args.length === 1 && /^\d+$/.test(args[0])) {
    // --backfill N  -> últimos N días corridos
    const dias = parseInt(args[0], 10);
    const hoy = new Date();
    for (let i = dias; i >= 1; i--) {
      const d = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate() - i));
      fechas.push(toApiDate(d));
    }
  } else if (args.length === 2) {
    // --backfill YYYY/MM/DD YYYY/MM/DD  -> rango explícito
    const desde = new Date(args[0].replace(/\//g, '-') + 'T00:00:00Z');
    const hasta = new Date(args[1].replace(/\//g, '-') + 'T00:00:00Z');
    if (isNaN(desde) || isNaN(hasta) || desde > hasta) {
      errlog('Rango de backfill inválido. Uso: --backfill YYYY/MM/DD YYYY/MM/DD');
      process.exit(1);
    }
    for (let d = new Date(desde); d <= hasta; d.setUTCDate(d.getUTCDate() + 1)) {
      fechas.push(toApiDate(new Date(d)));
    }
  } else {
    errlog('Uso: --backfill N   |   --backfill YYYY/MM/DD YYYY/MM/DD');
    process.exit(1);
  }

  log(`Backfill de ${fechas.length} fechas (${fechas[0]} -> ${fechas[fechas.length - 1]})`);

  let granParsed = 0;
  let granUpserted = 0;
  for (const fecha of fechas) {
    log(`--- ${fecha} ---`);
    const { totalParsed, totalUpserted } = await snapshot(fecha);
    granParsed += totalParsed;
    granUpserted += totalUpserted;
  }
  log(`Backfill terminado: ${granParsed} parseadas, ${granUpserted} upserted en ${fechas.length} fechas`);
}

// ---------- Main ----------
(async () => {
  const argv = process.argv.slice(2);
  const inicio = Date.now();

  try {
    if (argv[0] === '--backfill') {
      await backfill(argv.slice(1));
    } else {
      log('Snapshot del último día hábil disponible (ultimo)');
      await snapshot('ultimo');
    }
    log(`Listo en ${((Date.now() - inicio) / 1000).toFixed(1)}s`);
    process.exit(0);
  } catch (e) {
    errlog('Error fatal:', e.stack || e.message);
    process.exit(1);
  }
})();
