# -*- coding: utf-8 -*-
# cocos-bot: la cuenta 72404 es compartida con LP (opera a mano). El bot no
# adopta ordenes ajenas y antes de vender descuenta la tenencia real y las
# ventas activas de LP (29/09/2026).
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
i = s.find('async function ventaActivaDe(tk) {')
j = s.find('async function cerrar(t, kind, qty, pxArs, usd) {')
if i < 0 or j < 0 or j < i:
    print('FALLO: no encuentro el bloque'); sys.exit(1)
NUEVO = r'''/* LA CUENTA ES COMPARTIDA: LP opera a mano en la misma cuenta 72404 (y suele
 * espejar las señales del bot). Reglas: (1) el bot NUNCA adopta una orden que
 * no colocó él: sus ventas quedan anotadas en la fila como [venta id|kind|
 * qty|px] y se recuperan al reiniciar; (2) antes de vender mira la tenencia
 * real del papel en la cuenta y descuenta las ventas activas ajenas: vende
 * como mucho lo que queda, así nunca deja la cuenta vendida en descubierto. */
async function tenenciaCuenta(tk) {
  const j = await api("GET", `/rest/risk/detailedPosition/${CUENTA}`);
  const rep = j?.detailedPosition?.report || {};
  let n = 0;
  for (const tipo of Object.values(rep)) for (const [sym, info] of Object.entries(tipo || {})) if (String(sym).toUpperCase() === tk) n += Number(info?.instrumentCurrentSize) || 0;
  return n;
}
async function vendibleDe(t, tk, qty) {
  const acts = await ordenesActivas().catch(() => []);
  const propias = new Set([...salidas.values()].map((s) => String(s.id).split("|")[0]));
  const ajenas = acts.filter((o) => o.side === "SELL" && o.instrumentId?.symbol === simbolo(tk) && !propias.has(o.clOrdId));
  const comprometidoAjeno = ajenas.reduce((a, o) => a + (Number(o.leavesQty) || Number(o.orderQty) || 0), 0);
  const tenencia = await tenenciaCuenta(tk).catch(() => null);
  if (tenencia == null) return qty;
  const libre = Math.max(0, tenencia - comprometidoAjeno);
  if (libre < qty) {
    log(`[cocos ${tk}] la cuenta tiene ${tenencia} y hay ventas ajenas por ${comprometidoAjeno}: vendo ${libre} de ${qty}`);
    await tg(`<b>COCOS BOT · ojo ${tk}</b>\nQuería vender ${qty} pero en la cuenta quedan ${libre} libres (tenencia ${tenencia}, ventas tuyas activas ${comprometidoAjeno}). Vendo ${libre}.`);
  }
  return Math.min(qty, libre);
}
async function vender(t, kind, qty, pxArs) {
  const tk = String(t.ticker).toUpperCase();
  if (salidas.has(t.id)) return;
  let id = null;
  if (REAL) {
    qty = await vendibleDe(t, tk, qty);
    if (qty < 1) { log(`[cocos ${tk}] nada para vender en la cuenta`); return; }
    try { id = await ordenNueva(tk, "SELL", qty, pxArs); }
    catch (e) { log(`[cocos ${tk}] la VENTA fue rechazada: ${e.message}`); await tg(`<b>COCOS BOT · VENTA RECHAZADA ${tk}</b>\n${e.message}\nLa posición sigue ABIERTA (${t.qty}). Reintento en la próxima pasada.`); return; }
    const marca = ` [venta ${id}|${kind}|${qty}|${pxArs}]`;
    await supabase.from("paper_iol_trades").update({ nota_sim: `${t.nota_sim || ""}${marca}` }).eq("id", t.id);
    t.nota_sim = `${t.nota_sim || ""}${marca}`;
  }
  salidas.set(t.id, { id, kind, qty, pxArs, placedAt: Date.now() });
  log(`[cocos ${tk}] venta ${kind}: ${qty} × ${pesos(pxArs)}${REAL ? ` (orden ${id})` : " (simulada)"}`);
}
// Al arrancar: recuperar las ventas del bot que quedaron en curso (reinicio).
async function reconciliarSalidas(vivas) {
  for (const t of vivas) {
    if (t.status !== "open") continue;
    const ms = [...String(t.nota_sim || "").matchAll(/\[venta ([^|\]]+)\|(\w+)\|(\d+)\|([\d.]+)\]/g)];
    if (!ms.length) continue;
    const m = ms[ms.length - 1];
    const o = await ordenEstado(m[1]).catch(() => null);
    if (o && (!FINAL.has(String(o.status)) || String(o.status) === "FILLED")) {
      salidas.set(t.id, { id: m[1], kind: m[2], qty: Number(m[3]), pxArs: Number(m[4]), placedAt: Date.now() });
      log(`[cocos ${t.ticker}] recupero venta ${m[1]} (${o.status})`);
    }
  }
}
'''
s = s[:i] + NUEVO + s[j:]
A = '''  const vivas = await abiertasCocos();
  log(`filas vivas en el libro cocos: ${vivas.length}`);
  for (;;) {'''
if s.count(A) != 1:
    print('FALLO: ancla del arranque'); sys.exit(1)
s = s.replace(A, '''  const vivas = await abiertasCocos();
  log(`filas vivas en el libro cocos: ${vivas.length}`);
  await reconciliarSalidas(vivas).catch((e) => log(`reconciliar: ${e.message}`));
  for (;;) {''')
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
