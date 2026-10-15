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
# Por rueda simulada: cierre en pesos del día anterior y latente al cierre anterior (scalp_resultados)
DIAS = {
    '2026-10-07': ({'MU': 337750, 'SNDK': 15730, 'NVDA': 16100, 'GOOGL': 9675, 'AMD': 104400, 'INTC': 36420,
                    'META': 49700, 'AAPL': 26820, 'MSFT': 28460, 'AMZN': 2872.5},
                   {'72404': {'AAPL': -14160, 'AMD': 0, 'AMZN': 3500, 'GOOGL': 720, 'INTC': -347420, 'META': -9600, 'MSFT': 0, 'MU': -166425, 'NVDA': -16960, 'SNDK': -179680},
                    '3893': {'AAPL': -2260, 'AMD': 0, 'AMZN': 3500, 'GOOGL': 2385, 'INTC': -293060, 'META': -10400, 'MSFT': 0, 'MU': -89325, 'NVDA': -13120, 'SNDK': -125280}}),
    '2026-10-08': ({'MU': 350300, 'SNDK': 16060, 'NVDA': 15940, 'GOOGL': 9765, 'AMD': 104200, 'INTC': 36340,
                    'META': 48280, 'AAPL': 27180, 'MSFT': 28300, 'AMZN': 2915},
                   {'72404': {'AAPL': 1340, 'AMD': 5150, 'AMZN': 7703, 'GOOGL': 0, 'INTC': -343900, 'META': -109200, 'MSFT': 360, 'MU': 13450, 'NVDA': -45760, 'SNDK': -90140},
                    '3893': {'AAPL': 4280, 'AMD': 13625, 'AMZN': 3937, 'GOOGL': 0, 'INTC': -289300, 'META': -90800, 'MSFT': 2520, 'MU': -2775, 'NVDA': -41280, 'SNDK': -62930}}),
    '2026-10-09': ({'MU': 334600, 'SNDK': 15200, 'NVDA': 15530, 'GOOGL': 9700, 'AMD': 100150, 'INTC': 34560,
                    'META': 48400, 'AAPL': 27500, 'MSFT': 28100, 'AMZN': 2860},           # cierre 08/10 (data912)
                   {'72404': {'AAPL': 7920, 'AMD': -111100, 'AMZN': -38501, 'GOOGL': -3680, 'INTC': -674780, 'META': -114180, 'MSFT': -20160, 'MU': -112175, 'NVDA': -194240, 'SNDK': -289790},
                    '3893': {'AAPL': 4860, 'AMD': -127875, 'AMZN': -45939, 'GOOGL': -2085, 'INTC': -642740, 'META': -94800, 'MSFT': -21360, 'MU': -198350, 'NVDA': -160960, 'SNDK': -318130}}),
    # 13/10 (lunes 12 feriado): cierre del viernes 09/10 (CL de Primary de los logs de la regla G; MU y NU de Yahoo .BA)
    # y latente al cierre del 09/10 de scalp_resultados. JNJ y NU arrancan el 13/10 sin latente.
    '2026-10-13': ({'MU': 331850, 'SNDK': 15020, 'NVDA': 15460, 'GOOGL': 9810, 'AMD': 98175, 'INTC': 33780,
                    'META': 48400, 'AAPL': 27200, 'MSFT': 28780, 'AMZN': 2950, 'JNJ': 28120, 'NU': 12960},
                   {'72404': {'AAPL': -2220, 'AMD': -224825, 'AMZN': 0, 'GOOGL': -4465, 'INTC': -812060, 'META': -114000, 'MSFT': 3600, 'MU': -156175, 'NVDA': -225600, 'SNDK': -355130, 'JNJ': 0, 'NU': 0},
                    '3893': {'AAPL': -8980, 'AMD': -233875, 'AMZN': 5687, 'GOOGL': -1820, 'INTC': -789380, 'META': -94800, 'MSFT': 3960, 'MU': -250600, 'NVDA': -187840, 'SNDK': -380770, 'JNJ': 0, 'NU': 0}}),
    '2026-10-14': ({'MU': 307000, 'SNDK': 14070, 'NVDA': 15310, 'GOOGL': 9845, 'AMD': 97350, 'INTC': 33200,
                    'META': 51075, 'AAPL': 27380, 'MSFT': 29100, 'AMZN': 2895, 'JNJ': 26700, 'NU': 12560},
                   {'72404': {'AAPL': -27800, 'AMD': -164775, 'AMZN': -15751, 'GOOGL': -7650, 'INTC': -942300, 'META': -6000, 'MSFT': -18000, 'MU': -542725, 'NVDA': -297280, 'SNDK': -710870, 'JNJ': -25560, 'NU': -18410},
                    '3893': {'AAPL': -27800, 'AMD': -268625, 'AMZN': -28439, 'GOOGL': -5015, 'INTC': -928500, 'META': -5250, 'MSFT': -18000, 'MU': -724825, 'NVDA': -242240, 'SNDK': -663810, 'JNJ': -27000, 'NU': -16360}}),
    '2026-10-15': ({'MU': 296000, 'SNDK': 13370, 'NVDA': 14940, 'GOOGL': 9720, 'AMD': 92400, 'INTC': 31720,
                    'META': 49740, 'AAPL': 27700, 'MSFT': 28720, 'AMZN': 2860, 'JNJ': 27380, 'NU': 12020},
                   {'72404': {'AAPL': -5240, 'AMD': -582975, 'AMZN': -74376, 'GOOGL': -30550, 'INTC': -1171100, 'META': -109800, 'MSFT': -82800, 'MU': -780325, 'NVDA': -472000, 'SNDK': -961340, 'JNJ': 3960, 'NU': -190440},
                    '3893': {'AAPL': -7480, 'AMD': -625625, 'AMZN': -109814, 'GOOGL': -38005, 'INTC': -1172900, 'META': -109850, 'MSFT': -79200, 'MU': -962425, 'NVDA': -416960, 'SNDK': -1003980, 'JNJ': 2520, 'NU': -173810}}),
}
PREV, LAT_PREV = DIAS[DIA]
# Escalón del bot → clave del simulador: 1-5 grilla (0-4), 6 refuerzo (99), 7+ lotes del lateral (100+)
CLAVE = lambda k: k - 1 if k <= 5 else (99 if k == 6 else 100 + k)
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
            lots[CLAVE(k)] = (px, q, q * px)
    ini = dict(ancla=None if limpio else s['ancla'], lots=lots, paso=s['paso'], gan=s['gan'], prev_c=PREV[tk])
    p_nuevo, g_nuevo = s['pasoNuevo'], s['ganNueva']
    if entrada_off:
        # (b) la primera compra queda apoyada un escalón abajo del cierre anterior,
        # fija toda la rueda (antes seguía al precio vela a vela y en velas de
        # 1 minuto casi nunca entraba: daba "no operó")
        ini.update(reent=PREV[tk] * (1 - p_nuevo), espera=10 ** 9)
    r = g.grilla(bars, p_nuevo, g_nuevo, None, doble=2.0, frac=0.5, espera_barras=20,
                 lateral_barras=60, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2,
                 dinamico={DIA: (p_nuevo, g_nuevo)}, inicial=ini, nobuy=nobuy)
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
