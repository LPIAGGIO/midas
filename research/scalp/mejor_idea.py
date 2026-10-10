# -*- coding: utf-8 -*-
# "En simulación, ¿qué es lo que mejor mide? ¿Cuál sería la mejor idea?" (LP 09/10/2026).
# Todas las perillas juntas, sobre los 10 papeles del scalp, misma grilla que corre
# (sin corte, refuerzo 50% al doble de profundidad, lateral):
#   escalón     1x / 1,5x / 2x  (1x = el de la 72404 por papel)
#   horario     A desde la apertura / B desde las 12 / G desde la apertura si abre 1% abajo
#   cierre      nada / vende lo verde y reentra al precio / vende lo verde y reentra un escalón abajo
# Velas de 1 hora (2 años) y de 5 minutos (60 días). USD, lote 460.
# Medidas: resultado (realizado + abierto al final), resultado por 1000 de capital
# medio por día, y el peor abierto (suma por papel: lo peor que estuvo en rojo).
import itertools, statistics as st
import grilla5y as g
import apertura_bajista as ab
import candidato as cd

PAPELES = ab.PAPELES
ESC = (1.0, 1.5, 2.0)
HOR = (('A', 0.0), ('B', 0.0), ('G', 0.01))
CIE = (('nada', None, 0), ('verde, al precio', 'papel', 0), ('verde, 1 escalón abajo', 'papel', -1))


def velas(tk, serie):
    if serie == '5m':
        return ab.velas(tk, '5m')
    v = cd.yahoo(tk, '1h', '730d')
    return [x for x in v if 1030 <= x[1] < 1700]


def main():
    datos = {s: {tk: velas(tk, s) for tk, _, _ in PAPELES} for s in ('1h', '5m')}
    for serie in ('1h', '5m'):
        esp, lat, por_dia = (0, 1, 7) if serie == '1h' else (4, 12, 78)
        d0 = datos[serie]['MU']
        print('\n== velas %s · %s a %s · 10 papeles · USD' % (serie, d0[0][0], d0[-1][0]))
        print('   %-5s %-4s %-24s %10s %10s %13s %12s' % ('esc', 'hora', 'cierre', 'resultado', 'realizado', 'por 1000/día', 'peor abierto'))
        filas = []
        for (e, (h, x), (cn, cg, cr)) in itertools.product(ESC, HOR, CIE):
            tot = real = peor = 0.0; caps = []; dias = 0
            for tk, p, gn in PAPELES:
                v = datos[serie][tk]
                nb = ab.nobuy_de(v, h, x)
                bars = [(f, o, hh, l, c) for f, hm, o, hh, l, c in v]
                r = g.grilla(bars, p * e, gn * e, None, doble=2.0, frac=0.5, espera_barras=esp,
                             lateral_barras=lat, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, nobuy=nb,
                             cierre_ganadores=cg, cierre_reent=(por_dia if cr else 0))
                tot += r['total']; real += r['real']; peor += r['peor_abierto']; caps.append(st.mean(r['s_cap'])); dias = max(dias, r['dias'])
            k = 1000 * tot / sum(caps) / dias
            filas.append((e, h, cn, tot, real, k, peor))
            print('   %-5s %-4s %-24s %+10.0f %+10.0f %13.2f %12.0f' % ('%.1fx' % e, h, cn, tot, real, k, peor))
        mejor = max(filas, key=lambda f: f[5])
        base = [f for f in filas if f[0] == 1.0 and f[1] == 'A' and f[2] == 'nada'][0]
        print('   mejor por capital: %.1fx · %s · %s (%.2f contra %.2f de 1x · A · nada)' % (mejor[0], mejor[1], mejor[2], mejor[5], base[5]))


if __name__ == '__main__':
    main()
