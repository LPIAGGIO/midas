# -*- coding: utf-8 -*-
# grilla5y.py (05/10/2026): tres agregados para simular la rueda real de un dia
# y medir la recompra despues de una venta en salto de apertura.
#   inicial     : dict(ancla, lots={k:(precio, unidades, costo)}, paso, gan, prev_c)
#                 estado arrastrado con que arranca (por defecto arranca vacio).
#   nobuy       : conjunto de indices de vela en los que NO se compra nada
#                 (escalones, refuerzo, reapertura ni lateral). Las ventas siguen.
#   tope_barras : si una venta se ejecuto en el salto de apertura (primera vela
#                 de la rueda, por encima de su objetivo) y cerro el ciclo, no se
#                 reabre por encima del OBJETIVO de esa venta durante las
#                 primeras tope_barras velas de la rueda. 0 = apagado.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'grilla5y.py')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et, n=1):
    global s
    if s.count(a) == n: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub("lateral_hasta_esc=None, dinamico=None):", "lateral_hasta_esc=None, dinamico=None, inicial=None, nobuy=None, tope_barras=0):", 'firma')
sub("paso=paso, gan=gan, pg=(paso, gan))\n    lots = {}          # k -> (precio, unidades, costo_usd)",
    "paso=paso, gan=gan, pg=(paso, gan), nb=False, bs=0, tope=None, topes=0)\n    lots = {}          # k -> (precio, unidades, costo_usd)\n"
    "    if inicial:\n        E['ancla'] = inicial.get('ancla')\n        lots.update(inicial.get('lots') or {})\n"
    "        E['paso'], E['gan'] = inicial.get('paso', paso), inicial.get('gan', gan)", 'inicial')
# sin compras en las velas marcadas
sub("""        pos = p0
        if p1 < p0:
            while True:
                if E['parado'] == fecha:
                    return""", """        pos = p0
        if p1 < p0:
            if E['nb']:
                return
            while True:
                if E['parado'] == fecha:
                    return""", 'nobuy-mover')
# la venta que cierra el ciclo en el salto de apertura deja un tope para reabrir
sub("""                vender(k, p1 if salto else obj, fecha)
                if not lots:
                    E['reent'] = E['ancla']
                    E['ancla'] = None
                    E['espera'] = espera_barras""", """                vender(k, p1 if salto else obj, fecha)
                if not lots:
                    E['reent'] = E['ancla']
                    E['ancla'] = None
                    E['espera'] = espera_barras
                    if tope_barras and salto and E['bs'] == 0 and p1 > obj:
                        E['tope'] = obj          # no reabrir por encima del objetivo de esta venta
                        E['topes'] += 1""", 'tope-set')
sub("""    prev_c = None
    prev_f = None
    for i, (fecha, o, h, l, c) in enumerate(bars):""", """    prev_c = inicial.get('prev_c') if inicial else None
    prev_f = None
    for i, (fecha, o, h, l, c) in enumerate(bars):
        E['nb'] = nobuy is not None and i in nobuy
        if E['nb']:
            E['idle'] = 0               # el reloj del lateral arranca con las compras
        E['bs'] = 0 if fecha != prev_f else E['bs'] + 1
        if E['tope'] is not None and E['bs'] >= tope_barras:
            E['tope'] = None            # paso la ventana: vuelve a seguir al precio""", 'bucle')
sub("""        if E['ok'] and E['ancla'] is None and E['parado'] is None and E['reent'] is None:
            if entrada_off > 0:""", """        if E['ok'] and E['ancla'] is None and E['parado'] is None and E['reent'] is None and not E['nb'] and not lots:
            if entrada_off > 0:""", 'abre')
sub("""        if E['ok'] and E['ancla'] is None and E['parado'] is None:
            if E['espera'] > 0:
                E['espera'] -= 1        # sigue esperando que vuelva al ancla""", """        if E['ok'] and E['ancla'] is None and E['parado'] is None and not E['nb'] and not lots:
            if E['tope'] is not None:
                E['reent'] = max(E['reent'] or 0, E['tope']) if c > E['tope'] else None
                if c <= E['tope']:
                    comprar(0, c)       # ya esta por debajo del objetivo de la venta: reabre
            elif E['espera'] > 0:
                E['espera'] -= 1        # sigue esperando que vuelva al ancla""", 'reabre')
sub("""and E['parado'] is None and (lateral_hasta_esc is None or nesc <= lateral_hasta_esc):""",
    """and E['parado'] is None and not E['nb'] and (lateral_hasta_esc is None or nesc <= lateral_hasta_esc):""", 'lateral')
sub("""s_lot=s_lot, s_cap=s_cap, extras=E['extras'])""", """s_lot=s_lot, s_cap=s_cap, extras=E['extras'], topes=E['topes'])""", 'retorno')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
