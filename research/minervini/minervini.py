# -*- coding: utf-8 -*-
# Minervini (post de Matías Scalbi, 12/10/2026): ¿la plantilla de tendencia
# sirve con NUESTROS datos y para NUESTRO bot?
#
#   A) Rendimiento posterior de los papeles que pasan las 8 condiciones vs el
#      resto del universo el mismo día (exceso), a 5, 20 y 60 ruedas. Entrada
#      a la apertura del día siguiente a la señal (sin mirar el futuro).
#   B) Cartera mensual: todos los que pasan (tope 10 por fuerza relativa),
#      equiponderada, con 0,121% por vuelta sobre lo que rota. Contra el
#      universo equiponderado y contra SPY. Primera mitad / segunda mitad.
#   C) Como filtro de la grilla del scalp: velas de 1 hora, parámetros de la
#      cuenta 72404 (2x), abrir ciclos nuevos solo los días en que el papel
#      pasaba la plantilla al cierre anterior.
#
# Lo que NO se mide: fundamentos (EPS, ventas), el patrón VCP y el pivot, que
# en el método son juicio sobre el gráfico. Sesgo de supervivencia: el
# universo son los CEDEARs que existen HOY, así que todo sale optimista.
import json, os, sys, time, math, statistics as st, bisect
AQUI = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(AQUI, '..', 'backtest-5y', 'data')
sys.path.insert(0, os.path.join(AQUI, '..', 'scalp'))
FEE_RT = 0.00121

ETF = set('AMDD ARKK CIBR COPX EEM ETHA EWJ EWY EWZ GDX GLD GSG IBB IBIT ICLN IEMG ILF ITA QQQ QQQD SLV SMH SPXL SPY TQQQ URA USO VXX XLE XLK XME'.split())


def cargar(tk, serie='daily'):
    j = json.load(open(os.path.join(D, serie, tk + '.json')))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    out = []
    for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if o and h and l and c:
            out.append((time.strftime('%Y-%m-%d', time.gmtime(t - 4 * 3600)), o, h, l, c))
    # dedup por fecha (Yahoo a veces repite la última barra)
    vist, res = set(), []
    for b in out:
        if b[0] in vist: continue
        vist.add(b[0]); res.append(b)
    return res


def sma(v, n, i):
    return sum(v[i - n + 1:i + 1]) / n


def preparar():
    datos = {}
    for f in sorted(os.listdir(os.path.join(D, 'daily'))):
        tk = f[:-5]
        if tk in ETF: continue
        try:
            b = cargar(tk)
        except Exception:
            continue
        if len(b) < 300: continue
        datos[tk] = b
    return datos


def condiciones(b):
    """{fecha: (pasa_1a7, mom)} con mom = fuerza tipo IBD (sin el ranking)."""
    c = [x[4] for x in b]; h = [x[2] for x in b]; l = [x[3] for x in b]
    out = {}
    for i in range(272, len(b)):
        s50, s150, s200 = sma(c, 50, i), sma(c, 150, i), sma(c, 200, i)
        s200_ant = sma(c, 200, i - 21)
        hi52, lo52 = max(h[i - 251:i + 1]), min(l[i - 251:i + 1])
        ok = (c[i] > s150 and c[i] > s200 and s150 > s200 and s200 > s200_ant and s50 > s150 and s50 > s200
              and c[i] > s50 and c[i] >= 1.3 * lo52 and c[i] >= 0.75 * hi52)
        mom = 0.4 * (c[i] / c[i - 63] - 1) + 0.2 * (c[i] / c[i - 126] - 1) + 0.2 * (c[i] / c[i - 189] - 1) + 0.2 * (c[i] / c[i - 251] - 1)
        out[b[i][0]] = (ok, mom)
    return out


