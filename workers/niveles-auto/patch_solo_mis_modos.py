# -*- coding: utf-8 -*-
# niveles-auto: operar SOLO sobre sus propios libros (paper, real, shadow).
#
# INCIDENTE 01/10/2026. El 29/09 se sumaron a paper_iol_trades los libros
# 'cocos' y 'cocos_sombra' (bot de Cocos). niveles-auto leia la tabla SIN
# filtrar por modo:
#   - paperPass tomo la fila pendiente de NBIS del bot de Cocos (146 unidades)
#     como propia, no encontro la orden en IOL ("no estaba apoyada") y coloco
#     en IOL la orden 191019162: compra de 146 NBIS a $13.690 con plata real.
#     El 30/09 lo habia intentado 9 veces y IOL lo rechazo por saldo (de ahi el
#     "monto estimado 2.007.632" que no cerraba con la orden de 98). Cancelada
#     a mano a los 18 minutos, sin ejecutar.
#   - paperSignal contaba las posiciones de Cocos como propias: el libro real
#     de IOL no tomaba señales en papeles donde Cocos (o su sombra) tenia algo.
#   - las salidas de filas ajenas habrian mandado ventas reales a IOL.
# Cada lectura de la tabla queda acotada a MIS_MODOS.
import io, os, sys
D = os.path.dirname(os.path.abspath(__file__))
fallos = []
def parchar(nombre):
    ruta = os.path.join(D, nombre)
    s = io.open(ruta, encoding='utf-8').read()
    def sub(a, b, et, veces=1):
        nonlocal s
        n = s.count(a)
        if n == veces: s = s.replace(a, b)
        else: fallos.append('%s %s (%d)' % (nombre, et, n))
    sub('''  const { data: trades } = await supabase.from("paper_iol_trades").select("*").in("status", ["pending", "open"]);''',
        '''  // SOLO mis libros: la tabla tambien tiene 'cocos' y 'cocos_sombra' (otro
  // worker). El 01/10/2026 este paso tomo una fila de Cocos y coloco su orden
  // en IOL con plata real (ver patch_solo_mis_modos.py).
  const { data: trades } = await supabase.from("paper_iol_trades").select("*").in("status", ["pending", "open"]).in("modo", MIS_MODOS);''', 'paperPass')
    sub('''  const { data: exAll } = await supabase.from("paper_iol_trades").select("id,status,entry_limit,modo,broker_order_id").eq("sym", sym).in("status", ["pending", "open"]);''',
        '''  const { data: exAll } = await supabase.from("paper_iol_trades").select("id,status,entry_limit,modo,broker_order_id").eq("sym", sym).in("status", ["pending", "open"]).in("modo", MIS_MODOS);''', 'paperSignal')
    sub('''const BOT_VENTANA_H = 48;''', '''// Libros que maneja ESTE worker. Ninguna lectura de paper_iol_trades puede
// salir de aca: hay otros workers escribiendo sus propios modos en la tabla.
const MIS_MODOS = ["paper", "real", "shadow"];
const BOT_VENTANA_H = 48;''', 'const')
    return s
out = {n: parchar(n) for n in ['worker.js', 'worker-deploy.js']}
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
for n, s in out.items():
    io.open(os.path.join(D, n), 'w', encoding='utf-8').write(s)
print('ok')
