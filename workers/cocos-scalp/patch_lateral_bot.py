# -*- coding: utf-8 -*-
# cocos-scalp/worker.js — tanda del 02/10/2026 (se despliega con el mercado
# cerrado; los bots los reinicia LP):
#  1) REGLA DEL LATERAL (LP: "comprar medio lote al precio si pasa una hora y
#     no pasa nada", solo en papeles con 1 o 2 escalones): lote extra de
#     LATERAL_FRAC × LOTE al precio, hasta LATERAL_MAX extras abiertos; cada
#     extra se vende a su costo + GANANCIA. Medido en research/scalp/lateral.py.
#  2) Websocket: ping/pong para saber que la conexión vive aunque el libro esté
#     quieto, y no salir a pedir el precio por REST (HTTP 429 compartido entre
#     los 18 bots: 51 rechazos el 02/10).
#  3) El saldo disponible se reintenta al arrancar (seis de nueve bots de la
#     cuenta 3893 arrancaron sin poder leerlo).
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et, n=1):
    global s
    if s.count(a) == n: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

# ── parámetros ──
sub('''const PERDIDA_MAX =''', '''// REGLA DEL LATERAL (LP 02/10/2026): si el papel pasa LATERAL_MIN minutos sin
// ninguna ejecución y tiene entre 1 y LATERAL_HASTA_ESC escalones cargados,
// compra un lote extra de LATERAL_FRAC × LOTE al precio. Hasta LATERAL_MAX
// extras abiertos; cada uno se vende a su costo + GANANCIA. 0 = apagada.
const LATERAL_MIN = Number(ENV.SCALP_LATERAL_MIN || 0);
const LATERAL_FRAC = Number(ENV.SCALP_LATERAL_FRAC || 0.5);
const LATERAL_MAX = Number(ENV.SCALP_LATERAL_MAX || 4);
const LATERAL_HASTA_ESC = Number(ENV.SCALP_LATERAL_HASTA_ESC || 2);
const PERDIDA_MAX =''', 'params')

# ── estado: casilleros de extras después del refuerzo ──
sub('''const NIVEL_REF = NIVELES;                       // índice del nivel del refuerzo en S.niveles
function normalizar() { while (S.niveles.length <= NIVEL_REF) S.niveles.push({ held: 0, costo: 0 }); if (S.reforzado == null) S.reforzado = false; }''',
    '''const NIVEL_REF = NIVELES;                       // índice del nivel del refuerzo en S.niveles
const EXTRA_0 = NIVELES + 1;                     // primer casillero de los extras del lateral
const esExtra = (k) => k >= EXTRA_0;
function normalizar() {
  while (S.niveles.length < EXTRA_0 + LATERAL_MAX) S.niveles.push({ held: 0, costo: 0 });
  if (S.reforzado == null) S.reforzado = false;
  if (S.ultOp == null) S.ultOp = Date.now();     // última ejecución (para la regla del lateral)
}
const heldGrilla = () => S.niveles.slice(0, NIVELES).reduce((a, n) => a + n.held, 0);''', 'estado')

# ── cada ejecución reinicia el reloj del lateral ──
sub('''  const dq = cum - o.cum; if (!(dq > 0)) return;
  const dN = cum * avg - o.cum * o.avg;''', '''  const dq = cum - o.cum; if (!(dq > 0)) return;
  S.ultOp = Date.now();
  const dN = cum * avg - o.cum * o.avg;''', 'ultOp')

# ── rueda nueva: el reloj arranca con la rueda ──
sub('''  S.dia = diaAr(); S.pnl = 0; S.rondas = 0;''', '''  S.ultOp = Date.now();
  S.dia = diaAr(); S.pnl = 0; S.rondas = 0;''', 'nuevoDia')

# ── fin de ciclo: lo define la GRILLA (puede quedar un extra abierto) ──
sub('''  if (S.ancla && tot === 0 && !vs.some((o) => o.lado === "SELL" || o.cum > 0)) {''',
    '''  const totG = heldGrilla();
  if (S.ancla && totG === 0 && S.niveles[NIVEL_REF].held === 0 && !vs.some((o) => !esExtra(o.nivel) && (o.lado === "SELL" || o.cum > 0))) {''', 'fin-ciclo')

# ── ventas: escalones y extras ──
sub('''  for (let k = 0; k < NIVELES; k++) {
    const L = S.niveles[k]; if (!(L.held > 0)) continue;''', '''  for (let k = 0; k < S.niveles.length; k++) {
    if (k === NIVEL_REF) continue;               // el refuerzo no sale solo: sale todo junto
    const L = S.niveles[k]; if (!(L.held > 0)) continue;''', 'ventas')

# ── compras de la grilla: solo miran la grilla ──
sub('''  let h = -1; S.niveles.forEach((n, k) => { if (n.held > 0) h = k; });
  const deseado = h + 1;
  const compras = vs.filter((o) => o.lado === "BUY");''', '''  let h = -1; S.niveles.forEach((n, k) => { if (k < NIVELES && n.held > 0) h = k; });
  const deseado = h + 1;
  const compras = vs.filter((o) => o.lado === "BUY" && !esExtra(o.nivel));''', 'compras')
sub('''!(c.nivel === NIVEL_REF && tot >= MAX)) await cancelar(c, "la grilla se movió");''',
    '''!(c.nivel === NIVEL_REF && totG >= MAX)) await cancelar(c, "la grilla se movió");''', 'cancel')
sub('''  if (REFUERZO_FRAC > 0 && !S.reforzado && !compras.length && S.ancla && tot >= MAX && ref.held === 0 && !pausaCompras) {''',
    '''  if (REFUERZO_FRAC > 0 && !S.reforzado && !compras.length && S.ancla && totG >= MAX && ref.held === 0 && !pausaCompras) {''', 'refuerzo-cond')
