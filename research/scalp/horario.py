# -*- coding: utf-8 -*-
# "¿Y si una cuenta arranca 2 horas despues?" (LP 02/10/2026). La cuenta B no
# opera (ni compra ni vende) antes de la hora indicada; lo que quedo de dias
# anteriores se arrastra igual. Sin corte, refuerzo 50%. USD, 2.300 por papel.
import json, os, time
import grilla5y as g
PAPELES = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
           ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005)]
B5 = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backtest-5y', 'data', 'hourly')
def velas(tk, serie):
    out = []
    if serie == '5m':
        for t, o, h, l, c, v in json.load(open('%s_5m.json' % tk.lower())):
            lt = time.gmtime(t - 3 * 3600); out.append((time.strftime('%Y-%m-%d', lt), lt.tm_hour * 100 + lt.tm_min, o, h, l, c))
    else:
        j = json.load(open(os.path.join(B5, tk + '.json')))['chart']['result'][0]; q = j['indicators']['quote'][0]
        for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']):
            if o and h and l and c:
                lt = time.gmtime(t - 4 * 3600)   # hora de Nueva York; BYMA abre a la misma hora de reloj +1
                out.append((time.strftime('%Y-%m-%d', lt), (lt.tm_hour + 1) * 100 + lt.tm_min, o, h, l, c))
    return out
for serie, esp in (('5m', 4), ('hourly', 0)):
    print('\n== velas %s · los 9 papeles · USD' % serie)
    print('   %-22s %10s %10s %12s %14s %12s' % ('arranque de la cuenta', 'resultado', 'vueltas', 'por rueda', 'suma de peores', 'cargada'))
    base = None
    for nombre, desde in (('10:35 (actual)', 1035), ('11:35', 1135), ('12:35', 1235), ('13:35', 1335), ('14:35', 1435)):
        tot = vu = peor = 0.0; carg = n = 0; dias = 0; series = {}
        for tk, p, gn in PAPELES:
            v = [x for x in velas(tk, serie) if desde <= x[1] < 1645]
            bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
            if not bars: continue
            r = g.grilla(bars, p, gn, None, doble=2.0, frac=0.5, espera_barras=esp)
            tot += r['total']; vu += r['rondas']; peor += r['peor_abierto']; carg += sum(1 for x in r['s_lot'] if x >= 4); n += len(r['s_lot']); dias = max(dias, r['dias'])
        if base is None: base = tot
        print('   %-22s %+10.0f %10d %+12.1f %14.0f %11.0f%%   A + esta cuenta: %+.0f' % (nombre, tot, vu, tot / dias, peor, 100.0 * carg / n, base + tot))
