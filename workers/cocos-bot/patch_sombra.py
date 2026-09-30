# -*- coding: utf-8 -*-
# cocos-bot: libro 'cocos_sombra' = misma maquinaria, SIN filtro de señales y
# SIN ordenes reales (forzado por codigo), para comparar al fin del dia
# (pedido de LP 30/09/2026: "simula en paralelo espejado un shadow").
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et, todas=False):
    global s
    n = s.count(a)
    if todas and n >= 1: s = s.replace(a, b)
    elif n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''const USER_ID = ENV.COCOS_BOT_USER || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const REAL = ENV.COCOS_BOT_REAL === "1";
const PROBAR = ENV.COCOS_BOT_PROBAR !== "0";''',
'''const USER_ID = ENV.COCOS_BOT_USER || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
/* LIBRO: 'cocos' = el bot real. 'cocos_sombra' = la misma maquinaria SIN
 * filtro de señales (toma todo soporte con stop y target válidos, como el
 * sombra de IOL) y SIN órdenes reales: REAL queda en false por código, no
 * por configuración, así una instancia sombra nunca puede operar. Sirve para
 * comparar al fin del día filtro contra sin filtro con las reglas de Cocos. */
const LIBRO = ENV.COCOS_BOT_LIBRO === "cocos_sombra" ? "cocos_sombra" : "cocos";
const SOMBRA = LIBRO === "cocos_sombra";
const REAL = !SOMBRA && ENV.COCOS_BOT_REAL === "1";
const PROBAR = !SOMBRA && ENV.COCOS_BOT_PROBAR !== "0";
const TG_ON = !SOMBRA && ENV.COCOS_BOT_TG !== "0";''', 'libro')
sub('''async function tg(texto) {
  if (!ENV.TELEGRAM_BOT_TOKEN) return;''', '''async function tg(texto) {
  if (!TG_ON || !ENV.TELEGRAM_BOT_TOKEN) return;''', 'tg')
sub('''.eq("modo", "cocos")''', '''.eq("modo", LIBRO)''', 'modo-queries', todas=True)
sub('''    modo: "cocos", perfil: "cocos", ratio: Math.round(ratio * 100) / 100, px_ars_orden: limArs,''',
'''    modo: LIBRO, perfil: "cocos", ratio: Math.round(ratio * 100) / 100, px_ars_orden: limArs,''', 'insert-entrada')
sub('''px_ars_entrada: pxEnt, exit_reason: "tp_parcial", regla_salida: "tp50_hijo"''', '''px_ars_entrada: pxEnt, exit_reason: "tp_parcial", regla_salida: "tp50_hijo"''', 'hijo-anchor')
sub('''modo: "cocos", perfil: "cocos", ratio: t.ratio, px_ars_entrada: pxEnt''', '''modo: LIBRO, perfil: "cocos", ratio: t.ratio, px_ars_entrada: pxEnt''', 'insert-hijo')
sub('''    let riskMult = 1;
    if (r.modo === "shadow") {''', '''    let riskMult = 1;
    if (SOMBRA) {
      // sin filtro: solo universo y que sea CEDEAR (ya chequeado arriba)
    } else if (r.modo === "shadow") {''', 'filtro')
sub('''    if (faltas.length) { log(`[señal ${tk}] no califica: ${faltas.join(" · ")}`); continue; }
    if (await earningsCerca(tk)) { log(`[señal ${tk}] no califica: balance en 3 días`); continue; }''',
'''    if (faltas.length) { log(`[señal ${tk}] no califica: ${faltas.join(" · ")}`); continue; }
    if (!SOMBRA && await earningsCerca(tk)) { log(`[señal ${tk}] no califica: balance en 3 días`); continue; }''', 'earnings')
sub('''  const perd = await perdidaHoy(vivas, usd);
  if (perd <= -PERDIDA_DIA) {''', '''  const perd = await perdidaHoy(vivas, usd);
  if (PERDIDA_DIA > 0 && perd <= -PERDIDA_DIA) {''', 'freno')
sub('''  if (!(await botHabilitado())) {''', '''  if (!SOMBRA && !(await botHabilitado())) {''', 'llave')
sub('''  log(`cocos-bot arrancando · ${REAL ? "*** ORDENES REALES ***" : "simulado (COCOS_BOT_REAL≠1)"}''',
'''  log(`cocos-bot arrancando · libro ${LIBRO}${SOMBRA ? " (SIN FILTRO)" : ""} · ${REAL ? "*** ORDENES REALES ***" : "simulado (sin órdenes reales)"}''', 'log')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok', s.count('LIBRO'))
