# -*- coding: utf-8 -*-
# ¿A qué hora conviene "vender lo verde"? (LP 09/10/2026: "buscar el volumen y los
# picos en los últimos 15 minutos; en la semana muchos lotes se cerraron en los
# últimos 15 minutos").
# 1) Perfil de los últimos 45 minutos (velas de 5 min del subyacente, 60 días, 10
#    papeles): volumen de cada tramo y precio medio contra el de las 16:15.
# 2) La grilla de la 3893 (escalón 2x, regla G, vende lo verde y reentra un escalón
#    abajo) con la venta a las 16:30, 16:40, 16:45, 16:50, 16:55 y al cierre.
import json, os, time, urllib.request, statistics as st
import grilla5y as g
import apertura_bajista as ab
AQUI = os.path.dirname(os.path.abspath(__file__))
PAPELES = ab.PAPELES


def con_volumen(tk):
    f = os.path.join(AQUI, 'd5v', tk + '.json')
    if os.path.exists(f) and time.time() - os.path.getmtime(f) < 12 * 3600:
        return json.load(open(f))
    u = 'https://query2.finance.yahoo.com/v8/finance/chart/%s?interval=5m&range=60d' % tk
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))['chart']['result'][0]
    q = r['indicators']['quote'][0]
    out = []
    for t, o, h, l, c, v in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close'], q['volume']):
        if None in (o, h, l, c): continue
        lt = time.gmtime(t - 4 * 3600)
        hm = (lt.tm_hour + 1) * 100 + lt.tm_min
        if 1030 <= hm < 1700:
            out.append((time.strftime('%Y-%m-%d', lt), hm, o, h, l, c, v or 0))
    os.makedirs(os.path.dirname(f), exist_ok=True)
    json.dump(out, open(f, 'w'))
    return out


def perfil():
    tramos = [1615, 1620, 1625, 1630, 1635, 1640, 1645, 1650, 1655]
    vol = {t: [] for t in tramos}; px = {t: [] for t in tramos}; vol_dia = []
    alto = {t: 0 for t in tramos}; n_dias = 0
    for tk, _, _ in PAPELES:
        v = con_volumen(tk)
        dias = {}
        for x in v: dias.setdefault(x[0], []).append(x)
        for f, b in dias.items():
            m = {x[1]: x for x in b}
            if 1615 not in m or 1655 not in m: continue
            tot = sum(x[6] for x in b) or 1
            ref = m[1615][2]                                   # apertura de la vela de las 16:15
            fin = m[1655][5]                                   # cierre
            n_dias += 1
            mejor = max(tramos, key=lambda t: m[t][3] if t in m else 0)
            alto[mejor] += 1
            for t in tramos:
                if t in m:
                    vol[t].append(m[t][6] / tot * 100)
                    px[t].append((m[t][5] / ref - 1) * 100)
    print('== últimos 45 minutos · 60 días · 10 papeles (%d papel-días) · hora BYMA' % n_dias)
    print('   %-6s %12s %16s %20s' % ('vela', '% volumen día', 'precio vs 16:15', 'vela con el máximo'))
    for t in tramos:
        print('   %02d:%02d  %11.1f%% %+15.3f%% %18.0f%%' % (t // 100, t % 100, st.mean(vol[t]), st.mean(px[t]), 100.0 * alto[t] / n_dias))


def grilla_cierre():
    print('\n== grilla de la 3893 (2x, regla G, vende lo verde y reentra un escalón abajo) según la hora de la venta')
    print('   %-8s %10s %10s %13s %12s' % ('hora', 'resultado', 'realizado', 'por 1000/día', 'peor abierto'))
    for H in (1630, 1640, 1645, 1650, 1655, 1700):
        tot = real = peor = 0.0; caps = []; dias = 0
        for tk, p, gn in PAPELES:
            v = [x[:6] for x in con_volumen(tk)]
            nb = ab.nobuy_de(v, 'G', 0.01)
            idx = set()
            if H < 1700:
                visto = set()
                for i, x in enumerate(v):
                    if x[1] >= H and x[0] not in visto:
                        visto.add(x[0]); idx.add(i)
            bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
            r = g.grilla(bars, p * 2, gn * 2, None, doble=2.0, frac=0.5, espera_barras=4, lateral_barras=12,
                         lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, nobuy=nb,
                         cierre_ganadores='papel', cierre_reent=78, cierre_en=(idx or None))
            tot += r['total']; real += r['real']; peor += r['peor_abierto']; caps.append(st.mean(r['s_cap'])); dias = max(dias, r['dias'])
        print('   %02d:%02d    %+10.0f %+10.0f %13.2f %12.0f' % (H // 100, H % 100, tot, real, 1000 * tot / sum(caps) / dias, peor))


if __name__ == '__main__':
    perfil()
    grilla_cierre()
