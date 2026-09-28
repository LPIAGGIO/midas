# -*- coding: utf-8 -*-
# Posiciones consolidadas con el diseño del Reporte de cartera (27/09/2026,
# pedido de LP: "estilo + columnas"). Solo la vista de ABIERTAS.
import io, re, sys
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

# ---------------------------------------------------------------- 1) helpers
sub('''  { key: "opciones",  label: "Opciones",       types: ["option"] },
];
''', '''  { key: "opciones",  label: "Opciones",       types: ["option"] },
];

// Tipos que son CAPITAL (lo que pagaste está en la cuenta). Futuros y opciones
// no: su "valor" en consolidatePositions es el P&L, así que no suman al valor
// de cartera ni al % de cartera del layout "reporte".
const CONS_CAPITAL_TYPES = new Set(["bond_ars", "bond_usd", "on", "cedear", "stock", "fci", "caucion"]);
// Días de tenencia (DPT) igual que el Reporte de cartera: calendario ART desde
// la primera compra del grupo, mínimo 1.
function consDias(g) {
  if (!g?.firstDate) return null;
  const d = Math.floor((new Date(getTodayStringAR() + "T00:00:00").getTime() - new Date(String(g.firstDate).slice(0, 10) + "T00:00:00").getTime()) / 86400000);
  return Number.isFinite(d) ? Math.max(1, d) : null;
}
''', '1/helpers')

# -------------------------------- 2) P&L del día: de useMemo a función pura
ini = '  const { dailyPnl, dailyPct, marketClosed } = useMemo(() => {\n'
fin = '\n  }, [group, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup]);\n'
i = s.find(ini)
j = s.find(fin, i) if i >= 0 else -1
if s.count(ini) != 1 or j < 0:
    fallos.append('2/daily (%d)' % s.count(ini))
else:
    cuerpo = s[i + len(ini):j]
    cuerpo = '\n'.join(l[2:] if l.startswith('  ') else l for l in cuerpo.split('\n'))
    funcion = ('// P&L del día de un grupo consolidado. Era un useMemo adentro de\n'
               '// ConsolidatedRow; se sacó a función para que la tabla pueda sumar\n'
               '// el "Hoy" en subtotales y total con el MISMO cálculo que la fila.\n'
               'function computeGroupDaily(group, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup) {\n'
               + cuerpo + '\n}\n\n')
    s = (s[:i]
         + '  const _dailyCalc = useMemo(\n'
         + '    () => (daily ? null : computeGroupDaily(group, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup)),\n'
         + '    [daily, group, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup]\n'
         + '  );\n'
         + '  const { dailyPnl, dailyPct, marketClosed } = daily || _dailyCalc;\n'
         + s[j + len(fin):])
    k = s.find('function ConsolidatedRow({')
    s = s[:k] + funcion + s[k:]

# ------------------------------------------------------ 3) firma de la fila
sub('function ConsolidatedRow({ group, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup, expanded, onToggle, onEdit, onDelete, onUpdatePrice, readOnlyPrice = false, pppOverride = null }) {',
    'function ConsolidatedRow({ group, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup, expanded, onToggle, onEdit, onDelete, onUpdatePrice, readOnlyPrice = false, pppOverride = null, layout = "classic", daily = null, dias = null, pctCart = null }) {',
    '3/firma')

