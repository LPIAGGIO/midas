# -*- coding: utf-8 -*-
# cocos-scalp/worker.js (08/10/2026, acordado con LP a las 12:14): libro congelado.
# Primary corta el websocket a las 06:00; el bot reconecta a las 06:02 y desde
# ahí no recibió más mensajes Md (solo pongs), así que libro() devolvió todo el
# día el libro de antes de la apertura (GOOGL y MSFT abrieron ciclo a precios
# viejos que nunca se ejecutaron; el latente informado era falso). Los días
# anteriores no pasó porque LP reiniciaba los bots a la mañana. Ahora:
#  1) entre las 10:20 y HORA_INICIO, una vez por día, se reconecta el ws para
#     suscribirse fresco antes de la apertura;
#  2) en rueda, si pasan 5 minutos sin un mensaje Md (los pongs no cuentan),
#     se cierra y reconecta el ws;
#  3) libro() en rueda no usa un libro de más de 10 minutos: lo pide por REST
#     (que deja el libro fechado ahora, así no consulta en cada ciclo: la API
#     corta con "Rate limit exceeded" si se la consulta seguido).
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''let book = { bid: null, ask: null, last: null, t: 0 }, wsConn = null, wsUltimo = 0, wsReint = 0;''',
    '''let book = { bid: null, ask: null, last: null, t: 0 }, wsConn = null, wsUltimo = 0, wsReint = 0;
let wsMd = 0, wsAbierto = 0, wsRefrescado = null;   // último mensaje Md · apertura del ws · día del refresco previo a la rueda''', 'variables')

sub('''    ws.on("open", () => { wsReint = 0; ws.send(''',
    '''    ws.on("open", () => { wsReint = 0; wsAbierto = Date.now(); ws.send(''', 'open')

sub('''      if (j.type !== "Md") return;
      const md = j.marketData || {};''',
    '''      if (j.type !== "Md") return;
      wsMd = Date.now();
      const md = j.marketData || {};''', 'md')

sub('''let _restT = 0, _fk = 344000, _fn = 0;''',
    '''// Vigía del ws (cada 30 s): refresco antes de la apertura y reconexión si en
// rueda pasan 5 minutos sin precios. Cerrar dispara la reconexión del "close".
function wsVigilar() {
  if (!wsConn || wsConn.readyState !== 1 || !esHabil()) return;
  const hm = hhmmAr();
  if (hm >= 1020 && hm < HORA_INICIO && wsRefrescado !== diaAr()) {
    wsRefrescado = diaAr();
    if (Date.now() - wsAbierto > 10 * 60_000) { log("ws: reconecto antes de la apertura para suscribirme fresco"); try { wsConn.close(); } catch { /* se cae sola */ } }
    return;
  }
  if (hm >= HORA_INICIO && hm < HORA_CIERRE && Date.now() - Math.max(wsMd, wsAbierto) > 5 * 60_000) {
    log(`ws: ${Math.round((Date.now() - Math.max(wsMd, wsAbierto)) / 60_000)} min sin precios en rueda; reconecto`);
    wsAbierto = Date.now();                        // no repetir hasta que pasen otros 5 minutos
    try { wsConn.close(); } catch { /* se cae sola */ }
  }
}
let _restT = 0, _fk = 344000, _fn = 0;''', 'vigia')

sub('''  if (wsConn && wsConn.readyState === 1 && Date.now() - wsUltimo < 90_000 && book.t) return book;''',
    '''  const enRueda = esHabil() && hhmmAr() >= HORA_INICIO && hhmmAr() < HORA_CIERRE;
  if (wsConn && wsConn.readyState === 1 && Date.now() - wsUltimo < 90_000 && book.t && !(enRueda && Date.now() - book.t > 10 * 60_000)) return book;''', 'libro')

sub('''    await wsConectar();
    for (let i = 0; i < 10 && !book.t; i++) await dormir(1000);''',
    '''    await wsConectar();
    if (hhmmAr() >= 1020) wsRefrescado = diaAr();   // recién conectado: no hace falta el refresco previo
    setInterval(wsVigilar, 30_000);
    for (let i = 0; i < 10 && !book.t; i++) await dormir(1000);''', 'main')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
