# -*- coding: utf-8 -*-
# Dos cuentas con el mismo bot: ¿conviene desfasarlas? (LP 02/10/2026).
# Se compara la cuenta A (configuracion actual) sumada a una cuenta B que:
#   igual      : es identica a A (lo que corre hoy)
#   caida      : abre cada ciclo recien cuando el precio cae medio escalon / un escalon
#   espera     : espera mas tiempo a que el precio vuelva antes de perseguirlo
#   ancha      : usa escalones y ganancia 1,5 veces mas grandes
#   angosta    : usa escalones y ganancia 0,7 veces
# Sin corte, con refuerzo de 50%. Capital base 2.300 USD por papel y por cuenta.
# Metricas de la SUMA de las dos cuentas: resultado, peor momento abierto y
# porcentaje de velas con las dos cargadas (4 o mas escalones cada una).
import json, os, sys, time
import grilla5y as g
PAPELES = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
           ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005)]


def barras5m(tk):
    rows = json.load(open('%s_5m.json' % tk.lower()))
    out = []
    for t, o, h, l, c, v in rows:
        lt = time.gmtime(t - 3 * 3600)
        hm = lt.tm_hour * 100 + lt.tm_min
        if 1035 <= hm < 1645:
            out.append((time.strftime('%Y-%m-%d', lt), o, h, l, c))
    return out


def correr(serie):
    ESP = 4 if serie == '5m' else 0          # 20 minutos en velas de 5; en horarias, la vela misma
    VAR = [
        ('igual (hoy)', lambda p, gn: dict(paso=p, gan=gn, espera_barras=ESP)),
        ('caida de medio escalon', lambda p, gn: dict(paso=p, gan=gn, espera_barras=ESP, entrada_off=p / 2)),
        ('caida de un escalon', lambda p, gn: dict(paso=p, gan=gn, espera_barras=ESP, entrada_off=p)),
        ('espera el triple', lambda p, gn: dict(paso=p, gan=gn, espera_barras=(12 if serie == '5m' else 3))),
        ('grilla 1,5x mas ancha', lambda p, gn: dict(paso=p * 1.5, gan=gn * 1.5, espera_barras=ESP)),
        ('grilla 0,7x mas angosta', lambda p, gn: dict(paso=p * 0.7, gan=gn * 0.7, espera_barras=ESP)),
    ]
    tot = {n: dict(sumaB=0.0, comb=0.0, peor=0.0, ambas=0, velas=0, vueltasB=0, pos=0) for n, _ in VAR}
    totA = 0.0
    dias = 0
    print('\n== velas %s · resultado en USD · A = cuenta actual · B = segunda cuenta' % serie)
    print('   %-6s %9s | ' % ('papel', 'A sola') + ' | '.join('%-22s' % n[:22] for n, _ in VAR))
    for tk, p, gn in PAPELES:
        try:
            bars = barras5m(tk) if serie == '5m' else g.cargar(tk, serie)
        except Exception as e:
            print('   %-6s sin datos (%s)' % (tk, e)); continue
        dias = max(dias, len({b[0] for b in bars}))
        A = g.grilla(bars, p, gn, None, doble=2.0, frac=0.5, espera_barras=ESP)
        totA += A['total']
        celdas = []
        for n, f in VAR:
            k = f(p, gn)
            B = g.grilla(bars, k.pop('paso'), k.pop('gan'), None, doble=2.0, frac=0.5, **k)
            comb_ab = [x + y for x, y in zip(A['s_ab'], B['s_ab'])]
            ambas = sum(1 for x, y in zip(A['s_lot'], B['s_lot']) if x >= 4 and y >= 4)
            t = tot[n]
            t['sumaB'] += B['total']; t['comb'] += A['total'] + B['total']; t['peor'] += min(comb_ab); t['ambas'] += ambas; t['velas'] += len(comb_ab); t['vueltasB'] += B['rondas']
            t['pos'] += 1 if B['total'] > A['total'] else 0
            celdas.append('B %+6.0f peor A+B %6.0f' % (B['total'], min(comb_ab)))
        print('   %-6s %+9.0f | ' % (tk, A['total']) + ' | '.join('%-22s' % c for c in celdas))
    print('\n   TOTAL de los 9 papeles (%d ruedas) · A sola %+.0f' % (dias, totA))
    print('   %-26s %10s %10s %12s %16s %12s %10s' % ('variante de B', 'B', 'A + B', 'por rueda', 'suma de peores', 'ambas carg.', 'B > A en'))
    for n, _ in VAR:
        t = tot[n]
        print('   %-26s %+10.0f %+10.0f %+12.1f %16.0f %11.1f%% %7d de 9' % (n, t['sumaB'], t['comb'], t['comb'] / dias, t['peor'], 100.0 * t['ambas'] / t['velas'], t['pos']))


if __name__ == '__main__':
    correr('5m')
    correr('hourly')
    correr('daily')
