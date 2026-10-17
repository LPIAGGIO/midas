"""Pagina las tres lecturas del panel admin de un usuario.

Leian positions, cash_movements y libro_movimientos con .limit(1000) ordenado
de la mas nueva a la mas vieja: PostgREST corta en 1.000 filas y LP ya tiene
1.068 posiciones, asi que la lista escondia las mas viejas sin avisar.
Se pasa a fondosPaginar con el id como desempate (el orden por fecha sola no
es estable entre paginas). Se conserva el .eq("user_id", ...) y que un error
deje la lista vacia, como antes.
"""
from pathlib import Path

RUTA = Path(__file__).resolve().parents[2] / "src" / "MidasTerminal.jsx"

CAMBIOS = [
    (
        """    const [p, c, l] = await Promise.all([
      supabase.from("positions").select("id,ticker,instrument_type,operation_type,quantity,entry_price,entry_date,broker").eq("user_id", user.id).order("entry_date", { ascending: false }).limit(1000),
      supabase.from("cash_movements").select("id,movement_date,movement_type,currency,amount,notes").eq("user_id", user.id).order("movement_date", { ascending: false }).limit(1000),
      supabase.from("libro_movimientos").select("id,fecha_ejecucion,tipo_operacion,ticker,comision,ddmm,iva,total").eq("user_id", user.id).order("fecha_ejecucion", { ascending: false }).limit(1000),
    ]);
    setPos(p.data || []); setCash(c.data || []); setLibro(l.data || []);""",
        """    // Paginado: PostgREST corta en 1.000 filas y la lista escondia las mas
    // viejas sin avisar. El id desempata para que el orden sea estable entre paginas.
    const todo = (armar) => fondosPaginar(armar).catch(() => []);
    const [p, c, l] = await Promise.all([
      todo(() => supabase.from("positions").select("id,ticker,instrument_type,operation_type,quantity,entry_price,entry_date,broker").eq("user_id", user.id).order("entry_date", { ascending: false }).order("id", { ascending: false })),
      todo(() => supabase.from("cash_movements").select("id,movement_date,movement_type,currency,amount,notes").eq("user_id", user.id).order("movement_date", { ascending: false }).order("id", { ascending: false })),
      todo(() => supabase.from("libro_movimientos").select("id,fecha_ejecucion,tipo_operacion,ticker,comision,ddmm,iva,total").eq("user_id", user.id).order("fecha_ejecucion", { ascending: false }).order("id", { ascending: false })),
    ]);
    setPos(p); setCash(c); setLibro(l);""",
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
