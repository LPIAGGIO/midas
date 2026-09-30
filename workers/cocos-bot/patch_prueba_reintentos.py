# -*- coding: utf-8 -*-
# cocos-bot: la prueba de plomeria reintenta cada 10 min hasta las 11:30 si
# Primary todavia no levanto (mantenimiento nocturno), 30/09/2026.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''let plomeriaOk = !PROBAR, plomeriaDia = null, avisoPerdida = null, avisoApagado = null;''',
'''let plomeriaOk = !PROBAR, plomeriaDia = null, plomeriaIntento = 0, avisoPerdida = null, avisoApagado = null;''', 'estado')
sub('''async function probarPlomeria() {
  const hoy = diaAr(new Date());
  if (plomeriaDia === hoy) return plomeriaOk;
  plomeriaDia = hoy;''',
'''async function probarPlomeria() {
  const hoy = diaAr(new Date());
  if (plomeriaDia === hoy) return plomeriaOk;
  // Primary puede tardar en levantar a la mañana (mantenimiento nocturno):
  // si la prueba falla se reintenta cada 10 min hasta las 11:30 antes de dar
  // el día por perdido.
  plomeriaIntento++;
  const ultimo = hhmmAr() >= 1130 || plomeriaIntento >= 7;
  if (ultimo) plomeriaDia = hoy;''', 'inicio')
sub('''    plomeriaOk = true;
    log(`[prueba] OK: 1 × ${tk} a ${pesos(px)} aceptada (${o1.status}) y cancelada (${o2.status})`);''',
'''    plomeriaOk = true;
    plomeriaDia = hoy;
    log(`[prueba] OK: 1 × ${tk} a ${pesos(px)} aceptada (${o1.status}) y cancelada (${o2.status})`);''', 'ok')
sub('''  } catch (e) {
    plomeriaOk = false;
    log(`[prueba] FALLO: ${e.message}`);
    await tg(`<b>COCOS BOT · prueba FALLÓ</b>\\n${e.message}\\nHoy NO abre posiciones nuevas. Revisar en Matriz si quedó alguna orden de 1 × AAPL colgada.`);
  }''',
'''  } catch (e) {
    plomeriaOk = false;
    log(`[prueba] FALLO (intento ${plomeriaIntento}): ${e.message}`);
    if (ultimo) await tg(`<b>COCOS BOT · prueba FALLÓ</b>\\n${e.message}\\nHoy NO abre posiciones nuevas. Revisar en Matriz si quedó alguna orden de 1 × AAPL colgada.`);
    else { await tg(`<b>COCOS BOT · prueba falló, reintento en 10 min</b>\\n${e.message}`); await new Promise((r) => setTimeout(r, 9 * 60_000)); }
  }''', 'catch')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
