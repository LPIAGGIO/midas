# -*- coding: utf-8 -*-
# "El escalón mínimo tiene que ser 1,5 y máximo 2... 2,5" (LP 11/10/2026).
# Escalón 1,5x / 2x / 2,5x / 3x del base de cada papel, regla G, dos cierres
# (sin vender lo verde = cuenta 1; vende lo verde y reentra un escalón abajo =
# 3893), 10 papeles. Novedad: columna NETO DE CAUCIÓN: el capital comprado es
# palanca y cuesta CAUCION_TNA anual (20,5% + 3% comisión + 0,365% derechos,
# con IVA) todos los días corridos, también mientras el lote espera.
import statistics as st
import grilla5y as g
import apertura_bajista as ab
import candidato as cd
import horario_cierre as hc
PAPELES = ab.PAPELES
CAUCION_TNA = 0.205 + (0.03 + 0.00365) * 1.21      # 24,6% all-in


def velas(tk, serie):
    if serie == '5m':
        return [x[:6] for x in hc.con_volumen(tk)]
    return [x for x in cd.yahoo(tk, '1h', '730d') if 1030 <= x[1] < 1700]


def corre(serie, esc, verde):
    esp, lat, por_dia, H = (4, 12, 78, 1645) if serie == '5m' else (0, 1, 7, None)
    tot = real = peor = 0.0; caps = []; dias = 0; vu = 0; cap_dias = 0.0
    for tk, p, gn in PAPELES:
        v = velas(tk, serie)
        nb = ab.nobuy_de(v, 'G', 0.01)
        idx = set()
        if H and verde:
            visto = set()
            for i, x in enumerate(v):
                if x[1] >= H and x[0] not in visto:
                    visto.add(x[0]); idx.add(i)
        bars = [(f, o, h, l, c) for f, hm, o, h, l, c in v]
        r = g.grilla(bars, p * esc, gn * esc, None, doble=2.0, frac=0.5, espera_barras=esp, lateral_barras=lat,
                     lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2, nobuy=nb,
                     cierre_ganadores=('papel' if verde else None), cierre_reent=(por_dia if verde else 0), cierre_en=(idx or None))
        tot += r['total']; real += r['real']; peor += r['peor_abierto']; vu += r['rondas']
        cm = st.mean(r['s_cap']); caps.append(cm); dias = max(dias, r['dias'])
        # capital parado: promedio del capital comprado × días corridos del período (ruedas × 7/5)
        cap_dias += cm * r['dias'] * 7 / 5
    caucion = cap_dias * CAUCION_TNA / 365
    cap = sum(caps)
    return dict(tot=tot, real=real, peor=peor, vu=vu, cap=cap, dias=dias, caucion=caucion, neto=tot - caucion,
                k=1000 * tot / cap / dias, kn=1000 * (tot - caucion) / cap / dias)


def main():
    for serie in ('1h', '5m'):
        d0 = velas('MU', serie)
        print('\n== velas %s · %s a %s · 10 papeles · regla G · USD, lote %d · caución %.1f%% all-in' % (serie, d0[0][0], d0[-1][0], g.LOTE, CAUCION_TNA * 100))
        print('   %-6s %-22s %9s %9s %9s %9s %12s %12s %12s %8s' % ('esc.', 'cierre', 'resultado', 'caución', 'neto', 'cap.medio', 'por 1000/día', 'neto/1000/d', 'peor abierto', 'vueltas'))
        for verde in (False, True):
            for esc in (1.5, 2.0, 2.5, 3.0):
                r = corre(serie, esc, verde)
                print('   %-6s %-22s %+9.0f %9.0f %+9.0f %9.0f %12.2f %12.2f %12.0f %8d' % (
                    '%.1fx' % esc, 'vende lo verde' if verde else 'sin vender', r['tot'], r['caucion'], r['neto'], r['cap'], r['k'], r['kn'], r['peor'], r['vu']))


if __name__ == '__main__':
    main()
