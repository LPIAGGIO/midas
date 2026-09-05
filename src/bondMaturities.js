/**
 * Mapa de fechas de vencimiento de Lecaps, Boncaps y Duales en pesos.
 *
 * Tickers que data912 devuelve y que cubrimos:
 *   - LECAPs (S):     S14G6, S15Y6, S17L6, S29Y6, S30N6, S30O6, S30S6, S31G6, S31L6
 *   - BONCAPs (T):    T15E7, T30A7, T30J6, T30J7, T31Y7
 *   - BONCAPs (TT):   TTD26, TTJ26, TTS26
 *   - DUALES (...D):  S2G6D, S2L6D, S2Y6D, SL6D, SS6D
 *   - TASA VARIABLE:  PBA27, TXMJ9 (sin TIR fija — ver abajo)
 *
 * Excluidos del mapa:
 *   - X tickers (X15Y6, X29Y6, etc.): son el mismo subyacente operado por circuito alternativo
 *   - CER puros (BU4J6, D30S6, M31G6): no entran en V1
 *   - Hard dollar (AE/AL/GD/GE): no son carry trade en pesos
 *
 * Letras de mes (convención Tesoro):
 *   E=ene F=feb M=mar A=abr Y=may J=jun L=jul G=ago S=sep O=oct N=nov D=dic
 */

const MONTH_LETTER = {
  E: 1,  F: 2,  M: 3,  A: 4,  Y: 5,  J: 6,
  L: 7,  G: 8,  S: 9,  O: 10, N: 11, D: 12,
};

// Mapa hardcodeado: ticker -> { type, maturityDate (ISO), finalPayoff, capitalizable }
//   type: 'lecap' | 'boncap' | 'dual' | 'cer' | 'floater'
//   finalPayoff: pesos que paga el bono al vencimiento por cada $100 de VN
//                (verificado en rendimientos.co — se actualiza con cada licitación nueva)
//   capitalizable: true para Lecaps/Boncaps a tasa fija
//   coupons: fechas de pago de renta (solo para los que NO capitalizan al vto)
export const BOND_REGISTRY = {
  // ─── Lecaps (S) — capitalizan al vencimiento ───
  S15Y6: { type: "lecap", maturityDate: "2026-05-15", finalPayoff: 105.178, capitalizable: true },
  S29Y6: { type: "lecap", maturityDate: "2026-05-29", finalPayoff: 132.044, capitalizable: true },
  S17L6: { type: "lecap", maturityDate: "2026-07-17", finalPayoff: 107.920, capitalizable: true },
  S31L6: { type: "lecap", maturityDate: "2026-07-31", finalPayoff: 117.677, capitalizable: true },
  S14G6: { type: "lecap", maturityDate: "2026-08-14", finalPayoff: 108.030, capitalizable: true },
  S31G6: { type: "lecap", maturityDate: "2026-08-31", finalPayoff: 127.064, capitalizable: true },
  S30S6: { type: "lecap", maturityDate: "2026-09-30", finalPayoff: 117.536, capitalizable: true },
  S30O6: { type: "lecap", maturityDate: "2026-10-30", finalPayoff: 135.278, capitalizable: true },
  S30N6: { type: "lecap", maturityDate: "2026-11-30", finalPayoff: 129.888, capitalizable: true },

  // ─── Boncaps (T) — capitalizan al vencimiento ───
  T30J6: { type: "boncap", maturityDate: "2026-06-30", finalPayoff: 144.896, capitalizable: true },
  T15E7: { type: "boncap", maturityDate: "2027-01-15", finalPayoff: 161.104, capitalizable: true },
  T30A7: { type: "boncap", maturityDate: "2027-04-30", finalPayoff: 157.341, capitalizable: true },
  T31Y7: { type: "boncap", maturityDate: "2027-05-31", finalPayoff: 151.563, capitalizable: true },
  T30J7: { type: "boncap", maturityDate: "2027-06-30", finalPayoff: 156.037, capitalizable: true },

  // ─── Boncaps TT — capitalizables al vto ───
  // finalPayoff verificado en colab público de carry trade (logos servicios financieros).
  TTM26: { type: "boncap", maturityDate: "2026-03-16", finalPayoff: 135.238, capitalizable: true },
  TTJ26: { type: "boncap", maturityDate: "2026-06-30", finalPayoff: 144.629, capitalizable: true },
  TTS26: { type: "boncap", maturityDate: "2026-09-15", finalPayoff: 152.096, capitalizable: true },
  TTD26: { type: "boncap", maturityDate: "2026-12-15", finalPayoff: 161.144, capitalizable: true },

  // ─── Duales TAMAR (terminan en D) — deshabilitados en V1 vía shouldIgnoreTicker ───
  // Fechas verificadas con cohen.com.ar. Quedan en el mapa para V2.
  S2G6D: { type: "dual", maturityDate: "2026-08-14", capitalizable: true },
  S2L6D: { type: "dual", maturityDate: "2026-07-17", capitalizable: true },
  S2Y6D: { type: "dual", maturityDate: "2026-05-15", capitalizable: true },
  SL6D:  { type: "dual", maturityDate: "2026-07-31", capitalizable: true },
  SS6D:  { type: "dual", maturityDate: "2026-09-30", capitalizable: true },

  // ─── Tasa variable (type "floater") — NO tienen TIR fija ───
  // La tasa de cada período se fija sobre la marcha (TAMAR, CER), así que
  // el pago al vencimiento NO se puede saber de antemano: van SIN
  // finalPayoff a propósito. Entran al registry igual para que el resto
  // del sistema conozca su vencimiento (Flujos, Liquidez, filtro de
  // tenencia fantasma, buscador de tickers); las pantallas de carry y
  // rendimientos los saltean vía isFloatingRate().
  //
  // PBA27: TD Prov. de Buenos Aires tasa variable, TAMAR + 7 pp, bullet
  // al 30/04/2027, renta trimestral. Fechas del aviso de suscripción de
  // Banco Provincia (10/12/2025).
  PBA27: {
    type: "floater",
    maturityDate: "2027-04-30",
    capitalizable: false,
    coupons: ["2026-07-30", "2026-10-30", "2027-01-30", "2027-04-30"],
  },
  // TXMJ9: dual CER/TAMAR del Tesoro, bullet al 29/06/2029, sin cupones
  // (capitaliza). Paga MAX(CER lag 10 hd, TAMAR TEM + 3%), 30/360.
  // RC 23/2026, emisión 30/04/2026.
  TXMJ9: {
    type: "floater",
    maturityDate: "2029-06-29",
    capitalizable: true,
  },
};

