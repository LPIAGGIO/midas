# -*- coding: utf-8 -*-
# Regla del lateral (LP 02/10/2026): si pasan 2 horas sin ninguna ejecucion,
# comprar medio lote al precio. Los 9 papeles, sin corte, refuerzo 50%.
# Como la regla usa mas capital, se compara tambien el rendimiento sobre el
# capital MAXIMO que llego a usar cada variante.
import json, os, time
import grilla5y as g
PAPELES = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
           ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005)]


def barras5m(tk):
    out = []
    for t, o, h, l, c, v in json.load(open('%s_5m.json' % tk.lower())):
        lt = time.gmtime(t - 3 * 3600)
        hm = lt.tm_hour * 100 + lt.tm_min
        if 1035 <= hm < 1645:
            out.append((time.strftime('%Y-%m-%d', lt), o, h, l, c))
    return out


def correr(serie, porhora, esp):
    VAR = [('sin regla (hoy)', {}),
           ('medio lote a las 2 h', dict(lateral_barras=2 * porhora, lateral_frac=0.5)),
           ('medio lote a la 1 h', dict(lateral_barras=1 * porhora, lateral_frac=0.5)),
           ('medio lote a las 4 h', dict(lateral_barras=4 * porhora, lateral_frac=0.5)),
           ('lote entero a las 2 h', dict(lateral_barras=2 * porhora, lateral_frac=1.0)),
           ('medio lote a las 2 h, hasta 8', dict(lateral_barras=2 * porhora, lateral_frac=0.5, lateral_max=8)),
           ('medio lote a las 2 h, hasta 2', dict(lateral_barras=2 * porhora, lateral_frac=0.5, lateral_max=2))]
    print('\n== velas %s · 9 papeles · USD' % serie)
    print('   %-30s %10s %8s %8s %14s %12s %14s %10s' % ('variante', 'resultado', 'vueltas', 'extras', 'suma de peores', 'capital max', 'sobre cap. max', 'mejoran'))
    base = {}
    for nombre, kw in VAR:
        tot = vu = ex = peor = cap = 0.0
        mej = 0
        dias = 0
        for tk, p, gn in PAPELES:
            bars = barras5m(tk) if serie == '5m' else g.cargar(tk, serie)
            r = g.grilla(bars, p, gn, None, doble=2.0, frac=0.5, espera_barras=esp, **kw)
            tot += r['total']; vu += r['rondas']; ex += r['extras']; peor += r['peor_abierto']; cap += r['capmax']; dias = max(dias, r['dias'])
            if not kw: base[tk] = r['total']
            elif r['total'] > base[tk]: mej += 1
        print('   %-30s %+10.0f %8d %8d %14.0f %12.0f %13.1f%% %7s' % (nombre, tot, vu, ex, peor, cap, 100.0 * tot / cap, '' if not kw else '%d de 9' % mej))


if __name__ == '__main__':
    correr('5m', 12, 4)
    correr('hourly', 1, 0)
