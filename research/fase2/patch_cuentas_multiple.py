# -*- coding: utf-8 -*-
# Selección MÚLTIPLE de cuentas (LP 12/10/2026: "si quiero ver solo las de
# Cocos no puedo"). sel = "todas" o lista separada por comas de "<broker>:<cuenta>".
#  - Barra de arriba: botón con casillas agrupadas por broker (tildar el broker
#    marca o desmarca todas sus cuentas).
#  - Portfolio: un broker con varias cuentas muestra una ficha por cuenta que
#    prende y apaga la misma selección global.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ── contexto ──
sub('''// 12/10/2026). sel = "todas" o "<broker>:<cuenta>". Se guarda en el navegador.''',
'''// 12/10/2026). sel = "todas" o lista "<broker>:<cuenta>,<broker>:<cuenta>"
// (selección múltiple). Se guarda en el navegador.''', 'coment')
sub('''function filaEnCuenta(row, sel, brokerDefault = "cocos") {
  if (!sel || sel === "todas") return true;
  const i = sel.indexOf(":");
  const b = sel.slice(0, i), c = sel.slice(i + 1);
  return (row?.broker || brokerDefault) === b && (row?.cuenta || "principal") === c;
}''',
'''function selLista(sel) {
  return !sel || sel === "todas" ? null : String(sel).split(",").filter(Boolean);
}
const claveCuenta = (r, brokerDefault = "cocos") => `${r?.broker || brokerDefault}:${r?.cuenta || "principal"}`;
function filaEnCuenta(row, sel, brokerDefault = "cocos") {
  const l = selLista(sel);
  return !l || l.includes(claveCuenta(row, brokerDefault));
}''', 'filaEnCuenta')
sub('''  // Si la cuenta guardada ya no existe (otro usuario, cuenta borrada), vuelve a todas.
  useEffect(() => {
    if (sel !== "todas" && cuentas.length && !cuentas.some((r) => `${r.broker}:${r.cuenta || "principal"}` === sel)) setSel("todas");
  }, [cuentas, sel, setSel]);
  const value = useMemo(() => ({ sel: cuentas.length > 1 ? sel : "todas", setSel, cuentas }), [sel, setSel, cuentas]);''',
'''  const claves = useMemo(() => cuentas.map((r) => claveCuenta(r)), [cuentas]);
  // Fija la selección normalizada: vacía o completa = "todas".
  const fijar = useCallback((lista) => {
    const l = claves.filter((k) => lista.includes(k));
    setSel(!l.length || l.length === claves.length ? "todas" : l.join(","));
  }, [claves, setSel]);
  // Prende o apaga un grupo de cuentas (una sola, o todas las de un broker).
  const alternar = useCallback((keys, on) => {
    const actual = selLista(sel) || claves;
    fijar(on ? [...new Set([...actual, ...keys])] : actual.filter((k) => !keys.includes(k)));
  }, [sel, claves, fijar]);
  // Cuentas guardadas que ya no existen (otro usuario, cuenta borrada) se descartan.
  useEffect(() => {
    const l = selLista(sel);
    if (l && claves.length && l.some((k) => !claves.includes(k))) fijar(l);
  }, [claves, sel, fijar]);
  const value = useMemo(() => ({ sel: cuentas.length > 1 ? sel : "todas", setSel, cuentas, claves, alternar }), [sel, setSel, cuentas, claves, alternar]);''', 'provider')
sub('''const CuentaContext = createContext({ sel: "todas", setSel: () => {}, cuentas: [] });''',
'''const CuentaContext = createContext({ sel: "todas", setSel: () => {}, cuentas: [], claves: [], alternar: () => {} });''', 'ctx default')

# ── selector de la barra ──
a = s.index('''// Selector de la barra de arriba: solo aparece con más de una cuenta.
function CuentaSelector() {''')
z = s.index('''// Helper: reemplaza el string formateado por ●●● cuando hidden=true.''')
if not (0 < z - a < 4000):
    print('selector: tamaño raro', z - a); sys.exit(1)
