# -*- coding: utf-8 -*-
# Fundamentals: filtro estilo Lynch + dilución + textos viejos (29/09/2026).
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

# 1) universo: NU (en cartera), LLY y CAT (los que pregunta Pablo)
sub('''const FUND_UNIVERSE = "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,NFLX,AVGO,KO,MELI,JPM,V,MA,WMT,JNJ,PG,XOM,DIS,COIN,PLTR,MSTR,QCOM,MU,INTC,ORCL,CRM,NKE,BA,CRWV,IREN,SNDK,SPCX";''',
'''const FUND_UNIVERSE = "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,AMD,NFLX,AVGO,KO,MELI,JPM,V,MA,WMT,JNJ,PG,XOM,DIS,COIN,PLTR,MSTR,QCOM,MU,INTC,ORCL,CRM,NKE,BA,CRWV,IREN,SNDK,SPCX,NU,LLY,CAT";''', '1/universo')
sub('''  XOM: "Petróleo · Energía", BE: "Energía · Fuel cells", BA: "Aeroespacial", SPCX: "Aeroespacial · Espacio",''',
'''  XOM: "Petróleo · Energía", BE: "Energía · Fuel cells", BA: "Aeroespacial", SPCX: "Aeroespacial · Espacio",
  NU: "Fintech LatAm", LLY: "Salud · Farma", CAT: "Maquinaria · Industria",''', '1b/temas')

# 2) aviso de dilución + filtro Lynch
sub('''  if (r?.de != null && isFinite(r.de) && r.de > 200) {''',
'''  if (r?.shrYoY != null && isFinite(r.shrYoY) && r.shrYoY > 0.03) {
    out.push({ k: "dil", label: "dilución", color: "#fb923c",
      tip: `Las acciones en circulación crecieron ${(r.shrYoY * 100).toFixed(1).replace(".", ",")}% en un año (emisión o pago en acciones). La empresa puede ganar más en total y cada acción no: lo que importa es el EPS, no la ganancia total.` });
  }
  if (r?.de != null && isFinite(r.de) && r.de > 200) {''', '2/aviso')

sub('''function FundamentalsModule() {''',
'''/* Filtro estilo Peter Lynch: el screener de Finviz que publicó Matias Scalbi
 * (29/09/2026) adaptado a lo que da Yahoo. Busca "fast growers" RENTABLES que
 * ya demostraron crecimiento. Dos diferencias con el original, a la vista en
 * el glosario: el crecimiento es de 2-3 años (Yahoo no da 5) y la deuda es la
 * TOTAL sobre patrimonio, no solo la de largo plazo (más exigente).
 * Un criterio sin dato (bancos no reportan D/E) no cuenta como falla; con dos
 * sin dato no se da por aprobado. OJO con lo que NO dice: el crecimiento
 * pasado casi no predice el futuro (Chan-Karceski-Lakonishok 2003). El filtro
 * encuentra empresas que YA crecieron; es una criba para investigar, no una
 * señal. */
const FUND_LYNCH = [
  { k: "eps", label: "EPS crece ≥15% anual", get: (r) => r.epsCagr, ok: (v) => v >= 0.15 },
  { k: "rev", label: "Ventas crecen ≥10% anual", get: (r) => r.revCagr, ok: (v) => v >= 0.10 },
  { k: "op", label: "Margen operativo positivo", get: (r) => r.opMrg, ok: (v) => v > 0 },
  { k: "net", label: "Margen neto positivo", get: (r) => r.netMrg, ok: (v) => v > 0 },
  { k: "de", label: "Deuda/patrimonio < 50%", get: (r) => r.de, ok: (v) => v < 50 },
];
function fundLynch(r) {
  const items = FUND_LYNCH.map((c) => {
    const v = c.get(r);
    const hay = v != null && isFinite(v);
    return { k: c.k, label: c.label, estado: !hay ? "nd" : c.ok(v) ? "ok" : "no" };
  });
  const ok = items.filter((i) => i.estado === "ok").length;
  const nd = items.filter((i) => i.estado === "nd").length;
  const no = items.length - ok - nd;
  return { items, ok, nd, no, pasa: no === 0 && nd <= 1 };
}

function FundamentalsModule() {''', '2b/lynch')

# 3) estado del filtro
sub('''  const [fila, setFila] = useState(null);     // ticker con el detalle desplegado
''',
'''  const [fila, setFila] = useState(null);     // ticker con el detalle desplegado
  const [soloLynch, setSoloLynch] = useState(false);
''', '3/estado')

