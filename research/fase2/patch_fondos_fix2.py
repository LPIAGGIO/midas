"""Fondos, vista "con las grillas al techo" (17/10/2026).

- La columna "De eso, grillas" mostraba "—" para una grilla sin tenencia
  (LLY): al techo tiene que mostrar el techo de la grilla.
- La marca "ya tenés" de la composición sigue la vista (de hoy: solo lo que
  se tiene; al techo: también las grillas armadas).
- Rótulos del cuadro de sectores y de la frase según la vista.
"""
import pathlib, sys

RAIZ = pathlib.Path(__file__).resolve().parents[2]
ARCHIVOS = [RAIZ / "src" / "MidasTerminal.jsx", pathlib.Path(__file__).with_name("fondos_module.jsx")]

CAMBIOS = [
    ('''<td style={{ ...tdr, color: C.muted }}>{x.c?.qGrilla ? fdUsd(vista === "hoy" ? x.c.grillaUsd : (x.c.techoUsd - (x.c.hoyUsd - x.c.grillaUsd))) : "—"}</td>''',
     '''<td style={{ ...tdr, color: C.muted }}>{vista === "hoy" ? (x.c?.qGrilla ? fdUsd(x.c.grillaUsd) : "—") : (x.c?.cuentas ? fdUsd(x.c.techoUsd - Math.max(0, (x.c.hoyUsd || 0) - (x.c.grillaUsd || 0))) : "—")}</td>'''),
    ('''                {composicion.slice(0, 10).map((h, i) => {
                  const mio = match(h);''',
     '''                {composicion.slice(0, 10).map((h, i) => {
                  const t = match(h);
                  const mio = t && (vista === "techo" || cartera?.porTicker.get(t)?.q > 0);'''),
    ('''{["Sector", `En ${f.ticker}`, "Tu cartera hoy", "Después"].map(''',
     '''{["Sector", `En ${f.ticker}`, vista === "hoy" ? "Tu cartera hoy" : "Tu cartera al techo", "Después"].map('''),
    ('''{cruce.filas[0].c?.cuentas ? <>, y ya está en {cruce.filas[0].c.cuentas === 1 ? "una grilla" : `las ${cruce.filas[0].c.cuentas} grillas`}</> : null}.</> : null}''',
     '''{cruce.filas[0].c?.cuentas ? <>, y {cruce.filas[0].c.qGrilla > 0 ? "ya está en" : "tiene grilla armada en"} {cruce.filas[0].c.cuentas === 1 ? "una cuenta" : `las ${cruce.filas[0].c.cuentas} cuentas`} de Cocos</> : null}.</> : null}'''),
]

textos = {}
for p in ARCHIVOS:
    s = p.read_text(encoding="utf-8")
    for viejo, _ in CAMBIOS:
        n = s.count(viejo)
        if n != 1:
            sys.exit(f"{p.name}: ancla encontrada {n} veces: {viejo[:80]!r}")
    for viejo, nuevo in CAMBIOS:
        s = s.replace(viejo, nuevo, 1)
    textos[p] = s
for p, s in textos.items():
    p.write_bytes(s.encode("utf-8"))
print("ok")
