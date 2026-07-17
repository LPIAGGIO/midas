/**
 * Worker rem-sync: actualiza el REM (Relevamiento de Expectativas de Mercado
 * del BCRA) oficial en la tabla Supabase `rem_forecasts`.
 *
 * Antes se cargaba a mano leyendo el Excel del BCRA con Excel COM. Este worker
 * lo automatiza: baja el xlsx mensual, parsea la mediana de tipo de cambio e
 * IPC (nivel general) por mes, y hace UPSERT idempotente en rem_forecasts.
 *
 * FUENTE: el Excel mensual del BCRA. URL real (descubierta scrapeando la
 * pagina del REM): lleva /archivos/.../informes/ y el mes en abreviatura
 * espaniola de 3 letras (may, no mayo):
 *   https://www.bcra.gob.ar/archivos/Pdfs/PublicacionesEstadisticas/informes/
 *     tablas-relevamiento-expectativas-mercado-{mes}-{anio}.xlsx
 * Hoja "Cuadros de resultados". Tomamos:
 *   - "Tipo de cambio nominal" (mediana $/USD por mes)  -> variable tipo_cambio
 *   - "Precios minoristas (IPC nivel general...)"        -> variable ipc
 *     (OJO: hay tambien "IPC nucleo" mas abajo; NO es esa)
 * Solo importan las filas mensuales (col Periodo = serial Excel fin de mes);
 * se descartan los agregados anuales ("2026", "prox. 12 meses", "Trim. I-26").
 *
 * LAG: el REM sale con ~1 mes de atraso (la encuesta de mayo se publica a
 * principios de junio). El worker arranca en el mes corriente y camina hacia
 * atras hasta encontrar el xlsx mas reciente que exista (200 + magic bytes).
 *
 * IDEMPOTENTE: upsert por (variable, period_date) -> re-correr con la misma
 * encuesta no duplica ni deja la tabla vacia. Tras el upsert, borra de cada
 * variable las filas de encuestas viejas (cleanup de meses que salieron de la
 * ventana del nuevo REM).
 *
 * Schedule: PM2 cron_restart (ver ecosystem.config.js). Corre varios dias a
 * principios de mes para captar la publicacion sin depender del dia exacto.
 *
 * Override manual:
 *   SURVEY=may-2026 node worker.js     (forzar una encuesta puntual / backfill)
 */
require("dotenv").config();
const XLSX = require("xlsx");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan vars de entorno (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Verifica .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const BASE_URL =
  "https://www.bcra.gob.ar/archivos/Pdfs/PublicacionesEstadisticas/informes/" +
  "tablas-relevamiento-expectativas-mercado";

// Cuantos meses hacia atras probar desde el mes corriente al buscar el xlsx.
const LOOKBACK_MONTHS = 5;

// Rangos sanos para no escribir basura si el BCRA cambia el formato.
const SANITY = {
  tipo_cambio: { min: 300, max: 20000, minRows: 4 }, // $/USD
  ipc: { min: -10, max: 60, minRows: 4 }, // var % mensual
};

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function urlForSurvey(survey) {
  return `${BASE_URL}-${survey}.xlsx`;
}

// Mes corriente en TZ Argentina, como {mes, anio}.
function nowAr() {
  const ar = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })
  );
  return { mes: ar.getMonth(), anio: ar.getFullYear() };
}

function surveyLabel(mesIdx, anio) {
  return `${MESES[mesIdx]}-${anio}`;
}

// Serial Excel (sistema 1900) -> 'YYYY-MM-DD' UTC. 25569 = 1970-01-01 y ya
// contempla el bug del anio bisiesto 1900 para fechas posteriores a marzo 1900.
function excelSerialToISODate(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

// Baja el xlsx de una encuesta. Devuelve el buffer si existe (200 + magic bytes
// PK de zip/xlsx), o null si 404 / soft-404 (la pagina de error es text/html).
async function fetchXlsx(survey) {
  const url = urlForSurvey(survey);
  let r;
  try {
    r = await fetch(url, { headers: { "User-Agent": "Midas/0.1 rem-sync" }, redirect: "follow" });
  } catch (e) {
    log(`  ${survey}: error de red (${e.message})`);
    return null;
  }
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  // xlsx es un zip -> empieza con 'PK' (0x50 0x4B). Asi descartamos soft-404.
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    log(`  ${survey}: respuesta 200 pero no es xlsx (${buf.length} bytes), ignoro`);
    return null;
  }
  return buf;
}

