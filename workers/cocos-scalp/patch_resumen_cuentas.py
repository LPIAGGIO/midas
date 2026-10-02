# -*- coding: utf-8 -*-
# resumen.js: dos cuentas de Cocos (02/10/2026). Cada carpeta de scalp
# pertenece a una cuenta (cocos-scalp* = 72404, cocos2-scalp* = la segunda);
# el resumen sale por papel con la cuenta en el título, un total por cuenta y
# un total general. Con nueve papeles por cuenta el detalle por papel se manda
# igual (lo pidió LP), agrupado por cuenta.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'resumen.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''      if (txt.includes("ÓRDENES REALES")) { real = true; tk = m[2]; continue; }''',
    '''      if (txt.includes("ÓRDENES REALES")) { real = true; tk = m[2]; continue; }
      const mc = /^cuenta (\\d+) ·/.exec(txt);
      if (mc) { cuenta = mc[1]; continue; }''', 'cuenta-log')
sub('''  const ev = []; let tk = null;''',
    '''  const ev = []; let tk = null;
  // La cuenta sale del log ("cuenta 3893 · tick ..."); las carpetas viejas,
  // anteriores a ese renglón, son de la 72404.
  let cuenta = "72404";''', 'cuenta-var')
sub('''  return { tk, ev, est };''', '''  return { tk, ev, est, cuenta };''', 'cuenta-ret')
sub('''  const L = [`<b>SCALP ${b.tk} · ${hoy.split("-").reverse().join("/")}</b>`];''',
    '''  const L = [`<b>SCALP ${b.tk} · cuenta ${b.cuenta} · ${hoy.split("-").reverse().join("/")}</b>`];''', 'titulo')
sub('''  const bots = fs.readdirSync(RAIZ).filter((d) => /^cocos-scalp/.test(d)).map((d) => leerBot(path.join(RAIZ, d))).filter((b) => b && b.ev.length);''',
    '''  const bots = fs.readdirSync(RAIZ).filter((d) => /^cocos\\d*-scalp/.test(d)).map((d) => leerBot(path.join(RAIZ, d))).filter((b) => b && b.ev.length)
    .sort((a, b) => a.cuenta.localeCompare(b.cuenta) || a.tk.localeCompare(b.tk));''', 'dirs')
a = s.find('  if (bots.length > 1) mensajes.push(')
b = s.find('\n', a)
if a < 0: fallos.append('total (0)')
else:
    s = s[:a] + '''  if (bots.length > 1) {
    const cuentas = [...new Set(bots.map((b) => b.cuenta))];
    const L = ["<b>SCALP · total del día</b>"];
    let general = 0;
    for (const c of cuentas) {
      let sub = 0;
      L.push("", `<b>Cuenta ${c}</b>`);
      bots.forEach((b, i) => { if (b.cuenta !== c) return; sub += partes[i].total; L.push(`${b.tk}: ${pesos(partes[i].total)} en ${partes[i].vueltas} ventas`); });
      L.push(`Subtotal: ${pesos(sub)}`);
      general += sub;
    }
    if (cuentas.length > 1) L.push("", `<b>Total general: ${pesos(general)}</b>`);
    else L[L.length - 1] = `<b>Total: ${pesos(general)}</b>`;
    mensajes.push(L.join("\\n"));
  }''' + s[b:]
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