s = s[:a] + '''// Selector de la barra de arriba: casillas agrupadas por broker. Solo aparece
// con más de una cuenta.
function CuentaSelector() {
  const { sel, cuentas, claves, alternar, setSel } = useCuenta();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  if (cuentas.length < 2) return null;
  const l = selLista(sel);
  const activas = l || claves;
  const filtrando = !!l;
  const grupos = [];
  for (const r of cuentas) {
    let g = grupos.find((x) => x.broker === r.broker);
    if (!g) { g = { broker: r.broker, filas: [] }; grupos.push(g); }
    g.filas.push(r);
  }
  // Texto del botón: todas / un broker entero / una cuenta / "2 de 4 cuentas".
  let texto = "Todas las cuentas";
  if (filtrando) {
    const g = grupos.find((x) => x.filas.length > 1 && x.filas.every((r) => activas.includes(claveCuenta(r))) && activas.length === x.filas.length);
    if (g) texto = `${BROKER_CATALOG[g.broker]?.label || g.broker} · todas`;
    else if (activas.length === 1) texto = nombreDeCuentaFila(cuentas.find((r) => claveCuenta(r) === activas[0]) || {}, cuentas);
    else texto = `${activas.length} de ${claves.length} cuentas`;
  }
  const caja = (on, parcial) => (
    <span style={{ width: 14, height: 14, flexShrink: 0, borderRadius: 3, border: `1px solid ${on || parcial ? C.accent : C.borderStrong}`, background: on ? C.accent : "transparent", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      {on ? <Check size={10} strokeWidth={3} color={C.bg} /> : parcial ? <span style={{ width: 6, height: 2, background: C.accent }} /> : null}
    </span>
  );
  const fila = { display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 12px", background: "transparent", border: "none", color: C.text, fontSize: 12, cursor: "pointer", textAlign: "left", fontFamily: "'Roboto', sans-serif" };
  const hov = { onMouseEnter: (e) => { e.currentTarget.style.backgroundColor = C.deep; }, onMouseLeave: (e) => { e.currentTarget.style.backgroundColor = "transparent"; } };
  return (
    <div ref={ref} style={{ position: "relative", margin: "0 10px" }}>
      <button onClick={() => setOpen((v) => !v)} title="Cuentas que se muestran en todas las pantallas"
        style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", fontSize: 11.5, maxWidth: 240, background: filtrando ? C.accentSoft : C.panel, color: filtrando ? C.accent : C.muted, border: `1px solid ${filtrando ? C.accentBorder : C.border}`, borderRadius: 6, cursor: "pointer", fontFamily: "'Roboto', sans-serif", whiteSpace: "nowrap", overflow: "hidden" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{texto}</span>
        <ChevronDown size={13} style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms" }} />
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 260, background: C.panel, border: `1px solid ${C.borderStrong}`, borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", zIndex: 60, padding: "4px 0" }}>
          <button onClick={() => setSel("todas")} style={{ ...fila, fontWeight: 600 }} {...hov}>{caja(!filtrando, false)}Todas las cuentas</button>
          <div style={{ height: 1, background: C.border, margin: "4px 0" }} />
          {grupos.map((g) => {
            const keys = g.filas.map((r) => claveCuenta(r));
            const nOn = keys.filter((k) => activas.includes(k)).length;
            const nombreB = BROKER_CATALOG[g.broker]?.label || g.broker;
            if (g.filas.length === 1) return (
              <button key={g.broker} onClick={() => alternar(keys, nOn === 0)} style={fila} {...hov}>{caja(nOn === 1, false)}{nombreDeCuentaFila(g.filas[0], cuentas)}</button>
            );
            return (
              <div key={g.broker}>
                <button onClick={() => alternar(keys, nOn < keys.length)} style={{ ...fila, fontWeight: 600 }} {...hov}>{caja(nOn === keys.length, nOn > 0 && nOn < keys.length)}{nombreB}<span style={{ marginLeft: "auto", fontSize: 10.5, color: C.dim, fontWeight: 400 }}>{keys.length} cuentas</span></button>
                {g.filas.map((r) => {
                  const k = claveCuenta(r), on = activas.includes(k);
                  const alias = (r.cuenta || "principal") === "principal" ? `Principal${r.broker_account_id ? " · " + r.broker_account_id : ""}` : `${String(r.label || "").split(" · ").slice(1).join(" · ") || r.cuenta}${r.broker_account_id ? " · " + r.broker_account_id : ""}`;
                  return <button key={k} onClick={() => alternar([k], !on)} style={{ ...fila, paddingLeft: 34, color: on ? C.text : C.muted }} {...hov}>{caja(on, false)}{alias}</button>;
                })}
              </div>
            );
          })}
          <div style={{ padding: "6px 12px 4px", fontSize: 10.5, color: C.dim, borderTop: `1px solid ${C.border}`, marginTop: 4, lineHeight: 1.4 }}>Filtra cartera, caja y libro en todas las pantallas.</div>
        </div>
      )}
    </div>
  );
}

''' + s[z:]

# ── alta manual con una sola cuenta elegida ──
sub('''    if (!row.cuenta && sel !== "todas") {
      const i = sel.indexOf(":");
      if (!row.broker || row.broker === sel.slice(0, i)) { row.broker = row.broker || sel.slice(0, i); row.cuenta = sel.slice(i + 1); }
    }''',
'''    const unaSola = selLista(sel);
    if (!row.cuenta && unaSola && unaSola.length === 1) {
      const i = unaSola[0].indexOf(":");
      const b = unaSola[0].slice(0, i), c = unaSola[0].slice(i + 1);
      if (!row.broker || row.broker === b) { row.broker = row.broker || b; row.cuenta = c; }
    }''', 'addPosition')

