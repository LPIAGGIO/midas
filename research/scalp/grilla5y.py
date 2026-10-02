# -*- coding: utf-8 -*-
# Grilla del scalp sobre 5 años de velas (LP 01/10/2026: "si baja mucho, hay
# que quedarse holdeando hasta que recupere"). Compara el corte actual contra
# cortes mas anchos y contra holdear sin limite.
#
# Simulacion por CAMINO de precios: cada vela se recorre apertura → minimo →
# maximo → cierre (o al reves si la vela es bajista) y las ordenes se ejecutan
# al cruzar su precio. El salto entre un cierre y la apertura siguiente ejecuta
# todo lo cruzado AL PRECIO DE APERTURA (compras mas baratas, cortes mas caros).
# Lote de monto fijo en dolares. Comision 0,0605% por punta (tarifa swing).
import json, sys, time, os, statistics as st
B = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'backtest-5y', 'data')
FEE = 0.0005 * 1.21
LOTE = 460.0            # USD por lote (≈ 2 CEDEARs de MU hoy); 5 lotes = USD 2.300
NIV = 5


def cargar(tk, serie):
    j = json.load(open(os.path.join(B, serie, tk + '.json')))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    out = []
    for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if o and h and l and c:
            out.append((time.strftime('%Y-%m-%d', time.gmtime(t - 4 * 3600)), o, h, l, c))
    return out


_ccl = {}
_ccl_k = []


def ccl(fecha):
    global _ccl_k
    if not _ccl:
        for r in json.load(open(os.path.join(B, 'ccl.json')))['data']:
            _ccl[r['fecha']] = r['venta']
        _ccl_k = sorted(_ccl)
    if fecha in _ccl:
        return _ccl[fecha]
    import bisect
    i = bisect.bisect_right(_ccl_k, fecha) - 1
    return _ccl[_ccl_k[max(i, 0)]]


