# -*- coding: utf-8 -*-
# Fase 2 del Libro (27/09/2026, pedido de LP):
#  - borrar el archivo importado borra TODO lo de Cocos (posiciones de cualquier
#    fuente, libro, caja). IOL y Balanz intactos.
#  - subir el archivo arma todo lo que pueda, POSICIONES incluidas.
#  - las letras vencidas se cierran por fecha de vencimiento (el cobro llega al
#    libro sin ticker y era lo que fabricaba los fantasmas S30A6/S29Y6).
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

# 1) vencimientos en deriveFromLedger
sub('''  const positions = [];
  for (const a of netAgg.values()) {''',
'''  // VENCIMIENTOS (27/09/2026). El cobro de una letra vencida entra al libro
  // como "Renta y Amortizacion" SIN ticker, asi que nada cerraba la tenencia:
  // S30A6 y S29Y6 seguian vivas meses despues de cobradas (fueron el motivo de
  // apagar la derivacion el 17/09). Se cierran en su fecha de vencimiento
  // (BOND_REGISTRY o el codigo del ticker) al pago final verificado; si el
  // registro no lo tiene, al cobro del libro de esa fecha; si tampoco, al
  // ultimo precio operado.
  const netoBono = new Map();
  for (const l of lots) {
    if (l.instrument_type !== "bond_ars") continue;
    netoBono.set(l.ticker, (netoBono.get(l.ticker) || 0) + (l.side === "buy" ? l.quantity : -l.quantity));
  }
  for (const [tk, q] of netoBono) {
    if (!(q > 1e-6)) continue;
    const info = resolveBond(String(tk).toUpperCase());
    if (!info?.maturityDate || info.maturityDate >= _todayAR) continue;
    let px = Number(info.finalPayoff) || 0;
    if (!px) {
      const vto = new Date(info.maturityDate + "T12:00:00");
      const cobro = rows.find((m) => m.categoria === "renta" && !m.ticker && Number(m.total) > 0 && m.fecha_ejecucion &&
        Math.abs(new Date(m.fecha_ejecucion + "T12:00:00") - vto) <= 5 * 86400000);
      if (cobro) px = (Number(cobro.total) / q) * 100;
    }
    if (!px) {
      const ult = lots.filter((l) => l.ticker === tk).slice(-1)[0];
      px = ult?.entry_price || 0;
    }
    lots.push({ ticker: tk, srcTicker: tk, instrument_type: "bond_ars", side: "sell", quantity: q,
      entry_price: px, entry_currency: "ARS", entry_date: info.maturityDate, vencimiento: true });
  }

  const positions = [];
  for (const a of netAgg.values()) {''', '1/vencimientos')

# 2) prender la derivacion al importar
sub('''    /* DERIVACIÓN DE POSICIONES DESHABILITADA (17/09/2026). La Fase 2 del
     * Libro está incompleta: no netea vencimientos de letras ni rescates de
     * FCI, así que fabrica tenencias fantasma (S30A6/S29Y6 cobradas
     * aparecían como vivas) y duplica futuros contra la Matriz. Hoy borró
     * y reemplazó mal todo el portfolio de LP. El Libro sigue importando
     * MOVIMIENTOS (eso funciona); las POSICIONES vienen de la Matriz y de
     * la foto del broker hasta que la Fase 2 se termine con sus tests. */
    const DERIVACION_POSICIONES_OFF = true;''',
'''    /* DERIVACIÓN DE POSICIONES: PRENDIDA de nuevo el 27/09/2026 (pedido de LP:
     * "cuando se sube el archivo nuevo que arme todo lo que pueda"). Estaba
     * apagada desde el 17/09 porque fabricaba tenencias fantasma: las letras
     * vencidas (S30A6/S29Y6) seguían vivas. deriveFromLedger ahora las cierra
     * por fecha de vencimiento. Probado con research/fase2/probar.cjs contra
     * el CSV real de LP del 22/09: la tenencia derivada coincide con la
     * reconstrucción validada (PBA27, TXMJ9, T30J7, GGAL, GLD, JNJ) y con lo
     * que efectivamente tiene (DLR NOV26 200; NU y HUT vendidos). WTI y
     * opciones no vienen en el extracto: se cargan a mano. */
    const DERIVACION_POSICIONES_OFF = false;''', '2/flag')

# 3) applyDerived: lo derivado reemplaza a la reconstruccion vieja; caja solo de Cocos
sub('''    await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").filter("extra->>source", "eq", "derivado_libro");''',
'''    await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").filter("extra->>source", "eq", "derivado_libro");
    // Con la derivación prendida, la reconstrucción manual vieja (historico_libro
    // / ajuste_neteo, research/reconstruir-historico) queda reemplazada: si
    // convivieran, cada papel aparecería dos veces.
    if (allPos.length) {
      await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos")
        .in("extra->>source", ["historico_libro", "ajuste_neteo"]);
    }''', '3a/historico')