# ------------------------------------------------ 4) fila en layout reporte
NUEVA_FILA = '''      {layout === "reporte" ? (() => {
        // Layout "reporte" (27/09/2026): una línea por fila, estilo del Reporte
        // de cartera. Misma data y mismos controles que el layout clásico.
        const RC = { padding: "5px 8px", fontSize: 11.5, color: C.text, borderBottom: expanded ? "none" : `1px solid ${C.border}`, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", verticalAlign: "middle" };
        const RN = { ...RC, textAlign: "right" };
        const cur = group.currency || "ARS";
        const fMon = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : fmtNumber(Number(n), cur === "ARS" ? { maxDecimals: 0 } : { maxDecimals: 2, minDecimals: 2 }));
        const fPctR = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`);
        const esCapital = CONS_CAPITAL_TYPES.has(group.instrument_type);
        const hoyNulo = marketClosed || dailyPnl == null;
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
                {cur !== "ARS" && <span style={{ fontSize: 9, color: C.dim }}>{cur}</span>}
                {rowBroker && <BrokerBadge broker={rowBroker} />}
                {group.isShort && (
                  <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: "0.1em", padding: "0 4px", color: C.red, border: "1px solid rgba(248,113,113,0.30)", borderRadius: 2 }}>SHORT</span>
                )}
              </div>
            </td>
            <td
              style={{ ...RN, color: group.isShort ? C.red : C.text }}
              title={group.instrument_type === "future" && group.notional != null ? `Notional ${fmtNumber(group.notional, { maxDecimals: 0 })} (exposición nominal, no es valor de cartera)` : undefined}
            >
              {fmtNumber(group.netQty, group.instrument_type === "crypto" ? { maxDecimals: 8 } : { maxDecimals: 0 })}
            </td>
            <td style={RN}>{group.ppp != null ? fmtNumber(group.ppp, { maxDecimals: 4, smartDecimals: true }) : "—"}</td>
            <td style={RN} onClick={(e) => e.stopPropagation()}>
              <EditablePriceCell
                position={sampleForCell}
                resolved={resolvedForCell}
                onSave={(newPrice) => {
                  if (!anchorPositionId) return;
                  onUpdatePrice(anchorPositionId, newPrice);
                }}
              />
            </td>
            <td style={RN}>{esCapital ? fMon(group.valueAtCost) : <span style={{ color: C.dim }}>—</span>}</td>
            <td style={RN}>
              {!esCapital ? <span style={{ color: C.dim }}>—</span>
                : group.valueAtMarket != null ? fMon(group.valueAtMarket)
                : <span title="Sin precio de mercado: valuado a costo">{fMon(group.valueAtCost)}<span style={{ color: C.dim, fontSize: 9, marginLeft: 3 }}>c</span></span>}
            </td>
            <td style={{ ...RN, color: pnlColor }}>{group.pnl != null ? fMon(group.pnl) : "—"}</td>
            <td style={{ ...RN, color: pnlColor }}>{fPctR(group.pnlPct)}</td>
            <td style={{ ...RN, color: hoyNulo ? C.dim : dailyColor }}>{hoyNulo ? "—" : fMon(dailyPnl)}</td>
            <td style={{ ...RN, color: hoyNulo ? C.dim : dailyColor }}>{hoyNulo ? "—" : fPctR(dailyPct)}</td>
            <td style={{ ...RN, color: C.muted }}>{dias ?? "—"}</td>
            <td style={{ ...RN, color: C.muted }}>{pctCart != null ? pctCart.toFixed(1) + "%" : "—"}</td>
          </tr>
        );
      })() : (
'''
sub('''    <>
      <tr
        style={{
          borderBottom: expanded ? "none" : `1px solid ${C.border}`,''',
'''    <>
''' + NUEVA_FILA + '''      <tr
        style={{
          borderBottom: expanded ? "none" : `1px solid ${C.border}`,''', '4a/fila-inicio')
sub('''      </tr>

      {/* Fila expandida: muestra cada operación individual del grupo */}''',
'''      </tr>
      )}

      {/* Fila expandida: muestra cada operación individual del grupo */}''', '4b/fila-fin')
sub('''          <td colSpan={readOnlyPrice ? 9 : 10} style={{ padding: 0, backgroundColor: C.deep }}>''',
'''          <td colSpan={layout === "reporte" ? 13 : (readOnlyPrice ? 9 : 10)} style={{ padding: 0, backgroundColor: C.deep }}>''', '4c/colspan')

