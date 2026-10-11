# -*- coding: utf-8 -*-
# Grilla PIRÁMIDE (LP 11/10/2026): escalones con distancia y tamaño crecientes,
#   1: 1,5% con $1,5M · 2: 2% con $2M · 3: 2,5% con $2,5M · 4: 3% con $3M (máximo $9M por papel)
# y dos salidas: SEPARADO (cada escalón vende a su costo × (1 + 70% de su paso), como el
# bot) o PROMEDIO (todo junto al costo promedio × (1 + ganancia ponderada por tamaño)).
# El escalón 1 entra al precio cuando abre el ciclo; cada escalón siguiente está a su
# distancia del anterior. Sin refuerzo ni lateral. Regla G (compra desde la apertura si
# abre 1% abajo; si no, desde las 12). Velas de 1 hora, 10 papeles, últimos 6 y 12 meses.
# Comparación: grilla uniforme de 5 × $1,8M y de 4 × $2,25M (mismo máximo de $9M), paso 2% / 1,4%.
import statistics as st, sys
import apertura_bajista as ab
import candidato as cd
import seis_meses as sm
PAPELES = ab.PAPELES
FEE = 0.00044 * 1.21          # por punta, Cocos
CCL = 1610.0
CAUCION = 0.0 if '--sin-caucion' in sys.argv else sm.CAUCION_TNA


def simular(bars, nobuy, niveles, salida):
    """niveles: lista de (lote_pesos, paso, gan); el paso del nivel 0 no se usa como distancia."""
    N = len(niveles)
    ancla = None; lots = {}; real = 0.0; vu = 0; ciclos = 0
    stats = [dict(fills=0, sells=0, pnl=0.0, dias=0.0) for _ in niveles]
    eq = []; caps = []; peor = 0.0
    lot_usd = [n[0] / CCL for n in niveles]

    def nivel_px(k):      # precio de compra del nivel k (k ≥ 1)
        return ancla * (1 - sum(niveles[j][1] for j in range(1, k + 1)))

    def comprar(k, px, i):
        nonlocal ancla, ciclos
        if ancla is None: ancla = px; ciclos += 1
        u = lot_usd[k] / px
        lots[k] = (px, u, u * px, i)
        stats[k]['fills'] += 1

    def vender_todo(px, i, modo):
        nonlocal real, ancla, vu
        for k, (c, u, cost, i0) in list(lots.items()):
            ing = u * px; g = ing - cost - FEE * (ing + cost)
            real += g; vu += 1; stats[k]['sells'] += 1; stats[k]['pnl'] += g; stats[k]['dias'] += (i - i0) / 7
        lots.clear(); ancla = None

    def vender_k(k, px, i):
        nonlocal real, vu, ancla
        c, u, cost, i0 = lots.pop(k)
        ing = u * px; g = ing - cost - FEE * (ing + cost)
        real += g; vu += 1; stats[k]['sells'] += 1; stats[k]['pnl'] += g; stats[k]['dias'] += (i - i0) / 7
        if not lots: ancla = None

    def mover(p0, p1, i, salto, nb):
        # bajando: compras del siguiente nivel; subiendo: ventas
        if p1 < p0:
            if nb: return
            while True:
                if ancla is None: return
                h = max(lots) if lots else -1
                if h + 1 >= N: return
                px = nivel_px(h + 1)
                if px < p1: return
                comprar(h + 1, p1 if salto else min(px, p0), i)
        else:
            while lots:
                if salida == 'promedio':
                    ut = sum(v[1] for v in lots.values()); cost = sum(v[2] for v in lots.values())
                    ganw = sum(lots[k][1] * lots[k][0] * niveles[k][2] for k in lots) / sum(lots[k][1] * lots[k][0] for k in lots)
                    obj = cost / ut * (1 + ganw)
                    if obj > p1: return
                    vender_todo(p1 if salto else obj, i, 'promedio'); return
                k = max(lots)                              # el más barato (más profundo) sale primero
                obj = lots[k][0] * (1 + niveles[k][2])
                if obj > p1: return
                vender_k(k, p1 if salto else obj, i)

    prev_c = None; prev_f = None
    for i, (f, hm, o, h, l, c) in enumerate(bars):
        nb = i in nobuy
        if prev_c is not None: mover(prev_c, o, i, True, nb)
        if ancla is None and not nb and not lots: comprar(0, o, i)
        camino = [o, l, h, c] if c >= o else [o, h, l, c]
        for a, b in zip(camino, camino[1:]): mover(a, b, i, False, nb)
        if ancla is None and not nb and not lots: comprar(0, c, i)
        ab_ = sum(u * c - cost for (_, u, cost, _) in lots.values())
        peor = min(peor, ab_)
        eq.append(real + ab_); caps.append(sum(v[2] for v in lots.values()))
        prev_c, prev_f = c, f
    dias = len({b[0] for b in bars})
    cm = st.mean(caps)
    cau = cm * dias * 7 / 5 * CAUCION / 365
    return dict(tot=eq[-1], real=real, vu=vu, ciclos=ciclos, cap=cm, peor=peor, dias=dias, cau=cau, stats=stats)


