# -*- coding: utf-8 -*-
# Comitente obligatorio al conectar Matriz (LP 15/10/2026). Pablo conectó Matriz
# sin número de comitente y quedó dos días en error: cocos-sync no puede
# sincronizar sin él. (1) El formulario no deja guardar sin comitente numérico
# y explica dónde encontrarlo. (2) Si una cuenta ya quedó en error por falta de
# comitente, la tarjeta de Brokers y el recuadro "Conectado" permiten
# completarlo ahí mismo, sin volver a cargar la clave.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ── componente para completar el comitente de una fila en error ──
sub('''function AltaBrokersModal({ open, onClose, onNavigate, onChanged, inline = false }) {''',
'''// Texto que deja cocos-sync cuando una cuenta con clave no tiene comitente.
const FALTA_COMITENTE = "Falta el número de comitente";
const AYUDA_COMITENTE = "Es el número de cuenta (comitente) que ves en Matriz o en la app del broker; sin él no podemos sincronizar.";
const faltaComitente = (f) => !!f && f.status === "error" && String(f.status_message || "").startsWith(FALTA_COMITENTE);

/* Completar el comitente de una cuenta conectada que quedó en error por no
 * tenerlo. Actualiza solo esa fila del usuario y la deja pendiente de la
 * próxima sincronización: la clave ya está guardada, no hace falta pedirla. */
function CompletarComitente({ fila, userId, onDone }) {
  const [v, setV] = useState("");
  const [estado, setEstado] = useState(null);
  const num = v.replace(/\D/g, "");
  const guardar = async () => {
    if (!num || !fila?.id || !userId) return;
    setEstado("Guardando…");
    const { error } = await supabase.from("linked_brokers")
      .update({ broker_account_id: num, status: "pending", status_message: "Comitente cargado. Pendiente de la próxima sincronización.", updated_at: new Date().toISOString() })
      .eq("id", fila.id).eq("user_id", userId);
    if (error) { setEstado("No se pudo guardar: " + error.message); return; }
    setEstado(null); setV("");
    onDone && onDone();
  };
  return (
    <div style={{ marginTop: 8, padding: "10px 12px", border: `1px solid ${C.red}`, borderRadius: 6, background: "rgba(239,68,68,0.06)" }}>
      <div style={{ fontSize: 11.5, color: C.text, marginBottom: 6 }}>Falta el número de comitente de esta cuenta. {AYUDA_COMITENTE}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input placeholder="N° de comitente" value={v} inputMode="numeric" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") guardar(); }} style={{ padding: "6px 8px", fontSize: 12, background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 4, colorScheme: "dark", width: 160 }} autoComplete="off" />
        <button onClick={guardar} disabled={!num} style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, borderRadius: 6, border: `1px solid ${C.accent}`, background: num ? C.accent : "transparent", color: num ? C.bg : C.dim, cursor: num ? "pointer" : "default", opacity: num ? 1 : 0.6 }}>Guardar comitente</button>
        {estado && <span style={{ fontSize: 11, color: estado.startsWith("No") ? C.red : C.muted }}>{estado}</span>}
      </div>
    </div>
  );
}

function AltaBrokersModal({ open, onClose, onNavigate, onChanged, inline = false }) {''', 'componente')

# ── guardarMatriz: comitente obligatorio ──
sub('''    if (!c.usuario || !c.clave) { setMsg((m) => ({ ...m, [k]: "Falta el usuario o la clave de Matriz." })); return; }
    setMsg((m) => ({ ...m, [k]: "Guardando…" }));
    const { error } = await supabase.rpc("guardar_credencial_matriz", { p_broker: id, p_usuario: c.usuario, p_clave: c.clave, p_comitente: c.comitente || null,''',
'''    if (!c.usuario || !c.clave) { setMsg((m) => ({ ...m, [k]: "Falta el usuario o la clave de Matriz." })); return; }
    const comit = String(c.comitente ?? fila?.broker_account_id ?? "").replace(/\D/g, "");
    if (!comit) { setMsg((m) => ({ ...m, [k]: "Falta el número de comitente. " + AYUDA_COMITENTE })); return; }
    setMsg((m) => ({ ...m, [k]: "Guardando…" }));
    const { error } = await supabase.rpc("guardar_credencial_matriz", { p_broker: id, p_usuario: c.usuario, p_clave: c.clave, p_comitente: comit,''', 'guardar')

# ── recuadro "Conectado": aviso y completar comitente ──
sub('''        <button onClick={() => { setMsg((m) => ({ ...m, [k]: "" })); editar(k, true); }} style={{ ...btn(false), padding: "4px 10px", fontWeight: 500 }}>Cambiar usuario o clave</button>
      </div>
    );''',
'''        <button onClick={() => { setMsg((m) => ({ ...m, [k]: "" })); editar(k, true); }} style={{ ...btn(false), padding: "4px 10px", fontWeight: 500 }}>Cambiar usuario o clave</button>
        {faltaComitente(f) && <div style={{ flexBasis: "100%" }}><CompletarComitente fila={f} userId={user?.id} onDone={async () => { await recargar(); onChanged && onChanged(); }} /></div>}
      </div>
    );''', 'conectado')

# ── formulario: campo obligatorio, ayuda y botón deshabilitado ──
sub('''          <input placeholder="N° de comitente (opcional)" value={c.comitente ?? (f?.broker_account_id || "")} onChange={(e) => setC(k, "comitente", e.target.value)} style={inp} autoComplete="off" />
          <button onClick={() => guardarMatriz(id, cta)} style={btn(true)}>{f?.vault_secret_name ? "Guardar" : "Guardar y sincronizar"}</button>
        </div>''',
'''          <input placeholder="N° de comitente" inputMode="numeric" value={c.comitente ?? (f?.broker_account_id || "")} onChange={(e) => setC(k, "comitente", e.target.value)} style={inp} autoComplete="off" />
          {(() => {
            const listo = !!c.usuario && !!c.clave && !!String(c.comitente ?? f?.broker_account_id ?? "").replace(/\D/g, "");
            return <button onClick={() => guardarMatriz(id, cta)} disabled={!listo} style={{ ...btn(true), opacity: listo ? 1 : 0.5, cursor: listo ? "pointer" : "default" }}>{f?.vault_secret_name ? "Guardar" : "Guardar y sincronizar"}</button>;
          })()}
        </div>
        <div style={{ fontSize: 10.5, color: C.dim, marginTop: 6 }}>Los tres datos son obligatorios. {AYUDA_COMITENTE}</div>''', 'formulario')

# ── tarjeta de Brokers ──
sub('''          {hasError && linked.status_message && (
            <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>⚠ {linked.status_message}</div>
          )}''',
'''          {hasError && linked.status_message && !faltaComitente(linked) && (
            <div style={{ fontSize: 11, color: C.red, marginTop: 4 }}>⚠ {linked.status_message}</div>
          )}
          {faltaComitente(linked) && <CompletarComitente fila={linked} userId={userId} onDone={() => refetchBrokers && refetchBrokers()} />}''', 'tarjeta')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
