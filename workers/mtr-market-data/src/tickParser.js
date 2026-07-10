// Parser de ticks del WS de matbarofex.primary.ventures.
// Ver doc en README.md > "Protocolo del WS" para el detalle.
//
// Funciones puras, sin side-effects. Testeable con:
//   npm run test:parser
//
// Tipos de mensaje (primer char):
//   "M:..." -> MarketDataTick (pipe-delimited)
//   "L:..." -> ClosingPricesTick (pipe-delimited, prefix "L:M")
//   "B:..." -> BookDataTick (exclamation-delimited)
//   "X:..." -> GlobalTick (JSON inline)
//   "pong"  -> respuesta al ping del cliente
//   "[]" o "[...]" -> batch de ticks (array JSON con strings dentro)
//
// IMPORTANTE: el mapping posicional esta calibrado para segmento rx_DDF
// (futuros financieros). Segmento rx_DDA (BCRA A3500) y otros pueden
// tener distinta alineacion y campos que no aplican (ej. tipos de cambio
// no tienen open interest). El parser detecta ticks con menos de 21 campos
// y los marca como "incomplete" para que el sink decida que hacer.

const EXPECTED_FIELDS = 21;

// Posiciones de los campos en el split (segmento rx_DDF, 21 campos).
const MD_FIELDS = {
  ID: 0,
  SEQ: 1,
  BSZ: 2,
  BID: 3,
  ASK: 4,
  ASZ: 5,
  LST: 6,
  LSTD: 7,
  VOL: 8,
  VOE: 9,
  VON: 10,
  LOW: 11,
  HGH: 12,
  OPN: 13,
  OIN: 14,
  CLS: 15,
  CLSD: 16,
  STL: 17,
  STLD: 18,
  REFP: 19,
  REFD: 20,
};

/**
 * Convierte string a float SOLO si es estrictamente numerico (sin trailing).
 * Esto evita el bug de parseFloat("2026-05-22") = 2026.
 */
