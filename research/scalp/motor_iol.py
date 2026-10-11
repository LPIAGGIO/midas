# -*- coding: utf-8 -*-
# "Simulá el scalp de los bots, pero que los precios de entrada sean el motor del
# bot de IOL, sin el risk on" (LP 11/10/2026).
# La grilla de la cuenta 1 (escalón 1,5x, refuerzo 50%, lateral, sin corte) sobre
# velas de 1 hora de 2 años, con cuatro formas de abrir el ciclo:
#   A  como corre: abre al precio, siempre que no tenga ciclo
#   B  solo con señal del motor de niveles (score ≥ 7, R:R ≥ 2, sin contra-tendencia),
#      SIN el filtro de régimen; compra límite en el nivel del motor, viva 48 h (14 barras)
#   C  igual que B pero CON el régimen (risk_on, o mixto con score ≥ 8 y R:R ≥ 2,5)
#   D  igual que B pero entrando al cierre de la barra de la señal, sin esperar el nivel
# Las señales son las 333.935 del cache research/backtest-5y/signals.json (el motor
# portado del worker, engine.js), barra por barra sobre las mismas series horarias.
import json, os, statistics as st
import grilla5y as g
AQUI = os.path.dirname(os.path.abspath(__file__))
B5 = os.path.join(AQUI, '..', 'backtest-5y')
PAPELES = [('MU', 0.01, 0.007), ('SNDK', 0.015, 0.01), ('NVDA', 0.01, 0.007), ('GOOGL', 0.007, 0.005), ('AMD', 0.01, 0.007),
           ('INTC', 0.01, 0.007), ('META', 0.01, 0.007), ('AAPL', 0.007, 0.005), ('MSFT', 0.007, 0.005), ('AMZN', 0.007, 0.005),
           ('NU', 0.01, 0.007)]   # JNJ queda afuera: 8 señales en 2 años
ESC = 1.5


def gate(s, regimen):
    ok = s['score'] >= 7 and s['rr'] is not None and s['rr'] >= 2 and not s['ct'] and s['stop'] and s['stop'] < s['entry'] and s['target'] is not None
    if not regimen:
        return ok
    mixto = s['regime'] == 'mixto' and s['score'] >= 8 and s['rr'] >= 2.5
    return ok and (s['regime'] == 'risk_on' or mixto)


def cargar_senales():
    S = json.load(open(os.path.join(B5, 'signals.json')))['senales']
    por = {}
    for s in S:
        por.setdefault(s['sym'], []).append(s)
    return por


def barras_con_ts(tk):
    j = json.load(open(os.path.join(B5, 'data', 'hourly', tk + '.json')))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    bars, idx = [], {}
    import time
    for t, o, h, l, c in zip(j['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if o and h and l and c:
            idx[t] = len(bars)
            bars.append((time.strftime('%Y-%m-%d', time.gmtime(t - 4 * 3600)), o, h, l, c))
    return bars, idx


def corre(variante, por):
    tot = real = peor = 0.0; caps = []; dias = 0; vu = 0; nsen = 0; ciclos = 0; carg = 0; n = 0
    for tk, p, gn in PAPELES:
        bars, idx = barras_con_ts(tk)
        sen = None; solo = False; mercado = False
        if variante != 'A':
            solo = True
            sen = {}
            for s in por.get(tk, []):
                if s['ts'] in idx and gate(s, variante == 'C'):
                    sen[idx[s['ts']]] = s['entry']
            mercado = variante == 'D'
        r = g.grilla(bars, p * ESC, gn * ESC, None, doble=2.0, frac=0.5, espera_barras=0,
                     lateral_barras=1, lateral_frac=0.5, lateral_max=4, lateral_hasta_esc=2,
                     senales=sen, ventana=14, solo_senales=solo, senal_mercado=mercado)
        tot += r['total']; real += r['real']; peor += r['peor_abierto']; vu += r['rondas']; nsen += r['nsen']; ciclos += r['ciclos']
        caps.append(st.mean(r['s_cap'])); dias = max(dias, r['dias'])
        carg += sum(1 for x in r['s_lot'] if x > 0); n += len(r['s_lot'])
    return dict(tot=tot, real=real, peor=peor, vu=vu, nsen=nsen, ciclos=ciclos, cap=sum(caps), dias=dias, pct=100.0 * carg / n)


def main():
    por = cargar_senales()
    print('== grilla cuenta 1 (1,5x) · %d papeles · velas de 1 hora · USD, lote %d' % (len(PAPELES), g.LOTE))
    print('   %-52s %9s %9s %12s %10s %8s %7s %7s %8s' % ('cómo abre el ciclo', 'resultado', 'realizado', 'por 1000/día', 'peor abierto', 'cap. medio', 'vueltas', 'ciclos', '% tiempo'))
    for v, nombre in [('A', 'A  como corre: al precio, siempre'),
                      ('B', 'B  señal del motor SIN régimen, límite en el nivel (48 h)'),
                      ('C', 'C  señal del motor CON régimen, límite en el nivel (48 h)'),
                      ('D', 'D  señal del motor SIN régimen, a mercado al cierre de la barra')]:
        r = corre(v, por)
        print('   %-52s %+9.0f %+9.0f %12.2f %10.0f %8.0f %7d %7d %7.0f%%%s' % (
            nombre, r['tot'], r['real'], 1000 * r['tot'] / r['cap'] / r['dias'], r['peor'], r['cap'], r['vu'], r['ciclos'], r['pct'],
            '' if v == 'A' else '   (%d señales)' % r['nsen']))


if __name__ == '__main__':
    main()
