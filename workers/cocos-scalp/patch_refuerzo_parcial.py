# -*- coding: utf-8 -*-
# cocos-scalp/worker.js: el refuerzo se habilita con los 5 escalones cargados,
# no con la cantidad maxima exacta (05/10/2026). Un escalon ejecutado a medias
# (INTC 72404: 17 de 25; SNDK 72404: 10 de 58) dejaba la grilla "llena" por
# debajo de SCALP_MAX y el refuerzo no se disparaba nunca.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''  const deseado = h + 1;
  const compras = vs.filter((o) => o.lado === "BUY" && !esExtra(o.nivel));''',
    '''  const deseado = h + 1;
  const llena = h === NIVELES - 1;               // los 5 escalones tienen papeles (aunque alguno esté a medias)
  const compras = vs.filter((o) => o.lado === "BUY" && !esExtra(o.nivel));''', 'llena')
sub('''!(c.nivel === NIVEL_REF && totG >= MAX)) await cancelar(c, "la grilla se movió");''',
    '''!(c.nivel === NIVEL_REF && llena)) await cancelar(c, "la grilla se movió");''', 'cancel')
sub('''&& S.ancla && totG >= MAX && ref.held === 0 && !pausaCompras && !temprano) {''',
    '''&& S.ancla && llena && ref.held === 0 && !pausaCompras && !temprano) {''', 'refuerzo')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
