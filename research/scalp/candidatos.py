# -*- coding: utf-8 -*-
# Candidatos para reemplazar a INTC en la grilla (pedido de LP 14/10/2026, después
# de dos días de semis abajo). Misma grilla que los bots (grilla5y.grilla: refuerzo
# x2 al 50%, lateral), velas de 1 hora (~2 años), configuración de cada cuenta
# (paso base x2 y x2,5, ganancia 70% del paso). Paso base por volatilidad, con la
# misma escala que usan los 12 papeles de hoy. Mitades separadas, correlación
# diaria con los semis (MU, SNDK, NVDA, AMD) y con la cartera sin INTC, y volumen
# del CEDEAR en BYMA (data912, foto del día). Salida en candidatos-salida.txt.
import os, json, math, statistics as st, urllib.request, sys
import grilla5y as g
H = os.path.join(g.B, 'hourly')
ACTUALES = ['MU','SNDK','NVDA','AMD','INTC','META','GOOGL','AAPL','MSFT','AMZN','NU','JNJ']
SEMIS = ['MU','SNDK','NVDA','AMD']
kw = dict(doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)

def diarios(v):
    d = {}
    for b in v: d[b[0]] = b[4]
    return d
def rets(d):
    k = sorted(d); return {k[i]: d[k[i]] / d[k[i-1]] - 1 for i in range(1, len(k))}
def corr(a, b):
    ks = sorted(set(a) & set(b))
    if len(ks) < 60: return None
    x = [a[k] for k in ks]; y = [b[k] for k in ks]
    mx, my = st.mean(x), st.mean(y)
    sx = math.sqrt(sum((i-mx)**2 for i in x)); sy = math.sqrt(sum((i-my)**2 for i in y))
    return sum((i-mx)*(j-my) for i, j in zip(x, y)) / (sx*sy) if sx and sy else None
def base_por_vol(vol):
    return 0.007 if vol < 0.32 else (0.01 if vol < 0.62 else 0.015)

datos = {}
for f in sorted(os.listdir(H)):
    tk = f[:-5]
    try:
        v = g.cargar(tk, 'hourly')
        if len(v) > 500: datos[tk] = v
    except Exception: pass
fechas = sorted({b[0] for v in datos.values() for b in v}); ini, fin = fechas[0], fechas[-1]
mitad = fechas[len(fechas)//2]
R = {tk: rets(diarios(v)) for tk, v in datos.items()}
def canasta(tks):
    ks = set.intersection(*[set(R[t]) for t in tks if t in R])
    return {k: st.mean(R[t][k] for t in tks if t in R) for k in ks}
semis = canasta(SEMIS)
cartera = canasta([t for t in ACTUALES if t != 'INTC'])

try:
    req = urllib.request.Request('https://data912.com/live/arg_cedears', headers={'User-Agent': 'Mozilla/5.0'})
    ced = {r['symbol']: r for r in json.load(urllib.request.urlopen(req, timeout=30))}
except Exception as e:
    print('sin data912:', e); ced = {}

filas = []
for tk, v in datos.items():
    d = diarios(v); ks = sorted(d)
    if ks[0] > fechas[int(len(fechas)*0.1)]: continue          # historia incompleta (cotiza hace poco)
    r = list(rets(d).values()); vol = st.pstdev(r) * math.sqrt(252)
    base = base_por_vol(vol)
    res = {}
    for esc in (2.0, 2.5):
        p, gn = base*esc, base*esc*0.7
        a = g.grilla(v, p, gn, None, **kw)
        a1 = g.grilla([b for b in v if b[0] < mitad], p, gn, None, **kw)
        a2 = g.grilla([b for b in v if b[0] >= mitad], p, gn, None, **kw)
        res[esc] = (a['total'], a1['total'], a2['total'], a['peor_abierto'], a['rondas'], a['cargado'])
    c = ced.get(tk) or {}
    volars = (c.get('v') or 0) * (c.get('c') or 0)
    filas.append(dict(tk=tk, vol=vol, base=base, res=res, cs=corr(R[tk], semis), cc=corr(R[tk], cartera), ced=bool(c), volars=volars, px=c.get('c')))

out = []
P = lambda *a: out.append(' '.join(str(x) for x in a))
P(f'velas horarias {ini} a {fin} · corte de mitades {mitad} · {len(filas)} papeles con historia completa')
P('USD con lote de 460 por escalón (5 escalones + refuerzo). Paso base por volatilidad anual: <32% 0,7% · <62% 1% · resto 1,5%')
P('vol ARS = volumen del CEDEAR hoy en BYMA (data912, foto del 14/10, segmento pesos)')
def linea(f):
    a, b = f['res'][2.0], f['res'][2.5]
    return (f"{f['tk']:6} vol {f['vol']*100:4.0f}% base {f['base']*100:.1f}% | 2x: tot {a[0]:+7.0f} m1 {a[1]:+6.0f} m2 {a[2]:+6.0f} peor {a[3]:+7.0f} vueltas {a[4]:4d} | "
            f"2,5x: tot {b[0]:+7.0f} m1 {b[1]:+6.0f} m2 {b[2]:+6.0f} peor {b[3]:+7.0f} | corr semis {f['cs'] if f['cs'] is None else round(f['cs'],2)} cartera {f['cc'] if f['cc'] is None else round(f['cc'],2)} | "
            f"CEDEAR {'si' if f['ced'] else 'NO'} vol ARS {f['volars']/1e6:8.0f} M")
P('\n== los 12 de hoy')
for f in sorted([f for f in filas if f['tk'] in ACTUALES], key=lambda f: -f['res'][2.0][0]): P(linea(f))
intc = next((f for f in filas if f['tk'] == 'INTC'), None)
umbral = 300e6
P(f'\n== candidatos: positivos en las dos mitades y en las dos cuentas, CEDEAR con volumen hoy > {umbral/1e6:.0f} M, ordenados por resultado / |peor latente| (cuenta 2x)')
cand = [f for f in filas if f['tk'] not in ACTUALES and f['ced'] and f['volars'] > umbral
        and all(f['res'][e][1] > 0 and f['res'][e][2] > 0 for e in (2.0, 2.5))]
cand.sort(key=lambda f: -(f['res'][2.0][0] / max(1.0, -f['res'][2.0][3])))
for f in cand[:30]: P(linea(f))
P(f'\n== los mismos, solo los de correlación con los semis < 0,5')
for f in [f for f in cand if f['cs'] is not None and f['cs'] < 0.5][:20]: P(linea(f))
open('candidatos-salida.txt', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('\n'.join(out))
