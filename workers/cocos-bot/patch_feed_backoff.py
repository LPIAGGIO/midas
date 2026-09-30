# -*- coding: utf-8 -*-
# cocos-bot: el feed data912 fallaba en rafagas (30/09/2026). Cuando una
# consulta fallaba el cache no se actualizaba, y CADA orden viva volvia a
# pedir el feed en la misma pasada: con 7 pendientes la sombra mandaba 6-7
# consultas en 3 segundos, justo cuando el proveedor estaba rechazando. Eso
# alimentaba el limite de consultas de data912 para toda la IP del VPS (la
# comparten niveles-auto y otros 4 workers).
#   - una sola consulta por feed cada 50 s; tras una falla, espera 60 s;
#   - se registra el codigo HTTP de la falla;
#   - respaldo: si el precio en dolares lleva mas de 150 s viejo, los papeles
#     con orden o posicion viva se consultan uno por uno en Yahoo.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''let _loc = { t: 0, m: {} };
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
}''',
'''// Una consulta por feed cada 50 s; tras una falla se espera 60 s antes de
// reintentar (sin esto, cada orden viva reintentaba en la misma pasada y se
// mandaban rafagas justo cuando el proveedor rechazaba).
async function bajarFeed(nombre, url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(12_000) });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
let _loc = { t: 0, m: {}, prox: 0 };
async function libroLocal(tk) {
  if (Date.now() >= _loc.prox) {
    try {
      const arr = await bajarFeed("arg_cedears", "https://data912.com/live/arg_cedears");
      const m = {};
      for (const it of arr || []) { const sy = String(it?.symbol || "").toUpperCase(); if (sy) m[sy] = { bid: Number(it.px_bid) || null, ask: Number(it.px_ask) || null, last: Number(it.c) || null }; }
      if (Object.keys(m).length > 50) { _loc.m = m; _loc.t = Date.now(); }
      _loc.prox = Date.now() + 50_000;
    } catch (e) { _loc.prox = Date.now() + 60_000; log(`arg_cedears: ${e.message} (uso el último dato, de hace ${Math.round((Date.now() - _loc.t) / 1000)} s)`); }
  }
  return _loc.m[tk.toUpperCase()] || null;
}''', 'libroLocal')

sub('''let _usd = { t: 0, m: {} };
async function usdPrecios() {
  if (Date.now() - _usd.t < 45_000) return _usd.m;
  try {
    const r = await fetch("https://data912.com/live/usa_stocks", { headers: UA });
    const arr = await r.json();
    const m = {};
    for (const it of arr || []) { const s = String(it?.symbol || "").toUpperCase(); if (s && Number(it.c) > 0) m[s] = Number(it.c); }
    if (Object.keys(m).length > 100) _usd = { t: Date.now(), m };
  } catch (e) { log(`usa_stocks: ${e.message}`); }
  return _usd.m;
}''',
'''let _usd = { t: 0, m: {}, prox: 0 };
async function usdPrecios() {
  if (Date.now() < _usd.prox) return _usd.m;
  try {
    const arr = await bajarFeed("usa_stocks", "https://data912.com/live/usa_stocks");
    const m = {};
    for (const it of arr || []) { const s = String(it?.symbol || "").toUpperCase(); if (s && Number(it.c) > 0) m[s] = Number(it.c); }
    if (Object.keys(m).length > 100) { _usd.m = m; _usd.t = Date.now(); }
    _usd.prox = Date.now() + 50_000;
  } catch (e) { _usd.prox = Date.now() + 60_000; log(`usa_stocks: ${e.message} (uso el último dato, de hace ${Math.round((Date.now() - _usd.t) / 1000)} s)`); }
  return _usd.m;
}
// RESPALDO: si el feed en dólares lleva más de 150 s sin actualizarse, los
// papeles con orden o posición viva se consultan de a uno en Yahoo. Así un
// stop no queda vigilado con un precio viejo si data912 se cae un rato.
const _yh = new Map();
async function usdConRespaldo(vivas) {
  const usd = await usdPrecios();
  if (Date.now() - _usd.t <= 150_000) return usd;
  const copia = { ...usd };
  for (const sym of new Set(vivas.map((v) => String(v.sym).toUpperCase()))) {
    const hit = _yh.get(sym);
    if (hit && Date.now() - hit.t < 40_000) { copia[sym] = hit.v; continue; }
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`, { headers: UA, signal: AbortSignal.timeout(8000) });
      const v = (await r.json())?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (v > 0) { _yh.set(sym, { v, t: Date.now() }); copia[sym] = v; }
    } catch { /* sigue con el dato viejo */ }
  }
  if (avisoRespaldo !== Math.floor(Date.now() / 600_000)) { avisoRespaldo = Math.floor(Date.now() / 600_000); log(`feed en dólares viejo (${Math.round((Date.now() - _usd.t) / 1000)} s): precios de Yahoo para ${[..._yh.keys()].join(", ") || "nadie"}`); }
  return copia;
}
let avisoRespaldo = null;''', 'usd')

sub('''  const usd = await usdPrecios();
  const vivas = await abiertasCocos();
  for (const t of vivas) {''',
'''  const vivas = await abiertasCocos();
  const usd = await usdConRespaldo(vivas);
  for (const t of vivas) {''', 'pasada')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
