# -*- coding: utf-8 -*-
# Futuros: despues de la rueda, el precio del dia es el AJUSTE oficial (como
# Matriz), no el ultimo operado (30/09/2026: DLRNOV26 −150.000 en Midas contra
# +103.000 en Matriz; el ultimo operado fue a las 14:59 y el ajuste de A3
# quedo 3 pesos arriba). El proxy /api/mtr-md expone la fecha ART del
# settlement; el front usa el settlement como "ultimo" cuando es el de HOY.
import io, sys
A = r'C:\Users\slider\Documents\Claude\Projects\Midas\api\mtr-md.js'
F = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
fallos = []
def parchar(ruta, pares):
    s = io.open(ruta, encoding='utf-8').read()
    for a, b, et in pares:
        n = s.count(a)
        if n == 1: s = s.replace(a, b)
        else: fallos.append('%s %s (%d)' % (ruta[-14:], et, n))
    return s
api = parchar(A, [
('''  const lastDate = row.last_ts ? new Date(row.last_ts).getTime() : null;''',
 '''  const lastDate = row.last_ts ? new Date(row.last_ts).getTime() : null;
  // Fecha (hora argentina) del settlement que trae la fila: el front compara
  // contra "hoy" para saber si ya es el ajuste del dia. OJO: el settle de ayer
  // se publica 21:00 ART = 00:00 UTC de hoy; en UTC parece de hoy y no lo es.
  const settlementDate = row.settlement_ts
    ? new Date(row.settlement_ts).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })
    : null;''', 'settleDate'),
('''  return { last, bid, offer, settlement, reference, midpoint, price, priceSource, lastDate, freshness, bidSize, askSize, volume };''',
 '''  return { last, bid, offer, settlement, settlementDate, reference, midpoint, price, priceSource, lastDate, freshness, bidSize, askSize, volume };''', 'return'),
])
front = parchar(F, [
('''    const lastRaw = fp?.last != null ? fp.last : fp?.settlement;
    if (lastRaw != null && !fp?.error) {
      const last = Number(lastRaw);
      const lookupEntry = futureAdjLookup ? futureAdjLookup.get(p.id) : null;
      // Fecha de hoy en ART, no UTC. Con `new Date().toISOString` entre
      // 21:00 y 23:59 ART el slice(0,10) avanza al día UTC siguiente —
      // eso rompía la comparación contra entry_date (que se guarda como
      // YYYY-MM-DD en ART).
      const todayAR = new Date().toLocaleDateString("en-CA", {
        timeZone: "America/Argentina/Buenos_Aires",
      });''',
 '''    // 30/09/2026: cuando A3 ya publicó el AJUSTE de hoy, ése es el precio
    // del día (así lo liquida Matriz), no el último operado. El último de
    // DLRNOV26 fue 1.574,5 a las 14:59 y el ajuste quedó ~1.577,5: Midas
    // decía −150.000 y Matriz +103.000.
    const todayAR = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/Argentina/Buenos_Aires",
    });
    const settleHoy = fp?.settlementDate === todayAR && Number(fp?.settlement) > 0 ? Number(fp.settlement) : null;
    const lastRaw = settleHoy != null ? settleHoy : (fp?.last != null ? fp.last : fp?.settlement);
    if (lastRaw != null && !fp?.error) {
      const last = Number(lastRaw);
      const lookupEntry = futureAdjLookup ? futureAdjLookup.get(p.id) : null;''', 'daily'),
('''  if (p.instrument_type === "future" && futurePrices && ticker) {
    const fp = futurePrices[ticker];
    if (fp?.price != null && !fp.error) {
      return { price: Number(fp.price), source: "primary" };
    }''',
 '''  if (p.instrument_type === "future" && futurePrices && ticker) {
    const fp = futurePrices[ticker];
    // Con el ajuste de HOY publicado, la posición se valúa al ajuste (como el
    // broker), no al último operado ni al mid (30/09/2026).
    const hoyAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
    if (fp?.settlementDate === hoyAR && Number(fp?.settlement) > 0 && !fp.error) {
      return { price: Number(fp.settlement), source: "settle" };
    }
    if (fp?.price != null && !fp.error) {
      return { price: Number(fp.price), source: "primary" };
    }''', 'resolver'),
])
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(A, 'w', encoding='utf-8').write(api)
io.open(F, 'w', encoding='utf-8').write(front)
print('ok')
