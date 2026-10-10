# -*- coding: utf-8 -*-
# cocos-scalp/worker.js — decisiones de LP del viernes 09/10/2026, rigen desde el
# martes 13/10 (lunes feriado). Tres reglas nuevas, todas por .env:
#
#  1) REGLA G (SCALP_APERTURA_BAJA, p. ej. 0.01): con SCALP_HORA_COMPRAS=1200, el
#     bot solo vende hasta las 12 SALVO que el papel abra ese porcentaje (o más)
#     abajo del cierre anterior: ahí compra desde la apertura. El cierre anterior
#     se guarda al cerrar la rueda (S.cierrePrev) y, si falta (primer día), se
#     pide a Primary (entrada CL). Medido en research/scalp/apertura_bajista.py.
#
#  2) VENDER LO VERDE (SCALP_CIERRE_VERDE=1645, solo la 3893): a esa hora, si el
#     papel está en ganancia neta de comisiones a la punta compradora, cancela
#     todo y vende todo a la punta (hasta 4 intentos; si deja de estar en verde,
#     se queda con los papeles). Al día siguiente la primera compra queda apoyada
#     un escalón abajo del precio de esa venta hasta las 16:40; si no bajó, entra
#     al precio (a la punta vendedora) antes de las 16:45. Medido en
#     research/scalp/mejor_idea.py y horario_cierre.py (16:45 fue la mejor hora).
#
#  3) El escalón nuevo va por .env (SCALP_PASO/GANANCIA): los ciclos abiertos
#     terminan con el suyo (ya estaba así desde el 07/10).
#
#  Además: reloj simulado para el modo FAKE (SCALP_FAKE=1): arranca en
#  SCALP_FAKE_HORA (10:31), avanza un minuto por ciclo y pasa al día hábil
#  siguiente después de las 17:05. Así se prueban varias ruedas en segundos.
#  No cambia nada con órdenes reales.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

# ── parámetros ──
sub('''const CIERRE_VENDE = ENV.SCALP_CIERRE_VENDE === "1";    // por defecto NO vende al cierre: arrastra''',
    '''const CIERRE_VENDE = ENV.SCALP_CIERRE_VENDE === "1";    // por defecto NO vende al cierre: arrastra
// VENDER LO VERDE (LP 09/10/2026): a esta hora (hhmm) vende todo el papel si está en
// ganancia neta a la punta compradora; 0 = apagado. Al día siguiente reentra un
// escalón abajo del precio de venta (hasta CIERRE_VERDE_REENTRADA) o, si no bajó, al precio.
const CIERRE_VERDE = Number(ENV.SCALP_CIERRE_VERDE || 0);
const CIERRE_VERDE_REENTRADA = Number(ENV.SCALP_CIERRE_VERDE_REENTRADA || 1640);
// REGLA G (LP 09/10/2026): con HORA_COMPRAS > HORA_INICIO, si el papel abre este
// porcentaje (o más) abajo del cierre anterior, compra desde la apertura. 0 = apagada.
const APERTURA_BAJA = Number(ENV.SCALP_APERTURA_BAJA || 0);''', 'parametros')

# ── reloj FAKE ──
sub('''const CICLO_MS = FAKE ? 10 : 4000;''',
    '''const CICLO_MS = FAKE ? 10 : 4000;
// Reloj de la simulación: un minuto por ciclo desde SCALP_FAKE_HORA; después de
// las 17:05 pasa al día hábil siguiente a la misma hora de arranque.
let fakeMin = 0, fakeDias = 0;
const fakeHm = () => { const b = Number(process.env.SCALP_FAKE_HORA || 1031); const m = Math.floor(b / 100) * 60 + (b % 100) + fakeMin; return Math.floor(m / 60) * 100 + (m % 60); };
const fakeTick = () => { fakeMin++; if (fakeHm() >= 1705) { fakeMin = 0; fakeDias++; } };
const fakeDia = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })); let n = fakeDias; while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() >= 1 && d.getDay() <= 5) n--; } return d.toLocaleDateString("en-CA"); };''', 'reloj fake')

sub('''const diaAr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const hhmmAr = () => { const s = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }); return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5)); };''',
    '''const diaAr = () => (FAKE ? fakeDia() : new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }));
const hhmmAr = () => { if (FAKE) return fakeHm(); const s = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }); return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5)); };''', 'reloj')

sub('''const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5 && !FERIADOS.has(diaAr()); };''',
    '''const esHabil = () => { if (FAKE) return true; const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5 && !FERIADOS.has(diaAr()); };''', 'habil')

# ── cierre anterior por Primary (entrada CL), para la regla G el primer día ──
sub('''async function disponible24() {''',
    '''// Cierre de la rueda anterior según Primary (entrada CL). Respaldo de S.cierrePrev.
async function cierreAnterior() {
  if (FAKE) return null;
  const j = await api("GET", `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: simbolo(), entries: "CL", depth: 1 })}`);
  return Number(j?.marketData?.CL?.price) || null;
}
async function disponible24() {''', 'cierre anterior')

