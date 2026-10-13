# -*- coding: utf-8 -*-
# Repaso de cuentas por broker (12/10/2026, LP fue a comer):
#  1) El importador viejo del Libro de operaciones ("Importar cuenta corriente")
#     metía todo en la cuenta principal: el archivo de la 3893 se mezclaba con
#     el libro de la 72404. Ahora pregunta la cuenta (si hay más de una de
#     Cocos) y deduplica contra el libro de ESA cuenta.
#  2) "Borrar todo" del libro avisa que borra todas las cuentas de Cocos.
#  3) La selección guardada en el navegador era una sola para cualquier usuario
#     y, si sus cuentas no existían (otro usuario, cuenta quitada), quedaba en
#     "ninguna" y la pantalla vacía. Ahora la clave es por usuario y, si no
#     queda ninguna cuenta válida, vuelve a "todas".
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ── 3) selección por usuario ──
sub('''  const [sel, setSelState] = useState(() => { try { return localStorage.getItem(CUENTA_SEL_KEY) || "todas"; } catch { return "todas"; } });
  const setSel = useCallback((v) => { setSelState(v); try { localStorage.setItem(CUENTA_SEL_KEY, v); } catch { /* sin storage */ } }, []);''',
'''  // Clave por usuario: en un navegador compartido cada uno tiene su selección.
  const selKey = `${CUENTA_SEL_KEY}:${user?.id || "anon"}`;
  const [sel, setSelState] = useState("todas");
  useEffect(() => { try { setSelState(localStorage.getItem(selKey) || "todas"); } catch { setSelState("todas"); } }, [selKey]);
  const setSel = useCallback((v) => { setSelState(v); try { localStorage.setItem(selKey, v); } catch { /* sin storage */ } }, [selKey]);''', 'sel por usuario')
sub('''  // Cuentas guardadas que ya no existen (otro usuario, cuenta borrada) se descartan.
  useEffect(() => {
    const l = selLista(sel);
    if (l && claves.length && l.some((k) => !claves.includes(k))) fijar(l);
  }, [claves, sel, fijar]);''',
'''  // Cuentas guardadas que ya no existen (cuenta quitada) se descartan; si no
  // queda ninguna válida, vuelve a "todas" en vez de dejar la pantalla vacía.
  useEffect(() => {
    const l = selLista(sel);
    if (!l || !l.length || !claves.length || !l.some((k) => !claves.includes(k))) return;
    const validas = l.filter((k) => claves.includes(k));
    if (validas.length) fijar(validas); else setSel("todas");
  }, [claves, sel, fijar, setSel]);''', 'validacion')

# ── 1) importador viejo del libro, por cuenta ──
sub('''function ImportCuentaCorrienteModal({ existingComprobantes, onDone, onClose }) {
  const { user } = useAuth();
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name); setResult(null);
    try {
      const parsed = parseMovimientosCsv(await f.text(), existingComprobantes);''',
'''function ImportCuentaCorrienteModal({ existingComprobantes, onDone, onClose }) {
  const { user } = useAuth();
  const { sel: cuentaSelGlobal, cuentas: cuentasTodas } = useCuenta();
  const [rows, setRows] = useState(null);
  const [fileName, setFileName] = useState("");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  // Cuenta de Cocos a la que va el archivo. Con una sola, la principal. Con
  // varias: la elegida arriba si es exactamente una de Cocos; si no, hay que elegir.
  const cuentasCocos = (cuentasTodas || []).filter((r) => r.broker === "cocos");
  const varias = cuentasCocos.length > 1;
  const [cuenta, setCuenta] = useState(() => {
    if (!varias) return "principal";
    const l = selLista(cuentaSelGlobal);
    return l && l.length === 1 && l[0].startsWith("cocos:") ? l[0].slice(6) : null;
  });
  const [texto, setTexto] = useState(null);
  // Dedup contra el libro de la cuenta elegida (no contra lo que se ve en pantalla).
  useEffect(() => {
    if (!texto || !cuenta || !user?.id) return;
    let vivo = true;
    (async () => {
      const { data } = await leerLibroCompleto(user.id, "nro_comprobante", cuenta);
      if (!vivo) return;
      const ya = new Set((data || []).map((m) => m.nro_comprobante));
      const parsed = parseMovimientosCsv(texto, ya);
      if (parsed == null) { setRows([]); setResult({ inserted: 0, errs: ["No reconozco el formato (esperaba el CSV movimientos_cuenta de Cocos, separado por ';')."] }); return; }
      setRows(parsed);
    })();
    return () => { vivo = false; };
  }, [texto, cuenta, user?.id]);

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name); setResult(null);
    if (varias) { try { setRows(null); setTexto(await f.text()); } catch (err) { setRows([]); setResult({ inserted: 0, errs: [`No se pudo leer el archivo: ${err.message}`] }); } return; }
    try {
      const parsed = parseMovimientosCsv(await f.text(), existingComprobantes);''', 'modal estado')
