# -*- coding: utf-8 -*-
# cocos-scalp/worker.js: el bot opera hasta el cierre real de la rueda (LP
# 02/10/2026: "ojo que el mercado cierra 17 hs"; el bot cortaba 16:45, hora
# pensada para cuando vendia todo al cierre). Ahora:
#  - opera hasta las 17:00; las ordenes son por el dia y vencen solas;
#  - a las 17:00 solo registra el estado final (sin cancelar una por una);
#  - puede abrir ciclos nuevos hasta las 16:45;
#  - el cierre ya no manda un Telegram por bot (eran 18 mensajes): el detalle
#    sale en el resumen de las 17:03.
import io, os, re, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))
sub('const HORA_CIERRE = Number(ENV.SCALP_HORA_CIERRE || 1645);', 'const HORA_CIERRE = Number(ENV.SCALP_HORA_CIERRE || 1700);   // cierre real de BYMA', 'cierre')
sub('const HORA_ULTIMO_CICLO = Number(ENV.SCALP_HORA_ULTIMO_CICLO || 1615);', 'const HORA_ULTIMO_CICLO = Number(ENV.SCALP_HORA_ULTIMO_CICLO || 1645);', 'ultimo')
sub('''  for (let i = 0; i < 12 && vivas().length; i++) { for (const o of vivas()) { o.cancelT = 0; await cancelar(o, "cierre de la rueda"); } await dormir(2500); await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`)); }
  const n = heldTot(), costo = S.niveles.reduce((a, x) => a + x.costo, 0);''',
'''  // Con el mercado ya cerrado las ordenes vencieron solas: alcanza con leer su
  // estado final (una venta pudo ejecutarse en el ultimo minuto). Si el cierre
  // se pidio antes de las 17:00 (SCALP_HORA_CIERRE), ahi si se cancelan.
  const cerrado = hhmmAr() >= 1700;
  for (let i = 0; i < (cerrado ? 4 : 12) && vivas().length; i++) {
    if (!cerrado) for (const o of vivas()) { o.cancelT = 0; await cancelar(o, "cierre de la rueda"); }
    await dormir(cerrado ? 5000 : 2500);
    await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`));
  }
  const n = heldTot(), costo = S.niveles.reduce((a, x) => a + x.costo, 0);''', 'bucle')
patron = re.compile(r"  const msg = `CIERRE del día \(\$\{S\.fin\}\)[^\n]*\n  log\(msg\); await tg\([^\n]*\n\}")
if len(patron.findall(s)) != 1:
    fallos.append('tg (%d)' % len(patron.findall(s)))
else:
    s = patron.sub(lambda m: "  log(`CIERRE del día (${S.fin}) · ${S.rondas} ventas · P&L realizado ${pesos(S.pnl)}`);\n  // Sin Telegram por bot: el detalle de todos sale junto en el resumen de las 17:03.\n}", s)
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