# ── cerrarDia guarda el cierre ──
sub('''  const n = heldTot(), costo = S.niveles.reduce((a, x) => a + x.costo, 0);
  S.fin = n ? `cierre de la rueda: quedan ${n} papeles abiertos para mañana (costo ${pesos(costo)})` : "cierre de la rueda: sin papeles";
  guardar();''',
    '''  const n = heldTot(), costo = S.niveles.reduce((a, x) => a + x.costo, 0);
  S.fin = n ? `cierre de la rueda: quedan ${n} papeles abiertos para mañana (costo ${pesos(costo)})` : "cierre de la rueda: sin papeles";
  const bc = await libro().catch(() => null);                       // cierre de hoy, para la regla G de mañana
  if (bc && (bc.last > 0 || bc.bid > 0)) S.cierrePrev = bc.last || bc.bid;
  guardar();''', 'cerrarDia')

# ── nuevoDia: regla G y reentrada después de vender lo verde ──
sub('''  guardar();
  log(`arranco la rueda con ${n} papeles de ayer · ancla ${S.ancla ? pesos(S.ancla) : "—"}${HORA_COMPRAS > HORA_INICIO ? ` · hasta las ${HORA_COMPRAS} solo vendo, no compro` : ""}`);
}''',
    '''  // Regla G: ¿abrió APERTURA_BAJA abajo del cierre anterior? Entonces compra desde ya.
  S.horaCompras = HORA_COMPRAS;
  if (APERTURA_BAJA > 0 && HORA_COMPRAS > HORA_INICIO) {
    let prev = S.cierrePrev > 0 ? S.cierrePrev : null;
    if (!prev) prev = await cierreAnterior().catch((e) => { log(`cierre anterior: ${e.message}`); return null; });
    const b0 = await libro();
    const ref = b0.bid > 0 ? b0.bid : b0.last;
    if (prev > 0 && ref > 0) {
      const var_ = ref / prev - 1;
      if (var_ <= -APERTURA_BAJA) { S.horaCompras = HORA_INICIO; log(`abre ${(var_ * 100).toFixed(2)}% contra el cierre anterior ${pesos(prev)}: compro desde la apertura (regla G)`); }
      else log(`abre ${(var_ * 100).toFixed(2)}% contra el cierre anterior ${pesos(prev)}: compro desde las ${HORA_COMPRAS}`);
    } else log(`sin cierre anterior o sin libro: compro desde las ${HORA_COMPRAS}`);
  }
  // Vendió lo verde ayer: la primera compra queda un escalón abajo de ese precio
  // hasta CIERRE_VERDE_REENTRADA; si no bajó, entra al precio (ver la compra del escalón 1).
  if (S.cierreVerde && S.cierreVerde.dia !== diaAr() && n === 0) {
    S.reentrada = { px: alTick(S.cierreVerde.px * (1 - PASO), "abajo"), hastaHm: CIERRE_VERDE_REENTRADA, dia: diaAr(), verde: true };
    log(`ayer vendí lo verde a ${pesos(S.cierreVerde.px)}: reentro un escalón abajo, a ${pesos(S.reentrada.px)}, hasta las ${CIERRE_VERDE_REENTRADA}; si no baja, al precio`);
    S.cierreVerde = null;
  }
  guardar();
  log(`arranco la rueda con ${n} papeles de ayer · ancla ${S.ancla ? pesos(S.ancla) : "—"}${S.horaCompras > HORA_INICIO ? ` · hasta las ${S.horaCompras} solo vendo, no compro` : ""}`);
}

/* Vender lo verde (LP 09/10/2026): si el papel está en ganancia neta a la punta
 * compradora, cancela todo y lo vende entero a la punta. Si mientras tanto deja
 * de estar en verde, se queda con los papeles (siguen con sus ventas). */
async function venderVerde(b) {
  const costoDe = () => S.niveles.reduce((a, n) => a + n.costo, 0);
  const verde = (bid) => { const t = heldTot(), c = costoDe(); return t * bid - c - FEE * (t * bid + c); };
  const g0 = verde(b.bid);
  if (g0 <= 0) { log(`${CIERRE_VERDE}: no está en verde (${pesos(g0)} neto a ${pesos(b.bid)}): sigo con los ${heldTot()} papeles`); return; }
  log(`${CIERRE_VERDE}: VENDO LO VERDE · ${heldTot()} papeles · ${pesos(g0)} neto a la punta ${pesos(b.bid)}`);
  for (let i = 0; i < 12 && vivas().length; i++) { for (const o of vivas()) { o.cancelT = 0; await cancelar(o, "vender lo verde"); } await dormir(2500); await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`)); }
  const desde = Date.now();
  for (let intento = 0; intento < 4 && heldTot() > 0; intento++) {
    const bb = await libro();
    if (!(bb.bid > 0)) { await dormir(5000); continue; }
    if (verde(bb.bid) <= 0) { log(`dejó de estar en verde a ${pesos(bb.bid)}: me quedo con los ${heldTot()} papeles`); break; }
    const tot = heldTot(), costo = costoDe();
    S.niveles.forEach((n, k) => { n.held = k === 0 ? tot : 0; n.costo = k === 0 ? costo : 0; });
    await colocar("SELL", 0, tot, alTick(bb.bid, "abajo"));
    for (let i = 0; i < 8 && vivas().length; i++) { await dormir(2500); await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`)); }
    for (const o of vivas()) { o.cancelT = 0; await cancelar(o, "reintento de vender lo verde"); }
    await dormir(2500); await sincronizar(await libro()).catch(() => {});
  }
  const ventas = S.ordenes.filter((o) => o.lado === "SELL" && o.t >= desde && o.cum > 0);
  const qv = ventas.reduce((a, o) => a + o.cum, 0), pv = qv ? ventas.reduce((a, o) => a + o.cum * o.avg, 0) / qv : null;
  if (heldTot() === 0 && pv) {
    S.cierreVerde = { px: pv, dia: diaAr() };
    S.ancla = null; S.reforzado = false; S.reentrada = null;
    log(`vendí lo verde: ${qv} papeles a ${pesos(pv)} · P&L del día ${pesos(S.pnl)} · mañana reentro un escalón abajo`);
  } else log(`vender lo verde: quedan ${heldTot()} papeles (vendí ${qv}); siguen con su venta normal`);
  guardar();
}''', 'nuevoDia + venderVerde')

