/* futures-cash — ajuste diario de futuros a la caja, como lo hace Cocos.
 *
 * Corre una vez por noche (cron, ~23:30 ART) y hace dos cosas:
 *   1. Captura el settlement del dia desde mtr_market_data (snapshot live del
 *      worker matbarofex, segmento rx_DDF) hacia futures_settlements_history —
 *      la tabla live pisa el valor cada rueda, sin esto la historia se pierde.
 *   2. Por cada usuario cocos CON caja mantenida y posicion neta de futuros,
 *      inserta el Credito/Debito Indice del dia en cash_movements.
 *
 * Formula validada contra el extracto real de Cocos (31/08/2026, -502.500
 * exacto con 391 viejos + 59 comprados en el dia):
 *   ajuste = (S_hoy - S_ayer) x neto_previo x mult
 *          + sum sobre trades de hoy: (S_hoy - precio) x qty_firmada x mult
 *
 * Idempotente via source_ref 'idx-<ticker>-<fecha>-<user>': correr dos veces
 * no duplica. Y es PROVISORIO a proposito: el importador del Libro borra toda
 * la caja del usuario y la reconstruye desde la cuenta corriente (que ya trae
 * estos indices en su total), asi que cualquier error de aca se pisa al dia
 * siguiente con el dato oficial.
 *
 * Guarda de alcance: usuarios sin movimientos de caja cocos se saltean — una
 * caja que nadie mantiene no mejora con una fila suelta de indice. */
require("dotenv").config();
// Node 20 del VPS no trae WebSocket nativo y supabase-js v2 lo exige al
// construir el cliente (aunque aca no usemos realtime) — mismo polyfill que
// futures-settlement/backfill_settles.js.
global.WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const MULT = { DLR: 1000 }; // ARS por punto por contrato; extender si aparecen otros productos
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const hoyBA = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const multDe = (ticker) => { for (const k of Object.keys(MULT)) if (ticker.startsWith(k)) return MULT[k]; return null; };

async function capturarSettles(hoy) {
  const { data: live } = await supabase.from("mtr_market_data")
    .select("symbol,settlement,settlement_ts").eq("segment", "rx_DDF").not("settlement", "is", null);
  const filas = (live || [])
    .filter((r) => r.settlement_ts && String(r.settlement_ts).slice(0, 10) === hoy && Number(r.settlement) > 0)
    .map((r) => ({ ticker: r.symbol.replace(/\//g, ""), settle_date: hoy, settlement: Number(r.settlement) }));
  if (!filas.length) { log("sin settles fechados hoy en mtr_market_data (feriado o worker matbarofex caido)"); return 0; }
  const { error } = await supabase.from("futures_settlements_history")
    .upsert(filas, { onConflict: "ticker,settle_date" });
  if (error) throw new Error("upsert history: " + error.message);
  log(`settles capturados: ${filas.map((f) => `${f.ticker}=${f.settlement}`).join(", ")}`);
  return filas.length;
}

async function ajustesDelDia(hoy) {
  const { data: pos } = await supabase.from("positions")
    .select("user_id,ticker,operation_type,quantity,entry_price,entry_date")
    .eq("instrument_type", "future").eq("broker", "cocos");
  if (!pos?.length) return;

  // settle de hoy y el habil anterior, por ticker
  const tickers = [...new Set(pos.map((p) => p.ticker))];
  const { data: hist } = await supabase.from("futures_settlements_history")
    .select("ticker,settle_date,settlement").in("ticker", tickers)
    .lte("settle_date", hoy).order("settle_date", { ascending: false });
  const settles = {};
  for (const h of hist || []) {
    const s = (settles[h.ticker] = settles[h.ticker] || []);
    if (s.length < 2 && !s.find((x) => x.settle_date === h.settle_date)) s.push(h);
  }

  const porUser = {};
  for (const p of pos) (porUser[p.user_id] = porUser[p.user_id] || []).push(p);

  for (const [uid, filas] of Object.entries(porUser)) {
    const { count } = await supabase.from("cash_movements")
      .select("id", { count: "exact", head: true }).eq("user_id", uid).eq("broker", "cocos");
    if (!count) { log(`user ${uid.slice(0, 8)}: sin caja mantenida, salteado`); continue; }

    const porTicker = {};
    for (const p of filas) (porTicker[p.ticker] = porTicker[p.ticker] || []).push(p);

    for (const [tk, ops] of Object.entries(porTicker)) {
      const mult = multDe(tk);
      if (!mult) { log(`user ${uid.slice(0, 8)} ${tk}: sin multiplicador conocido, salteado`); continue; }
      const s = settles[tk] || [];
      if (s.length < 2 || s[0].settle_date !== hoy) {
        log(`user ${uid.slice(0, 8)} ${tk}: sin settle de hoy o sin previo (${s.map((x) => x.settle_date).join(",")})`);
        continue;
      }
      const [sHoy, sPrev] = [Number(s[0].settlement), Number(s[1].settlement)];
      let netoPrevio = 0, ajusteHoy = 0, netoTotal = 0;
      for (const p of ops) {
        const q = (p.operation_type === "sell" ? -1 : 1) * Number(p.quantity);
        netoTotal += q;
        if (p.entry_date === hoy) ajusteHoy += (sHoy - Number(p.entry_price)) * q * mult;
        else netoPrevio += q;
      }
      if (netoTotal === 0 && netoPrevio === 0) continue;
      const ajuste = Math.round(((sHoy - sPrev) * netoPrevio * mult + ajusteHoy) * 100) / 100;
      if (Math.abs(ajuste) < 0.005) { log(`user ${uid.slice(0, 8)} ${tk}: ajuste 0 (settle sin cambio)`); continue; }

      const ref = `idx-${tk}-${hoy}-${uid.slice(0, 8)}`;
      const { data: ya } = await supabase.from("cash_movements")
        .select("id").eq("user_id", uid).eq("source_ref", ref).maybeSingle();
      if (ya) { log(`user ${uid.slice(0, 8)} ${tk}: ya cargado (${ref})`); continue; }

      const { error } = await supabase.from("cash_movements").insert({
        user_id: uid, movement_date: hoy,
        movement_type: ajuste >= 0 ? "deposit" : "withdrawal",
        currency: "ARS", amount: Math.abs(ajuste), broker: "cocos",
        notes: `${ajuste >= 0 ? "Credito" : "Debito"} indice ${tk} (settle ${sPrev} -> ${sHoy}, neto ${netoTotal})`,
        source_ref: ref,
      });
      if (error) { log(`user ${uid.slice(0, 8)} ${tk}: ERROR insert: ${error.message}`); continue; }
      log(`user ${uid.slice(0, 8)} ${tk}: ${ajuste >= 0 ? "credito" : "debito"} indice ${ajuste.toLocaleString("es-AR")} (neto ${netoTotal}, previo ${netoPrevio})`);
    }
  }
}

(async () => {
  const hoy = hoyBA();
  const dow = new Date(hoy + "T12:00:00Z").getUTCDay();
  if (dow === 0 || dow === 6) { log("fin de semana, nada que hacer"); return; }
  await capturarSettles(hoy);
  await ajustesDelDia(hoy);
  log("listo");
})().catch((e) => { log("FATAL", e.message); process.exit(1); });
