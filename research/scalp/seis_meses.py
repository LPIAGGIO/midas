# -*- coding: utf-8 -*-
# "Calculemos los últimos 6 meses (o 1 año) de los papeles: escalones, volatilidad,
# cuántas veces entra y sale, cuántas vueltas da, y cuánto podríamos haber ganado
# con la decisión" (LP 11/10/2026).
# Velas de 1 hora, 10 papeles, regla G. Decisión: cuenta 1 = 2x sin vender lo verde;
# cuenta 2 = 2,5x vendiendo lo verde al cierre con reentrada un escalón abajo.
# USD con lote de 460; en pesos: × (1.000.000 / 460) con CCL constante (el bot opera
# lotes de ~$1M). Caución 24,6% all-in sobre el capital comprado, días corridos.
import datetime as dt, statistics as st
import grilla5y as g
import apertura_bajista as ab
import candidato as cd
PAPELES = ab.PAPELES
import sys
# python seis_meses.py [lote en millones] [--sin-caucion]   (LP 11/10: "lotes de 2 millones, sin caución")
LOTE_M = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else 1.0
CAUCION_TNA = 0.0 if '--sin-caucion' in sys.argv else 0.205 + (0.03 + 0.00365) * 1.21
A_PESOS = LOTE_M * 1_000_000 / g.LOTE
HOY = '2026-10-09'


def desde(meses):
    d = dt.date(2026, 10, 9)
    m = d.month - meses; y = d.year
    while m <= 0: m += 12; y -= 1
    return '%04d-%02d-%02d' % (y, m, d.day)


def velas(tk, d0):
    return [x for x in cd.yahoo(tk, '1h', '730d') if 1030 <= x[1] < 1700 and x[0] >= d0]


def vol(tk, d0):
    d = cd.diario(tk); ks = sorted(k for k in d if k >= d0)
    r = [d[ks[i]] / d[ks[i - 1]] - 1 for i in range(1, len(ks))]
    v = velas(tk, d0); rng = {}
    for f, hm, o, h, l, c in v:
        lo, hi = rng.get(f, (1e18, 0)); rng[f] = (min(lo, l), max(hi, h))
    return st.pstdev(r) * 100, st.mean((hi / lo - 1) * 100 for lo, hi in rng.values()), len(ks)


def corre(tk, p, gn, d0, esc, verde):
    v = velas(tk, d0)
    nb = ab.nobuy_de(v, 'G', 0.01)
    bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
    r = g.grilla(bars, p * esc, gn * esc, None, doble=2.0, frac=0.5, espera_barras=0, lateral_barras=1,
                 lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, nobuy=nb,
                 cierre_ganadores=('papel' if verde else None), cierre_reent=(7 if verde else 0))
    cm = st.mean(r['s_cap'])
    cau = cm * r['dias'] * 7 / 5 * CAUCION_TNA / 365
    return dict(tot=r['total'], real=r['real'], peor=r['peor_abierto'], vu=r['rondas'], ciclos=r['ciclos'], cap=cm, dias=r['dias'], cau=cau, neto=r['total'] - cau)


def main():
    for meses in (6, 12):
        d0 = desde(meses)
        print('\n' + '=' * 100)
        print('ÚLTIMOS %d MESES · desde %s · velas de 1 hora · regla G · pesos con lote de $%.0fM (CCL constante) · caución %.1f%%' % (meses, d0, LOTE_M, CAUCION_TNA * 100))
        # 1) papel por papel con la decisión
        for nombre, esc, verde in (('CUENTA 1 · escalón 2x · sin vender lo verde', 2.0, False), ('CUENTA 2 · escalón 2,5x · vende lo verde', 2.5, True)):
            print('\n-- %s' % nombre)
            print('   %-6s %7s %7s %6s %7s %8s %12s %11s %12s %12s %10s' % ('papel', 'vol/día', 'rango', 'ciclos', 'vueltas', 'vuel/mes', 'bruto $', 'caución $', 'neto $', 'peor abierto', 'cap.medio'))
            T = dict(tot=0, cau=0, neto=0, peor=0, vu=0, ciclos=0, cap=0)
            for tk, p, gn in PAPELES:
                sd, rng, nd = vol(tk, d0)
                r = corre(tk, p, gn, d0, esc, verde)
                for k in T: T[k] += r[k]
                print('   %-6s %6.1f%% %6.1f%% %6d %7d %8.1f %12.0f %11.0f %12.0f %12.0f %10.0f' % (
                    tk, sd, rng, r['ciclos'], r['vu'], r['vu'] / (r['dias'] / 21), r['tot'] * A_PESOS, r['cau'] * A_PESOS, r['neto'] * A_PESOS, r['peor'] * A_PESOS, r['cap'] * A_PESOS))
            nd = r['dias']
            print('   %-6s %7s %7s %6d %7d %8.1f %12.0f %11.0f %12.0f %12.0f %10.0f' % ('TOTAL', '', '', T['ciclos'], T['vu'], T['vu'] / (nd / 21), T['tot'] * A_PESOS, T['cau'] * A_PESOS, T['neto'] * A_PESOS, T['peor'] * A_PESOS, T['cap'] * A_PESOS))
            print('   por rueda: bruto %.0f · neto %.0f · ruedas %d' % (T['tot'] * A_PESOS / nd, T['neto'] * A_PESOS / nd, nd))
        # 2) barrido de escalones, los 10 papeles juntos
        print('\n-- barrido de escalones (10 papeles, pesos con lote de $1M)')
        print('   %-6s %-16s %12s %11s %12s %12s %8s %8s %10s' % ('esc.', 'cierre', 'bruto $', 'caución $', 'neto $', 'peor abierto', 'ciclos', 'vueltas', 'neto/rueda'))
        for verde in (False, True):
            for esc in (1.5, 2.0, 2.5, 3.0, 3.5):
                T = dict(tot=0, cau=0, neto=0, peor=0, vu=0, ciclos=0); nd = 0
                for tk, p, gn in PAPELES:
                    r = corre(tk, p, gn, d0, esc, verde)
                    for k in T: T[k] += r[k]
                    nd = r['dias']
                print('   %-6s %-16s %12.0f %11.0f %12.0f %12.0f %8d %8d %10.0f' % ('%.1fx' % esc, 'vende lo verde' if verde else 'sin vender', T['tot'] * A_PESOS, T['cau'] * A_PESOS, T['neto'] * A_PESOS, T['peor'] * A_PESOS, T['ciclos'], T['vu'], T['neto'] * A_PESOS / nd))


if __name__ == '__main__':
    main()