# 4) PEG con crecimiento esperado + Lynch por fila
sub('''      const fwdOk = r.fwdPE != null && isFinite(r.fwdPE) && r.fwdPE > 0;
      const grwOk = r.earnGrw != null && isFinite(r.earnGrw) && r.earnGrw > 0;''',
'''      const fwdOk = r.fwdPE != null && isFinite(r.fwdPE) && r.fwdPE > 0;
      // Crecimiento para el PEG: el ESPERADO del próximo año (consenso), que es
      // lo que usaba Lynch y va con el P/E forward. Si no hay, el del último
      // trimestre contra el mismo del año anterior (lo que se usaba hasta el
      // 29/09/2026, más ruidoso).
      const grwFwdOk = r.grwFwd != null && isFinite(r.grwFwd);
      const grw = grwFwdOk ? r.grwFwd : r.earnGrw;
      const grwOk = grw != null && isFinite(grw) && grw > 0;''', '4a/grw')
sub('''      const pegNS = fwdOk && grwOk && r.earnGrw > 1;
      const peg = fwdOk && grwOk && !pegNS ? r.fwdPE / (r.earnGrw * 100) : null;''',
'''      const pegNS = fwdOk && grwOk && grw > 1;
      const peg = fwdOk && grwOk && !pegNS ? r.fwdPE / (grw * 100) : null;''', '4b/peg')
sub('''      return { ...r, mcapRank: mr.get(r.ticker) ?? null, peg, pegNS, earnYield, prima };''',
'''      const lynch = fundLynch(r);
      // Para ordenar: los que pasan arriba, después por cantidad de criterios.
      const lynchOk = lynch.ok + (lynch.pasa ? 10 : 0);
      return { ...r, mcapRank: mr.get(r.ticker) ?? null, peg, pegNS, pegFuente: grwFwdOk ? "fwd" : "trim", earnYield, prima, lynch, lynchOk };''', '4c/lynch')

# 5) filtro en la tabla
sub('''  const sorted = useMemo(() => {
    const arr = [...scored];''',
'''  const lynchN = useMemo(() => scored.filter((r) => r.lynch?.pasa).length, [scored]);
  const sorted = useMemo(() => {
    const arr = soloLynch ? scored.filter((r) => r.lynch?.pasa) : [...scored];''', '5a/filtro')
sub('''    return arr;
  }, [scored, sortKey, sortDir]);''',
'''    return arr;
  }, [scored, sortKey, sortDir, soloLynch]);''', '5b/deps')
sub('''  const primaColor = (p) => (p == null ? C.muted : p > 5 ? "#34d399" : p >= 0 ? "#fbbf24" : "#f87171");''',
'''  const primaColor = (p) => (p == null ? C.muted : p > 5 ? "#34d399" : p >= 0 ? "#fbbf24" : "#f87171");
  // Dilución: rojo arriba de 3% anual, ámbar 1-3%, verde si recompra.
  const dilColor = (x) => (x == null || !isFinite(x) ? C.dim : x > 0.03 ? "#f87171" : x > 0.01 ? "#fbbf24" : x < -0.005 ? "#34d399" : C.muted);
  const fSig = (x, d = 1) => (x == null || !isFinite(x) ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(d).replace(".", ",")}%`);
  // Textos de Seguimientos calculados con el dato del día (antes estaban
  // escritos a mano y se quedaban viejos).
  const quemanN = scored.filter((r) => (r.netMrg != null && r.netMrg < 0) || (r.fcf != null && r.fcf < 0) || !(r.fwdPE > 0)).length;
  const conCedear = cedearSet ? scored.map((r) => r.ticker).filter((t) => cedearSet.has(t)).sort() : null;''', '5c/helpers')

# 6) snapshot diario, no semanal
sub('''              ? `snapshot semanal · ${''', '''              ? `snapshot diario · ${''', '6/rotulo')

