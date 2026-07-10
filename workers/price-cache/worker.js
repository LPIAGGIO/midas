
/**
 * Worker price-cache: cada minuto durante horario de mercado, descarga
 * precios reales de MAE y los upsertea en la tabla prices_cache de
 * Supabase. El frontend lee de ahí en lugar de pegarle a DATA912 /
 * BYMA Open Data (que tienen 15-20 min de delay).
 *
 * Endpoints:
 *   - rentafija: bonos, LECAPs, BONCERs, ONs, etc.
 *   - forex: dólares (USMEP, UST$T, EB$T, USB$T) por segmento + plazo.
 *   - cauciones: tasas TNA por moneda + plazo.
 *
 * Horario: lun-vie 10:00 a 18:00 ART (premarket + postmarket).
 *
 * Schedule: PM2 cron_restart cada 1 min en esa ventana. El worker hace
 * un sync completo y termina (one-shot). El process.exit final permite
 * que PM2 lo reinicie en el próximo tick sin overlap.
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");


const MAE_API_KEY = process.env.MAE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!MAE_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan vars de entorno. Verificá .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});


const MAE_BASE = "https://api.mae.com.ar/MarketData/v1";
const ENDPOINTS = [
  { path: "/mercado/cotizaciones/rentafija", source: "mae_rentafija" },
  { path: "/mercado/cotizaciones/forex",     source: "mae_forex" },
  { path: "/mercado/cotizaciones/cauciones", source: "mae_cauciones" },
];

/**
 * Validamos horario incluso si PM2 ya lo restringe vía cron. Doble
 * checkpoint por si alguien corre el script a mano fuera de horario.
 * Usamos Intl con timeZone explícito para evitar pifiar si el VPS
 * tiene timezone mal configurada.
 */
function isMarketWindow() {
  if (process.env.FORCE_SYNC === "1") return true;
  const now = new Date();
  const ar = new Date(now.toLocaleString("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
  }));
  const day = ar.getDay();   // 0=dom 6=sab
  const hour = ar.getHours();
  if (day === 0 || day === 6) return false;
  if (hour < 10 || hour >= 18) return false;
  return true;
}

/**
 * Pega a un endpoint MAE iterando todas las páginas. MAE devuelve el
 * header x-pagination con TotalPages. Si no viene, asumimos 1 página.
 */
