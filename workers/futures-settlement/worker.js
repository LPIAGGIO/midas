"use strict";

/* ---------------------------------------------------------------
 * Worker: futures-settlement
 *
 * Corre 1x/dia (PM2 cron_restart 01:00 ART). Hace dos cosas:
 *
 *   1) CAPTURA el settlement oficial del ultimo dia habil para cada
 *      ticker de futuro que tenga algun usuario en `positions`, y lo
 *      guarda en `futures_settlements_history`.
 *
 *   2) GENERA las filas `pending` en `futures_daily_adjustments` -
 *      un ajuste MTM por posicion x dia habil. Esto es lo que antes
 *      hacia el frontend (`generateMissingAdjustments`); ahora corre
 *      server-side a la 1am, sin depender de que el usuario abra la app.
 *
 * El usuario despues confirma cada ajuste a mano en Midas (puede
 * editar el monto si Cocos le liquido algo distinto) -> eso crea el
 * cash_movement. La confirmacion NO la hace este worker.
 *
 * Fuente del settlement: la tabla `mtr_market_data` de Supabase, poblada
 * por el worker `mtr-market-data` que mantiene un WS abierto contra el
 * visor A3 de matbarofex (PRODUCCION).
 *
 * REFACTORIZADO 2026-05-28: antes pegaba a /api/primary-md de Vercel, que
 * consultaba reMarkets (sandbox). Resultado: settlements del demo, no de
 * produccion. Ese era el origen del freshness=stale que se reportaba desde
 * 23/05. Ahora lee directo de la fuente real, sin pasar por el endpoint.
 *
 * Idempotente: se puede correr N veces sin romper nada (upserts).
 * --------------------------------------------------------------- */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// supabase-js construye internamente un cliente Realtime que en Node < 22
// necesita un WebSocket global (Node 22+ lo trae nativo; este VPS corre
// Node 20). El worker NO usa Realtime -solo REST- pero createClient lo
// inicializa igual, asi que le damos el polyfill `ws` para que no falle.
if (typeof globalThis.WebSocket === "undefined") {
  globalThis.WebSocket = require("ws");
}

// --------------- Config ---------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FUTURE_MULTIPLIER_DEFAULT = 1000;

// Modo prueba: con `node worker.js --dry-run` hace todas las consultas
// (Supabase + Primary) y calcula todo, pero NO escribe nada en la base.
const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[futures-settlement] FATAL: falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// --------------- Logging ---------------
function log(level, msg, extra) {
  const ts = new Date().toISOString();
  const tail = extra !== undefined ? " " + JSON.stringify(extra) : "";
  console.log(`[${ts}] [${level}] ${msg}${tail}`);
}
const info = (m, e) => log("INFO", m, e);
const warn = (m, e) => log("WARN", m, e);
const err = (m, e) => log("ERROR", m, e);

// --------------- Calendario de feriados ---------------
// Porteado de EcoFlowTerminal.jsx (BYMA_HOLIDAYS). Mantener en sync.
// IMPORTANTE: agregar los feriados 2027 antes de fin de 2026.
const BYMA_HOLIDAYS = new Set([
  // 2025
  "2025-01-01", "2025-03-03", "2025-03-04", "2025-03-24", "2025-04-02",
  "2025-04-17", "2025-04-18", "2025-05-01", "2025-06-16", "2025-06-20",
  "2025-07-09", "2025-08-15", "2025-11-21", "2025-11-24", "2025-12-08",
  "2025-12-25",
  // 2026
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-23", "2026-03-24",
  "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-25", "2026-06-15",
  "2026-07-09", "2026-07-10", "2026-08-17", "2026-10-12", "2026-11-06",
  "2026-12-07", "2026-12-08", "2026-12-24", "2026-12-25", "2026-12-31",
]);