# 7) glosario
sub('''                ["PEG", "P/E fwd ÷ crecimiento de ganancias (en puntos). Cuánto pagás por cada punto de crecimiento. <1 barato para lo que crece, 1–2 razonable, >2 caro."],''',
'''                ["PEG", "P/E fwd ÷ crecimiento ESPERADO del EPS del próximo año (consenso de analistas, en puntos; si no hay consenso, el del último trimestre). Cuánto pagás por cada punto de crecimiento. <1 barato para lo que crece, 1–2 razonable, >2 caro. Es una estimación: si el crecimiento no llega, el PEG mentía."],''', '7a/peg')
sub('''                ["2. Contra su propio historial", "El múltiplo de hoy contra su rango de los últimos años. Se empezó a acumular el 11/08/2026 en la tabla fundamentals_history; todavía no hay muestra suficiente."],''',
'''                ["2. Contra su propio historial", "El múltiplo de hoy contra su rango de los últimos años. Se acumula a diario desde el 11/08/2026 en la tabla fundamentals_history. Con menos de un año no alcanza: hace falta al menos un ciclo completo de resultados para que el rango propio signifique algo."],''', '7b/historia')
sub('''              { h: "Otras columnas", rows: [''',
'''              { h: "Crecimiento y filtro Lynch", rows: [
                ["Dil", "Cuánto crecieron las acciones en circulación en un año (diluidas promedio, último trimestre contra el de un año antes). Positivo = te diluyen (emisión, pago en acciones); negativo = recompra. Rojo arriba de 3%. Si una empresa gana 20% más pero emite 20% más acciones, el EPS no se movió."],
                ["EPS / Ventas anual", "Crecimiento anual compuesto del EPS diluido y de las ventas, desde el primer año con base positiva hasta el último cierre anual. Yahoo da hasta 4 años: es un crecimiento de 2 o 3 años, no de 5."],
                ["SBC / ventas", "Compensación pagada en acciones sobre ventas (últimos 12 meses). No sale caja, pero diluye: es un costo real para el accionista."],
                ["Lynch", "Cuántos de los cinco criterios cumple: EPS ≥15% anual, ventas ≥10% anual, margen operativo y neto positivos, deuda/patrimonio <50%. Adaptado del screener de Finviz que publicó Matias Scalbi. La deuda es la TOTAL (Finviz usa la de largo plazo), así que es más exigente. Un criterio sin dato no cuenta como falla (los bancos no informan D/E)."],
                ["Lo que el filtro no dice", "El crecimiento pasado casi no predice el futuro: Chan, Karceski y Lakonishok (2003) midieron que la persistencia del crecimiento de ganancias apenas supera al azar. El filtro encuentra empresas que YA crecieron; es una criba para investigar, no una señal de compra. Para cíclicas, turnarounds o empresas sin ganancias no sirve."],
              ] },
              { h: "Otras columnas", rows: [''', '7c/lynch')

# 8) botón del filtro al lado de las listas
sub('''              {l.label}
              <span style={{ fontSize: 10, marginLeft: 6, color: C.dim }}>{l.tickers.split(",").length}</span>
            </button>
          );
        })}
      </div>''',
'''              {l.label}
              <span style={{ fontSize: 10, marginLeft: 6, color: C.dim }}>{l.tickers.split(",").length}</span>
            </button>
          );
        })}
        <span style={{ width: 1, height: 18, background: C.border, margin: "0 4px" }} />
        <button
          onClick={() => setSoloLynch((v) => !v)}
          title="Mostrar solo los que pasan el filtro estilo Peter Lynch (ver glosario)"
          style={{
            padding: "5px 12px", fontSize: 12, fontWeight: soloLynch ? 700 : 500, cursor: "pointer", borderRadius: 6,
            border: `1px solid ${soloLynch ? "#34d399" : C.border}`,
            background: soloLynch ? "rgba(52,211,153,0.10)" : "transparent",
            color: soloLynch ? "#34d399" : C.muted,
          }}
        >
          Filtro Lynch
          <span style={{ fontSize: 10, marginLeft: 6, color: C.dim }}>{data ? lynchN : ""}</span>
        </button>
      </div>

      {soloLynch && (
        <div className="flex" style={{ gap: 8, alignItems: "flex-start", border: `1px solid ${C.border}`, background: C.deep, borderRadius: 8, padding: "10px 14px", marginBottom: 12 }}>
          <Info size={13} color={C.dim} strokeWidth={1.7} style={{ marginTop: 2, flexShrink: 0 }} />
          <span style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.55 }}>
            <b style={{ color: C.text }}>EPS ≥15% y ventas ≥10% anual, márgenes positivos, deuda/patrimonio &lt;50%.</b> Encuentra
            empresas que <b style={{ color: C.text }}>ya</b> crecieron; que sigan creciendo es otra pregunta (la persistencia del
            crecimiento apenas supera al azar, Chan-Karceski-Lakonishok 2003). Es la criba para empezar a investigar: después
            viene entender el negocio, la dilución y cuánto crecimiento ya está en el precio (PEG, en el detalle).
          </span>
        </div>
      )}''', '8/boton')

