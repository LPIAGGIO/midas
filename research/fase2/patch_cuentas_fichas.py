# -*- coding: utf-8 -*-
# Ajustes de la selección de cuentas (LP 12/10/2026):
#  - "Todas las cuentas" tildada destilda todo (estado "ninguna"); antes,
#    sacar la última cuenta volvía solo a "todas" y parecía que IOL seguía.
#  - El control vive en las fichas de "Brokers" del Portfolio: una ficha
#    "Todas" y una por cuenta (IOL incluida), todas sobre la selección global.
#  - La barra de arriba solo muestra el botón cuando se está filtrando, para
#    verlo desde las otras pantallas.
#  - El efectivo de un broker sin cuentas elegidas también se excluye.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ── contexto: estado "ninguna" ──
sub('''function selLista(sel) {
  return !sel || sel === "todas" ? null : String(sel).split(",").filter(Boolean);
}''',
'''function selLista(sel) {
  if (!sel || sel === "todas") return null;
  if (sel === "ninguna") return [];
  return String(sel).split(",").filter(Boolean);
}''', 'selLista')
sub('''    setSel(!l.length || l.length === claves.length ? "todas" : l.join(","));''',
'''    setSel(!l.length ? "ninguna" : l.length === claves.length ? "todas" : l.join(","));''', 'fijar')

# ── botón de arriba: solo filtrando; "Todas" alterna todas / ninguna ──
sub('''  if (cuentas.length < 2) return null;
  const l = selLista(sel);
  const activas = l || claves;
  const filtrando = !!l;''',
'''  const l = selLista(sel);
  const activas = l || claves;
  const filtrando = !!l;
  // Con todas las cuentas a la vista el control vive en las fichas del
  // Portfolio; acá solo se avisa que hay un filtro puesto.
  if (cuentas.length < 2 || !filtrando) return null;''', 'selector visible')
sub('''  let texto = "Todas las cuentas";
  if (filtrando) {''', '''  let texto = "Todas las cuentas";
  if (filtrando && !activas.length) texto = "Ninguna cuenta";
  else if (filtrando) {''', 'texto ninguna')
sub('''          <button onClick={() => setSel("todas")} style={{ ...fila, fontWeight: 600 }} {...hov}>{caja(!filtrando, false)}Todas las cuentas</button>''',
'''          <button onClick={() => setSel(filtrando ? "todas" : "ninguna")} style={{ ...fila, fontWeight: 600 }} {...hov}>{caja(!filtrando, activas.length > 0 && filtrando)}Todas las cuentas</button>''', 'todas alterna')

# ── Portfolio: todas las cuentas como fichas globales ──
sub('''  const multiCuentas = useMemo(() => {
    const m = new Map();
    for (const r of cuentasCtx || []) { if (!m.has(r.broker)) m.set(r.broker, []); m.get(r.broker).push(r); }
    for (const [b, l] of [...m]) if (l.length < 2) m.delete(b);
    return m;
  }, [cuentasCtx]);''',
'''  // Con 2+ cuentas dadas de alta, las fichas de "Brokers" manejan la selección
  // global de cuentas (todas, incluida IOL). Con una sola, el filtro local de siempre.
  const multiCuentas = useMemo(() => {
    const m = new Map();
    if ((cuentasCtx || []).length < 2) return m;
    for (const r of cuentasCtx) { if (!m.has(r.broker)) m.set(r.broker, []); m.get(r.broker).push(r); }
    return m;
  }, [cuentasCtx]);''', 'multiCuentas')
sub('''                        const alias = (r.cuenta || "principal") === "principal" ? (r.broker_account_id || "principal") : (String(r.label || "").split(" · ").slice(1).join(" · ") || r.cuenta);''',
'''                        const unica = multiCuentas.get(key).length === 1;
                        const alias = (r.cuenta || "principal") === "principal" ? (r.broker_account_id || "principal") : (String(r.label || "").split(" · ").slice(1).join(" · ") || r.cuenta);''', 'alias unica')
sub('''                            <span>{meta?.short || key} · {alias}</span>''',
'''                            <span>{meta?.short || key}{unica ? "" : ` · ${alias}`}</span>''', 'label unica')
sub('''              {chipsBrokers.map((key) => {
                // Broker con varias cuentas''',
'''              {multiCuentas.size > 0 && (() => {
                const todasOn = cuentaSel === "todas";
                return (
                  <button onClick={() => setCuentaSel(todasOn ? "ninguna" : "todas")} title={todasOn ? "Apagar todas las cuentas" : "Ver todas las cuentas"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", backgroundColor: todasOn ? C.accentSoft : "transparent", border: `1px solid ${todasOn ? C.accentBorder : C.border}`, color: todasOn ? C.accent : C.muted, cursor: "pointer", fontFamily: "'Roboto', sans-serif", transition: "all 120ms ease" }}>
                    {todasOn ? <Check size={11} strokeWidth={2.5} /> : null}Todas
                  </button>
                );
              })()}
              {chipsBrokers.map((key) => {
                // Broker con varias cuentas''', 'ficha todas')
sub('''  const { sel: cuentaSel, cuentas: cuentasCtx, alternar: alternarCuenta } = useCuenta();''',
'''  const { sel: cuentaSel, setSel: setCuentaSel, cuentas: cuentasCtx, alternar: alternarCuenta } = useCuenta();''', 'ctx setSel')

# efectivo: un broker sin ninguna cuenta elegida queda excluido (IOL trae su
# caja de broker_cash_snapshots, que no pasa por el filtro de filas)
sub('''  const [excludedBrokers, setExcludedBrokers] = useState(() => new Set());''',
'''  const [excludedLocal, setExcludedBrokers] = useState(() => new Set());
  const excludedBrokers = useMemo(() => {
    const out = new Set(excludedLocal);
    const l = selLista(cuentaSel);
    if (l) for (const r of cuentasCtx || []) {
      const keys = cuentasCtx.filter((x) => x.broker === r.broker).map((x) => claveCuenta(x));
      if (!keys.some((k) => l.includes(k))) out.add(r.broker);
    }
    return out;
  }, [excludedLocal, cuentaSel, cuentasCtx]);''', 'excluded union')

# sin posiciones por el filtro no es "cartera vacía": se siguen viendo las fichas
sub('''      {loading && positions.length === 0 ? (
        <div className="flex items-center justify-center" style={{ padding: "80px 0" }}>
          <Loader2 size={24} color={C.muted} className="eco-spin" strokeWidth={1.5} />
        </div>
      ) : positions.length === 0 ? (''',
'''      {loading && (todasPos || []).length === 0 ? (
        <div className="flex items-center justify-center" style={{ padding: "80px 0" }}>
          <Loader2 size={24} color={C.muted} className="eco-spin" strokeWidth={1.5} />
        </div>
      ) : (todasPos || []).length === 0 ? (''', 'vacio por filtro')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
