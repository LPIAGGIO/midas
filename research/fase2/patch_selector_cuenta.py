# -*- coding: utf-8 -*-
# Varias cuentas por broker, paso 2 (LP 12/10/2026): selector de cuenta en la
# barra de arriba. "Todas las cuentas" es lo de siempre; elegir una filtra
# posiciones, caja y libro en todas las pantallas (los tres ganchos centrales).
#
# Cuidados:
#  - El importador lee el libro SIN filtro: rearma la cuenta desde su libro y,
#    filtrado por otra cuenta, lo vería vacío y borraría todo.
#  - El import de Portfolio deduplica contra TODAS las posiciones.
#  - Lo que se escribe solo (caja de una posición, comisión, ajuste de futuros)
#    lleva la cuenta del papel, no la elegida en pantalla.
#  - De paso: posiciones y caja se leen paginadas (Supabase corta en 1.000 y
#    LP ya tiene 832 posiciones; la segunda cuenta las pasaba).
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ── 1) Contexto de cuenta + selector (antes de usePrivacy) ──
sub('''function usePrivacy() {
  return useContext(PrivacyContext);
}''',
'''function usePrivacy() {
  return useContext(PrivacyContext);
}

// ═══════════════════════════════════════════════════════════════════════
// CuentaContext: qué cuenta se está mirando (varias cuentas por broker,
// 12/10/2026). sel = "todas" o "<broker>:<cuenta>". Se guarda en el navegador.
// Filas sin broker (viejas) cuentan como Cocos; sin cuenta, como principal.
// ═══════════════════════════════════════════════════════════════════════
const CUENTA_SEL_KEY = "midas:cuenta-sel";
const CuentaContext = createContext({ sel: "todas", setSel: () => {}, cuentas: [] });
function filaEnCuenta(row, sel, brokerDefault = "cocos") {
  if (!sel || sel === "todas") return true;
  const i = sel.indexOf(":");
  const b = sel.slice(0, i), c = sel.slice(i + 1);
  return (row?.broker || brokerDefault) === b && (row?.cuenta || "principal") === c;
}
function CuentaProvider({ children }) {
  const { user } = useAuth();
  const [cuentas, setCuentas] = useState([]);
  const [sel, setSelState] = useState(() => { try { return localStorage.getItem(CUENTA_SEL_KEY) || "todas"; } catch { return "todas"; } });
  const setSel = useCallback((v) => { setSelState(v); try { localStorage.setItem(CUENTA_SEL_KEY, v); } catch { /* sin storage */ } }, []);
  useEffect(() => {
    if (!user?.id) { setCuentas([]); return; }
    let vivo = true;
    supabase.from("linked_brokers").select("broker,cuenta,label,broker_account_id,created_at").eq("user_id", user.id).order("created_at", { ascending: true })
      .then(({ data }) => { if (vivo) setCuentas(data || []); }, () => {});
    return () => { vivo = false; };
  }, [user?.id]);
  // Si la cuenta guardada ya no existe (otro usuario, cuenta borrada), vuelve a todas.
  useEffect(() => {
    if (sel !== "todas" && cuentas.length && !cuentas.some((r) => `${r.broker}:${r.cuenta || "principal"}` === sel)) setSel("todas");
  }, [cuentas, sel, setSel]);
  const value = useMemo(() => ({ sel: cuentas.length > 1 ? sel : "todas", setSel, cuentas }), [sel, setSel, cuentas]);
  return <CuentaContext.Provider value={value}>{children}</CuentaContext.Provider>;
}
function useCuenta() {
  return useContext(CuentaContext);
}
function nombreDeCuentaFila(r, cuentas) {
  const cta = r.cuenta || "principal";
  const delMismo = (cuentas || []).filter((x) => x.broker === r.broker).length;
  const base = BROKER_CATALOG[r.broker]?.label || r.label || r.broker;
  if (cta === "principal") return delMismo > 1 ? `${base} · principal${r.broker_account_id ? " " + r.broker_account_id : ""}` : base;
  const alias = String(r.label || "").split(" · ").slice(1).join(" · ") || cta;
  return `${base} · ${alias}`;
}
// Selector de la barra de arriba: solo aparece con más de una cuenta.
function CuentaSelector() {
  const { sel, setSel, cuentas } = useCuenta();
  if (cuentas.length < 2) return null;
  const filtrando = sel !== "todas";
  return (
    <select value={sel} onChange={(e) => setSel(e.target.value)} title="Cuenta que se muestra en todas las pantallas"
      style={{ margin: "0 10px", padding: "5px 8px", fontSize: 11.5, maxWidth: 220, background: filtrando ? C.accentSoft : C.panel, color: filtrando ? C.accent : C.muted, border: `1px solid ${filtrando ? C.accentBorder : C.border}`, borderRadius: 6, cursor: "pointer", colorScheme: "dark", fontFamily: "'Roboto', sans-serif" }}>
      <option value="todas">Todas las cuentas</option>
      {cuentas.map((r) => {
        const v = `${r.broker}:${r.cuenta || "principal"}`;
        return <option key={v} value={v}>{nombreDeCuentaFila(r, cuentas)}</option>;
      })}
    </select>
  );
}''', 'contexto cuenta')

