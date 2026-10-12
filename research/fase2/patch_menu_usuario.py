# -*- coding: utf-8 -*-
# Menú del avatar unificado (LP 12/10/2026, a partir del de El Teórico):
# Configuración, Avisos (sonido y ventanas), Ocultar montos, Pantalla
# (más grande / normal / más columnas), Panel de admin y Cerrar sesión.
# Las preferencias de pantalla viajan en profiles.ui_prefs.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et):
    global s
    n = s.count(a)
    if n != 1:
        print('%s: ancla %d veces, no escribo nada' % (et, n)); sys.exit(1)
    s = s.replace(a, b)

# 1) altura del contenedor raíz compensada por el zoom de "Pantalla"
sub('''        backgroundColor: C.bg,
        color: C.text,
        height: "100vh",
        minHeight: 600,''',
'''        backgroundColor: C.bg,
        color: C.text,
        height: "calc(100vh / var(--midas-zoom, 1))",
        minHeight: 600,''', 'altura raiz')

# 2) el header pasa la navegación al menú
sub('''              <UserMenu />''', '''              <UserMenu onNavigate={setActive} />''', 'render usermenu')

# 3) helpers + hooks del menú
sub('''function UserMenu() {
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);''',
'''// Preferencias de interfaz del menú del avatar. "Pantalla" se aplica con zoom
// de CSS sobre <html>; el contenedor raíz divide su altura por --midas-zoom
// para seguir ocupando justo la ventana (con zoom 1,1 un 100vh mide 110%).
const UI_PREFS_KEY = "midas:ui-prefs";
const PANTALLA_OPCIONES = [
  { id: "grande", label: "Más grande", zoom: 1.1 },
  { id: "normal", label: "Normal", zoom: 1 },
  { id: "columnas", label: "Más columnas", zoom: 0.9 },
];
function leerUiPrefs() {
  try { return { pantalla: "normal", ...(JSON.parse(localStorage.getItem(UI_PREFS_KEY) || "{}") || {}) }; } catch { return { pantalla: "normal" }; }
}
function aplicarPantalla(id) {
  try {
    const z = (PANTALLA_OPCIONES.find((o) => o.id === id) || {}).zoom || 1;
    const el = document.documentElement;
    el.style.zoom = z === 1 ? "" : String(z);
    el.style.setProperty("--midas-zoom", String(z));
  } catch { /* sin DOM */ }
}
aplicarPantalla(leerUiPrefs().pantalla);
function leerAvisos() {
  try { return { muted: localStorage.getItem("midas:alerts-muted") === "1", popupsOff: localStorage.getItem("midas:popups-off") === "1" }; } catch { return { muted: false, popupsOff: false }; }
}
// Avisa al resto de la app (motor de alertas, menú) que cambió una preferencia
// guardada en el navegador. Diferido para no setear estado en medio de un render.
function avisarPrefs() { setTimeout(() => { try { window.dispatchEvent(new Event("midas:prefs-changed")); } catch { /* noop */ } }, 0); }

function UserMenu({ onNavigate }) {
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [actioning, setActioning] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sub, setSub] = useState(null); // submenú abierto: "avisos" | "pantalla"
  const { hidden: privOculto, toggle: privToggle } = usePrivacy();
  const [uiPrefs, setUiPrefs] = useState(leerUiPrefs);
  const [avisos, setAvisos] = useState(leerAvisos);
  useEffect(() => {
    const h = () => setAvisos(leerAvisos());
    window.addEventListener("midas:prefs-changed", h);
    return () => window.removeEventListener("midas:prefs-changed", h);
  }, []);
  // Las preferencias guardadas en el usuario mandan sobre las del navegador.
  useEffect(() => {
    if (!user?.id) return;
    let vivo = true;
    supabase.from("profiles").select("ui_prefs").eq("id", user.id).maybeSingle().then(({ data }) => {
      if (!vivo || !data?.ui_prefs || !Object.keys(data.ui_prefs).length) return;
      const p = { ...leerUiPrefs(), ...data.ui_prefs };
      try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(p)); } catch { /* sin storage */ }
      setUiPrefs(p); aplicarPantalla(p.pantalla);
    }, () => {});
    return () => { vivo = false; };
  }, [user?.id]);
  const cambiarPantalla = (id) => {
    const p = { ...uiPrefs, pantalla: id };
    setUiPrefs(p); aplicarPantalla(id);
    try { localStorage.setItem(UI_PREFS_KEY, JSON.stringify(p)); } catch { /* sin storage */ }
    if (user?.id) supabase.from("profiles").update({ ui_prefs: p }).eq("id", user.id).then(() => {}, () => {});
  };
  const cambiarAviso = (clave, valor) => {
    try { localStorage.setItem(clave, valor ? "1" : "0"); } catch { /* sin storage */ }
    setAvisos(leerAvisos()); avisarPrefs();
  };''', 'usermenu hooks')

