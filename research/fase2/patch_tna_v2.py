# -*- coding: utf-8 -*-
# pnlCapitalDias v2: cada día con operaciones cuenta el MÁXIMO invertido ese
# día (la v1 solo contaba lo que quedaba al cierre de cada tramo y dejaba
# afuera el capital intradía: MU -267%, SNDK -719%, META +1664% de TNA).
import io, re, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
i = s.find('function pnlCapitalDias(ops, type, finISO) {')
j = s.find('\nfunction PnlPorInstrumentoModule() {', i)
if i < 0 or j < 0:
    print('FALLO: no encuentro la funcion'); sys.exit(1)

NUEVA = '''function pnlCapitalDias(ops, type, finISO) {
  const dia = (iso) => Math.floor(new Date(String(iso).slice(0, 10) + "T12:00:00").getTime() / 86400000);
  // Dentro del mismo día van primero las compras: en las idas y vueltas
  // intradía (Compra/Venta Trading) el extracto a veces lista la venta antes y
  // se leía como un short.
  const esVenta = (o) => (o.operation_type === "sell" ? 1 : 0);
  const ord = [...(ops || [])].filter((o) => o && o.entry_date).sort((a, b) =>
    a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1
      : (esVenta(a) - esVenta(b)) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
  if (!ord.length) return null;
  // Capital × días: cada día CON operaciones cuenta el máximo invertido ese día
  // (así entra el capital de las operaciones intradía); los días sin
  // operaciones cuentan lo que quedó puesto.
  let qty = 0, cost = 0, capDias = 0, prevDia = null, k = 0;
  while (k < ord.length) {
    const d = dia(ord[k].entry_date);
    if (prevDia != null && qty > 1e-9 && d - prevDia > 1) capDias += cost * (d - prevDia - 1);
    let pico = qty > 1e-9 ? cost : 0;
    while (k < ord.length && dia(ord[k].entry_date) === d) {
      const o = ord[k++];
      const q = Number(o.quantity) || 0, px = Number(o.entry_price) || 0;
      if (o.operation_type === "sell") {
        if (!(qty > 1e-9)) continue;   // venta sin tenencia previa: no suma capital
        const venta = Math.min(q, qty);
        cost -= cost * (venta / qty);
        qty -= venta;
        if (qty <= 1e-9) { qty = 0; cost = 0; }
      } else {
        qty += q;
        cost += applyConventionToValue(type, q, px);
        if (cost > pico) pico = cost;
      }
    }
    capDias += pico;
    prevDia = d;
  }
  if (qty > 1e-9 && finISO) {
    const f = dia(finISO);
    if (f > prevDia) capDias += cost * (f - prevDia);
  }
  const dias = finISO ? Math.max(1, dia(finISO) - dia(ord[0].entry_date)) : null;
  return { capDias, dias };
}
'''
s = s[:i] + NUEVA + s[j:]
io.open(P, 'w', encoding='utf-8').write(s)
print('pnlCapitalDias v2 aplicada')