sub('''    <PrivacyProvider>
''', '''    <PrivacyProvider><CuentaProvider>
''', 'provider abre')
sub('''    </PrivacyProvider>
''', '''    </CuentaProvider></PrivacyProvider>
''', 'provider cierra')

sub('''              className="px-4 flex items-center"
              style={{ borderLeft: `1px solid ${C.border}` }}
            >
              <UserMenu onNavigate={setActive} />''',
'''              className="px-4 flex items-center"
              style={{ borderLeft: `1px solid ${C.border}` }}
            >
              <CuentaSelector />
              <UserMenu onNavigate={setActive} />''', 'selector en header')

# ── 2) libro ──
sub('''function useLibroMovimientos() {
  const { user } = useAuth();
  const [rows, setRows] = useState([]);''',
'''function useLibroMovimientos({ sinFiltro = false } = {}) {
  const { user } = useAuth();
  const { sel } = useCuenta();
  const [rowsTodas, setRows] = useState([]);
  // El libro es de Cocos: elegir una cuenta de otro broker lo deja vacío.
  const rows = useMemo(() => (sinFiltro ? rowsTodas : rowsTodas.filter((r) => filaEnCuenta({ broker: "cocos", cuenta: r.cuenta }, sel))), [rowsTodas, sel, sinFiltro]);''', 'libro hook')
sub('''  const { rows: movsTodos, reload: reloadMovs } = useLibroMovimientos();''',
'''  const { rows: movsTodos, reload: reloadMovs } = useLibroMovimientos({ sinFiltro: true });''', 'importador sin filtro')

# saldo de apertura de Caja en el tiempo
sub('''    supabase.from("broker_opening_cash").select("currency,amount").eq("user_id", user.id)
      .then(({ data }) => {
        if (cancel || !data) return;
        const o = { ARS: 0, USD: 0 };
        for (const r of data) {''',
'''    supabase.from("broker_opening_cash").select("broker,cuenta,currency,amount").eq("user_id", user.id)
      .then(({ data }) => {
        if (cancel || !data) return;
        const o = { ARS: 0, USD: 0 };
        for (const r of data.filter((x) => filaEnCuenta(x, cuentaSel))) {''', 'cajatiempo apertura')
sub('''        setOpening(o);
      });
    return () => { cancel = true; };
  }, [user]);''',
'''        setOpening(o);
      });
    return () => { cancel = true; };
  }, [user, cuentaSel]);''', 'cajatiempo deps')
sub('''function CajaTiempoModule() {
  const { rows, loading } = useLibroMovimientos();
  const { user } = useAuth();''',
'''function CajaTiempoModule() {
  const { rows, loading } = useLibroMovimientos();
  const { user } = useAuth();
  const { sel: cuentaSel } = useCuenta();''', 'cajatiempo sel')

# ── 3) posiciones: paginado + filtro ──
sub('''function useUserPositions() {
  const { user } = useAuth();
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setPositions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("positions")
      .select("*")
      .eq("user_id", user.id)
      .order("entry_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });

    if (err) {''',
'''// Lee una tabla del usuario completa en páginas de 1.000 (Supabase corta ahí
// sin avisar: el 02/10 el libro lo cruzó y fabricó tenencias fantasma).
async function leerTodoDelUsuario(tabla, userId, ordenar) {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await ordenar(supabase.from(tabla).select("*").eq("user_id", userId)).order("id", { ascending: true }).range(desde, desde + 999);
    if (error) return { data: null, error };
    todas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: todas, error: null };
}

function useUserPositions() {
  const { user } = useAuth();
  const { sel } = useCuenta();
  const [todas, setPositions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Lo que ven las pantallas: la cuenta elegida arriba (o todas).
  const positions = useMemo(() => (sel === "todas" ? todas : todas.filter((p) => filaEnCuenta(p, sel))), [todas, sel]);

  const refresh = useCallback(async () => {
    if (!user) {
      setPositions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: err } = await leerTodoDelUsuario("positions", user.id, (q) => q
      .order("entry_date", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }));

    if (err) {''', 'positions hook')
sub('''  const addPosition = useCallback(async (payload) => {
    if (!user) throw new Error("No hay sesión activa");
    const row = { ...payload, user_id: user.id };''',
'''  const addPosition = useCallback(async (payload) => {
    if (!user) throw new Error("No hay sesión activa");
    // Cargada con una cuenta elegida arriba: va a esa cuenta si es del mismo broker.
    const row = { ...payload, user_id: user.id };
    if (!row.cuenta && sel !== "todas") {
      const i = sel.indexOf(":");
      if (!row.broker || row.broker === sel.slice(0, i)) { row.broker = row.broker || sel.slice(0, i); row.cuenta = sel.slice(i + 1); }
    }''', 'addPosition cuenta')