/**
 * Decoder regex como fallback. Intenta extraer la fecha del ticker.
 * Cubre 2 patrones que SÍ funcionan correctamente:
 *   - TT + LETRA + 2 dígitos:           ej. TTJ26 → 30/jun/2026
 *   - [ST] + DD + LETRA + 1 dígito:     ej. S29Y6 → 29/may/2026
 *
 * NOTA: Los Duales (terminan en D) NO se decodifican por regex porque
 * el patrón "S2L6D" no es "día + mes + año + D". El "2" no es día sino
 * identificador de serie. Por lo tanto los Duales SOLO funcionan vía
 * el mapa hardcodeado verificado con cohen.com.ar.
 *
 * Devuelve null para tickers que no matchean.
 *
 * @returns { type, maturityDate, capitalizable } | null
 */
export function decodeTicker(ticker) {
  if (!ticker || typeof ticker !== "string") return null;
  const t = ticker.toUpperCase().trim();

  // Patrón TT: TT + LETRA_MES + 2 dígitos del año
  const ttMatch = /^TT([EFMAYJLGSOND])(\d{2})$/.exec(t);
  if (ttMatch) {
    const month = MONTH_LETTER[ttMatch[1]];
    const year = 2000 + parseInt(ttMatch[2], 10);
    if (!month) return null;
    return {
      type: "boncap",
      maturityDate: isoDate(year, month, 30),
      capitalizable: true,
    };
  }

  // Patrón S/T standard: [ST] + DD + LETRA + 1 dígito  (ej. S29Y6, T30J7)
  const stMatch = /^([ST])(\d{2})([EFMAYJLGSOND])(\d)$/.exec(t);
  if (stMatch) {
    const prefix = stMatch[1];
    const day = parseInt(stMatch[2], 10);
    const month = MONTH_LETTER[stMatch[3]];
    const year = 2020 + parseInt(stMatch[4], 10);
    if (!month || day < 1 || day > 31) return null;
    return {
      type: prefix === "S" ? "lecap" : "boncap",
      maturityDate: isoDate(year, month, day),
      capitalizable: true,
    };
  }

  return null;
}

