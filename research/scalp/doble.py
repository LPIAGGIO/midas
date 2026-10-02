# -*- coding: utf-8 -*-
# Idea de LP (01/10/2026): sin corte; con los 5 escalones cargados, si cae "el
# doble mas" compra otra vez lo mismo que tiene y sale todo junto en el
# promedio + ganancia. Se compara contra la grilla sin corte.
import json, os, sys, time, urllib.request, statistics as st
import grilla5y as g
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'd10')
def d10(tk): return [tuple(r) for r in json.load(open(os.path.join(D, tk + '.json')))]
_c = {}
def maxd(tk):
    if tk in _c: return _c[tk]
    u = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&period1=631152000&period2=%d' % (tk, int(time.time()))
    j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    _c[tk] = [(time.strftime('%Y-%m-%d', time.gmtime(t)), o, h, l, c) for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']) if o and h and l and c and l > 0]
    return _c[tk]
def linea(nombre, r):
    return '%-22s total %+6.0f · peor abierto %6.0f · peor caida %6.0f · capital usado max %5.0f · cargada %3.0f%% · racha %4d d · %4d vueltas' % (nombre, r['total'], r['peor_abierto'], r['dd'], r['capmax'], r['cargado'], r['racha'], r['rondas'])
def caso(titulo, per, paso, gan):
    print('== ' + titulo + ' · papel %+.0f%%' % ((per[-1][4] / per[0][1] - 1) * 100))
    print('   ' + linea('sin corte', g.grilla(per, paso, gan, None)))
    for fr in (0.5, 1.0):
        print('   ' + linea('+ %d%% mas a -%.0f%%' % (fr * 100, 2 * paso * 4 * 100), g.grilla(per, paso, gan, None, doble=2.0, frac=fr)))
mu = maxd('MU')
caso('MU 2021-09 a 2026-09', [r for r in mu if '2021-09-17' <= r[0] <= '2026-09-17'], 0.01, 0.007)
caso('MU 2016-10 a 2021-09', [r for r in mu if '2016-10-03' <= r[0] < '2021-09-17'], 0.01, 0.007)
caso('MU 2000-03 a 2010-03 (ciclo malo)', [r for r in mu if '2000-03-01' <= r[0] < '2010-03-01'], 0.01, 0.007)
caso('MU 2007-07 a 2012-07 (ciclo malo)', [r for r in mu if '2007-07-01' <= r[0] < '2012-07-01'], 0.01, 0.007)
caso('SNDK 2025-02 a 2026-09 (grilla 1,5% / 1%)', [r for r in d10('SNDK') if r[0] >= '2025-02-13'], 0.015, 0.01)
print('== 263 papeles 2021-09 a 2026-09 · grilla 1% / 0,7%')
filas = []
for f in sorted(os.listdir(D)):
    rows = d10(f[:-5]); per = [r for r in rows if r[0] >= '2021-09-17']
    if len(per) < 1000 or len(rows) - len(per) < 700: continue
    a = g.grilla(per, 0.01, 0.007, None); b = g.grilla(per, 0.01, 0.007, None, doble=2.0, frac=0.5)
    filas.append((f[:-5], a['total'], b['total'], a['racha'], b['racha'], a['peor_abierto'], b['peor_abierto']))
for i, n in ((1, 'sin corte'), (2, '+50% a -8%')):
    v = [x[i] for x in filas]
    print('   %-12s mediana %+6.0f · promedio %+6.0f · positivos %3d%% · peor %+6.0f · racha mediana %d d · peor abierto mediano %.0f' % (n, st.median(v), sum(v) / len(v), 100 * sum(1 for x in v if x > 0) / len(v), min(v), st.median([x[i + 2] for x in filas]), st.median([x[i + 4] for x in filas])))
print('   mejora con el doble en %d de %d papeles · empeora en %d' % (sum(1 for x in filas if x[2] > x[1] + 1), len(filas), sum(1 for x in filas if x[2] < x[1] - 1)))
