# -*- coding: utf-8 -*-
# Varias cuentas del mismo broker (LP 12/10/2026), paso 1: alta de cuentas,
# credenciales de Matriz por cuenta e importador de Cocos por cuenta. Todo lo
# existente vive en la cuenta 'principal' (default de la columna `cuenta`).
# La vista sigue consolidada; el selector por cuenta en pantallas es el paso 2.
#
# Regla central: la derivación del libro de Cocos borra y rearma posiciones y
# caja. Con varias cuentas, cada borrado y cada inserción va acotado a la
# cuenta que se importa; si no, importar la cuenta B borraba lo de la A.
import io, sys, re
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ───────────────────────── AltaBrokersModal ─────────────────────────
sub('''    const { data } = await supabase.from("linked_brokers").select("id,broker,status,vault_secret_name,broker_user_id,broker_account_id,status_message").eq("user_id", user.id);''',
'''    const { data } = await supabase.from("linked_brokers").select("id,broker,cuenta,label,status,vault_secret_name,broker_user_id,broker_account_id,status_message,created_at").eq("user_id", user.id).order("created_at", { ascending: true });''', 'alta select')

sub('''  const filaDe = (id) => (filas || []).find((r) => r.broker === id);''',
'''  const filaDe = (id) => (filas || []).find((r) => r.broker === id && (r.cuenta || "principal") === "principal") || (filas || []).find((r) => r.broker === id);
  // Todas las cuentas de un broker, la principal primero.
  const cuentasDe = (id) => (filas || []).filter((r) => r.broker === id)
    .sort((a, b) => ((a.cuenta || "principal") === "principal" ? -1 : (b.cuenta || "principal") === "principal" ? 1 : 0));
  const nombreCuenta = (r) => {
    const cta = r?.cuenta || "principal";
    const base = cta === "principal" ? "Cuenta principal" : (String(r.label || "").split(" · ").slice(1).join(" · ") || r.label || cta);
    return base + (r?.broker_account_id ? ` · comitente ${r.broker_account_id}` : "");
  };''', 'filaDe')

sub('''  const [editando, setEditando] = useState(() => new Set());''',
'''  const [editando, setEditando] = useState(() => new Set());
  // Alta de una cuenta adicional del mismo broker (cotitular, sociedad...).
  const [nuevaDe, setNuevaDe] = useState(null);
  const [nueva, setNueva] = useState({ nombre: "", comitente: "" });''', 'estado nueva cuenta')

sub('''  const guardarMatriz = async (id) => {
    const c = cred[id] || {};
    if (!c.usuario || !c.clave) { setMsg((m) => ({ ...m, [id]: "Falta el usuario o la clave de Matriz." })); return; }
    setMsg((m) => ({ ...m, [id]: "Guardando…" }));
    const { error } = await supabase.rpc("guardar_credencial_matriz", { p_broker: id, p_usuario: c.usuario, p_clave: c.clave, p_comitente: c.comitente || null, p_label: BROKER_CATALOG[id]?.label || id });
    if (error) { setMsg((m) => ({ ...m, [id]: "No se pudo guardar: " + error.message })); return; }
    setCred((x) => ({ ...x, [id]: { usuario: c.usuario, comitente: c.comitente, clave: "" } }));
    setMsg((m) => ({ ...m, [id]: "Guardado. Queda pendiente de la primera sincronización." }));
    editar(id, false);''',
'''  const guardarMatriz = async (id, cta = "principal") => {
    const k = `${id}:${cta}`;
    const c = cred[k] || {};
    const fila = (filas || []).find((r) => r.broker === id && (r.cuenta || "principal") === cta);
    if (!c.usuario || !c.clave) { setMsg((m) => ({ ...m, [k]: "Falta el usuario o la clave de Matriz." })); return; }
    setMsg((m) => ({ ...m, [k]: "Guardando…" }));
    const { error } = await supabase.rpc("guardar_credencial_matriz", { p_broker: id, p_usuario: c.usuario, p_clave: c.clave, p_comitente: c.comitente || null, p_label: fila?.label || BROKER_CATALOG[id]?.label || id, p_cuenta: cta });
    if (error) { setMsg((m) => ({ ...m, [k]: "No se pudo guardar: " + error.message })); return; }
    setCred((x) => ({ ...x, [k]: { usuario: c.usuario, comitente: c.comitente, clave: "" } }));
    setMsg((m) => ({ ...m, [k]: "Guardado. Queda pendiente de la primera sincronización." }));
    editar(k, false);''', 'guardarMatriz')

