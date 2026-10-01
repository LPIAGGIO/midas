# -*- coding: utf-8 -*-
# Baja velas de MU de Yahoo: 1 minuto (Yahoo solo guarda ~30 dias, en tramos
# de 7) y 5 minutos (60 dias). Guarda mu_1m.json y mu_5m.json.
import json, sys, time, urllib.request
TK = sys.argv[1] if len(sys.argv) > 1 else 'MU'
def chart(interval, p1, p2):
    u = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?interval=%s&period1=%d&period2=%d&includePrePost=false' % (TK, interval, p1, p2)
    r = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
    j = json.load(urllib.request.urlopen(r, timeout=30))['chart']
    if j.get('error'): raise Exception(j['error'])
    j = j['result'][0]
    if 'timestamp' not in j: return []
    q = j['indicators']['quote'][0]
    return [(t, o, h, l, c, v) for t, o, h, l, c, v in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close'], q['volume']) if o and h and l and c]
now = int(time.time())
for iv, dias, tramo in [('1m', 29, 7), ('5m', 59, 59)]:
    rows = {}
    ini = now - dias * 86400
    while ini < now:
        fin = min(now, ini + tramo * 86400)
        try:
            for r in chart(iv, ini, fin): rows[r[0]] = r
        except Exception as e: print(iv, 'tramo', ini, 'fallo:', e)
        ini = fin
    out = [rows[k] for k in sorted(rows)]
    json.dump(out, open('%s_%s.json' % (TK.lower(), iv), 'w'))
    dias_n = len({time.strftime('%Y-%m-%d', time.gmtime(r[0] - 4 * 3600)) for r in out})
    print(iv, len(out), 'velas ·', dias_n, 'ruedas ·', time.strftime('%Y-%m-%d', time.gmtime(out[0][0])), 'a', time.strftime('%Y-%m-%d', time.gmtime(out[-1][0])))
