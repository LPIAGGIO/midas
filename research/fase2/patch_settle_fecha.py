# -*- coding: utf-8 -*-
# La fecha del ajuste de futuros (settlement_ts) es una FECHA sin hora: el
# worker mtr-market-data guarda el campo STLD ("YYYY-MM-DD") y Postgres lo
# deja en 00:00 UTC. El 30/09/2026 se la convirtio a hora argentina creyendo
# que era la hora de publicacion, y eso la corria un dia para atras: el
# ajuste del dia nunca se reconocia como "de hoy" (ni en la valuacion del
# front ni en el resumen de Telegram). Verificado el 02/10 09:53: la fila
# decia 2026-10-01 con los valores del cierre del 01/10 (NOV 1.576, no los
# 1.577,5 del 30/09). Se lee la fecha tal cual viene.
import io, sys
B = 'C:/Users/slider/Documents/Claude/Projects/Midas'
fallos = []
def parchar(rel, a, b):
    p = B + '/' + rel
    s = io.open(p, encoding='utf-8').read()
    if s.count(a) != 1: fallos.append('%s (%d)' % (rel, s.count(a))); return None
    return p, s.replace(a, b)
r1 = parchar('api/mtr-md.js', '''  // Fecha (hora argentina) del settlement que trae la fila: el front compara
  // contra "hoy" para saber si ya es el ajuste del dia. OJO: el settle de ayer
  // se publica 21:00 ART = 00:00 UTC de hoy; en UTC parece de hoy y no lo es.
  const settlementDate = row.settlement_ts
    ? new Date(row.settlement_ts).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" })
    : null;''', '''  // Fecha del settlement que trae la fila: el front compara contra "hoy" para
  // saber si ya es el ajuste del dia. settlement_ts es una FECHA sin hora (el
  // campo STLD del feed, guardado a las 00:00 UTC): se lee tal cual, SIN pasar
  // a hora argentina (eso la corria un dia para atras; ver patch_settle_fecha.py).
  const settlementDate = row.settlement_ts ? new Date(row.settlement_ts).toISOString().slice(0, 10) : null;''')
r2 = parchar('workers/telegram-notifier/worker.js', '''  // En hora ARGENTINA: el settle de ayer se publica 21:00 ART = 00:00 UTC de
  // hoy, y comparando el string crudo daba "settle de hoy" cuando era el de
  // ayer (30/09/2026: DLRNOV26 −50.000 contra el settle viejo).
  const fechaArt = new Date(data[0].settlement_ts).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  return fechaArt === dateStr;''', '''  // settlement_ts es una FECHA sin hora (campo STLD del feed, guardada a las
  // 00:00 UTC): es la fecha de la rueda del ajuste y se compara tal cual. El
  // 30/09/2026 se la paso a hora argentina y quedaba siempre un dia atras
  // (ver research/fase2/patch_settle_fecha.py).
  return new Date(data[0].settlement_ts).toISOString().slice(0, 10) === dateStr;''')
if fallos or not r1 or not r2:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
for p, s in (r1, r2): io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