sub('''      const chunk = newRows.slice(k, k + 300).map(({ status, ...r }) => ({ ...r, user_id: user.id }));
      const { error } = await supabase
        .from("libro_movimientos")
        .upsert(chunk, { onConflict: "user_id,cuenta,nro_comprobante", ignoreDuplicates: true });''',
'''      const chunk = newRows.slice(k, k + 300).map(({ status, ...r }) => ({ ...r, user_id: user.id, cuenta: cuenta || "principal" }));
      const { error } = await supabase
        .from("libro_movimientos")
        .upsert(chunk, { onConflict: "user_id,cuenta,nro_comprobante", ignoreDuplicates: true });''', 'modal insert')
sub('''      const { error: fciErr } = await syncFciOps(user.id, fciOps);''',
'''      const { error: fciErr } = await syncFciOps(user.id, fciOps, cuenta || "principal");''', 'modal fci')
sub('''        <label style={{ display: "inline-block", padding: "8px 14px", border: `1px solid ${C.border}`, color: C.text, fontSize: 11, cursor: "pointer", marginBottom: 14, alignSelf: "flex-start" }}>
          {fileName || "Elegir archivo .csv"}''',
'''        {varias && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <span style={{ fontSize: 11, color: cuenta ? C.muted : C.yellow }}>¿De qué cuenta es el archivo?</span>
            {cuentasCocos.map((r) => {
              const cta = r.cuenta || "principal", on = cuenta === cta;
              return <button key={cta} onClick={() => { setCuenta(cta); setResult(null); }} style={{ padding: "5px 11px", fontSize: 11, fontWeight: 600, cursor: "pointer", borderRadius: 6, border: `1px solid ${on ? C.accent : C.border}`, background: on ? "rgba(96,165,250,0.10)" : "transparent", color: on ? C.text : C.muted }}>{nombreDeCuentaFila(r, cuentasTodas)}{r.broker_account_id && cta !== "principal" ? ` · ${r.broker_account_id}` : ""}</button>;
            })}
          </div>
        )}
        <label style={{ display: "inline-block", padding: "8px 14px", border: `1px solid ${C.border}`, color: C.text, fontSize: 11, cursor: "pointer", marginBottom: 14, alignSelf: "flex-start" }}>
          {fileName || "Elegir archivo .csv"}''', 'modal selector')
sub('''            <button onClick={doImport} disabled={importing || newRows.length === 0} style={{ padding: "9px 16px", backgroundColor: newRows.length ? C.accent : C.border, color: newRows.length ? "#0b0e11" : C.dim, border: "none", fontSize: 12, fontWeight: 700, cursor: newRows.length && !importing ? "pointer" : "default", alignSelf: "flex-start" }}>''',
'''            <button onClick={doImport} disabled={importing || newRows.length === 0 || !cuenta} style={{ padding: "9px 16px", backgroundColor: newRows.length ? C.accent : C.border, color: newRows.length ? "#0b0e11" : C.dim, border: "none", fontSize: 12, fontWeight: 700, cursor: newRows.length && !importing ? "pointer" : "default", alignSelf: "flex-start" }}>''', 'modal boton')

# ── 2) "Borrar todo" aclara que son todas las cuentas de Cocos ──
sub('''            ? <button onClick={wipeAll} style={{ padding: "8px 14px", backgroundColor: C.red, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>¿Seguro? Borrar todo</button>''',
'''            ? <button onClick={wipeAll} style={{ padding: "8px 14px", backgroundColor: C.red, color: "#fff", border: "none", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>{cuentasLibro.filter((r) => r.broker === "cocos").length > 1 ? "¿Seguro? Borra TODAS tus cuentas de Cocos" : "¿Seguro? Borrar todo"}</button>''', 'wipe texto')
sub('''function CuentaCorrienteView() {
  const { rows, loading, reload } = useLibroMovimientos();''',
'''function CuentaCorrienteView() {
  const { rows, loading, reload } = useLibroMovimientos();
  const { cuentas: cuentasLibro } = useCuenta();''', 'wipe ctx')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