function isoDate(year, month, day) {
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${year}-${m}-${d}`;
}

/**
 * Resuelve un ticker. Primero intenta el mapa hardcodeado, después el decoder.
 * @returns { type, maturityDate, capitalizable, source: 'registry'|'decoded' } | null
 */
export function resolveBond(ticker) {
  if (BOND_REGISTRY[ticker]) {
    return { ...BOND_REGISTRY[ticker], source: "registry" };
  }
  const decoded = decodeTicker(ticker);
  if (decoded) {
    return { ...decoded, source: "decoded" };
  }
  return null;
}

/**
 * Días desde la fecha de SETTLEMENT (T+1) hasta el vencimiento.
 *
 * En BYMA los bonos liquidan al día siguiente: comprás T0, te entregan
 * el título y se debita el cash en T+1. Por eso el horizonte real de
 * la inversión es desde mañana, no desde hoy. Esta es la convención
 * que usan lamacro.ar, Cocos, IOL, BYMA para calcular TIR/TEA/TNA.
 *
 * Antes esto devolvía T+0 (días desde hoy). Cambio en may-2026 para
 * alinear con el mercado y eliminar el offset constante de 1 día
 * que teníamos contra lamacro.
 *
 * Retorna 0 si el bono vence hoy o ya venció (no genera intereses).
 */
export function daysToMaturity(maturityDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const mat = new Date(maturityDate + "T00:00:00");
  const daysT0 = Math.round((mat - today) / 86400000);
  // T+1: descontamos 1 día. Si vence mañana (daysT0=1), settlement
  // y vencimiento son el mismo día → 0 días útiles → ya vencido.
  return Math.max(0, daysT0 - 1);
}

/**
 * Decide si un ticker debe ser ignorado del universo de carry trade.
 * Excluimos: X tickers (versión MEP duplicada), bonos hard-dollar,
 * Duales (precios de data912 inconsistentes con el resto), y
 * cualquier cosa que no matchee los patrones del Tesoro.
 *
 * @returns true si debe IGNORARSE
 */
/**
 * Tasa variable (floaters TAMAR/BADLAR + margen fijo).
 *
 * Estos bonos NO tienen pago al vencimiento conocido de antemano: el
 * cupón se fija con la tasa de cada período. Sin ese número no hay TIR
 * computable, así que quedan fuera de las pantallas de carry trade y
 * rendimientos — meterlos ahí con un payoff supuesto (VN=100) daría un
 * rendimiento negativo inventado.
 *
 * OJO: esto NO los saca del sistema. Siguen en BOND_REGISTRY para que
 * el vencimiento, los cupones, la valuación a mercado y el filtro de
 * tenencia fantasma funcionen igual que con cualquier otro bono.
 *
 * @returns true si el ticker es de tasa variable
 */
export function isFloatingRate(ticker) {
  const t = (ticker || "").toUpperCase().trim();
  return BOND_REGISTRY[t]?.type === "floater";
}

export function shouldIgnoreTicker(ticker) {
  if (!ticker || typeof ticker !== "string") return true;
  const t = ticker.toUpperCase().trim();
  // X tickers: misma S pero negociadas por otro circuito — duplicaríamos
  if (t.startsWith("X")) return true;
  // CER puros (no en V1)
  if (t.startsWith("BU") || t.startsWith("D30") || t.startsWith("M31") || t.startsWith("DI")) return true;
  // Duales (terminan en "D"): precios de data912 vienen en formato distinto.
  // Quedan fuera de V1 hasta calibrar el factor de conversión correcto.
  if (t.endsWith("D")) return true;
  return false;
}