async function fetchAllPages(path) {
  const all = [];
  let pageNumber = 1;
  let totalPages = 1;

  do {
    const url = `${MAE_BASE}${path}?pageNumber=${pageNumber}`;
    const resp = await fetch(url, {
      headers: { "x-api-key": MAE_API_KEY },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} en ${path} page ${pageNumber}`);
    }
    const data = await resp.json();
    if (Array.isArray(data)) all.push(...data);

    const pagHeader = resp.headers.get("x-pagination");
    if (pagHeader) {
      try {
        const pag = JSON.parse(pagHeader);
        totalPages = Number(pag.TotalPages) || 1;
      } catch (e) {
        totalPages = 1;
      }
    }
    pageNumber++;
  } while (pageNumber <= totalPages);

  return all;
}

/**
 * Deriva el cierre anterior a partir del último precio y la variación.
 *
 * MAE NO expone `precioCierreAnterior` en cotizaciones intraday: el campo
 * existe en el response pero siempre viene en 0 (verificado empíricamente
 * 31/05/2026 y 01/06/2026 en horario hábil). Sin embargo, `variacion` SÍ
 * viene poblada como porcentaje respecto al cierre anterior.
 *
 * Formula: prev_close = last / (1 + variacion/100)
 *
 * Validado matemáticamente contra el dato oficial de daily_close_prices
 * (worker mae-boletin, boletín MAE del cierre):
 *   AE38 BT $ 000 → derivado 1165,500 ≡ oficial 1165,500 (diferencia 0).
 *
 * Fallbacks:
 *  - Si MAE algún día sí manda `precioCierreAnterior` > 0, lo usamos.
 *  - Si `variacion` es 0 o null (instrumento no operó), devolvemos null
 *    (preferimos null antes que un valor incorrecto).
 */
function derivePrevClose(item) {
  const explicit = Number(item.precioCierreAnterior);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const last = Number(item.precioUltimo);
  const variacion = Number(item.variacion);
  if (
    Number.isFinite(last) && last > 0 &&
    Number.isFinite(variacion) && variacion !== 0
  ) {
    return last / (1 + variacion / 100);
  }
  return null;
}

/**
 * Mapea un item MAE a la row de prices_cache. Defensivo con tipos:
 * MAE a veces devuelve "0001-01-01T00:00:00" como fecha vacía, lo
 * normalizamos a null. Los precios vienen como números o string,
 * forzamos Number(). El segment_code es "" cuando no aplica (cauciones).
 */
function mapToRow(item, source) {
  const ticker = String(item.ticker || "").trim();
  const segmentCode = String(item.codigoSegmento || "").trim();
  const plazo = String(item.plazo || "000").padStart(3, "0");
  const currency = String(item.moneda || "$").trim();

  const settle = item.fechaLiquidacion;
  const settleDate =
    settle && !settle.startsWith("0001") ? settle.slice(0, 10) : null;

  const numOrNull = (v) => {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    ticker,
    segment_code: segmentCode,
    plazo,
    currency,
    source,
    description: item.descripcion || null,
    tipo_emision: item.tipoEmision || null,
    segment_name: item.segmento || null,
    last_price: numOrNull(item.precioUltimo),
    close_price: numOrNull(item.precioCierre),
    prev_close: derivePrevClose(item),
    min_price: numOrNull(item.precioMinimo),
    max_price: numOrNull(item.precioMaximo),
    variation_pct: numOrNull(item.variacion),
    last_rate: numOrNull(item.ultimaTasa),
    open_interest: numOrNull(item.openInterest),
    volume: numOrNull(item.volumenAcumulado),
    amount: numOrNull(item.montoAcumulado),
    trade_date: item.fecha ? String(item.fecha).slice(0, 10) : null,
    settlement_date: settleDate,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Sync de un endpoint: fetch páginas + UPSERT en batches de 500.
 * Filtramos items sin ticker (defensivo, no debería pasar pero el feed
 * a veces tiene basura). Batch grande para minimizar round-trips.
 */
async function syncEndpoint(endpoint) {
  const { path, source } = endpoint;
  const t0 = Date.now();
  const items = await fetchAllPages(path);
  const valid = items.filter((it) => it && it.ticker && String(it.ticker).trim());
  if (valid.length === 0) {
    console.log(`[${source}] sin items`);
    return;
  }

  const mapped = valid.map((it) => mapToRow(it, source));

  // Dedup por la clave única (ticker, segment_code, plazo, currency, source):
  // MAE a veces devuelve el mismo instrumento dos veces en la misma corrida
  // (típico de rentafija con el mismo ticker en distintos registros). El
  // UPSERT en batch revienta si la clave aparece repetida ("ON CONFLICT DO
  // UPDATE command cannot affect row a second time"). Nos quedamos con la
  // fila de mayor amount (la más líquida/representativa).
  const byKey = new Map();
  for (const row of mapped) {
    const key = `${row.ticker}|${row.segment_code}|${row.plazo}|${row.currency}|${row.source}`;
    const prev = byKey.get(key);
    if (!prev || (row.amount ?? 0) > (prev.amount ?? 0)) byKey.set(key, row);
  }
  const rows = Array.from(byKey.values());
  if (rows.length < mapped.length) {
    console.log(`[${source}] dedup: ${mapped.length - rows.length} filas duplicadas descartadas`);
  }

  // UPSERT en batches: Postgres acepta batches grandes pero >1000 puede
  // pegarle al timeout del API gateway. 500 es conservador.
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const { error } = await supabase
      .from("prices_cache")
      .upsert(slice, {
        onConflict: "ticker,segment_code,plazo,currency,source",
      });
    if (error) throw error;
    upserted += slice.length;
  }

  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[${source}] ${upserted} rows en ${dur}s`);
}

async function main() {
  const stamp = new Date().toISOString();
  if (!isMarketWindow()) {
    console.log(`[${stamp}] fuera de horario, skip`);
    return;
  }
  console.log(`[${stamp}] sync MAE`);

  for (const ep of ENDPOINTS) {
    try {
      await syncEndpoint(ep);
    } catch (err) {
      console.error(`[${ep.source}] error: ${err.message}`);
    }
  }
  console.log(`[${new Date().toISOString()}] done`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
