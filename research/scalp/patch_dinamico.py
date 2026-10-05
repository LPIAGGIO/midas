# -*- coding: utf-8 -*-
# grilla5y.py: escalon variable en el tiempo (04/10/2026, idea de mazda_miata en
# moltbook: "volatility-scaled rung, k*ATR instead of a fixed percent").
#   dinamico : dict fecha -> (paso, ganancia). El paso y la ganancia de un ciclo
#              se fijan cuando el ciclo abre (al tomar el ancla) y no cambian
#              hasta que se vende todo. None = paso fijo, como siempre.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'grilla5y.py')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et, n=1):
    global s
    if s.count(a) == n: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))
sub("lateral_max=4, lateral_hasta_esc=None):", "lateral_max=4, lateral_hasta_esc=None, dinamico=None):", 'firma')
sub("capmax=LOTE * NIV, espera=0, idle=0, nx=0, extras=0)", "capmax=LOTE * NIV, espera=0, idle=0, nx=0, extras=0, paso=paso, gan=gan, pg=(paso, gan))", 'estado')
sub("""        if E['ancla'] is None:
            E['ancla'] = px""", """        if E['ancla'] is None:
            E['ancla'] = px
            E['paso'], E['gan'] = E['pg']          # el ciclo nace con el paso vigente ese dia""", 'ancla')
sub("px = E['ancla'] * (1 - doble * paso * (NIV - 1))", "px = E['ancla'] * (1 - doble * E['paso'] * (NIV - 1))", 'doble')
sub("px = E['ancla'] * (1 - paso * (h + 1))", "px = E['ancla'] * (1 - E['paso'] * (h + 1))", 'escalon')
sub("/ ut * (1 + gan)", "/ ut * (1 + E['gan'])", 'venta-conjunta')
sub("obj = lots[k][0] * (1 + gan)", "obj = lots[k][0] * (1 + E['gan'])", 'venta')
sub("""        if E['parado'] is not None and E['parado'] != fecha:""", """        if dinamico is not None:
            E['pg'] = dinamico.get(fecha, (paso, gan))
        if E['parado'] is not None and E['parado'] != fecha:""", 'por-dia')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