# agregarCuenta, después de guardarMatriz (ancla: la definición de inp del modal)
sub('''  const inp = { width: "100%", padding: "6px 8px", fontSize: 12, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark" };
  const btn = (primario) => ({ padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${C.accent}`, background: primario ? C.accent : "transparent", color: primario ? C.bg : C.accent, whiteSpace: "nowrap" });
  const cuerpo = (''',
'''  // La clave interna de la cuenta: el número de comitente si lo hay (es lo
  // que identifica la cuenta en el broker), si no el nombre sin acentos.
  const agregarCuenta = async (id) => {
    const nombre = nueva.nombre.trim(), comit = nueva.comitente.replace(/\\D/g, "");
    if (!nombre) { setMsg((m) => ({ ...m, [`nueva:${id}`]: "Poné un nombre para reconocerla (por ejemplo Sociedad o Cotitular con Juan)." })); return; }
    const slug = (comit || nombre.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")).slice(0, 30) || "cuenta";
    const cta = slug === "principal" ? "principal-2" : slug;
    if ((filas || []).some((r) => r.broker === id && (r.cuenta || "principal") === cta)) { setMsg((m) => ({ ...m, [`nueva:${id}`]: "Ya tenés una cuenta con ese número o nombre en este broker." })); return; }
    const label = `${BROKER_CATALOG[id]?.label || id} · ${nombre}`;
    const filasNuevas = [];
    // Si el broker todavía no estaba dado de alta, se crea también la principal.
    if (!(filas || []).some((r) => r.broker === id)) filasNuevas.push({ user_id: user.id, broker: id, cuenta: "principal", label: BROKER_CATALOG[id]?.label || id, status: "manual", status_message: "Dado de alta. Cargá sus movimientos desde Importaciones." });
    filasNuevas.push({ user_id: user.id, broker: id, cuenta: cta, label, status: "manual", broker_account_id: comit || null, status_message: "Cuenta adicional. Cargá su clave de Matriz o subí su archivo desde Importaciones." });
    const { error } = await supabase.from("linked_brokers").insert(filasNuevas);
    if (error) { setMsg((m) => ({ ...m, [`nueva:${id}`]: "No se pudo agregar: " + error.message })); return; }
    setNueva({ nombre: "", comitente: "" }); setNuevaDe(null); setMsg((m) => ({ ...m, [`nueva:${id}`]: "" }));
    await recargar();
    onChanged && onChanged();
  };

  const inp = { width: "100%", padding: "6px 8px", fontSize: 12, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark" };
  const btn = (primario) => ({ padding: "6px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${C.accent}`, background: primario ? C.accent : "transparent", color: primario ? C.bg : C.accent, whiteSpace: "nowrap" });
  const linkBtn = { background: "none", border: "none", padding: 0, fontSize: 11, color: C.accent, cursor: "pointer" };
  // Recuadro de Matriz de UNA cuenta: "Conectado" si ya tiene clave, si no el formulario.
  const bloqueMatriz = (b, id, cta, f) => {
    const k = `${id}:${cta}`, c = cred[k] || {};
    if (f?.vault_secret_name && !editando.has(k)) return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.green, flex: 1 }}>
          Conectado por API a Matriz con usuario y clave{f.broker_user_id ? ` (usuario ${f.broker_user_id}${f.broker_account_id ? ", comitente " + f.broker_account_id : ""})` : ""}.
          {f.status === "active" ? " Sincroniza la tenencia y el saldo todas las mañanas." : " Pendiente de la primera sincronización."}
        </span>
        <button onClick={() => { setMsg((m) => ({ ...m, [k]: "" })); editar(k, true); }} style={{ ...btn(false), padding: "4px 10px", fontWeight: 500 }}>Cambiar usuario o clave</button>
      </div>
    );
    return (
      <div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
          {f?.vault_secret_name ? "Cargá el usuario y la clave nuevos de Matriz. La clave se guarda cifrada en el servidor y no vuelve al navegador." : "Si operás con Matriz en este broker, cargá tu usuario y clave de Matriz: Midas sincroniza la tenencia y el saldo todas las mañanas. La clave se guarda cifrada en el servidor y no vuelve al navegador."}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 8, alignItems: "center" }}>
          <input placeholder="Usuario de Matriz" value={c.usuario || ""} onChange={(e) => setC(k, "usuario", e.target.value)} style={inp} autoComplete="off" />
          <input placeholder="Clave de Matriz" type="password" value={c.clave || ""} onChange={(e) => setC(k, "clave", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") guardarMatriz(id, cta); }} style={inp} autoComplete="new-password" />
          <input placeholder="N° de comitente (opcional)" value={c.comitente ?? (f?.broker_account_id || "")} onChange={(e) => setC(k, "comitente", e.target.value)} style={inp} autoComplete="off" />
          <button onClick={() => guardarMatriz(id, cta)} style={btn(true)}>{f?.vault_secret_name ? "Guardar" : "Guardar y sincronizar"}</button>
        </div>
        {f?.vault_secret_name && <button onClick={() => editar(k, false)} style={{ background: "none", border: "none", padding: 0, marginTop: 6, fontSize: 11, color: C.dim, cursor: "pointer", textDecoration: "underline" }}>Cancelar</button>}
        {msg[k] && <div style={{ fontSize: 11, color: msg[k].startsWith("No") || msg[k].startsWith("Falta") ? C.red : C.green, marginTop: 6 }}>{msg[k]}</div>}
      </div>
    );
  };
  const cuerpo = (''', 'agregarCuenta + bloqueMatriz')

