/* Backfill de una sola vez del histórico de settlements de DLR.
 *
 * El worker futures-settlement solo captura los tickers que HOY tiene alguien
 * abierto, así que los vencimientos ya expirados (JUN26, JUL26, AGO26, SEP26…)
 * nunca entraron a futures_settlements_history, y encima el pedido de un rango
 * largo se le trunca en 500 registros. Sin ese histórico no se puede valuar una
 * posición de futuros en una fecha pasada.
 *
 * Corre dentro de ~/workers/futures-settlement para tomar su .env y su
 * node_modules. Es idempotente: upsert por (ticker, settle_date).
 *
 * Dos trampas de la API: mezcla opciones con futuros (optionType != null) y
 * nombra los contratos DLR082026, mientras que Midas los llama DLRAGO26. */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Mismo polyfill que worker.js: el VPS corre Node 20 y createClient inicializa
// un cliente Realtime que necesita un WebSocket global aunque acá solo se use REST.
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = require("ws");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const API = "https://apicem.matbarofex.com.ar/api/v2/closing-prices";
const MESES = ["ENE", "FEB", "MAR", "ABR", "MAY", "JUN", "JUL", "AGO", "SEP", "OCT", "NOV", "DIC"];
const DESDE = process.argv[2] || "2026-04-15";
const HASTA = process.argv[3] || new Date().toISOString().slice(0, 10);
const DRY = process.argv.includes("--dry-run");

function tramos(desde, hasta) {
  const out = [];
  const cur = new Date(desde + "T12:00:00"), fin = new Date(hasta + "T12:00:00");
  while (cur <= fin) {
    const a = cur.toISOString().slice(0, 10);
    cur.setDate(cur.getDate() + 20);
    out.push([a, (cur > fin ? fin : cur).toISOString().slice(0, 10)]);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

(async () => {
  const filas = new Map();
  for (const [a, b] of tramos(DESDE, HASTA)) {
    const r = await fetch(`${API}?product=DLR&from=${a}&to=${b}&pageSize=5000`);
    if (!r.ok) { console.error(`  HTTP ${r.status} en ${a}..${b}`); continue; }
    const j = await r.json();
    const data = Array.isArray(j.data) ? j.data : [];
    if (data.length >= 5000) console.error(`  OJO: ${a}..${b} llego al tope, puede estar truncado`);
    let n = 0;
    for (const x of data) {
      if (x.optionType != null) continue;
      const m = String(x.symbol || "").match(/^DLR(\d{2})(\d{4})$/);
      if (!m) continue;
      const mes = MESES[Number(m[1]) - 1];
      const settle = Number(x.settlement);
      const fecha = String(x.dateTime || "").slice(0, 10);
      if (!mes || !Number.isFinite(settle) || settle <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) continue;
      filas.set(`DLR${mes}${m[2].slice(2)}|${fecha}`, settle);
      n++;
    }
    console.error(`  ${a} -> ${b}: ${data.length} registros, ${n} settles`);
  }
  const rows = [...filas.entries()].map(([k, v]) => {
    const [ticker, settle_date] = k.split("|");
    return { ticker, settle_date, settlement: v };
  }).sort((x, y) => x.settle_date.localeCompare(y.settle_date));
  console.error(`\n${rows.length} settles en ${new Set(rows.map((r) => r.ticker)).size} tickers`);
  if (DRY) { console.error("DRY-RUN: no se escribe nada."); return; }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase.from("futures_settlements_history")
      .upsert(chunk, { onConflict: "ticker,settle_date" });
    if (error) { console.error("ERROR upsert:", error.message); process.exit(1); }
    console.error(`  escritos ${i + chunk.length}/${rows.length}`);
  }
  console.error("listo.");
})();
