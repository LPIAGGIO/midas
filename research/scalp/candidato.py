# -*- coding: utf-8 -*-
# ¿Sumar un papel al scalp? (LP 08/10/2026: "BRKB como lo ves para sumar").
# Corre la misma grilla de la 72404 (sin corte, refuerzo 50%, lateral) sobre el
# candidato y sobre los papeles que ya operamos, en velas de 1 hora (2 años) y de
# 5 minutos (60 días), y mide la correlación diaria contra el ETF de semis.
# Todo en USD con el mismo lote, para comparar por unidad de capital.
#   python candidato.py BRK-B
import json, os, sys, time, urllib.request, statistics as st
import grilla5y as g
CAND = sys.argv[1] if len(sys.argv) > 1 else 'BRK-B'
AQUI = os.path.dirname(os.path.abspath(__file__))
BASE = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
        ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005), ('AMZN', 0.007, 0.005)]


def yahoo(sym, intervalo, rango):
    f = os.path.join(AQUI, 'cand', '%s-%s.json' % (sym, intervalo))
    if os.path.exists(f) and time.time() - os.path.getmtime(f) < 6 * 3600:
        return json.load(open(f))
    u = 'https://query2.finance.yahoo.com/v8/finance/chart/%s?interval=%s&range=%s' % (sym, intervalo, rango)
    r = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30))['chart']['result'][0]
    q = r['indicators']['quote'][0]
    out = []
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, l, c): continue
        lt = time.gmtime(t - 4 * 3600)
        out.append((time.strftime('%Y-%m-%d', lt), (lt.tm_hour + 1) * 100 + lt.tm_min, o, h, l, c))
    os.makedirs(os.path.dirname(f), exist_ok=True)
    json.dump(out, open(f, 'w'))
    return out


def corre(sym, p, gn, intervalo):
    v = yahoo(sym, intervalo, '730d' if intervalo == '1h' else '60d')
    v = [x for x in v if 1030 <= x[1] < 1700]
    esp, lat = (0, 1) if intervalo == '1h' else (4, 12)
    r = g.grilla([(f, o, h, l, c) for f, hm, o, h, l, c in v], p, gn, None, doble=2.0, frac=0.5, espera_barras=esp,
                 lateral_barras=lat, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)
    cap = st.mean(r['s_cap']) or 1
    return r, cap, r['dias']


def diario(sym):
    v = yahoo(sym, '1d', '2y')
    return {f: c for f, hm, o, h, l, c in v}


def main():
    soxx = diario('SOXX')
    print('== %s contra los 10 papeles del scalp · misma grilla · USD, lote %d' % (CAND, g.LOTE))
    for intervalo in ('1h', '5m'):
        print('\n   velas %s' % intervalo)
        print('   %-7s %-12s %9s %9s %8s %12s %10s %14s' % ('papel', 'paso/gan', 'resultado', 'realizado', 'vueltas', 'vueltas/día', 'peor abierto', 'por 1000 capital/día'))
        filas = [(CAND, 0.007, 0.005), (CAND, 0.005, 0.0035)] + BASE
        for sym, p, gn in filas:
            r, cap, d = corre(sym, p, gn, intervalo)
            print('   %-7s %4.1f%%/%4.2f%% %+9.0f %+9.0f %8d %12.2f %10.0f %14.2f' % (sym, p * 100, gn * 100, r['total'], r['real'], r['rondas'], r['rondas'] / d, r['peor_abierto'], 1000 * r['total'] / cap / d))
    print('\n   correlación de retornos diarios contra SOXX (2 años) y rango medio del día')
    for sym in [CAND] + [b[0] for b in BASE]:
        d = diario(sym)
        ks = sorted(set(d) & set(soxx))
        a = [d[ks[i]] / d[ks[i - 1]] - 1 for i in range(1, len(ks))]
        b = [soxx[ks[i]] / soxx[ks[i - 1]] - 1 for i in range(1, len(ks))]
        ma, mb = st.mean(a), st.mean(b)
        cor = sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (len(a) * st.pstdev(a) * st.pstdev(b))
        h1 = [x for x in yahoo(sym, '1h', '730d')]
        rng = {}
        for f, hm, o, h, l, c in h1:
            lo, hi = rng.get(f, (1e18, 0)); rng[f] = (min(lo, l), max(hi, h))
        rango = st.mean((hi / lo - 1) * 100 for lo, hi in rng.values())
        print('   %-7s correlación %+.2f · volatilidad diaria %.1f%% · rango medio del día %.1f%%' % (sym, cor, st.pstdev(a) * 100, rango))


if __name__ == '__main__':
    main()
