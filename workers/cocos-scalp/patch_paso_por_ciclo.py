# -*- coding: utf-8 -*-
# cocos-scalp/worker.js: el paso y la ganancia pertenecen al CICLO (04/10/2026).
# LP ensancha el escalon de la cuenta 3893 a 1,5 veces. Los ciclos que ya estan
# abiertos (papeles arrastrados) tienen que terminar con el paso y la ganancia
# con que se abrieron: si no, sus ventas se alejarian 0,35% y los escalones
# quedarian a distancias mezcladas. El paso nuevo rige desde el proximo ciclo.
#  - S.paso / S.gan: se fijan cuando el ciclo toma su ancla.
#  - SCALP_PASO_PREVIO / SCALP_GANANCIA_PREVIA: solo para la primera vez que
#    arranca esta version con un ciclo abierto (el estado todavia no los trae).
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''const GANANCIA = Number(ENV.SCALP_GANANCIA || 0.0025);  // objetivo por lote''',
    '''const GANANCIA = Number(ENV.SCALP_GANANCIA || 0.0025);  // objetivo por lote
// El paso y la ganancia son del CICLO: se fijan cuando toma su ancla y no cambian
// hasta que se vende todo. Un cambio en el .env rige desde el ciclo siguiente.
// Los PREVIOS solo se usan la primera vez, si hay un ciclo abierto sin esos datos.
const PASO_PREVIO = Number(ENV.SCALP_PASO_PREVIO || PASO);
const GANANCIA_PREVIA = Number(ENV.SCALP_GANANCIA_PREVIA || GANANCIA);''', 'params')

sub('''  if (S.ultOp == null) S.ultOp = Date.now();     // última ejecución (para la regla del lateral)
}''', '''  if (S.ultOp == null) S.ultOp = Date.now();     // última ejecución (para la regla del lateral)
  if (S.paso == null || S.gan == null) {
    const abierto = S.ancla != null || S.niveles.some((n) => n.held > 0);
    S.paso = abierto ? PASO_PREVIO : PASO; S.gan = abierto ? GANANCIA_PREVIA : GANANCIA;
  }
}
const pasoC = () => S.paso || PASO;              // paso del ciclo en curso
const ganC = () => S.gan || GANANCIA;            // ganancia del ciclo en curso''', 'estado')

sub('''    if (S.ancla == null) { S.ancla = avg; S.reentrada = null; }''',
    '''    if (S.ancla == null) { S.ancla = avg; S.reentrada = null; S.paso = PASO; S.gan = GANANCIA; }''', 'ancla')

sub('''salida conjunta a ${pesos(alTick((costo / tot) * (1 + GANANCIA), "arriba"))}`);''',
    '''salida conjunta a ${pesos(alTick((costo / tot) * (1 + ganC()), "arriba"))}`);''', 'log-refuerzo')
sub('''    if (!v) await colocar("SELL", k, L.held, alTick((L.costo / L.held) * (1 + GANANCIA), "arriba"));''',
    '''    if (!v) await colocar("SELL", k, L.held, alTick((L.costo / L.held) * (1 + ganC()), "arriba"));''', 'venta')
sub('''    const pxRef = alTick(S.ancla * (1 - REFUERZO_MULT * PASO * (NIVELES - 1)), "abajo");''',
    '''    const pxRef = alTick(S.ancla * (1 - REFUERZO_MULT * pasoC() * (NIVELES - 1)), "abajo");''', 'refuerzo')
sub('''    else px = Math.min(alTick(S.ancla * (1 - PASO * deseado), "abajo"), b.ask);''',
    '''    else px = Math.min(alTick(S.ancla * (1 - pasoC() * deseado), "abajo"), b.ask);''', 'escalon')

sub('''  if (S.fin) log(`el día ya se cerró (${S.fin}). Mañana retoma solo.`);''',
    '''  if (heldTot() > 0 && (pasoC() !== PASO || ganC() !== GANANCIA)) log(`ciclo abierto con paso ${(pasoC() * 100).toFixed(2)}% y ganancia ${(ganC() * 100).toFixed(2)}%: termina así; el paso ${(PASO * 100).toFixed(2)}% rige desde el próximo ciclo`);
  if (S.fin) log(`el día ya se cerró (${S.fin}). Mañana retoma solo.`);''', 'aviso')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
