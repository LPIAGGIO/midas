# -*- coding: utf-8 -*-
# consolidatePositions POR BROKER (28/09/2026). Ver el comentario del wrapper.
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
orig = len(s)

viejo = 'function consolidatePositions(positions, bondPrices, futurePrices, fciPrices, stockPrices) {\n  if (!positions?.length) return [];\n  // Hoy (para descartar letras/boncaps ya vencidas de la tenencia).'
if s.count(viejo) != 1:
    print('FALLO: firma original (%d)' % s.count(viejo)); sys.exit(1)

WRAPPER = '''/* ─────────────── consolidatePositions: POR BROKER (28/09/2026) ───────────────
 * El costo del lote vivo sale de recorrer las operaciones en orden. Con todos
 * los brokers en una sola fila de tiempo, una venta en Cocos "vendía" papeles
 * de IOL y lo que quedaba heredaba el costo de lo vendido: JNJ, 20 en IOL a
 * $25.512, se mostraba a $28.820 porque se mezclaba con 500 comprados y
 * vendidos en Cocos (lo mismo INTC, GOOGL, AMD...), y la fila decía MIXTO
 * aunque en Cocos ya no hubiera nada. Pasó a notarse al prender la derivación
 * de posiciones del Libro (27/09), que trajo toda la historia de Cocos.
 *
 * Ahora cada broker se consolida por separado (una cuenta no puede vender los
 * papeles de otra) y después se juntan en UNA fila solo las posiciones
 * ABIERTAS del mismo papel: ese es el único MIXTO real (OKLO: 5.000 en Cocos +
 * 621 en IOL). Las cerradas quedan una por broker: el realizado es de cada
 * cuenta. Con un solo broker no cambia nada, ni siquiera las claves.
 */
function consolidatePositions(positions, bondPrices, futurePrices, fciPrices, stockPrices) {
  if (!positions?.length) return [];
  const porBroker = new Map();
  for (const p of positions) {
    const b = p?.broker || "manual";
    if (!porBroker.has(b)) porBroker.set(b, []);
    porBroker.get(b).push(p);
  }
  if (porBroker.size <= 1) return consolidatePositionsUnBroker(positions, bondPrices, futurePrices, fciPrices, stockPrices);

  const out = [];
  const abiertas = new Map(); // papel -> índice en out
  for (const [b, ps] of porBroker) {
    for (const g0 of consolidatePositionsUnBroker(ps, bondPrices, futurePrices, fciPrices, stockPrices) || []) {
      // Clave con el broker: dos cuentas producen la misma clave para el mismo
      // papel y chocarían en la UI (filas expandidas, orden, React keys).
      const g = { ...g0, groupKey: `${g0.groupKey}|@${b}` };
      if (g.isClosed || g.instrument_type === "caucion") { out.push(g); continue; }
      const papel = `${g.instrument_type}|${String(g.ticker || "").toUpperCase()}|${g.instrument_type === "future" ? "" : (g.currency || "")}`;
      if (!abiertas.has(papel)) { abiertas.set(papel, out.length); out.push(g); continue; }
      const i = abiertas.get(papel);
      out[i] = juntarAbiertasDeBrokers(out[i], g);
    }
  }
  out.sort((a, b) => {
    const av = a.valueAtMarket ?? -Infinity;
    const bv = b.valueAtMarket ?? -Infinity;
    return Math.abs(bv) - Math.abs(av);
  });
  return out;
}

// Una fila ABIERTA del mismo papel en dos brokers → una sola fila MIXTO. Cada
// parte ya trae su costo del lote vivo bien calculado; acá solo se suman
// cantidades, valores y resultados, y el PPC es el promedio ponderado.
function juntarAbiertasDeBrokers(a, b) {
  const sum = (x, y) => (x == null || y == null ? null : Number(x) + Number(y));
  const sumOr = (x, y) => (x == null && y == null ? null : (Number(x) || 0) + (Number(y) || 0));
  const qa = Math.abs(Number(a.netQty) || 0), qb = Math.abs(Number(b.netQty) || 0);
  const netQty = (Number(a.netQty) || 0) + (Number(b.netQty) || 0);
  const ppp = a.ppp != null && b.ppp != null && qa + qb > 0
    ? (Number(a.ppp) * qa + Number(b.ppp) * qb) / (qa + qb)
    : (a.ppp ?? b.ppp);
  const valueAtCost = sum(a.valueAtCost, b.valueAtCost);
  const valueAtMarket = sum(a.valueAtMarket, b.valueAtMarket);
  const pnl = sum(a.pnl, b.pnl);
  const lifetimePnl = sumOr(a.lifetimePnl, b.lifetimePnl);
  const soloUnHistorico = a.lifetimePnl == null || b.lifetimePnl == null;
  const minD = (x, y) => (!x ? y : !y ? x : (x < y ? x : y));
  const maxD = (x, y) => (!x ? y : !y ? x : (x > y ? x : y));
  return {
    ...a,
    groupKey: String(a.groupKey).replace(/\\|@[^|]+$/, "") + "|@mix",
    operations: [...(a.operations || []), ...(b.operations || [])],
    operationsCount: (a.operationsCount || 0) + (b.operationsCount || 0),
    buyOpsCount: (a.buyOpsCount || 0) + (b.buyOpsCount || 0),
    sellOpsCount: (a.sellOpsCount || 0) + (b.sellOpsCount || 0),
    netQty,
    isShort: netQty < 0,
    ppp,
    currentPrice: a.currentPrice ?? b.currentPrice,
    priceSource: a.priceSource ?? b.priceSource,
    valueAtCost,
    valueAtMarket,
    pnl,
    pnlPct: pnl != null && valueAtCost != null && Math.abs(valueAtCost) > 0 ? (pnl / Math.abs(valueAtCost)) * 100 : null,
    realizedPnl: sumOr(a.realizedPnl, b.realizedPnl),
    unrealizedPnl: sumOr(a.unrealizedPnl, b.unrealizedPnl),
    isPartialOpen: !!(a.isPartialOpen || b.isPartialOpen),
    lifetimePnl,
    // Un % de realizado histórico no se suma entre cuentas con bases distintas:
    // si solo una de las dos tiene historia, vale el suyo; si ambas, no se muestra.
    lifetimePnlPct: soloUnHistorico ? (a.lifetimePnl != null ? a.lifetimePnlPct : b.lifetimePnlPct) : null,
    notional: sum(a.notional, b.notional),
    firstDate: minD(a.firstDate, b.firstDate),
    lastDate: maxD(a.lastDate, b.lastDate),
    notesAggregated: [...(a.notesAggregated || []), ...(b.notesAggregated || [])],
  };
}

function consolidatePositionsUnBroker(positions, bondPrices, futurePrices, fciPrices, stockPrices) {
  if (!positions?.length) return [];
  // Hoy (para descartar letras/boncaps ya vencidas de la tenencia).'''

s = s.replace(viejo, WRAPPER)

# groupBroker: con la consolidación por broker, las operaciones de una fila
# abierta ya son solo de los brokers que la tienen. Se deja igual; se anota.
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
