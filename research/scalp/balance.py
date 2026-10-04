# -*- coding: utf-8 -*-
# Canasta balanceada (LP 04/10/2026): "cuando bajan los semis, que sube? cual es
# el opuesto? armamos algo balanceado y simulamos todos los escenarios, estilo
# montecarlo, de los ultimos 2 años".
#
#  A) Que hace cada CEDEAR los dias que caen los semis (factor = SMH).
#  B) Canastas de 9: la actual, y dos balanceadas elegidas con la correlacion de
#     los 2 años ANTERIORES (para no elegir con los mismos datos que se prueban).
#  C) Monte Carlo: 1.000 años sinteticos armados con bloques de 10 ruedas de los
#     ultimos 2 años, las mismas ruedas para todos los papeles (conserva la
#     correlacion entre ellos). En cada año se corre la grilla sin corte con
#     refuerzo de 50% papel por papel y se suma la cartera.
#  D) Control de azar: 300 canastas de 9 elegidas al azar entre los liquidos.
#
# Datos: d10/ (diario, USD, hasta 01/10/2026). Liquidez: foto de data912 del
# ultimo cierre (un solo dia). SNDK cotiza desde 02/2025: antes se usa WDC, su
# empresa madre. Todo en dolares: el CCL es un factor comun que no se balancea.
import json, os, math, random, sys, time, urllib.request
import grilla5y as g

AQUI = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(AQUI, 'd10')
T = 504                 # ruedas de prueba (ultimos 2 años)
LARGO = 250             # ruedas por año sintetico
BLOQUE = 10
N_MC = int(os.environ.get('N_MC', 1000))
N_AZAR = 300
N_MC_AZAR = 200
ACTUAL = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
          ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005)]
# apalancados, inversos, de volatilidad y cripto: no son candidatos a una grilla que holdea
EXCLUIR = {'AMDD', 'QQQD', 'SPXL', 'TQQQ', 'VXX', 'ETHA', 'IBIT', 'SPCX', 'GGAL', 'ELPC'}
CAP_PAPEL = g.LOTE * g.NIV * 1.5          # 5 lotes + refuerzo de 50%


def cargar():
    S = {}
    for f in os.listdir(D):
        S[f[:-5]] = {r[0]: (r[1], r[2], r[3], r[4]) for r in json.load(open(os.path.join(D, f))) if r[1] and r[2] and r[3] and r[4]}
    return S


def liquidez():
    p = os.path.join(AQUI, 'data912-cedears.json')
    if not os.path.exists(p):
        req = urllib.request.Request('https://data912.com/live/arg_cedears', headers={'User-Agent': 'Mozilla/5.0'})
        open(p, 'wb').write(urllib.request.urlopen(req, timeout=30).read())
    out = {}
    for r in json.load(open(p)):
        if r.get('c') and r.get('px_bid') and r.get('px_ask'):
            out[r['symbol']] = dict(monto=(r.get('v') or 0) * r['c'], ops=r.get('q_op') or 0, spread=r['px_ask'] / r['px_bid'] - 1)
    return out


def pct(v, q):
    v = sorted(v)
    return v[min(len(v) - 1, max(0, int(round(q * (len(v) - 1)))))]


def corr(x, y):
    n = len(x); mx = sum(x) / n; my = sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else 0.0


