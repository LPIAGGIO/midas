# -*- coding: utf-8 -*-
# P&L por Instrumento: columnas Días y TNA para comparar qué rindió mejor
# (28/09/2026, pedido de LP). TNA sobre capital × días invertido.
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

# 1) helper antes del módulo
sub('''function PnlPorInstrumentoModule() {''',
'''// Capital × días invertido en un instrumento: el costo del lote vivo (costo
// promedio) integrado en el tiempo. Es la base de la TNA de P&L por
// Instrumento (pedido de LP 28/09/2026): con varias compras y ventas,
// "resultado / costo total" mezcla plata que estuvo 40 días con plata que
// estuvo 2 y no dice qué rindió mejor. Esto pondera cada peso por el tiempo
// que estuvo puesto. Una ida y vuelta en el mismo día cuenta 1 día (si no, la
// TNA sería infinita). Devuelve null si hubo short (sobre capital no aplica).
function pnlCapitalDias(ops, type, finISO) {
  const dia = (iso) => Math.floor(new Date(String(iso).slice(0, 10) + "T12:00:00").getTime() / 86400000);
  const ord = [...(ops || [])].filter((o) => o && o.entry_date).sort((a, b) =>
    a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : String(a.created_at || "").localeCompare(String(b.created_at || "")));
  if (!ord.length) return null;
  let qty = 0, cost = 0, capDias = 0, prevDia = null, abiertoDia = null, pico = 0;
  for (const o of ord) {
    const d = dia(o.entry_date);
    if (prevDia != null && qty > 1e-9) capDias += cost * (d - prevDia);
    const q = Number(o.quantity) || 0, px = Number(o.entry_price) || 0;
    if (o.operation_type === "sell") {
      if (!(qty > 1e-9)) return null;
      const venta = Math.min(q, qty);
      cost -= cost * (venta / qty);
      qty -= venta;
      if (qty <= 1e-9) {
        if (abiertoDia === d) capDias += pico;
        qty = 0; cost = 0; abiertoDia = null; pico = 0;
      }
    } else {
      if (qty <= 1e-9) { abiertoDia = d; pico = 0; }
      qty += q;
      cost += applyConventionToValue(type, q, px);
      if (cost > pico) pico = cost;
    }
    prevDia = d;
  }
  if (qty > 1e-9 && finISO) capDias += cost * Math.max(0, dia(finISO) - prevDia);
  const dias = finISO ? Math.max(1, dia(finISO) - dia(ord[0].entry_date)) : null;
  return { capDias, dias };
}

function PnlPorInstrumentoModule() {''', '1/helper')

# 2) guardar las operaciones de cada instrumento
sub('''        first: null, last: null, realized: 0, total: 0, hasPnl: false, priceSource: null, ops: 0,
      };''',
'''        first: null, last: null, realized: 0, total: 0, hasPnl: false, priceSource: null, ops: 0,
        opsList: [],
      };
      e.opsList.push(p);''', '2/opsList')

# 3) TNA antes de armar las filas
sub('''    return Array.from(acc.values()).map((e) => ({
      ...e,
      pppBuy: e.buyQty > 0 ? e.buyNot / e.buyQty : null,''',
'''    // TNA sobre capital × días (ver pnlCapitalDias). Solo contado: futuros y
    // opciones no inmovilizan capital en la cuenta, cauciones van en su fila.
    const hoyTna = getTodayStringAR();
    for (const e of acc.values()) {
      e.tna = null; e.dias = null;
      if (!e.hasPnl || e.type === "caucion" || !CONS_CAPITAL_TYPES.has(e.type) || !e.opsList?.length) continue;
      const abierto = Math.abs(e.buyQty - e.sellQty) > 1e-9 && !e.matured;
      const fin = abierto ? hoyTna : (e.matured ? (parseLetraMaturity(e.ticker) || e.last) : e.last);
      const r = pnlCapitalDias(e.opsList, e.type, fin);
      if (!r || !(r.capDias > 0)) continue;
      e.dias = r.dias;
      e.tna = (e.total / r.capDias) * 365 * 100;
    }

    return Array.from(acc.values()).map((e) => ({
      ...e,
      pppBuy: e.buyQty > 0 ? e.buyNot / e.buyQty : null,''', '3/tna')

# 4) orden por TNA (click en el encabezado)
sub('''  const presentTypes = useMemo(() => Array.from(new Set(rows.map((r) => r.type))), [rows]);
  const shown = typeFilter === "all" ? rows : rows.filter((r) => r.type === typeFilter);''',
'''  const presentTypes = useMemo(() => Array.from(new Set(rows.map((r) => r.type))), [rows]);
  // Orden por TNA: click en el encabezado → mayor a menor → menor a mayor → original.
  const [ordenTna, setOrdenTna] = useState(null);
  const filtradas = typeFilter === "all" ? rows : rows.filter((r) => r.type === typeFilter);
  const shown = ordenTna == null ? filtradas : [...filtradas].sort((a, b) => {
    const va = a.tna ?? (ordenTna === "desc" ? -Infinity : Infinity);
    const vb = b.tna ?? (ordenTna === "desc" ? -Infinity : Infinity);
    return ordenTna === "desc" ? vb - va : va - vb;
  });''', '4/orden')