PIRAMIDE = [(1.5e6, 0.015, 0.0105), (2.0e6, 0.02, 0.014), (2.5e6, 0.025, 0.0175), (3.0e6, 0.03, 0.021)]
UNIF5 = [(1.8e6, 0.02, 0.014)] * 5
UNIF4 = [(2.25e6, 0.02, 0.014)] * 4


def corre(meses, niveles, salida):
    d0 = sm.desde(meses)
    T = dict(tot=0, real=0, vu=0, ciclos=0, cap=0, peor=0, cau=0); S = [dict(fills=0, sells=0, pnl=0.0, dias=0.0) for _ in niveles]; dias = 0
    for tk, p, gn in PAPELES:
        v = sm.velas(tk, d0)
        nb = ab.nobuy_de(v, 'G', 0.01)
        r = simular(v, nb, niveles, salida)
        for k in T: T[k] += r[k]
        for k in range(len(niveles)):
            for x in S[k]: S[k][x] += r['stats'][k][x]
        dias = r['dias']
    return T, S, dias


def main():
    for meses in (6, 12):
        print('\n' + '=' * 96)
        print('ÚLTIMOS %d MESES · velas de 1 hora · 10 papeles · regla G · pesos (CCL %.0f constante) · caución %.1f%%' % (meses, CCL, CAUCION * 100))
        print('   %-34s %12s %11s %12s %12s %10s %7s %7s %10s' % ('grilla · salida', 'bruto $', 'caución $', 'neto $', 'peor abierto', 'cap.medio', 'ciclos', 'vueltas', 'neto/rueda'))
        filas = [('pirámide · separado', PIRAMIDE, 'separado'), ('pirámide · promedio', PIRAMIDE, 'promedio'),
                 ('uniforme 5 × $1,8M · separado', UNIF5, 'separado'), ('uniforme 5 × $1,8M · promedio', UNIF5, 'promedio'),
                 ('uniforme 4 × $2,25M · separado', UNIF4, 'separado')]
        det = {}
        for nombre, niv, sal in filas:
            T, S, dias = corre(meses, niv, sal)
            det[nombre] = (S, niv)
            print('   %-34s %12.0f %11.0f %12.0f %12.0f %10.0f %7d %7d %10.0f' % (
                nombre, T['tot'] * CCL, T['cau'] * CCL, (T['tot'] - T['cau']) * CCL, T['peor'] * CCL, T['cap'] * CCL, T['ciclos'], T['vu'], (T['tot'] - T['cau']) * CCL / dias))
        for nombre in ('pirámide · separado', 'pirámide · promedio'):
            S, niv = det[nombre]
            print('\n   %s · por escalón' % nombre)
            print('   %-8s %8s %7s %8s %8s %12s %12s %10s' % ('escalón', 'lote $', 'paso', 'compras', 'ventas', 'resultado $', 'por venta $', 'días/lote'))
            for k, n in enumerate(niv):
                s = S[k]
                print('   %-8s %8.1fM %6.1f%% %8d %8d %12.0f %12.0f %10.1f' % (k + 1, n[0] / 1e6, n[1] * 100, s['fills'], s['sells'], s['pnl'] * CCL, s['pnl'] * CCL / s['sells'] if s['sells'] else 0, s['dias'] / s['sells'] if s['sells'] else 0))


if __name__ == '__main__':
    main()
