# -*- coding: utf-8 -*-
# Salto de apertura (LP 05/10/2026: "las ventas tienen que ser tipo 30 minutos
# despues de que abra el mercado, cuando abre con un salto grande").
# Pregunta medible: cuando el papel abre con salto para arriba, ¿a los 30 / 60
# minutos esta mas arriba o mas abajo que en la apertura? Si sigue subiendo,
# conviene demorar la venta; si afloja, conviene vender en la apertura (y lo
# que hay que demorar es la RECOMPRA).
#  - 5 minutos (~43 ruedas): apertura (9:35 ET, cuando arranca el bot) contra
#    +30 y +60 minutos.
#  - Horario (~730 ruedas): apertura contra el cierre de la primera hora.
import json, os, time, statistics as st
import grilla5y as g
AQUI = os.path.dirname(os.path.abspath(__file__))
P = ['MU', 'SNDK', 'NVDA', 'GOOGL', 'AMD', 'INTC', 'META', 'AAPL', 'MSFT']
CORTES = [(0.005, 0.01), (0.01, 0.02), (0.02, 9), (-0.01, -0.005), (-0.02, -0.01), (-9, -0.02)]


def resumen(nombre, v):
    if len(v) < 5:
        return '   %-34s n=%d (muy pocos)' % (nombre, len(v))
    return '   %-34s n=%4d · promedio %+.2f%% · mediana %+.2f%% · sube %2.0f%% de las veces' % (nombre, len(v), 100 * st.mean(v), 100 * st.median(v), 100.0 * sum(1 for x in v if x > 0) / len(v))


def cinco():
    print('VELAS DE 5 MINUTOS · 9 papeles · desde las 9:35 de NY (10:35 de aca, cuando arranca el bot)')
    filas = []
    for tk in P:
        dias = {}
        for t, o, h, l, c, v in json.load(open(os.path.join(AQUI, '%s_5m.json' % tk.lower()))):
            lt = time.gmtime(t - 4 * 3600); hm = lt.tm_hour * 100 + lt.tm_min
            if 930 <= hm < 1600 and c:
                dias.setdefault(time.strftime('%Y-%m-%d', lt), []).append((hm, o, h, l, c))
        ks = sorted(dias)
        for a, b in zip(ks, ks[1:]):
            prev = dias[a][-1][4]; d = dias[b]
            if len(d) < 20 or d[0][0] != 930: continue
            ap = d[1][1]                                  # precio a las 9:35
            salto = d[0][1] / prev - 1                    # apertura contra el cierre anterior
            p30 = next((x[4] for x in d if x[0] == 1000), None)
            p60 = next((x[4] for x in d if x[0] == 1030), None)
            if p30 and p60:
                mx30 = max(x[2] for x in d if 935 <= x[0] <= 1000)
                mn60 = min(x[3] for x in d if 935 <= x[0] <= 1030)
                filas.append((salto, p30 / ap - 1, p60 / ap - 1, mx30 / ap - 1, mn60 / ap - 1, d[-1][4] / ap - 1))
    for lo, hi in CORTES:
        s = [f for f in filas if lo <= f[0] < hi]
        print('\n  Salto de apertura entre %+.1f%% y %s (%d casos)' % (lo * 100, '%+.1f%%' % (hi * 100) if abs(hi) < 9 else 'mas', len(s)))
        print(resumen('a los 30 min vs 9:35', [f[1] for f in s]))
        print(resumen('a los 60 min vs 9:35', [f[2] for f in s]))
        print(resumen('al cierre vs 9:35', [f[5] for f in s]))
        if len(s) >= 5:
            print('   maximo de los primeros 30 min: mediana %+.2f%% · minimo de la primera hora: mediana %+.2f%%' % (100 * st.median([f[3] for f in s]), 100 * st.median([f[4] for f in s])))


def horario():
    print('\n\nVELAS HORARIAS · 9 papeles · ~3 años · apertura contra el cierre de la primera hora y del dia')
    filas = []
    for tk in P:
        dias = {}
        for b in g.cargar(tk, 'hourly'):
            dias.setdefault(b[0], []).append(b)
        ks = sorted(dias)
        for a, b in zip(ks, ks[1:]):
            prev = dias[a][-1][4]; d = dias[b]
            if len(d) < 5: continue
            ap = d[0][1]
            filas.append((ap / prev - 1, d[0][4] / ap - 1, d[-1][4] / ap - 1, b[:4]))
    for lo, hi in CORTES:
        s = [f for f in filas if lo <= f[0] < hi]
        print('\n  Salto de apertura entre %+.1f%% y %s (%d casos)' % (lo * 100, '%+.1f%%' % (hi * 100) if abs(hi) < 9 else 'mas', len(s)))
        print(resumen('primera hora vs apertura', [f[1] for f in s]))
        print(resumen('cierre vs apertura', [f[2] for f in s]))
        por = {}
        for f in s: por.setdefault(f[3], []).append(f[1])
        print('   primera hora por año: ' + ' · '.join('%s %+.2f%% (n=%d)' % (y, 100 * st.mean(v), len(v)) for y, v in sorted(por.items())))


if __name__ == '__main__':
    cinco()
    horario()
