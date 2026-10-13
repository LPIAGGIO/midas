# -*- coding: utf-8 -*-
# Desvincular cuentas de Cocos/Matriz (LP 12/10/2026: "falta en Cocos el botón
# desvincular, para poder meterle de nuevo cuando quiera o sacarla").
#  - "Sacar la clave de Matriz": borra la clave de Vault y deja la cuenta y sus
#    datos (se vuelve a cargar desde Agregar broker).
#  - "Quitar la cuenta": borra la clave, la fila y TODO lo de esa cuenta
#    (libro, lotes, posiciones, caja, saldo de apertura). Solo para cuentas
#    adicionales, o la principal si no tiene operaciones.
#  - Horas en 24 h y hora argentina en la tarjeta (decía 09:22 a las 21:22).
#  - El selector de cuentas se refresca solo cuando se agrega o quita una.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

# ── hora legible ──
sub('''function selLista(sel) {''',
'''// Fecha y hora argentinas en 24 h ("12/10/2026, 21:22").
function fmtFechaHoraAR(v) {
  try { return new Date(v).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { return String(v || ""); }
}
// Aviso para que el selector de cuentas relea las cuentas dadas de alta.
function avisarCuentas() { try { window.dispatchEvent(new Event("midas:cuentas-changed")); } catch { /* noop */ } }

function selLista(sel) {''', 'helpers')
sub('''              <> · Último sync: {new Date(linked.last_sync_at).toLocaleString("es-AR")}</>''',
'''              <> · Último sync: {fmtFechaHoraAR(linked.last_sync_at)}</>''', 'sync fmt')
sub('''                Actualizado: {new Date(cashSnapshotAt).toLocaleString("es-AR")}''',
'''                Actualizado: {fmtFechaHoraAR(cashSnapshotAt)}''', 'actualizado fmt')
sub('''          Última call: {new Date(quota.last_call_at).toLocaleString("es-AR")}''',
'''          Última call: {fmtFechaHoraAR(quota.last_call_at)}''', 'call fmt')

# ── el selector relee cuentas ──
sub('''    supabase.from("linked_brokers").select("broker,cuenta,label,broker_account_id,created_at").eq("user_id", user.id).order("created_at", { ascending: true })
      .then(({ data }) => { if (vivo) setCuentas(data || []); }, () => {});
    return () => { vivo = false; };
  }, [user?.id]);''',
'''    const leer = () => supabase.from("linked_brokers").select("broker,cuenta,label,broker_account_id,created_at").eq("user_id", user.id).order("created_at", { ascending: true })
      .then(({ data }) => { if (vivo) setCuentas(data || []); }, () => {});
    leer();
    window.addEventListener("midas:cuentas-changed", leer);
    return () => { vivo = false; window.removeEventListener("midas:cuentas-changed", leer); };
  }, [user?.id]);''', 'provider relee')
# el alta de brokers avisa cuando cambia algo
sub('''    setNueva({ nombre: "", comitente: "" }); setNuevaDe(null); setMsg((m) => ({ ...m, [`nueva:${id}`]: "" }));
    await recargar();''',
'''    setNueva({ nombre: "", comitente: "" }); setNuevaDe(null); setMsg((m) => ({ ...m, [`nueva:${id}`]: "" }));
    avisarCuentas();
    await recargar();''', 'alta avisa')
sub('''      for (const r of sacar) await supabase.from("linked_brokers").delete().eq("id", r.id).eq("user_id", user.id);
      onChanged && onChanged();''',
'''      for (const r of sacar) await supabase.from("linked_brokers").delete().eq("id", r.id).eq("user_id", user.id);
      avisarCuentas();
      onChanged && onChanged();''', 'guardar avisa')

