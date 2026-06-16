/**
 * /api/mtr-md — Market data de futuros DLR desde Supabase.
 *
 * Reemplazo drop-in de /api/primary-md. Devuelve EXACTAMENTE el mismo shape,
 * asi el switchover en el frontend es cambiar la URL del fetch y nada mas.
 *
 * Diferencia con primary-md (el viejo):
 *   - primary-md pegaba a api.remarkets.primary.com.ar (ambiente DEMO/sandbox
 *     de Primary) -> precios que NO coincidian con produccion. Esa era la
 *     causa raiz del bug de precios DLR.
 *   - mtr-md lee la tabla `mtr_market_data` de Supabase, poblada por el worker
 *     PM2 `mtr-market-data` que mantiene un WS abierto contra el visor A3 de
 *     PRODUCCION (matbarofex.primary.ventures).
 *
 * Implementacion: fetch directo a PostgREST (la REST API de Supabase). NO usa
 * el cliente @supabase/supabase-js a proposito -> evita el problema de Node 20
 * sin WebSocket nativo (supabase-js inicializa Realtime en el constructor) y
 * no agrega dependencias. Para un endpoint read-only, un GET HTTP alcanza.
 *
 * Shape de respuesta (identico a primary-md):
 *   {
 *     ok: true,
 *     fetchedAt: "2026-05-28T14:13:47.123Z",
 *     prices: {
 *       "DLRMAY26": { last, bid, offer, settlement, midpoint,
 *                     price, priceSource, lastDate, freshness },
 *       ...
 *     }
 *   }
 *
 * Acepta ?symbols=DLRMAY26,DLRJUN26,... (formato app o Primary con "/").
 * Si no se pasa symbols, devuelve los 12 DLR. Tickers no-DLR se omiten
 * (el frontend mantiene su valor previo via merge).
 */

// Env vars: priorizamos las sin prefijo (server-side). Fallback a VITE_ por si
// en Vercel solo estan configuradas esas.
const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

// Prioridad de "precio elegido" (acordada con LP):
//   1. last si lastTs < 30 min        -> "last" / fresh
//   2. mid = (bid+offer)/2 si AMBOS    -> "mid"  / fresh|stale
//   3. last si lastTs < 36h            -> "last" / stale
//   4. settlement                      -> "settlement" / stale
//   5. nada                            -> null / none
const LAST_FRESH_MS = 30 * 60 * 1000;
const LAST_INTRADAY_MS = 36 * 60 * 60 * 1000;

function rowToPriceEntry(row, nowMs) {
  const last = row.last != null ? Number(row.last) : null;
  const bid = row.bid != null ? Number(row.bid) : null;
  const offer = row.ask != null ? Number(row.ask) : null; // tabla usa "ask", front espera "offer"
  const settlement = row.settlement != null ? Number(row.settlement) : null;
  // `reference` = settle del día ANTERIOR. A diferencia de `settlement` (que tras
  // el cierre rola al settle de HOY), reference NO rola → es la base correcta del
  // P&L del día de futuros, igual que lo calcula Matriz: (último − reference).
  const reference = row.reference != null ? Number(row.reference) : null;
  const midpoint = bid != null && offer != null ? (bid + offer) / 2 : null;
  const lastDate = row.last_ts ? new Date(row.last_ts).getTime() : null;
  const lastAge = lastDate != null ? nowMs - lastDate : Infinity;

  // Tamaños de las puntas (para order-book imbalance) + volumen.
  const bidSize = row.bid_size != null ? Number(row.bid_size) : null;
  const askSize = row.ask_size != null ? Number(row.ask_size) : null;
  const volume = row.volume != null ? Number(row.volume) : null;

  let price = null;
  let priceSource = null;
  let freshness = "none";

  if (last != null && lastAge <= LAST_FRESH_MS) {
    price = last;
    priceSource = "last";
    freshness = "fresh";
  } else if (midpoint != null) {
    price = midpoint;
    priceSource = "mid";
    freshness = last != null ? "stale" : "fresh";
  } else if (last != null && lastAge <= LAST_INTRADAY_MS) {
    price = last;
    priceSource = "last";
    freshness = "stale";
  } else if (settlement != null) {
    price = settlement;
    priceSource = "settlement";
    freshness = "stale";
  }

  return { last, bid, offer, settlement, reference, midpoint, price, priceSource, lastDate, freshness, bidSize, askSize, volume };
}

/** app ticker "DLRMAY26" -> security_id "rx_DDF_DLR_MAY26". null si no es DLR. */
function appToSecurityId(appTicker) {
  const m = (appTicker || "").toUpperCase().trim().replace("/", "").match(/^(DLR)([A-Z]{3})(\d{2})$/);
  if (!m) return null;
  return `rx_DDF_DLR_${m[2]}${m[3]}`;
}

/** symbol de la tabla "DLR/MAY26" -> app ticker "DLRMAY26". */
function symbolToApp(symbol) {
  return (symbol || "").replace("/", "");
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method_not_allowed" });
    return;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    res.status(502).json({
      ok: false,
      error: "config_error",
      detail: "SUPABASE_URL / SUPABASE_ANON_KEY no configurados",
    });
    return;
  }

  try {
    // Parsear symbols pedidos (opcional). Formato app "DLRMAY26" o Primary
    // "DLR/MAY26". Si no viene, devolvemos todos los DLR de la tabla.
    const raw = (req.query?.symbols || "").trim();
    let securityIds = null;
    if (raw) {
      securityIds = [];
      for (const t of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const secId = appToSecurityId(t);
        if (secId) securityIds.push(secId);
      }
    }

    // Construir la query PostgREST.
    let url = `${SUPABASE_URL}/rest/v1/mtr_market_data?select=*`;
    if (securityIds && securityIds.length > 0) {
      url += `&security_id=in.(${securityIds.join(",")})`;
    }

    // Authorization Bearer SOLO para keys legacy JWT (eyJ...). Las publishable
    // keys nuevas (sb_publishable_...) NO son JWT; mandarlas en Bearer hace que
    // PostgREST las rechace con 401. Para esas, apikey solo basta (rol anon).
    const headers = { apikey: SUPABASE_ANON_KEY };
    if (SUPABASE_ANON_KEY.startsWith("eyJ")) {
      headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;
    }
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.error("mtr-md postgrest error:", resp.status, text);
      res.status(502).json({
        ok: false,
        error: "supabase_error",
        detail: `PostgREST HTTP ${resp.status}`,
      });
      return;
    }

    const rows = await resp.json();
    const nowMs = Date.now();
    const prices = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const appKey = symbolToApp(row.symbol);
      prices[appKey] = rowToPriceEntry(row, nowMs);
    }

    // Mismo cache header que primary-md: 5s edge cache.
    res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=10");
    res.status(200).json({
      ok: true,
      fetchedAt: new Date(nowMs).toISOString(),
      prices,
    });
  } catch (err) {
    console.error("mtr-md error:", err);
    res.status(502).json({
      ok: false,
      error: "mtr_md_error",
      detail: err.message,
    });
  }
}