function toFloat(s) {
  if (s === undefined || s === null || s === "") return null;
  if (typeof s !== "string") return Number.isFinite(s) ? s : null;
  // Permite: opcional signo, digitos, opcional punto decimal con digitos
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toInt(s) {
  if (s === undefined || s === null || s === "") return null;
  if (typeof s !== "string") return Number.isInteger(s) ? s : null;
  if (!/^-?\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Devuelve el string crudo si parece un timestamp valido, null en otro caso.
 * Acepta:
 *   "2026-05-26T16:47:02Z"         (ISO con Z)
 *   "2026-05-26T16:15:41:00Z"      (variante con seg:ms al final)
 *   "2026-05-22"                   (solo fecha)
 * Rechaza strings claramente no-temporales como "1391" o "abc".
 * Postgres timestamptz acepta tanto fecha sola como ISO con Z.
 */
function toTimestamp(s) {
  if (!s || typeof s !== "string") return null;
  // Acepta YYYY-MM-DD opcionalmente seguido de cualquier T...
  if (!/^\d{4}-\d{2}-\d{2}(T.+)?$/.test(s)) return null;
  return s;
}

/**
 * Parsea un MarketDataTick (formato "M:rx_DDF_DLR_JUN26|271031|810|...").
 * Devuelve { tick, complete } donde:
 *   tick: objeto con campos normalizados, o null si esta gravemente malformado
 *   complete: true si el tick tenia los 21 campos esperados
 */
function parseMarketDataTick(raw) {
  const payload = raw.startsWith("M:") ? raw.substring(2) : raw;
  const parts = payload.split("|");

  // Tick gravemente malformado si no llega ni al last/lstd.
  if (parts.length < 8) return { tick: null, complete: false };

  const id = parts[MD_FIELDS.ID];
  if (!id) return { tick: null, complete: false };

  const complete = parts.length >= EXPECTED_FIELDS;

  // Helper: lee posicion solo si esta dentro del array.
  const at = (idx) => (idx < parts.length ? parts[idx] : "");

  const tick = {
    securityId: id,
    seq: toInt(at(MD_FIELDS.SEQ)),
    bidSize: toFloat(at(MD_FIELDS.BSZ)),
    bid: toFloat(at(MD_FIELDS.BID)),
    ask: toFloat(at(MD_FIELDS.ASK)),
    askSize: toFloat(at(MD_FIELDS.ASZ)),
    last: toFloat(at(MD_FIELDS.LST)),
    lastTs: toTimestamp(at(MD_FIELDS.LSTD)),
    volume: toFloat(at(MD_FIELDS.VOL)),
    volumeEffective: toFloat(at(MD_FIELDS.VOE)),
    volumeNominal: toFloat(at(MD_FIELDS.VON)),
    low: toFloat(at(MD_FIELDS.LOW)),
    high: toFloat(at(MD_FIELDS.HGH)),
    open: toFloat(at(MD_FIELDS.OPN)),
    // Los campos siguientes solo son confiables si el tick tiene 21 campos
    // alineados a rx_DDF. Para tick incompleto los seteo null preventivamente.
    openInterest: complete ? toFloat(at(MD_FIELDS.OIN)) : null,
    close: complete ? toFloat(at(MD_FIELDS.CLS)) : null,
    closeTs: complete ? toTimestamp(at(MD_FIELDS.CLSD)) : null,
    settlement: complete ? toFloat(at(MD_FIELDS.STL)) : null,
    settlementTs: complete ? toTimestamp(at(MD_FIELDS.STLD)) : null,
    reference: complete ? toFloat(at(MD_FIELDS.REFP)) : null,
    referenceTs: complete ? toTimestamp(at(MD_FIELDS.REFD)) : null,
  };

  return { tick, complete };
}

/**
 * Parser de alto nivel. Recibe el raw text del frame WS (string o array JSON
 * serializado) y devuelve un array de "eventos" normalizados.
 *
 * Eventos posibles:
 *   { kind: "md",      data: <MarketDataTick>, complete: bool }
 *   { kind: "closing", data: <MarketDataTick>, complete: bool }
 *   { kind: "book",    raw: <string>  }    (no parseo book por ahora)
 *   { kind: "global",  data: { t, d } }    (clock/fixstatus/etc)
 *   { kind: "pong",    data: null }
 *   { kind: "empty",   data: null }        (frame "[]")
 *   { kind: "unknown", raw: <string> }
 */
function parseFrame(raw) {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") raw = String(raw);
  const s = raw.trim();
  if (s === "") return [];

  // pong literal
  if (s === "pong") return [{ kind: "pong", data: null }];

  // Array JSON (batch). Puede ser "[]" vacio o "[\"M:...\",\"M:...\"]"
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return [{ kind: "unknown", raw: s }];
      if (arr.length === 0) return [{ kind: "empty", data: null }];
      return arr.flatMap((item) => parseFrame(item));
    } catch (_err) {
      return [{ kind: "unknown", raw: s }];
    }
  }

  if (s.startsWith("M:")) {
    const { tick, complete } = parseMarketDataTick(s);
    return tick ? [{ kind: "md", data: tick, complete }] : [];
  }
  if (s.startsWith("L:M")) {
    const { tick, complete } = parseMarketDataTick(s.substring(3));
    return tick ? [{ kind: "closing", data: tick, complete }] : [];
  }
  if (s.startsWith("B:")) {
    return [{ kind: "book", raw: s }];
  }
  if (s.startsWith("X:")) {
    try {
      const data = JSON.parse(s.substring(2));
      return [{ kind: "global", data }];
    } catch (_err) {
      return [{ kind: "unknown", raw: s }];
    }
  }

  return [{ kind: "unknown", raw: s }];
}

module.exports = {
  parseFrame,
  parseMarketDataTick,
  parseTick: parseFrame,
  MD_FIELDS,
  EXPECTED_FIELDS,
};