def main():
    S = cargar()
    L = liquidez()
    cal = sorted(S['MU'])
    prueba, previa = cal[-T:], cal[-2 * T:-T]
    # SNDK antes de cotizar: las velas de WDC (solo importan las proporciones de cada dia)
    ini = min(S['SNDK'])
    k = S['SNDK'][ini][3] / S['WDC'][ini][3]          # empalme: WDC llevado a la escala de SNDK
    for d in cal:
        if d < ini and d in S['WDC']:
            S['SNDK'][d] = tuple(v * k for v in S['WDC'][d])

    idx = {d: i for i, d in enumerate(cal)}
    R = {}
    for tk, s in S.items():
        r = {}
        for d in cal[1:]:
            p = cal[idx[d] - 1]
            if d in s and p in s:
                r[d] = math.log(s[d][3] / s[p][3])
        R[tk] = r
    completo = lambda tk, dias: all(d in R[tk] for d in dias)
    serie = lambda tk, dias: [R[tk][d] for d in dias]
    vol = lambda tk, dias: math.sqrt(sum(x * x for x in serie(tk, dias)) / len(dias) * 252)

    # ── A) que hace cada papel cuando caen los semis ──
    smh = serie('SMH', prueba)
    malos = [d for d, x in zip(prueba, smh) if x <= -0.02]
    print('ULTIMOS 2 AÑOS: %s a %s (%d ruedas). Dias con los semis (SMH) cayendo 2%% o mas: %d' % (prueba[0], prueba[-1], T, len(malos)))
    liquidos = [tk for tk in S if tk in L and tk not in EXCLUIR and L[tk]['monto'] >= 30e6 and L[tk]['spread'] <= 0.012 and completo(tk, prueba) and completo(tk, previa)]
    print('CEDEARs con historia completa, monto operado >= $30M y spread <= 1,2%% en la foto del ultimo cierre: %d' % len(liquidos))
    filas = []
    for tk in liquidos:
        x = serie(tk, prueba)
        enmalos = [R[tk][d] for d in malos]
        filas.append((corr(x, smh), tk, corr(serie(tk, previa), serie('SMH', previa)), 100 * sum(enmalos) / len(enmalos), 100.0 * sum(1 for v in enmalos if v > 0) / len(enmalos), 100 * vol(tk, prueba), L[tk]['monto'] / 1e6))
    filas.sort()
    print('\nA) LOS MENOS ATADOS A LOS SEMIS (correlacion diaria con SMH, ultimos 2 años)')
    print('   %-6s %8s %10s %16s %14s %9s %10s' % ('papel', 'correl.', '2a antes', 'dia malo semis', 'sube esos dias', 'volatil.', 'monto $M'))
    for c, tk, c0, m, up, v, mo in filas[:32]:
        print('   %-6s %8.2f %10.2f %15.2f%% %13.0f%% %8.0f%% %10.0f' % (tk, c, c0, m, up, v, mo))
    print('   ...')
    for c, tk, c0, m, up, v, mo in filas:
        if tk in [a[0] for a in ACTUAL] or tk in ('GLD', 'SLV', 'GDX', 'XLE', 'USO', 'SPY', 'EWZ'):
            print('   %-6s %8.2f %10.2f %15.2f%% %13.0f%% %8.0f%% %10.0f' % (tk, c, c0, m, up, v, mo))
    if 'SNDK' not in liquidos:
        x = serie('SNDK', prueba); em = [R['SNDK'][d] for d in malos]
        print('   %-6s %8.2f %10s %15.2f%% %13.0f%% %8.0f%%   (con WDC antes de 02/2025)' % ('SNDK', corr(x, smh), '', 100 * sum(em) / len(em), 100.0 * sum(1 for v in em if v > 0) / len(em), 100 * vol('SNDK', prueba)))

    # ── B) canastas, elegidas con los 2 años ANTERIORES ──
    def params(tk):
        v = vol(tk, previa)
        return (0.015, 0.01) if v > 0.55 else (0.01, 0.007) if v > 0.30 else (0.007, 0.005) if v > 0.20 else (0.005, 0.0035)
    cand = [tk for tk in liquidos if vol(tk, previa) >= 0.22]      # con menos movimiento la grilla no rota
    cache = {}
    def c_prev(a, b):
        k = (a, b) if a < b else (b, a)
        if k not in cache: cache[k] = corr(serie(a, previa), serie(b, previa))
        return cache[k]
    def codicioso(base, n):
        sel = list(base)
        while len(sel) < n:
            mejor = min((tk for tk in cand if tk not in sel), key=lambda tk: sum(c_prev(tk, s) for s in sel) / len(sel))
            sel.append(mejor)
        return sel
    act = [a[0] for a in ACTUAL]
    P = {a[0]: (a[1], a[2]) for a in ACTUAL}
    resto = sorted((tk for tk in act if tk not in ('MU', 'NVDA', 'SNDK')), key=lambda tk: c_prev(tk, 'SMH'))
    mitad = codicioso(['MU', 'NVDA'] + resto[:2], 9)
    libre = codicioso(['MU'], 9)
    # defensivos: los 4 liquidos menos atados a los semis en los 2 años previos (sin piso de volatilidad)
    defens = sorted((tk for tk in liquidos if tk not in act and tk not in ('SMH', 'SPY', 'QQQ', 'XLK')), key=lambda tk: c_prev(tk, 'SMH'))[:4]
    canastas = [('actual (9 de hoy)', act), ('5 semis + 4 defensivos', ['MU', 'SNDK', 'NVDA', 'AMD', 'INTC'] + defens),
                ('mitad y mitad (4 de hoy + 5 opuestos)', mitad), ('MU + 8 opuestos', libre)]
    def par(tk):
        return P[tk] if tk in P else params(tk)
    def n_ef(sel, dias):
        cs = [corr(serie(a, dias), serie(b, dias)) for i, a in enumerate(sel) for b in sel[i + 1:]]
        rho = sum(cs) / len(cs)
        av = [sum(R[tk][d] for tk in sel) / len(sel) for d in dias]
        peor20 = min(sum(av[i:i + 20]) for i in range(len(av) - 20))
        return rho, len(sel) / (1 + (len(sel) - 1) * rho), 100 * peor20
    print('\nB) CANASTAS (elegidas con la correlacion de %s a %s; medidas en los ultimos 2 años)' % (previa[0], previa[-1]))
    for nombre, sel in canastas:
        rho, ne, p20 = n_ef(sel, prueba)
        print('   %-38s %s' % (nombre, ' '.join(sel)))
        print('   %-38s correlacion media %.2f · apuestas independientes %.1f · peor racha de 20 ruedas %.1f%%' % ('', rho, ne, p20))

    # ── simulacion de un papel sobre una lista de dias (reales o sorteados) ──
    def barras(tk, dias):
        px = 100.0; out = []
        s = S[tk]
        for n, d in enumerate(dias):
            pc = s[cal[idx[d] - 1]][3]
            o, h, l, c = (px * v / pc for v in s[d])
            out.append(('%04d-%03d' % (2000 + n // 250, n), o, h, l, c))
            px = c
        return out
    def corre(tk, dias):
        p, gn = par(tk)
        r = g.grilla(barras(tk, dias), p, gn, None, doble=2.0, frac=0.5)
        return r['eq'], r['s_cap'], r['rondas']
    def cartera(res, sel):
        n = len(res[sel[0]][0])
        eq = [sum(res[tk][0][i] for tk in sel) for i in range(n)]
        cap = [sum(res[tk][1][i] for tk in sel) for i in range(n)]
        return eq[-1], min(min(eq), 0.0), max(cap), sum(res[tk][2] for tk in sel)

    capital = 9 * CAP_PAPEL
    print('\n   HISTORIA REAL de los ultimos 2 años (grilla sin corte, refuerzo 50%%; %% sobre el capital maximo de la canasta, USD %d)' % capital)
    print('   %-38s %10s %12s %10s %14s' % ('canasta', 'resultado', 'peor momento', 'vueltas', 'result/peor'))
    for nombre, sel in canastas:
        res = {tk: corre(tk, prueba) for tk in sel}
        fin, peor, cap, v = cartera(res, sel)
        print('   %-38s %9.1f%% %11.1f%% %10d %14.2f' % (nombre, 100 * fin / capital, 100 * peor / capital, v, fin / -peor if peor < 0 else float('nan')))

    # ── C) Monte Carlo ──
    rnd = random.Random(20261004)
    def sorteo(pozo=None):
        pozo = pozo or prueba
        dias = []
        while len(dias) < LARGO:
            i = rnd.randrange(len(pozo))
            dias.extend(pozo[(i + k) % len(pozo)] for k in range(BLOQUE))
        return dias[:LARGO]
    caminos = [sorteo() for _ in range(N_MC)]
    nombres = sorted({tk for _, sel in canastas for tk in sel})
    t0 = time.time()
    M = {n: [] for n, _ in canastas}
    por_papel = {tk: [] for tk in nombres}
    for dias in caminos:
        res = {tk: corre(tk, dias) for tk in nombres}
        for tk in nombres:
            por_papel[tk].append(res[tk][0][-1])
        for nombre, sel in canastas:
            M[nombre].append(cartera(res, sel))
    print('\nC) MONTE CARLO: %d años sinteticos de %d ruedas (bloques de %d ruedas de los ultimos 2 años) · %.0f s' % (N_MC, LARGO, BLOQUE, time.time() - t0))
    print('   % anual sobre el capital maximo de la canasta')
    print('   %-38s %9s %9s %9s %10s | %12s %12s %12s | %9s' % ('canasta', 'mediana', 'malo 5%', 'bueno 5%', 'años neg.', 'peor: med.', 'peor: 5%', 'peor: 1%', 'med/peor5'))
    for nombre, sel in canastas:
        fin = [100 * m[0] / capital for m in M[nombre]]; peor = [100 * m[1] / capital for m in M[nombre]]
        print('   %-38s %8.1f%% %8.1f%% %8.1f%% %9.0f%% | %11.1f%% %11.1f%% %11.1f%% | %9.2f' % (
            nombre, pct(fin, .5), pct(fin, .05), pct(fin, .95), 100.0 * sum(1 for x in fin if x < 0) / len(fin),
            pct(peor, .5), pct(peor, .05), pct(peor, .01), pct(fin, .5) / -pct(peor, .05)))
    print('\n   Por papel (mediana y 5%% malo del resultado anual, %% sobre el capital del papel USD %d)' % CAP_PAPEL)
    for tk in nombres:
        v = [100 * x / CAP_PAPEL for x in por_papel[tk]]
        print('   %-6s paso %.1f%% · mediana %6.1f%% · malo 5%% %7.1f%% · años negativos %3.0f%% · %s' % (
            tk, par(tk)[0] * 100, pct(v, .5), pct(v, .05), 100.0 * sum(1 for x in v if x < 0) / len(v),
            ' + '.join(n.split(' (')[0] for n, sel in canastas if tk in sel)))

    # ── E) el mismo ejercicio con las ruedas de 2022, el ultimo año malo de los semis ──
    y22 = [d for d in cal if d[:4] == '2022']
    cs22 = [(n, sel) for n, sel in canastas if all(completo(tk, y22) for tk in sel)]
    fuera = [n for n, sel in canastas if (n, sel) not in cs22]
    smh22 = 100 * (math.exp(sum(R['SMH'][d] for d in y22)) - 1)
    ns22 = sorted({tk for _, sel in cs22 for tk in sel})
    M22 = {n: [] for n, _ in cs22}
    pp22 = {tk: [] for tk in ns22}
    for _ in range(N_MC):
        dias = sorteo(y22)
        res = {tk: corre(tk, dias) for tk in ns22}
        for tk in ns22:
            pp22[tk].append(res[tk][0][-1])
        for nombre, sel in cs22:
            M22[nombre].append(cartera(res, sel))
    print('\nE) PRUEBA DE ESTRES: %d años sinteticos armados con las %d ruedas de 2022 (SMH %.0f%% en el año)%s' % (N_MC, len(y22), smh22, ' · sin datos de 2022: ' + ', '.join(fuera) if fuera else ''))
    print('   %-38s %9s %9s %9s %10s | %12s %12s %12s' % ('canasta', 'mediana', 'malo 5%', 'bueno 5%', 'años neg.', 'peor: med.', 'peor: 5%', 'peor: 1%'))
    for nombre, sel in cs22:
        fin = [100 * m[0] / capital for m in M22[nombre]]; peor = [100 * m[1] / capital for m in M22[nombre]]
        print('   %-38s %8.1f%% %8.1f%% %8.1f%% %9.0f%% | %11.1f%% %11.1f%% %11.1f%%' % (
            nombre, pct(fin, .5), pct(fin, .05), pct(fin, .95), 100.0 * sum(1 for x in fin if x < 0) / len(fin), pct(peor, .5), pct(peor, .05), pct(peor, .01)))
    print('   Por papel en 2022 (mediana del resultado anual, % sobre el capital del papel): ' + ' · '.join('%s %.0f%%' % (tk, pct([100 * x / CAP_PAPEL for x in v], .5)) for tk, v in sorted(pp22.items())))

    # ── D) control de azar ──
    universo = sorted(set(cand) | set(a for a in act if a != 'SNDK'))
    azar = [rnd.sample(universo, 9) for _ in range(N_AZAR)]
    t0 = time.time()
    A = [[] for _ in azar]
    C2 = {n: [] for n, _ in canastas}
    todos = sorted(set(universo) | set(nombres))
    for dias in caminos[:N_MC_AZAR]:
        res = {tk: corre(tk, dias) for tk in todos}
        for i, sel in enumerate(azar):
            A[i].append(cartera(res, sel))
        for nombre, sel in canastas:
            C2[nombre].append(cartera(res, sel))
    def resumen(ms):
        fin = [100 * m[0] / capital for m in ms]; peor = [100 * m[1] / capital for m in ms]
        return pct(fin, .5), pct(peor, .05), pct(fin, .5) / -pct(peor, .05)
    ra = [resumen(a) for a in A]
    print('\nD) CONTROL DE AZAR: %d canastas de 9 al azar entre %d papeles, %d años sinteticos · %.0f s' % (N_AZAR, len(universo), N_MC_AZAR, time.time() - t0))
    print('   al azar: mediana del resultado %.1f%% (de %.1f%% a %.1f%%) · peor momento 5%%: %.1f%% (de %.1f%% a %.1f%%) · resultado/peor: %.2f (de %.2f a %.2f)' % (
        pct([r[0] for r in ra], .5), pct([r[0] for r in ra], .05), pct([r[0] for r in ra], .95),
        pct([r[1] for r in ra], .5), pct([r[1] for r in ra], .05), pct([r[1] for r in ra], .95),
        pct([r[2] for r in ra], .5), pct([r[2] for r in ra], .05), pct([r[2] for r in ra], .95)))
    for nombre, sel in canastas:
        m, p, q = resumen(C2[nombre])
        print('   %-38s resultado %.1f%% (le gana al %.0f%% del azar) · peor 5%% %.1f%% (mejor que el %.0f%%) · resultado/peor %.2f (mejor que el %.0f%%)' % (
            nombre, m, 100.0 * sum(1 for r in ra if r[0] < m) / len(ra), p, 100.0 * sum(1 for r in ra if r[1] < p) / len(ra), q, 100.0 * sum(1 for r in ra if r[2] < q) / len(ra)))
    json.dump(dict(canastas=canastas, prueba=[prueba[0], prueba[-1]], previa=[previa[0], previa[-1]]), open(os.path.join(AQUI, 'balance-canastas.json'), 'w'))


if __name__ == '__main__':
    main()
