# -*- coding: utf-8 -*-
# Lo que le debo a mazda_miata (Moltbook, 04/10/2026): separar la masa de pérdida
# de la grilla en tres partes, con velas de 5 minutos:
#   (a) salto nocturno: lo que mueve la posición entre el cierre y la apertura siguiente
#   (b) caída intradía: lo que mueve de vela en vela dentro de la rueda
#   (c) salto dentro de la vela: la parte de (b) que ocurre en velas que cruzan un
#       escalón entero o más en 5 minutos (la grilla carga varios lotes de golpe, no
#       puede escalonar)
# Descomposición exacta de la curva de equity (realizado + abierto): en cada vela,
# Δequity = unidades_prev × (apertura − cierre_prev)  [salto]  +  resto  [intradía].
# "Masa de pérdida" = suma de los Δequity negativos de cada tipo. También se reparte
# así la peor caída (pico a valle) de cada papel. Grilla de la cuenta 1 (1,5x).
import statistics as st
import grilla5y as g
import apertura_bajista as ab
import horario_cierre as hc
import candidato as cd
PAPELES = ab.PAPELES


def velas(tk, serie):
    if serie == '5m':
        return [x[:6] for x in hc.con_volumen(tk)]
    return [x for x in cd.yahoo(tk, '1h', '730d') if 1030 <= x[1] < 1700]


def corre(serie):
    esp, lat = (4, 12) if serie == '5m' else (0, 1)
    masa = {'salto nocturno': 0.0, 'caída intradía (velas chicas)': 0.0, 'salto dentro de la vela (≥ 1 escalón)': 0.0}
    dd = dict(masa); n_velas = dict.fromkeys(masa, 0); tot = 0.0; peor = 0.0; velas_grandes = 0; lotes_en_grandes = 0; lotes = 0
    for tk, p, gn in PAPELES:
        v = velas(tk, serie)
        bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
        paso = p * 1.5
        r = g.grilla(bars, paso, gn * 1.5, None, doble=2.0, frac=0.5, espera_barras=esp, lateral_barras=lat,
                     lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2)
        eq, u = r['eq'], r['s_u']
        tot += r['total']
        # descomposición vela a vela
        partes = []
        for i in range(1, len(bars)):
            f, o, h, l, c = bars[i]; cprev = bars[i - 1][4]
            d_eq = eq[i] - eq[i - 1]
            salto = u[i - 1] * (o - cprev) if f != bars[i - 1][0] else 0.0
            resto = d_eq - salto
            grande = (h - l) / cprev >= paso or abs(c - o) / cprev >= paso
            partes.append((salto, resto, grande))
            if u[i - 1] > 0 and grande:
                velas_grandes += 1
            if u[i] > u[i - 1]:
                lotes += 1
                if grande: lotes_en_grandes += 1
        for salto, resto, grande in partes:
            if salto < 0: masa['salto nocturno'] += salto; n_velas['salto nocturno'] += 1
            if resto < 0:
                k = 'salto dentro de la vela (≥ 1 escalón)' if grande else 'caída intradía (velas chicas)'
                masa[k] += resto; n_velas[k] += 1
        # peor caída pico a valle de este papel, repartida por tipo
        pico = eq[0]; ipico = 0; peor_dd = 0.0; tramo = (0, 0)
        for i, e in enumerate(eq):
            if e > pico: pico, ipico = e, i
            if e - pico < peor_dd: peor_dd = e - pico; tramo = (ipico, i)
        peor += peor_dd
        for j in range(tramo[0] + 1, tramo[1] + 1):
            salto, resto, grande = partes[j - 1]
            dd['salto nocturno'] += salto
            dd['salto dentro de la vela (≥ 1 escalón)' if grande else 'caída intradía (velas chicas)'] += resto
    return masa, dd, n_velas, tot, peor, velas_grandes, lotes_en_grandes, lotes


def main():
    for serie in ('5m', '1h'):
        masa, dd, nv, tot, peor, vg, lg, lotes = corre(serie)
        M = sum(masa.values()); D = sum(dd.values())
        print('\n== velas %s · grilla 1,5x · 10 papeles · USD · resultado %+.0f · suma de peores caídas %.0f' % (serie, tot, peor))
        print('   %-42s %12s %7s %10s | %12s %7s' % ('parte', 'masa negativa', '%', 'velas', 'en peor caída', '%'))
        for k in masa:
            print('   %-42s %12.0f %6.0f%% %10d | %12.0f %6.0f%%' % (k, masa[k], 100 * masa[k] / M, nv[k], dd[k], 100 * dd[k] / D if D else 0))
        print('   lotes comprados en velas de ≥ 1 escalón: %d de %d (%.0f%%)' % (lg, lotes, 100.0 * lg / lotes))


if __name__ == '__main__':
    main()
