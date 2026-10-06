# -*- coding: utf-8 -*-
# cocos-scalp/worker.js (06/10/2026, acordado con LP): el rechazo "Stock
# insuficiente" de Cocos NO es falta de papeles: es un bug de Matriz que LP
# reclama a Cocos (06/10: NVDA en las dos cuentas, "disponible −64" con 64 en
# cartera; a las 10:42 ya estaba ajustado). Antes contaba como rechazo del
# mercado y a los 5 frenaba el bot por el día. Ahora:
#  - no suma al freno de los 5 rechazos;
#  - avisa por Telegram con el detalle (una vez por media hora);
#  - pausa 10 minutos la venta de ese escalón y después vuelve a intentar.
# Los demás rechazos siguen frenando como antes.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''let rechMercado = 0;                              // rechazos del mercado seguidos; solo los borra una ejecución''',
    '''let rechMercado = 0;                              // rechazos del mercado seguidos; solo los borra una ejecución
// "Stock insuficiente": bug de Matriz (LP lo reclama a Cocos). No frena: avisa,
// pausa la venta de ese escalón 10 minutos y reintenta.
const pausaVenta = {};                            // nivel -> hasta cuándo no se vuelve a mandar la venta
let ultAvisoStock = 0;''', 'estado')

sub('''      if (st === "REJECTED") { rechazos++; rechMercado++; log(`ERROR orden rechazada por el mercado (${o.lado} ${o.qty} × ${o.px}): ${e.text || ""}`); }''',
    '''      if (st === "REJECTED") {
        if (/stock insuficiente/i.test(e.text || "")) {
          pausaVenta[o.nivel] = Date.now() + 10 * 60_000;
          log(`ERROR stock insuficiente al vender (${o.lado} ${o.qty} × ${o.px}): ${e.text || ""} — bug de Matriz; reintento en 10 min`);
          if (Date.now() - ultAvisoStock > 30 * 60_000) { ultAvisoStock = Date.now(); await tg(`<b>SCALP ${TK} · cuenta ${CUENTA}</b>\\nCocos rechazó la venta de ${o.qty} a ${pesos(o.px)} por "stock insuficiente" (${(e.text || "").slice(0, 120)}). Tengo ${heldTot()} en cartera. Es el bug de Matriz: reclamar a Cocos. Reintento cada 10 minutos.`); }
        } else { rechazos++; rechMercado++; log(`ERROR orden rechazada por el mercado (${o.lado} ${o.qty} × ${o.px}): ${e.text || ""}`); }
      }''', 'rechazo')

sub('''    const v = vs.find((o) => o.lado === "SELL" && o.nivel === k);
    if (!v) await colocar("SELL", k, L.held, alTick((L.costo / L.held) * (1 + ganC()), "arriba"));''',
    '''    const v = vs.find((o) => o.lado === "SELL" && o.nivel === k);
    if (!v && pausaVenta[k] > Date.now()) continue;  // esperando a que Cocos ajuste el stock
    if (!v) await colocar("SELL", k, L.held, alTick((L.costo / L.held) * (1 + ganC()), "arriba"));''', 'venta')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
