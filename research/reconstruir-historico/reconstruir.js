"use strict";
/* Reconstruye el HISTORICO de positions de Cocos desde libro_movimientos.
 *
 * Contexto (17/09/2026): un borrado en lote mio se llevo las filas derivadas
 * del Libro y con ellas el historico por instrumento (la pantalla P&L mostraba
 * "1 ops" en todo). El dato crudo quedo intacto: 914 filas en
 * libro_movimientos. Esto las vuelve a convertir en filas de positions.
 *
 * Diferencia con la derivacion del front (que quedo deshabilitada): despues de
 * generar el historico COMPARA los netos contra la foto real del broker y, si
 * no cuadran, inserta filas de AJUSTE (vencimientos/cobros que el libro no
 * netea). Asi la historia queda completa Y los netos correctos.
 *
 * Uso:
 *   node reconstruir.js            -> DRY RUN (no escribe nada)
 *   node reconstruir.js --aplicar  -> escribe
 */
require("dotenv").config();
globalThis.WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const U = "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const APLICAR = process.argv.includes("--aplicar");
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Foto del portfolio de Cocos del 17/09/2026 — la fuente de verdad de los netos.
const FOTO = {
  PBA27: 44521727, TXMJ9: 16797312, T30J7: 10452139,
  NU: 2000, JNJ: 500, UNH: 500, GLD: 514,
  GGAL: 1000, DLRNOV26: 500, WTINOV26: -44, GFGC7400OC: -6,
};
// Precio de referencia para las filas de ajuste (cobro al vencimiento / salida).
const PX_AJUSTE = {
  S30A6: 127.486, S29Y6: 129.51, T30J6: 143.28, T30A7: 129.65, T31Y7: 123.4, AO28: 145990,
  GFGC7400OC: 152.05,   // prima real de la venta de 12 del 16/09
  // WTI no pasa por la cuenta corriente de Cocos (opera por MTR y solo deja
  // Debito/Credito Cambio sin ticker): el promedio real de los 44 cortos se
  // perdio con las filas de la Matriz. 92,19 es el promedio medido sobre los
  // 35 que si teniamos — APROXIMACION, corregir cuando LP baje el
  // ReporteOperaciones con rango largo.
  WTINOV26: 92.19,
};

const CAT_POS = new Set(["trade_cedear", "trade_bono", "futuro", "opcion", "trade_otro"]);
const esCompra = (t) => /^compra/i.test(t || "");
const esVenta = (t) => /^venta/i.test(t || "");

function tipoInstrumento(cat, ticker, moneda) {
  if (cat === "trade_cedear") return "cedear";
  if (cat === "opcion") return "option";
  if (cat === "futuro") return "future";
  if (cat === "trade_bono") return String(moneda || "").toUpperCase().includes("USD") ? "bond_usd" : "bond_ars";
  return "stock";
}
// Multiplicador de contrato para futuros (WTI 10 barriles, ORO 1 onza, DLR 1000).
function futMult(tk) {
  const t = String(tk || "").toUpperCase();
  if (t.startsWith("WTI")) return 10;
  if (t.startsWith("ORO")) return 1;
  return 1000;
}

