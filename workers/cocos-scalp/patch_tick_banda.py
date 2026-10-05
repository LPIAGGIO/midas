# -*- coding: utf-8 -*-
# cocos-scalp/worker.js (05/10/2026, en rueda, autorizado por LP):
#  1) TICK POR BANDA DE PRECIO. BYMA cambia el salto minimo segun el precio y
#     Primary informa uno solo (el de la banda donde cotiza el papel). META en
#     la 3893 compro a $49.980 y su venta a +1,05% caia en $50.520: multiplo de
#     20 (el tick informado) pero invalido arriba de $50.000. 590 rechazos.
#     Bandas inferidas de lo que informa Primary para los 9 papeles: <10.000 →
#     5; <20.000 → 10; <50.000 → 20; resto → 25. Si el precio cae en una banda
#     distinta de la del tick informado se usa el minimo comun multiplo de los
#     dos (valido con cualquiera de las dos reglas).
#  2) RECHAZOS DEL MERCADO. El contador se ponia en cero cada vez que se enviaba
#     una orden, asi que el freno de "tres rechazos" nunca saltaba cuando el
#     rechazo llegaba despues del envio. Ahora los rechazos del mercado se
#     cuentan aparte y solo los borra una ejecucion: a los 5 seguidos el bot se
#     frena y avisa.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''const alTick = (px, modo) => { const n = px / TICK; const k = modo === "arriba" ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9); return Math.round(k * TICK * 1000) / 1000; };''',
    '''// BYMA cambia el salto mínimo según el precio; Primary informa uno solo (el de
// la banda donde cotiza hoy). Si el precio pedido cae en otra banda se usa el
// mínimo común múltiplo del tick informado y el de esa banda.
const tickBanda = (px) => (px < 10000 ? 5 : px < 20000 ? 10 : px < 50000 ? 20 : 25);
const mcd = (a, b) => (b ? mcd(b, a % b) : a);
const tickDe = (px) => { const tb = tickBanda(px); return !Number.isInteger(TICK) || TICK < 5 || TICK === tb ? TICK : (TICK * tb) / mcd(TICK, tb); };
const redondear = (px, t, modo) => (modo === "arriba" ? Math.ceil(px / t - 1e-9) : Math.floor(px / t + 1e-9)) * t;
const alTick = (px, modo) => {
  let r = redondear(px, tickDe(px), modo);
  if (tickDe(r) !== tickDe(px)) r = redondear(r, tickDe(r), modo);     // el redondeo cruzó de banda
  return Math.round(r * 1000) / 1000;
};''', 'tick')

sub('''let rechazos = 0, pausaCompras = 0,''', '''let rechMercado = 0;                              // rechazos del mercado seguidos; solo los borra una ejecución
let rechazos = 0, pausaCompras = 0,''', 'contador')
sub('''  const dq = cum - o.cum; if (!(dq > 0)) return;
  S.ultOp = Date.now();''', '''  const dq = cum - o.cum; if (!(dq > 0)) return;
  S.ultOp = Date.now(); rechMercado = 0;''', 'reset')
sub('''      if (st === "REJECTED") { rechazos++; log(`ERROR orden rechazada por el mercado: ${e.text || ""}`); }''',
    '''      if (st === "REJECTED") { rechazos++; rechMercado++; log(`ERROR orden rechazada por el mercado (${o.lado} ${o.qty} × ${o.px}): ${e.text || ""}`); }''', 'rechazo')
sub('''  if (rechazos >= 3) { for (const o of vivas()) await cancelar(o, "rechazos"); S.fin = "tres órdenes rechazadas seguidas";''',
    '''  if (rechazos >= 3 || rechMercado >= 5) { for (const o of vivas()) await cancelar(o, "rechazos"); S.fin = rechMercado >= 5 ? "cinco órdenes rechazadas por el mercado" : "tres órdenes rechazadas seguidas";''', 'freno')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
