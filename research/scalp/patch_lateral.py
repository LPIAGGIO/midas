# -*- coding: utf-8 -*-
# grilla5y.py: regla del lateral (LP 02/10/2026: "comprar medio lote al precio
# si pasan 2 hs y no pasa nada"). Parametros:
#   lateral_barras : velas sin ninguna ejecucion (compra o venta) tras las
#                    cuales compra un lote extra al precio. 0 = apagado.
#   lateral_frac   : tamaño del lote extra (0,5 = medio lote).
#   lateral_max    : cuantos extras puede tener abiertos a la vez.
# El extra se vende solo a su costo + ganancia, como cualquier lote. No cuenta
# como escalon de la grilla. Si entra el refuerzo, sale en el promedio con todo.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'grilla5y.py')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et, n=1):
    global s
    if s.count(a) == n: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))
sub("entrada_off=0.0, espera_barras=0):", "entrada_off=0.0, espera_barras=0, lateral_barras=0, lateral_frac=0.5, lateral_max=4):", 'firma')
sub("capmax=LOTE * NIV, espera=0)", "capmax=LOTE * NIV, espera=0, idle=0, nx=0, extras=0)", 'estado')
sub("""    def comprar(k, px):
        lots[k] = (px, LOTE * E['fx'] / px, LOTE)""", """    def comprar(k, px):
        E['idle'] = 0
        lots[k] = (px, LOTE * E['fx'] / px, LOTE)""", 'comprar')
sub("""    def vender(k, px, fecha):
        co, u, cusd = lots.pop(k)""", """    def vender(k, px, fecha):
        E['idle'] = 0
        co, u, cusd = lots.pop(k)""", 'vender')
sub("h = max((k for k in lots if k != X), default=-1)", "h = max((k for k in lots if k < NIV), default=-1)", 'h')
sub("""        ab = sum(u * c / E['fx'] - cusd for (_, u, cusd) in lots.values())
        peor_abierto = min(peor_abierto, ab)""", """        # Regla del lateral: tantas velas sin ejecuciones → un lote extra al precio.
        E['idle'] += 1
        if lateral_barras and E['idle'] >= lateral_barras and lots and X not in lots and E['parado'] is None:
            vivos = sum(1 for k in lots if k >= 100)
            if vivos < lateral_max:
                E['nx'] += 1
                lots[100 + E['nx']] = (c, lateral_frac * LOTE * E['fx'] / c, lateral_frac * LOTE)
                E['extras'] += 1
                E['idle'] = 0
        E['capmax'] = max(E['capmax'], sum(v[2] for v in lots.values()))
        ab = sum(u * c / E['fx'] - cusd for (_, u, cusd) in lots.values())
        peor_abierto = min(peor_abierto, ab)""", 'regla')
sub("""racha=racha_max, dias=dias, anio=por_anio, eq=eq, s_ab=s_ab, s_lot=s_lot)""", """racha=racha_max, dias=dias, anio=por_anio, eq=eq, s_ab=s_ab, s_lot=s_lot, extras=E['extras'])""", 'retorno')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
