# -*- coding: utf-8 -*-
# Grilla alrededor de los balances trimestrales (pedido de LP, 14/10/2026).
# Pregunta: conviene cambiar la grilla en las N ruedas anteriores al balance?
#   C  control (sin cambios)
#   A  ventana de N ruedas sin comprar nada (ni ciclo nuevo ni escalon ni refuerzo ni lateral),
#      incluido el gap de apertura del dia del salto; las ventas siguen
#   B  ventana de N ruedas comprando con medio lote (escalones, refuerzo y lateral)
# N = 1 y 2 ruedas. Velas horarias (research/backtest-5y/data/hourly, 2023-10 a 2026-09),
# 12 papeles x 2 cuentas (paso base x2 y x2,5, ganancia 70% del paso), refuerzo 50% al doble de
# profundidad y lateral como en vivo (misma config que pausa_suba.py). Lote 460 USD.
# Fechas de balances: balances-fechas.json (api.nasdaq.com/api/calendar/earnings por dia habil,
# generado por balances_fechas.py). El historico no trae hora ('time-not-supplied'): la vela del
# salto se infiere. Todos reportan despues del cierre (salto = apertura de la rueda siguiente)
# salvo JNJ, que reporta antes de la apertura (salto = apertura del mismo dia); el script
# imprime el chequeo contra el gap de apertura de cada papel.
# Mitades como en el resto de la serie: corridas separadas sobre cada mitad.
# "Evento" = desde el cierre previo a la primera rueda de la ventana hasta el cierre del dia del
# salto (marca a mercado). "Resto" = todo lo demas.
import sys
import json, os
import grilla5y as g

AQUI = os.path.dirname(os.path.abspath(__file__))
PAPELES = [('MU', 0.01), ('SNDK', 0.015), ('NVDA', 0.01), ('AMD', 0.01), ('INTC', 0.01), ('META', 0.01),
           ('GOOGL', 0.007), ('AAPL', 0.007), ('MSFT', 0.007), ('AMZN', 0.007), ('NU', 0.01), ('JNJ', 0.007)]
KW = dict(doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)
ANTES_APERTURA = {'JNJ'}
# NU: Nasdaq lista 2026-02-19 y 2026-02-25 para el mismo trimestre; el gap de apertura de la
# primera es -0,7% y el de la segunda -4,5%. Se descarta la 19 (estimada) y se queda la 25.
DESCARTAR = {('NU', '2026-02-19')}
VARIANTES = [('C  control', None, 0), ('A1 no compra 1 rueda', 'A', 1), ('A2 no compra 2 ruedas', 'A', 2),
             ('B1 medio lote 1 rueda', 'B', 1), ('B2 medio lote 2 ruedas', 'B', 2)]

