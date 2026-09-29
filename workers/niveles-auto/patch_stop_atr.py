# -*- coding: utf-8 -*-
# Stop a 1,5 x ATR(14) fijo en el libro real (pedido de LP 29/09/2026:
# "correle el stop a todo. que quede siempre seteado a 1,5 atr").
# Se aplica igual al repo (worker.js) y al artefacto que corre en el VPS
# (worker-deploy.js); si algun reemplazo no calza en alguno, no escribe nada.
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

    sub('''const SALIDA_CONFIRM_MS = Number(process.env.IOL_BOT_SALIDA_CONFIRM_MS || 10 * 60 * 1000);''',
'''const SALIDA_CONFIRM_MS = Number(process.env.IOL_BOT_SALIDA_CONFIRM_MS || 10 * 60 * 1000);

/* STOP A 1,5 x ATR (decision de LP 29/09/2026: "correle el stop a todo. que
 * quede siempre seteado a 1,5 atr"). Solo el libro REAL; paper y shadow
 * siguen con el stop tecnico, asi el shadow queda como control.
 *  - Entrada: el stop inicial va a entrada - 1,5 x ATR(14) diario del
 *    subyacente, y el tamaño sale de ese riesgo (1% del capital) dentro del
 *    mismo tope por posicion. El filtro R:R >= 2 se sigue evaluando con el
 *    stop tecnico: es el filtro de CALIDAD del setup, no la gestion.
 *  - Abierta: el stop acompaña al precio a 1,5 x ATR y SOLO SUBE. Contra una
 *    mecha suelta se usa el menor de dos lecturas consecutivas (~60s).
 * Antecedente: los stops tecnicos de LAC, OKLO y ORCL quedaron a menos de
 * medio ATR del precio y LP los corrio a mano tres veces (23-28/09). ATR
 * sobre ruedas CERRADAS, cache de una hora. IOL_BOT_STOP_ATR=0 lo apaga. */
const STOP_ATR_MULT = Number(process.env.IOL_BOT_STOP_ATR ?? 1.5);
const atrCache = new Map();   // sym → { atr, ts }
const pAnterior = new Map();  // trade id → ultimo precio leido
async function atr14(sym) {
  const c = atrCache.get(sym);
  if (c && Date.now() - c.ts < 60 * 60 * 1000) return c.atr;
  const d = await yahooCandles(sym, "1d", "2mo").catch(() => null);
  if (!d || d.length < 3) return c?.atr ?? null;
  const hoy = new Date().toISOString().slice(0, 10);
  const b = d[d.length - 1].t === hoy ? d.slice(0, -1) : d;
  const tr = [];
  for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  const ult = tr.slice(-14);
  if (!ult.length) return c?.atr ?? null;
  const atr = ult.reduce((x, v) => x + v, 0) / ult.length;
  atrCache.set(sym, { atr, ts: Date.now() });
  return atr;
}''', 'const')

    sub('''  // Sizing por riesgo, EN PESOS sobre el instrumento que se compra de verdad.
  const riesgoUnidad = (entry - stop) * rArs;''',
'''  // Libro real: stop a 1,5 x ATR (ver STOP_ATR_MULT). El sizing de abajo ya
  // usa este stop, asi el riesgo por trade sigue siendo el 1%.
  if (MODO_REAL && !esShadow && STOP_ATR_MULT > 0) {
    const a = await atr14(sym);
    if (a > 0 && entry - STOP_ATR_MULT * a > 0) {
      const sAtr = entry - STOP_ATR_MULT * a;
      log(`[bot ${tk}] stop ${STOP_ATR_MULT}×ATR: US$${Number(stop).toFixed(2)} (tecnico) → US$${sAtr.toFixed(2)} (ATR ${a.toFixed(2)})`);
      stop = sAtr;
    }
  }

  // Sizing por riesgo, EN PESOS sobre el instrumento que se compra de verdad.
  const riesgoUnidad = (entry - stop) * rArs;''', 'entrada')

    sub('''    const entry = Number(t.entry_price), R = Number(t.r_value);
    let stop = Number(t.stop);''',
'''    const entry = Number(t.entry_price), R = Number(t.r_value);
    let stop = Number(t.stop);
    // Stop a 1,5 x ATR que acompaña al precio y solo sube (ver STOP_ATR_MULT).
    if (t.modo === "real" && STOP_ATR_MULT > 0 && p > 0) {
      const pRef = Math.min(p, pAnterior.get(t.id) ?? p);
      pAnterior.set(t.id, p);
      const a = await atr14(t.sym);
      const sAtr = a > 0 ? pRef - STOP_ATR_MULT * a : null;
      // Umbral de 0,2% para no escribir la base en cada centavo.
      if (sAtr != null && sAtr > stop * 1.002) {
        log(`[bot ${t.ticker}] stop ${STOP_ATR_MULT}×ATR sube: US$${stop.toFixed(2)} → US$${sAtr.toFixed(2)} (precio ${pRef.toFixed(2)}, ATR ${a.toFixed(2)})`);
        stop = sAtr;
        await supabase.from("paper_iol_trades").update({ stop }).eq("id", t.id);
      }
    }''', 'abierta')
    return s

out = {n: parchar(n) for n in ['worker.js', 'worker-deploy.js']}
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
for n, s in out.items():
    io.open(os.path.join(D, n), 'w', encoding='utf-8').write(s)
print('ok')
