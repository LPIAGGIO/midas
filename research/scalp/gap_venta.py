# -*- coding: utf-8 -*-
# Pedido de LP 15/10/2026: cuando el papel abre por ENCIMA del precio de venta de
# los escalones, el bot vende en la apertura (JNJ abrió +1,46%, vendió a 27.720 y a
# los 5 minutos estaba en 28.100). ¿Conviene esperar y poner la venta por arriba de
# la apertura? Estudio de eventos con velas de 1 hora (~2 años) de los 12 papeles:
# días que abren >= G% arriba del cierre anterior. Resultado de cada regla en % contra
# vender en la apertura (positivo = mejor que la regla actual). Mitades separadas.
import statistics as st
import grilla5y as g
TK = ['MU','SNDK','NVDA','AMD','INTC','META','GOOGL','AAPL','MSFT','AMZN','NU','JNJ']
def dias(v):
    d = {}
    for b in v: d.setdefault(b[0], []).append(b)
    return d
res = {}
for G in (0.01, 0.02):
    ev = []
    for tk in TK:
        try: v = g.cargar(tk, 'hourly')
        except Exception: continue
        D = dias(v); ks = sorted(D)
        for i in range(1, len(ks)):
            prev, hoy = D[ks[i-1]], D[ks[i]]
            if len(hoy) < 3: continue
            pc, op = prev[-1][4], hoy[0][1]
            if op / pc - 1 < G: continue
            h1, h2 = hoy[0], hoy[1]
            r = {'fecha': ks[i], 'tk': tk}
            for k in (0.003, 0.005, 0.01):
                lim = op * (1 + k)
                # B: venta límite apertura+k durante la 1ra hora; si no llena, vende al cierre de esa hora
                px = lim if h1[2] >= lim else h1[4]
                r[f'B{k}'] = px / op - 1
                # B2: igual pero espera 2 horas
                px2 = lim if max(h1[2], h2[2]) >= lim else h2[4]
                r[f'B2_{k}'] = px2 / op - 1
            r['C1h'] = h1[4] / op - 1       # vender al cierre de la 1ra hora
            r['Cdia'] = hoy[-1][4] / op - 1  # vender al cierre del día
            ev.append(r)
    fechas = sorted(e['fecha'] for e in ev); mitad = fechas[len(fechas)//2] if fechas else None
    res[G] = (ev, mitad)

out = []
for G, (ev, mitad) in res.items():
    out.append(f'\n== abren >= {G*100:.0f}% arriba del cierre anterior: {len(ev)} eventos (12 papeles, velas 1h, corte de mitades {mitad})')
    out.append('  regla                                   promedio   mediana  mitad1   mitad2   %mejor')
    for key, nom in [('B0.003','límite apertura+0,3%, 1 hora'),('B0.005','límite apertura+0,5%, 1 hora'),('B0.01','límite apertura+1%, 1 hora'),
                     ('B2_0.005','límite apertura+0,5%, 2 horas'),('B2_0.01','límite apertura+1%, 2 horas'),('C1h','vender al cierre de la 1ra hora'),('Cdia','vender al cierre del día')]:
        xs = [e[key] for e in ev]; a = [e[key] for e in ev if e['fecha'] < mitad]; b = [e[key] for e in ev if e['fecha'] >= mitad]
        out.append(f'  {nom:38} {st.mean(xs)*100:+7.3f}% {st.median(xs)*100:+7.3f}% {st.mean(a)*100:+7.3f}% {st.mean(b)*100:+7.3f}% {100*sum(x>0 for x in xs)/len(xs):5.0f}%')
    pt = {}
    for e in ev: pt.setdefault(e['tk'], []).append(e['B0.005'])
    out.append('  por papel, límite +0,5% 1 hora: ' + ' · '.join(f'{t} {st.mean(x)*100:+.2f}% (n={len(x)})' for t, x in sorted(pt.items())))
open('gap-venta-salida.txt', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print('\n'.join(out))