sub('''    await supabase.from("cash_movements").delete().eq("user_id", user.id).is("source_ref", null);
    if (keepRefs.length) {
      await supabase.from("cash_movements").delete().eq("user_id", user.id)
        .not("source_ref", "in", `(${keepRefs.map((r) => `"${r}"`).join(",")})`);
    } else {
      await supabase.from("cash_movements").delete().eq("user_id", user.id).not("source_ref", "is", null);
    }''',
'''    // Solo la caja de Cocos (o sin broker, filas viejas): IOL y Balanz no se tocan.
    const cajaCocos = () => supabase.from("cash_movements").delete().eq("user_id", user.id).or("broker.eq.cocos,broker.is.null");
    await cajaCocos().is("source_ref", null);
    if (keepRefs.length) {
      await cajaCocos().not("source_ref", "in", `(${keepRefs.map((r) => `"${r}"`).join(",")})`);
    } else {
      await cajaCocos().not("source_ref", "is", null);
    }''', '3b/caja')

# 4) borrar = TODO lo de Cocos
sub('''const FUENTES_IRRECUPERABLES = new Set(["historico_libro", "ajuste_neteo"]);
async function borrarPosicionesCocos(userId) {
  const { data: candidatos } = await supabase
    .from("positions")
    .select("id, instrument_type, ticker, extra")
    .eq("user_id", userId)
    .eq("broker", "cocos");
  const preservar = (candidatos || [])
    .filter((p) => FUENTES_IRRECUPERABLES.has(p?.extra?.source) ||
      (p?.extra?.source === "csv_matriz" &&
       (p.instrument_type === "option" ||
        String(p.ticker || "").toUpperCase().startsWith("ORO"))))
    .map((p) => p.id);
  let q = supabase.from("positions").delete().eq("user_id", userId).eq("broker", "cocos");
  if (preservar.length) q = q.not("id", "in", "(" + preservar.join(",") + ")");
  await q;
  return preservar.length;
}''',
'''//
// 27/09/2026 — REGLA DE LP: "cuando se borra el archivo que se importó, tiene
// que borrar todo lo de ese broker". Con la derivación prendida el extracto
// vuelve a armar las posiciones al reimportar, así que ya no hay nada que
// preservar. Se borra TODO Cocos, de cualquier fuente — incluido lo cargado a
// mano (WTI, opciones), que no viene en el archivo y se vuelve a cargar a mano.
async function borrarPosicionesCocos(userId) {
  await supabase.from("positions").delete().eq("user_id", userId).eq("broker", "cocos");
  return 0;
}''', '4/borrar')

# 5) los dos botones de borrado: caja solo de Cocos
sub('''    await borrarPosicionesCocos(user.id);
    await supabase.from("cash_movements").delete().eq("user_id", user.id);
    setConfirmWipe(false); reload();''',
'''    await borrarPosicionesCocos(user.id);
    await supabase.from("cash_movements").delete().eq("user_id", user.id).or("broker.eq.cocos,broker.is.null");
    setConfirmWipe(false); reload();''', '5a/wipeAll')
sub('''    await borrarPosicionesCocos(user.id);
    await supabase.from("cash_movements").delete().eq("user_id", user.id);
    setConfirmDel(null); reloadBatches(); reloadMovs();''',
'''    await borrarPosicionesCocos(user.id);
    await supabase.from("cash_movements").delete().eq("user_id", user.id).or("broker.eq.cocos,broker.is.null");
    setConfirmDel(null); reloadBatches(); reloadMovs();''', '5b/deleteBatch')

# 6) texto honesto del botón
sub('''<span style={{ fontSize: 10.5, color: C.muted }}>Borra los movimientos Y el portfolio derivado. ¿Seguro?</span>''',
'''<span style={{ fontSize: 10.5, color: C.muted }}>{b.broker === "balanz" ? "Borra la foto de Balanz y sus posiciones. ¿Seguro?" : "Borra TODO Cocos: movimientos, caja y todas las posiciones (también WTI y opciones cargadas a mano). IOL y Balanz no se tocan. Al reimportar se arma de nuevo. ¿Seguro?"}</span>''', '6/texto')

# 7) Reconstruir tambien arma posiciones
sub('''  // Reconstruir sin subir archivo (re-deriva del ledger actual).
  // 17/09/2026: solo CAJA y FCI — las POSICIONES no se derivan (Fase 2
  // incompleta: no netea vencimientos, fabrica fantasmas).
  const reaplicar = async () => {
    setApplying(true); setRebuildMsg(null);
    const d = deriveFromLedger(movs);
    const err = await applyDerived({ ...d, positions: [], lots: [] });
    setApplying(false);
    setRebuildMsg(err ? "Error: " + err : "✓ Caja y FCI reconstruidos desde el libro (posiciones no se tocan: Fase 2 pendiente).");
  };''',
'''  // Reconstruir sin subir archivo (re-deriva del ledger actual): caja, FCI y
  // posiciones (27/09/2026: derivación de posiciones prendida).
  const reaplicar = async () => {
    setApplying(true); setRebuildMsg(null);
    const d = deriveFromLedger(movs);
    const err = await applyDerived(d);
    setApplying(false);
    setRebuildMsg(err ? "Error: " + err : "✓ Caja, FCI y posiciones reconstruidos desde el libro.");
  };''', '7/reaplicar')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos))
    sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes, 9 parches' % (orig, len(s)))
