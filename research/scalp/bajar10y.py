# -*- coding: utf-8 -*-
# Baja 10 años de velas diarias (ajustadas) de todo el universo, para poder
# elegir "buenos papeles" con lo que se sabia ANTES del periodo simulado.
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
B = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backtest-5y', 'data', 'daily')
tks = sorted(f[:-5] for f in os.listdir(B) if f.endswith('.json'))
def bajar(tk):
    dst = os.path.join('d10', tk + '.json')
    if os.path.exists(dst): return tk, 'ya'
    for i in range(3):
        try:
            u = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=1d&range=10y' % tk
            r = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
            j = json.load(urllib.request.urlopen(r, timeout=30))['chart']['result'][0]
            q = j['indicators']['quote'][0]
            rows = [(time.strftime('%Y-%m-%d', time.gmtime(t)), o, h, l, c) for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']) if o and h and l and c]
            json.dump(rows, open(dst, 'w'))
            return tk, len(rows)
        except Exception as e:
            err = str(e); time.sleep(2)
    return tk, 'FALLO ' + err
with ThreadPoolExecutor(6) as ex: res = list(ex.map(bajar, tks))
fall = [r for r in res if str(r[1]).startswith('FALLO')]
print(len(res), 'papeles ·', len(fall), 'fallos', fall[:5])