# ── ciclo: tick del reloj FAKE, disparo de vender lo verde, hora de compras del día, reentrada ──
sub('''async function ciclo() {
  if (S.dia !== diaAr()) {''',
    '''async function ciclo() {
  if (FAKE) fakeTick();
  if (S.dia !== diaAr()) {''', 'ciclo tick')

sub('''  if (!(b.bid > 0) || !(b.ask > 0)) return;                       // sin libro no se decide nada
  const tot = heldTot();''',
    '''  if (!(b.bid > 0) || !(b.ask > 0)) return;                       // sin libro no se decide nada
  if (CIERRE_VERDE > 0 && hm >= CIERRE_VERDE && S.verdeDia !== diaAr()) {
    S.verdeDia = diaAr(); guardar();
    if (heldTot() > 0) return venderVerde(b);
  }
  const tot = heldTot();''', 'ciclo verde')

sub('''  const enReentrada = S.reentrada && Date.now() < S.reentrada.hasta;
  const tarde = hm >= HORA_ULTIMO_CICLO;
  const temprano = hm < HORA_COMPRAS;            // todavía solo se vende lo arrastrado''',
    '''  // La reentrada por hora (después de vender lo verde) vale hasta hastaHm de ese día; la de REANCLA, por tiempo.
  const enReentrada = !!S.reentrada && (S.reentrada.hastaHm ? (S.reentrada.dia === diaAr() && hm < S.reentrada.hastaHm) : Date.now() < S.reentrada.hasta);
  const alPrecioCierre = !!S.reentrada && S.reentrada.verde && S.reentrada.dia === diaAr() && !enReentrada;   // no bajó: entra al precio
  const tarde = hm >= HORA_ULTIMO_CICLO;
  const temprano = hm < (S.horaCompras || HORA_COMPRAS);   // todavía solo se vende lo arrastrado''', 'ciclo reentrada')

# OJO: el `else` de la línea siguiente pertenece a este `if`; va con llaves para no
# dejarlo colgado de otro if (la primera versión mandaba compras a precio 0).
sub('''    if (deseado === 0) px = enReentrada && b.bid > S.reentrada.px ? S.reentrada.px : b.bid;
    else px = Math.min(alTick(S.ancla * (1 - pasoC() * deseado), "abajo"), b.ask);''',
    '''    if (deseado === 0) {
      px = enReentrada && b.bid > S.reentrada.px ? S.reentrada.px : alPrecioCierre ? alTick(b.ask, "arriba") : b.bid;
      if (alPrecioCierre) log(`no bajó al escalón de reentrada ${pesos(S.reentrada.px)}: entro al precio de cierre`);
    } else px = Math.min(alTick(S.ancla * (1 - pasoC() * deseado), "abajo"), b.ask);''', 'compra reentrada')

sub('''  const o = { id: null, lado, nivel, qty, px, cum: 0, avg: 0, final: false, t: Date.now(), duda: false };
  try {''',
    '''  const o = { id: null, lado, nivel, qty, px, cum: 0, avg: 0, final: false, t: Date.now(), duda: false };
  // Seguro (09/10/2026, lo atrapó el banco de prueba): nunca mandar un precio o cantidad inválidos.
  if (!(px > 0) || !(qty > 0) || !Number.isFinite(px)) { rechazos++; log(`ERROR orden ${lado} escalón ${nivel + 1} con precio/cantidad inválidos (${qty} × ${px}): no la mando`); return; }
  try {''', 'seguro precio')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
