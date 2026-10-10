# -*- coding: utf-8 -*-
# Variante de la reentrada después de vender lo verde (LP 10/10/2026): la compra
# queda un escalón abajo del precio de venta, pero si el papel sube X% desde la
# apertura del día, entra al precio en ese momento en vez de esperar al cierre.
# Grilla de la 3893 (2x, regla G, vende lo verde 16:45) sobre los 10 papeles.
#   python reentrada_sube.py
import statistics as st
import grilla5y as g
import apertura_bajista as ab
import candidato as cd
import horario_cierre as hc
PAPELES = ab.PAPELES


def corre(serie, reent_sube, al_precio=False):
    esp, lat, por_dia, H = (4, 12, 78, 1645) if serie == '5m' else (0, 1, 7, None)
    tot = real = peor = 0.0; caps = []; dias = 0; sube = 0
    for tk, p, gn in PAPELES:
        v = [x[:6] for x in hc.con_volumen(tk)] if serie == '5m' else [x for x in cd.yahoo(tk, '1h', '730d') if 1030 <= x[1] < 1700]
        nb = ab.nobuy_de(v, 'G', 0.01)
        idx = set()
        if H:
            visto = set()
            for i, x in enumerate(v):
                if x[1] >= H and x[0] not in visto:
                    visto.add(x[0]); idx.add(i)
        bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
        r = g.grilla(bars, p * 2, gn * 2, None, doble=2.0, frac=0.5, espera_barras=esp, lateral_barras=lat,
                     lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, nobuy=nb, cierre_ganadores='papel',
                     cierre_reent=(0 if al_precio else por_dia), cierre_en=(idx or None), reent_sube=reent_sube)
        tot += r['total']; real += r['real']; peor += r['peor_abierto']; caps.append(st.mean(r['s_cap'])); dias = max(dias, r['dias'])
        sube += r['s_lot'] and 0 or 0
    return tot, real, 1000 * tot / sum(caps) / dias, peor


def main():
    for serie in ('5m', '1h'):
        print('\n== velas %s · 3893: escalón 2x, regla G, vende lo verde%s' % (serie, ' 16:45' if serie == '5m' else ' al cierre'))
        print('   %-44s %10s %10s %13s %12s' % ('reentrada después de vender lo verde', 'resultado', 'realizado', 'por 1000/día', 'peor abierto'))
        for nombre, rs, ap in [('al precio de apertura (sin esperar)', 0.0, True),
                               ('un escalón abajo; si no, al cierre (ACTUAL)', 0.0, False),
                               ('un escalón abajo; si sube 0,5% desde la apertura, entra', 0.005, False),
                               ('un escalón abajo; si sube 1% desde la apertura, entra', 0.01, False),
                               ('un escalón abajo; si sube 1,5% desde la apertura, entra', 0.015, False),
                               ('un escalón abajo; si sube 2% desde la apertura, entra', 0.02, False)]:
            tot, real, k, peor = corre(serie, rs, ap)
            print('   %-44s %+10.0f %+10.0f %13.2f %12.0f' % (nombre, tot, real, k, peor))


if __name__ == '__main__':
    main()
