# -*- coding: utf-8 -*-
# Fundamentals: crecimiento de varios años, dilución, SBC y crecimiento
# esperado (filtro estilo Lynch, 29/09/2026). Mismo bloque en el worker del
# snapshot y en el endpoint en vivo, que ya duplicaban el fetch.
import io, sys
BLOQUE = io.open(r'C:\Users\slider\AppData\Local\Temp\claude\C--Users-slider-Documents-Claude\141311fc-87b6-49b3-a2d5-e68670178813\scratchpad\lynch_fetch.js', encoding='utf-8').read()
BASE = r'C:\Users\slider\Documents\Claude\Projects\Midas'
fallos = []

def parchar(ruta):
    s = io.open(ruta, encoding='utf-8').read()
    def sub(a, b, nombre):
        nonlocal s
        n = s.count(a)
        if n == 1: s = s.replace(a, b)
        else: fallos.append('%s %s (%d)' % (ruta[-30:], nombre, n))
    sub('const MODULES = "summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents";',
        'const MODULES = "summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,earningsTrend";', 'modules')
    sub('''  const r = await fetch(u, { headers: { "User-Agent": UA, "Cookie": auth.cookie } });
  const j = await r.json();
  const res = j?.quoteSummary?.result?.[0];''',
'''  // La serie anual va en paralelo; si falla, la fila sale igual sin las
  // columnas de varios años.
  const [r, by] = await Promise.all([
    fetch(u, { headers: { "User-Agent": UA, "Cookie": auth.cookie } }),
    fetchSerie(t, auth).catch(() => ({})),
  ]);
  const j = await r.json();
  const res = j?.quoteSummary?.result?.[0];''', 'fetchOne')
    sub('''    payDate: raw(ce.dividendDate),
  };''', '''    payDate: raw(ce.dividendDate),
    ...lynchDe(by, fd, res.earningsTrend),
  };''', 'campos')
    sub('''const raw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));
''', '''const raw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));

''' + BLOQUE, 'bloque')
    return s

out = {p: parchar(BASE + '\\' + p) for p in ['workers\\fundamentals-snapshot\\worker.js', 'api\\fundamentals.js']}
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
for p, s in out.items():
    io.open(BASE + '\\' + p, 'w', encoding='utf-8').write(s)
print('ok')
