# -*- coding: utf-8 -*-
# La lista de cuentas va al lado de "BROKERS" en el Portfolio (LP 12/10/2026:
# "confunde tocar ahí y que se active al lado del ícono de la derecha"). En el
# Portfolio no se muestra el botón de arriba; en las otras pantallas sigue
# apareciendo solo si hay filtro, porque la selección vale para todas.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

sub('''function CuentaSelector() {''', '''function CuentaSelector({ inline = false }) {''', 'firma')
sub('''  if (cuentas.length < 2 || !filtrando) return null;''',
'''  if (cuentas.length < 2 || (!inline && !filtrando)) return null;''', 'visible')
sub('''    <div ref={ref} style={{ position: "relative", margin: "0 10px" }}>''',
'''    <div ref={ref} style={{ position: "relative", margin: inline ? "0 6px 0 0" : "0 10px" }}>''', 'margen')
sub('''        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 260,''',
'''        <div style={{ position: "absolute", top: "calc(100% + 6px)", ...(inline ? { left: 0 } : { right: 0 }), minWidth: 260,''', 'popover lado')
sub('''              <CuentaSelector />''', '''              {active !== "portfolio-ia" && <CuentaSelector />}''', 'header')

# fichas: el bloque "Todas" pasa a ser la lista
a = s.index('''              {multiCuentas.size > 0 && (() => {''')
z = s.index('''              })()}\n''', a) + len('''              })()}\n''')
if z - a > 2500: print('bloque todas raro', z - a); sys.exit(1)
s = s[:a] + '''              {multiCuentas.size > 0 && <CuentaSelector inline />}\n''' + s[z:]
# y las fichas por cuenta se van (la lista de al lado las reemplaza)
a = s.index('''                // Broker con varias cuentas: una ficha por cuenta, que prende y''')
z = s.index('''                const isActive = !excludedBrokers.has(key);''', a)
if z - a > 4000: print('bloque fichas raro', z - a); sys.exit(1)
s = s[:a] + '''                // Brokers con cuentas dadas de alta: se eligen en la lista de al lado.
                if (multiCuentas.has(key)) return null;
''' + s[z:]
io.open(p, 'w', encoding='utf-8').write(s); print('ok')
