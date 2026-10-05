# -*- coding: utf-8 -*-
# Escalon por volatilidad (04/10/2026). mazda_miata (moltbook): "the design you
# have not tried is a volatility-scaled rung (k*ATR instead of a fixed
# percent)... if it is still an exposure dial, the improvement will track the
# name's average volatility rather than any path property, and will collapse
# when you stratify by volatility regime".
#
#  F  : paso fijo, el de hoy por papel.
#  Vm : paso = k × volatilidad diaria de las 20 ruedas previas, con k por papel
#       elegido para que el paso PROMEDIO sea igual al fijo (aisla el efecto de
#       condicionar, sin cambiar el paso medio).
#  V3 : paso = 0,30 × volatilidad, igual para todos.
#  Familia de pasos fijos (0,5x a 2x): la "perilla". Si Vm cae sobre la curva
#  resultado / peor momento de esa familia, es una perilla y no una señal.
#  Estratos: terciles de volatilidad de cada papel; resultado y capital cargado
#  de F y Vm en cada uno.
# Sin corte, refuerzo 50%. Horario (10/2023 a 09/2026) y diario 10 años.
import json, os, math
import grilla5y as g

AQUI = os.path.dirname(os.path.abspath(__file__))
P = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
     ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005)]
MULT = [0.5, 0.75, 1.0, 1.5, 2.0]


def diario(tk):
    return [tuple(r) for r in json.load(open(os.path.join(AQUI, 'd10', tk + '.json'))) if r[1] and r[2] and r[3] and r[4]]


def sigma20(tk):
    d = diario(tk)
    r = [math.log(b[4] / a[4]) for a, b in zip(d, d[1:])]
    out = {}
    for i in range(21, len(d)):
        v = r[i - 21:i - 1]                      # 20 retornos que terminan el dia ANTERIOR
        out[d[i][0]] = math.sqrt(sum(x * x for x in v) / len(v))
    return out


def corre(bars, paso, gan, din=None):
    r = g.grilla(bars, paso, gan, None, doble=2.0, frac=0.5, dinamico=din)
    return r


def spearman(x, y):
    def rk(v):
        o = sorted(range(len(v)), key=lambda i: v[i]); r = [0] * len(v)
        for p, i in enumerate(o): r[i] = p
        return r
    a, b = rk(x), rk(y); n = len(x)
    return 1 - 6 * sum((p - q) ** 2 for p, q in zip(a, b)) / (n * (n * n - 1))