# ── fichas del Portfolio ──
sub('''  const { positions, todas: todasPos, loading, error, addPosition, updatePosition, deletePosition } = useUserPositions();''',
'''  const { positions, todas: todasPos, loading, error, addPosition, updatePosition, deletePosition } = useUserPositions();
  const { sel: cuentaSel, cuentas: cuentasCtx, alternar: alternarCuenta } = useCuenta();''', 'portfolio ctx')
sub('''          {presentBrokers.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: 10 }}>''',
'''          {(presentBrokers.length > 1 || multiCuentas.size > 0) && (
            <div className="flex items-center gap-1.5 flex-wrap" style={{ marginBottom: 10 }}>''', 'fila condicion')
sub('''              {presentBrokers.map((key) => {
                const isActive = !excludedBrokers.has(key);''',
'''              {chipsBrokers.map((key) => {
                // Broker con varias cuentas: una ficha por cuenta, que prende y
                // apaga la selección global (la misma del botón de arriba).
                if (multiCuentas.has(key)) {
                  const meta = BROKER_CATALOG[key];
                  return (
                    <Fragment key={key}>
                      {multiCuentas.get(key).map((r) => {
                        const k = claveCuenta(r), on = filaEnCuenta(r, cuentaSel);
                        const alias = (r.cuenta || "principal") === "principal" ? (r.broker_account_id || "principal") : (String(r.label || "").split(" · ").slice(1).join(" · ") || r.cuenta);
                        return (
                          <button key={k} onClick={() => alternarCuenta([k], !on)} title="Prende o apaga esta cuenta en todas las pantallas"
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", fontSize: 10.5, fontWeight: 500, letterSpacing: "0.04em", backgroundColor: on ? "rgba(255,255,255,0.04)" : "transparent", border: `1px solid ${on ? C.borderStrong : C.border}`, color: on ? C.text : C.muted, cursor: "pointer", fontFamily: "'Roboto', sans-serif", transition: "all 120ms ease" }}>
                            <span style={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: meta?.color || "#94A3B8", opacity: on ? 1 : 0.35 }} />
                            <span>{meta?.short || key} · {alias}</span>
                            <span style={{ color: on ? C.dim : C.faint, fontSize: 9.5, marginLeft: 1, fontVariantNumeric: "tabular-nums" }}>{cuentaOpenCounts[k] || 0}</span>
                          </button>
                        );
                      })}
                    </Fragment>
                  );
                }
                const isActive = !excludedBrokers.has(key);''', 'chips map')

# conteo por cuenta (desde TODAS las posiciones, para que una cuenta apagada
# siga mostrando su número) y lista de fichas
sub('''  const presentBrokers = useMemo(() => {''',
'''  // Brokers con más de una cuenta (selección por cuenta en las fichas).
  const multiCuentas = useMemo(() => {
    const m = new Map();
    for (const r of cuentasCtx || []) { if (!m.has(r.broker)) m.set(r.broker, []); m.get(r.broker).push(r); }
    for (const [b, l] of [...m]) if (l.length < 2) m.delete(b);
    return m;
  }, [cuentasCtx]);
  const cuentaOpenCounts = useMemo(() => {
    const hoyISO = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
    const por = new Map();
    for (const p of todasPos || []) {
      const tkU = (p.ticker || "").trim().toUpperCase();
      if (p.instrument_type === "bond_ars" || p.instrument_type === "bond_usd") {
        const mat = parseLetraMaturity(tkU);
        if (mat && mat < hoyISO) continue;
      }
      const k = claveCuenta(p, "manual");
      if (!por.has(k)) por.set(k, new Map());
      const m = por.get(k), tk = `${tkU}|${p.instrument_type}`;
      m.set(tk, (m.get(tk) || 0) + (Number(p.quantity) || 0) * (p.operation_type === "sell" ? -1 : 1));
    }
    const out = {};
    for (const [k, m] of por) { let n = 0; for (const v of m.values()) if (Math.abs(v) > 1e-6) n++; out[k] = n; }
    return out;
  }, [todasPos]);
  const presentBrokers = useMemo(() => {''', 'conteo por cuenta')
sub('''    return ["iol", "cocos", "balanz", "eco", "manual"].filter((b) => set.has(b));
  }, [positions, cashState, iolCashByCurrency]);''',
'''    return ["iol", "cocos", "balanz", "eco", "manual"].filter((b) => set.has(b));
  }, [positions, cashState, iolCashByCurrency]);
  // Fichas: los brokers presentes más los que tienen varias cuentas (aunque
  // estén todas apagadas, para poder volver a prenderlas desde acá).
  const chipsBrokers = useMemo(() => {
    const orden = ["iol", "cocos", "balanz", "eco", "manual"];
    const set = new Set([...presentBrokers, ...multiCuentas.keys()]);
    return [...orden.filter((b) => set.has(b)), ...[...set].filter((b) => !orden.includes(b))];
  }, [presentBrokers, multiCuentas]);''', 'chipsBrokers')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
