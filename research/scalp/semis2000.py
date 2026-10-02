# -*- coding: utf-8 -*-
# La tesis "los semis a la larga suben" en el ciclo malo: grilla sin corte
# arrancando en el techo de 2000 y en el de 2007/2008.
import json, time, urllib.request
import grilla5y as g
def maxd(tk):
    u = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&period1=631152000&period2=%d' % (tk, int(time.time()))
    j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=40))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    return [(time.strftime('%Y-%m-%d', time.gmtime(t)), o, h, l, c) for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']) if o and h and l and c and l > 0]
for ini, fin in (('2000-03-01', '2005-03-01'), ('2000-03-01', '2010-03-01'), ('2007-07-01', '2012-07-01'), ('2016-10-03', '2021-09-17')):
    print('== arrancando %s, hasta %s · grilla 1%% / +0,7%% sin corte · capital 2.300 USD' % (ini, fin))
    for tk in ('MU', 'INTC', 'AMD', 'NVDA', 'TXN', 'AMAT', 'QCOM', 'TSM'):
        try: rows = maxd(tk)
        except Exception as e: print('  ', tk, 'sin datos', e); continue
        per = [r for r in rows if ini <= r[0] < fin]
        if len(per) < 500: continue
        r = g.grilla(per, 0.01, 0.007, None)
        print('   %-5s papel %+5.0f%% · grilla %+6.0f (realizado %+6.0f, abierto %+6.0f) · peor abierto %6.0f · dias cargada %3.0f%% · racha max %4d d · %d vueltas' % (
            tk, (per[-1][4] / per[0][1] - 1) * 100, r['total'], r['real'], r['abierto'], r['peor_abierto'], r['cargado'], r['racha'], r['rondas']))