# región por broker: reemplazo completo entre el map y el mensaje general
ini = '''        {[...sel].filter((id) => BROKER_CATALOG[id]).map((id) => {'''
fin = '''        {msg._ && <div style={{ fontSize: 11, color: C.red, marginTop: 10 }}>{msg._}</div>}'''
if s.count(ini) != 1 or s.count(fin) != 1:
    print('region alta: anclas %d/%d, no escribo nada' % (s.count(ini), s.count(fin))); sys.exit(1)
a, z = s.index(ini), s.index(fin)
if not (0 < z - a < 12000):
    print('region alta: tamaño raro %d, no escribo nada' % (z - a)); sys.exit(1)
nuevo = '''        {[...sel].filter((id) => BROKER_CATALOG[id]).map((id) => {
          const b = BROKER_CATALOG[id], f = filaDe(id);
          const cuentas = cuentasDe(id);
          const varias = cuentas.length > 1;
          const textoImporta = b.importa ? "Se carga subiendo el archivo de tenencia o movimientos del broker, desde Importaciones." : "Todavía no hay importador para este broker: contanos qué archivo exporta y lo sumamos. Mientras tanto podés cargar posiciones a mano.";
          return (
            <div key={id} style={{ marginTop: 12, padding: "10px 12px", border: `1px solid ${C.border}`, borderRadius: 8 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text, marginBottom: 6 }}>{b.label}{varias && <span style={{ fontSize: 11, color: C.dim, fontWeight: 400 }}> · {cuentas.length} cuentas</span>}</div>
              {b.type === "api" ? (
                f?.status === "active" ? (
                  <div style={{ fontSize: 11, color: C.green }}>Conectado por API.</div>
                ) : (
                  <div>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Se conecta con tu usuario y clave de IOL, por la API oficial: cotizaciones en tiempo real y sincronización automática de tu cartera.</div>
                    <VincularIOLInline onSuccess={() => { recargar(); onChanged && onChanged(); }} />
                  </div>
                )
              ) : (
                <div>
                  {b.matriz ? (
                    (cuentas.length ? cuentas : [null]).map((r, i) => {
                      const cta = r?.cuenta || "principal";
                      return (
                        <div key={cta} style={varias ? { padding: "8px 0", borderTop: i ? `1px solid ${C.border}` : "none" } : undefined}>
                          {varias && <div style={{ fontSize: 11.5, fontWeight: 600, color: C.text, marginBottom: 6 }}>{nombreCuenta(r)}</div>}
                          {bloqueMatriz(b, id, cta, r)}
                        </div>
                      );
                    })
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, color: C.muted, flex: 1 }}>{textoImporta}{varias && <span style={{ color: C.dim }}> Cuentas: {cuentas.map(nombreCuenta).join(", ")}.</span>}</span>
                      <button onClick={() => { onClose(); onNavigate && onNavigate("importaciones"); }} style={btn(false)}>Ir a Importaciones →</button>
                    </div>
                  )}
                  {b.matriz && b.importa && <div style={{ fontSize: 11, color: C.dim, marginTop: 6 }}>También podés subir el archivo de movimientos desde Importaciones: de ahí sale el histórico completo.</div>}
                  {nuevaDe === id ? (
                    <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${C.border}` }}>
                      <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>Otra cuenta en {b.label}: de una sociedad, de la que sos cotitular, la de un familiar. Cada una lleva su clave de Matriz y sus archivos; en el tablero se ven sumadas.</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 8, alignItems: "center" }}>
                        <input placeholder="Nombre (ej. Sociedad)" value={nueva.nombre} onChange={(e) => setNueva((x) => ({ ...x, nombre: e.target.value }))} style={inp} autoComplete="off" />
                        <input placeholder="N° de comitente" value={nueva.comitente} onChange={(e) => setNueva((x) => ({ ...x, comitente: e.target.value }))} onKeyDown={(e) => { if (e.key === "Enter") agregarCuenta(id); }} style={inp} autoComplete="off" />
                        <button onClick={() => agregarCuenta(id)} style={btn(true)}>Agregar</button>
                        <button onClick={() => { setNuevaDe(null); setNueva({ nombre: "", comitente: "" }); }} style={{ ...linkBtn, color: C.dim }}>Cancelar</button>
                      </div>
                      {msg[`nueva:${id}`] && <div style={{ fontSize: 11, color: C.red, marginTop: 6 }}>{msg[`nueva:${id}`]}</div>}
                    </div>
                  ) : (
                    <button onClick={() => { setNuevaDe(id); setNueva({ nombre: "", comitente: "" }); }} style={{ ...linkBtn, marginTop: 8 }}>+ Agregar otra cuenta de {b.label}</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
'''
s = s[:a] + nuevo + s[z:]