# 9) Seguimientos: textos calculados
sub('''              <b style={{ color: C.text }}>Son quince nombres y una sola apuesta.</b> Mirá la columna Tema:''',
'''              <b style={{ color: C.text }}>Son {scored.length || FUND_SEGUIMIENTOS.split(",").length} nombres y una sola apuesta.</b> Mirá la columna Tema:''', '9a/quince')
sub('''              <b style={{ color: C.text }}>Casi todas pierden plata o queman caja</b> y el valor depende de que el backlog''',
'''              <b style={{ color: C.text }}>{scored.length ? `${quemanN} de ${scored.length} pierden plata o queman caja` : "La mayoría pierde plata o quema caja"}</b> y el valor depende de que el backlog''', '9b/queman')
sub('''              (data centers con energía aprobada), agregados el 17/08. Con CEDEAR:{" "}
              <b className="eco-mono" style={{ color: C.text }}>ONDS, ALAB, MRVL</b>; el resto se compra en EE.UU.''',
'''              (data centers con energía aprobada), agregados el 17/08. Con CEDEAR hoy:{" "}
              <b className="eco-mono" style={{ color: C.text }}>{conCedear == null ? "…" : conCedear.length ? conCedear.join(", ") : "ninguna"}</b>; el resto se compra en EE.UU.''', '9c/cedear')

# 10) columnas Dil y Lynch
sub('''              <Th k="mcap" label="Cap" right tip="Capitalización de mercado en dólares." />''',
'''              <Th k="shrYoY" label="Dil" right tip="Dilución: cuánto crecieron las acciones en circulación en un año. Negativo = recompra. Rojo arriba de 3%." />
              <Th k="lynchOk" label="Lynch" right tip="Criterios del filtro estilo Peter Lynch que cumple (EPS ≥15%, ventas ≥10%, márgenes positivos, deuda <50%). Ver glosario." />
              <Th k="mcap" label="Cap" right tip="Capitalización de mercado en dólares." />''', '10a/headers')
sub('''                      <td style={{ ...td, textAlign: "right", color: C.muted }}>{fBig(r.mcap)}</td>''',
'''                      <td style={{ ...td, textAlign: "right", color: dilColor(r.shrYoY) }}>{fSig(r.shrYoY)}</td>
                      <td style={{ ...td, textAlign: "right", fontWeight: r.lynch.pasa ? 700 : 400, color: r.lynch.pasa ? "#34d399" : C.dim }}
                        title={r.lynch.items.map((i) => `${i.estado === "ok" ? "✓" : i.estado === "no" ? "✗" : "—"} ${i.label}`).join("\\n")}>
                        {r.lynch.pasa ? "✓ " : ""}{r.lynch.ok}/{r.lynch.ok + r.lynch.no}
                      </td>
                      <td style={{ ...td, textAlign: "right", color: C.muted }}>{fBig(r.mcap)}</td>''', '10b/celdas')
sub('''                            {a.k === "pico" ? "pico" : a.k === "sin" ? "s/gan" : "deuda"}''',
'''                            {a.k === "pico" ? "pico" : a.k === "sin" ? "s/gan" : a.k === "dil" ? "dil" : "deuda"}''', '10c/pill')
sub('''                        <td colSpan={14} style={{ padding: "14px 16px" }}>''',
'''                        <td colSpan={16} style={{ padding: "14px 16px" }}>''', '10d/colspan')
sub('''          <table style={{ width: "100%", minWidth: 980, borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim, textAlign: "left", background: "rgba(255,255,255,0.02)", whiteSpace: "nowrap" }}>
              <th style={{ padding: "7px 9px", fontWeight: 600 }}>#</th>
              <Th k="ticker" label="Ticker" />''',
'''          <table style={{ width: "100%", minWidth: 1080, borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ borderBottom: `1px solid ${C.border}`, color: C.dim, textAlign: "left", background: "rgba(255,255,255,0.02)", whiteSpace: "nowrap" }}>
              <th style={{ padding: "7px 9px", fontWeight: 600 }}>#</th>
              <Th k="ticker" label="Ticker" />''', '10e/ancho')

