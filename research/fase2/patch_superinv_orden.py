# -*- coding: utf-8 -*-
# Superinversores > Mi cartera: orden por default de más a menos gestores y
# encabezados que ordenan (LP 17/10/2026: "ponele que pueda ordenar por otra
# cosa. y que por default este de mas gestor a menor").
# Falla sin escribir nada si un ancla no aparece exactamente una vez.
import io, sys
P = 'src/MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
cambios = [
    ("  const [pos, setPos] = useState(null);\n",
     "  const [pos, setPos] = useState(null);\n"
     "  const [ordCartera, setOrdCartera] = useState({ col: \"gestores\", dir: -1 });   // Mi cartera: columna y sentido\n"),
    ("    // Ascendente por cantidad de gestores: arriba quedan los papeles donde\n"
     "    // estás solo, que son los que hay que mirar de verdad.\n"
     "    filas.sort((a, b) => a.nGestores - b.nGestores || (a.ticker < b.ticker ? -1 : 1));\n",
     "    filas.sort((a, b) => b.nGestores - a.nGestores || (a.ticker < b.ticker ? -1 : 1));\n"),
    ("  const gestoresOrd = useMemo(() => {\n",
     "  // Mi cartera ordenada por la columna elegida (default: más gestores arriba).\n"
     "  const carteraOrd = useMemo(() => {\n"
     "    if (!cartera) return cartera;\n"
     "    const { col, dir } = ordCartera;\n"
     "    const topPct = (f) => (f.top.length ? Math.max(...f.top.map((t) => Number(t.pct) || 0)) : 0);\n"
     "    const val = (f) => (col === \"papel\" ? f.ticker : col === \"cantidad\" ? Math.abs(f.cantidad) : col === \"tenedores\" ? topPct(f) : f.nGestores);\n"
     "    return [...cartera].sort((a, b) => {\n"
     "      const x = val(a), y = val(b);\n"
     "      const c = typeof x === \"string\" ? (x < y ? -1 : x > y ? 1 : 0) : x - y;\n"
     "      return c * dir || (a.ticker < b.ticker ? -1 : 1);\n"
     "    });\n"
     "  }, [cartera, ordCartera]);\n\n"
     "  const gestoresOrd = useMemo(() => {\n"),
    ("  const th = { padding: \"8px 12px\", fontSize: 10.5, fontWeight: 500, color: C.dim, letterSpacing: \"0.08em\", textTransform: \"uppercase\", whiteSpace: \"nowrap\", textAlign: \"right\" };\n"
     "  const thL = { ...th, textAlign: \"left\" };\n",
     "  const th = { padding: \"8px 12px\", fontSize: 10.5, fontWeight: 500, color: C.dim, letterSpacing: \"0.08em\", textTransform: \"uppercase\", whiteSpace: \"nowrap\", textAlign: \"right\" };\n"
     "  const thL = { ...th, textAlign: \"left\" };\n"
     "  // Encabezado que ordena Mi cartera: el primer toque va al sentido natural (papel A→Z, números de mayor a menor), el segundo lo invierte.\n"
     "  const thOrd = (col, label, base) => {\n"
     "    const on = ordCartera.col === col;\n"
     "    return (\n"
     "      <th\n"
     "        style={{ ...base, cursor: \"pointer\", userSelect: \"none\", color: on ? C.text : base.color }}\n"
     "        title=\"Ordenar\"\n"
     "        onClick={() => setOrdCartera((o) => ({ col, dir: o.col === col ? -o.dir : col === \"papel\" ? 1 : -1 }))}\n"
     "      >\n"
     "        {label}{on ? (ordCartera.dir > 0 ? \" \\u2191\" : \" \\u2193\") : \"\"}\n"
     "      </th>\n"
     "    );\n"
     "  };\n"),
    ("                Tus papeles ordenados de <b style={{ color: C.text }}>menos a más acompañados</b>: arriba quedan los que\n"
     "                no aparecen en ningún 13F del panel. Estar solo no significa estar equivocado — significa que la tesis\n"
     "                es tuya y la tenés que sostener sin ayuda.\n",
     "                Tus papeles con <b style={{ color: C.text }}>cuántos gestores del panel los tienen</b> (de más a menos;\n"
     "                tocá un encabezado para ordenar por otra cosa). Estar solo no significa estar equivocado — significa que la\n"
     "                tesis es tuya y la tenés que sostener sin ayuda.\n"),
    ("                        <th style={thL}>Papel</th>\n"
     "                        <th style={th}>Cantidad</th>\n"
     "                        <th style={th}>Gestores</th>\n"
     "                        <th style={{ ...th, textAlign: \"left\" }}>Veredicto</th>\n"
     "                        <th style={{ ...th, textAlign: \"left\" }}>Principales tenedores</th>\n",
     "                        {thOrd(\"papel\", \"Papel\", thL)}\n"
     "                        {thOrd(\"cantidad\", \"Cantidad\", th)}\n"
     "                        {thOrd(\"gestores\", \"Gestores\", th)}\n"
     "                        <th style={{ ...th, textAlign: \"left\" }}>Veredicto</th>\n"
     "                        {thOrd(\"tenedores\", \"Principales tenedores\", { ...th, textAlign: \"left\" })}\n"),
    ("                    <tbody>\n"
     "                      {cartera.map((f) => (\n"
     "                        <tr key={f.ticker} style={{ borderTop: `1px solid ${C.border}`, verticalAlign: \"top\" }}>\n",
     "                    <tbody>\n"
     "                      {carteraOrd.map((f) => (\n"
     "                        <tr key={f.ticker} style={{ borderTop: `1px solid ${C.border}`, verticalAlign: \"top\" }}>\n"),
]
for a, b in cambios:
    n = s.count(a)
    if n != 1:
        sys.exit('ancla %d veces: %r' % (n, a[:80]))
    s = s.replace(a, b)
io.open(P, 'w', encoding='utf-8', newline='').write(s)
print('ok', len(cambios), 'cambios')
