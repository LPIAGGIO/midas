// Lista hardcodeada de los 12 futuros DLR estandar (sin opciones, sin minis).
// Extraida del ref-data del 26/05/2026.
//
// FUTURO: cuando un contrato vence (ej. DLR_MAY26 desaparece el 31/05),
// hay que actualizarlo o pegarle a /api/v2/ref-data y diff-ear. Para MVP,
// hardcode + revision manual mensual. Ver TODO al final.

const DLR_FUTURES = [
  { securityId: "rx_DDF_DLR_MAY26", symbol: "DLR/MAY26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_JUN26", symbol: "DLR/JUN26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_JUL26", symbol: "DLR/JUL26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_AGO26", symbol: "DLR/AGO26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_SEP26", symbol: "DLR/SEP26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_OCT26", symbol: "DLR/OCT26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_NOV26", symbol: "DLR/NOV26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_DIC26", symbol: "DLR/DIC26", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_ENE27", symbol: "DLR/ENE27", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_FEB27", symbol: "DLR/FEB27", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_MAR27", symbol: "DLR/MAR27", segment: "rx_DDF" },
  { securityId: "rx_DDF_DLR_ABR27", symbol: "DLR/ABR27", segment: "rx_DDF" },
];

// Cauciones colocadoras en PESOS del MAE (segmento rx_MAE). El "precio" de
// estos instrumentos ES la tasa (TNA %), no un precio de futuro. Misma fuente
// que el snapshot estatico viejo (api.mae.com.ar/cauciones), por otro
// transporte. La 1D alimenta el benchmark "vs caucion" de la curva DLR y el
// analizador Futuros vs Caucion; 2D-4D vienen gratis en el mismo feed para
// armar una mini-curva. El tickParser deja la tasa en last/bid/ask (rueda
// activa) o reference/settlement (fuera de hora).
const CAUCIONES_ARS = [
  { securityId: "rx_MAE_CAARS_1D", symbol: "CAARS/1D", segment: "rx_MAE" },
  { securityId: "rx_MAE_CAARS_2D", symbol: "CAARS/2D", segment: "rx_MAE" },
  { securityId: "rx_MAE_CAARS_3D", symbol: "CAARS/3D", segment: "rx_MAE" },
  { securityId: "rx_MAE_CAARS_4D", symbol: "CAARS/4D", segment: "rx_MAE" },
];

const WTI_FUTURES = [
  { securityId: "rx_DUAL_WTI_JUL26", symbol: "WTI/JUL26", segment: "rx_DUAL" },
];

/* Futuros de ACCIONES individuales (segmento rx_DUAL, multiplicador 100 —
 * o sea 1 contrato = 100 acciones, igual que las opciones de BYMA).
 *
 * POR QUE: el futuro cotiza con PREMIO sobre el contado, y ese premio es una
 * TASA IMPLICITA — la misma cuenta que ya hacemos entre el dolar futuro y la
 * caucion. Con la accion en cartera, vender el futuro contra ella arma un
 * carry: te quedas la tasa sin riesgo de precio. Ademas permite comparar dos
 * formas de monetizar el mismo papel (lanzamiento cubierto vs venta de
 * futuro), que hasta ahora no se podia medir por falta de dato.
 *
 * Se eligieron los cuatro que LP opera. Existen ademas futuros de BONOS
 * (AL30, AL30D, AL35, GD30, GD35 — multiplicador 1000) en el mismo segmento;
 * se dejan afuera hasta que haya un uso concreto, para no inflar la
 * suscripcion sin necesidad. */
const ACCIONES_FUTURES = [
  { securityId: "rx_DUAL_GGAL_AGO26", symbol: "GGAL/AGO26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_GGAL_OCT26", symbol: "GGAL/OCT26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_YPFD_AGO26", symbol: "YPFD/AGO26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_YPFD_OCT26", symbol: "YPFD/OCT26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_PAMP_AGO26", symbol: "PAMP/AGO26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_PAMP_OCT26", symbol: "PAMP/OCT26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_TXAR_AGO26", symbol: "TXAR/AGO26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_TXAR_OCT26", symbol: "TXAR/OCT26", segment: "rx_DUAL" },
];

/* Futuros de TASA. Son la vara natural contra la cual medir el premio de los
 * futuros de accion: en vez de comparar contra la caucion spot (que es a 1
 * dia), se compara contra el mismo plazo.
 *   CAUC = caucion en pesos   TMR = TAMAR (plazos fijos mayoristas)
 * El "precio" de estos contratos ES una tasa, igual que las cauciones del MAE:
 * el tickParser ya trata ese caso, no hace falta tocarlo. */
const TASA_FUTURES = [
  { securityId: "rx_DUAL_CAUC_AGO26", symbol: "CAUC/AGO26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_CAUC_SEP26", symbol: "CAUC/SEP26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_CAUC_OCT26", symbol: "CAUC/OCT26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_CAUC_NOV26", symbol: "CAUC/NOV26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_TMR_AGO26", symbol: "TMR/AGO26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_TMR_SEP26", symbol: "TMR/SEP26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_TMR_OCT26", symbol: "TMR/OCT26", segment: "rx_DUAL" },
  { securityId: "rx_DUAL_TMR_NOV26", symbol: "TMR/NOV26", segment: "rx_DUAL" },
];

const ALL_SYMBOLS = [
  ...DLR_FUTURES, ...CAUCIONES_ARS, ...WTI_FUTURES,
  ...ACCIONES_FUTURES, ...TASA_FUTURES,
];

/**
 * Devuelve la lista de securityIds para suscribir al WS de Primary.
 * El topic del WS es `md.${securityId}`.
 */
function getSymbolsToSubscribe() {
  return ALL_SYMBOLS.map((s) => s.securityId);
}

/**
 * Devuelve metadata de un securityId (symbol, segment).
 * El sink lo usa para enriquecer el upsert.
 */
function getSymbolMeta(securityId) {
  return ALL_SYMBOLS.find((s) => s.securityId === securityId);
}

/**
 * Construye los topics WS a partir de los securityIds.
 * Topic format: `md.${securityId}` (md = market data).
 */
function buildTopics(securityIds) {
  return securityIds.map((id) => `md.${id}`);
}

module.exports = {
  DLR_FUTURES,
  CAUCIONES_ARS,
  ACCIONES_FUTURES,
  TASA_FUTURES,
  ALL_SYMBOLS,
  getSymbolsToSubscribe,
  getSymbolMeta,
  buildTopics,
};

// TODO[refresh-dinamico]: leer /api/v2/ref-data cada 24h, filtrar
//   securities con id que matchee /^rx_DDF_DLR_[A-Z]{3}\d{2}$/, comparar
//   con ALL_SYMBOLS y mandar S/U al WS para suscribir nuevos y desuscribir
//   vencidos. No bloqueante para MVP.
