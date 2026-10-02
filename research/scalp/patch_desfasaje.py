# -*- coding: utf-8 -*-
# grilla5y.py: parametros para medir dos cuentas DESFASADAS (LP 02/10/2026:
# "hizo la diferencia entrar con la otra cuenta en diferente horario y
# posicion... para que lo midamos").
#   entrada_off   : al abrir un ciclo no compra al precio; espera una caida de
#                   ese porcentaje (la orden sigue al precio hacia arriba).
#   espera_barras : velas que espera a que el precio vuelva al ancla antes de
#                   perseguirlo (en vivo son 20 minutos).
# Devuelve ademas las series por vela (resultado, abierto, lotes) para poder
# sumar dos cuentas y medir el peor momento COMBINADO.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'grilla5y.py')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et, n=1):
    global s
    if s.count(a) == n: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))
sub("permitido=None, doble=None, frac=1.0):", "permitido=None, doble=None, frac=1.0, entrada_off=0.0, espera_barras=0):", 'firma')
sub("fx=1.0, ok=True, capmax=LOTE * NIV)", "fx=1.0, ok=True, capmax=LOTE * NIV, espera=0)", 'estado')
sub("""                    E['reent'] = E['ancla']
                    E['ancla'] = None""", """                    E['reent'] = E['ancla']
                    E['ancla'] = None
                    E['espera'] = espera_barras""", 'ciclo', 2)
sub("""        if E['ok'] and E['ancla'] is None and E['parado'] is None and E['reent'] is None:
            comprar(0, o)               # arranque, o primera vela despues de un corte""",
    """        if E['ok'] and E['ancla'] is None and E['parado'] is None and E['reent'] is None:
            if entrada_off > 0:
                E['reent'] = o * (1 - entrada_off)   # espera una caida antes de abrir el ciclo
            else:
                comprar(0, o)           # arranque, o primera vela despues de un corte""", 'arranque')
sub("""        if E['ok'] and E['ancla'] is None and E['parado'] is None:
            E['reent'] = None
            comprar(0, c)               # no volvio al ancla: sigue al precio""",
    """        if E['ok'] and E['ancla'] is None and E['parado'] is None:
            if E['espera'] > 0:
                E['espera'] -= 1        # sigue esperando que vuelva al ancla
            elif entrada_off > 0:
                E['reent'] = c * (1 - entrada_off)   # la orden sigue al precio, siempre una caida abajo
            else:
                E['reent'] = None
                comprar(0, c)           # no volvio al ancla: sigue al precio""", 'persecucion')
sub("""        eq.append(E['real'] + ab)""", """        eq.append(E['real'] + ab)
        s_ab.append(ab)
        s_lot.append(len(lots))""", 'series')
sub("""    eq = []
    cargado = racha = racha_max = 0""", """    eq = []
    s_ab = []
    s_lot = []
    cargado = racha = racha_max = 0""", 'series-init')
sub("""racha=racha_max, dias=dias, anio=por_anio)""", """racha=racha_max, dias=dias, anio=por_anio, eq=eq, s_ab=s_ab, s_lot=s_lot)""", 'retorno')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