# ── tarjeta: estado + acciones ──
sub('''  const [unlinking, setUnlinking] = useState(false);''',
'''  const [unlinking, setUnlinking] = useState(false);
  const [opcMatriz, setOpcMatriz] = useState(false);   // panel de desvincular de una cuenta Matriz/manual
  const [opcMsg, setOpcMsg] = useState(null);
  const cuentaCta = linked?.cuenta || "principal";
  const puedeQuitar = !!linked && !isApi && (cuentaCta !== "principal" || positionCount === 0);
  // Saca la clave de Matriz: la cuenta y sus datos quedan.
  const sacarClave = async () => {
    setUnlinking(true); setOpcMsg(null);
    const { error } = await supabase.rpc("borrar_credencial_matriz", { p_broker: id, p_cuenta: cuentaCta });
    setUnlinking(false);
    if (error) { setOpcMsg("No se pudo sacar la clave: " + error.message); return; }
    setOpcMatriz(false); refetchBrokers && refetchBrokers();
  };
  // Quita la cuenta entera con todo lo suyo. Solo esa cuenta: filtro por
  // user_id, broker y cuenta en cada borrado.
  const quitarCuenta = async () => {
    const nombre = linked?.label || meta.label;
    if (!window.confirm(`¿Quitar ${nombre}?\\n\\nSe borran su clave de Matriz y todos sus datos en Midas: movimientos importados, posiciones, caja y saldo de apertura de esta cuenta. Tus otras cuentas no se tocan. No se puede deshacer.`)) return;
    setUnlinking(true); setOpcMsg(null);
    try {
      if (linked.vault_secret_name) {
        const { error } = await supabase.rpc("borrar_credencial_matriz", { p_broker: id, p_cuenta: cuentaCta });
        if (error) throw error;
      }
      const pasos = [
        supabase.from("libro_movimientos").delete().eq("user_id", userId).eq("cuenta", cuentaCta),
        supabase.from("positions").delete().eq("user_id", userId).eq("broker", id).eq("cuenta", cuentaCta),
        supabase.from("cash_movements").delete().eq("user_id", userId).eq("broker", id).eq("cuenta", cuentaCta),
        supabase.from("broker_opening_cash").delete().eq("user_id", userId).eq("broker", id).eq("cuenta", cuentaCta),
        supabase.from("import_batches").delete().eq("user_id", userId).eq("broker", id).eq("cuenta", cuentaCta),
      ];
      // El libro es solo de Cocos: para otro broker no se toca.
      if (id !== "cocos") pasos.shift();
      for (const q of pasos) { const { error } = await q; if (error) throw error; }
      const { error: e2 } = await supabase.from("linked_brokers").delete().eq("id", linked.id).eq("user_id", userId);
      if (e2) throw e2;
      avisarCuentas();
      refetchBrokers && refetchBrokers();
    } catch (e) {
      setOpcMsg("No se pudo quitar: " + (e?.message || "error"));
    } finally { setUnlinking(false); }
  };''', 'card estado')

# botón y panel junto al de IOL
sub('''          {/* Acción: Desvincular (IOL conectado) */}
          {linked && isApi && (''',
'''          {/* Acción: Desvincular (cuentas Matriz o manuales con fila) */}
          {linked && !isApi && (linked.vault_secret_name || puedeQuitar) && (
            <button
              onClick={() => { setOpcMatriz((v) => !v); setOpcMsg(null); }}
              disabled={unlinking}
              style={{ fontSize: 11, letterSpacing: "0.04em", background: "transparent", color: opcMatriz ? C.text : C.muted, border: `1px solid ${opcMatriz ? C.borderStrong : C.border}`, borderRadius: 3, cursor: unlinking ? "default" : "pointer", padding: "5px 12px", display: "flex", alignItems: "center", gap: 6 }}
            >
              {unlinking && <Loader2 size={11} className="eco-spin" strokeWidth={2} />}
              Desvincular
            </button>
          )}

          {/* Acción: Desvincular (IOL conectado) */}
          {linked && isApi && (''', 'boton')

# panel con las dos opciones, debajo del encabezado
sub('''        </div>
        </div>

        {/* IOL conectado: efectivo + cupo de API lado a lado + actividad desplegable */}''',
'''        </div>
        </div>

        {opcMatriz && linked && !isApi && (
          <div style={{ borderTop: `1px solid ${C.border}`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            {linked.vault_secret_name && (
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ flex: 1, fontSize: 11.5, color: C.muted, minWidth: 240 }}><b style={{ color: C.text, fontWeight: 600 }}>Sacar la clave de Matriz.</b> Midas deja de sincronizar esta cuenta; sus movimientos, posiciones y caja quedan. La volvés a cargar cuando quieras desde Agregar broker.</span>
                <button onClick={sacarClave} disabled={unlinking} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 3, cursor: "pointer", background: "transparent", color: C.accent, border: `1px solid ${C.accentBorder}` }}>Sacar la clave</button>
              </div>
            )}
            {puedeQuitar ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span style={{ flex: 1, fontSize: 11.5, color: C.muted, minWidth: 240 }}><b style={{ color: C.text, fontWeight: 600 }}>Quitar la cuenta.</b> Borra la cuenta, su clave y todo lo suyo en Midas: movimientos, posiciones, caja y saldo de apertura. Tus otras cuentas no se tocan.</span>
                <button onClick={quitarCuenta} disabled={unlinking} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 3, cursor: "pointer", background: "transparent", color: C.red, border: `1px solid ${C.red}` }}>Quitar la cuenta</button>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: C.dim }}>La cuenta principal con operaciones no se quita desde acá: para borrar sus datos usá Eliminar en Importaciones.</div>
            )}
            {opcMsg && <div style={{ fontSize: 11, color: C.red }}>{opcMsg}</div>}
          </div>
        )}

        {/* IOL conectado: efectivo + cupo de API lado a lado + actividad desplegable */}''', 'panel')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
