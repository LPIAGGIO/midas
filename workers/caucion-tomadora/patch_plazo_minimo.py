# -*- coding: utf-8 -*-
# caucion-tomadora/worker.js (09/10/2026): el viernes previo al feriado del
# lunes 12/10 no existe la caución a 1 día ("Security MERV - XMEV - PESOS - 1D
# doesn't exist"): el plazo más corto es 4D (vence el martes). El bot quedó sin
# poder apoyar ni tomar. Ahora:
#  - cada día elige el plazo más corto que liste Primary (PESOS - ND con N
#    mínimo); si no lo puede leer, usa 1D;
#  - las cauciones de hoy se cuentan sobre cualquier plazo en pesos (una
#    tomada a mano a 4D también cubre);
#  - feriados: no opera en los días de CAUCION_FERIADOS (lista AAAA-MM-DD en
#    .env) ni en el 12/10/2026.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''const SIMBOLO = "MERV - XMEV - PESOS - 1D";''',
    '''// Plazo más corto del día: 1D casi siempre; antes de un fin de semana largo es
// 3D o 4D (el 1D no existe). Se resuelve una vez por día con la lista de Primary.
const RE_CAUCION = /^MERV - XMEV - PESOS - (\\d+)D$/;
let _simbolo = { dia: null, s: "MERV - XMEV - PESOS - 1D" };''', 'simbolo')

sub('''const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5; };''',
    '''const FERIADOS = new Set(["2026-10-12", ...String(PROPIO.CAUCION_FERIADOS || "").split(/[ ,]+/).filter(Boolean)]);
const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5 && !FERIADOS.has(diaAr()); };''', 'habil')

sub('''    if (o.instrumentId?.symbol !== SIMBOLO || o.side !== "BUY" || !String(o.transactTime || "").startsWith(hoy)) continue;''',
    '''    if (!RE_CAUCION.test(o.instrumentId?.symbol || "") || o.side !== "BUY" || !String(o.transactTime || "").startsWith(hoy)) continue;''', 'cauciones')

sub('''async function libro(c) {
  const j = await api(c, `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: SIMBOLO, entries: "BI,OF,LA", depth: 1 })}`);''',
    '''async function simbolo(c) {
  if (_simbolo.dia === diaAr()) return _simbolo.s;
  try {
    const j = await api(c, "/rest/instruments/all");
    const plazos = (j?.instruments || []).map((x) => RE_CAUCION.exec(x?.instrumentId?.symbol || "")).filter(Boolean).map((m) => Number(m[1]));
    if (plazos.length) {
      const n = Math.min(...plazos);
      _simbolo = { dia: diaAr(), s: `MERV - XMEV - PESOS - ${n}D` };
      log(`plazo de hoy: ${_simbolo.s}${n > 1 ? " (no hay 1D: fin de semana largo)" : ""}`);
    }
  } catch (e) { log(`plazo: ${e.message}; uso ${_simbolo.s}`); }
  return _simbolo.s;
}
async function libro(c) {
  const j = await api(c, `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: await simbolo(c), entries: "BI,OF,LA", depth: 1 })}`);''', 'libro')

n = s.count('symbol: SIMBOLO, ')
if n != 2: fallos.append('ordenes (%d)' % n)
else: s = s.replace('symbol: SIMBOLO, ', 'symbol: await simbolo(c), ')

if 'SIMBOLO' in s: fallos.append('quedó SIMBOLO')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
