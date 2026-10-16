import json, glob, os, math, urllib.request
FEE = 0.000565
px = {}
req = urllib.request.Request('https://data912.com/live/arg_cedears', headers={'User-Agent': 'Mozilla/5.0'})
for r in json.load(urllib.request.urlopen(req, timeout=20)): px[r['symbol']] = r.get('c')
bots = []
for d in sorted(glob.glob(os.path.expanduser('~/workers/cocos*-scalp*'))):
    if not os.path.exists(d + '/estado.json'): continue
    env = dict(l.strip().split('=', 1) for l in open(d + '/.env') if '=' in l and not l.startswith('#'))
    s = json.load(open(d + '/estado.json'))
    if not s.get('reforzado'): continue
    tk = env.get('SCALP_TICKER', 'MU'); lote = int(env['SCALP_LOTE']); P = float(env['SCALP_PASO'])
    pc = s.get('paso') or P; gc = s.get('gan') or float(env.get('SCALP_GANANCIA', P * 0.7))
    h = sum(n['held'] for n in s['niveles']); c = sum(n['costo'] for n in s['niveles'])
    bots.append(('3893' if 'cocos2' in d else '72404', tk, h, c, lote, pc, gc, px[tk]))
ESC = [-0.10, -0.05, 0.0, 0.05, 0.10, 0.15, 0.20]
print('precio de hoy = cierre del 15/10 en BYMA (data912)')
print(f"{'bot':12} {'p':>8} | {'salida/dist con 0':>22} | {'con 1 lote':>22} | {'con 2 lotes':>22} | costo extra")
tot = {n: {e: 0.0 for e in ESC} for n in (0, 1, 2)}; extra = {1: 0.0, 2: 0.0}
for cta, tk, h, c, lote, pc, gc, p in bots:
    cols = []
    for n in (0, 1, 2):
        hn = h + n * lote; cn = c + n * lote * p * (1 + FEE)
        sal = cn / hn * (1 + gc) * (1 + pc)
        cols.append(f'{sal:10,.0f} ({sal/p*100-100:+5.1f}%)')
        if n: extra[n] += n * lote * p
        for e in ESC:
            q = p * (1 + e)
            # si el escenario toca la salida, vende todo en la salida (realiza); si no, latente al precio del escenario
            v = hn * sal * (1 - FEE) - cn if q >= sal else hn * q * (1 - FEE) - cn
            tot[n][e] += v
    print(f'{cta:5} {tk:6} {p:8,.0f} | ' + ' | '.join(cols) + f' | ${lote*p/1e6:.2f}M por lote')
print('\nresultado de los 9 bots reforzados según dónde quede el precio (todos los semis se mueven igual):')
print('  escenario       ' + '   '.join(f'{e*100:+4.0f}%' for e in ESC))
for n in (0, 1, 2):
    print(f'  {n} lote(s) extra ' + ' '.join(f'{tot[n][e]/1e6:+6.2f}M' for e in ESC) + (f'   (extra invertido ${extra[n]/1e6:.1f}M)' if n else ''))
for n in (1, 2):
    print(f'  diferencia {n} vs 0 ' + ' '.join(f'{(tot[n][e]-tot[0][e])/1e6:+6.2f}M' for e in ESC))