(async () => {
  let libro = [], from = 0;
  for (;;) {
    const { data, error } = await sb.from("libro_movimientos").select("*").eq("user_id", U).order("fecha_ejecucion").range(from, from + 999);
    if (error) throw new Error(error.message);
    libro = libro.concat(data || []);
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  console.log(`libro: ${libro.length} filas`);

  const filas = [];
  let salteadas = 0;
  for (const m of libro) {
    if (!CAT_POS.has(m.categoria)) continue;
    const tk = String(m.ticker || "").toUpperCase().trim();
    const qty = Math.abs(Number(m.cantidad) || 0);
    const px = Number(m.precio) || 0;
    if (!tk || qty === 0 || px === 0) { salteadas++; continue; }
    const compra = esCompra(m.tipo_operacion), venta = esVenta(m.tipo_operacion);
    if (!compra && !venta) { salteadas++; continue; }   // Credito/Debito Indice = caja, no operacion
    const it = tipoInstrumento(m.categoria, tk, m.moneda);
    filas.push({
      user_id: U, broker: "cocos", ticker: tk, instrument_type: it,
      operation_type: compra ? "buy" : "sell",
      quantity: qty, entry_price: px,
      entry_currency: String(m.moneda || "").toUpperCase().includes("USD") ? "USD-MEP" : "ARS",
      entry_date: String(m.fecha_ejecucion || "").slice(0, 10),
      settlement: (it === "future" || it === "fci") ? "CI" : "T1",
      extra: {
        source: "historico_libro",
        nro_comprobante: m.nro_comprobante || null,
        tipo_libro: m.tipo_operacion,
        ...(it === "future" ? { contract_size: futMult(tk) } : {}),
      },
    });
  }
  console.log(`operaciones reconstruidas: ${filas.length} (salteadas ${salteadas} por ser caja/ajuste)`);

  // Netos resultantes
  const net = {};
  for (const f of filas) {
    const q = f.quantity * (f.operation_type === "sell" ? -1 : 1);
    net[f.ticker] = (net[f.ticker] || 0) + q;
  }

  // Ajustes: lo que el libro no netea (vencimientos/cobros) vs la foto real.
  const ajustes = [];
  const tickers = new Set([...Object.keys(net), ...Object.keys(FOTO)]);
  console.log("\nTICKER · HISTORICO · FOTO · AJUSTE");
  for (const tk of [...tickers].sort()) {
    const h = Math.round((net[tk] || 0) * 100) / 100;
    const f = FOTO[tk] ?? 0;
    const dif = Math.round((f - h) * 100) / 100;
    if (Math.abs(dif) < 0.01) continue;
    console.log(`${tk.padEnd(12)} ${String(h).padStart(12)} ${String(f).padStart(12)} ${String(dif).padStart(12)}`);
    ajustes.push({
      user_id: U, broker: "cocos", ticker: tk,
      instrument_type: (filas.find((x) => x.ticker === tk) || {}).instrument_type || "bond_ars",
      operation_type: dif < 0 ? "sell" : "buy",
      quantity: Math.abs(dif),
      entry_price: PX_AJUSTE[tk] || (filas.filter((x) => x.ticker === tk).slice(-1)[0]?.entry_price) || 0,
      entry_currency: "ARS", entry_date: "2026-09-17", settlement: "T1",
      extra: { source: "ajuste_neteo", nota: "Ajuste 17/09: el libro no netea vencimientos/cobros. Cuadra el neto contra la foto real del broker." },
    });
  }
  if (!ajustes.length) console.log("(sin diferencias: el libro ya cuadra con la foto)");

  if (!APLICAR) {
    console.log(`\nDRY RUN — se insertarian ${filas.length} operaciones + ${ajustes.length} ajustes, y se retirarian las 10 filas de reconstruccion_foto_cocos.`);
    return;
  }

  // Aplicar: primero las historicas, despues los ajustes, y recien al final se
  // retiran las filas planas de la reconstruccion (para no quedar sin nada si algo falla).
  const todo = [...filas, ...ajustes];
  for (let k = 0; k < todo.length; k += 200) {
    const { error } = await sb.from("positions").insert(todo.slice(k, k + 200));
    if (error) throw new Error(`insert: ${error.message}`);
  }
  const { data: del } = await sb.from("positions").delete().eq("user_id", U).eq("broker", "cocos")
    .filter("extra->>source", "eq", "reconstruccion_foto_cocos").select("id");
  console.log(`\nAPLICADO: ${todo.length} filas insertadas · ${(del || []).length} filas planas retiradas`);

  // Verificacion final
  const { data: fin } = await sb.from("positions").select("ticker,quantity,operation_type").eq("user_id", U).eq("broker", "cocos");
  const nf = {};
  for (const r of fin || []) nf[r.ticker] = (nf[r.ticker] || 0) + (Number(r.quantity) || 0) * (r.operation_type === "sell" ? -1 : 1);
  let ok = true;
  for (const [tk, q] of Object.entries(FOTO)) {
    const m = Math.round((nf[tk] || 0) * 100) / 100;
    if (Math.abs(m - q) > 0.01) { console.log(`DESCUADRE ${tk}: midas ${m} vs foto ${q}`); ok = false; }
  }
  console.log(ok ? "VERIFICACION OK: todos los netos cuadran con la foto" : "VERIFICACION CON DESCUADRES (revisar arriba)");
})().catch((e) => { console.error("FALLO:", e.message); process.exit(1); });
