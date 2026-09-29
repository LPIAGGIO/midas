# -*- coding: utf-8 -*-
# "Hoy" de una posición abierta = solo lo que sigue abierto (29/09/2026).
# Con ventas en el día, el Hoy de la fila sumaba la ganancia de lo vendido,
# que además aparece en "Posiciones cerradas hoy": OKLO mostraba +199.743 en
# abiertas (= +229.742 de lo vendido − 30.000 del lote recomprado) y +229.742
# en cerradas. La tarjeta del P&L del día no cambia (suma por ticker una vez).
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
orig = len(s)
A = '''    const netQ = Number(group.netQty) || 0;
    if (netQ === 0) return { dailyPnl: null, dailyPct: null, marketClosed: false };
    let dayTotal = 0;
    let anyData = false;
    for (const op of group.operations) {
      if (op?.isSynthetic) continue; // sólo operaciones reales (no pares sintéticos)'''
B = '''    const netQ = Number(group.netQty) || 0;
    if (netQ === 0) return { dailyPnl: null, dailyPct: null, marketClosed: false };

    /* CON VENTAS HOY (29/09/2026): el Hoy de la fila mide SOLO lo que sigue
     * abierto. Lo vendido hoy ya tiene su fila en "Posiciones cerradas hoy"
     * (ganancia del día contra el cierre de ayer); sumarlo también acá lo
     * contaba dos veces. Caso OKLO: 5.000 arrastradas vendidas a 2.175 y
     * 2.500 recompradas a 2.160 → la fila decía +199.743 (= +229.742 de lo
     * vendido − 30.000 del lote nuevo) y lo real del remanente es −30.000.
     * Mismo criterio que la sección de cerradas: las ventas salen primero de
     * lo arrastrado; si sobran, de las compras de hoy (a su precio promedio).
     * Remanente = arrastrado que quedó (contra el cierre de ayer) + comprado
     * hoy que quedó (contra su precio de compra). Solo largos: shorts y
     * grupos sin precio de ayer siguen por el cálculo de siempre. */
    {
      const hoyG = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
      let arr = 0, qVentaHoy = 0, qCompraHoy = 0, vCompraHoy = 0;
      for (const op of group.operations) {
        if (op?.isSynthetic) continue;
        const q = Number(op.quantity) || 0;
        if (op.entry_date === hoyG) {
          if (op.operation_type === "sell") qVentaHoy += q;
          else { qCompraHoy += q; vCompraHoy += q * (Number(op.entry_price) || 0); }
        } else arr += (op.operation_type === "sell" ? -1 : 1) * q;
      }
      const tkR = (group.ticker || "").toUpperCase();
      const esEqR = group.instrument_type === "stock" || group.instrument_type === "cedear";
      const feedR = esEqR ? stockPrices?.[tkR] : bondPrices?.[tkR];
      let prevR = feedR?.previousClose;
      if (prevR == null && feedR?.changePct != null) {
        const den = 1 + Number(feedR.changePct) / 100;
        if (den > 0) prevR = Number(feedR.price) / den;
      }
      const pxR = Number(group.currentPrice);
      if (qVentaHoy > 0 && arr >= 0 && netQ > 0 && Number(prevR) > 0 && pxR > 0) {
        const arrQueda = Math.max(0, arr - qVentaHoy);
        const deHoyVendido = Math.max(0, qVentaHoy - arr);
        const hoyQueda = Math.max(0, qCompraHoy - deHoyVendido);
        const pmHoy = qCompraHoy > 0 ? vCompraHoy / qCompraHoy : 0;
        const val = (q, dp) => applyConventionToValue(group.instrument_type, q, dp);
        const pnlR = val(arrQueda, pxR - prevR) + (hoyQueda > 0 ? val(hoyQueda, pxR - pmHoy) : 0);
        const denR = Math.abs(val(arrQueda, prevR) + (hoyQueda > 0 ? val(hoyQueda, pmHoy) : 0));
        if (Number.isFinite(pnlR)) {
          return { dailyPnl: pnlR, dailyPct: denR > 0 ? (pnlR / denR) * 100 : null, marketClosed: false };
        }
      }
    }

    let dayTotal = 0;
    let anyData = false;
    for (const op of group.operations) {
      if (op?.isSynthetic) continue; // sólo operaciones reales (no pares sintéticos)'''
if s.count(A) != 1:
    print('FALLO: ancla (%d)' % s.count(A)); sys.exit(1)
s = s.replace(A, B)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