# ───────────────────────── libro / FCI por cuenta ─────────────────────────
sub('''async function leerLibroCompleto(userId, columnas = "*") {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from("libro_movimientos").select(columnas)
      .eq("user_id", userId).order("nro_comprobante", { ascending: true }).range(desde, desde + 999);''',
'''async function leerLibroCompleto(userId, columnas = "*", cuenta = null) {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    let q = supabase.from("libro_movimientos").select(columnas).eq("user_id", userId);
    if (cuenta) q = q.eq("cuenta", cuenta);
    const { data, error } = await q.order("nro_comprobante", { ascending: true }).range(desde, desde + 999);''', 'leerLibroCompleto')

sub('''async function syncFciOps(userId, fciOps) {
  if (!fciOps || !fciOps.length) return { inserted: 0, error: null };
  const { data: existing, error } = await supabase
    .from("positions")
    .select("ticker, quantity, entry_date, operation_type, extra")
    .eq("user_id", userId)
    .eq("broker", "cocos")
    .eq("instrument_type", "fci");''',
'''async function syncFciOps(userId, fciOps, cuenta = "principal") {
  if (!fciOps || !fciOps.length) return { inserted: 0, error: null };
  const { data: existing, error } = await supabase
    .from("positions")
    .select("ticker, quantity, entry_date, operation_type, extra")
    .eq("user_id", userId)
    .eq("broker", "cocos")
    .eq("cuenta", cuenta)
    .eq("instrument_type", "fci");''', 'syncFciOps')
