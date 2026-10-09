# -*- coding: utf-8 -*-
# cocos-scalp/worker.js (09/10/2026): esHabil() no sabía de feriados; el lunes
# 12/10 (feriado) los bots iban a arrancar la rueda, mandar ventas que el
# mercado rechaza y frenarse con 5 rechazos y 20 avisos. Ahora no operan en los
# días de SCALP_FERIADOS (lista AAAA-MM-DD en .env, separada por comas) ni en
# el 12/10/2026.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
a = '''const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5; };'''
b = '''const FERIADOS = new Set(["2026-10-12", ...String(ENV.SCALP_FERIADOS || "").split(/[ ,]+/).filter(Boolean)]);
const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5 && !FERIADOS.has(diaAr()); };'''
if s.count(a) != 1 or s.count('const ENV = leerEnv();') != 1 or s.index('const ENV = leerEnv();') > s.index(a):
    print('FALLOS, no escribo nada'); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s.replace(a, b)); print('ok')