# 11) detalle: grupo Crecimiento + checklist
sub('''                  { g: "Valuación", k: "PEG", v: r.pegNS ? "n/s" : fCom(r.peg, 2), c: r.pegNS ? C.muted : pegColor(r.peg),
                    d: r.pegNS
                      ? "Crecimiento arriba del 100%: el PEG pierde sentido — daría casi cero y parecería regalado justo en el pico del ciclo."
                      : "P/E sobre crecimiento de ganancias: cuánto pagás por cada punto de crecimiento. Menos de 1 es barato para lo que crece." },''',
'''                  { g: "Valuación", k: "PEG", v: r.pegNS ? "n/s" : fCom(r.peg, 2), c: r.pegNS ? C.muted : pegColor(r.peg),
                    d: r.pegNS
                      ? "Crecimiento arriba del 100%: el PEG pierde sentido — daría casi cero y parecería regalado justo en el pico del ciclo."
                      : `P/E sobre crecimiento ${r.pegFuente === "fwd" ? "esperado del próximo año (consenso)" : "del último trimestre (no hay consenso)"}: cuánto pagás por cada punto de crecimiento. Menos de 1 es barato para lo que crece.` },
                  { g: "Crecimiento", k: `EPS anual${r.epsAnios ? ` (${r.epsAnios} años)` : ""}`, v: fSig(r.epsCagr), c: r.epsCagr == null ? C.muted : r.epsCagr >= 0.15 ? "#34d399" : r.epsCagr < 0 ? "#f87171" : C.text,
                    d: "Crecimiento compuesto del EPS diluido entre cierres anuales. Lynch pedía 15% o más, sostenido." },
                  { g: "Crecimiento", k: `Ventas anual${r.revAnios ? ` (${r.revAnios} años)` : ""}`, v: fSig(r.revCagr), c: r.revCagr == null ? C.muted : r.revCagr >= 0.10 ? "#34d399" : r.revCagr < 0 ? "#f87171" : C.text,
                    d: "Crecimiento compuesto de las ventas. Si el EPS crece mucho más que las ventas, vino de márgenes o recompras, no de expansión." },
                  { g: "Crecimiento", k: "EPS esperado próx. año", v: fSig(r.grwFwd), c: r.grwFwd != null && r.grwFwd < 0 ? "#f87171" : C.text,
                    d: "Consenso de analistas. Es la base del PEG; es una estimación, no un dato." },
                  { g: "Crecimiento", k: "Dilución anual", v: fSig(r.shrYoY), c: dilColor(r.shrYoY),
                    d: "Acciones diluidas del último trimestre contra el de un año antes. Negativo = recompra." },
                  { g: "Crecimiento", k: "SBC / ventas", v: fP(r.sbcPct, 1), c: r.sbcPct != null && r.sbcPct > 0.1 ? "#f87171" : C.text,
                    d: "Pago en acciones sobre ventas (12 meses). No sale caja, pero diluye." },''', '11a/detalle')
sub('''                            {["Valuación", "Calidad", "Balance"].map((grupo) => (''',
'''                            {["Valuación", "Crecimiento", "Calidad", "Balance"].map((grupo) => (''', '11b/grupos')
# checklist Lynch debajo de la grilla del detalle
sub('''                                    <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.45, marginTop: 2 }}>{x.d}</div>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>''',
'''                                    <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.45, marginTop: 2 }}>{x.d}</div>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                          <div className="flex" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                            <span style={{ fontSize: 9.5, color: C.dim, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 600, marginRight: 4 }}>
                              Filtro Lynch {r.lynch.pasa ? "· pasa" : "· no pasa"}
                            </span>
                            {r.lynch.items.map((i) => {
                              const col = i.estado === "ok" ? "#34d399" : i.estado === "no" ? "#f87171" : C.dim;
                              return (
                                <span key={i.k} style={{ fontSize: 10.5, padding: "2px 7px", borderRadius: 5, border: `1px solid ${col}`, color: col }}>
                                  {i.estado === "ok" ? "✓" : i.estado === "no" ? "✗" : "—"} {i.label}
                                </span>
                              );
                            })}
                          </div>''', '11c/checklist')

# 12) nota al pie
sub('''para ver EV/EBITDA, PEG, earnings yield, ROE, FCF yield, D/E y la explicación de los avisos.''',
'''para ver EV/EBITDA, PEG, earnings yield, crecimiento de varios años, dilución, SBC, ROE, FCF yield, D/E, el detalle del filtro Lynch y la explicación de los avisos.''', '12/pie')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
