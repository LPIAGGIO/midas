# -*- coding: utf-8 -*-
# Velas de 1 minuto EN PESOS de los 9 CEDEARs para una rueda (Yahoo, sufijo .BA,
# con pre-mercado porque Yahoo cree que BYMA abre a las 11:00). Lo que falte
# entre las 10:30 y la primera vela en pesos se completa con la vela en dolares
# del subyacente llevada a pesos con la relacion de esa primera vela.
#   python hoy_bajar.py 2026-10-05   → hoy/<TK>.json  [[hhmm, o, h, l, c], ...]
import json, os, sys, time, urllib.request
AQUI = os.path.dirname(os.path.abspath(__file__))
P = ['MU', 'SNDK', 'NVDA', 'GOOGL', 'AMD', 'INTC', 'META', 'AAPL', 'MSFT', 'AMZN']
DIA = sys.argv[1]


def yahoo(sym):
    u = 'https://query2.finance.yahoo.com/v8/finance/chart/%s?interval=1m&range=2d&includePrePost=true' % sym
    j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))
    r = j['chart']['result'][0]; q = r['indicators']['quote'][0]
    out = []
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, l, c): continue
        lt = time.gmtime(t - 3 * 3600)
        if time.strftime('%Y-%m-%d', lt) == DIA:
            out.append([lt.tm_hour * 100 + lt.tm_min, o, h, l, c])
    return out


os.makedirs(os.path.join(AQUI, 'hoy'), exist_ok=True)
for tk in P:
    ars = [b for b in yahoo(tk + '.BA') if 1030 <= b[0] <= 1700]
    usd = [b for b in yahoo(tk) if 1030 <= b[0] <= 1700]
    primero = ars[0][0]
    relleno = []
    if primero > 1031:
        u0 = next((b for b in usd if b[0] >= primero), None)
        k = ars[0][1] / u0[1]
        relleno = [[b[0]] + [round(x * k, 2) for x in b[1:]] for b in usd if b[0] < primero]
    bars = relleno + ars
    json.dump(bars, open(os.path.join(AQUI, 'hoy', '%s-%s.json' % (tk, DIA)), 'w'))
    print('%-5s pesos desde %04d (%d velas) · relleno con dolares %d velas · apertura %.0f · min %.0f · max %.0f · cierre %.0f' % (
        tk, primero, len(ars), len(relleno), bars[0][1], min(b[3] for b in bars), max(b[2] for b in bars), bars[-1][4]))
