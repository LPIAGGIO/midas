"""Pagina las lecturas de positions que netean CEDEAR+acciones por ticker.

PostgREST corta toda consulta en 1.000 filas aunque se pida mas, sin error.
LP tiene 785 filas cedear+stock al 17/10/2026 y suben todos los dias con los
bots de Cocos: pasado el tope, la tenencia neteada sale falsa (como el YPFD
fantasma del libro el 02/10).

  1. SuperinversoresModule, solapa "Mi cartera": .limit(5000) -> fondosPaginar.
  2. Briefs de tickers (ticker_brief + posiciones abiertas): sin limit, mismo
     tope de 1.000 -> fondosPaginar.

Las dos mantienen .eq("user_id", ...): LP es admin y la policy
admin_all_positions devuelve las de todos sin ese filtro.
"""
from pathlib import Path

RUTA = Path(__file__).resolve().parents[2] / "src" / "MidasTerminal.jsx"

CAMBIOS = [
    (
        """      const { data: d, error: e } = await supabase
        .from("positions")
        .select("ticker,instrument_type,operation_type,quantity")
        .eq("user_id", user.id)
        .in("instrument_type", ["cedear", "stock"])
        .limit(5000);
      if (!vivo) return;""",
        """      // Paginado: PostgREST corta en 1.000 filas aunque se pida mas y el neteo
      // por ticker saldria falso sin avisar.
      let d = null, e = null;
      try {
        d = await fondosPaginar(() => supabase
          .from("positions")
          .select("ticker,instrument_type,operation_type,quantity")
          .eq("user_id", user.id)
          .in("instrument_type", ["cedear", "stock"])
          .order("id", { ascending: true }));
      } catch (err) { e = err; }
      if (!vivo) return;""",
    ),
    (
        """        supabase.from("positions").select("ticker,operation_type,quantity,instrument_type,broker").in("instrument_type", ["cedear", "stock"]).neq("broker", "iol").eq("user_id", user.id),""",
        """        // Paginado: sin esto PostgREST corta en 1.000 filas y el neteo miente.
        fondosPaginar(() => supabase.from("positions").select("ticker,operation_type,quantity,instrument_type,broker").in("instrument_type", ["cedear", "stock"]).neq("broker", "iol").eq("user_id", user.id).order("id", { ascending: true }))
          .then((data) => ({ data }), () => ({ data: null })),""",
    ),
]


def main():
    src = RUTA.read_bytes().decode("utf-8")
    for viejo, nuevo in CAMBIOS:
        n = src.count(viejo)
        if n != 1:
            raise SystemExit(f"ancla aparece {n} veces (se esperaba 1):\n{viejo[:120]}")
        src = src.replace(viejo, nuevo)
    RUTA.write_bytes(src.encode("utf-8"))
    print(f"ok: {len(CAMBIOS)} cambios en {RUTA.name}")


if __name__ == "__main__":
    main()