datos = {tk: g.cargar(tk, 'hourly') for tk, _ in PAPELES}
fechas = sorted({b[0] for v in datos.values() for b in v})
mitad = fechas[len(fechas) // 2]
raw = json.load(open(os.path.join(AQUI, 'balances-fechas.json')))['balances']
dias_de = {tk: sorted({b[0] for b in v}) for tk, v in datos.items()}


def eventos(tk):
    """[(fecha_reporte, fecha_salto)] dentro de los datos del papel"""
    dias = dias_de[tk]
    out = []
    for e in raw.get(tk, []):
        R = e['fecha']
        if (tk, R) in DESCARTAR or R not in dias:
            continue
        j = dias.index(R) + (0 if tk in ANTES_APERTURA else 1)
        if j < len(dias):
            out.append((R, dias[j]))
    return out


def ventana(tk, J, N):
    dias = dias_de[tk]
    j = dias.index(J)
    return dias[max(j - N, 0):j]


def bal_de(tk, modo, N):
    v, s = set(), set()
    for R, J in eventos(tk):
        v.update(ventana(tk, J, N)); s.add(J)
    return dict(ventana=v, salto=s, modo=modo)


def corre(tk, base, esc, bars, bal):
    p = base * esc
    return g.grilla(bars, p, p * 0.7, None, bal=bal, **KW)


def pnl_eventos(bars, eq, tk, N):
    """{fecha_salto: USD} de cada evento (ventana de N ruedas + dia del salto) presente en bars"""
    ult = {}
    for i, b in enumerate(bars):
        ult[b[0]] = i
    dias = sorted(ult)
    out = {}
    for R, J in eventos(tk):
        if J not in ult:
            continue
        w = [d for d in ventana(tk, J, N) if d in ult]
        if not w:
            continue
        k = dias.index(w[0])
        ini = eq[ult[dias[k - 1]]] if k > 0 else 0.0
        out[J] = eq[ult[J]] - ini
    return out


def corrida(esc, modo, N):
    """para cada papel: full, mitad1, mitad2 -> (bars, r)"""
    out = {}
    for tk, base in PAPELES:
        v = datos[tk]
        bal = bal_de(tk, modo, N) if modo else None
        cortes = (('full', v), ('h1', [b for b in v if b[0] < mitad]), ('h2', [b for b in v if b[0] >= mitad]))
        out[tk] = {k: (b, corre(tk, base, esc, b, bal)) for k, b in cortes if b}
    return out


def latente_cartera(res):
    por = {}
    for tk, d in res.items():
        bars, r = d['full']
        ult = {}
        for i, b in enumerate(bars):
            ult[b[0]] = r['s_ab'][i]
        for f, x in ult.items():
            por[f] = por.get(f, 0.0) + x
    return min(por.values())


def eventos_total(res, N):
    """suma de P&L de eventos por mitad {h1, h2} y dict por evento {(tk, J): usd}"""
    tot = {'h1': 0.0, 'h2': 0.0}
    det = {}
    for tk, d in res.items():
        for h in ('h1', 'h2'):
            if h not in d:
                continue
            bars, r = d[h]
            for J, x in pnl_eventos(bars, r['eq'], tk, N).items():
                tot[h] += x
                det[(tk, J)] = x
    return tot, det


def main():
    print('velas horarias', fechas[0], 'a', fechas[-1], '· corte de mitades', mitad)
    print('\nBALANCES USADOS (fecha de reporte > rueda del salto, aaaa omitido)')
    n1 = n2 = 0
    for tk, _ in PAPELES:
        ev = eventos(tk)
        n1 += sum(1 for R, J in ev if J < mitad); n2 += sum(1 for R, J in ev if J >= mitad)
        print('  %-5s %2d balances: %s' % (tk, len(ev), ' '.join('%s>%s' % (R[2:], J[5:]) for R, J in ev)))
    print('  total %d balances papel-trimestre (1ra mitad %d, 2da mitad %d)' % (n1 + n2, n1, n2))
    print('\nCHEQUEO DE LA HORA DEL REPORTE (promedio de |gap de apertura| del dia R y del dia R+1)')
    for tk, _ in PAPELES:
        op, cl, dd = {}, {}, []
        for f, o, h, l, c in datos[tk]:
            if f not in op:
                op[f] = o; dd.append(f)
            cl[f] = c
        gr = gn = 0.0; n = 0
        for R, J in eventos(tk):
            i = dd.index(R)
            if i < 1 or i + 1 >= len(dd):
                continue
            gr += abs(op[R] / cl[dd[i - 1]] - 1); gn += abs(op[dd[i + 1]] / cl[R] - 1); n += 1
        if n:
            print('  %-5s gap abre R %.1f%% · gap abre R+1 %.1f%% (%d eventos) -> %s' % (
                tk, gr / n * 100, gn / n * 100, n, 'antes de apertura' if gr > gn else 'despues del cierre'))

    for esc, nom in ((2.0, 'cuenta 72404 (paso x2)'), (2.5, 'cuenta 3893 (paso x2,5)')):
        print('\n' + '=' * 118 + '\n== ' + nom)
        R = {vn: corrida(esc, modo, N) for vn, modo, N in VARIANTES}
        C = R[VARIANTES[0][0]]
        tot_c = {k: sum(C[tk][k][1]['total'] for tk in C if k in C[tk]) for k in ('full', 'h1', 'h2')}
        print('  %-24s %8s %8s %8s | %8s %8s | %7s | %9s %9s' % ('variante', 'total', '1ra mit', '2da mit', 'eventos', 'resto', 'vueltas', 'peor lat', 'peor cart'))
        print('  %-24s %8s %8s %8s | %8s %8s | %7s | %9s %9s' % ('', 'USD', 'USD', 'USD', 'USD', 'USD', '', 'suma pap.', 'por dia'))
        for vn, modo, N in VARIANTES:
            res = R[vn]
            t = {k: sum(res[tk][k][1]['total'] for tk in res if k in res[tk]) for k in ('full', 'h1', 'h2')}
            ev, _ = eventos_total(res, N or 1)
            evs = ev['h1'] + ev['h2']
            vu = sum(res[tk]['full'][1]['rondas'] for tk in res)
            pl = sum(res[tk]['full'][1]['peor_abierto'] for tk in res)
            print('  %-24s %+8.0f %+8.0f %+8.0f | %+8.0f %+8.0f | %7d | %9.0f %9.0f' % (
                vn, t['full'], t['h1'], t['h2'], evs, t['h1'] + t['h2'] - evs, vu, pl, latente_cartera(res)))
        print('  (eventos = ventana de N ruedas + dia del salto, N de la variante; el control usa N=1 en su fila)')
        ev2, _ = eventos_total(C, 2)
        print('  control medido con N=2: eventos %+.0f resto %+.0f' % (ev2['h1'] + ev2['h2'], tot_c['h1'] + tot_c['h2'] - ev2['h1'] - ev2['h2']))
        print('  --- contra el control, por mitad (dif de total de la mitad) y por balance')
        for vn, modo, N in VARIANTES[1:]:
            res = R[vn]
            t = {k: sum(res[tk][k][1]['total'] for tk in res if k in res[tk]) for k in ('h1', 'h2')}
            evv, dv = eventos_total(res, N)
            evc, dc = eventos_total(C, N)
            mej = sum(1 for k in dv if dv[k] - dc.get(k, 0) > 0.5)
            peo = sum(1 for k in dv if dv[k] - dc.get(k, 0) < -0.5)
            pl_c = sum(C[tk]['full'][1]['peor_abierto'] for tk in C)
            pl_v = sum(res[tk]['full'][1]['peor_abierto'] for tk in res)
            print('   %-22s mitad1 %+7.0f (eventos %+6.0f) · mitad2 %+7.0f (eventos %+6.0f) · balances mejora %d / empeora %d / igual %d · peor lat. dif %+.0f · peor cartera dif %+.0f' % (
                vn, t['h1'] - tot_c['h1'], evv['h1'] - evc['h1'], t['h2'] - tot_c['h2'], evv['h2'] - evc['h2'],
                mej, peo, len(dv) - mej - peo, pl_v - pl_c, latente_cartera(res) - latente_cartera(C)))
        print('  --- por papel: dif de total contra el control en (mitad1 / mitad2) por variante; eventos del control (N=1)')
        print('   %-6s %9s %9s | %s' % ('papel', 'total C', 'evento C', ' '.join('%-15s' % v[0][:2] for v in VARIANTES[1:])))
        for tk, _ in PAPELES:
            fila = []
            for vn, modo, N in VARIANTES[1:]:
                d1 = R[vn][tk]['h1'][1]['total'] - C[tk]['h1'][1]['total'] if 'h1' in C[tk] else 0.0
                d2 = R[vn][tk]['h2'][1]['total'] - C[tk]['h2'][1]['total']
                fila.append('%+6.0f /%+6.0f%s' % (d1, d2, '*' if d1 > 0 and d2 > 0 else ' '))
            e1, _ = eventos_total({tk: C[tk]}, 1)
            print('   %-6s %+9.0f %+9.0f | %s' % (tk, C[tk]['full'][1]['total'], e1['h1'] + e1['h2'], ' '.join(fila)))
        print('   (* = mejora en las dos mitades)')


if __name__ == '__main__':
    main()
