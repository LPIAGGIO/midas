# -*- coding: utf-8 -*-
# niveles-auto: si data912 falla (HTTP 500/502 o timeout, 30/09/2026 en
# rafagas de 4 min), botFeeds devolvia listas vacias y la pasada salteaba
# TODAS las posiciones ("sin precio local"): stops sin vigilar mientras durara
# la racha. Ahora cada feed conserva su ultimo dato bueno hasta 5 minutos y el
# codigo HTTP queda en el log. El relleno de Yahoo para el precio en dolares
# ya existia.
import io, os, sys
D = os.path.dirname(os.path.abspath(__file__))
fallos = []
def parchar(nombre):
    ruta = os.path.join(D, nombre)
    s = io.open(ruta, encoding='utf-8').read()
    def sub(a, b, et):
        nonlocal s
        n = s.count(a)
        if n == 1: s = s.replace(a, b)
        else: fallos.append('%s %s (%d)' % (nombre, et, n))
    sub('''async function botFeeds() {
  const [dol, ced, loc, usa] = await Promise.all([
    fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).then((r) => r.json()).catch(() => null),
    fetch("https://data912.com/live/arg_cedears", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/arg_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
    fetch("https://data912.com/live/usa_stocks", { headers: UA }).then((r) => r.json()).catch(() => []),
  ]);''',
'''/* Feeds de data912 con RESPALDO (30/09/2026): el proveedor fallo en rafagas
 * de varios minutos (HTTP 500/502 y timeouts) y cada falla dejaba la pasada
 * sin precio local para TODAS las posiciones. Cada feed guarda su ultimo
 * dato bueno y lo reusa hasta 5 minutos; el motivo queda en el log. */
const _feedCache = { ced: { t: 0, v: [] }, loc: { t: 0, v: [] }, usa: { t: 0, v: [] } };
async function feedData912(nombre, url) {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!Array.isArray(j) || j.length < 10) throw new Error("respuesta vacia");
    _feedCache[nombre] = { t: Date.now(), v: j };
    return j;
  } catch (e) {
    const c = _feedCache[nombre], edad = Date.now() - c.t;
    if (c.v.length && edad < 5 * 60_000) { log(`[feed] ${nombre}: ${e.message} — uso el ultimo dato bueno (${Math.round(edad / 1000)} s)`); return c.v; }
    log(`[feed] ${nombre}: ${e.message} y sin dato reciente`);
    return [];
  }
}
async function botFeeds() {
  const [dol, ced, loc, usa] = await Promise.all([
    fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).then((r) => r.json()).catch(() => null),
    feedData912("ced", "https://data912.com/live/arg_cedears"),
    feedData912("loc", "https://data912.com/live/arg_stocks"),
    feedData912("usa", "https://data912.com/live/usa_stocks"),
  ]);''', 'botFeeds')
    return s
out = {n: parchar(n) for n in ['worker.js', 'worker-deploy.js']}
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
for n, s in out.items():
    io.open(os.path.join(D, n), 'w', encoding='utf-8').write(s)
print('ok')
