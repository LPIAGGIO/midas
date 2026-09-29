# -*- coding: utf-8 -*-
# Control de la tenencia de Cocos contra la foto de Matriz (API de Primary,
# worker cocos-sync), 29/09/2026. El extracto sigue mandando: esto solo avisa.
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

# 1) el banner, arriba de los chips de filtro de Posiciones consolidadas
sub('''              Importar CSV
            </button>
          )}
        </div>
      </div>

      {/* Filtros (chips por tipo).''',
'''              Importar CSV
            </button>
          )}
        </div>
      </div>

      <ControlCocosBanner positions={positions} />

      {/* Filtros (chips por tipo).''', '1/banner')

# 2) el componente, antes de groupBroker
sub('''function groupBroker(group) {''',
'''/* ─────────────── Control contra la foto de Matriz (29/09/2026) ───────────────
 *
 * El worker cocos-sync lee la cuenta de Cocos por la API oficial de Primary
 * (el backend de Matriz) cada 15 min de 10:00 a 12:45 y guarda UNA foto por
 * día en broker_account_snapshot. Matriz no trae sola la tenencia de Cocos:
 * LP le pide a Cocos cada mañana que la actualice; por eso solo se usan fotos
 * marcadas "cargada".
 *
 * Qué compara: lo que el broker tenía AL ABRIR el día de la foto ("inicial")
 * contra lo que Midas armó con el extracto hasta el día ANTERIOR. Las
 * operaciones de hoy no entran en ninguno de los dos lados. El extracto sigue
 * mandando: esto solo avisa dónde no coinciden. FCI y cauciones no están en
 * Matriz y quedan afuera; futuros sí (DLR112026 ↔ DLRNOV26).
 */
const MESES_DLR = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
function tickerMidasDesdeMatriz(tipo, simbolo) {
  const s = String(simbolo || "").toUpperCase();
  const m = /^([A-Z]+)(\\d{2})(\\d{4})$/.exec(s);
  if (tipo === "FUTURE" && m) {
    const mes = MESES_DLR[Number(m[2]) - 1];
    if (mes) return `${m[1]}${mes}${m[3].slice(2)}`;
  }
  return s;
}

function ControlCocosBanner({ positions }) {
  const { user } = useAuth();
  const [foto, setFoto] = useState(null);
  const [abierto, setAbierto] = useState(false);
  useEffect(() => {
    if (!user?.id) return;
    let vivo = true;
    supabase.from("broker_account_snapshot")
      .select("snapshot_at,snapshot_date,cash,positions,totals")
      .eq("user_id", user.id).eq("broker", "cocos")
      .order("snapshot_date", { ascending: false }).limit(5)
      .then(({ data }) => {
        if (!vivo) return;
        setFoto((data || []).find((f) => f?.totals?.cargada) || null);
      });
    return () => { vivo = false; };
  }, [user?.id]);

  const comp = useMemo(() => {
    if (!foto) return null;
    const dia = foto.snapshot_date;
    const midas = new Map();
    for (const p of positions || []) {
      if (p.broker !== "cocos") continue;
      if (!p.entry_date || p.entry_date >= dia) continue;
      if (p.instrument_type === "fci" || p.instrument_type === "caucion" || p.instrument_type === "option") continue;
      const tk = (p.ticker || "").trim().toUpperCase();
      if (!tk) continue;
      if (p.instrument_type === "bond_ars" || p.instrument_type === "bond_usd") {
        const mat = parseLetraMaturity(tk);
        if (mat && mat < dia) continue;
      }
      midas.set(tk, (midas.get(tk) || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0));
    }
    const broker = new Map();
    for (const x of foto.positions || []) {
      const tk = tickerMidasDesdeMatriz(x.tipo, x.simbolo);
      broker.set(tk, (broker.get(tk) || 0) + (Number(x.inicial) || 0));
    }
    const filas = [];
    for (const tk of new Set([...midas.keys(), ...broker.keys()])) {
      const b = broker.get(tk) || 0, m = midas.get(tk) || 0;
      if (Math.abs(b) < 1e-6 && Math.abs(m) < 1e-6) continue;
      filas.push({ tk, b, m, ok: Math.abs(b - m) < 1e-6 });
    }
    filas.sort((x, y) => Number(x.ok) - Number(y.ok) || x.tk.localeCompare(y.tk));
    return { filas, dif: filas.filter((f) => !f.ok).length };
  }, [foto, positions]);

  if (!foto || !comp || !comp.filas.length) return null;
  const hora = new Date(foto.snapshot_at).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const ars = foto.cash?.ci?.saldo?.ARS?.disponible;
  const ars24 = foto.cash?.["24hs"]?.saldo?.ARS?.disponible;
  const ok = comp.dif === 0;
  const color = ok ? C.green : C.cat.amber;
  const fN = (n) => fmtNumber(n, { maxDecimals: 0 });
  return (
    <div style={{ margin: "0 0 10px", border: `1px solid ${ok ? C.border : "rgba(251,191,36,0.35)"}`, borderRadius: 6, background: C.panel, fontSize: 11.5 }}>
      <button
        onClick={() => setAbierto((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "transparent", border: "none", cursor: "pointer", color: C.muted, textAlign: "left", fontFamily: "'Roboto', sans-serif" }}
      >
        {abierto ? <ChevronDown size={12} strokeWidth={1.8} /> : <ChevronRight size={12} strokeWidth={1.8} />}
        <span style={{ fontWeight: 700, color }}>{ok ? "Cocos coincide con Matriz" : `Cocos: ${comp.dif} ${comp.dif === 1 ? "papel no coincide" : "papeles no coinciden"} con Matriz`}</span>
        <span style={{ color: C.dim }}>
          · foto {hora} · tenencia al abrir vs extracto hasta el día anterior
          {ars != null ? ` · saldo $ CI ${fN(ars)}` : ""}{ars24 != null ? ` · 24hs ${fN(ars24)}` : ""}
        </span>
      </button>
      {abierto && (
        <div style={{ padding: "2px 12px 10px 32px" }}>
          <table style={{ borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }}>
            <thead>
              <tr style={{ color: C.dim, fontSize: 10 }}>
                <th style={{ textAlign: "left", padding: "3px 14px 3px 0", fontWeight: 600 }}>Papel</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Matriz</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Midas</th>
                <th style={{ textAlign: "right", padding: "3px 0 3px 14px", fontWeight: 600 }}>Diferencia</th>
              </tr>
            </thead>
            <tbody>
              {comp.filas.map((f) => (
                <tr key={f.tk} style={{ color: f.ok ? C.muted : C.text }}>
                  <td style={{ padding: "2px 14px 2px 0", fontWeight: 600 }}>{f.tk}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.b)}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.m)}</td>
                  <td style={{ textAlign: "right", padding: "2px 0 2px 14px", color: f.ok ? C.green : C.cat.amber, fontWeight: 700 }}>{f.ok ? "ok" : fN(f.m - f.b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 6, color: C.dim, fontSize: 10.5, fontFamily: "'Roboto', sans-serif", lineHeight: 1.5 }}>
            El extracto sigue siendo lo que manda. La foto se toma por la API de Primary cada 15 minutos de 10:00 a 12:45, y solo cuenta si Cocos ya cargó Matriz ese día. FCI y cauciones no están en Matriz.
          </div>
        </div>
      )}
    </div>
  );
}

function groupBroker(group) {''', '2/componente')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
