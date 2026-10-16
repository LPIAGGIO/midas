# -*- coding: utf-8 -*-
# LP 16/10/2026: meter 1 o 2 lotes más en los bots que ya hicieron el refuerzo, para promediar.
# Misma grilla de los bots (salida del refuerzo un escalón arriba, vigente desde el 16/10), velas 1h
# ~2 años, 12 papeles, 2x y 2,5x, refuerzo y lateral. Lotes extra comprados cuando el precio está en o
# bajo el refuerzo, 2 escalones abajo o 4 escalones abajo. Mitades separadas. USD, lote 460.
import grilla5y as g
PAPELES = [('MU',0.01),('SNDK',0.015),('NVDA',0.01),('AMD',0.01),('INTC',0.01),('META',0.01),
           ('GOOGL',0.007),('AAPL',0.007),('MSFT',0.007),('AMZN',0.007),('NU',0.01),('JNJ',0.007)]
kw = dict(doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, ref_split='todo')
datos = {tk: g.cargar(tk, 'hourly') for tk, _ in PAPELES}
fechas = sorted({b[0] for v in datos.values() for b in v}); mitad = fechas[len(fechas)//2]
VAR = [((None, 1), 'sin lotes extra (como hoy)')]
for n in (1, 2):
    for k, t in ((0, 'en o bajo el refuerzo'), (2, '2 escalones abajo'), (4, '4 escalones abajo')):
        VAR.append(((k, n), f'{n} lote{"s" if n > 1 else ""} extra, {t}'))
out = [f'velas {fechas[0]} a {fechas[-1]} · corte de mitades {mitad} · USD, lote 460 · salida del refuerzo un escalón arriba']
for esc, nom in ((2.0, 'cuenta 72404 (2x)'), (2.5, 'cuenta 3893 (2,5x)')):
    out.append(f'\n== {nom}')
    out.append('  variante                                     total     1ra mit   2da mit   peor lat   capital max   dif total (mitad1 / mitad2)')
    base = None
    for (k, n), txt in VAR:
        T = M1 = M2 = 0.0; peor = 0.0; cap = 0.0
        for tk, b in PAPELES:
            v = datos[tk]; p, gn = b*esc, b*esc*0.7
            a = dict(post_ref=k, post_ref_lotes=n, **kw)
            r = g.grilla(v, p, gn, None, **a)
            r1 = g.grilla([x for x in v if x[0] < mitad], p, gn, None, **a)
            r2 = g.grilla([x for x in v if x[0] >= mitad], p, gn, None, **a)
            T += r['total']; M1 += r1['total']; M2 += r2['total']; peor += r['peor_abierto']; cap += r['capmax']
        if base is None: base = (T, M1, M2, peor, cap)
        d = '' if k is None else f'   {T-base[0]:+6.0f} ({M1-base[1]:+5.0f} / {M2-base[2]:+5.0f}) · peor {100*(peor/base[3]-1):+.0f}% · capital {100*(cap/base[4]-1):+.0f}%'
        out.append(f'  {txt:44} {T:+8.0f}  {M1:+8.0f}  {M2:+8.0f}  {peor:9.0f}  {cap:10.0f}{d}')
open('lotes-extra-v2-salida.txt', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('\n'.join(out))
