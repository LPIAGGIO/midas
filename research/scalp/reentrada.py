# -*- coding: utf-8 -*-
# ¿Conviene esperar una baja para volver a entrar después de cerrar un ciclo? (LP 15/10/2026:
# JNJ y AAPL cerraron en la apertura y el bot vuelve a entrar a las 12 al precio, más caro de
# lo que vendió). Misma grilla que los bots, velas de 1 hora (~2 años), 12 papeles, config de
# cada cuenta (2x y 2,5x, ganancia 70%), refuerzo y lateral. Mitades separadas. USD, lote 460.
import grilla5y as g
PAPELES = [('MU',0.01),('SNDK',0.015),('NVDA',0.01),('AMD',0.01),('INTC',0.01),('META',0.01),
           ('GOOGL',0.007),('AAPL',0.007),('MSFT',0.007),('AMZN',0.007),('NU',0.01),('JNJ',0.007)]
kw = dict(doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)
datos = {tk: g.cargar(tk, 'hourly') for tk, _ in PAPELES}
fechas = sorted({b[0] for v in datos.values() for b in v}); mitad = fechas[len(fechas)//2]
VAR = [(None, 'como hoy: sigue al precio'), ('b1', 'espera 1 escalón abajo en el día'), ('b2', 'espera 2 escalones abajo en el día'),
       ('c', 'no reentra en el día, mañana en la apertura'), ('d', 'espera 1 escalón abajo sin límite')]
out = [f'velas {fechas[0]} a {fechas[-1]} · corte de mitades {mitad}']
for esc, nom in ((2.0, 'cuenta 72404 (2x)'), (2.5, 'cuenta 3893 (2,5x)')):
    out.append(f'\n== {nom}')
    out.append('  variante                                       total     1ra mit   2da mit   ciclos  vueltas  peor lat (suma)')
    base = None; porpapel = {}
    for mod, txt in VAR:
        T = M1 = M2 = 0.0; ci = vu = 0; peor = 0.0
        for tk, b in PAPELES:
            v = datos[tk]; p, gn = b*esc, b*esc*0.7
            r = g.grilla(v, p, gn, None, reent_modo=mod, **kw)
            r1 = g.grilla([x for x in v if x[0] < mitad], p, gn, None, reent_modo=mod, **kw)
            r2 = g.grilla([x for x in v if x[0] >= mitad], p, gn, None, reent_modo=mod, **kw)
            T += r['total']; M1 += r1['total']; M2 += r2['total']; ci += r['ciclos']; vu += r['rondas']; peor += r['peor_abierto']
            porpapel.setdefault(tk, {})[mod] = r['total']
        if base is None: base = (T, M1, M2)
        d = '' if mod is None else f'   dif {T-base[0]:+6.0f} ({M1-base[1]:+5.0f} / {M2-base[2]:+5.0f})'
        out.append(f'  {txt:44} {T:+8.0f}  {M1:+8.0f}  {M2:+8.0f}  {ci:6d}  {vu:6d}  {peor:10.0f}{d}')
    out.append('  por papel (total USD): ' + ' · '.join(f"{tk} " + '/'.join(f"{porpapel[tk][m]:+.0f}" for m, _ in VAR) for tk, _ in PAPELES))
open('reentrada-salida.txt', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('\n'.join(out))