sub('''      entry_date: o.entry_date, broker: "cocos", settlement: "CI",
      extra: { source: "libro_fci", libro_comprobante: o.comprobante },''',
'''      entry_date: o.entry_date, broker: "cocos", cuenta, settlement: "CI",
      extra: { source: "libro_fci", libro_comprobante: o.comprobante },''', 'syncFciOps rows')

# modal viejo de Movimientos: conflicto con el índice nuevo (va a la principal)
sub('''        .upsert(chunk, { onConflict: "user_id,nro_comprobante", ignoreDuplicates: true });''',
'''        .upsert(chunk, { onConflict: "user_id,cuenta,nro_comprobante", ignoreDuplicates: true });''', 'modal viejo upsert')

# ───────────────────────── Saldo de apertura por cuenta ─────────────────────────
sub('''function SaldoAperturaCard({ userId, onSaved }) {''', '''function SaldoAperturaCard({ userId, onSaved, cuenta = "principal", nombreCuenta = null }) {''', 'apertura firma')
sub('''        .select("currency, amount").eq("user_id", userId).eq("broker", "cocos");
      if (!vivo) return;
      const m = {};
      for (const r of data || []) m[r.currency] = String(r.amount);
      setVals(m);
    })();
    return () => { vivo = false; };
  }, [userId]);''',
'''        .select("currency, amount").eq("user_id", userId).eq("broker", "cocos").eq("cuenta", cuenta);
      if (!vivo) return;
      const m = {};
      for (const r of data || []) m[r.currency] = String(r.amount);
      setVals(m);
    })();
    return () => { vivo = false; };
  }, [userId, cuenta]);''', 'apertura lectura')
sub('''      .map((r) => ({ user_id: userId, broker: "cocos", currency: r.currency, amount: r.amount, updated_at: new Date().toISOString() }));
    const { error } = filas.length
      ? await supabase.from("broker_opening_cash").upsert(filas, { onConflict: "user_id,broker,currency" })''',
'''      .map((r) => ({ user_id: userId, broker: "cocos", cuenta, currency: r.currency, amount: r.amount, updated_at: new Date().toISOString() }));
    const { error } = filas.length
      ? await supabase.from("broker_opening_cash").upsert(filas, { onConflict: "user_id,broker,cuenta,currency" })''', 'apertura guardar')
sub('''        Saldo de apertura
      </div>''', '''        Saldo de apertura{nombreCuenta ? <span style={{ fontSize: 11.5, color: C.dim, fontWeight: 400 }}> · {nombreCuenta}</span> : null}
      </div>''', 'apertura titulo')