def grilla(bars, paso, gan, corte, en_pesos=False, cierre_vende=False, permitido=None, doble=None, frac=1.0):
    """corte=None → holdea sin limite. Devuelve metricas en USD."""
    # doble: con la grilla llena, si el precio cae a ancla*(1 - doble*profundidad) compra
    # OTRA VEZ la misma cantidad que tiene y pasa a salir todo junto en promedio + gan.
    X = 99
    # permitido: fechas en las que se puede ABRIR un ciclo nuevo (None = siempre)
    E = dict(ancla=None, reent=None, parado=None, real=0.0, rondas=0, cortes=0, perd=0.0, fx=1.0, ok=True, capmax=LOTE * NIV)
    lots = {}          # k -> (precio, unidades, costo_usd)
    por_anio = {}

    def comprar(k, px):
        lots[k] = (px, LOTE * E['fx'] / px, LOTE)
        if E['ancla'] is None:
            E['ancla'] = px

    def vender(k, px, fecha):
        co, u, cusd = lots.pop(k)
        ing = u * px / E['fx']
        g = ing - cusd - FEE * (ing + cusd)
        E['real'] += g
        E['rondas'] += 1
        por_anio[fecha[:4]] = por_anio.get(fecha[:4], 0) + g
        return g

    def mover(p0, p1, fecha, salto):
        pos = p0
        if p1 < p0:
            while True:
                if E['parado'] == fecha:
                    return
                cand = []
                if E['ancla'] is None:
                    if E['ok'] and E['reent'] is not None and E['reent'] >= p1:
                        cand.append((min(E['reent'], pos), 'r', 0))
                else:
                    h = max((k for k in lots if k != X), default=-1)
                    if doble is not None and h == NIV - 1 and X not in lots:
                        px = E['ancla'] * (1 - doble * paso * (NIV - 1))
                        if px >= p1:
                            cand.append((min(px, pos), 'x', X))
                    if h + 1 < NIV:
                        px = E['ancla'] * (1 - paso * (h + 1))
                        if px >= p1:
                            cand.append((min(px, pos), 'b', h + 1))
                    if corte is not None and lots:
                        px = E['ancla'] * (1 - corte)
                        if px >= p1:
                            cand.append((min(px, pos), 's', 0))
                if not cand:
                    return
                px, tipo, k = max(cand)
                ej = p1 if salto else px
                if tipo == 'r':
                    E['reent'] = None
                    comprar(0, ej)
                elif tipo == 'b':
                    comprar(k, ej)
                elif tipo == 'x':
                    u = frac * sum(v[1] for v in lots.values())   # frac=0.5: compra la mitad de lo que tiene
                    lots[X] = (ej, u, u * ej / E['fx'])
                    E['capmax'] = max(E['capmax'], sum(v[2] for v in lots.values()))
                else:
                    g = sum(vender(kk, ej, fecha) for kk in list(lots))
                    E['cortes'] += 1
                    E['perd'] += g
                    E['ancla'] = None
                    E['reent'] = None
                    E['parado'] = fecha
                    return
                pos = px
        else:
            while lots:
                if X in lots:
                    ut = sum(v[1] for v in lots.values())
                    obj = sum(v[0] * v[1] for v in lots.values()) / ut * (1 + gan)
                    if obj > p1:
                        return
                    for kk in list(lots):
                        vender(kk, p1 if salto else obj, fecha)
                    E['reent'] = E['ancla']
                    E['ancla'] = None
                    return
                k = min(lots, key=lambda kk: lots[kk][0])
                obj = lots[k][0] * (1 + gan)
                if obj > p1:
                    return
                vender(k, p1 if salto else obj, fecha)
                if not lots:
                    E['reent'] = E['ancla']
                    E['ancla'] = None

    eq = []
    cargado = racha = racha_max = 0
    peor_abierto = 0.0
    prev_c = None
    prev_f = None
    for i, (fecha, o, h, l, c) in enumerate(bars):
        if en_pesos:
            E['fx'] = ccl(fecha)
            o, h, l, c = o * E['fx'], h * E['fx'], l * E['fx'], c * E['fx']
        if E['parado'] is not None and E['parado'] != fecha:
            E['parado'] = None          # dia nuevo despues de un corte
        if prev_c is not None:
            mover(prev_c, o, fecha, True)
        E['ok'] = permitido is None or fecha in permitido
        if E['ok'] and E['ancla'] is None and E['parado'] is None and E['reent'] is None:
            comprar(0, o)               # arranque, o primera vela despues de un corte
        camino = [o, l, h, c] if c >= o else [o, h, l, c]
        for a, b in zip(camino, camino[1:]):
            mover(a, b, fecha, False)
        if E['ok'] and E['ancla'] is None and E['parado'] is None:
            E['reent'] = None
            comprar(0, c)               # no volvio al ancla: sigue al precio
        if cierre_vende and (i + 1 == len(bars) or bars[i + 1][0] != fecha):
            # ultima vela del dia: vende todo al cierre y mañana arranca de cero
            for kk in list(lots):
                vender(kk, c, fecha)
            E['ancla'] = None
            E['reent'] = None
            E['parado'] = fecha
        ab = sum(u * c / E['fx'] - cusd for (_, u, cusd) in lots.values())
        peor_abierto = min(peor_abierto, ab)
        eq.append(E['real'] + ab)
        if fecha != prev_f:
            if len(lots) >= NIV:
                cargado += 1
                racha += 1
                racha_max = max(racha_max, racha)
            else:
                racha = 0
        prev_c, prev_f = c, fecha
    pico = -1e18
    dd = 0
    for e in eq:
        pico = max(pico, e)
        dd = min(dd, e - pico)
    dias = len({b[0] for b in bars})
    return dict(total=eq[-1], real=E['real'], abierto=eq[-1] - E['real'], rondas=E['rondas'], cortes=E['cortes'], perd=E['perd'], dd=dd,
                capmax=E['capmax'], dobles=sum(1 for _ in [0]) * 0, peor_abierto=peor_abierto, cargado=100.0 * cargado / dias, racha=racha_max, dias=dias, anio=por_anio)


CORTES = [0.05, 0.075, 0.10, 0.15, 0.20, 0.30, None]
nom = lambda co: 'sin' if co is None else '%.1f%%' % (co * 100)