# 4) filas nuevas antes de Cerrar sesión
sub('''          {/* Acciones */}
          <button
            onClick={handleLogout}''',
'''          {/* Preferencias */}
          {(() => {
            const fila = { padding: "9px 14px", backgroundColor: "transparent", border: "none", color: C.text, fontSize: 12, cursor: "pointer", textAlign: "left", fontFamily: "'Roboto', sans-serif", transition: "background-color 120ms ease", display: "flex", alignItems: "center", gap: 10, width: "100%" };
            const hov = { onMouseEnter: (e) => { e.currentTarget.style.backgroundColor = C.deep; }, onMouseLeave: (e) => { e.currentTarget.style.backgroundColor = "transparent"; } };
            const valor = (t) => <span style={{ marginLeft: "auto", fontSize: 11, color: C.dim, display: "flex", alignItems: "center", gap: 4 }}>{t}</span>;
            const opcion = (label, on, onClick) => (
              <button key={label} onClick={onClick} style={{ ...fila, padding: "7px 14px 7px 38px", color: on ? C.text : C.muted, fontWeight: on ? 600 : 400 }} {...hov}>
                {label}{on && <Check size={13} strokeWidth={2} style={{ marginLeft: "auto", color: C.accent }} />}
              </button>
            );
            const avisosTxt = avisos.muted ? "Silenciados" : avisos.popupsOff ? "Sin ventanas" : "Activados";
            const pantallaTxt = (PANTALLA_OPCIONES.find((o) => o.id === uiPrefs.pantalla) || PANTALLA_OPCIONES[1]).label;
            const flecha = (k) => <ChevronDown size={12} style={{ transform: sub === k ? "rotate(180deg)" : "none", transition: "transform 120ms" }} />;
            return (
              <div style={{ borderBottom: `1px solid ${C.border}`, padding: "4px 0" }}>
                {onNavigate && (
                  <button onClick={() => { setOpen(false); onNavigate("settings"); }} style={fila} {...hov}>
                    <Settings size={14} strokeWidth={1.7} style={{ color: C.muted }} />Configuración
                  </button>
                )}
                <button onClick={() => setSub(sub === "avisos" ? null : "avisos")} style={fila} {...hov}>
                  <Bell size={14} strokeWidth={1.7} style={{ color: C.muted }} />Avisos{valor(<>{avisosTxt}{flecha("avisos")}</>)}
                </button>
                {sub === "avisos" && (
                  <div>
                    {opcion("Sonido y alertas en pantalla", !avisos.muted, () => cambiarAviso("midas:alerts-muted", !avisos.muted))}
                    {opcion("Ventanas del navegador", !avisos.popupsOff, () => cambiarAviso("midas:popups-off", !avisos.popupsOff))}
                    <div style={{ padding: "2px 14px 8px 38px", fontSize: 10.5, color: C.dim, lineHeight: 1.4 }}>Los avisos por Telegram se manejan desde Configuración.</div>
                  </div>
                )}
                <button onClick={privToggle} style={fila} {...hov}>
                  {privOculto ? <EyeOff size={14} strokeWidth={1.7} style={{ color: C.muted }} /> : <Eye size={14} strokeWidth={1.7} style={{ color: C.muted }} />}Ocultar montos{valor(privOculto ? "Sí" : "No")}
                </button>
                <button onClick={() => setSub(sub === "pantalla" ? null : "pantalla")} style={fila} {...hov}>
                  <Layers size={14} strokeWidth={1.7} style={{ color: C.muted }} />Pantalla{valor(<>{pantallaTxt}{flecha("pantalla")}</>)}
                </button>
                {sub === "pantalla" && PANTALLA_OPCIONES.map((o) => opcion(o.label, uiPrefs.pantalla === o.id, () => cambiarPantalla(o.id)))}
              </div>
            );
          })()}

          {/* Acciones */}
          <button
            onClick={handleLogout}''', 'filas menu')

# 5) el motor de alertas avisa sus cambios y escucha los del menú
sub('''  const toggleMute = useCallback(() => setMuted((m) => { const nm = !m; try { localStorage.setItem("midas:alerts-muted", nm ? "1" : "0"); } catch (e) { /* noop */ } return nm; }), []);''',
'''  const toggleMute = useCallback(() => setMuted((m) => { const nm = !m; try { localStorage.setItem("midas:alerts-muted", nm ? "1" : "0"); } catch (e) { /* noop */ } avisarPrefs(); return nm; }), []);''', 'toggleMute')
sub('''  const togglePopups = useCallback(() => setPopupsOff((v) => { const nv = !v; try { localStorage.setItem("midas:popups-off", nv ? "1" : "0"); } catch (e) { /* noop */ } return nv; }), []);''',
'''  const togglePopups = useCallback(() => setPopupsOff((v) => { const nv = !v; try { localStorage.setItem("midas:popups-off", nv ? "1" : "0"); } catch (e) { /* noop */ } avisarPrefs(); return nv; }), []);
  // El menú del avatar también prende y apaga sonido y ventanas.
  useEffect(() => {
    const h = () => { const a = leerAvisos(); setMuted(a.muted); setPopupsOff(a.popupsOff); };
    window.addEventListener("midas:prefs-changed", h);
    return () => window.removeEventListener("midas:prefs-changed", h);
  }, []);''', 'togglePopups')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
