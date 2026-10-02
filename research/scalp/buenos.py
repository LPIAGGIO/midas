# -*- coding: utf-8 -*-
# "Hay que ver buenos papeles" (LP 01/10/2026). La pregunta que se puede medir:
# ¿se podia saber ANTES cuales eran los buenos? Se eligen los papeles con lo
# que se veia el 17/09/2021 (rendimiento de los 3 años previos, estar sobre la
# media de 200 ruedas) y se corre la grilla SIN corte los 5 años siguientes.
# Tambien una regla que el bot puede aplicar solo: abrir ciclos nuevos
# unicamente con el papel sobre su media de 200 ruedas.
import json, os, sys, statistics as st
import grilla5y as g
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'd10')
INI = '2021-09-17'
SEMIS = ['MU', 'NVDA', 'AMD', 'AVGO', 'MRVL', 'QCOM', 'INTC', 'ADI', 'TSM', 'ASML', 'AMAT', 'LRCX', 'KLAC', 'TXN', 'ON', 'NXPI', 'MCHP', 'SWKS', 'QRVO', 'STM', 'UMC', 'WDC', 'STX']


def serie(tk):
    return [tuple(r) for r in json.load(open(os.path.join(D, tk + '.json')))]


def sma200(rows):
    out = {}
    s = 0.0
    for i, r in enumerate(rows):
        s += r[4]
        if i >= 200:
            s -= rows[i - 200][4]
        if i >= 199:
            out[r[0]] = s / 200
    return out


def antes(rows, fecha, ruedas):
    prev = [r for r in rows if r[0] < fecha]
    if len(prev) < ruedas + 5:
        return None
    return (prev[-1][4] / prev[-ruedas][4] - 1) * 100


def resumen(nombre, filas, col):
    v = [f[col] for f in filas]
    if not v:
        return
    print('   %-34s n=%3d · mediana %+6.0f · promedio %+6.0f · positivos %3d%% · pierden mas de la mitad del capital %2d%% · peor %+6.0f' % (
        nombre, len(v), st.median(v), sum(v) / len(v), 100 * sum(1 for x in v if x > 0) / len(v), 100 * sum(1 for x in v if x < -1150) / len(v), min(v)))


filas = []
for f in sorted(os.listdir(D)):
    tk = f[:-5]
    rows = serie(tk)
    r3 = antes(rows, INI, 756)
    r1 = antes(rows, INI, 252)
    if r3 is None:
        continue
    per = [r for r in rows if r[0] >= INI]
    if len(per) < 1000:
        continue
    m = sma200(rows)
    prev = [r for r in rows if r[0] < INI]
    sobre = prev[-1][4] > m.get(prev[-1][0], 1e18)
    ok = {r[0] for r in rows if r[0] in m and r[4] > m[r[0]]}
    # el filtro usa el cierre de AYER contra la media de ayer
    fechas = [r[0] for r in rows]
    permitido = {fechas[i] for i in range(1, len(fechas)) if fechas[i - 1] in ok}
    sin = g.grilla(per, 0.01, 0.007, None)
    fil = g.grilla(per, 0.01, 0.007, None, permitido=permitido)
    filas.append(dict(tk=tk, r3=r3, r1=r1, sobre=sobre, papel=(per[-1][4] / per[0][1] - 1) * 100, sin=sin['total'], fil=fil['total'],
                      racha=sin['racha'], racha_f=fil['racha'], peor=sin['peor_abierto'], peor_f=fil['peor_abierto'], carg=sin['cargado'], carg_f=fil['cargado'], vueltas_f=fil['rondas'], vueltas=sin['rondas']))

print('== %d papeles con historia desde 2018 · grilla 1%% / +0,7%% SIN corte · %s a 2026-09-17 · USD sobre capital maximo 2.300' % (len(filas), INI))
print('\n1) Los cuatro que nombro LP, vistos el 17/09/2021:')
orden = sorted(filas, key=lambda f: -f['r3'])
for tk in ('SNAP', 'PYPL', 'NKE', 'GLOB', 'MU', 'NVDA'):
    f = next((x for x in filas if x['tk'] == tk), None)
    if f:
        print('   %-5s 3 años previos %+5.0f%% (puesto %3d de %d) · ultimo año %+4.0f%% · sobre la media de 200: %s → 5 años despues %+5.0f%% · grilla sin corte %+6.0f' % (
            tk, f['r3'], orden.index(f) + 1, len(filas), f['r1'], 'si' if f['sobre'] else 'no', f['papel'], f['sin']))

print('\n2) Elegidos por como venian el 17/09/2021 (rendimiento de los 3 años previos), grilla sin corte:')
n = len(orden)
for i, nombre in enumerate(('quinto 1: los que mejor venian', 'quinto 2', 'quinto 3', 'quinto 4', 'quinto 5: los que peor venian')):
    resumen(nombre, orden[i * n // 5:(i + 1) * n // 5], 'sin')
resumen('sobre la media de 200 ese dia', [f for f in filas if f['sobre']], 'sin')
resumen('bajo la media de 200 ese dia', [f for f in filas if not f['sobre']], 'sin')
resumen('TODOS', filas, 'sin')

print('\n3) Semiconductores (la tesis de LP), grilla sin corte:')
sem = [f for f in filas if f['tk'] in SEMIS]
for f in sorted(sem, key=lambda x: -x['sin']):
    print('   %-5s papel %+6.0f%% · grilla %+6.0f · peor abierto %6.0f · dias cargada %3.0f%% · racha max %4d d' % (f['tk'], f['papel'], f['sin'], f['peor'], f['carg'], f['racha']))
resumen('semis', sem, 'sin')

print('\n4) Regla que el bot puede aplicar solo: abrir ciclos nuevos SOLO con el papel sobre su media de 200 ruedas')
resumen('sin filtro (todos)', filas, 'sin')
resumen('con filtro (todos)', filas, 'fil')
resumen('sin filtro (semis)', sem, 'sin')
resumen('con filtro (semis)', sem, 'fil')
for tk in ('MU', 'SNDK', 'NVDA', 'INTC', 'SNAP', 'PYPL', 'NKE', 'GLOB'):
    f = next((x for x in filas if x['tk'] == tk), None)
    if f:
        print('   %-5s sin filtro %+6.0f (racha %4d d, peor abierto %6.0f, %d vueltas) → con filtro %+6.0f (racha %4d d, peor abierto %6.0f, %d vueltas)' % (
            tk, f['sin'], f['racha'], f['peor'], f['vueltas'], f['fil'], f['racha_f'], f['peor_f'], f['vueltas_f']))