sub('''    setPositions((prev) => [data, ...prev]);
    return data;
  }, [user]);

  const updatePosition = useCallback(async (id, patch) => {''',
'''    setPositions((prev) => [data, ...prev]);
    return data;
  }, [user, sel]);

  const updatePosition = useCallback(async (id, patch) => {''', 'addPosition deps')
sub('''  return { positions, loading, error, addPosition, updatePosition, deletePosition, refresh };
}''',
'''  return { positions, todas, loading, error, addPosition, updatePosition, deletePosition, refresh };
}''', 'positions return')

# ── 4) caja: paginado + filtro + cuenta del papel en lo automático ──
sub('''function useCashMovements() {
  const { user } = useAuth();
  const [movements, setMovements] = useState([]);''',
'''function useCashMovements() {
  const { user } = useAuth();
  const { sel } = useCuenta();
  const [movTodos, setMovements] = useState([]);
  const movements = useMemo(() => (sel === "todas" ? movTodos : movTodos.filter((m) => filaEnCuenta(m, sel))), [movTodos, sel]);''', 'cash hook')
sub('''    const { data, error: err } = await supabase
      .from("cash_movements")
      .select("*")
      .eq("user_id", user.id)
      .order("movement_date", { ascending: false })
      .order("created_at", { ascending: false });
    if (err) {
      setError(err.message);
      setMovements([]);''',
'''    const { data, error: err } = await leerTodoDelUsuario("cash_movements", user.id, (q) => q
      .order("movement_date", { ascending: false })
      .order("created_at", { ascending: false }));
    if (err) {
      setError(err.message);
      setMovements([]);''', 'cash fetch')
sub('''    const existing = movements.find(
      (m) => m.related_position_id === position.id &&
             !((m.notes || "").startsWith("Comisión"))
    );
    const payload = buildCashMovementPayload(position, user.id, allPositions);''',
'''    const existing = movTodos.find(
      (m) => m.related_position_id === position.id &&
             !((m.notes || "").startsWith("Comisión"))
    );
    const payload = buildCashMovementPayload(position, user.id, allPositions);
    if (payload) { payload.broker = position.broker || null; payload.cuenta = position.cuenta || "principal"; }''', 'sync cuenta')
sub('''      setMovements((prev) => [data, ...prev]);
      return data;
    }
  }, [user, movements]);''',
'''      setMovements((prev) => [data, ...prev]);
      return data;
    }
  }, [user, movTodos]);''', 'sync deps')
sub('''      related_position_id: position.id,
      notes: `Comisión por derechos de mercado · ${position.ticker}`,''',
'''      related_position_id: position.id,
      broker: position.broker || null,
      cuenta: position.cuenta || "principal",
      notes: `Comisión por derechos de mercado · ${position.ticker}`,''', 'comision cuenta')

# ── 5) ajustes de futuros: la caja va a la cuenta del futuro ──
sub('''        const { data: cm, error: cmErr } = await supabase
          .from("cash_movements")
          .insert({
            user_id: user.id,
            movement_date: adj.adjustment_date,''',
'''        const { data: cm, error: cmErr } = await supabase
          .from("cash_movements")
          .insert({
            ...cuentaDeFuturo(adj.ticker),
            user_id: user.id,
            movement_date: adj.adjustment_date,''', 'ajuste 1')
sub('''        const { data: cm, error: cmErr } = await supabase
          .from("cash_movements")
          .insert({
            user_id: user.id,
            movement_date: first.adjustment_date,''',
'''        const { data: cm, error: cmErr } = await supabase
          .from("cash_movements")
          .insert({
            ...cuentaDeFuturo(first.ticker),
            user_id: user.id,
            movement_date: first.adjustment_date,''', 'ajuste 2')
sub('''function useFutureAdjustments(positions, futurePrices) {''',
'''function useFutureAdjustments(positions, futurePrices) {
  // Cuenta del futuro (varias cuentas por broker): la caja del ajuste va ahí.
  const cuentaDeFuturo = (tk) => {
    const p = (positions || []).find((x) => x.ticker === tk && x.instrument_type === "future");
    return p ? { broker: p.broker || "cocos", cuenta: p.cuenta || "principal" } : {};
  };''', 'cuentaDeFuturo')

# ── 6) import de Portfolio: deduplica contra TODAS las posiciones ──
sub('''  const { positions, loading, error, addPosition, updatePosition, deletePosition } = useUserPositions();''',
'''  const { positions, todas: todasPos, loading, error, addPosition, updatePosition, deletePosition } = useUserPositions();''', 'portfolio todas')
sub('''          existingPositions={positions}''', '''          existingPositions={todasPos}''', 'import dedup todas')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
