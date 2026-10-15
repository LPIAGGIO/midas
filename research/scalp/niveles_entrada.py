# -*- coding: utf-8 -*-
# Entradas con el modelo de niveles para papeles nuevos de la grilla (15/10/2026, LLY y UNH) con el modelo
# de niveles del bot (workers/niveles-auto/worker-deploy.js): pivotes diarios (1 año)
# y horarios (1 mes) con LB=5, zonas de ±0,6%, entrada en el techo de la zona de
# soporte, stop 0,7% bajo la zona siguiente (o 1×ATR), stop del libro real 1,5×ATR(14)
# diario, objetivo en el piso de la resistencia más cercana. Precios en CEDEAR (ARS).
import json, urllib.request, sys
CCL = float(sys.argv[1]); ARS = dict(a.split('=') for a in sys.argv[2:])
import sys as _s
PABLO = {a.split('=')[0]: [] for a in _s.argv[2:]}
def velas(tk, it, rg):
    u = f'https://query1.finance.yahoo.com/v8/finance/chart/{tk}?interval={it}&range={rg}'
    j = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    return [dict(h=h, l=l, c=c, v=v or 0) for h, l, c, v in zip(q['high'], q['low'], q['close'], q['volume']) if h and l and c]
def piv(cs, lb, tf):
    his, los = [], []
    for i in range(lb, len(cs) - lb):
        w = cs[i-lb:i+lb+1]
        if all(x['h'] <= cs[i]['h'] for x in w): his.append((cs[i]['h'], tf))
        if all(x['l'] >= cs[i]['l'] for x in w): los.append((cs[i]['l'], tf))
    return his, los
def zonas(ps, tol=0.006):
    zs = []
    for p, tf in sorted(ps):
        if zs and abs(p - zs[-1]['avg']) / zs[-1]['avg'] <= tol:
            zs[-1]['m'].append((p, tf)); zs[-1]['avg'] = sum(x[0] for x in zs[-1]['m']) / len(zs[-1]['m'])
        else: zs.append({'avg': p, 'm': [(p, tf)]})
    return [dict(lo=min(x[0] for x in z['m']), hi=max(x[0] for x in z['m']), t=len(z['m']), d=any(x[1]=='d' for x in z['m']), h=any(x[1]=='h' for x in z['m'])) for z in zs]
for tk, ords in PABLO.items():
    d = velas(tk, '1d', '1y'); h = velas(tk, '60m', '1mo')
    spot = d[-1]['c']; ars = float(ARS[tk]); ratio = max(1, round(spot * CCL / ars))
    toA = lambda u: round(u * CCL / ratio); toU = lambda a: a * ratio / CCL
    atr = sum(max(d[i]['h']-d[i]['l'], abs(d[i]['h']-d[i-1]['c']), abs(d[i]['l']-d[i-1]['c'])) for i in range(len(d)-14, len(d))) / 14
    dh, dl = piv(d, 5, 'd'); hh, hl = piv(h, 5, 'h')
    sup = zonas(dl + hl); res = zonas(dh + hh)
    below = [z for z in sup if z['hi'] < spot * 0.999]; above = [z for z in res if z['lo'] > spot * 1.001]
    print(f'\n=== {tk} · spot US$ {spot:.2f} = ${ars:,.0f} CEDEAR (ratio {ratio}) · ATR diario US$ {atr:.2f} ({atr/spot*100:.1f}%) · mínimo 1 año US$ {min(x["l"] for x in d):.2f} · máximo US$ {max(x["h"] for x in d):.2f}')
    print('  resistencias arriba (piso de zona → CEDEAR): ' + ' · '.join(f'{z["lo"]:.2f}→${toA(z["lo"]):,} ({z["t"]}t{" D" if z["d"] else ""}{"H" if z["h"] else ""})' for z in above[:4]))
    print('  soportes abajo (techo de zona → CEDEAR):      ' + ' · '.join(f'{z["hi"]:.2f}→${toA(z["hi"]):,} ({z["t"]}t{" D" if z["d"] else ""}{"H" if z["h"] else ""})' for z in reversed(below[-5:])))
    tgt = above[0]['lo'] if above else None
    def plan(entry_u, nombre):
        lower = [z for z in below if z['hi'] < entry_u * 0.995]
        stop_m = lower[-1]['lo'] * 0.993 if lower else entry_u - atr
        stop_r = entry_u - 1.5 * atr
        rr = (tgt - entry_u) / (entry_u - stop_m) if tgt and entry_u > stop_m else None
        print(f'  {nombre:28} entrada ${toA(entry_u):,} (US$ {entry_u:.2f}, {entry_u/spot*100-100:+.1f}%) · stop modelo ${toA(stop_m):,} ({stop_m/entry_u*100-100:+.1f}%) · stop 1,5×ATR ${toA(stop_r):,} ({stop_r/entry_u*100-100:+.1f}%) · objetivo ${toA(tgt):,} ({tgt/entry_u*100-100:+.1f}%) · R:R {rr:.1f}' if tgt else f'  {nombre}: sin resistencia arriba')
    for z in reversed(below[-3:]): plan(z['hi'], f'modelo: soporte {z["t"]} toque(s)')
    for o in ords: plan(toU(o), f'Pablo: orden a ${o:,}')