# ------------------------------------------------------ 5) tabla: datos
sub('''    return m;
  }, [consolidated, isClosed]);
''', '''    return m;
  }, [consolidated, isClosed]);

  // Layout "reporte" (solo abiertas): P&L del día por grupo, para ordenar y
  // para sumar en subtotales con el mismo cálculo que la fila.
  const dailyByKey = useMemo(() => {
    const m = new Map();
    if (isClosed) return m;
    for (const g of consolidated) {
      m.set(g.groupKey, computeGroupDaily(g, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup));
    }
    return m;
  }, [consolidated, isClosed, bondPrices, futurePrices, stockPrices, fciPrices, futureAdjLookup]);
  // Base del % de cartera: capital en pesos (sin futuros ni opciones).
  const capTotal = useMemo(() => {
    let t = 0;
    for (const g of consolidated) {
      if (!CONS_CAPITAL_TYPES.has(g.instrument_type) || (g.currency || "ARS") !== "ARS") continue;
      const v = Number(g.valueAtMarket ?? g.valueAtCost);
      if (Number.isFinite(v)) t += v;
    }
    return t;
  }, [consolidated]);
  const pctCartDe = (g) => {
    if (!CONS_CAPITAL_TYPES.has(g.instrument_type) || (g.currency || "ARS") !== "ARS" || !(capTotal > 0)) return null;
    const v = Number(g.valueAtMarket ?? g.valueAtCost);
    return Number.isFinite(v) ? (v / capTotal) * 100 : null;
  };
''', '5a/datos')
sub('''        case "ops": {
          const n = Number(g.operationsCount);
          return Number.isFinite(n) ? n : 0;
        }
''', '''        case "ops": {
          const n = Number(g.operationsCount);
          return Number.isFinite(n) ? n : 0;
        }
        case "vini": {
          const n = Number(g.valueAtCost);
          return CONS_CAPITAL_TYPES.has(g.instrument_type) && Number.isFinite(n) ? n : -Infinity;
        }
        case "vact": {
          const n = Number(g.valueAtMarket ?? g.valueAtCost);
          return CONS_CAPITAL_TYPES.has(g.instrument_type) && Number.isFinite(n) ? n : -Infinity;
        }
        case "pnlpct": {
          const n = Number(g.pnlPct);
          return g.pnlPct != null && Number.isFinite(n) ? n : -Infinity;
        }
        case "hoy": {
          const d = dailyByKey.get(g.groupKey);
          const n = Number(d?.dailyPnl);
          return d && !d.marketClosed && d.dailyPnl != null && Number.isFinite(n) ? n : -Infinity;
        }
        case "dpt": {
          const n = consDias(g);
          return n == null ? -Infinity : n;
        }
        case "cart": {
          const n = pctCartDe(g);
          return n == null ? -Infinity : n;
        }
''', '5b/sort')
sub('''  }, [consolidated, sortKey, sortDir, pppOverrides]);''',
    '''  }, [consolidated, sortKey, sortDir, pppOverrides, dailyByKey, capTotal]);''', '5c/deps')
