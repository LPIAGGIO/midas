# -*- coding: utf-8 -*-
# cocos-bot: Primary limita /rest/marketdata/get por usuario (HTTP 429 el
# 30/09/2026 10:43, con la sombra y el real compartiendo el cupo). El libro
# local pasa a salir de data912 (una consulta trae todos los CEDEARs); Primary
# queda solo para el precio al VENDER en el bot real, con cache y reintento.
# La sombra no consulta precios a Primary nunca. Ademas: una señal que falla
# por un error transitorio se reintenta en vez de perderse.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

# 1) reintento ante 429 en cualquier llamada a Primary
sub('''  if ((r.status === 401 || r.status === 302) && reintento) { await token(true); return api(metodo, ruta, false); }''',
'''  if ((r.status === 401 || r.status === 302) && reintento) { await token(true); return api(metodo, ruta, false); }
  if (r.status === 429 && reintento) { await new Promise((ok) => setTimeout(ok, 3000)); return api(metodo, ruta, false); }''', '429')

# 2) libro: local (data912) por defecto, Primary solo cuando hace falta precision
sub('''async function libro(tk) {
  const j = await api("GET", `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: simbolo(tk), entries: "BI,OF,LA", depth: 1 })}`);
  const md = j?.marketData || {};
  return { bid: Number(md.BI?.[0]?.price) || null, ask: Number(md.OF?.[0]?.price) || null, last: Number(md.LA?.price) || null };
}''',
'''/* LIBRO LOCAL. Primary limita /rest/marketdata/get POR USUARIO (HTTP 429 el
 * 30/09/2026, con el bot real y la sombra compartiendo el cupo). Por eso:
 *  - por defecto el libro sale de data912 (una consulta trae bid/ask/último de
 *    TODOS los CEDEARs, cache 20 s): alcanza para dimensionar, calcular el
 *    ratio y ver si el dólar corrió el límite;
 *  - Primary (preciso=true) solo para poner el precio de una VENTA del bot
 *    real y para la prueba de plomería, con cache de 8 s;
 *  - la sombra NUNCA le pide precios a Primary: no le gasta cupo al real. */
let _loc = { t: 0, m: {} };
async function libroLocal(tk) {
  if (Date.now() - _loc.t > 20_000) {
    try {
      const r = await fetch("https://data912.com/live/arg_cedears", { headers: UA });
      const arr = await r.json();
      const m = {};
      for (const it of arr || []) { const sy = String(it?.symbol || "").toUpperCase(); if (sy) m[sy] = { bid: Number(it.px_bid) || null, ask: Number(it.px_ask) || null, last: Number(it.c) || null }; }
      if (Object.keys(m).length > 50) _loc = { t: Date.now(), m };
    } catch (e) { log(`arg_cedears: ${e.message}`); }
  }
  return _loc.m[tk.toUpperCase()] || null;
}
const _libP = new Map();
async function libroPrimary(tk) {
  const hit = _libP.get(tk);
  if (hit && Date.now() - hit.t < 8000) return hit.v;
  const j = await api("GET", `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: simbolo(tk), entries: "BI,OF,LA", depth: 1 })}`);
  const md = j?.marketData || {};
  const v = { bid: Number(md.BI?.[0]?.price) || null, ask: Number(md.OF?.[0]?.price) || null, last: Number(md.LA?.price) || null };
  _libP.set(tk, { v, t: Date.now() });
  return v;
}
async function libro(tk, preciso = false) {
  const vacio = { bid: null, ask: null, last: null };
  if (SOMBRA) return (await libroLocal(tk)) || vacio;
  if (preciso) { try { return await libroPrimary(tk); } catch (e) { log(`[cocos ${tk}] libro Primary: ${e.message} — uso data912`); return (await libroLocal(tk)) || vacio; } }
  const loc = await libroLocal(tk);
  if (loc && (loc.last > 0 || loc.bid > 0)) return loc;
  return libroPrimary(tk);
}''', 'libro')

# 3) sitios que necesitan el libro de Primary (ventas y prueba)
sub('''    const lb = await libro(tk);
    const ref = lb.bid || lb.last;''', '''    const lb = await libro(tk, true);
    const ref = lb.bid || lb.last;''', 'prueba')
sub('''      const lb = await libro(tk);
      if (lb.bid > 0 && lb.bid < s.pxArs) {''', '''      const lb = await libro(tk, true);
      if (lb.bid > 0 && lb.bid < s.pxArs) {''', 'rebajar')
sub('''const lb = await libro(tk); const px = alTick(Math.min(nivel * ratio''', '''const lb = await libro(tk, true); const px = alTick(Math.min(nivel * ratio''', 'tp')
sub('''  const lb = await libro(tk);
  const teorico''', '''  const lb = await libro(tk, true);
  const teorico''', 'salida')

# 4) una señal que falla por error transitorio se reintenta
sub('''    await entrar(r, tk, riskMult);
  }''', '''    try { await entrar(r, tk, riskMult); }
    catch (e) {
      const n = (reintentos.get(r.id) || 0) + 1; reintentos.set(r.id, n);
      log(`[señal ${tk}] error al entrar (${e.message})${n < 5 ? " — reintento en la próxima pasada" : " — abandono"}`);
      if (n < 5) { vistas.delete(r.id); vistas.delete(clave); }
    }
  }''', 'reintento')
sub('''const vistas = new Set();          // ids de filas shadow ya evaluadas''',
'''const vistas = new Set();          // ids de filas shadow ya evaluadas
const reintentos = new Map();      // id de señal → intentos fallidos por error transitorio''', 'estado')

# 5) la sombra toma las señales de toda la rueda de hoy (su fill exige cruce
#    actual, no mira para atras); el real solo las posteriores a su arranque.
sub('''let arranque = new Date().toISOString();''',
'''let arranque = new Date().toISOString();
if (SOMBRA) { const d = new Date(); d.setUTCHours(13, 30, 0, 0); if (d.getTime() < Date.now()) arranque = d.toISOString(); }''', 'arranque')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
