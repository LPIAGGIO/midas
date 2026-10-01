# -*- coding: utf-8 -*-
# Scalp MU: (1) cuanto tarda en retroceder 0,25% despues de un maximo del dia;
# (2) cuanto tarda en volver al precio de compra despues de vender a +0,25%;
# (3) la grilla del bot simulada sobre las velas con distintas esperas.
# Supuestos conservadores: una compra apoyada se ejecuta solo si el minimo de
# la vela queda POR DEBAJO del precio; una venta, si el maximo queda POR
# ENCIMA; un lote no se vende en la misma vela en que se compro.
import json, sys, time, statistics as st
from collections import defaultdict
IV = sys.argv[1] if len(sys.argv) > 1 else '1m'
TK = sys.argv[2] if len(sys.argv) > 2 else 'MU'
PX_ARS = float(sys.argv[3]) if len(sys.argv) > 3 else 347500.0   # precio del CEDEAR, para pasar a pesos
MIN = 1 if IV == '1m' else 5
rows = json.load(open('%s_%s.json' % (TK.lower(), IV)))
dias = defaultdict(list)
for t, o, h, l, c, v in rows:
    lt = time.gmtime(t - 3 * 3600)                    # hora argentina
    hm = lt.tm_hour * 100 + lt.tm_min
    if 1035 <= hm < 1645: dias[time.strftime('%Y-%m-%d', lt)].append((t, o, h, l, c))
dias = {d: b for d, b in dias.items() if len(b) > 200 / MIN}
print('== %s %s · %d ruedas (%s a %s)' % (TK, IV, len(dias), min(dias), max(dias)))
def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * p))]
def resumen(nombre, ts, nunca):
    n = len(ts) + nunca
    if not n: return
    print('%s: %d casos · nunca en el dia %.0f%%' % (nombre, n, 100 * nunca / n))
    print('   dentro de  ' + '  '.join('%d min: %2.0f%%' % (m, 100 * sum(1 for x in ts if x <= m) / n) for m in (2, 5, 10, 15, 20, 30, 60, 120)))
    if ts: print('   mediana %d min · p75 %d · p90 %d (de los que volvieron)' % (st.median(ts), pct(ts, .75), pct(ts, .9)))

# (1) maximos del dia: tiempo hasta retroceder 0,25%
G = 0.0025
ts, nunca = [], 0
for d, b in dias.items():
    mx = max(x[2] for x in b[:max(1, 15 // MIN)])
    for i in range(max(1, 15 // MIN), len(b)):
        if b[i][2] > mx:
            mx = b[i][2]
            if i + 1 < len(b) and b[i + 1][2] > mx: continue      # sigue subiendo: cuenta el ultimo del tramo
            obj = mx * (1 - G)
            j = next((k for k in range(i + 1, len(b)) if b[k][3] <= obj), None)
            if j is None: nunca += 1
            else: ts.append((j - i) * MIN)
resumen('(1) tras un maximo del dia, tiempo hasta bajar 0,25%', ts, nunca)

# (3) grilla
FEE = 0.00044 * 1.21; PASO = 0.003; CORTE = 0.018; NIV = 5; ARS = PX_ARS / rows[-1][4]; LOTE = float(sys.argv[4]) if len(sys.argv) > 4 else 2
def grilla(espera_min, gan=G, paso=PASO, corte=CORTE, vueltas=None):
    tot = {'pnl': 0, 'rondas': 0, 'cortes': 0, 'dias': [], 'maxlotes': 0}
    for d, b in sorted(dias.items()):
        pnl = 0; ancla = None; held = {}; buy = None; reent = None; fin = False   # held[k] = (costo, vela)
        for i, (t, o, h, l, c) in enumerate(b):
            if fin: break
            # compras apoyadas
            if buy and l < buy[1]:
                k, px, _ = buy; held[k] = (px, i); buy = None
                if ancla is None: ancla = px; reent = None
            # corte
            if ancla and l <= ancla * (1 - corte):
                px = ancla * (1 - corte) * (1 - 0.001)
                for k, (co, _) in held.items(): pnl += px - co - FEE * (px + co)
                held = {}; tot['cortes'] += 1; fin = True; break
            # ventas (no en la vela de la compra)
            for k in sorted(held, reverse=True):
                co, ib = held[k]
                if ib < i and h > co * (1 + gan):
                    pv = co * (1 + gan); pnl += pv - co - FEE * (pv + co); tot['rondas'] += 1; del held[k]
                    if vueltas is not None and k == 0:
                        j = next((m for m in range(i + 1, len(b)) if b[m][3] < co), None)
                        vueltas.append(None if j is None else (j - i) * MIN)
            tot['maxlotes'] = max(tot['maxlotes'], len(held))
            # fin de ciclo
            if ancla and not held:
                reent = (ancla, i + espera_min / MIN); ancla = None; buy = None
            # orden de compra para la vela siguiente
            if held:
                hmax = max(held); des = hmax + 1
                buy = (des, min(ancla * (1 - paso * des), c), i) if des < NIV else None
            else:
                en = reent and i < reent[1]
                if buy is None or buy[0] != 0: buy = (0, reent[0] if en and c > reent[0] else c, i)
                elif not en and c > buy[1] * 1.001: buy = (0, c, i)
        if not fin:
            c = b[-1][4] * (1 - 0.0005)
            for k, (co, _) in held.items(): pnl += c - co - FEE * (c + co)
        tot['dias'].append(pnl * ARS * LOTE); tot['pnl'] += pnl * ARS * LOTE
    return tot
v = []
grilla(10 ** 6, vueltas=v)
resumen('(2) tras vender a +0,25%, tiempo hasta volver al precio de compra', [x for x in v if x is not None], sum(1 for x in v if x is None))
print('(3) grilla del bot (2 papeles por lote, pesos netos de comision)')
print('   espera   P&L total   por rueda   vueltas  cortes  ruedas+  peor rueda  mejor rueda')
for e in (0, 2, 5, 10, 15, 20, 30, 60, 10 ** 6):
    r = grilla(e); ds = r['dias']
    print('   %6s  %10.0f  %10.0f  %7d  %6d  %3d/%d  %10.0f  %10.0f' % ('sin fin' if e > 999 else '%d min' % e, r['pnl'], r['pnl'] / len(ds), r['rondas'], r['cortes'], sum(1 for x in ds if x > 0), len(ds), min(ds), max(ds)))
print('(4) con la espera en 10 min, otros anchos de grilla')
print('   paso/gan/corte   P&L total   por rueda   vueltas  cortes  ruedas+  peor rueda')
for paso, gan, corte in ((0.003, 0.0025, 0.018), (0.005, 0.004, 0.03), (0.007, 0.005, 0.04), (0.01, 0.007, 0.05), (0.003, 0.0025, 0.05), (0.005, 0.0025, 0.03), (0.015, 0.01, 0.075), (0.02, 0.014, 0.10)):
    r = grilla(10, gan, paso, corte); ds = r['dias']
    print('   %.1f%%/%.2f%%/%.1f%%  %10.0f  %10.0f  %7d  %6d  %3d/%d  %10.0f' % (paso * 100, gan * 100, corte * 100, r['pnl'], r['pnl'] / len(ds), r['rondas'], r['cortes'], sum(1 for x in ds if x > 0), len(ds), min(ds)))