# 5) CSV
sub('''    const head = "tipo;ticker;moneda;ops;desde;hasta;qty_comprada;ppp_compra;qty_vendida;ppp_venta;abierto;realizado;no_realizado;total";
    const lines = shown.map((r) => [TYPE_LABEL[r.type] || r.type, tickerLabel(r), r.currency, r.ops, r.first || "", r.last || "", r.buyQty, r.pppBuy ?? "", r.sellQty, r.pppSell ?? "", r.open, r.realized.toFixed(2), r.unrealized.toFixed(2), r.total.toFixed(2)].join(";"));''',
'''    const head = "tipo;ticker;moneda;ops;desde;hasta;qty_comprada;ppp_compra;qty_vendida;ppp_venta;abierto;realizado;no_realizado;total;dias;tna_pct";
    const lines = shown.map((r) => [TYPE_LABEL[r.type] || r.type, tickerLabel(r), r.currency, r.ops, r.first || "", r.last || "", r.buyQty, r.pppBuy ?? "", r.sellQty, r.pppSell ?? "", r.open, r.realized.toFixed(2), r.unrealized.toFixed(2), r.total.toFixed(2), r.dias ?? "", r.tna != null ? r.tna.toFixed(2) : ""].join(";"));''', '5/csv')

# 6) encabezado
sub('''                <th style={{ textAlign: "right", padding: "8px 10px" }}>Total</th>
              </tr>''',
'''                <th style={{ textAlign: "right", padding: "8px 10px" }}>Total</th>
                <th style={{ textAlign: "right", padding: "8px 10px" }} title="Días desde la primera compra hasta la última venta (o hasta hoy si sigue abierto)">Días</th>
                <th
                  onClick={() => setOrdenTna((o) => (o == null ? "desc" : o === "desc" ? "asc" : null))}
                  title="Rendimiento anualizado sobre el capital que estuvo invertido cada día (click para ordenar)"
                  style={{ textAlign: "right", padding: "8px 10px", cursor: "pointer", userSelect: "none", color: ordenTna ? C.text : undefined }}>
                  TNA {ordenTna === "desc" ? "▼" : ordenTna === "asc" ? "▲" : ""}
                </th>
              </tr>''', '6/header')

# 7) celdas
sub('''                    {cell(r.total, true)}
                  </tr>''',
'''                    {cell(r.total, true)}
                    <td style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: C.muted }}>{r.dias ?? "—"}</td>
                    <td
                      title={r.tna != null && r.dias != null && r.dias < 30 ? "Menos de 30 días: anualizar tan poco tiempo exagera el número" : undefined}
                      style={{ padding: "7px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", fontWeight: 700,
                        color: r.tna == null ? C.dim : r.tna >= 0 ? C.green : C.red, opacity: r.tna != null && r.dias != null && r.dias < 30 ? 0.55 : 1 }}>
                      {r.tna == null ? "—" : `${r.tna >= 0 ? "+" : "−"}${Math.abs(r.tna).toLocaleString("es-AR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`}
                    </td>
                  </tr>''', '7/celdas')

# 8) colspans
sub('''                      <td colSpan={9} style={{ padding: "0 10px 7px 10px", fontSize: 10.5, color: C.dim }}>''',
    '''                      <td colSpan={11} style={{ padding: "0 10px 7px 10px", fontSize: 10.5, color: C.dim }}>''', '8a/futclose')
sub('''                  <td key={i} style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap", color: v > 0 ? C.green : v < 0 ? C.red : C.dim }}>{fmtM(v)}</td>
                ))}
              </tr>''',
'''                  <td key={i} style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap", color: v > 0 ? C.green : v < 0 ? C.red : C.dim }}>{fmtM(v)}</td>
                ))}
                <td colSpan={2}></td>
              </tr>''', '8b/total')
sub('''                    <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap", color: comisiones < 0 ? C.red : C.dim }}>{fmtM(comisiones)}</td>
                  </tr>''',
'''                    <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap", color: comisiones < 0 ? C.red : C.dim }}>{fmtM(comisiones)}</td>
                    <td colSpan={2}></td>
                  </tr>''', '8c/comisiones')
sub('''                    <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap", color: totNeto > 0 ? C.green : totNeto < 0 ? C.red : C.dim }}>{fmtM(totNeto)}</td>
                  </tr>''',
'''                    <td style={{ padding: "8px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 700, whiteSpace: "nowrap", color: totNeto > 0 ? C.green : totNeto < 0 ? C.red : C.dim }}>{fmtM(totNeto)}</td>
                    <td colSpan={2}></td>
                  </tr>''', '8d/neto')

# 9) nota al pie
sub('''        {" "}<strong style={{ color: C.muted }}>Comisiones</strong> (solo en la vista Todos):''',
'''        {" "}<strong style={{ color: C.muted }}>TNA</strong> = total ÷ (capital invertido × días) × 365: cada peso pesa por el tiempo que estuvo puesto, así se comparan instrumentos que tuviste distinto tiempo. Solo contado (futuros y opciones no inmovilizan capital). Con menos de 30 días se muestra atenuada: anualizar tan poco tiempo exagera.
        {" "}<strong style={{ color: C.muted }}>Comisiones</strong> (solo en la vista Todos):''', '9/nota')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
