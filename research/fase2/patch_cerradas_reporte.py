# -*- coding: utf-8 -*-
# "Posiciones cerradas hoy" con el mismo diseño que las abiertas (layout
# reporte): pedido de LP 29/09/2026.
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

# 1) tabla: reemplazar el layout clásico de cerradas por el reporte
ini = s.find('''  return (
    <div
      style={{
        backgroundColor: C.panel,
        border: `1px solid ${C.border}`,
        overflow: "hidden",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Roboto', sans-serif" }}>''')
fin = s.find('''// pppOverride: PPP alternativo SOLO para mostrar en la celda PPP''')
if ini < 0 or fin < 0 or fin < ini or s.count("function ConsolidatedTable(") != 1:
    fallos.append('1/clasico (%d,%d)' % (ini, fin))
else:
    NUEVO = '''  // ─── Cerradas hoy, layout "reporte" (29/09/2026, pedido de LP) ───
  // El mismo diseño que las abiertas: una línea por fila, % en su columna,
  // categoría con conteo, subtotal y TOTAL. La ganancia del día va en la
  // franja cian (es el "Hoy" de lo que se cerró). Cantidad = lo cerrado HOY
  // (el neto ya es 0). Se sacó la columna Total: en una cerrada repetía el P&L.
  const RC = { padding: "5px 8px", fontSize: 11.5, color: C.text, borderBottom: `1px solid ${C.border}`, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const RN = { ...RC, textAlign: "right" };
  const HS = { padding: "6px 8px", fontSize: 10, letterSpacing: "0.03em", borderBottom: `1px solid ${C.border}` };
  const fMon = (n, cur) => (n == null || !Number.isFinite(Number(n)) ? "—" : `${Number(n) >= 0 ? "+" : ""}${fmtNumber(Number(n), (cur || "ARS") === "ARS" ? { maxDecimals: 0 } : { maxDecimals: 2, minDecimals: 2 })}`);
  const colR = (n) => (n == null || !Number.isFinite(Number(n)) ? C.dim : n >= 0 ? C.green : C.red);
  const BANDA_I = { borderLeft: `3px solid ${C.cat.cyan}` };
  const BANDA_D = { borderRight: `3px solid ${C.cat.cyan}` };
  const COLS = 9;
  const sumaPnl = (rows) => rows.reduce((acc, r) => acc + (r.pnl != null && Number.isFinite(Number(r.pnl)) ? Number(r.pnl) : 0), 0);
  const totalArs = sumaPnl(consolidated.filter((g) => (g.currency || "ARS") === "ARS"));
  const hayOtraMoneda = consolidated.some((g) => (g.currency || "ARS") !== "ARS");
  return (
    <div style={{ backgroundColor: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead>
            <tr>
              <PTh dense style={{ ...HS, width: 22, paddingRight: 0 }}>{""}</PTh>
              <PTh dense style={HS} {...sortProps("ticker")}>Ticker</PTh>
              <PTh dense align="right" style={HS}>Cant.</PTh>
              {/* Base del día: cierre de ayer para lo arrastrado, precio de
                  compra para lo operado hoy. Es contra lo que se mide la fila. */}
              <PTh dense align="right" style={HS} {...sortProps("ppp")}>Base día</PTh>
              <PTh dense align="right" style={HS} {...sortProps("precio")}>Últ. precio</PTh>
              <PTh dense align="right" style={{ ...HS, ...BANDA_I, color: C.cat.cyan, fontWeight: 700 }} {...sortProps("pnl")}>Ganancia día</PTh>
              <PTh dense align="right" style={{ ...HS, ...BANDA_D, color: C.cat.cyan, fontWeight: 700 }}>%</PTh>
              <PTh dense style={HS} {...sortProps("moneda")}>Moneda</PTh>
              <PTh dense align="right" style={HS} {...sortProps("ops")}>Ops</PTh>
            </tr>
          </thead>
          <tbody>
            {categorized.map((cat) => {
              const mono = new Set(cat.rows.map((r) => r.currency || "ARS")).size === 1;
              const cur = cat.rows[0]?.currency || "ARS";
              const sub = sumaPnl(cat.rows);
              return (
                <Fragment key={cat.key}>
                  <tr style={{ background: C.deep }}>
                    <td colSpan={5} style={{ ...RC, fontFamily: "inherit", fontWeight: 700, color: C.text }}>
                      {cat.label} <span style={{ color: C.dim, fontWeight: 400 }}>({cat.rows.length})</span>
                    </td>
                    <td style={{ ...RC, ...BANDA_I }}></td>
                    <td style={{ ...RC, ...BANDA_D }}></td>
                    <td colSpan={COLS - 7} style={RC}></td>
                  </tr>
                  {cat.rows.map((g) => (
                    <ConsolidatedRow
                      key={g.groupKey}
                      group={g}
                      bondPrices={bondPrices}
                      futurePrices={futurePrices}
                      stockPrices={stockPrices}
                      fciPrices={fciPrices}
                      futureAdjLookup={futureAdjLookup}
                      expanded={expanded.has(g.groupKey)}
                      onToggle={() => toggle(g.groupKey)}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      onUpdatePrice={onUpdatePrice}
                      readOnlyPrice
                      pppOverride={pppOverrides?.get(g.groupKey) ?? null}
                      layout="reporte-cerrada"
                    />
                  ))}
                  {mono && (
                    <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                      <td colSpan={5} style={{ ...RC, fontFamily: "inherit", fontWeight: 600, color: C.muted }}>Subtotal · {cat.label}</td>
                      <td style={{ ...RN, ...BANDA_I, fontWeight: 700, color: colR(sub) }}>{fMon(sub, cur)}</td>
                      <td style={{ ...RN, ...BANDA_D }}></td>
                      <td colSpan={COLS - 7} style={RN}></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            <tr style={{ background: C.deep, borderTop: `2px solid ${C.border}` }}>
              <td colSpan={5} style={{ ...RC, fontFamily: "inherit", fontWeight: 700 }}>
                TOTAL ganancia del día{hayOtraMoneda ? " (solo pesos)" : ""}
              </td>
              <td style={{ ...RN, ...BANDA_I, fontWeight: 700, color: colR(totalArs) }}>{fMon(totalArs, "ARS")}</td>
              <td style={{ ...RN, ...BANDA_D }}></td>
              <td colSpan={COLS - 7} style={RN}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}


'''
    s = s[:ini] + NUEVO + s[fin:]

