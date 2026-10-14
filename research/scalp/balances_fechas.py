# -*- coding: utf-8 -*-
# Fechas historicas de balances (fuente: api.nasdaq.com/api/calendar/earnings?date=AAAA-MM-DD,
# un pedido por dia habil; se queda con los 12 papeles). El campo 'time' del historico viene
# 'time-not-supplied': el momento (antes de apertura / despues de cierre) se infiere en balances.py.
import json, os, sys, time, urllib.request, datetime as dt
from concurrent.futures import ThreadPoolExecutor
AQUI = os.path.dirname(os.path.abspath(__file__))
TK = {'MU','SNDK','NVDA','AMD','INTC','META','GOOGL','AAPL','MSFT','AMZN','NU','JNJ'}
OUT = os.path.join(AQUI, 'balances-fechas.json')
def dia(d):
    for k in range(4):
        try:
            rq = urllib.request.Request('https://api.nasdaq.com/api/calendar/earnings?date=' + d, headers={'User-Agent': 'Mozilla/5.0'})
            j = json.load(urllib.request.urlopen(rq, timeout=30))
            rows = (j.get('data') or {}).get('rows') or []
            return d, [(r['symbol'], r.get('time'), r.get('fiscalQuarterEnding'), r.get('eps')) for r in rows if r['symbol'] in TK]
        except Exception as e:
            time.sleep(1 + k)
    return d, None
d0, d1 = dt.date(2023, 10, 1), dt.date(2026, 9, 30)
ds = []
while d0 <= d1:
    if d0.weekday() < 5: ds.append(d0.isoformat())
    d0 += dt.timedelta(days=1)
with ThreadPoolExecutor(6) as ex:
    res = list(ex.map(dia, ds))
fallos = [d for d, r in res if r is None]
out = {}
for d, r in res:
    for s, t, fq, eps in (r or []):
        out.setdefault(s, []).append(dict(fecha=d, hora=t, trimestre=fq, eps=eps))
json.dump(dict(fallos=fallos, balances=out), open(OUT, 'w'), indent=1)
print('dias', len(ds), 'fallos', len(fallos))
for s in sorted(out): print(s, len(out[s]), [x['fecha'] for x in out[s]])
