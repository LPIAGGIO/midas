# -*- coding: utf-8 -*-
# El libro de Cocos pasó las 1.000 filas el 02/10/2026 (1.011) y Supabase
# devuelve como máximo 1.000 por consulta: al re-derivar las posiciones se
# perdían 11 movimientos al azar (6 de YPFD y 5 de GGAL). Resultado: 5.250
# YPFD fantasma, porque las ventas que cerraban la posición quedaron afuera.
# Toda lectura COMPLETA del libro pasa a paginar de a 1.000.
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''function useLibroMovimientos() {''',
'''// Lee TODAS las filas del libro de un usuario, paginando de a 1.000 (el tope
// por consulta de Supabase). 02/10/2026: con 1.011 filas una lectura simple
// devolvía 1.000 y la derivación armaba 5.250 YPFD fantasma (las ventas que
// cerraban la posición habían quedado afuera). El orden por nro_comprobante
// es estable, así que ninguna fila se repite ni se saltea entre páginas.
async function leerLibroCompleto(userId, columnas = "*") {
  const todas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase.from("libro_movimientos").select(columnas)
      .eq("user_id", userId).order("nro_comprobante", { ascending: true }).range(desde, desde + 999);
    if (error) return { data: null, error };
    todas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return { data: todas, error: null };
}

function useLibroMovimientos() {''', 'helper')

sub('''      const { data, error } = await supabase
        .from("libro_movimientos")
        .select("*")
        .eq("user_id", user.id)
        .order("fecha_ejecucion", { ascending: false })
        .order("nro_comprobante", { ascending: false });
      if (!cancel) { setRows(error ? [] : (data || [])); setLoading(false); }''',
'''      const { data, error } = await leerLibroCompleto(user.id);
      // Mismo orden que antes: más nuevo primero, por fecha y comprobante.
      const ord = (data || []).slice().sort((a, b) =>
        (a.fecha_ejecucion < b.fecha_ejecucion ? 1 : a.fecha_ejecucion > b.fecha_ejecucion ? -1 : 0) ||
        String(b.nro_comprobante).localeCompare(String(a.nro_comprobante), undefined, { numeric: true }));
      if (!cancel) { setRows(error ? [] : ord); setLoading(false); }''', 'hook')

sub('''    const { data: fresh } = await supabase.from("libro_movimientos").select("*").eq("user_id", user.id);
    const derived = deriveFromLedger(fresh || []);''',
'''    const { data: fresh, error: errLibro } = await leerLibroCompleto(user.id);
    // Sin el libro entero NO se deriva: una lectura a medias fabrica tenencias.
    if (errLibro || !fresh) { setImporting(false); setResult({ err: `No pude leer el libro completo: ${errLibro?.message || "sin datos"}` }); return; }
    const derived = deriveFromLedger(fresh);''', 'derivacion')

sub('''    supabase.from("libro_movimientos").select("comision,ddmm,iva,monto_bruto,categoria").eq("user_id", user.id).limit(8000)
      .then(({ data }) => {''',
'''    leerLibroCompleto(user.id, "nro_comprobante,comision,ddmm,iva,monto_bruto,categoria")
      .then(({ data }) => {''', 'tarifa')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