# ───────────────────────── ImportacionesView ─────────────────────────
sub('''  const { rows: movs, reload: reloadMovs } = useLibroMovimientos();
  const existingComprobantes = useMemo(() => new Set(movs.map((m) => m.nro_comprobante)), [movs]);''',
'''  const { rows: movsTodos, reload: reloadMovs } = useLibroMovimientos();
  // Cuenta de Cocos a la que va el archivo (varias cuentas del mismo broker).
  const [cuenta, setCuenta] = useState("principal");
  const cuentasCocos = useMemo(() => conns.filter((r) => r.broker === "cocos")
    .sort((a, b) => ((a.cuenta || "principal") === "principal" ? -1 : (b.cuenta || "principal") === "principal" ? 1 : 0)), [conns]);
  const nombreDeCuenta = (cta) => {
    const r = cuentasCocos.find((x) => (x.cuenta || "principal") === cta);
    const base = cta === "principal" ? "Cuenta principal" : (String(r?.label || "").split(" · ").slice(1).join(" · ") || r?.label || cta);
    return base + (r?.broker_account_id ? ` · comitente ${r.broker_account_id}` : "");
  };
  const variasCocos = cuentasCocos.length > 1;
  const movs = useMemo(() => movsTodos.filter((m) => (m.cuenta || "principal") === cuenta), [movsTodos, cuenta]);
  const existingComprobantes = useMemo(() => new Set(movs.map((m) => m.nro_comprobante)), [movs]);''', 'imp estado cuenta')

sub('''    supabase.from("linked_brokers").select("broker,label,status,last_sync_at").eq("user_id", user.id).then(({ data }) => setConns(data || []));''',
'''    supabase.from("linked_brokers").select("broker,cuenta,label,status,last_sync_at,broker_account_id").eq("user_id", user.id).then(({ data }) => setConns(data || []));''', 'imp conns')

sub('''  const applyDerived = async (derived) => {
    const allPos = [...derived.positions, ...derived.lots];
    const libroHasta = allPos.reduce((m, p) => (p.entry_date && p.entry_date > m ? p.entry_date : m), "");
    await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").filter("extra->>source", "eq", "derivado_libro");''',
'''  const applyDerived = async (derived, cta = "principal") => {
    const allPos = [...derived.positions, ...derived.lots];
    const libroHasta = allPos.reduce((m, p) => (p.entry_date && p.entry_date > m ? p.entry_date : m), "");
    // Todo acotado a la cuenta: rearmar la cuenta B no puede tocar la A.
    await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").eq("cuenta", cta).filter("extra->>source", "eq", "derivado_libro");''', 'applyDerived firma')
sub('''      await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos")
        .filter("extra->>source", "in", '("historico_libro","ajuste_neteo")');''',
'''      await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").eq("cuenta", cta)
        .filter("extra->>source", "in", '("historico_libro","ajuste_neteo")');''', 'applyDerived historico')
sub('''        await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos")
          .filter("extra->>source", "eq", "csv_matriz").lte("entry_date", libroHasta)''',
'''        await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").eq("cuenta", cta)
          .filter("extra->>source", "eq", "csv_matriz").lte("entry_date", libroHasta)''', 'applyDerived puentes')
sub('''    const { data: puentes } = await supabase.from("positions").select("id")
      .eq("user_id", user.id).eq("broker", "cocos").filter("extra->>source", "eq", "csv_matriz");''',
'''    const { data: puentes } = await supabase.from("positions").select("id")
      .eq("user_id", user.id).eq("broker", "cocos").eq("cuenta", cta).filter("extra->>source", "eq", "csv_matriz");''', 'applyDerived puentes select')
sub('''    const cajaCocos = () => supabase.from("cash_movements").delete().eq("user_id", user.id).or("broker.eq.cocos,broker.is.null");
    await cajaCocos().is("source_ref", null);''',
'''    const cajaCocos = () => supabase.from("cash_movements").delete().eq("user_id", user.id).eq("cuenta", cta).or("broker.eq.cocos,broker.is.null");
    await cajaCocos().is("source_ref", null);''', 'applyDerived caja')
sub('''      broker: "cocos", settlement: (p.instrument_type === "fci" || p.instrument_type === "future") ? "CI" : "T1",''',
'''      broker: "cocos", cuenta: cta, settlement: (p.instrument_type === "fci" || p.instrument_type === "future") ? "CI" : "T1",''', 'applyDerived posRows')
sub('''    const fciSync = await syncFciOps(user.id, derived.fciOps);''', '''    const fciSync = await syncFciOps(user.id, derived.fciOps, cta);''', 'applyDerived fci')
sub('''        .eq("user_id", user.id)
        .eq("broker", "cocos");
      for (const a of aperturas || []) {''',
'''        .eq("user_id", user.id)
        .eq("broker", "cocos")
        .eq("cuenta", cta);
      for (const a of aperturas || []) {''', 'applyDerived apertura')