def main():
    datos = preparar()
    cond = {tk: condiciones(b) for tk, b in datos.items()}
    idx = {tk: {x[0]: i for i, x in enumerate(b)} for tk, b in datos.items()}
    fechas = sorted({f for cd in cond.values() for f in cd})
    # RS: percentil del momentum dentro del universo ese día
    pasa = {}   # fecha -> {tk: rs}
    for f in fechas:
        moms = [(tk, cd[f][1]) for tk, cd in cond.items() if f in cd]
        if len(moms) < 50: continue
        orden = sorted(m for _, m in moms)
        n = len(orden)
        pasa[f] = {}
        for tk, m in moms:
            rs = bisect.bisect_left(orden, m) / (n - 1) * 100
            if cond[tk][f][0] and rs >= 70:
                pasa[f][tk] = rs
    fechas = sorted(pasa)
    print('Universo: %d acciones (sin ETF) · %s a %s · %d ruedas con señal calculable' % (len(datos), fechas[0], fechas[-1], len(fechas)))
    print('Pasan la plantilla en promedio: %.1f papeles por día (de ~%d)' % (st.mean(len(v) for v in pasa.values()), len(datos)))

    # ── A) rendimiento posterior ──
    print('\nA) RENDIMIENTO POSTERIOR · entrada a la apertura siguiente · exceso contra el promedio del universo el mismo día')
    mitad = fechas[len(fechas) // 2]
    for H in (5, 20, 60):
        filas = {'1ra mitad': [], '2da mitad': []}
        for f in fechas[::5]:   # cada 5 ruedas para no repetir casi la misma observación
            rets = {}
            for tk, b in datos.items():
                i = idx[tk].get(f)
                if i is None or i + H >= len(b): continue
                rets[tk] = b[i + H][4] / b[i + 1][1] - 1
            if len(rets) < 50: continue
            u = st.mean(rets.values())
            sel = [rets[tk] - u for tk in pasa[f] if tk in rets]
            if sel:
                filas['1ra mitad' if f < mitad else '2da mitad'].append((st.mean(sel), len(sel)))
        for k, v in filas.items():
            ex = [x for x, _ in v]
            t = st.mean(ex) / (st.pstdev(ex) / math.sqrt(len(ex))) if len(ex) > 2 and st.pstdev(ex) > 0 else float('nan')
            print('   %2d ruedas · %s: exceso medio %+.2f%% · días con exceso positivo %d%% · t %.1f · %d fechas' % (
                H, k, st.mean(ex) * 100, 100 * sum(1 for x in ex if x > 0) / len(ex), t, len(ex)))

    # ── B) cartera mensual ──
    print('\nB) CARTERA MENSUAL · los que pasan (tope 10 por fuerza relativa) · equiponderada · 0,121%% por vuelta')
    fin_mes = [f for k, f in enumerate(fechas) if k + 1 == len(fechas) or fechas[k + 1][:7] != f[:7]]
    spy = cargar('SPY'); spy_i = {x[0]: i for i, x in enumerate(spy)}
    serie = []
    prev = set()
    for a, z in zip(fin_mes, fin_mes[1:]):
        top = sorted(pasa[a].items(), key=lambda x: -x[1])[:10]
        sel = [tk for tk, _ in top]
        def r_tk(tk):
            i, j = idx[tk].get(a), idx[tk].get(z)
            if i is None or j is None or i + 1 >= len(datos[tk]): return None
            return datos[tk][j][4] / datos[tk][i + 1][1] - 1
        rs = [r for r in (r_tk(tk) for tk in sel) if r is not None]
        ru = [r for r in (r_tk(tk) for tk in datos) if r is not None]
        rot = len(set(sel) ^ prev) / max(len(sel) + len(prev), 1)
        prev = set(sel)
        rc = (st.mean(rs) if rs else 0.0) - rot * FEE_RT
        rsp = spy[spy_i[z]][4] / spy[spy_i[a] + 1][1] - 1 if a in spy_i and z in spy_i else 0.0
        serie.append((z, rc, st.mean(ru), rsp, len(rs)))
    def resumen(xs):
        m = st.mean(xs); s = st.pstdev(xs)
        acc = 1.0
        for x in xs: acc *= 1 + x
        return '%+.2f%%/mes · Sharpe %.2f · total %+.0f%%' % (m * 100, m / s * math.sqrt(12) if s else 0, (acc - 1) * 100)
    for nom, sub in (('todo', serie), ('1ra mitad', serie[:len(serie) // 2]), ('2da mitad', serie[len(serie) // 2:])):
        print('   %-9s  plantilla %s' % (nom, resumen([x[1] for x in sub])))
        print('   %-9s  universo  %s' % ('', resumen([x[2] for x in sub])))
        print('   %-9s  SPY       %s' % ('', resumen([x[3] for x in sub])))
    print('   meses sin ningún papel que pase: %d de %d' % (sum(1 for x in serie if x[4] == 0), len(serie)))
    peor = min(serie, key=lambda x: x[1]); print('   peor mes plantilla: %s %+.1f%% (universo %+.1f%%)' % (peor[0][:7], peor[1] * 100, peor[2] * 100))
    por_anio = {}
    for z, rc, ru, rsp, n in serie:
        por_anio.setdefault(z[:4], []).append((rc, ru))
    print('   por año (plantilla vs universo): ' + '  '.join('%s %+.0f%%/%+.0f%%' % (a, (math.prod(1 + x for x, _ in v) - 1) * 100, (math.prod(1 + y for _, y in v) - 1) * 100) for a, v in sorted(por_anio.items())))

    # ── C) filtro de la grilla ──
    print('\nC) LA PLANTILLA COMO FILTRO DE LA GRILLA · velas de 1 hora · escalón 2x (cuenta 72404) · abre ciclos solo si el papel pasaba al cierre anterior')
    import grilla5y as g
    import apertura_bajista as ab
    tot_a = tot_b = 0.0
    for tk, p, gn in ab.PAPELES:
        try:
            hb = cargar(tk, 'hourly')
        except Exception:
            print('   %-5s sin velas horarias' % tk); continue
        cd = cond.get(tk)
        if not cd:
            print('   %-5s sin diario suficiente' % tk); continue
        fs = sorted(cd)
        # permitido el día f si pasaba al cierre de la rueda anterior (plantilla sin RS
        # y con RS del universo)
        ok_dias = set()
        for k in range(1, len(fs)):
            ant = fs[k - 1]
            if tk in pasa.get(ant, {}): ok_dias.add(fs[k])
        dias_h = sorted({x[0] for x in hb})
        frac = sum(1 for d in dias_h if d in ok_dias) / len(dias_h)
        kw = dict(doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)
        a = g.grilla(hb, p * 2, gn * 2, None, **kw)
        b = g.grilla(hb, p * 2, gn * 2, None, permitido=ok_dias, **kw)
        tot_a += a['total']; tot_b += b['total']
        print('   %-5s pasa %3.0f%% de los días · sin filtro USD %+7.0f (vueltas %4d, peor abierto %6.0f) · con filtro USD %+7.0f (vueltas %4d, peor abierto %6.0f)' % (
            tk, frac * 100, a['total'], a['rondas'], a['peor_abierto'], b['total'], b['rondas'], b['peor_abierto']))
    print('   TOTAL sin filtro USD %+.0f · con filtro USD %+.0f  (lote USD %.0f, total = realizado + abierto al final)' % (tot_a, tot_b, g.LOTE))


if __name__ == '__main__':
    main()
