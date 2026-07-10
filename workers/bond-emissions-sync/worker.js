"use strict";

/* ---------------------------------------------------------------
 * Worker: bond-emissions-sync
 *
 * Scrapea argentina.gob.ar/noticias/resultado-de-la-licitacion-* y
 * extrae las caracteristicas de cada Lecap/Boncap emitido:
 *   - ticker (e.g. T30J6, S29Y6)
 *   - tipo (lecap | boncap)
 *   - fecha de vencimiento (parseada del titulo de la fila)
 *   - TEM de capitalizacion (parseada de las footnotes)
 *   - precio de corte (PC) y TIREA (parseados de la tabla)
 *
 * De ahi deriva el pago al vencimiento por 100 VN:
 *   pago_vto = PC × (1 + TIREA)^(years_remaining_at_auction)
 *
 * Lo persiste en la tabla bond_emissions (PK ticker). En auctions
 * multiples del mismo bono (reaperturas), validamos consistencia y
 * mantenemos los metadatos first_/last_.
 *
 * Modos:
 *   - default:        5 paginas del buscador (~ultimas 2 semanas)
 *   - --backfill:     30 paginas (~12 meses) + seed URLs hardcoded
 *   - --dry-run:      parsea pero no escribe a Supabase
 *   - --verbose:      logs detallados
 *
 * NO es agente: no opera nada. Solo cataloga datos publicos del
 * Tesoro.
 * --------------------------------------------------------------- */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Supabase JS necesita WebSocket en Node < 22.
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = require("ws");
}

// ----- Config -----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const GOB_BASE = "https://www.argentina.gob.ar";
const FETCH_TIMEOUT_MS = 25000;
const SLEEP_BETWEEN_FETCHES_MS = 600;  // ser amable con el servidor
const PAGE_SIZE = 20;

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const FULL_BACKFILL = process.argv.includes("--backfill");
const MAX_PAGES = FULL_BACKFILL ? 30 : 5;

// Seed URLs conocidas (bootstrap inicial sin depender 100% del buscador).
// Sacadas via web_search; cubren los articulos del Tesoro de los ultimos
// ~18 meses con bonos relevantes para el universo activo.
// Si el buscador anda, va a encontrar mas; si no, con estos 13 ya tenemos
// la mayoria de bonos activos.
const SEED_PATHS = [
  // 2024
  "/noticias/resultado-de-la-licitacion-de-lecap-boncap-y-boncer",
  // 2025 H1
  "/noticias/resultado-de-la-licitacion-de-lecap-boncap-boncer-y-lelink",
  "/noticias/resultado-de-la-licitacion-de-lecap-boncap-letra-tamar-y-boncer-por-efectivo-y-conversion",
  "/noticias/resultado-de-la-licitacion-de-lecap-y-boncap",
  // 2025 H2
  "/noticias/resultado-de-la-licitacion-de-lecap-boncap-boncer-y-lelink-1",
  "/noticias/resultado-de-la-licitacion-de-de-lecap-boncap-boncer-lelink-y-dolar-linked",
  "/noticias/resultado-de-la-licitacion-de-lecap-boncap-boncer-y-dolar-linked",
  "/noticias/resultado-de-la-licitacion-de-lecap-boncap-lelink-y-bono-dolar-linked",
  "/noticias/resultado-de-licitacion-de-lecap-boncap-y-lelink",
  "/noticias/resultado-de-licitacion-de-lecap-boncap-boncer-letamar-bono-tamar-y-lelink",
  // 2026
  "/noticias/resultado-de-la-licitacion-de-instrumentos-del-tesoro-nacional-denominados-en-pesos-y-0",
];

// ----- Sanity -----
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[bond-emissions-sync] FATAL: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
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
const err  = (m) => log("ERROR", m);
const dbg  = (m) => { if (VERBOSE) log("DBG", m); };

