"""Fondos: inversos y apalancados en el cruce (17/10/2026).

- Con pesos negativos (SH, PSQ) el orden por peso dejaba arriba los más
  chicos: se ordena por valor absoluto.
- Frase del apalancado sin doble paréntesis; "1 papel" en singular.
"""
import pathlib, sys

RAIZ = pathlib.Path(__file__).resolve().parents[2]
ARCHIVOS = [RAIZ / "src" / "MidasTerminal.jsx", pathlib.Path(__file__).with_name("fondos_module.jsx")]

CAMBIOS = [
    ('''    }).filter((x) => x.base > 0).sort((a, b) => b.peso - a.peso);''',
     '''    }).filter((x) => x.base > 0).sort((a, b) => Math.abs(b.peso) - Math.abs(a.peso));'''),
    ('''va a papeles que ya tenés{factor > 1 ? ` (con el apalancamiento ${factor}x)` : ""}''',
     '''va a papeles que ya tenés{factor > 1 ? ` contando el apalancamiento ${factor}x` : ""}'''),
    ('''{completa ? ` · ${fdNum(hold.length)} papeles` : ""}''',
     '''{completa ? ` · ${fdNum(hold.length)} ${hold.length === 1 ? "papel" : "papeles"}` : ""}'''),
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