sub('''    for (let k = 0; k < cashRows.length; k += 200) {
      const { error } = await supabase.from("cash_movements").insert(cashRows.slice(k, k + 200));
      if (error) return error.message;
    }
    return null;
  };''',
'''    for (const r of cashRows) r.cuenta = cta;
    for (let k = 0; k < cashRows.length; k += 200) {
      const { error } = await supabase.from("cash_movements").insert(cashRows.slice(k, k + 200));
      if (error) return error.message;
    }
    return null;
  };''', 'applyDerived caja insert')

sub('''      const { data: batch, error: be } = await supabase.from("import_batches").insert({ user_id: user.id, file_name: parsed.fileName, broker, source: "movimientos_cuenta", n_rows: newRows.length }).select().single();
      if (be) { setImporting(false); setResult({ err: be.message }); return; }
      for (let k = 0; k < newRows.length; k += 300) {
        const chunk = newRows.slice(k, k + 300).map(({ status, ...r }) => ({ ...r, user_id: user.id, import_batch_id: batch.id }));
        const { error } = await supabase.from("libro_movimientos").upsert(chunk, { onConflict: "user_id,nro_comprobante", ignoreDuplicates: true });''',
'''      const { data: batch, error: be } = await supabase.from("import_batches").insert({ user_id: user.id, file_name: parsed.fileName, broker, cuenta, source: "movimientos_cuenta", n_rows: newRows.length }).select().single();
      if (be) { setImporting(false); setResult({ err: be.message }); return; }
      for (let k = 0; k < newRows.length; k += 300) {
        const chunk = newRows.slice(k, k + 300).map(({ status, ...r }) => ({ ...r, user_id: user.id, cuenta, import_batch_id: batch.id }));
        const { error } = await supabase.from("libro_movimientos").upsert(chunk, { onConflict: "user_id,cuenta,nro_comprobante", ignoreDuplicates: true });''', 'importar batch')
sub('''    const { data: fresh, error: errLibro } = await leerLibroCompleto(user.id);''',
'''    const { data: fresh, error: errLibro } = await leerLibroCompleto(user.id, "*", cuenta);''', 'importar leer libro')
sub('''    const err = await applyDerived(derivedSeguro);''', '''    const err = await applyDerived(derivedSeguro, cuenta);''', 'importar apply')

sub('''    // Cocos "Borrar todo": wipe INTEGRAL de Cocos (lotes + libro + posiciones
    // broker='cocos' de cualquier fuente + caja). IOL y Balanz quedan intactos.
    await supabase.from("import_batches").delete().eq("user_id", user.id).or("broker.is.null,broker.neq.balanz");
    await supabase.from("libro_movimientos").delete().eq("user_id", user.id);
    await borrarPosicionesCocos(user.id);
    await supabase.from("cash_movements").delete().eq("user_id", user.id).or("broker.eq.cocos,broker.is.null");
    setConfirmDel(null); reloadBatches(); reloadMovs();''',
'''    // Cocos "Borrar todo" de ESA cuenta: lotes + libro + posiciones broker='cocos'
    // de cualquier fuente + caja, solo de la cuenta del lote. Las otras cuentas
    // de Cocos, IOL y Balanz quedan intactas.
    const cta = b?.cuenta || "principal";
    await supabase.from("import_batches").delete().eq("user_id", user.id).eq("cuenta", cta).or("broker.is.null,broker.neq.balanz");
    await supabase.from("libro_movimientos").delete().eq("user_id", user.id).eq("cuenta", cta);
    await supabase.from("positions").delete().eq("user_id", user.id).eq("broker", "cocos").eq("cuenta", cta);
    await supabase.from("cash_movements").delete().eq("user_id", user.id).eq("cuenta", cta).or("broker.eq.cocos,broker.is.null");
    setConfirmDel(null); reloadBatches(); reloadMovs();''', 'deleteBatch')

