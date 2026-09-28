# -*- coding: utf-8 -*-
# Importador Matriz: ignorar los ecos "I" (Order Updated) que el export trae
# desde el 28/09/2026 con order_ids distintos para la misma orden de cliente.
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
orig = len(s)
fallos = []

def sub(a, b, nombre):
    global s
    n = s.count(a)
    if n == 1:
        s = s.replace(a, b)
    else:
        fallos.append('%s (%d)' % (nombre, n))

# 1) columna del client order id
sub('''    iExec = ix("exec_type"), iLastQty = ix("last_qty");
  if (iOrder < 0 || iSym < 0 || iCum < 0) return []; // formato no reconocido''',
'''    iExec = ix("exec_type"), iLastQty = ix("last_qty"), iCl = ix("last_cl_ord_id");
  if (iOrder < 0 || iSym < 0 || iCum < 0) return []; // formato no reconocido

  /* ECOS "I" (28/09/2026). Desde ese día el export de Matriz repite cada
   * ejecución hasta tres veces: la fila de la operación (exec_type F) y dos
   * "Order Updated" (exec_type I), cada una con un order_id DISTINTO pero la
   * misma orden de cliente (last_cl_ord_id). Con el agrupado por order_id,
   * cada compra entraba tres veces: NU 200 a $10.120 se cargó como 600, el
   * archivo del día dio NU +8.200 en vez de +3.400 y la caja de T+1 el
   * triple. Regla: si la orden de cliente tiene filas F, sus I son ecos y se
   * ignoran; si solo vino como I (pasó con una venta de OKLO), se toma UNO de
   * sus order_ids. Los archivos viejos (solo F) no cambian, y la lógica de
   * reemplazos de abajo sigue igual porque cada orden de cliente tiene como
   * mucho un order_id con filas F. */
  const clConF = new Set();
  const clElegido = new Map();   // orden de cliente sin F → el order_id que se toma
  if (iCl >= 0 && iExec >= 0) {
    for (let li = 1; li < lines.length; li++) {
      const c = lines[li].split(",");
      const cl = (c[iCl] || "").trim();
      if (!cl) continue;
      if ((c[iExec] || "").trim() === "F") clConF.add(cl);
      else if (!clElegido.has(cl)) clElegido.set(cl, (c[iOrder] || "").trim());
    }
  }
  const clDe = new Map();        // order_id → orden de cliente (para el dedup)''', '1/ecos-pre')

# 2) filtro en el loop
sub('''    const oid = (c[iOrder] || "").trim();
    if (!oid) continue;
    const evt = iEvent >= 0 ? (c[iEvent] || "").trim().toLowerCase() : "";''',
'''    const oid = (c[iOrder] || "").trim();
    if (!oid) continue;
    const cl = iCl >= 0 ? (c[iCl] || "").trim() : "";
    if (cl && iExec >= 0 && (c[iExec] || "").trim() === "I") {
      if (clConF.has(cl)) continue;               // eco de una ejecución ya reportada como F
      if (clElegido.get(cl) !== oid) continue;    // el mismo eco repetido con otro order_id
    }
    if (cl) clDe.set(oid, cl);
    const evt = iEvent >= 0 ? (c[iEvent] || "").trim().toLowerCase() : "";''', '2/filtro')

# 3) dedup también por orden de cliente
sub('''    else if (existingOrderIds && existingOrderIds.has(oid)) { status = "dup"; }''',
'''    else if (existingOrderIds && (existingOrderIds.has(oid) || (clDe.get(oid) && existingOrderIds.has(clDe.get(oid))))) { status = "dup"; }''', '3/dup')
sub('''    out.push({
      orderId: oid, account, ticker,''',
'''    out.push({
      orderId: oid, clOrdId: clDe.get(oid) || null, account, ticker,''', '4/clOrdId')

# 5) guardar y leer el cl_ord_id
sub('''              matriz_order_id: r.orderId, matriz_account: r.account, source: "csv_matriz",''',
'''              matriz_order_id: r.orderId, matriz_account: r.account, source: "csv_matriz",
              ...(r.clOrdId ? { matriz_cl_ord_id: r.clOrdId } : {}),''', '5/guardar')
sub('''      const oid = p?.extra?.matriz_order_id;
      if (oid) s.add(oid);''',
'''      const oid = p?.extra?.matriz_order_id;
      if (oid) s.add(oid);
      const cl = p?.extra?.matriz_cl_ord_id;
      if (cl) s.add(cl);''', '6/leer')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
