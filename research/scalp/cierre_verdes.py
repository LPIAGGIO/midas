# -*- coding: utf-8 -*-
# "Qué hubiera pasado" con la regla de LP (06/10/2026): vender al cierre lo que
# está en verde y arrancar al día siguiente limpio, (a) al precio o (b) un
# escalón más abajo. Simula UNA rueda real con velas de 1 minuto en pesos,
# partiendo del estado con que abrió cada bot (estado_apertura.js), y compara
# contra la configuración que corrió de verdad.
#   python cierre_verdes.py 2026-10-07
import json, os, sys
import grilla5y as g

AQUI = os.path.dirname(os.path.abspath(__file__))
DIA = sys.argv[1] if len(sys.argv) > 1 else '2026-10-07'
# Cierre en pesos del día anterior (Yahoo .BA; META del Cie/Aju Ant de Matriz)
PREV = {'MU': 337750, 'SNDK': 15730, 'NVDA': 16100, 'GOOGL': 9675, 'AMD': 104400, 'INTC': 36420,
        'META': 49700, 'AAPL': 26820, 'MSFT': 28460, 'AMZN': 2872.5}
# Latente al cierre del día anterior por cuenta y papel (scalp_resultados)
LAT_PREV = {
    '72404': {'AAPL': -14160, 'AMD': 0, 'AMZN': 3500, 'GOOGL': 720, 'INTC': -347420, 'META': -9600, 'MSFT': 0, 'MU': -166425, 'NVDA': -16960, 'SNDK': -179680},
    '3893': {'AAPL': -2260, 'AMD': 0, 'AMZN': 3500, 'GOOGL': 2385, 'INTC': -293060, 'META': -10400, 'MSFT': 0, 'MU': -89325, 'NVDA': -13120, 'SNDK': -125280},
}
CONF = {'72404': dict(desde=1031), '3893': dict(desde=1200)}     # hora desde la que compra
COMISION = 0.00053                                                 # por punta (Cocos)
EST = json.load(open(os.path.join(AQUI, 'hoy-estado-inicial-%s.json' % DIA)))


def velas(tk):
    return [b for b in json.load(open(os.path.join(AQUI, 'hoy', '%s-%s.json' % (tk, DIA)))) if 1031 <= b[0] < 1700]


def corre(cta, tk, limpio=False, entrada_off=0.0):
    s = EST[cta][tk]
    v = velas(tk)
    bars = [(DIA, b[1], b[2], b[3], b[4]) for b in v]
    nobuy = {i for i, b in enumerate(v) if b[0] < CONF[cta]['desde']}
    g.LOTE = s['lote'] * PREV[tk]
    g.NIV = 5
    lots = {}
    if not limpio:
        for k, q, objetivo in s['ventas']:
            px = objetivo / (1 + s['gan'])
            lots[k - 1] = (px, q, q * px)
    ini = dict(ancla=None if limpio else s['ancla'], lots=lots, paso=s['paso'], gan=s['gan'], prev_c=PREV[tk])
    p_nuevo, g_nuevo = s['pasoNuevo'], s['ganNueva']
    r = g.grilla(bars, p_nuevo, g_nuevo, None, doble=2.0, frac=0.5, espera_barras=20,
                 lateral_barras=60, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2,
                 dinamico={DIA: (p_nuevo, g_nuevo)}, inicial=ini, nobuy=nobuy,
                 entrada_off=(p_nuevo if entrada_off else 0.0))
    lat0 = sum(q * PREV[tk] - c for (_, q, c) in lots.values())
    return r['eq'][-1] - lat0, r['rondas']


def main():
    print('RUEDA DEL %s · vender lo verde al cierre del día anterior y arrancar limpio' % DIA)
    tot = {}
    for cta in ('72404', '3893'):
        verdes = [tk for tk, l in LAT_PREV[cta].items() if l > 0 and tk in EST[cta]]
        print('\nCUENTA %s · en verde al cierre anterior: %s' % (cta, ', '.join('%s (%+d)' % (tk, LAT_PREV[cta][tk]) for tk in verdes) or 'ninguno'))
        print('   %-6s %12s %16s %16s' % ('papel', 'como corrió', '(a) limpio, precio', '(b) limpio, 1 esc. abajo'))
        r_real = r_a = r_b = 0.0
        for tk in sorted(EST[cta]):
            base, _ = corre(cta, tk)
            if tk in verdes:
                s = EST[cta][tk]
                qty = sum(q for _, q, _ in s['ventas'])
                costo_venta = COMISION * qty * PREV[tk]
                a, _ = corre(cta, tk, limpio=True)
                b, _ = corre(cta, tk, limpio=True, entrada_off=1)
                a -= costo_venta; b -= costo_venta
                print('   %-6s %12.0f %16.0f %16.0f   (venta de %d a %s, comisión %.0f)' % (tk, base, a, b, qty, PREV[tk], costo_venta))
            else:
                a = b = base
            r_real += base; r_a += a; r_b += b
        print('   %-6s %12.0f %16.0f %16.0f' % ('TOTAL', r_real, r_a, r_b))
        tot[cta] = (r_real, r_a, r_b)
    t = [sum(v[i] for v in tot.values()) for i in range(3)]
    print('\nLAS DOS CUENTAS · como corrió %.0f · (a) %.0f (%+.0f) · (b) %.0f (%+.0f)' % (t[0], t[1], t[1] - t[0], t[2], t[2] - t[0]))


if __name__ == '__main__':
    main()
