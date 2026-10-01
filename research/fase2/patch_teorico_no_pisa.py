# -*- coding: utf-8 -*-
# CEDEARs: el "teorico" (USD x CCL / ratio) NO pisa mas el precio local
# (30/09/2026). Con el precio pisado, el P&L del dia de Midas no coincidia
# con el de Matriz (HUT -316k vs -421k, MU +59k vs -41k): Matriz valua al
# ultimo operado local. El teorico queda guardado aparte por si se quiere
# mostrar como referencia.
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
a = '''            const theo = (usd * ccl) / cat.r;
            if (!(theo > 0) || theo > local.price * 1.12 || theo < local.price * 0.88) continue;
            map[tk] = {
              ...local,
              price: theo,
              source: "teorico",
              changePct: local.previousClose > 0 ? (theo / local.previousClose - 1) * 100 : local.changePct,
            };'''
b = '''            const theo = (usd * ccl) / cat.r;
            if (!(theo > 0) || theo > local.price * 1.12 || theo < local.price * 0.88) continue;
            // 30/09/2026: el teórico ya NO pisa el precio. Valuar al teórico
            // hacía que el "Hoy" de Midas no coincidiera con el P&L diario de
            // Matriz, que usa el último operado local (HUT −316k vs −421k,
            // MU +59k vs −41k). Queda como dato aparte (`teorico`) para
            // mostrarlo como referencia de hacia dónde corregiría el CEDEAR.
            map[tk] = { ...local, teorico: theo };'''
if s.count(a) != 1:
    print('FALLO: ancla (%d)' % s.count(a)); sys.exit(1)
s = s.replace(a, b)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
