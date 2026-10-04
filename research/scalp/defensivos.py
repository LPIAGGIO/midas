# -*- coding: utf-8 -*-
# Defensivos con disparador (LP 04/10/2026): "si viene un cisne negro y se hacen
# mierda los semis, mantener los malos holdeando y empezar a operar defensivos
# hasta que recuperen".
#
# Disparador: SMH cae X% desde su maximo de 252 ruedas → se prenden grillas en
# 5 defensivos con plata nueva. Se apagan (y se valuan al cierre) cuando SMH
# vuelve a estar a menos de 5% de su maximo. Los 5 defensivos se eligen EL DIA
# DEL DISPARO: los liquidos menos atados a SMH en las 504 ruedas anteriores.
# Historia real de 10 años (d10/, diario, USD), no sorteos: son pocos episodios
# y conviene verlos uno por uno.
#
# Comparaciones con la misma plata nueva durante la misma ventana:
#   - grillas nuevas en 5 semis (MU NVDA AMD INTC SNDK/WDC), ancladas al precio caido
#   - grillas en los defensivos SIEMPRE prendidas (para ver si el disparador suma)
import json, os, math
import grilla5y as g

AQUI = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(AQUI, 'd10')
SEMIS = [('MU', 0.01, 0.007), ('NVDA', 0.01, 0.007), ('AMD', 0.01, 0.007), ('INTC', 0.01, 0.007), ('SNDK', 0.015, 0.01)]
FIJOS = [(tk, 0.005, 0.0035) for tk in ('KO', 'PEP', 'MCD', 'WMT', 'JNJ')]      # defensivos de manual, sin elegir con datos
EXCLUIR = {'AMDD', 'QQQD', 'SPXL', 'TQQQ', 'VXX', 'ETHA', 'IBIT', 'SPCX', 'GGAL', 'ELPC', 'SMH', 'SPY', 'QQQ', 'XLK', 'ARKK', 'CIBR'}
CAP = g.LOTE * g.NIV * 1.5 * 5          # 5 papeles, 5 lotes + refuerzo


def corr(x, y):
    n = len(x); mx = sum(x) / n; my = sum(y) / n
    sx = math.sqrt(sum((a - mx) ** 2 for a in x)); sy = math.sqrt(sum((b - my) ** 2 for b in y))
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / (sx * sy) if sx and sy else 0.0