sub('''    const qtyRef = Math.round(tot * REFUERZO_FRAC);''', '''    const qtyRef = Math.round(totG * REFUERZO_FRAC);''', 'refuerzo-qty')
sub('''  if (!S.reforzado && !compras.length && deseado < NIVELES && tot + LOTE <= MAX && !pausaCompras && (deseado === 0 ? !tarde : S.ancla)) {''',
    '''  if (!S.reforzado && !compras.length && deseado < NIVELES && totG + LOTE <= MAX && !pausaCompras && (deseado === 0 ? !tarde : S.ancla)) {''', 'grilla-cond')

# ── la regla ──
sub('''  if (Date.now() - ultimoResumen > 5 * 60_000) {
    ultimoResumen = Date.now();
    log(`estado · tengo''', '''  // Regla del lateral: una hora sin ejecuciones y pocos escalones cargados → un
  // lote extra al precio (orden límite sobre la punta vendedora, para que entre).
  if (LATERAL_MIN > 0 && !S.reforzado && ref.held === 0 && !pausaCompras && !tarde && Date.now() - S.ultOp >= LATERAL_MIN * 60_000) {
    const nEsc = S.niveles.slice(0, NIVELES).filter((n) => n.held > 0).length;
    const libre = S.niveles.findIndex((n, k) => esExtra(k) && n.held === 0 && !vs.some((o) => o.nivel === k));
    const qtyX = Math.max(1, Math.round(LOTE * LATERAL_FRAC));
    if (nEsc >= 1 && nEsc <= LATERAL_HASTA_ESC && libre >= 0 && !vs.some((o) => o.lado === "BUY" && esExtra(o.nivel))) {
      S.ultOp = Date.now();                      // se ejecute o no, no vuelve a intentar hasta la próxima hora
      log(`lateral: ${LATERAL_MIN} min sin operaciones con ${nEsc} ${nEsc === 1 ? "escalón" : "escalones"} → lote extra de ${qtyX}`);
      await colocar("BUY", libre, qtyX, alTick(b.ask, "arriba"));
    }
  }
  // Una compra extra que no se ejecutó en 2 minutos se retira (el precio se fue).
  for (const o of vs) if (o.lado === "BUY" && esExtra(o.nivel) && o.cum === 0 && Date.now() - o.t > 120_000) await cancelar(o, "el extra no se ejecutó");
  if (Date.now() - ultimoResumen > 5 * 60_000) {
    ultimoResumen = Date.now();
    log(`estado · tengo''', 'regla')

# ── encabezado y chequeo de saldo ──
sub('''${REFUERZO_FRAC > 0 ? `refuerzo ${Math.round(MAX * REFUERZO_FRAC)} a −${(REFUERZO_MULT * PASO * (NIVELES - 1) * 100).toFixed(1)}% · ` : ""}''',
    '''${REFUERZO_FRAC > 0 ? `refuerzo ${Math.round(MAX * REFUERZO_FRAC)} a −${(REFUERZO_MULT * PASO * (NIVELES - 1) * 100).toFixed(1)}% · ` : ""}${LATERAL_MIN > 0 ? `lateral: ${Math.max(1, Math.round(LOTE * LATERAL_FRAC))} extra a los ${LATERAL_MIN} min (hasta ${LATERAL_MAX}, con ${LATERAL_HASTA_ESC} escalones o menos) · ` : ""}''', 'encabezado')
sub('''exposición máxima ${pesos(MAX * (1 + REFUERZO_FRAC) * b.ask)} ·''', '''exposición máxima ${pesos(EXPO_MAX * b.ask)} ·''', 'expo-log')
sub('''  if (REAL && disp != null && b.ask > 0 && disp < MAX * (1 + REFUERZO_FRAC) * b.ask * 1.01) {''',
    '''  if (REAL && disp != null && b.ask > 0 && disp < EXPO_MAX * b.ask * 1.01) {''', 'expo-chequeo')
sub('''const heldGrilla = () =>''', '''// Papeles que puede llegar a tener: grilla llena + refuerzo + extras del lateral.
const EXPO_MAX = MAX * (1 + REFUERZO_FRAC) + (LATERAL_MIN > 0 ? LATERAL_MAX * Math.max(1, Math.round(LOTE * LATERAL_FRAC)) : 0);
const heldGrilla = () =>''', 'expo-const')
sub('''  const disp = FAKE ? null : await disponible24().catch(() => null);''',
    '''  // El saldo se reintenta: con muchos bots arrancando a la vez la consulta se satura.
  let disp = null;
  for (let i = 0; !FAKE && i < 4 && disp == null; i++) { disp = await disponible24().catch(() => null); if (disp == null) await dormir(2500 + Math.random() * 2500); }''', 'disp')

# ── websocket: ping/pong ──
sub('''    ws.on("close", (c) => { if (wsConn === ws) { wsConn = null; reintentar(`close ${c}`); } });''',
    '''    // El libro de un CEDEAR puede pasar minutos sin cambiar: el pong dice que la
    // conexión vive, así no se sale a pedir el precio por REST sin necesidad.
    ws.on("pong", () => { wsUltimo = Date.now(); });
    const lat = setInterval(() => { if (wsConn !== ws) return clearInterval(lat); if (ws.readyState === 1) { try { ws.ping(); } catch { /* se cae sola */ } } }, 30_000);
    ws.on("close", (c) => { clearInterval(lat); if (wsConn === ws) { wsConn = null; reintentar(`close ${c}`); } });''', 'ping')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