// Busca el xlsx mas reciente disponible caminando hacia atras desde el mes
// corriente. Devuelve { survey, buf } o lanza si no encuentra ninguno.
async function findLatestSurvey() {
  const override = process.env.SURVEY && process.env.SURVEY.trim();
  if (override) {
    log(`SURVEY override = ${override}`);
    const buf = await fetchXlsx(override);
    if (!buf) throw new Error(`No se pudo bajar el xlsx para SURVEY=${override}`);
    return { survey: override, buf };
  }

  const { mes, anio } = nowAr();
  for (let back = 0; back <= LOOKBACK_MONTHS; back++) {
    let m = mes - back;
    let y = anio;
    while (m < 0) {
      m += 12;
      y -= 1;
    }
    const survey = surveyLabel(m, y);
    log(`probando ${survey} ...`);
    const buf = await fetchXlsx(survey);
    if (buf) {
      log(`encontrado REM ${survey} (${buf.length} bytes)`);
      return { survey, buf };
    }
  }
  throw new Error(
    `No se encontro ningun xlsx del REM en los ultimos ${LOOKBACK_MONTHS + 1} meses`
  );
}

// Extrae las filas mensuales de una seccion de la hoja. titleRegex matchea el
// titulo de la seccion en la col 0. Ademas de la mediana levanta (si estan)
// promedio, desvio, p90, p10 y participantes — el cuadro del REM las trae y
// rem_tc_history las guarda para la pantalla "REM vs Real".
function extractSection(rows, titleRegex, label) {
  const titleRow = rows.findIndex(
    (r) => r && typeof r[0] === "string" && titleRegex.test(r[0])
  );
  if (titleRow < 0) throw new Error(`No encontre la seccion "${label}" en la hoja`);

  const header = rows[titleRow + 1] || [];
  if (!(typeof header[0] === "string" && /per[ií]odo/i.test(header[0]))) {
    throw new Error(`Fila de header inesperada bajo "${label}" (fila ${titleRow + 1})`);
  }
  const findCol = (re) => header.findIndex((c) => typeof c === "string" && re.test(c));
  const medianaCol = findCol(/mediana/i);
  if (medianaCol < 0) throw new Error(`No encontre la columna "Mediana" en "${label}"`);
  const promedioCol = findCol(/promedio/i);
  const desvioCol = findCol(/desv[ií]o/i);
  const p90Col = findCol(/90/);
  const p10Col = findCol(/10/);
  const partCol = findCol(/participantes|cantidad/i);
  const num = (row, col) => {
    if (col < 0) return null;
    const v = Number(row[col]);
    return Number.isFinite(v) ? v : null;
  };

  const out = [];
  for (let i = titleRow + 2; i < rows.length; i++) {
    const row = rows[i] || [];
    const isBlank = row.every((c) => c === null || c === undefined || c === "");
    if (isBlank) break; // fin del bloque de la seccion
    const periodo = row[0];
    // Solo filas mensuales: col Periodo es un serial Excel numerico.
    // Los agregados ("2026", "prox. 12 meses", "Trim. I-26") son texto.
    if (typeof periodo !== "number" || !Number.isFinite(periodo)) continue;
    const mediana = Number(row[medianaCol]);
    if (!Number.isFinite(mediana)) continue;
    out.push({
      period_date: excelSerialToISODate(periodo),
      mediana,
      promedio: num(row, promedioCol),
      desvio: num(row, desvioCol),
      p90: num(row, p90Col),
      p10: num(row, p10Col),
      participantes: num(row, partCol),
    });
  }
  return out;
}

function checkSanity(variable, rows) {
  const s = SANITY[variable];
  if (rows.length < s.minRows) {
    throw new Error(`${variable}: solo ${rows.length} filas (esperaba >= ${s.minRows}); aborto`);
  }
  for (const r of rows) {
    if (r.mediana < s.min || r.mediana > s.max) {
      throw new Error(
        `${variable}: mediana fuera de rango (${r.mediana} en ${r.period_date}); aborto`
      );
    }
  }
}

async function upsertVariable(variable, survey, rows) {
  const payload = rows.map((r) => ({
    variable,
    period_date: r.period_date,
    mediana: r.mediana,
    survey,
  }));
  const { error: upErr } = await supabase
    .from("rem_forecasts")
    .upsert(payload, { onConflict: "variable,period_date" });
  if (upErr) throw new Error(`upsert ${variable}: ${upErr.message}`);

  // Cleanup: borra filas viejas de esta variable que no sean del survey nuevo
  // (meses que salieron de la ventana del REM corriente).
  const { error: delErr, count } = await supabase
    .from("rem_forecasts")
    .delete({ count: "exact" })
    .eq("variable", variable)
    .neq("survey", survey);
  if (delErr) throw new Error(`cleanup ${variable}: ${delErr.message}`);

  log(`  ${variable}: ${payload.length} upserted, ${count || 0} viejas borradas`);
}

// ----- Refresh de la pantalla "REM vs Real" (rem_tc_history + usd_mayorista_monthly) -----

