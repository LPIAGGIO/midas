"""Pantalla Fondos (Fase 1): módulo, entrada en Analizadores, ruta e ícono.

Falla sin escribir nada si un ancla no aparece exactamente una vez.
El módulo vive en research/fase2/fondos_module.jsx y se inserta antes de
SuperinversoresModule (usa sus helpers de fecha y el badge de atraso).
"""
import pathlib, sys

RAIZ = pathlib.Path(__file__).resolve().parents[2]
SRC = RAIZ / "src" / "MidasTerminal.jsx"
MOD = pathlib.Path(__file__).with_name("fondos_module.jsx")

s = SRC.read_text(encoding="utf-8")
modulo = MOD.read_text(encoding="utf-8")

if "function FondosModule()" in s:
    sys.exit("ya aplicado")

CAMBIOS = [
    ("  Bot,\n} from \"lucide-react\";", "  Bot,\n  PieChart,\n} from \"lucide-react\";"),
    ('      { id: "fundamentals-cedears", label: "Fundamentals CEDEARs", icon: Building2 },\n',
     '      { id: "fundamentals-cedears", label: "Fundamentals CEDEARs", icon: Building2 },\n'
     '      { id: "fondos", label: "Fondos", icon: PieChart },\n'),
    ('            ) : active === "superinversores" ? (\n',
     '            ) : active === "fondos" ? (\n'
     '              <FondosModule key={active} />\n'
     '            ) : active === "superinversores" ? (\n'),
    ("function SuperinversoresModule() {\n", modulo + "function SuperinversoresModule() {\n"),
]

for viejo, nuevo in CAMBIOS:
    n = s.count(viejo)
    if n != 1:
        sys.exit(f"ancla encontrada {n} veces: {viejo[:70]!r}")
for viejo, nuevo in CAMBIOS:
    s = s.replace(viejo, nuevo, 1)

SRC.write_bytes(s.encode("utf-8"))  # LF como en el repo (write_text en Windows pasa a CRLF)
print("ok: FondosModule insertado")
