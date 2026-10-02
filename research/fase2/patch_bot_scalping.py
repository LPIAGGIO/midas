# -*- coding: utf-8 -*-
# Pantalla "Bot Scalping" (LP 02/10/2026: "un reporte exclusivo para mí, para
# ver lo que está haciendo el bot, con las dos cuentas, arriba del libro de
# operaciones, primero"). Lee scalp_estado y scalp_resultados, que publica el
# worker scalp-estado del VPS cada 30 s. Solo la ve el admin (LP): el ítem del
# menú es adminOnly y además las tablas tienen RLS por user_id.
import io, sys
P = 'C:/Users/slider/Documents/Claude/Projects/Midas/src/MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''      { id: "libro-operaciones", label: "Libro de operaciones", icon: BookOpen },''',
    '''      { id: "bot-scalping", label: "Bot Scalping", icon: Bot, adminOnly: true },
      { id: "libro-operaciones", label: "Libro de operaciones", icon: BookOpen },''', 'nav')

sub('''function filterNav(nav, allowed) {
  if (allowed == null) return nav;''',
    '''// Los ítems adminOnly (hoy: Bot Scalping) solo los ve el admin; se sacan antes
// de aplicar los permisos por módulo.
function sinAdminOnly(nav) {
  return nav.map((n) => (n.children ? { ...n, children: n.children.filter((c) => !c.adminOnly) } : n)).filter((n) => !n.adminOnly);
}
function filterNav(nav, allowed, isAdmin = false) {
  if (!isAdmin) nav = sinAdminOnly(nav);
  if (allowed == null) return nav;''', 'filterNav')

sub('''  return <MidasApp allowedModules={access.isAdmin ? null : access.allowedModules} />;''',
    '''  return <MidasApp allowedModules={access.isAdmin ? null : access.allowedModules} isAdmin={access.isAdmin} />;''', 'prop')
sub('''function MidasApp({ allowedModules = null }) {''', '''function MidasApp({ allowedModules = null, isAdmin = false }) {''', 'firma')
sub('''  const visibleNav = useMemo(() => filterNav(NAV, allowedModules), [allowedModules]);''',
    '''  const visibleNav = useMemo(() => filterNav(NAV, allowedModules, isAdmin), [allowedModules, isAdmin]);''', 'visibleNav')
sub('''            ) : active === "libro-operaciones" ? (
              <LibroOperacionesModule />''',
    '''            ) : active === "bot-scalping" ? (
              <BotScalpingModule />
            ) : active === "libro-operaciones" ? (
              <LibroOperacionesModule />''', 'ruta')

