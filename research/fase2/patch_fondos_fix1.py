"""Fondos, ajustes de la primera prueba con datos reales (17/10/2026).

1. El sector de los papeles que solo están en una grilla (LLY con la
   entrada apoyada y tenencia 0) no se buscaba: valores_maestro se pedía
   solo con los tickers de positions.
2. "Ya tenés" y el cruce "de hoy" contaban papeles con grilla armada pero
   sin tenencia (LLY). Ahora "hoy" usa solo lo que se tiene; "al techo"
   sigue incluyendo esas grillas.
3. Textos: espacio antes del paréntesis y "1 pago".

Se aplica a src/MidasTerminal.jsx y a research/fase2/fondos_module.jsx (la
fuente del módulo). Falla sin escribir si un ancla no aparece una vez.
"""
import pathlib, sys

RAIZ = pathlib.Path(__file__).resolve().parents[2]
ARCHIVOS = [RAIZ / "src" / "MidasTerminal.jsx", pathlib.Path(__file__).with_name("fondos_module.jsx")]

CAMBIOS = [
    ('''        const tickers = [...new Set(pos.map((p) => String(p.ticker || "").toUpperCase()).filter(Boolean))];''',
     '''        const tickers = [...new Set([...pos, ...(grillas || [])].map((p) => String(p.ticker || "").toUpperCase()).filter(Boolean))];'''),
    ('''    if (!base || !cartera || !cartera.filas.length) { setSolapa(null); return () => { ok = false; }; }
    (async () => {
      try {
        const emis = [...new Set(cartera.filas.map((f) => f.emisor6).filter(Boolean))];
        const tks = cartera.filas.map((f) => f.ticker);''',
     '''    const hoy = cartera ? { filas: cartera.filas.filter((f) => f.q > 0) } : null; // "ya tenés" = tenencia de hoy
    if (!base || !hoy || !hoy.filas.length) { setSolapa(null); return () => { ok = false; }; }
    (async () => {
      try {
        const emis = [...new Set(hoy.filas.map((f) => f.emisor6).filter(Boolean))];
        const tks = hoy.filas.map((f) => f.ticker);'''),
    ('''        const fechas = new Map(base.fondos.map((f) => [f.ticker, f.holdings_fecha]));
        const match = fondosMatcher(cartera);''',
     '''        const fechas = new Map(base.fondos.map((f) => [f.ticker, f.holdings_fecha]));
        const match = fondosMatcher(hoy);'''),
    ('''    if (!base) return [];
    const match = fondosMatcher(cartera);''',
     '''    if (!base) return [];
    const match = fondosMatcher(cartera ? { filas: cartera.filas.filter((c) => c.q > 0) } : null);'''),
    ('''      return { t, peso, c, base, agrega, comb: (base + agrega) / (totBase + montoN || 1), antes: base / (totBase || 1) };
    }).sort((a, b) => b.peso - a.peso);''',
     '''      return { t, peso, c, base, agrega, comb: (base + agrega) / (totBase + montoN || 1), antes: base / (totBase || 1) };
    }).filter((x) => x.base > 0).sort((a, b) => b.peso - a.peso);'''),
    ('''va a papeles que ya tenés{factor > 1 ? ` (con el apalancamiento ${factor}x)` : ""}
                  ({fdUsd(montoN * cruce.pesoYa)} de {fdUsd(montoN)}).''',
     '''va a papeles que ya tenés{factor > 1 ? ` (con el apalancamiento ${factor}x)` : ""}
                  {" "}({fdUsd(montoN * cruce.pesoYa)} de {fdUsd(montoN)}).'''),
    ('''`${(f.dividendos || []).length} pagos · ''',
     '''`${(f.dividendos || []).length} ${(f.dividendos || []).length === 1 ? "pago" : "pagos"} · '''),
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