def main():
    S = {f[:-5]: {r[0]: (r[1], r[2], r[3], r[4]) for r in json.load(open(os.path.join(D, f))) if r[1] and r[2] and r[3] and r[4]} for f in os.listdir(D)}
    cal = sorted(S['SMH'])
    idx = {d: i for i, d in enumerate(cal)}
    ini = min(S['SNDK']); k = S['SNDK'][ini][3] / S['WDC'][ini][3]
    for d in cal:
        if d < ini and d in S['WDC']:
            S['SNDK'][d] = tuple(v * k for v in S['WDC'][d])
    liq = {r['symbol'] for r in json.load(open(os.path.join(AQUI, 'data912-cedears.json')))
           if r.get('c') and r.get('px_bid') and r.get('px_ask') and (r.get('v') or 0) * r['c'] >= 30e6 and r['px_ask'] / r['px_bid'] - 1 <= 0.012}
    semis = {s[0] for s in SEMIS}

    def rets(tk, dias):
        s = S[tk]
        return [math.log(s[d][3] / s[cal[idx[d] - 1]][3]) for d in dias]

    def elegir(fecha):
        """Los 5 liquidos menos atados a SMH en las 504 ruedas previas a la fecha."""
        i = idx[fecha]
        prev = cal[i - 504:i]
        x = rets('SMH', prev)
        c = []
        for tk in S:
            if tk in EXCLUIR or tk in semis or tk not in liq:
                continue
            if all(d in S[tk] for d in cal[i - 505:i]):
                y = rets(tk, prev)
                c.append((corr(x, y), tk, math.sqrt(sum(v * v for v in y) / len(y) * 252)))
        c.sort()
        return [(tk, v) for _, tk, v in c[:5]]

    def paso(v):
        return (0.015, 0.01) if v > 0.55 else (0.01, 0.007) if v > 0.30 else (0.007, 0.005) if v > 0.20 else (0.005, 0.0035)

    def corre(tk, dias, p, gn):
        dias = [d for d in dias if d in S[tk]]
        bars = [(d,) + S[tk][d] for d in dias]
        r = g.grilla(bars, p, gn, None, doble=2.0, frac=0.5)
        return r['eq'], r['rondas']

    def cartera(papeles, dias):
        eqs = []; v = 0
        for tk, p, gn in papeles:
            e, n = corre(tk, dias, p, gn)
            eqs.append(e); v += n
        m = min(len(e) for e in eqs)
        tot = [sum(e[i] for e in eqs) for i in range(m)]
        return 100 * tot[-1] / CAP, 100 * min(min(tot), 0) / CAP, v

    close = {d: S['SMH'][d][3] for d in cal}

    def episodios(x_on, x_off=0.05):
        out = []; on = None
        for i in range(520, len(cal)):
            d = cal[i]
            mx = max(close[e] for e in cal[i - 252:i + 1])
            dd = close[d] / mx - 1
            if on is None and dd <= -x_on:
                on = i
            elif on is not None and dd >= -x_off:
                out.append((on, i)); on = None
        if on is not None:
            out.append((on, len(cal) - 1))
        return out

    for x_on in (0.10, 0.15, 0.20):
        eps = episodios(x_on)
        print('\n=== DISPARADOR: SMH %d%% abajo de su maximo de un año · se apaga al volver a −5%% · %d episodios desde %s' % (x_on * 100, len(eps), cal[520]))
        print('   %-23s %6s %9s | %-28s %8s %8s %7s | %8s %8s' % ('episodio', 'ruedas', 'SMH peor', 'defensivos elegidos', 'result.', 'peor', 'vueltas', 'semis', 'peor'))
        tot_d = tot_s = dias_on = tot_f = 0.0; peor_f = 0.0
        peor_d = peor_s = 0.0
        for a, b in eps:
            dias = cal[a:b + 1]
            sel = elegir(cal[a])
            rd, pd, vd = cartera([(tk,) + paso(v) for tk, v in sel], dias)
            rs, ps, vs = cartera(SEMIS, dias)
            rf, pf, vf = cartera(FIJOS, dias); tot_f += rf; peor_f = min(peor_f, pf)
            smh_peor = 100 * (min(close[d] for d in dias) / close[cal[a]] - 1)
            print('   %s a %s %6d %8.0f%% | %-28s %7.1f%% %7.1f%% %7d | %7.1f%% %7.1f%%' % (cal[a], cal[b], len(dias), smh_peor, ' '.join(tk for tk, _ in sel), rd, pd, vd, rs, ps) + ' | KO PEP MCD WMT JNJ %6.1f%% %6.1f%%' % (rf, pf))
            tot_d += rd; tot_s += rs; dias_on += len(dias); peor_d = min(peor_d, pd); peor_s = min(peor_s, ps)
        if eps:
            print('   SUMA de los episodios: %d ruedas prendido (%.0f%% del tiempo) · defensivos %+.1f%% (%.1f%% anual mientras esta prendido, peor momento %.1f%%) · semis nuevos %+.1f%% (%.1f%% anual, peor momento %.1f%%)' % (
                dias_on, 100 * dias_on / (len(cal) - 520), tot_d, tot_d * 252 / dias_on, peor_d, tot_s, tot_s * 252 / dias_on, peor_s) + ' · KO PEP MCD WMT JNJ %+.1f%% (%.1f%% anual, peor momento %.1f%%)' % (tot_f, tot_f * 252 / dias_on, peor_f))

    # Defensivos siempre prendidos: se eligen de nuevo cada 252 ruedas y se valuan al cierre de cada tramo.
    print('\n=== DEFENSIVOS SIEMPRE PRENDIDOS (se reeligen cada 252 ruedas)')
    tot = 0.0; n = 0; peor = 0.0
    i = 520
    while i < len(cal) - 20:
        j = min(i + 252, len(cal) - 1)
        sel = elegir(cal[i])
        r, p, v = cartera([(tk,) + paso(vv) for tk, vv in sel], cal[i:j + 1])
        smh = 100 * (close[cal[j]] / close[cal[i]] - 1)
        print('   %s a %s · SMH %+4.0f%% · %-28s %7.1f%% · peor %6.1f%% · %d vueltas' % (cal[i], cal[j], smh, ' '.join(tk for tk, _ in sel), r, p, v))
        tot += r; n += 1; peor = min(peor, p); i = j
    print('   PROMEDIO %.1f%% anual · peor momento %.1f%%' % (tot / n, peor))


if __name__ == '__main__':
    main()
