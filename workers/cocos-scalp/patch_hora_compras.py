# -*- coding: utf-8 -*-
# cocos-scalp/worker.js: hora de compras separada de la hora de inicio (LP
# 02/10/2026: "cuando quedan papeles en cartera el bot tiene que activarse en
# las dos cuentas para ver de vender y salir en profit; la 72404 sigue normal y
# la 3893 espera para arrancar a comprar").
#  - SCALP_HORA_INICIO: desde cuando el bot trabaja (pone las ventas de lo que
#    arrastra de ruedas anteriores).
#  - SCALP_HORA_COMPRAS (nueva, por defecto = HORA_INICIO): antes de esa hora
#    no compra nada (ni grilla, ni refuerzo, ni lote extra del lateral).
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''const HORA_INICIO = Number(ENV.SCALP_HORA_INICIO || 1035);''',
    '''const HORA_INICIO = Number(ENV.SCALP_HORA_INICIO || 1035);
// Antes de HORA_COMPRAS el bot solo vende lo que arrastra de ruedas anteriores:
// no compra nada (grilla, refuerzo ni lateral). Por defecto, igual a HORA_INICIO.
const HORA_COMPRAS = Math.max(HORA_INICIO, Number(ENV.SCALP_HORA_COMPRAS || HORA_INICIO));''', 'param')

sub('''  const tarde = hm >= HORA_ULTIMO_CICLO;
''', '''  const tarde = hm >= HORA_ULTIMO_CICLO;
  const temprano = hm < HORA_COMPRAS;            // todavía solo se vende lo arrastrado
  if (temprano) S.ultOp = Date.now();            // el reloj del lateral arranca con las compras
''', 'temprano')

sub('''S.ancla && totG >= MAX && ref.held === 0 && !pausaCompras) {''',
    '''S.ancla && totG >= MAX && ref.held === 0 && !pausaCompras && !temprano) {''', 'refuerzo')
sub('''totG + LOTE <= MAX && !pausaCompras && (deseado === 0 ? !tarde : S.ancla)) {''',
    '''totG + LOTE <= MAX && !pausaCompras && !temprano && (deseado === 0 ? !tarde : S.ancla)) {''', 'grilla')
sub('''ref.held === 0 && !pausaCompras && !tarde && Date.now() - S.ultOp >= LATERAL_MIN * 60_000) {''',
    '''ref.held === 0 && !pausaCompras && !tarde && !temprano && Date.now() - S.ultOp >= LATERAL_MIN * 60_000) {''', 'lateral')

sub('''· cierre ${HORA_CIERRE} · tope de pérdida''',
    '''· ${HORA_COMPRAS > HORA_INICIO ? `vende desde ${HORA_INICIO}, compra desde ${HORA_COMPRAS} · ` : ""}cierre ${HORA_CIERRE} · tope de pérdida''', 'encabezado')
sub('''  log(`arranco la rueda con ${n} papeles de ayer · ancla ${S.ancla ? pesos(S.ancla) : "—"}`);''',
    '''  log(`arranco la rueda con ${n} papeles de ayer · ancla ${S.ancla ? pesos(S.ancla) : "—"}${HORA_COMPRAS > HORA_INICIO ? ` · hasta las ${HORA_COMPRAS} solo vendo, no compro` : ""}`);''', 'nuevoDia')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