// survey "jun-2026" -> survey_date = ultimo dia HABIL (lun-vie) del mes de la
// encuesta. Es la convencion de la carga historica (ej: may-2026 -> 2026-05-29).
function surveyDateFor(survey) {
  const m = String(survey).match(/^([a-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mesIdx = MESES.indexOf(m[1]);
  if (mesIdx < 0) return null;
  const anio = Number(m[2]);
  const d = new Date(Date.UTC(anio, mesIdx + 1, 0)); // ultimo dia del mes
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Upsert de la encuesta corriente en rem_tc_history (historial de encuestas,
// NO se borra lo viejo: la pantalla "REM vs Real" compara encuestas pasadas
// contra lo que efectivamente paso).
async function upsertTcHistory(survey, tcRows) {
  const survey_date = surveyDateFor(survey);
  if (!survey_date) {
    log(`  rem_tc_history: no pude derivar survey_date de "${survey}", salteo`);
    return;
  }
  const payload = tcRows.map((r) => ({
    survey_date,
    period_month: r.period_date.slice(0, 7) + "-01",
    mediana: r.mediana,
    promedio: r.promedio,
    desvio: r.desvio,
    p90: r.p90,
    p10: r.p10,
    participantes: r.participantes != null ? Math.round(r.participantes) : null,
  }));
  const { error } = await supabase
    .from("rem_tc_history")
    .upsert(payload, { onConflict: "survey_date,period_month" });
  if (error) throw new Error(`upsert rem_tc_history: ${error.message}`);
  log(`  rem_tc_history: encuesta ${survey} (${survey_date}) -> ${payload.length} meses`);
}

// Recalcula usd_mayorista_monthly (promedio y cierre mensual del A3500) para
// los ultimos N meses desde la API del BCRA (v4, idVariable=5). Idempotente.
async function refreshMayoristaMonthly(monthsBack = 3) {
  const { mes, anio } = nowAr();
  const desde = new Date(Date.UTC(anio, mes - monthsBack, 1)).toISOString().slice(0, 10);
  const url = `https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias/5?desde=${desde}&limit=3000`;
  let detalle;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Midas/0.1 rem-sync" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    detalle = j?.results?.[0]?.detalle || j?.results || [];
    // v4 puede devolver results como array de {fecha, valor} directo segun endpoint
    if (detalle.length && detalle[0].detalle) detalle = detalle[0].detalle;
  } catch (e) {
    log(`  usd_mayorista_monthly: BCRA var 5 fallo (${e.message}), salteo`);
    return;
  }
  const byMonth = new Map();
  for (const d of detalle) {
    const fecha = String(d.fecha || "").slice(0, 10);
    const valor = Number(d.valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(valor) || valor <= 0) continue;
    const month = fecha.slice(0, 7) + "-01";
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push({ fecha, valor });
  }
  const payload = [];
  for (const [month, rows] of byMonth) {
    rows.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
    const avg = rows.reduce((s, r) => s + r.valor, 0) / rows.length;
    payload.push({ month, avg_a3500: avg, eom_a3500: rows[rows.length - 1].valor, days: rows.length });
  }
  if (!payload.length) { log("  usd_mayorista_monthly: sin datos, salteo"); return; }
  const { error } = await supabase.from("usd_mayorista_monthly").upsert(payload, { onConflict: "month" });
  if (error) throw new Error(`upsert usd_mayorista_monthly: ${error.message}`);
  log(`  usd_mayorista_monthly: ${payload.length} meses refrescados (${payload.map((p) => p.month.slice(0, 7)).join(", ")})`);
}

async function main() {
  log("rem-sync arrancando");
  const { survey, buf } = await findLatestSurvey();

  const wb = XLSX.read(buf, { type: "buffer", cellDates: false });
  const sheetName =
    wb.SheetNames.find((n) => /cuadros de resultados/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
    header: 1,
    raw: true,
    defval: null,
  });

  const tc = extractSection(rows, /^Tipo de cambio nominal/i, "Tipo de cambio nominal");
  // OJO: "IPC nivel general", NO "IPC nucleo".
  const ipc = extractSection(
    rows,
    /^Precios minoristas \(IPC nivel general/i,
    "IPC nivel general"
  );

  checkSanity("tipo_cambio", tc);
  checkSanity("ipc", ipc);

  log(
    `parseado ${survey}: tipo_cambio=${tc.length} meses (${tc[0].period_date}..${tc[tc.length - 1].period_date}), ` +
      `ipc=${ipc.length} meses (${ipc[0].period_date}..${ipc[ipc.length - 1].period_date})`
  );

  await upsertVariable("tipo_cambio", survey, tc);
  await upsertVariable("ipc", survey, ipc);

  // Pantalla "REM vs Real": historial de encuestas + mayorista mensual real.
  await upsertTcHistory(survey, tc);
  await refreshMayoristaMonthly();

  log("rem-sync OK");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] fatal:`, err.message || err);
    process.exit(1);
  });
