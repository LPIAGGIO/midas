# -*- coding: utf-8 -*-
# niveles-auto (12/10/2026): el bot no sabía de feriados argentinos. Con EE.UU.
# abierto y BYMA cerrado corrió todo el día y mandó dos compras reales a IOL
# (XOM y COIN), que quedaron "Iniciada" para la rueda siguiente. Todo lo que
# corre en rueda (bot real, sombra, rearme de alertas, encolado) pasa por
# inUsMarketWindow(): acá se le agrega la lista de feriados de BYMA. Más días
# por .env: IOL_BOT_FERIADOS=AAAA-MM-DD,AAAA-MM-DD.
# Se aplica a worker-deploy.js (el que corre en el VPS) y a worker.js (el del
# repo), los dos, como pide el CLAUDE.md.
import io, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__))
A = '''function inUsMarketWindow() {
  const ar = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const dow = ar.getDay(), mins = ar.getHours() * 60 + ar.getMinutes();
  return dow >= 1 && dow <= 5 && mins >= 10 * 60 + 30 && mins <= 17 * 60;
}'''
B = '''// Feriados de BYMA (12/10/2026: el bot operó un feriado con EE.UU. abierto).
// Los que faltan del calendario se agregan por .env sin tocar el código.
const FERIADOS_BYMA = new Set([
  "2026-10-12", "2026-11-20", "2026-12-08", "2026-12-25",
  "2027-01-01", "2027-02-15", "2027-02-16", "2027-03-24", "2027-03-25", "2027-03-26", "2027-04-02", "2027-05-01", "2027-05-25",
  ...String(process.env.IOL_BOT_FERIADOS || "").split(/[ ,]+/).filter(Boolean),
]);
function inUsMarketWindow() {
  const ar = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const dow = ar.getDay(), mins = ar.getHours() * 60 + ar.getMinutes();
  const iso = ar.toLocaleDateString("en-CA");
  if (FERIADOS_BYMA.has(iso)) return false;
  return dow >= 1 && dow <= 5 && mins >= 10 * 60 + 30 && mins <= 17 * 60;
}'''
ok = True
for nombre in ('worker-deploy.js', 'worker.js'):
    p = os.path.join(AQUI, nombre)
    s = io.open(p, encoding='utf-8').read()
    n = s.count(A)
    if n != 1:
        print('%s: ancla %d veces, no toco nada' % (nombre, n)); ok = False
if not ok:
    sys.exit(1)
for nombre in ('worker-deploy.js', 'worker.js'):
    p = os.path.join(AQUI, nombre)
    s = io.open(p, encoding='utf-8').read().replace(A, B)
    io.open(p, 'w', encoding='utf-8').write(s)
    print('%s: ok' % nombre)