sub('''  }, [displayRows, sortKey]);
''', '''  }, [displayRows, sortKey]);

  // Subtotales por categoría y TOTAL de contado (layout "reporte").
  const sumar = (rows) => {
    const t = { ini: 0, act: 0, rdo: 0, hoy: 0, hasHoy: false, n: 0 };
    for (const r of rows) {
      t.n++;
      const vi = Number(r.valueAtCost), va = Number(r.valueAtMarket ?? r.valueAtCost), p = Number(r.pnl);
      if (Number.isFinite(vi)) t.ini += vi;
      if (Number.isFinite(va)) t.act += va;
      if (r.pnl != null && Number.isFinite(p)) t.rdo += p;
      const d = dailyByKey.get(r.groupKey);
      if (d && !d.marketClosed && d.dailyPnl != null && Number.isFinite(Number(d.dailyPnl))) { t.hoy += Number(d.dailyPnl); t.hasHoy = true; }
    }
    return t;
  };
  const catTotals = useMemo(() => {
    const out = new Map();
    for (const cat of categorized) {
      const monedas = new Set(cat.rows.map((r) => r.currency || "ARS"));
      out.set(cat.key, {
        ...sumar(cat.rows),
        mono: monedas.size === 1,
        cur: cat.rows[0]?.currency || "ARS",
        capital: cat.rows.every((r) => CONS_CAPITAL_TYPES.has(r.instrument_type)),
      });
    }
    return out;
  }, [categorized, dailyByKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const grand = useMemo(() => {
    const cap = consolidated.filter((g) => CONS_CAPITAL_TYPES.has(g.instrument_type));
    const ars = cap.filter((g) => (g.currency || "ARS") === "ARS");
    return { ...sumar(ars), mixed: ars.length !== cap.length };
  }, [consolidated, dailyByKey]); // eslint-disable-line react-hooks/exhaustive-deps
''', '5d/totales')

