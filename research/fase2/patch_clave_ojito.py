# -*- coding: utf-8 -*-
# Ojito para ver la clave al conectar brokers (LP 15/10/2026: "un ojito para que
# se saquen los * por si tipean mal"). A Pablo le bloquearon el usuario de Cocos
# y varios intentos con una clave mal tipeada bloquean el usuario en el broker.
# Campo reutilizable ClaveInput en las tres claves: Matriz y las dos de IOL.
import io, sys
p = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(p, encoding='utf-8').read()
def sub(a, b, et, n=1):
    global s
    k = s.count(a)
    if k != n:
        print('%s: ancla %d veces (esperaba %d), no escribo nada' % (et, k, n)); sys.exit(1)
    s = s.replace(a, b)

sub('''// Texto que deja cocos-sync cuando una cuenta con clave no tiene comitente.''',
'''/* Campo de clave con ojito: muestra lo tipeado para revisarlo antes de mandar.
 * Varios intentos con una clave mal escrita bloquean el usuario en el broker. */
function ClaveInput({ style, ...props }) {
  const [ver, setVer] = useState(false);
  const { width, ...resto } = style || {};
  return (
    <div style={{ position: "relative", width: width || "100%" }}>
      <input {...props} type={ver ? "text" : "password"} style={{ ...resto, width: "100%", paddingRight: 30, boxSizing: "border-box" }} />
      <button type="button" onClick={() => setVer((v) => !v)} title={ver ? "Ocultar la clave" : "Mostrar la clave para revisarla"} aria-label={ver ? "Ocultar la clave" : "Mostrar la clave"}
        style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", padding: 2, cursor: "pointer", color: C.muted, display: "flex", alignItems: "center" }}>
        {ver ? <EyeOff size={14} strokeWidth={1.7} /> : <Eye size={14} strokeWidth={1.7} />}
      </button>
    </div>
  );
}

// Texto que deja cocos-sync cuando una cuenta con clave no tiene comitente.''', 'componente')

sub('''          <input placeholder="Clave de Matriz" type="password" value={c.clave || ""}''',
'''          <ClaveInput placeholder="Clave de Matriz" value={c.clave || ""}''', 'matriz')
sub('''        <input placeholder="Clave de IOL" type="password" value={password}''',
'''        <ClaveInput placeholder="Clave de IOL" value={password}''', 'iol inline')
sub('''          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoComplete="current-password"''',
'''          <ClaveInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            autoComplete="current-password"''', 'iol modal')

io.open(p, 'w', encoding='utf-8').write(s); print('ok')