// true si la fecha (YYYY-MM-DD) es sabado, domingo o feriado bursatil.
// Usamos T12:00:00Z (mediodia UTC) para que getUTCDay() sea estable
// sin importar la timezone del VPS.
function isNonBusinessDay(iso) {
  if (BYMA_HOLIDAYS.has(iso)) return true;
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return dow === 0 || dow === 6;
}

// Fecha de hoy en Argentina, formato YYYY-MM-DD.
function todayAR() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

// Ultimo dia habil ESTRICTAMENTE anterior a `iso`.
function lastBusinessDayBefore(iso) {
  const d = new Date(iso + "T12:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() - 1);
  } while (isNonBusinessDay(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}

// --------------- Fetch del settlement (Supabase: mtr_market_data) ---------------
//
// Lee el settlement actual desde la tabla `mtr_market_data`, que el worker
// `mtr-market-data` mantiene actualizada via WS al visor de produccion.
//
// Validacion de fecha: chequea que `settlement_ts` de la tabla coincida con
// `expectedSettleDate` (la fecha que el worker calculo via lastBusinessDayBefore).
// Si no coincide -> freshness="stale" -> captureSettlements va a saltear ese
// ticker con warning, en vez de etiquetar mal el settle. Esto pasa, por
// ejemplo, si se corre el worker manualmente despues del cierre de un dia
// habil pero antes del cron de la 1 AM (la tabla ya tiene el settle "nuevo"
// pero settleDate sigue siendo el del dia anterior).
//
// Devuelve: { TICKER_UPPER: { settlement, freshness, actualSettleDate } }
async function fetchSettlements(tickers, expectedSettleDate) {
  // Map ticker app ("DLRMAY26") -> security_id ("rx_DDF_DLR_MAY26").
  const securityIds = [];
  const appToSec = {};
  for (const t of tickers) {
    const m = (t || "").toUpperCase().trim().match(/^(DLR)([A-Z]{3})(\d{2})$/);
    if (!m) {
      warn(`Ticker no mapeable a security_id: ${t}`);
      continue;
    }
    const secId = `rx_DDF_DLR_${m[2]}${m[3]}`;
    securityIds.push(secId);
    appToSec[t.toUpperCase().trim()] = secId;
  }
  if (securityIds.length === 0) return {};

  const { data, error } = await supabase
    .from("mtr_market_data")
    .select("security_id, settlement, settlement_ts")
    .in("security_id", securityIds);
  if (error) throw new Error(`leyendo mtr_market_data: ${error.message}`);

  const bySecId = {};
  for (const row of data || []) bySecId[row.security_id] = row;

  const out = {};
  for (const t of tickers) {
    const key = t.toUpperCase().trim();
    const secId = appToSec[key];
    if (!secId) {
      out[key] = { settlement: null, freshness: "none", actualSettleDate: null };
      continue;
    }
    const row = bySecId[secId];
    if (!row || row.settlement == null || !row.settlement_ts) {
      out[key] = { settlement: null, freshness: "none", actualSettleDate: null };
      continue;
    }
    // settlement_ts es timestamptz (ej "2026-05-27T00:00:00+00"). Slice a fecha.
    const actualDate = new Date(row.settlement_ts).toISOString().slice(0, 10);
    out[key] = {
      settlement: Number(row.settlement),
      freshness: actualDate === expectedSettleDate ? "fresh" : "stale",
      actualSettleDate: actualDate,
    };
  }
  return out;
}

// --------------- Paso 1: capturar settlements ---------------
async function captureSettlements(tickers, settleDate) {
  const feed = await fetchSettlements(tickers, settleDate);
  const rows = [];
  for (const t of tickers) {
    const entry = feed[t];
    if (!entry || entry.settlement == null) {
      warn(`Sin settlement para ${t} en mtr_market_data - se omite la captura`);
      continue;
    }
    if (entry.freshness !== "fresh") {
      // La tabla tiene un settle pero su fecha (actualSettleDate) no es la
      // que esperamos (settleDate). No lo escribimos: etiquetarlo con la
      // fecha equivocada generaria datos sucios. Probable causa: worker
      // corrido a deshora, o feed retrasado.
      warn(
        `${t}: settlement_ts (${entry.actualSettleDate}) != settleDate esperado (${settleDate}) -> se omite. ` +
        `¿Worker corriendo a deshora o feed atrasado?`
      );
      continue;
    }
    info(`${t}: settlement=${entry.settlement} (freshness=${entry.freshness}) -> ${settleDate}`);
    rows.push({
      ticker: t,
      settle_date: settleDate,
      settlement: entry.settlement,
      captured_at: new Date().toISOString(),
    });
  }
  if (rows.length === 0) {
    warn("Ningun settlement capturado.");
    return 0;
  }
  if (DRY_RUN) {
    info(`[DRY-RUN] Se guardarian ${rows.length} settlement(s) - no se escribe nada.`);
    return rows.length;
  }
  const { error } = await supabase
    .from("futures_settlements_history")
    .upsert(rows, { onConflict: "ticker,settle_date" });
  if (error) throw new Error(`upsert futures_settlements_history: ${error.message}`);
  info(`${rows.length} settlement(s) guardados/actualizados para ${settleDate}.`);
  return rows.length;
}

// --------------- Paso 2: generar ajustes pendientes ---------------
async function generateAdjustments(positions, endSettleDate) {
  // Agrupar por (user_id, ticker). ANTES era solo por ticker, lo que mezclaba
  // posiciones de distintos usuarios en un mismo grupo -> el adjustment se
  // atribuia al user_id del lote mas viejo (anchor) y el net_qty incluia qty
  // de otros usuarios. Resultado: cash mezclado entre cuentas.
  // FIX 2026-05-28: cada usuario tiene su propio grupo por ticker.
  const groups = {};
  for (const p of positions) {
    const ticker = (p.ticker || "").toUpperCase().trim();
    if (!ticker) continue;
    if (!p.user_id) {
      warn(`Posicion sin user_id - se omite: ticker=${ticker}, id=${p.id}`);
      continue;
    }
    const key = `${p.user_id}__${ticker}`;
    if (!groups[key]) groups[key] = { userId: p.user_id, ticker, ops: [], netQty: 0 };
    const sign = p.operation_type === "sell" ? -1 : 1;
    groups[key].netQty += sign * (Number(p.quantity) || 0);
    groups[key].ops.push(p);
  }
  const openGroups = Object.values(groups).filter((g) => g.netQty !== 0);
  // Grupos CERRADOS (round-trips: la cantidad neta volvio a 0). No tienen
  // ajuste MTM diario abierto, pero su P&L realizado igual debe acreditarse.
  const closedGroups = Object.values(groups).filter(
    (g) => g.netQty === 0 && g.ops.length > 0
  );
  if (openGroups.length === 0 && closedGroups.length === 0) {
    info("No hay grupos de futuros. Sin ajustes.");
    return 0;
  }

  // Traer todos los settlements de esos tickers (incluye el recien capturado).
  // Dedupear: ahora pueden haber multiples grupos con el mismo ticker (uno
  // por usuario que opere ese ticker).
  const tickerList = Array.from(new Set([...openGroups, ...closedGroups].map((g) => g.ticker)));
  const { data: settles, error: sErr } = await supabase
    .from("futures_settlements_history")
    .select("ticker, settle_date, settlement")
    .in("ticker", tickerList)
    .order("settle_date", { ascending: true });
  if (sErr) throw new Error(`leyendo settlements: ${sErr.message}`);
  const settlesByTicker = {};
  for (const s of settles || []) {
    (settlesByTicker[s.ticker] = settlesByTicker[s.ticker] || []).push(s);
  }

  // Traer ajustes ya existentes por (user_id, ticker). Sirve para DOS cosas:
  //  (1) existingSet: clave (user, ticker, dia) para no regenerar ni duplicar.
  //      ANTES la clave era (position_id, dia), donde position_id = "anchor"
  //      (lote mas viejo). Ese anchor es INESTABLE: si el lote mas viejo se
  //      cierra o cambia, cambia el position_id y se generaba una SEGUNDA fila
  //      para el mismo (ticker, dia) -> duplicados (posible doble caja). La
  //      clave (user, ticker, dia) es estable e idempotente de raiz.
  //  (2) lastAdjByUserTicker: corte de migracion por (user_id, ticker) (solo
  //      generamos fechas posteriores; las viejas quedan intactas).
  const { data: tickerAdj, error: taErr } = await supabase
    .from("futures_daily_adjustments")
    .select("user_id, ticker, adjustment_date")
    .in("ticker", tickerList);
  if (taErr) throw new Error(`leyendo ajustes existentes: ${taErr.message}`);
  const existingSet = new Set(
    (tickerAdj || []).map((r) => `${r.user_id}__${r.ticker}__${r.adjustment_date}`)
  );
  const lastAdjByUserTicker = {};
  for (const r of tickerAdj || []) {
    const k = `${r.user_id}__${r.ticker}`;
    if (!lastAdjByUserTicker[k] || r.adjustment_date > lastAdjByUserTicker[k]) {
      lastAdjByUserTicker[k] = r.adjustment_date;
    }
  }

  const rows = [];
  // ---- Ajustes de futuros ABIERTOS, CONSOLIDADOS POR (TICKER, DIA) ----
  // Para cada (ticker, dia habil) generamos UNA fila que consolida el
  // MTM de TODOS los lots vivos del ticker ese dia. Esto matchea lo que
  // Cocos efectivamente acredita al cliente (un solo asiento por contrato
  // cerrado el mes, no N asientos diarios por lot).
  //
  // Calculo:
  //   - Para cada lot vivo el dia D:
  //       base_lot = entry_price si entry_date == D
  //                  settle del dia habil anterior en otro caso
  //       ajuste_lot = (curr_settle_D - base_lot) * sign_lot * qty_lot * multiplier
  //   - ajuste_total_D = sum sobre lots vivos de ajuste_lot
  //   - net_qty_D     = sum (sign_lot * qty_lot)
  //   - prev_settle_D = sum (base_lot * sign_lot * qty_lot) / net_qty_D
  //         (avg ponderado de bases por signed qty; cuando se inserta en
  //          la formula (curr - prev) * net_qty * multiplier reproduce
  //          exactamente la suma por lot; verificado matematicamente)
  //   - position_id   = anchor del grupo (lot mas viejo del ticker, con
  //                     desempate por id para que sea estable entre
  //                     corridas e idempotente con el UPSERT)
  //
  // MIGRACION: respeta el corte por (user_id, ticker) (lastAdjByUserTicker). Las filas
  // viejas generadas con el modelo lot-por-lot quedan intactas; el
  // modelo nuevo solo aplica a fechas posteriores al corte.
  for (const g of openGroups) {
    const tickerSettles = (settlesByTicker[g.ticker] || [])
      .slice()
      .sort((a, b) => (a.settle_date < b.settle_date ? -1 : 1));
    if (tickerSettles.length === 0) {
      warn(`${g.ticker}: sin settlements en historico - no se generan ajustes (falta backfill?)`);
      continue;
    }

    // Lots normalizados: fecha, precio, qty, sign. Filtramos los invalidos.
    const lots = g.ops
      .map((op) => ({
        id: op.id,
        userId: op.user_id,
        entryDate: op.entry_date || (op.created_at || "").slice(0, 10) || "",
        entryPrice: Number(op.entry_price) || 0,
        qty: Number(op.quantity) || 0,
        sign: op.operation_type === "sell" ? -1 : 1,
      }))
      .filter((L) => L.entryDate && L.qty > 0);
    if (lots.length === 0) {
      warn(`${g.ticker}: lotes sin fecha/cantidad valida - se omite`);
      continue;
    }

    // Anchor del ticker: lote mas viejo, desempate por id. Estable entre
    // corridas porque no depende del dia que estamos procesando.
    const anchor = lots.reduce((a, b) => {
      if (a.entryDate !== b.entryDate) return a.entryDate <= b.entryDate ? a : b;
      return String(a.id) <= String(b.id) ? a : b;
    });
    const anchorUserId = anchor.userId;

    // Corte de migracion para este (user_id, ticker).
    const cutover = lastAdjByUserTicker[`${g.userId}__${g.ticker}`] || null;

    // Settles que aplican: dentro del rango (anchor.entryDate, endSettleDate]
    // y posteriores al corte de migracion.
    const candidateSettles = tickerSettles.filter(
      (s) =>
        s.settle_date >= anchor.entryDate &&
        s.settle_date <= endSettleDate &&
        (!cutover || s.settle_date > cutover)
    );

    for (const sRow of candidateSettles) {
      const adjDate = sRow.settle_date;
      if (isNonBusinessDay(adjDate)) continue;
      if (existingSet.has(`${g.userId}__${g.ticker}__${adjDate}`)) continue;

      const currSettle = Number(sRow.settlement);
      if (!Number.isFinite(currSettle)) continue;

      // prev_settle oficial: el settle del dia habil anterior a adjDate.
      const prevRow = tickerSettles
        .filter((s) => s.settle_date < adjDate)
        .slice(-1)[0];
      const prevOfficial = prevRow ? Number(prevRow.settlement) : null;

      // Lots vivos en adjDate: aquellos que entraron en o antes de esa fecha.
      const aliveLots = lots.filter((L) => L.entryDate <= adjDate);
      if (aliveLots.length === 0) continue;

      // Calcular ajuste consolidado: por lot, sumar (curr - base_lot) * sign * qty.
      let totalEstimated = 0;
      let totalSignedQty = 0;
      let baseWeightedSum = 0; // para avg ponderado
      let validLotCount = 0;
      for (const L of aliveLots) {
        let baseLot;
        if (L.entryDate === adjDate) {
          baseLot = L.entryPrice;
        } else if (Number.isFinite(prevOfficial)) {
          baseLot = prevOfficial;
        } else {
          // sin settle previo oficial y el lot no entro ese dia -> raro,
          // probablemente primer dia con activity en el ticker. Skip lot.
          warn(`${g.ticker} ${adjDate}: lot ${L.id} sin base resolvible - se omite del consolidado`);
          continue;
        }
        const signedQty = L.sign * L.qty;
        const ajusteLot = (currSettle - baseLot) * signedQty * FUTURE_MULTIPLIER_DEFAULT;
        totalEstimated += ajusteLot;
        totalSignedQty += signedQty;
        baseWeightedSum += baseLot * signedQty;
        validLotCount++;
      }
      if (validLotCount === 0) continue;

      // Posicion NETEADA EN CERO sin movimiento: round-trip cerrado en dias
      // anteriores (ambas patas con base = settle previo -> estimado exacto 0).
      // Generar la fila solo mete ruido en el modal de acreditacion ("0 x 1000,
      // estimado +0") — caso real LP 12/06: SEP26 cerrado el 08/06 seguia
      // generando filas vacias el 09 y el 10. Un round-trip cerrado HOY si
      // pasa (totalSignedQty 0 pero estimado != 0 = realizado intradia).
      if (totalSignedQty === 0 && Math.abs(totalEstimated) < 1) continue;

      // avg ponderado de bases. Si totalSignedQty == 0 (round-trip que neteo
      // ese mismo dia, edge), no hay un display sensato; usamos prevOfficial
      // o currSettle como fallback.
      let prevSettleDisplay;
      if (totalSignedQty !== 0) {
        prevSettleDisplay = baseWeightedSum / totalSignedQty;
      } else {
        prevSettleDisplay = Number.isFinite(prevOfficial) ? prevOfficial : currSettle;
      }

      rows.push({
        user_id: anchorUserId,
        position_id: anchor.id,
        ticker: g.ticker,
        adjustment_date: adjDate,
        prev_settle: prevSettleDisplay,
        curr_settle: currSettle,
        net_qty: totalSignedQty,
        multiplier: FUTURE_MULTIPLIER_DEFAULT,
        estimated_amount: totalEstimated,
        is_estimated: false,
        status: "pending",
      });
    }
  }

  // ---- Ajustes de posiciones CERRADAS (round-trips) ----
  // Un futuro que se abrio y cerro no tiene ajuste MTM diario, pero su
  // P&L realizado SI debe acreditarse. Generamos UN ajuste pendiente por
  // el resultado del round-trip: mismo flujo que los abiertos -- queda
  // pending y el usuario lo confirma (eso crea el cash_movement).
  //
  // Acotado a cierres RECIENTES (ultimos CLOSED_LOOKBACK_DAYS dias) para
  // no generar de golpe un backlog de cierres viejos la primera vez.
  const CLOSED_LOOKBACK_DAYS = 7;
  const lookbackFloorD = new Date(endSettleDate + "T12:00:00Z");
  lookbackFloorD.setUTCDate(lookbackFloorD.getUTCDate() - CLOSED_LOOKBACK_DAYS);
  const lookbackFloor = lookbackFloorD.toISOString().slice(0, 10);

  for (const g of closedGroups) {
    const dOf = (o) => o.entry_date || (o.created_at || "").slice(0, 10) || "";
    // Op de cierre = la mas reciente; anchor = la mas vieja (define el
    // position_id, mismo criterio que los grupos abiertos).
    const closeOp = g.ops.reduce((a, b) => (dOf(a) >= dOf(b) ? a : b));
    // anchor = op mas vieja; con fechas empatadas desempata por id para
    // que el position_id sea estable entre corridas (no duplicar ajustes).
    const anchorOp = g.ops.reduce((a, b) => {
      const da = dOf(a), db = dOf(b);
      if (da !== db) return da <= db ? a : b;
      return String(a.id) <= String(b.id) ? a : b;
    });
    const closeDate = dOf(closeOp);
    if (!closeDate) {
      warn(`${g.ticker}: round-trip cerrado sin fecha - se omite`);
      continue;
    }
    if (closeDate < lookbackFloor || closeDate > endSettleDate) continue;
    // Corte de reconciliacion (mismo criterio que los abiertos): si ya hay un
    // ajuste para este (user,ticker) en o despues del cierre, el realizado ya
    // fue contado -> no regenerar. Sin esto, una reimportacion de posiciones
    // (que borra los adjustments viejos pero deja vivo su cash_movement)
    // regeneraba el realizado de cierres recientes -> doble caja al confirmar.
    const cutoverC = lastAdjByUserTicker[`${g.userId}__${g.ticker}`] || null;
    if (cutoverC && closeDate <= cutoverC) continue;
    if (existingSet.has(`${g.userId}__${g.ticker}__${closeDate}`)) continue;

    // P&L realizado = (suma vendido - suma comprado) x multiplicador. Para
    // un round-trip esto es exacto, no depende de settlements intermedios.
    let buyNotional = 0, buyQty = 0, sellNotional = 0, sellQty = 0;
    for (const op of g.ops) {
      const px = Number(op.entry_price) || 0;
      const qty = Number(op.quantity) || 0;
      if (op.operation_type === "sell") { sellNotional += px * qty; sellQty += qty; }
      else { buyNotional += px * qty; buyQty += qty; }
    }
    if (buyQty <= 0 || sellQty <= 0) {
      warn(`${g.ticker}: round-trip sin ambos lados (buy/sell) - se omite`);
      continue;
    }
    const multiplier = FUTURE_MULTIPLIER_DEFAULT;
    const realized = (sellNotional - buyNotional) * multiplier;
    const avgBuy = buyNotional / buyQty;
    const avgSell = sellNotional / sellQty;

    rows.push({
      user_id: anchorOp.user_id,
      position_id: anchorOp.id,
      ticker: g.ticker,
      adjustment_date: closeDate,
      prev_settle: avgBuy,
      curr_settle: avgSell,
      net_qty: buyQty,
      multiplier,
      estimated_amount: realized,
      is_estimated: false,
      status: "pending",
    });
    info(`Round-trip cerrado ${g.ticker} ${closeDate}: ` +
         `${avgBuy} -> ${avgSell} x ${buyQty} x ${multiplier} = ${realized}`);
  }

  if (rows.length === 0) {
    info("No hay ajustes nuevos para generar.");
    return 0;
  }

  // Consolidar a UNA fila por (user_id, ticker, adjustment_date). Un cierre
  // PARCIAL el mismo dia produce dos rows: el MTM de lo que queda abierto (loop
  // de abiertos, va primero) + el realizado del round-trip cerrado. Cocos los
  // acredita JUNTOS ese dia, asi que sumamos el cash (estimated_amount) y el
  // net_qty; prev/curr_settle y position_id quedan del primero (el MTM abierto).
  // Sin esto, con la clave nueva (user,ticker,dia) las dos filas colisionarian
  // y se perderia una en el UPSERT.
  const mergedByKey = new Map();
  for (const r of rows) {
    const k = `${r.user_id}__${r.ticker}__${r.adjustment_date}`;
    const ex = mergedByKey.get(k);
    if (!ex) { mergedByKey.set(k, { ...r }); continue; }
    ex.estimated_amount += r.estimated_amount;
    ex.net_qty += r.net_qty;
  }
  const mergedRows = Array.from(mergedByKey.values());

  for (const r of mergedRows) {
    info(`Ajuste ${r.ticker} ${r.adjustment_date}: ${r.prev_settle} -> ${r.curr_settle}` +
         ` x ${r.net_qty} x ${r.multiplier} = ${r.estimated_amount}`);
  }

  if (DRY_RUN) {
    info(`[DRY-RUN] Se insertarian ${mergedRows.length} ajuste(s) pendiente(s) - no se escribe nada.`);
    return mergedRows.length;
  }

  // ignoreDuplicates: si la fila (user_id, ticker, adjustment_date) ya existe
  // - pending O confirmada - NO la tocamos. Nunca pisamos una confirmacion.
  const { error: insErr } = await supabase
    .from("futures_daily_adjustments")
    .upsert(mergedRows, { onConflict: "user_id,ticker,adjustment_date", ignoreDuplicates: true });
  if (insErr) throw new Error(`insertando ajustes: ${insErr.message}`);
  info(`${mergedRows.length} ajuste(s) pendiente(s) generados.`);
  return mergedRows.length;
}

// --------------- Main ---------------
async function main() {
  const today = todayAR();
  const settleDate = lastBusinessDayBefore(today);
  info(`Inicio - hoy(AR)=${today}, settle objetivo=${settleDate} (fuente: mtr_market_data)`);
  if (DRY_RUN) info("Modo DRY-RUN activo - no se escribira nada en la base.");

  // Posiciones de futuros de TODOS los usuarios.
  const { data: positions, error: posErr } = await supabase
    .from("positions")
    .select("id, user_id, ticker, instrument_type, operation_type, quantity, entry_price, entry_date, created_at")
    .eq("instrument_type", "future");
  if (posErr) throw new Error(`leyendo positions: ${posErr.message}`);

  if (!positions || positions.length === 0) {
    info("No hay posiciones de futuros. Nada que hacer.");
    return;
  }

  const tickers = Array.from(
    new Set(positions.map((p) => (p.ticker || "").toUpperCase().trim()).filter(Boolean))
  );
  info(`${positions.length} posicion(es) de futuros, ${tickers.length} ticker(s): ${tickers.join(", ")}`);

  await captureSettlements(tickers, settleDate);
  await generateAdjustments(positions, settleDate);

  info("Fin OK.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    err(`Worker abortado: ${e.message}`, { stack: e.stack });
    process.exit(1);
  });