# ------------------------------------------------------ 6) tabla: render
TABLA = '''
  // ─── Layout "reporte" (27/09/2026, pedido de LP) ───
  // Posiciones consolidadas con el diseño del Reporte de cartera: una línea
  // por fila, % en su propia columna, V. inicial / V. actual / DPT / % de
  // cartera, subtotal por categoría y TOTAL de contado. Conserva lo que el
  // reporte no tiene: P&L de hoy, editar precio, desplegar operaciones y el
  // broker. Solo ABIERTAS: "cerradas hoy" sigue con el layout clásico.
  if (!isClosed) {
    const RC = { padding: "5px 8px", fontSize: 11.5, color: C.text, borderBottom: `1px solid ${C.border}`, fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
    const RN = { ...RC, textAlign: "right" };
    const HS = { padding: "6px 8px", fontSize: 10, letterSpacing: "0.03em", borderBottom: `1px solid ${C.border}` };
    const fMon = (n, cur) => (n == null || !Number.isFinite(Number(n)) ? "—" : fmtNumber(Number(n), (cur || "ARS") === "ARS" ? { maxDecimals: 0 } : { maxDecimals: 2, minDecimals: 2 }));
    const fPctR = (n) => (n == null || !Number.isFinite(Number(n)) ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`);
    const colR = (n) => (n == null || !Number.isFinite(Number(n)) ? C.dim : n >= 0 ? C.green : C.red);
    const COLS = 13;
    return (
      <div style={{ backgroundColor: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1020 }}>
            <thead>
              <tr>
                <PTh dense style={{ ...HS, width: 22, paddingRight: 0 }}>{""}</PTh>
                <PTh dense style={HS} {...sortProps("ticker")}>Ticker</PTh>
                <PTh dense align="right" style={HS} {...sortProps("cantidad")}>Cant.</PTh>
                <PTh dense align="right" style={HS} {...sortProps("ppp")}>PPC</PTh>
                <PTh dense align="right" style={HS} {...sortProps("precio")}>P. actual</PTh>
                <PTh dense align="right" style={HS} {...sortProps("vini")}>V. inicial</PTh>
                <PTh dense align="right" style={HS} {...sortProps("vact")}>V. actual</PTh>
                <PTh dense align="right" style={HS} {...sortProps("pnl")}>Rdo.</PTh>
                <PTh dense align="right" style={HS} {...sortProps("pnlpct")}>% R.</PTh>
                <PTh dense align="right" style={HS} {...sortProps("hoy")}>Hoy</PTh>
                <PTh dense align="right" style={HS}>% Hoy</PTh>
                <PTh dense align="right" style={HS} {...sortProps("dpt")}>DPT</PTh>
                <PTh dense align="right" style={HS} {...sortProps("cart")}>% Cart.</PTh>
              </tr>
            </thead>
            <tbody>
              {categorized.map((cat) => {
                const t = catTotals.get(cat.key);
                return (
                  <Fragment key={cat.key}>
                    <tr style={{ background: C.deep }}>
                      <td colSpan={COLS} style={{ ...RC, fontFamily: "inherit", fontWeight: 700, color: C.text }}>
                        {cat.label} <span style={{ color: C.dim, fontWeight: 400 }}>({cat.rows.length})</span>
                      </td>
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
                        layout="reporte"
                        daily={dailyByKey.get(g.groupKey) || null}
                        dias={consDias(g)}
                        pctCart={pctCartDe(g)}
                      />
                    ))}
                    {t && t.mono && (
                      <tr style={{ background: "rgba(255,255,255,0.02)" }}>
                        <td colSpan={5} style={{ ...RC, fontFamily: "inherit", fontWeight: 600, color: C.muted }}>Subtotal · {cat.label}</td>
                        <td style={{ ...RN, fontWeight: 700 }}>{t.capital ? fMon(t.ini, t.cur) : ""}</td>
                        <td style={{ ...RN, fontWeight: 700 }}>{t.capital ? fMon(t.act, t.cur) : ""}</td>
                        <td style={{ ...RN, fontWeight: 700, color: colR(t.rdo) }}>{fMon(t.rdo, t.cur)}</td>
                        <td style={{ ...RN, fontWeight: 700, color: colR(t.rdo) }}>{t.capital && t.ini > 0 ? fPctR((t.rdo / t.ini) * 100) : ""}</td>
                        <td style={{ ...RN, fontWeight: 700, color: t.hasHoy ? colR(t.hoy) : C.dim }}>{t.hasHoy ? fMon(t.hoy, t.cur) : "—"}</td>
                        <td style={RN}></td>
                        <td style={RN}></td>
                        <td style={{ ...RN, fontWeight: 600, color: C.muted }}>{t.capital && t.cur === "ARS" && capTotal > 0 ? ((t.act / capTotal) * 100).toFixed(1) + "%" : ""}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {grand.n > 0 && (
                <tr style={{ background: C.deep, borderTop: `2px solid ${C.border}` }}>
                  <td colSpan={5} style={{ ...RC, fontFamily: "inherit", fontWeight: 700 }}
                    title="Solo contado (bonos, ONs, CEDEARs, acciones, FCI, cauciones). Futuros y opciones llevan su subtotal pero no suman: su valor es el P&L, no capital.">
                    TOTAL contado{grand.mixed ? " (solo pesos)" : ""}
                  </td>
                  <td style={{ ...RN, fontWeight: 700 }}>{fMon(grand.ini, "ARS")}</td>
                  <td style={{ ...RN, fontWeight: 700 }}>{fMon(grand.act, "ARS")}</td>
                  <td style={{ ...RN, fontWeight: 700, color: colR(grand.rdo) }}>{fMon(grand.rdo, "ARS")}</td>
                  <td style={{ ...RN, fontWeight: 700, color: colR(grand.rdo) }}>{grand.ini > 0 ? fPctR((grand.rdo / grand.ini) * 100) : "—"}</td>
                  <td style={{ ...RN, fontWeight: 700, color: grand.hasHoy ? colR(grand.hoy) : C.dim }}>{grand.hasHoy ? fMon(grand.hoy, "ARS") : "—"}</td>
                  <td colSpan={3} style={RN}></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
'''
sub('''    onSort: handleSort,
  });

  return (
    <div
      style={{
        backgroundColor: C.panel,
        border: `1px solid ${C.border}`,
        overflow: "hidden",
      }}
    >''', '''    onSort: handleSort,
  });
''' + TABLA + '''
  return (
    <div
      style={{
        backgroundColor: C.panel,
        border: `1px solid ${C.border}`,
        overflow: "hidden",
      }}
    >''', '6/tabla')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos))
    sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