def tabla(tk, serie, paso, gan, en_pesos=False):
    bars = cargar(tk, serie)
    print('\n== %s · %s · %s a %s · paso %.1f%% ganancia %.1f%%%s · capital maximo USD %d' % (
        tk, 'diario' if serie == 'daily' else 'horario', bars[0][0], bars[-1][0], paso * 100, gan * 100,
        ' · EN PESOS (precio x CCL), resultado en USD' if en_pesos else '', LOTE * NIV))
    print('   corte     total USD  realizado   abierto  vueltas cortes  perd.cortes  peor caida  peor abierto  dias cargado  racha max')
    for co in CORTES:
        r = grilla(bars, paso, gan, co, en_pesos)
        print('   %-8s %10.0f %10.0f %9.0f %8d %6d %12.0f %11.0f %13.0f %11.0f%% %8d d' % (
            nom(co), r['total'], r['real'], r['abierto'], r['rondas'], r['cortes'], r['perd'], r['dd'], r['peor_abierto'], r['cargado'], r['racha']))
    return bars


if __name__ == '__main__':
    modo = sys.argv[1] if len(sys.argv) > 1 else 'mu'
    if modo == 'mu':
        tabla('MU', 'daily', 0.01, 0.007)
        tabla('MU', 'hourly', 0.01, 0.007)
        tabla('MU', 'daily', 0.01, 0.007, True)
        for serie in ('daily', 'hourly'):
            bb = cargar('MU', serie)
            print('== MU %s · VENDE TODO AL CIERRE de cada dia (como corrio el 01/10)' % serie)
            for co in (0.05, None):
                r = grilla(bb, 0.01, 0.007, co, cierre_vende=True)
                print('   corte %-5s total USD %+8.0f · vueltas %d · cortes %d · peor caida %.0f · por año: %s' % (nom(co), r['total'], r['rondas'], r['cortes'], r['dd'], '  '.join('%s %+.0f' % (a, v) for a, v in sorted(r['anio'].items()))))
        b = cargar('MU', 'daily')
        print('\n   por año (MU diario, USD realizados):')
        for co in (0.05, 0.15, None):
            r = grilla(b, 0.01, 0.007, co)
            print('   corte %-5s ' % nom(co) + '  '.join('%s: %+.0f' % (a, v) for a, v in sorted(r['anio'].items())) + '  · abierto al final %+.0f' % r['abierto'])
        print('   MU comprar y mantener con USD %d: %+.0f (de %.2f a %.2f)' % (LOTE * NIV, LOTE * NIV * (b[-1][4] / b[0][1] - 1), b[0][1], b[-1][4]))
    elif modo == 'sndk':
        tabla('SNDK', 'daily', 0.015, 0.01)
        tabla('SNDK', 'hourly', 0.015, 0.01)
    elif modo == 'universo':
        tks = sorted(f[:-5] for f in os.listdir(os.path.join(B, 'daily')) if f.endswith('.json'))
        print('== universo · diario 5 años · paso 1%% ganancia 0,7%% · USD sobre capital maximo de %d' % (LOTE * NIV))
        print('   %-6s %9s | %9s %9s %9s | %12s %10s %11s' % ('papel', 'papel %', 'corte 5%', 'corte 15%', 'sin corte', 'peor abierto', 'racha max', 'abierto fin'))
        res = []
        for tk in tks:
            try:
                b = cargar(tk, 'daily')
            except Exception:
                continue
            if len(b) < 1000:
                continue
            a, m, s = (grilla(b, 0.01, 0.007, co) for co in (0.05, 0.15, None))
            d = grilla(b, 0.01, 0.007, None, cierre_vende=True)
            res.append((tk, (b[-1][4] / b[0][1] - 1) * 100, a['total'], m['total'], s['total'], s['peor_abierto'], s['racha'], s['abierto'], d['total']))
        for r in sorted(res, key=lambda x: x[4]):
            print('   %-6s %+8.0f%% | %+9.0f %+9.0f %+9.0f | %12.0f %8d d %+11.0f | vende al cierre %+7.0f' % r)
        for i, n in ((2, 'corte 5%'), (3, 'corte 15%'), (4, 'sin corte'), (8, 'vende al cierre')):
            v = [r[i] for r in res]
            print('   %-15s mediana %+7.0f · promedio %+7.0f · peor %+7.0f · mejor %+7.0f · positivos %d/%d' % (
                n, st.median(v), sum(v) / len(v), min(v), max(v), sum(1 for x in v if x > 0), len(v)))