COMP = r'''/* ─────────────── BotScalpingModule ───────────────
 * Reporte del bot de grilla (scalping) en las cuentas de Cocos. Lee
 * scalp_estado (estado en vivo, una fila por cuenta + papel) y
 * scalp_resultados (resultado por día), que publica el worker scalp-estado
 * cada 30 s. Solo lectura: desde acá no se enciende ni se apaga nada.
 */
function BotScalpingModule() {
  const { user } = useAuth();
  const [filas, setFilas] = useState(null);
  const [hist, setHist] = useState([]);
  const [error, setError] = useState(null);
  const [abierta, setAbierta] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!user) return;
    let vivo = true;
    (async () => {
      const [a, b] = await Promise.all([
        supabase.from("scalp_estado").select("*").eq("user_id", user.id).order("cuenta").order("ticker"),
        supabase.from("scalp_resultados").select("fecha,cuenta,ticker,pnl,ventas,comprado").eq("user_id", user.id).order("fecha", { ascending: false }).limit(900),
      ]);
      if (!vivo) return;
      if (a.error) { setError(a.error.message); setFilas([]); return; }
      setError(null); setFilas(a.data || []); setHist(b.data || []);
    })();
    return () => { vivo = false; };
  }, [user, tick]);

  const fN = (n) => fmtNumber(n, { maxDecimals: 0 });
  const plata = (n) => (n == null ? "—" : `${n < 0 ? "−" : ""}$${fN(Math.abs(n))}`);
  const conSigno = (n) => (n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}$${fN(Math.abs(n))}`);
  const color = (n) => (n > 0 ? C.green : n < 0 ? C.red : C.muted);
  const hora = (iso) => new Date(iso).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" });
  const th = { textAlign: "right", padding: "6px 10px", fontWeight: 600, fontSize: 10, color: C.dim, whiteSpace: "nowrap" };
  const td = { textAlign: "right", padding: "6px 10px", whiteSpace: "nowrap" };

  const cuentas = useMemo(() => {
    const m = new Map();
    for (const f of filas || []) { if (!m.has(f.cuenta)) m.set(f.cuenta, []); m.get(f.cuenta).push(f); }
    // La cuenta original (72404) va primero; las demás, después, por número.
    const orden = (c) => (c === "72404" ? "0" : "1" + c);
    return [...m.entries()].sort((x, y) => orden(x[0]).localeCompare(orden(y[0])));
  }, [filas]);
  const resumen = (fs) => {
    const r = { real: 0, lat: 0, inv: 0, ventas: 0, on: 0, n: fs.length, expo: 0 };
    for (const f of fs) {
      r.real += Number(f.pnl_dia) || 0; r.lat += Number(f.latente) || 0; r.inv += Number(f.costo) || 0; r.ventas += f.ventas_dia || 0;
      if (f.online) r.on++;
      const px = Number(f.ask || f.ultimo || f.bid) || 0, c = f.config || {};
      r.expo += (Number(c.max) || 0) * (1 + (Number(c.refuerzo) || 0)) * px;
    }
    return r;
  };
  const total = resumen(filas || []);
  const viejo = (filas || []).length ? Math.max(...filas.map((f) => Date.now() - new Date(f.actualizado_at).getTime())) : 0;
  const histDias = useMemo(() => {
    const m = new Map();
    for (const h of hist) {
      const k = h.fecha; if (!m.has(k)) m.set(k, { fecha: k, porCuenta: {}, total: 0, ventas: 0 });
      const d = m.get(k); d.porCuenta[h.cuenta] = (d.porCuenta[h.cuenta] || 0) + Number(h.pnl || 0); d.total += Number(h.pnl || 0); d.ventas += h.ventas || 0;
    }
    return [...m.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : -1)).slice(0, 30);
  }, [hist]);

  const Tarjeta = ({ titulo, r }) => (
    <div style={{ flex: "1 1 240px", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "12px 14px" }}>
      <div style={{ fontSize: 10, color: C.dim, letterSpacing: 1.2, textTransform: "uppercase", fontWeight: 600 }}>{titulo}</div>
      <div style={{ display: "flex", gap: 18, marginTop: 8, flexWrap: "wrap" }}>
        <div><div style={{ fontSize: 10, color: C.dim }}>Realizado hoy</div><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: color(r.real) }}>{conSigno(r.real)}</div></div>
        <div><div style={{ fontSize: 10, color: C.dim }}>Latente</div><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: color(r.lat) }}>{conSigno(r.lat)}</div></div>
        <div><div style={{ fontSize: 10, color: C.dim }}>Neto</div><div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 18, fontWeight: 700, color: color(r.real + r.lat) }}>{conSigno(r.real + r.lat)}</div></div>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>
        Invertido {plata(r.inv)} · exposición máxima {plata(r.expo)}<br />
        {r.ventas} ventas hoy · {r.on} de {r.n} bots encendidos
      </div>
    </div>
  );

  return (
    <div style={{ padding: "28px 32px", maxWidth: 1500, margin: "0 auto" }}>
      <h1 style={{ fontFamily: "'Raleway', sans-serif", fontWeight: 700, fontSize: 32, color: C.text, margin: 0, marginBottom: 6 }}>Bot Scalping</h1>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 18 }}>
        Grilla escalonada en Cocos, por cuenta y por papel. Se actualiza cada 30 segundos.
        {viejo > 5 * 60000 && <span style={{ color: C.cat.amber, marginLeft: 8 }}>Último dato de hace {Math.round(viejo / 60000)} min (fuera de rueda se publica cada 5 min).</span>}
      </div>
      {error && <div style={{ color: C.red, fontSize: 13, marginBottom: 12 }}>No pude leer el estado: {error}</div>}
      {filas === null ? <div style={{ color: C.muted, fontSize: 13 }}>Cargando…</div> : !filas.length ? (
        <div style={{ color: C.muted, fontSize: 13 }}>Todavía no hay bots de scalping publicando su estado.</div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 22 }}>
            {cuentas.length > 1 && <Tarjeta titulo="Total · las dos cuentas" r={total} />}
            {cuentas.map(([c, fs]) => <Tarjeta key={c} titulo={`Cuenta ${c}`} r={resumen(fs)} />)}
          </div>
          {cuentas.map(([c, fs]) => (
            <div key={c} style={{ marginBottom: 26 }}>
              <div style={{ fontSize: 11, color: C.dim, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Cuenta {c}</div>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: C.text }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                      <th style={{ ...th, textAlign: "left" }}>Papel</th>
                      <th style={th}>Escalones</th><th style={th}>Tiene</th><th style={th}>Costo prom.</th><th style={th}>Precio</th>
                      <th style={th}>Invertido</th><th style={th}>Latente</th><th style={th}>Realizado hoy</th><th style={th}>Ventas</th>
                      <th style={th}>Próx. venta</th><th style={th}>Próx. compra</th><th style={{ ...th, textAlign: "left" }}>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fs.map((f) => {
                      const k = `${f.cuenta}|${f.ticker}`, cfg = f.config || {}, ten = Number(f.tenencia) || 0;
                      const ords = f.ordenes || [], ventas = ords.filter((o) => o.lado === "SELL"), compras = ords.filter((o) => o.lado === "BUY");
                      const pv = ventas.length ? Math.min(...ventas.map((o) => o.px)) : null, pc = compras.length ? Math.max(...compras.map((o) => o.px)) : null;
                      const nEsc = (f.niveles || []).length, px = Number(f.bid || f.ultimo) || null;
                      const estado = !f.online ? "apagado" : f.fin ? f.fin : f.reforzado ? "con refuerzo: sale todo junto" : ten ? "en posición" : "esperando compra";
                      const abierto = abierta === k;
                      return (
                        <Fragment key={k}>
                          <tr onClick={() => setAbierta(abierto ? null : k)} style={{ borderBottom: `1px solid ${C.border}`, cursor: "pointer", background: abierto ? C.accentSoft : "transparent" }}>
                            <td style={{ ...td, textAlign: "left", fontWeight: 700 }}>
                              <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: 4, marginRight: 8, background: f.online ? C.green : C.red }} />{f.ticker}
                            </td>
                            <td style={td}>
                              {Array.from({ length: cfg.escalones || 5 }).map((_, i) => <span key={i} style={{ display: "inline-block", width: 8, height: 8, marginLeft: 3, borderRadius: 2, background: i < nEsc ? (f.reforzado ? C.cat.amber : C.accent) : C.faint }} />)}
                            </td>
                            <td style={td}>{ten ? fN(ten) : "—"}</td>
                            <td style={td}>{ten ? `$${fN(Number(f.costo) / ten)}` : "—"}</td>
                            <td style={td}>{px ? `$${fN(px)}` : "—"}</td>
                            <td style={td}>{ten ? plata(Number(f.costo)) : "—"}</td>
                            <td style={{ ...td, color: color(Number(f.latente)) }}>{ten ? conSigno(Number(f.latente)) : "—"}</td>
                            <td style={{ ...td, color: color(Number(f.pnl_dia)), fontWeight: 700 }}>{conSigno(Number(f.pnl_dia))}</td>
                            <td style={td}>{f.ventas_dia || 0}</td>
                            <td style={td}>{pv ? `$${fN(pv)}` : "—"}</td>
                            <td style={td}>{pc ? `$${fN(pc)}` : "—"}</td>
                            <td style={{ ...td, textAlign: "left", color: f.online && !f.fin ? C.muted : C.cat.amber, fontFamily: "'Roboto', sans-serif", fontSize: 11.5 }}>{estado}</td>
                          </tr>
                          {abierto && (
                            <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                              <td colSpan={12} style={{ padding: "10px 14px 14px 26px", background: C.deep, fontSize: 11.5 }}>
                                <div style={{ display: "flex", gap: 34, flexWrap: "wrap" }}>
                                  <div>
                                    <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>CONFIGURACIÓN</div>
                                    <div style={{ color: C.muted, lineHeight: 1.7 }}>
                                      {fN(cfg.lote)} por escalón · máximo {fN(cfg.max)}<br />
                                      escalón cada {((cfg.paso || 0) * 100).toFixed(1)}% · venta a +{((cfg.ganancia || 0) * 100).toFixed(1)}%<br />
                                      {cfg.refuerzo > 0 ? `refuerzo de ${fN((cfg.max || 0) * cfg.refuerzo)} si cae ${((cfg.paso || 0) * ((cfg.escalones || 5) - 1) * 2 * 100).toFixed(1)}%` : "sin refuerzo"} · {cfg.corte >= 0.9 ? "sin corte" : `corte ${((cfg.corte || 0) * 100).toFixed(1)}%`}<br />
                                      primera compra del ciclo: {f.ancla ? `$${fN(Number(f.ancla))}` : "—"}
                                    </div>
                                  </div>
                                  <div>
                                    <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>LOTES EN CARTERA</div>
                                    {(f.niveles || []).length ? (f.niveles || []).map((n) => <div key={n.k} style={{ color: C.muted, lineHeight: 1.7 }}>escalón {n.k}: {fN(n.tenencia)} a ${fN(n.costo / n.tenencia)}</div>) : <div style={{ color: C.dim }}>ninguno</div>}
                                  </div>
                                  <div>
                                    <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>ÓRDENES APOYADAS</div>
                                    {ords.length ? ords.map((o, i) => <div key={i} style={{ color: C.muted, lineHeight: 1.7 }}>{o.lado === "BUY" ? "compra" : "venta"} {fN(o.q)} a ${fN(o.px)}{o.ejecutado > 0 ? ` (ejecutado ${fN(o.ejecutado)})` : ""}</div>) : <div style={{ color: C.dim }}>ninguna</div>}
                                  </div>
                                  <div style={{ flex: "1 1 320px" }}>
                                    <div style={{ color: C.dim, fontSize: 10, marginBottom: 4 }}>OPERACIONES DE HOY</div>
                                    {(f.eventos || []).length ? [...(f.eventos || [])].reverse().map((e, i) => (
                                      <div key={i} style={{ color: e.tipo === "error" ? C.red : C.muted, lineHeight: 1.7 }}>
                                        {hora(e.t)} · {e.tipo === "compra" ? `compra ${fN(e.q)} a $${fN(e.px)} (escalón ${e.esc})` : e.tipo === "venta" ? <>venta {fN(e.q)} a ${fN(e.px)} → <b style={{ color: color(e.neto) }}>{conSigno(e.neto)}</b></> : e.tipo === "refuerzo" ? `refuerzo: ${e.txt}` : e.txt}
                                      </div>
                                    )) : <div style={{ color: C.dim }}>sin operaciones hoy</div>}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {histDias.length > 0 && (
            <div style={{ marginBottom: 26 }}>
              <div style={{ fontSize: 11, color: C.dim, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Resultado realizado por día</div>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: C.text }}>
                  <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    <th style={{ ...th, textAlign: "left" }}>Fecha</th>
                    {cuentas.map(([c]) => <th key={c} style={th}>Cuenta {c}</th>)}
                    <th style={th}>Total</th><th style={th}>Ventas</th>
                  </tr></thead>
                  <tbody>
                    {histDias.map((d) => (
                      <tr key={d.fecha} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ ...td, textAlign: "left" }}>{d.fecha.split("-").reverse().join("/")}</td>
                        {cuentas.map(([c]) => <td key={c} style={{ ...td, color: color(d.porCuenta[c] || 0) }}>{d.porCuenta[c] != null ? conSigno(d.porCuenta[c]) : "—"}</td>)}
                        <td style={{ ...td, color: color(d.total), fontWeight: 700 }}>{conSigno(d.total)}</td>
                        <td style={td}>{d.ventas}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <div style={{ color: C.dim, fontSize: 11, lineHeight: 1.6, maxWidth: 900 }}>
            Realizado es neto de comisiones y solo cuenta lotes ya vendidos. Latente valúa lo que tiene el bot a la punta compradora. Sin corte: el bot no vende con pérdida; la exposición máxima es lo que tendría invertido con todos los escalones y el refuerzo cargados. Tocá un papel para ver sus lotes, sus órdenes y las operaciones del día. Desde esta pantalla no se enciende ni se apaga nada.
          </div>
        </>
      )}
    </div>
  );
}

function BotIolModule() {'''
sub('''function BotIolModule() {''', COMP, 'componente')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