def estudio(nombre, cargar):
    print('\n' + '=' * 110 + '\n' + nombre)
    tot = {}; filas = []; estr = {t: dict(F=[0.0, 0.0, 0], V=[0.0, 0.0, 0]) for t in (0, 1, 2)}
    for tk, p, gn in P:
        bars = cargar(tk)
        sg = sigma20(tk)
        fechas = sorted({b[0] for b in bars})
        con = [f for f in fechas if f in sg]
        media = sum(sg[f] for f in con) / len(con)
        k = p / media
        clip = lambda x: min(0.05, max(0.003, x))
        din_m = {f: (clip(k * sg[f]), clip(k * sg[f]) * gn / p) for f in con}
        din_3 = {f: (clip(0.30 * sg[f]), clip(0.30 * sg[f]) * 0.7) for f in con}
        R = {'F': corre(bars, p, gn), 'Vm': corre(bars, p, gn, din_m), 'V3': corre(bars, p, gn, din_3)}
        for m in MULT:
            R['x%.2f' % m] = corre(bars, p * m, gn * m)
        for kk, r in R.items():
            t = tot.setdefault(kk, dict(total=0.0, peor=0.0, rondas=0, cap=0.0, eq=None))
            t['total'] += r['total']; t['peor'] += r['peor_abierto']; t['rondas'] += r['rondas']; t['cap'] += sum(r['s_cap']) / len(r['s_cap'])
        filas.append((tk, 100 * media, k, R['F']['total'], R['F']['peor_abierto'], R['Vm']['total'], R['Vm']['peor_abierto'], R['F']['rondas'], R['Vm']['rondas']))
        # estratos por tercil de volatilidad del papel
        vs = sorted(sg[f] for f in con); c1, c2 = vs[len(vs) // 3], vs[2 * len(vs) // 3]
        for clave, r in (('F', R['F']), ('V', R['Vm'])):
            eq, cap = r['eq'], r['s_cap']
            for i, b in enumerate(bars):
                if b[0] not in sg or i == 0: continue
                t = 0 if sg[b[0]] < c1 else 1 if sg[b[0]] < c2 else 2
                e = estr[t][clave]; e[0] += eq[i] - eq[i - 1]; e[1] += cap[i]; e[2] += 1
    print('   %-26s %10s %12s %12s %9s %14s %16s' % ('variante (suma 9 papeles)', 'resultado', 'suma peores', 'result/peor', 'vueltas', 'capital medio', 'result/cap.medio'))
    nom = {'F': 'paso fijo (hoy)', 'Vm': 'por volatilidad, paso medio igual', 'V3': 'por volatilidad, k=0,30'}
    for kk in ['F', 'Vm', 'V3'] + ['x%.2f' % m for m in MULT]:
        t = tot[kk]
        print('   %-34s %8.0f %12.0f %12.2f %9d %14.0f %15.1f%%' % (nom.get(kk, 'fijo ' + kk[1:] + ' veces el paso'), t['total'], t['peor'], t['total'] / -t['peor'], t['rondas'], t['cap'], 100 * t['total'] / t['cap']))
    # donde cae Vm respecto de la curva de la perilla (interpolando por peor momento)
    fam = sorted((tot['x%.2f' % m]['peor'], tot['x%.2f' % m]['total']) for m in MULT)
    for kk in ('Vm', 'V3'):
        x = tot[kk]['peor']; esp = None
        for (x0, y0), (x1, y1) in zip(fam, fam[1:]):
            if x0 <= x <= x1:
                esp = y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        print('   %s: resultado %.0f · la familia de pasos fijos con el MISMO peor momento da %s → diferencia %s' % (
            nom[kk], tot[kk]['total'], '%.0f' % esp if esp is not None else '(fuera de rango)', '%+.0f (%+.1f%%)' % (tot[kk]['total'] - esp, 100 * (tot[kk]['total'] - esp) / abs(esp)) if esp is not None else '—'))
    print('\n   Por papel (paso medio igual): %-6s %9s %7s | %9s %9s | %9s %9s | %9s' % ('', 'vol.dia', 'k', 'F result', 'F peor', 'Vm result', 'Vm peor', 'mejora r/p'))
    mej = []; vols = []
    for tk, v, k, ft, fp, vt, vp, fr, vr in filas:
        a = ft / -fp if fp < 0 else 0; b = vt / -vp if vp < 0 else 0
        mej.append(b - a); vols.append(v)
        print('   %-36s %8.2f%% %7.2f | %9.0f %9.0f | %9.0f %9.0f | %+9.2f   (vueltas %d → %d)' % (tk, v, k, ft, fp, vt, vp, b - a, fr, vr))
    print('   Mejora en resultado/peor: %d de 9 papeles · correlacion de rangos entre la mejora y la volatilidad media del papel: %+.2f' % (sum(1 for m in mej if m > 0), spearman(mej, vols)))
    print('\n   Por regimen de volatilidad (terciles de cada papel): resultado y resultado por capital cargado')
    print('   %-12s %12s %12s %16s %16s' % ('regimen', 'F', 'Vm', 'F / cap.cargado', 'Vm / cap.cargado'))
    for t, n in ((0, 'vol. baja'), (1, 'vol. media'), (2, 'vol. alta')):
        f, v = estr[t]['F'], estr[t]['V']
        print('   %-12s %12.0f %12.0f %15.2f%% %15.2f%%' % (n, f[0], v[0], 100 * f[0] / (f[1] / f[2]) if f[1] else 0, 100 * v[0] / (v[1] / v[2]) if v[1] else 0))


if __name__ == '__main__':
    estudio('HORARIO · 10/2023 a 09/2026 (SNDK desde 02/2025) · USD, lote 460', lambda tk: g.cargar(tk, 'hourly'))
    estudio('DIARIO · 10 años (SNDK desde 02/2025) · USD, lote 460', lambda tk: [r for r in diario(tk)][-2500:])