# 2) fila: layout "reporte-cerrada"
sub('''      })() : (
      <tr
        style={{
          borderBottom: expanded ? "none" : `1px solid ${C.border}`,''',
'''      })() : layout === "reporte-cerrada" ? (() => {
        // Cerradas hoy con el diseño del reporte (29/09/2026).
        const RC = { padding: "5px 8px", fontSize: 11.5, color: C.text, borderBottom: expanded ? "none" : `1px solid ${C.border}`, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", verticalAlign: "middle" };
        const RN = { ...RC, textAlign: "right" };
        const cur = group.currency || "ARS";
        const esRf = group.instrument_type === "bond_ars" || group.instrument_type === "bond_usd" || group.instrument_type === "on";
        const cant = Number(group.closedQty) > 0 ? Number(group.closedQty) : null;
        const base = pppOverride ?? group.ppp;
        return (
          <tr
            style={{ backgroundColor: expanded ? "rgba(91,141,214,0.04)" : "transparent", cursor: "pointer", transition: "background-color 100ms ease" }}
            onClick={onToggle}
            onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.015)"; }}
            onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.backgroundColor = "transparent"; }}
          >
            <td style={{ ...RC, width: 22, paddingRight: 0, color: C.dim }}>
              <span style={{ display: "inline-flex" }}>
                {expanded ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
              </span>
            </td>
            <td style={RC}>
              <div className="flex items-center" style={{ gap: 6 }}>
                <span style={{ fontWeight: 600, color: "#f59e0b" }}>{fciDisplayName(group.ticker)}</span>
                {rowBroker && <BrokerBadge broker={rowBroker} />}
              </div>
            </td>
            <td style={RN} title="Cantidad cerrada hoy">{cant != null ? fmtNumber(cant, group.instrument_type === "crypto" ? { maxDecimals: 8 } : { maxDecimals: 0 }) : "—"}</td>
            <td style={RN}>{base != null ? fmtNumber(base, { maxDecimals: 4, smartDecimals: true }) : "—"}</td>
            <td style={RN}>{group.currentPrice != null ? fmtNumber(group.currentPrice, { maxDecimals: 4, minDecimals: esRf ? 3 : 0, smartDecimals: true }) : "—"}</td>
            <td style={{ ...RN, borderLeft: `3px solid ${C.cat.cyan}`, fontWeight: 700, color: pnlColor }}>
              {group.pnl != null ? `${pnlSign}${fmtNumber(group.pnl, cur === "ARS" ? { maxDecimals: 0 } : { maxDecimals: 2, minDecimals: 2 })}` : "—"}
            </td>
            <td style={{ ...RN, borderRight: `3px solid ${C.cat.cyan}`, fontWeight: 700, color: pnlColor }}>
              {group.pnlPct != null ? `${group.pnlPct >= 0 ? "+" : "−"}${Math.abs(group.pnlPct).toFixed(2)}%` : "—"}
            </td>
            <td style={{ ...RC, color: C.muted, fontFamily: "inherit" }}>{cur}</td>
            <td style={{ ...RN, color: C.muted }}>{group.operations.length}</td>
          </tr>
        );
      })() : (
      <tr
        style={{
          borderBottom: expanded ? "none" : `1px solid ${C.border}`,''', '2/fila')

sub('''          <td colSpan={layout === "reporte" ? 13 : (readOnlyPrice ? 9 : 10)} style={{ padding: 0, backgroundColor: C.deep }}>''',
'''          <td colSpan={layout === "reporte" ? 13 : layout === "reporte-cerrada" ? 9 : (readOnlyPrice ? 9 : 10)} style={{ padding: 0, backgroundColor: C.deep }}>''', '3/colspan')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
