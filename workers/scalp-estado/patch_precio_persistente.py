# -*- coding: utf-8 -*-
# scalp-estado/worker.js (08/10/2026): a las 18:13 la pantalla Bot Scalping
# mostró latente $0 y el resultado del 08/10 en +1.175.710 (era −1.982.355).
# El proceso se reinicia por memoria (max_memory_restart 200M, 830 reinicios);
# al arrancar el último precio vive solo en memoria, y si data912 no contesta
# en esa pasada publica sin precio: latente 0 y lo graba como latente_cierre.
# Ahora:
#  - el último precio bueno de cada papel se guarda en precios-ult.json y se
#    usa cuando data912 no trae ese papel (se mezcla papel por papel);
#  - sin precio no se escribe latente (null en scalp_estado) y esa fila no
#    pisa scalp_resultados;
#  - scalp_resultados se escribe solo hasta las 17:30: el cierre queda quieto.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''let _feed = { t: 0, m: {} };
async function precios() {
  if (Date.now() - _feed.t < 25_000) return _feed.m;
  try {
    const r = await fetch("https://data912.com/live/arg_cedears", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
    if (r.status === 200) {
      const m = {};
      for (const x of await r.json()) if (x?.symbol) m[String(x.symbol).toUpperCase()] = { bid: Number(x.px_bid) || null, ask: Number(x.px_ask) || null, last: Number(x.c) || null };
      if (Object.keys(m).length > 50) _feed = { t: Date.now(), m };
    }
  } catch { /* se usa el último dato */ }
  return _feed.m;
}''',
'''// Último precio bueno por papel, en disco: sobrevive a los reinicios.
const ARCH_PX = path.join(__dirname, "precios-ult.json");
let _feed = { t: 0, m: {} };
try { _feed.m = JSON.parse(fs.readFileSync(ARCH_PX, "utf8")); } catch { /* primera vez */ }
async function precios() {
  if (Date.now() - _feed.t < 25_000) return _feed.m;
  try {
    const r = await fetch("https://data912.com/live/arg_cedears", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
    if (r.status === 200) {
      const lista = await r.json();
      if (Array.isArray(lista) && lista.length > 50) {
        const m = { ..._feed.m };
        for (const x of lista) {
          if (!x?.symbol) continue;
          const p = { bid: Number(x.px_bid) || null, ask: Number(x.px_ask) || null, last: Number(x.c) || null };
          if (p.last || p.bid) m[String(x.symbol).toUpperCase()] = p;     // sin precio: queda el anterior
        }
        _feed = { t: Date.now(), m };
        try { fs.writeFileSync(ARCH_PX, JSON.stringify(m)); } catch { /* no es grave */ }
      }
    }
  } catch { /* se usa el último dato */ }
  return _feed.m;
}''', 'precios')

sub('''      latente: tenencia > 0 && ref ? Math.round(tenencia * ref - costo) : 0,''',
    '''      latente: tenencia > 0 ? (ref ? Math.round(tenencia * ref - costo) : null) : 0,''', 'latente-estado')

sub('''    const latente = tenencia > 0 && ref ? Math.round(tenencia * ref - costo) : 0;''',
    '''    if (tenencia > 0 && !ref) continue;                       // sin precio no se pisa el resultado guardado
    const latente = tenencia > 0 ? Math.round(tenencia * ref - costo) : 0;''', 'latente-resultado')

sub('''  if (dow >= 1 && dow <= 5 && hhmmAr() >= 1035) {''',
    '''  // Hasta las 17:30: después el cierre queda quieto (no lo pisa una pasada sin precio).
  if (dow >= 1 && dow <= 5 && hhmmAr() >= 1035 && hhmmAr() <= 1730 && resultados.length) {''', 'ventana')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
