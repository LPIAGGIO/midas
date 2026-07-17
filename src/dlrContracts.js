/**
 * Mapa de contratos de Dólar Futuro (DLR) de Matba-Rofex.
 *
 * Convención de tickers Matba-Rofex: DLR/{MES_3LETRAS}{AA}, donde el mes es
 * en español (ABR, MAY, JUN, JUL, AGO, SEP, OCT, NOV, DIC, ENE, FEB, MAR).
 * Aquí los normalizamos sin "/" para usar como id: "DLRMAY26".
 *
 * Vencimiento: último día hábil del mes del contrato (regla MtR).
 * Liquidación: contra Comunicación BCRA "A 3500" (mayorista), en pesos por
 * cada USD 1 del contrato (1.000 USD por contrato es el tamaño físico).
 *
 * Excluidos del registry:
 *   - DLR/...M (posiciones "Mayoristas" — duplican la curva, mismo precio)
 *   - DLR/{MES1}/{MES2} (rolls / spreads entre dos vencimientos)
 *   - contratos ya vencidos (se podan al refrescar los seeds)
 *
 * Seed actualizado al 16/07/2026 con settlements de mtr_market_data (feed A3).
 * Spot mayorista (A3500) al mismo día: $1.474,8.
 *
 * El registry sirve como fallback. La UI permite al usuario actualizar
 * los precios manualmente y los persiste en localStorage hasta que
 * tengamos un endpoint público que los devuelva en JSON.
 */

const MONTH_LETTER_AR = {
  ENE: 1, FEB: 2,  MAR: 3,  ABR: 4,  MAY: 5,  JUN: 6,
  JUL: 7, AGO: 8,  SEP: 9,  OCT: 10, NOV: 11, DIC: 12,
};

/**
 * Último día hábil del mes (lun-vie, sin feriados argentinos).
 * Aproximación razonable: si el último día calendario cae sábado,
 * retrocedo a viernes; si cae domingo, retrocedo a viernes.
 * Para vencimientos exactos consultar calendario MtR.
 */
function lastBusinessDayOfMonth(year, month) {
  // month es 1-12
  const d = new Date(Date.UTC(year, month, 0)); // día 0 del mes siguiente = último día del mes
  const dow = d.getUTCDay(); // 0=dom, 6=sab
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Decodifica el sufijo MES+AA y devuelve { year, month, maturityDate }.
 * Ejemplo: "MAY26" → { year: 2026, month: 5, maturityDate: "2026-05-29" }
 */
function decodeDlrSuffix(suffix) {
  const m = /^([A-Z]{3})(\d{2})$/.exec(suffix);
  if (!m) return null;
  const month = MONTH_LETTER_AR[m[1]];
  const year = 2000 + parseInt(m[2], 10);
  if (!month) return null;
  return { year, month, maturityDate: lastBusinessDayOfMonth(year, month) };
}

// Lista canónica de contratos con sus precios seed (= settlement A3 del
// 16/07/2026, tomados de mtr_market_data). Los seeds son SOLO fallback si el
// feed/worker no responde; la UI los pisa con el precio live. Al refrescarlos,
// actualizar también DLR_SPOT_SEED y DLR_SEED_DATE.
// MANTENIMIENTO: cuando A3 liste un contrato nuevo (hoy el último es ABR27),
// agregarlo acá — las pantallas (curva, sintético, scalping) iteran este registry.
const DLR_SEED_RAW = [
  { suffix: "JUL26", priceSeed: 1483.0 },
  { suffix: "AGO26", priceSeed: 1510.0 },
  { suffix: "SEP26", priceSeed: 1536.0 },
  { suffix: "OCT26", priceSeed: 1564.0 },
  { suffix: "NOV26", priceSeed: 1594.0 },
  { suffix: "DIC26", priceSeed: 1624.0 },
  { suffix: "ENE27", priceSeed: 1654.0 },
  { suffix: "FEB27", priceSeed: 1684.0 },
  { suffix: "MAR27", priceSeed: 1715.0 },
  { suffix: "ABR27", priceSeed: 1745.0 },
];

/**
 * Registry final consumido por el módulo.
 * Cada entrada: { ticker, suffix, maturityDate, priceSeed }
 * Ordenado por fecha de vencimiento ascendente.
 */
export const DLR_REGISTRY = DLR_SEED_RAW
  .map(({ suffix, priceSeed }) => {
    const decoded = decodeDlrSuffix(suffix);
    if (!decoded) return null;
    return {
      ticker: `DLR${suffix}`,
      displayTicker: `DLR/${suffix}`, // formato pizarra MtR
      suffix,
      maturityDate: decoded.maturityDate,
      priceSeed,
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));

/**
 * Spot mayorista (BCRA Com. A 3500) al momento de la captura.
 * Se usa como fallback si /api/dolares no devuelve la casa "mayorista".
 */
export const DLR_SPOT_SEED = 1474.8;

/** Fecha del seed (para mostrar en UI cuando no hay datos editados). */
export const DLR_SEED_DATE = "2026-07-16";

/**
 * Días desde el SETTLEMENT (T+1) hasta el vencimiento del futuro.
 *
 * Mismo criterio que `daysToMaturity` en bondMaturities.js: el horizonte
 * de la inversión empieza mañana (T+1), no hoy. Esto alinea los
 * cálculos con BYMA/lamacro/IOL/Cocos. Antes era T+0.
 *
 * Retorna 0 si el futuro vence hoy o ya venció.
 */
export function daysToExpiry(maturityDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(maturityDate + "T00:00:00");
  const daysT0 = Math.round((exp - today) / 86400000);
  return Math.max(0, daysT0 - 1);
}

/**
 * Tasa Nominal Anual implícita (365 días).
 * TNA = (Futuro/Spot - 1) × 365/días
 */
export function implicitTNA(futuro, spot, days) {
  if (!futuro || !spot || !days || days <= 0) return null;
  return (futuro / spot - 1) * (365 / days);
}

/**
 * Tasa Efectiva Mensual implícita (30 días).
 * TEM = (Futuro/Spot)^(30/días) - 1
 */
export function implicitTEM(futuro, spot, days) {
  if (!futuro || !spot || !days || days <= 0) return null;
  return Math.pow(futuro / spot, 30 / days) - 1;
}

/**
 * Tasa Efectiva Anual implícita (365 días, capitalización compuesta).
 * TEA = (Futuro/Spot)^(365/días) - 1
 */
export function implicitTEA(futuro, spot, days) {
  if (!futuro || !spot || !days || days <= 0) return null;
  return Math.pow(futuro / spot, 365 / days) - 1;
}
