# -*- coding: utf-8 -*-
# Simulacion de UNA rueda real (LP 05/10/2026: "simulemos que hubiera sido lo
# mejor, y a cual de las dos cuentas le fue mejor").
#   python hoy.py 2026-10-05
# Parte del estado con que cada bot abrio (hoy-estado-inicial.json, sacado de
# los logs) y recorre las velas de 1 minuto en pesos de ese dia (hoy/). Varia:
# hora desde la que compra, escalon de los ciclos nuevos, lateral y la regla de
# la recompra tras una venta en el salto de apertura. Resultado del dia =
# realizado + cambio del latente contra el cierre anterior.
# Al final mide la regla de la recompra en las muestras largas.
import json, os, sys
import grilla5y as g
import lateral as L

AQUI = os.path.dirname(os.path.abspath(__file__))
DIA = sys.argv[1] if len(sys.argv) > 1 else '2026-10-05'
PREV = {'MU': 349250, 'AAPL': 27040, 'AMD': 103125, 'GOOGL': 9635, 'INTC': 38760, 'META': 49220, 'MSFT': 27960, 'NVDA': 15850, 'SNDK': 16410}   # cierre del viernes 02/10
REAL = {'72404': -272988, '3893': -198092}        # resultado real del dia (realizado + cambio del latente)
EST = json.load(open(os.path.join(AQUI, 'hoy-estado-inicial.json')))


def velas(tk):
    return [b for b in json.load(open(os.path.join(AQUI, 'hoy', '%s-%s.json' % (tk, DIA)))) if 1035 <= b[0] < 1700]


def corre(cta, tk, desde=1035, ancho=1.0, lateral=True, tope=False, estado=None):
    s = (estado or EST[cta])[tk]
    v = velas(tk)
    bars = [(DIA, b[1], b[2], b[3], b[4]) for b in v]
    nobuy = {i for i, b in enumerate(v) if b[0] < desde}
    lots = {}
    for k, q, objetivo in s['ventas']:
        px = objetivo / (1 + s['gan'])
        lots[k - 1] = (px, q, q * px)
    g.LOTE = s['lote'] * PREV[tk]
    ini = dict(ancla=s['ancla'], lots=lots, paso=s['paso'], gan=s['gan'], prev_c=PREV[tk])
    r = g.grilla(bars, s['paso'], s['gan'], None, doble=2.0, frac=0.5, espera_barras=20,
                 lateral_barras=60 if lateral else 0, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2,
                 dinamico={DIA: (s['paso'] * ancho, s['gan'] * ancho)}, inicial=ini, nobuy=nobuy, tope_barras=60 if tope else 0)
    lat0 = sum(q * PREV[tk] - c for (_, q, c) in lots.values())
    return dict(dia=r['eq'][-1] - lat0, real=r['real'], lat=r['eq'][-1] - r['real'], ventas=r['rondas'], cap=max(r['s_cap']), extras=r['extras'])


def cuenta(cta, estado=None, **kw):
    t = dict(dia=0.0, real=0.0, lat=0.0, ventas=0, cap=0.0, extras=0)
    por = {}
    for tk in sorted(PREV):
        r = corre(cta, tk, estado=estado, **kw)
        por[tk] = r
        for k in t: t[k] += r[k]
    return t, por


def fila(nombre, t):
    return '   %-52s %10.0f %10.0f %10.0f %7d %9.1f' % (nombre, t['dia'], t['real'], t['lat'], t['ventas'], t['cap'] / 1e6)