// ----- Helpers -----
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const SPANISH_MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function parseSpanishDate(text) {
  // "25 de junio de 2025" -> "2025-06-25"
  // Tolerante a case y a espacios extra. "&nbsp;" se reemplaza upstream.
  const m = text.match(/(\d{1,2})\s+de\s+(\w+)\s+de\s+(\d{4})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = SPANISH_MONTHS[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateDiffDays(isoLater, isoEarlier) {
  const d1 = new Date(isoLater + "T00:00:00Z");
  const d2 = new Date(isoEarlier + "T00:00:00Z");
  return (d1 - d2) / 86400000;
}

function parseSpanishNumber(s) {
  // Formato europeo: punto como separador de miles, coma como decimal.
  //   "1.436,10" -> 1436.10
  //   "40,53"    -> 40.53
  //   "1000"     -> 1000 (sin separadores)
  if (s == null) return NaN;
  const t = String(s).trim();
  if (!t) return NaN;
  if (t.includes(",")) {
    return parseFloat(t.replace(/\./g, "").replace(",", "."));
  }
  return parseFloat(t);
}

/**
 * Strip HTML to plaintext, manteniendo estructura de tabla via pipes.
 * Convierte:
 *   <td>A</td><td>B</td> -> "A | B"
 *   <tr>...</tr>          -> termina en newline
 *   demas tags se descartan, entidades comunes se decodifican.
 */
function stripHtmlToText(html) {
  return html
    // Cells: separador con pipe
    .replace(/<\/td>\s*<td[^>]*>/gi, " | ")
    .replace(/<td[^>]*>/gi, "")
    .replace(/<\/td>/gi, " | ")
    // Rows: newline al cierre
    .replace(/<tr[^>]*>/gi, "")
    .replace(/<\/tr>/gi, "\n")
    // Lista: cada item en su linea
    .replace(/<\/li>\s*<li[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "")
    .replace(/<\/li>/gi, "\n")
    // Headers/parrafos como newlines
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/h\d>/gi, "\n")
    // Stripear todos los demas tags
    .replace(/<[^>]+>/g, " ")
    // Entidades HTML comunes
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    // Normalizar espacios (preservar newlines)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

// ----- HTTP -----
async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        // UA "browser real" - el buscador de gob.ar tira 403 con UAs
        // identificandose como bot. Fetches de articulos individuales
        // andan con casi cualquier UA, pero el endpoint /buscador es
        // mas estricto. Esto es scraping de datos publicos en bajisima
        // frecuencia (1x cada 3-4 dias), nada agresivo.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9,en;q=0.8",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

// ----- Discovery: encontrar URLs de licitacion -----
async function discoverLicitationUrls() {
  const urls = new Set();

  // 1. Seeds hardcodeados (siempre incluidos)
  for (const path of SEED_PATHS) {
    urls.add(`${GOB_BASE}${path}`);
  }
  info(`Seeds: ${SEED_PATHS.length} URLs precargadas`);

  // 2. Discovery via buscador de gob.ar
  for (let page = 0; page < MAX_PAGES; page++) {
    const desde = page * PAGE_SIZE;
    const searchUrl = `${GOB_BASE}/buscador?cant=${PAGE_SIZE}&desde=${desde}&keywords=resultado%20licitacion%20lecap%20boncap`;
    let html;
    try {
      html = await fetchText(searchUrl);
    } catch (e) {
      warn(`buscador page ${page} fallo: ${e.message}`);
      break;
    }
    // Match a links que apuntan a noticias de licitacion. Regex tolerante
    // a "resultado-de" o "resultado-de-la" (ambas formas aparecen).
    const matches = [...html.matchAll(
      /href="(\/noticias\/resultado-de[^"]*licitacion[^"]*)"/gi
    )];
    let foundNew = 0;
    for (const m of matches) {
      const path = m[1].split("?")[0].split("#")[0];
      const full = `${GOB_BASE}${path}`;
      if (!urls.has(full)) {
        urls.add(full);
        foundNew++;
      }
    }
    info(`buscador page ${page}: ${matches.length} matches, ${foundNew} nuevas (total ${urls.size})`);
    if (foundNew === 0 && page > 0) break;
    await sleep(SLEEP_BETWEEN_FETCHES_MS);
  }

  return [...urls];
}

// ----- Parser de un articulo individual -----
/**
 * Parsea el HTML de un articulo de licitacion y devuelve:
 *   { fecha_articulo: "2025-06-25", bondMentions: [...] }
 *
 * Cada bondMention tiene:
 *   { ticker, type, tem_capitalizacion, fecha_vencimiento,
 *     precio_corte, tirea_anual }
 *
 * Estrategia:
 *   1) Stripear HTML a texto con pipes en tablas
 *   2) Sacar la fecha del articulo (primer "DD de MES de YYYY")
 *   3) Footnotes: regex de "LECAP/BONCAP TICKER capitaliza a una TEM
 *      de Y,YY%" -> mapa ticker -> {type, tem}
 *   4) Para cada ticker conocido, buscar su row en la tabla y extraer
 *      vto (texto), PC y TIREA (entre pipes)
 *   5) Devolver solo los bonds que tienen footnote + row data
 */
function parseArticle(html, url) {
  const text = stripHtmlToText(html);

  // 1. Fecha del articulo. En articulos de gob.ar aparece justo despues
  // del titulo, formato "DD de MES de YYYY". Tomamos el PRIMER match.
  const dateMatch = text.match(
    /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+de\s+(\d{4})/i
  );
  const fecha_articulo = dateMatch ? parseSpanishDate(dateMatch[0]) : null;
  if (!fecha_articulo) {
    dbg(`No pude parsear fecha en ${url}`);
    return null;
  }

  // 2. Footnotes con TEM de capitalizacion.
  // Patron: "(N) TEM de corte X,XX%. LA/EL LECAP/BONCAP TICKER capitaliza
  // a una TEM de Y,YY% desde la fecha de emision hasta su vencimiento"
  const footnoteRegex = /(?:LA|EL|La|El|la|el)\s+(LECAP|BONCAP)\s+([A-Z]{1,2}\d{1,2}[A-Z]\d)\s+capitaliza\s+a\s+una\s+TEM\s+de\s+([\d.,]+)\s*%/gi;
  const temByTicker = new Map();
  let m;
  while ((m = footnoteRegex.exec(text)) !== null) {
    const type = m[1].toLowerCase();
    const ticker = m[2].toUpperCase();
    const tem_pct = parseSpanishNumber(m[3]);
    if (!Number.isFinite(tem_pct) || tem_pct <= 0 || tem_pct > 100) {
      dbg(`TEM invalida para ${ticker}: ${m[3]}`);
      continue;
    }
    // Validacion: el prefijo del ticker debe ser consistente con el tipo.
    // S* prefix = lecap (corto plazo), T* prefix = boncap (mayor a 1 anio).
    // Si no concuerdan, es typo del articulo - vimos casos donde S30N6
    // aparece referenciado como "LECAP" y "BONCAP" en el mismo articulo.
    // Ignoramos el footnote inconsistente para no corromper la data.
    const prefix = ticker[0];
    const expectedType = prefix === "S" ? "lecap" : prefix === "T" ? "boncap" : null;
    if (expectedType && type !== expectedType) {
      warn(`${ticker}: footnote dice ${type} pero el ticker tiene prefijo ${prefix} (esperaba ${expectedType}) - probable typo en el articulo, ignorando este footnote`);
      continue;
    }
    // Si ya hay un footnote para este ticker, no sobreescribir (preservar el primero).
    if (!temByTicker.has(ticker)) {
      temByTicker.set(ticker, { type, tem: tem_pct / 100 });
    }
  }

  if (temByTicker.size === 0) {
    dbg(`Sin footnotes de TEM en ${url}`);
    return null;
  }

  // 3. Filas de la tabla como unidades atomicas.
  //
  // El formato cambio en oct/nov 2025 - articulos viejos tienen
  // "(TICKER - reapertura) (N)" donde (N) es el footnote ref, articulos
  // nuevos solo tienen "(TICKER - reapertura)". Ademas para emisiones
  // nuevas la columna "Precio / TEM" puede traer la TEM directamente
  // (e.g. "2,5%") en vez del precio de corte ("$ 1.148,70"). En esos
  // casos el bono no tiene footnote y PC = 1000 por convencion (es
  // emision original a la par).
  //
  // El regex captura:
  //   m[1] = LETRA | BONO
  //   m[2] = dia vto
  //   m[3] = mes vto (texto)
  //   m[4] = anio vto
  //   m[5] = ticker
  //   m[6] = "reapertura" | "nueva" | undefined
  //   m[7] = celda PC/TEM como texto crudo
  //   m[8] = TIREA
  const rowRegex = /(LETRA|BONO)\s+DEL\s+TESORO\s+NACIONAL\s+CAPITALIZABLE\s+EN\s+PESOS\s+CON\s+VENCIMIENTO\s+(\d{1,2})\s+DE\s+(\w+)\s+DE\s+(\d{4})\s+\(([A-Z]{1,2}\d{1,2}[A-Z]\d)(?:\s*[-\u2013]\s*(reapertura|nueva))?\s*\)(?:\s*\(\d+\))?[^|]*\|[^|]*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|\s*([\d.,]+)\s*%/gi;

  const bondMentions = [];
  while ((m = rowRegex.exec(text)) !== null) {
    const rowType = m[1]; // "LETRA" o "BONO"
    const ticker = m[5].toUpperCase();
    const emissionLabel = m[6] ? m[6].toLowerCase() : null; // "reapertura" | "nueva" | null
    const pcOrTemRaw = m[7].trim();
    const tirea_pct = parseSpanishNumber(m[8]);

    // Detectar si la columna 5 trae TEM (X,XX%) o Precio ($ X.XXX,XX).
    // Si tiene %, es una emision nueva con la TEM en la columna.
    const isTemColumn = /%/.test(pcOrTemRaw);

    let pc; // precio de corte por VNO 1000
    let tem; // TEM de capitalizacion (decimal)
    let type; // "lecap" | "boncap"

    const footnote = temByTicker.get(ticker);

    if (isTemColumn) {
      // Nueva emision: TEM en la columna, PC = 1000 por convencion (par).
      const temFromCol = parseSpanishNumber(pcOrTemRaw.replace(/%/g, ""));
      if (!Number.isFinite(temFromCol) || temFromCol <= 0 || temFromCol > 100) {
        dbg(`${ticker}: TEM-en-columna invalida (${pcOrTemRaw})`);
        continue;
      }
      pc = 1000;
      tem = (footnote ? footnote.tem * 100 : temFromCol) / 100;
      type = footnote ? footnote.type : (rowType === "LETRA" ? "lecap" : "boncap");
    } else {
      // Reapertura tipica: precio de corte en columna, TEM en footnote.
      const pcNum = parseSpanishNumber(pcOrTemRaw.replace(/[$\s]/g, ""));
      if (!Number.isFinite(pcNum) || pcNum <= 0) {
        dbg(`${ticker}: PC invalido (${pcOrTemRaw})`);
        continue;
      }
      if (!footnote) {
        // Sin footnote = no podemos saber la TEM. Skip.
        // (Para reaperturas la TEM SIEMPRE viene en footnote.)
        dbg(`${ticker}: reapertura/sin-marca sin footnote TEM - skip`);
        continue;
      }
      pc = pcNum;
      tem = footnote.tem;
      type = footnote.type;
    }

    // Validar TIREA
    if (!Number.isFinite(tirea_pct) || tirea_pct <= 0 || tirea_pct > 500) {
      dbg(`${ticker}: TIREA invalida (${m[8]})`);
      continue;
    }

    // Validar fecha de vencimiento
    const vtoDate = parseSpanishDate(`${m[2]} de ${m[3]} de ${m[4]}`);
    if (!vtoDate) {
      dbg(`${ticker}: vto invalido (${m[2]} ${m[3]} ${m[4]})`);
      continue;
    }

    bondMentions.push({
      ticker,
      type,
      tem_capitalizacion: tem,
      fecha_vencimiento: vtoDate,
      precio_corte: pc,
      tirea_anual: tirea_pct / 100,
      emission_label: emissionLabel,
    });
  }

  if (bondMentions.length === 0) {
    dbg(`Sin bonos parseables en ${url} (footnotes=${temByTicker.size})`);
  }

  return { fecha_articulo, bondMentions };
}

// ----- Calculo del pago al vencimiento -----
/**
 * Computa el pago al vencimiento por 100 VN.
 *
 * pago_vto_por_1000VN = PC × (1 + TIREA)^(years_remaining_at_auction)
 * pago_vto_por_100VN  = pago_vto_por_1000VN / 10
 *
 * Esto es invariante del bono: pega lo mismo en cualquier auction
 * (original o reapertura), porque tanto PC como TIREA reflejan el
 * "estado" del bono en ese momento.
 */
function computePagoVencimiento(pc, tirea, fecha_auction, fecha_vto) {
  const days = dateDiffDays(fecha_vto, fecha_auction);
  if (days <= 0) return null;
  const years = days / 365;
  const pagoPor1000 = pc * Math.pow(1 + tirea, years);
  return pagoPor1000 / 10;
}

// ----- Upsert en Supabase -----
async function upsertEmission(record) {
  const {
    ticker, type, tem_capitalizacion, fecha_vencimiento,
    pago_vencimiento, fecha_articulo, source_url,
  } = record;

  // 1. Leer registro existente
  const { data: existing, error: selErr } = await supabase
    .from("bond_emissions")
    .select("*")
    .eq("ticker", ticker)
    .maybeSingle();

  if (selErr) {
    warn(`select ${ticker}: ${selErr.message}`);
    return { action: "error" };
  }

  if (!existing) {
    // 2a. Insert nuevo
    const row = {
      ticker,
      type,
      fecha_vencimiento,
      tem_capitalizacion,
      pago_vencimiento,
      first_auction_date: fecha_articulo,
      first_source_url: source_url,
      last_auction_date: fecha_articulo,
      last_source_url: source_url,
    };
    if (DRY_RUN) {
      info(`[DRY] insert ${ticker} (${type}) pago_vto=${pago_vencimiento.toFixed(4)} vto=${fecha_vencimiento}`);
      return { action: "insert" };
    }
    const { error: insErr } = await supabase.from("bond_emissions").insert(row);
    if (insErr) {
      warn(`insert ${ticker}: ${insErr.message}`);
      return { action: "error" };
    }
    info(`insert ${ticker} (${type}) pago_vto=${pago_vencimiento.toFixed(4)} vto=${fecha_vencimiento}`);
    return { action: "insert" };
  }

  // 2b. Update: mantener first_* viejos, actualizar last_* si es mas nuevo.
  // Validar drift del pago_vencimiento (debe ser invariante; >1% = log).
  const newer = fecha_articulo > existing.last_auction_date;
  const earlier = fecha_articulo < existing.first_auction_date;
  const drift = Math.abs(pago_vencimiento - Number(existing.pago_vencimiento)) /
                Number(existing.pago_vencimiento);
  if (drift > 0.01) {
    warn(`${ticker}: drift ${(drift * 100).toFixed(2)}% (existing ${Number(existing.pago_vencimiento).toFixed(4)}, new ${pago_vencimiento.toFixed(4)}) - articulo ${source_url}`);
  }

  const update = { last_seen_at: new Date().toISOString() };
  if (newer) {
    update.last_auction_date = fecha_articulo;
    update.last_source_url = source_url;
    // Refrescamos pago_vencimiento al mas reciente (mas relevante para
    // el estado actual; ya validamos arriba que no varia mucho).
    update.pago_vencimiento = pago_vencimiento;
  }
  if (earlier) {
    update.first_auction_date = fecha_articulo;
    update.first_source_url = source_url;
  }
  if (Object.keys(update).length === 1) {
    dbg(`${ticker}: sin cambios materiales`);
    return { action: "noop" };
  }
  if (DRY_RUN) {
    info(`[DRY] update ${ticker}: ${JSON.stringify(update)}`);
    return { action: "update" };
  }
  const { error: updErr } = await supabase
    .from("bond_emissions")
    .update(update)
    .eq("ticker", ticker);
  if (updErr) {
    warn(`update ${ticker}: ${updErr.message}`);
    return { action: "error" };
  }
  info(`update ${ticker} (newer=${newer} earlier=${earlier})`);
  return { action: "update" };
}

// ----- Main -----
async function main() {
  info(`bond-emissions-sync arrancando (DRY=${DRY_RUN}, BACKFILL=${FULL_BACKFILL}, VERBOSE=${VERBOSE})`);

  const urls = await discoverLicitationUrls();
  info(`Descubri ${urls.length} URLs de licitacion`);

  const stats = { fetched: 0, parsed: 0, inserts: 0, updates: 0, noops: 0, errors: 0 };

  for (const url of urls) {
    let html;
    try {
      html = await fetchText(url);
      stats.fetched++;
    } catch (e) {
      warn(`fetch ${url}: ${e.message}`);
      stats.errors++;
      await sleep(SLEEP_BETWEEN_FETCHES_MS);
      continue;
    }

    const parsed = parseArticle(html, url);
    if (!parsed) {
      dbg(`Skip ${url} (no se pudo parsear)`);
      await sleep(SLEEP_BETWEEN_FETCHES_MS);
      continue;
    }
    stats.parsed++;
    dbg(`${url}: fecha=${parsed.fecha_articulo}, bonds=${parsed.bondMentions.length}`);

    for (const mention of parsed.bondMentions) {
      const pago = computePagoVencimiento(
        mention.precio_corte,
        mention.tirea_anual,
        parsed.fecha_articulo,
        mention.fecha_vencimiento
      );
      if (pago == null || !Number.isFinite(pago) || pago <= 0) {
        warn(`No pude computar pago_vto para ${mention.ticker} en ${url}`);
        stats.errors++;
        continue;
      }

      const result = await upsertEmission({
        ticker: mention.ticker,
        type: mention.type,
        tem_capitalizacion: mention.tem_capitalizacion,
        fecha_vencimiento: mention.fecha_vencimiento,
        pago_vencimiento: pago,
        fecha_articulo: parsed.fecha_articulo,
        source_url: url,
      });
      if (result.action === "insert") stats.inserts++;
      else if (result.action === "update") stats.updates++;
      else if (result.action === "noop") stats.noops++;
      else if (result.action === "error") stats.errors++;
    }

    await sleep(SLEEP_BETWEEN_FETCHES_MS);
  }

  info(`Listo. Stats: ${JSON.stringify(stats)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    err(`fatal: ${e.message}`);
    if (e.stack) err(e.stack);
    process.exit(1);
  });
