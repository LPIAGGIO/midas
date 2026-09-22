/**
 * Skill del bot de niveles (`niveles-auto`), que desde el 04/09/2026 opera la
 * cuenta IOL con plata real.
 *
 * TRES LIBROS EN LA MISMA TABLA, y confundirlos hace decir cualquier cosa:
 *   - `real`   -> plata de verdad. Toma solo algunas senales (tope por posicion).
 *   - `shadow` -> libro sombra: registra TODAS las senales como si se hubieran
 *                 tomado. Sirve para medir que cuesta la restriccion, NO para
 *                 sumarlo al resultado.
 *   - `paper`  -> el historial previo al pase a real. Historico, no vive.
 *
 * El P&L del shadow NO es comparable uno a uno contra el real: son distinta
 * cantidad de trades y distinto tamanio. Se muestran al lado, nunca sumados,
 * y el resumen dice explicitamente que miden cosas distintas.
 */

import { select } from "./supa.js";

const fmt0 = (n) => (n == null ? "s/d" : Math.round(n).toLocaleString("es-AR"));
const signo = (n) => (n == null ? "s/d" : (n >= 0 ? "+" : "") + fmt0(n));

function resumirLibro(trades) {
  const por = (s) => trades.filter((t) => t.status === s);
  const cerrados = por("closed");
  const abiertos = por("open");
  const pendientes = por("pending");
  const cancelados = por("cancelled");

  const realizado = cerrados.reduce((a, t) => a + (Number(t.pnl_ars) || 0), 0);
  // El no realizado solo cuenta sobre posiciones ABIERTAS. En las cerradas y
  // canceladas el campo queda con residuo y sumarlo infla el numero.
  const noRealizado = abiertos.reduce((a, t) => a + (Number(t.pnl_ars_abierto) || 0), 0);

  const ganadores = cerrados.filter((t) => (Number(t.pnl_ars) || 0) > 0).length;
  const marcados = abiertos.map((t) => t.marcado_at).filter(Boolean).sort();
  const fechas = trades.map((t) => t.created_at).filter(Boolean).sort();

  return {
    cerrados: cerrados.length,
    abiertos: abiertos.length,
    pendientes: pendientes.length,
    cancelados: cancelados.length,
    realizado,
    noRealizado,
    ganadores,
    aciertos: cerrados.length ? (ganadores / cerrados.length) * 100 : null,
    marcadoMasViejo: marcados[0] || null,
    tickersAbiertos: abiertos.map((t) => t.ticker),
    tickers: new Set(trades.map((t) => t.ticker)),
    desde: fechas[0]?.slice(0, 10) || null,
    hasta: fechas[fechas.length - 1]?.slice(0, 10) || null,
  };
}

/** "¿Como viene el bot?" */
export async function bot() {
  let trades;
  try {
    trades = await select("paper_iol_trades", {
      select: "ticker,status,modo,pnl_ars,pnl_ars_abierto,created_at,exit_ts,marcado_at",
      modo: "in.(real,shadow)",
      limit: "5000",
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err), resumen: "No pude leer los trades del bot." };
  }
  if (!trades.length) return { ok: false, resumen: "No hay trades cargados del bot." };

  const real = resumirLibro(trades.filter((t) => t.modo === "real"));
  const shadow = resumirLibro(trades.filter((t) => t.modo === "shadow"));

  // Cuanto cuesta la restriccion. OJO: el ratio crudo de trades mezcla dos
  // efectos distintos y decirlo suelto confunde -- medido el 21/09/2026, real
  // opera 16 tickers y sombra sigue 48, sobre la MISMA ventana. O sea que el
  // "3% de las senales" es en parte universo mas chico y en parte tope por
  // posicion. Se reportan los dos por separado.
  const tomadas = shadow.cerrados ? (real.cerrados / shadow.cerrados) * 100 : null;
  const universoPct = shadow.tickers.size ? (real.tickers.size / shadow.tickers.size) * 100 : null;
  const comunes = [...real.tickers].filter((t) => shadow.tickers.has(t));

  let resumen = `Plata real: ${real.cerrados} operaciones cerradas, ${signo(real.realizado)} ARS realizados`;
  if (real.aciertos != null) resumen += ` (${real.ganadores} de ${real.cerrados} en ganancia)`;
  resumen += ".";
  if (real.abiertos) resumen += ` ${real.abiertos} abierta${real.abiertos > 1 ? "s" : ""} (${real.tickersAbiertos.join(", ")}) con ${signo(real.noRealizado)} ARS sin realizar.`;
  if (real.pendientes) resumen += ` ${real.pendientes} orden${real.pendientes > 1 ? "es" : ""} pendiente${real.pendientes > 1 ? "s" : ""}.`;
  if (real.cancelados) resumen += ` ${real.cancelados} canceladas.`;

  resumen += ` En la misma ventana (${shadow.desde} a ${shadow.hasta}) el libro sombra, que anota todas las senales, lleva ${shadow.cerrados} cerradas con ${signo(shadow.realizado)} ARS.`;
  if (tomadas != null && universoPct != null) {
    resumen += ` La distancia entre los dos son dos cosas a la vez: en real se operan ${real.tickers.size} de los ${shadow.tickers.size} papeles que sigue el sombra (${universoPct.toFixed(0)}% del universo), y dentro de esos se toman menos entradas por el tope por posicion. El ${tomadas.toFixed(0)}% de trades no es "toma el ${tomadas.toFixed(0)}% de las senales".`;
  }
  resumen += " Los P&L no se suman ni se comparan uno a uno: distinto tamanio por operacion.";

  return {
    ok: true,
    real: { ...real, tickers: [...real.tickers] },
    shadow: { ...shadow, tickers: [...shadow.tickers] },
    tomadasPct: tomadas,
    universoPct,
    tickersComunes: comunes,
    resumen,
  };
}
