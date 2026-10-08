# -*- coding: utf-8 -*-
# Cuenta 3893 (LP 08/10/2026): hoy no compra antes de las 12:00. Propuesta de LP:
# "cuando abre en verde que no compre hasta las 12 como hacemos, pero si abre en
# bajada fuerte que si compre, porque a las 12 capaz ya se nivelo".
# Compara, con el escalon ancho de la 3893 (1,5 veces), sumando los 10 papeles:
#   A  compra desde la apertura
#   B  compra desde las 12:00 (como corre hoy)
#   G  B, pero si el papel ABRE X% o mas abajo del cierre anterior, compra desde la apertura
#   I  B, pero si ANTES de las 12 el papel toca X% abajo del cierre anterior, compra desde ahi
# Las ventas corren siempre desde la apertura (lo arrastrado se vende temprano).
# USD; hora BYMA = hora de Nueva York + 1. Las velas horarias son 10:30, 11:30,
# 12:30...: "desde las 12" ahi es desde las 12:30.
#   python apertura_bajista.py            (baja de nuevo las velas de 5 min)
import json, os, sys, time, urllib.request, statistics as st
import grilla5y as g
AQUI = os.path.dirname(os.path.abspath(__file__))
H1 = os.path.join(AQUI, '..', 'backtest-5y', 'data', 'hourly')
PAPELES = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
           ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005), ('AMZN', 0.007, 0.005)]
ANCHO = 1.5


def bajar5m(tk):
    f = os.path.join(AQUI, 'd5', tk + '.json')
    if '--sin-bajar' in sys.argv and os.path.exists(f):
        return json.load(open(f))
    u = 'https://query2.finance.yahoo.com/v8/finance/chart/%s?interval=5m&range=60d' % tk
    j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))
    r = j['chart']['result'][0]; q = r['indicators']['quote'][0]
    out = [[t, o, h, l, c] for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']) if None not in (o, h, l, c)]
    os.makedirs(os.path.dirname(f), exist_ok=True)
    json.dump(out, open(f, 'w'))
    return out


def velas(tk, serie):
    if serie == '5m':
        crudo = bajar5m(tk)
    else:
        j = json.load(open(os.path.join(H1, tk + '.json')))['chart']['result'][0]; q = j['indicators']['quote'][0]
        crudo = [[t, o, h, l, c] for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']) if o and h and l and c]
    out = []
    for t, o, h, l, c in crudo:
        lt = time.gmtime(t - 4 * 3600)
        hm = (lt.tm_hour + 1) * 100 + lt.tm_min
        if 1030 <= hm < 1700:
            out.append((time.strftime('%Y-%m-%d', lt), hm, o, h, l, c))
    return out


def nobuy_de(v, regla, x):
    """indices de velas sin compras segun la regla"""
    nb = set()
    prev_c = None
    i = 0
    while i < len(v):
        f = v[i][0]
        j = i
        while j < len(v) and v[j][0] == f:
            j += 1
        dia = range(i, j)
        temprano = [k for k in dia if v[k][1] < 1200]
        if regla == 'A':
            pass
        elif regla == 'B' or prev_c is None:
            nb.update(temprano)
        elif regla == 'G':
            if v[i][2] > prev_c * (1 - x):
                nb.update(temprano)
        elif regla == 'I':
            for k in temprano:
                if v[k][4] <= prev_c * (1 - x):
                    break            # toco el umbral: desde esta vela compra
                nb.add(k)
        prev_c = v[j - 1][5]
        i = j
    return nb


def corre(serie, regla, x=0.0):
    esp, lat = (4, 12) if serie == '5m' else (0, 1)
    tot = real = peor = 0.0; vu = 0; caps = []; dias = 0; act = 0
    for tk, p, gn in PAPELES:
        v = velas(tk, serie)
        if not v:
            continue
        nb = nobuy_de(v, regla, x)
        bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
        r = g.grilla(bars, p * ANCHO, gn * ANCHO, None, doble=2.0, frac=0.5, espera_barras=esp,
                     lateral_barras=lat, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, nobuy=nb)
        tot += r['total']; real += r['real']; peor += r['peor_abierto']; vu += r['rondas']
        caps.append(st.mean(r['s_cap'])); dias = max(dias, r['dias'])
        temp = {k for k, b in enumerate(v) if b[1] < 1200}
        act += len(temp - nb)
    return dict(tot=tot, real=real, peor=peor, vu=vu, cap=sum(caps), dias=dias, act=act)


def main():
    for serie in ('hourly', '5m'):
        v0 = velas('MU', serie)
        print('\n== velas %s · %s a %s · 10 papeles · escalon de la 3893 (x1,5) · USD, %d por lote' % (
            serie, v0[0][0], v0[-1][0], g.LOTE))
        print('   %-40s %10s %10s %8s %12s %11s %10s' % ('regla', 'resultado', 'realizado', 'vueltas', 'peor abierto', 'capital medio', 'por 1000 de capital'))
        base = None
        for nombre, regla, x in [('A  compra desde la apertura', 'A', 0), ('B  desde las 12 (hoy)', 'B', 0)] + \
                                [('G  abre %.1f%% abajo -> desde la apertura' % (x * 100), 'G', x) for x in (0.01, 0.015, 0.02, 0.03)] + \
                                [('I  toca %.1f%% abajo antes de 12 -> desde ahi' % (x * 100), 'I', x) for x in (0.01, 0.015, 0.02, 0.03)]:
            r = corre(serie, regla, x)
            if regla == 'B':
                base = r
            print('   %-40s %+10.0f %+10.0f %8d %12.0f %13.0f %+10.1f' % (nombre, r['tot'], r['real'], r['vu'], r['peor'], r['cap'], 1000.0 * r['tot'] / r['cap']))
        print('   (%d ruedas)' % r['dias'])


if __name__ == '__main__':
    main()