sub('''    const d = deriveFromLedger(movs);
    const err = await applyDerived(d);''',
'''    const d = deriveFromLedger(movs); // movs ya viene filtrado por la cuenta elegida
    const err = await applyDerived(d, cuenta);''', 'reaplicar')

# selector de cuenta, debajo de los botones de broker
sub('''          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>{info.label}</div>''',
'''          {broker === "cocos" && variasCocos && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
              <span style={{ fontSize: 12, color: C.muted }}>¿De qué cuenta es el archivo?</span>
              {cuentasCocos.map((r) => {
                const cta = r.cuenta || "principal", on = cuenta === cta;
                return <button key={cta} onClick={() => { setCuenta(cta); setParsed(null); setResult(null); setRebuildMsg(null); }} style={{ padding: "6px 12px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${on ? C.accent : C.border}`, background: on ? "rgba(96,165,250,0.10)" : "transparent", color: on ? C.text : C.muted }}>{nombreDeCuenta(cta)}</button>;
              })}
            </div>
          )}
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: "14px 16px", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6 }}>{info.label}</div>''', 'selector cuenta')

sub('''              <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 10 }}>{isBalanzParsed ? "Es tu foto de tenencia de Balanz — reemplaza tus posiciones de Balanz. Cocos e IOL quedan intactos." : "Se cargan al libro y se reconstruye tu portfolio (posiciones + caja) de una. Reemplaza tus posiciones de Cocos; IOL queda intacto."}</div>''',
'''              <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 10 }}>{isBalanzParsed ? "Es tu foto de tenencia de Balanz — reemplaza tus posiciones de Balanz. Cocos e IOL quedan intactos." : variasCocos ? `Va a ${nombreDeCuenta(cuenta)}. Se carga al libro de esa cuenta y se reconstruyen sus posiciones y su caja; tus otras cuentas e IOL quedan intactos.` : "Se cargan al libro y se reconstruye tu portfolio (posiciones + caja) de una. Reemplaza tus posiciones de Cocos; IOL queda intacto."}</div>''', 'aviso preview')

sub('''            <SaldoAperturaCard userId={user?.id} onSaved={reloadMovs} />''',
'''            <SaldoAperturaCard userId={user?.id} onSaved={reloadMovs} cuenta={cuenta} nombreCuenta={variasCocos ? nombreDeCuenta(cuenta) : null} />''', 'apertura uso')

sub('''                        {b.file_name || "importación"}
                      </div>''',
'''                        {b.file_name || "importación"}
                        {variasCocos && b.broker !== "balanz" && <span style={{ fontSize: 10.5, color: C.dim, fontWeight: 400 }}>· {nombreDeCuenta(b.cuenta || "principal")}</span>}
                      </div>''', 'lote cuenta')
sub('''"Borra TODO Cocos: movimientos, caja y todas las posiciones (también WTI y opciones cargadas a mano). IOL y Balanz no se tocan. Al reimportar se arma de nuevo. ¿Seguro?"''',
'''(variasCocos ? `Borra TODO ${nombreDeCuenta(b.cuenta || "principal")} de Cocos: movimientos, caja y todas sus posiciones (también WTI y opciones cargadas a mano). Tus otras cuentas, IOL y Balanz no se tocan. Al reimportar se arma de nuevo. ¿Seguro?` : "Borra TODO Cocos: movimientos, caja y todas las posiciones (también WTI y opciones cargadas a mano). IOL y Balanz no se tocan. Al reimportar se arma de nuevo. ¿Seguro?")''', 'confirm borrar')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
