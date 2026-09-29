# -*- coding: utf-8 -*-
# Fills del paper/sombra con precios de DESPUES de crear la orden y con el libro
# del CEDEAR (29/09/2026). La validacion research/shadow-fills mostro que
# minRueda tomaba el minimo de TODA la rueda, incluido lo operado antes de que
# existiera la orden: 98 de 247 posiciones del sombra se "llenaban" sin que el
# subyacente tocara el limite con la orden viva, y explicaban +4,93M del P&L
# simulado. Con fills reales el sombra da -0,98% por operacion.
import io, sys, os
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

    sub('''const minCache = new Map();
async function minRueda(sym) {
  const hit = minCache.get(sym);
  if (hit && Date.now() - hit.t < 120000) return hit.v;
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`, { headers: UA });
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    const lows = (res?.indicators?.quote?.[0]?.low || []).filter((x) => Number.isFinite(x));
    const v = lows.length ? Math.min(...lows) : null;
    minCache.set(sym, { v, t: Date.now() });
    return v;
  } catch { return null; }
}''',
'''/* BUG CORREGIDO 29/09/2026: tomaba el minimo de TODA la rueda, incluido lo
 * que opero ANTES de que existiera la orden. Una orden creada a las 14:00 con
 * el papel arriba se "llenaba" en el acto porque a las 11:00 habia tocado el
 * nivel. Ahora solo cuentan las velas de 5 min que arrancan DESPUES de crear
 * la orden (la vela en curso al crearla se descarta: su minimo puede ser de
 * antes). Datos del paper/sombra anteriores al 30/09/2026 quedan contaminados
 * (research/shadow-fills/INFORME.md). */
const minCache = new Map();
async function minRueda(sym, desdeMs = 0) {
  const hit = minCache.get(sym);
  let velas = hit && Date.now() - hit.t < 120000 ? hit.velas : null;
  if (!velas) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`, { headers: UA });
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      const ts = res?.timestamp || [];
      const lows = res?.indicators?.quote?.[0]?.low || [];
      velas = ts.map((t, i) => ({ t: t * 1000, low: lows[i] })).filter((v) => Number.isFinite(v.low));
      minCache.set(sym, { velas, t: Date.now() });
    } catch { return null; }
  }
  const validas = velas.filter((v) => v.t >= desdeMs);
  return validas.length ? Math.min(...validas.map((v) => v.low)) : null;
}''', 'minRueda')

    sub('''      const bajo = p <= lim ? p : await minRueda(symU);
      if (!(bajo <= lim) && !fillPorIol.has(t.id)) { fillCand.delete(t.id); continue; }''',
'''      const bajo = p <= lim ? p : await minRueda(symU, Date.parse(t.created_at) || 0);
      if (!(bajo <= lim) && !fillPorIol.has(t.id)) { fillCand.delete(t.id); continue; }
      /* Paper y sombra: ademas del cruce en dolares, el CEDEAR tiene que estar
       * OFRECIDO en pesos al limite o menos en ese momento (29/09/2026). El
       * cruce del subyacente no garantiza que el CEDEAR opere ahi (SPCX 14/09).
       * Es mas estricto que la realidad (se pierde las mechas del libro local
       * entre lecturas), a proposito: mejor subestimar que inventar fills. El
       * libro real no pasa por aca: su fill lo confirma IOL. */
      if (t.modo !== "real") {
        const askArs = f.arsAsk[tkU];
        if (!(askArs > 0 && askArs <= lim * rArs)) { fillCand.delete(t.id); continue; }
      }''', 'fill')

    sub('''              fees_ars: Math.round(feesTp), pnl_ars: Math.round(pnlTp),
              intradia: intradiaTp, veredicto: pnlTp > 0 ? "acierto" : "error",
              regla_salida: "tp50_hijo",''',
'''              fees_ars: Math.round(feesTp), pnl_ars: Math.round(pnlTp),
              // La misma venta con tarifa Cocos (faltaba en las hijas: un tablero
              // que sumara pnl_ars_alt subestimaba el sombra en ~1,8M).
              fees_ars_alt: Math.round((pxArsEntTp + pxArsTp) * qtyTp * FEE_COCOS),
              pnl_ars_alt: Math.round((pxArsTp - pxArsEntTp) * qtyTp - (pxArsEntTp + pxArsTp) * qtyTp * FEE_COCOS),
              intradia: intradiaTp, veredicto: pnlTp > 0 ? "acierto" : "error",
              regla_salida: "tp50_hijo",''', 'tp_alt')
    return s

out = {n: parchar(n) for n in ['worker.js', 'worker-deploy.js']}
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
for n, s in out.items():
    io.open(os.path.join(D, n), 'w', encoding='utf-8').write(s)
print('ok')