def main():
    g.NIV = 5
    print('RUEDA DEL %s · velas de 1 minuto en pesos · 9 papeles' % DIA)
    print('\n1) EL SIMULADOR CONTRA LO QUE PASO (misma configuracion que corrio cada cuenta)')
    print('   %-52s %10s %10s %10s %7s %9s' % ('', 'dia', 'realizado', 'latente', 'ventas', 'cap $M'))
    a, pa = cuenta('72404', desde=1035, ancho=1.0)
    b, pb = cuenta('3893', desde=1200, ancho=1.5)
    print(fila('72404 simulada (compra 10:35, escalon 1x)', a) + '   real: %d' % REAL['72404'])
    print(fila('3893 simulada (compra 12:00, escalon 1,5x)', b) + '   real: %d' % REAL['3893'])

    print('\n2) QUE EXPLICA LA DIFERENCIA ENTRE CUENTAS (cada cuenta con su estado de apertura)')
    print('   %-52s %10s %10s %10s %7s %9s' % ('', 'dia', 'realizado', 'latente', 'ventas', 'cap $M'))
    for cta in ('72404', '3893'):
        for nombre, kw in (('compra 10:35 · escalon 1x', dict(desde=1035, ancho=1.0)),
                           ('compra 12:00 · escalon 1x', dict(desde=1200, ancho=1.0)),
                           ('compra 10:35 · escalon 1,5x', dict(desde=1035, ancho=1.5)),
                           ('compra 12:00 · escalon 1,5x', dict(desde=1200, ancho=1.5))):
            print(fila('estado de la %s · %s' % (cta, nombre), cuenta(cta, **kw)[0]))

    print('\n3) QUE HUBIERA SIDO LO MEJOR HOY (suma de las dos cuentas, cada una con su estado de apertura)')
    print('   %-52s %10s %10s %10s %7s %9s' % ('', 'dia', 'realizado', 'latente', 'ventas', 'cap $M'))
    res = []
    for desde in (1035, 1135, 1200, 1400):
        for ancho in (1.0, 1.5):
            for lat in (True, False):
                for tope in (False, True):
                    x = cuenta('72404', desde=desde, ancho=ancho, lateral=lat, tope=tope)[0]
                    y = cuenta('3893', desde=desde, ancho=ancho, lateral=lat, tope=tope)[0]
                    t = {k: x[k] + y[k] for k in x}
                    res.append(('compra %04d · escalon %sx · lateral %s · recompra %s' % (desde, ('%.1f' % ancho).replace('.', ','), 'si' if lat else 'no', 'con tope' if tope else 'libre'), t))
    for nombre, t in sorted(res, key=lambda r: -r[1]['dia']):
        print(fila(nombre, t))
    print('   (sin comprar nada en todo el dia, solo vendiendo lo arrastrado:)')
    x = cuenta('72404', desde=1700, lateral=False)[0]; y = cuenta('3893', desde=1700, lateral=False)[0]
    print(fila('solo ventas', {k: x[k] + y[k] for k in x}))

    print('\n4) LA REGLA DE LA RECOMPRA EN LAS MUESTRAS LARGAS (9 papeles, USD, lote 460, sin corte, refuerzo 50%)')
    g.LOTE = 460.0
    P = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
         ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005)]
    for serie, esp, tb in (('5 minutos, 43 ruedas', 4, 12), ('horario, ~730 ruedas', 0, 1)):
        base = con = pb_ = pc = 0.0; mej = 0; nt = 0
        for tk, p, gn in P:
            bars = L.barras5m(tk) if serie.startswith('5') else g.cargar(tk, 'hourly')
            r0 = g.grilla(bars, p, gn, None, doble=2.0, frac=0.5, espera_barras=esp)
            r1 = g.grilla(bars, p, gn, None, doble=2.0, frac=0.5, espera_barras=esp, tope_barras=tb)
            base += r0['total']; con += r1['total']; pb_ += r0['peor_abierto']; pc += r1['peor_abierto']; nt += r1['topes']
            mej += r1['total'] > r0['total']
        print('   %-22s recompra libre %8.0f (peor %8.0f) · con tope la primera hora %8.0f (peor %8.0f) · diferencia %+.1f%% · mejora en %d de 9 · veces que actuo: %d' % (
            serie, base, pb_, con, pc, 100 * (con - base) / base, mej, nt))


if __name__ == '__main__':
    main()
