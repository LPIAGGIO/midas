# -*- coding: utf-8 -*-
# Control de B: ¿la ganancia es de la plantilla o solo de la fuerza relativa?
#   P10 = plantilla + RS, top 10 por RS (lo de minervini.py)
#   R10 = top 10 por RS SIN plantilla (momentum puro)
#   PT  = todos los que pasan la plantilla, equiponderados
import math, statistics as st, bisect
import minervini as m
datos = m.preparar()
cond = {tk: m.condiciones(b) for tk, b in datos.items()}
idx = {tk: {x[0]: i for i, x in enumerate(b)} for tk, b in datos.items()}
fechas = sorted({f for cd in cond.values() for f in cd})
rsd = {}
for f in fechas:
    moms = [(tk, cd[f][1]) for tk, cd in cond.items() if f in cd]
    if len(moms) < 50: continue
    o = sorted(x for _, x in moms); n = len(o)
    rsd[f] = {tk: (bisect.bisect_left(o, x) / (n - 1) * 100, cond[tk][f][0]) for tk, x in moms}
fechas = sorted(rsd)
fin = [f for k, f in enumerate(fechas) if k + 1 == len(fechas) or fechas[k + 1][:7] != f[:7]]
def r_tk(tk, a, z):
    i, j = idx[tk].get(a), idx[tk].get(z)
    if i is None or j is None or i + 1 >= len(datos[tk]): return None
    return datos[tk][j][4] / datos[tk][i + 1][1] - 1
reglas = {
    'P10 plantilla+RS top10': lambda d: [t for t, _ in sorted(((t, v[0]) for t, v in d.items() if v[1] and v[0] >= 70), key=lambda x: -x[1])[:10]],
    'R10 solo RS top10     ': lambda d: [t for t, _ in sorted(((t, v[0]) for t, v in d.items()), key=lambda x: -x[1])[:10]],
    'PT  plantilla, todos  ': lambda d: [t for t, v in d.items() if v[1] and v[0] >= 70],
    'U   universo          ': lambda d: list(d),
}
for nom, f in reglas.items():
    prev, xs = set(), []
    for a, z in zip(fin, fin[1:]):
        sel = f(rsd[a]); rs = [r for r in (r_tk(t, a, z) for t in sel) if r is not None]
        rot = len(set(sel) ^ prev) / max(len(sel) + len(prev), 1); prev = set(sel)
        xs.append((st.mean(rs) if rs else 0) - rot * m.FEE_RT)
    acc, pico, dd = 1.0, 1.0, 0.0
    for x in xs:
        acc *= 1 + x; pico = max(pico, acc); dd = min(dd, acc / pico - 1)
    h = len(xs) // 2
    sh = lambda v: st.mean(v) / st.pstdev(v) * math.sqrt(12)
    print('%s  %+.2f%%/mes · Sharpe %.2f · peor caída %.0f%% · 1ra mitad %+.2f%%/mes · 2da mitad %+.2f%%/mes' % (
        nom, st.mean(xs) * 100, sh(xs), dd * 100, st.mean(xs[:h]) * 100, st.mean(xs[h:]) * 100))
