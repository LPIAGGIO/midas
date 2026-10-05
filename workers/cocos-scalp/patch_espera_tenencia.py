# -*- coding: utf-8 -*-
# cocos-scalp/worker.js: esperar a que Cocos informe la tenencia antes de abrir
# la rueda (05/10/2026). A las 08:36 del lunes el informe de posiciones de
# Cocos devolvia 0 en todos los papeles de las dos cuentas (el viernes a la
# noche ya venia incompleto). nuevoDia() frena el bot por todo el dia si la
# cuenta informa MENOS papeles de los que el bot lleva: correcto si LP vendio
# papeles del bot, pero no si el informe todavia no se cargo. Ahora, antes de
# abrir la rueda, si la cuenta informa menos se espera (sin mandar nada) y se
# vuelve a mirar cada minuto, hasta 30 minutos. Pasado ese plazo rige el freno
# de siempre.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''async function ciclo() {
  if (S.dia !== diaAr()) { if (!esHabil() || hhmmAr() < HORA_INICIO) return; await nuevoDia(); }''',
    '''// Antes de abrir la rueda: ¿la cuenta ya informa los papeles que el bot lleva?
// El informe de posiciones de Cocos arranca vacío a la mañana. Mientras informe
// menos, no se abre la rueda ni se manda nada; se vuelve a mirar cada minuto.
// A los 30 minutos se deja pasar y nuevoDia() aplica su freno.
const esperaTen = { desde: 0, ult: 0, aviso: 0 };
async function tenenciaLista() {
  const n = heldTot();
  if (!REAL || n === 0) return true;
  if (esperaTen.desde && Date.now() - esperaTen.ult < 60_000) return false;
  const t = await tenenciaCuenta().catch(() => null);
  if (t == null || t >= n) { if (esperaTen.desde) log(`la cuenta ya informa ${t ?? "?"} ${TK}: abro la rueda`); esperaTen.desde = 0; return true; }
  esperaTen.ult = Date.now();
  if (!esperaTen.desde) esperaTen.desde = Date.now();
  if (Date.now() - esperaTen.desde > 30 * 60_000) { esperaTen.desde = 0; return true; }
  if (Date.now() - esperaTen.aviso > 5 * 60_000) { esperaTen.aviso = Date.now(); log(`la cuenta informa ${t} ${TK} y llevo ${n}: espero a que Cocos cargue las posiciones (no mando nada)`); }
  return false;
}

async function ciclo() {
  if (S.dia !== diaAr()) { if (!esHabil() || hhmmAr() < HORA_INICIO) return; if (!(await tenenciaLista())) return; await nuevoDia(); }''', 'ciclo')

sub('''  if (S.dia !== diaAr() && esHabil() && hhmmAr() >= HORA_INICIO) await nuevoDia();''',
    '''  if (S.dia !== diaAr() && esHabil() && hhmmAr() >= HORA_INICIO && (await tenenciaLista())) await nuevoDia();''', 'main')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
