# -*- coding: utf-8 -*-
# Salida del refuerzo en dos mitades (LP 15/10/2026): 1ra mitad en promedio + ganancia,
# 2da mitad un escalón más arriba ('paso') o en promedio + 2×ganancia ('gan'), contra
# salir todo junto (como hoy). Misma grilla de los bots, velas 1h ~2 años, 12 papeles,
# 2x y 2,5x, refuerzo y lateral. Mitades separadas. USD, lote 460.
import grilla5y as g
PAPELES = [('MU',0.01),('SNDK',0.015),('NVDA',0.01),('AMD',0.01),('INTC',0.01),('META',0.01),
           ('GOOGL',0.007),('AAPL',0.007),('MSFT',0.007),('AMZN',0.007),('NU',0.01),('JNJ',0.007)]
kw = dict(doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)
datos = {tk: g.cargar(tk, 'hourly') for tk, _ in PAPELES}
fechas = sorted({b[0] for v in datos.values() for b in v}); mitad = fechas[len(fechas)//2]
VAR = [(None, 'todo junto en promedio + ganancia (hoy)'), ('paso', 'mitad ahí, mitad un escalón más arriba'), ('gan', 'mitad ahí, mitad en promedio + 2 ganancias')]
out = [f'velas {fechas[0]} a {fechas[-1]} · corte de mitades {mitad} · USD, lote 460']
for esc, nom in ((2.0, 'cuenta 72404 (2x)'), (2.5, 'cuenta 3893 (2,5x)')):
    out.append(f'\n== {nom}')
    out.append('  variante                                     total     1ra mit   2da mit   vueltas  peor lat   dif total (mitad1 / mitad2)')
    base = None; pp = {}
    for k, txt in VAR:
        T = M1 = M2 = 0.0; vu = 0; peor = 0.0
        for tk, b in PAPELES:
            v = datos[tk]; p, gn = b*esc, b*esc*0.7
            r = g.grilla(v, p, gn, None, ref_split=k, **kw)
            r1 = g.grilla([x for x in v if x[0] < mitad], p, gn, None, ref_split=k, **kw)
            r2 = g.grilla([x for x in v if x[0] >= mitad], p, gn, None, ref_split=k, **kw)
            T += r['total']; M1 += r1['total']; M2 += r2['total']; vu += r['rondas']; peor += r['peor_abierto']
            pp.setdefault(tk, []).append(r['total'])
        if base is None: base = (T, M1, M2)
        d = '' if k is None else f'   {T-base[0]:+6.0f} ({M1-base[1]:+5.0f} / {M2-base[2]:+5.0f})'
        out.append(f'  {txt:43} {T:+8.0f}  {M1:+8.0f}  {M2:+8.0f}  {vu:6d}  {peor:9.0f}{d}')
    out.append('  por papel (hoy / un escalón / 2 ganancias): ' + ' · '.join(f'{tk} ' + '/'.join(f'{x:+.0f}' for x in v) for tk, v in pp.items()))
open('salida-partida-salida.txt', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('\n'.join(out))
