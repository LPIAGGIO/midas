/**
 * Skills de cartera y senales propias de LP.
 *
 * LA TRAMPA DE `positions`: guarda UNA FILA POR OPERACION, con el lado en
 * `operation_type` ('buy'/'sell') y `quantity` SIEMPRE positiva. No existen
 * cantidades negativas. Sumar `quantity` agrupando por ticker sobrestima
 * brutal: asi se reporto "MU 17.450" cuando el neto real era 2 (8.726 compras
 * contra 8.724 ventas). El neto es compras menos ventas, y un short aparece
 * como exceso de ventas, no como signo negativo.
 */

import { select, LP_USER_ID, esServiceKey } from "./supa.js";

const fmt = (n, d = 2) => (n == null ? "s/d" : n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmt0 = (n) => fmt(n, 0);

/**
 * Neto por ticker. El unico calculo correcto sobre `positions`.
 * `porBroker` separa Cocos de IOL: la tabla los mezcla, y sumarlos hace decir
 * cosas falsas. Ejemplo real (21/09/2026): JNJ da 520 neto, pero son 8 en IOL
 * (el test de momentum) y ~512 comprados en Cocos. Cruzar la senal de momentum
 * contra el total daba "tenes los 8" cuando en la cuenta del experimento no.
 */
function netear(filas, { porBroker = false } = {}) {
  const porTicker = new Map();
  for (const f of filas) {
    const k = porBroker ? `${f.broker || "s/b"}|${f.ticker}` : f.ticker;
    if (!porTicker.has(k)) {
      porTicker.set(k, { ticker: f.ticker, neto: 0, compras: 0, ventas: 0, tipo: f.instrument_type, broker: f.broker, precio: null, precioAt: null });
    }
    const p = porTicker.get(k);
    const q = Number(f.quantity) || 0;
    if (f.operation_type === "sell") { p.ventas += q; p.neto -= q; }
    else { p.compras += q; p.neto += q; }
    // Nos quedamos con el precio mas fresco que tenga alguna fila del ticker.
    if (f.current_price != null && (!p.precioAt || (f.current_price_updated_at || "") > p.precioAt)) {
      p.precio = Number(f.current_price);
      p.precioAt = f.current_price_updated_at || null;
    }
  }
  return [...porTicker.values()];
}

/**
 * Cartera neta de LP. `soloAbiertas` descarta los netos cero, que son la
 * mayoria de las filas historicas.
 */
export async function cartera({ soloAbiertas = true, userId = null, broker = null } = {}) {
  userId = userId || LP_USER_ID();
  let filas;
  try {
    filas = await select("positions", {
      select: "ticker,quantity,operation_type,instrument_type,broker,current_price,current_price_updated_at",
      user_id: `eq.${userId}`,
      ...(broker ? { broker: `eq.${broker}` } : {}),
      limit: "5000",
    });
  } catch (err) {
    return { ok: false, error: String(err.message || err), resumen: "No pude leer las posiciones." };
  }

  if (!filas.length) {
    const causa = esServiceKey()
      ? "No hay posiciones cargadas para ese usuario."
      : "Vino vacio. Con la clave anonima el RLS de duenio tapa `positions`: hace falta la service key.";
    return { ok: false, vacio: true, resumen: causa };
  }

  let items = netear(filas, { porBroker: !broker });
  const abiertas = items.filter((p) => Math.abs(p.neto) > 1e-9);
  if (soloAbiertas) items = abiertas;

  // `positions.current_price` viene vacio en la practica (verificado 21/09/2026:
  // los 17 netos abiertos, todos sin precio), asi que el precio real sale de
  // iol_quotes. Si tampoco esta ahi, la posicion queda SIN VALUAR a proposito:
  // es preferible decir "no se" a inventar un numero de plata.
  const faltantes = items.filter((p) => p.precio == null).map((p) => p.ticker);
  if (faltantes.length) {
    try {
      const quotes = await select("iol_quotes", {
        select: "ticker,last,updated_at",
        ticker: `in.(${faltantes.map((t) => `"${t}"`).join(",")})`,
      });
      const porTicker = new Map(quotes.map((q) => [q.ticker, q]));
      for (const p of items) {
        const q = porTicker.get(p.ticker);
        if (p.precio == null && q?.last != null) {
          p.precio = Number(q.last);
          p.precioAt = q.updated_at;
          p.precioFuente = "iol_quotes";
        }
      }
    } catch { /* si falla el cruce, quedan sin valuar y el resumen lo dice */ }
  }

  for (const p of items) {
    // Los bonos en pesos cotizan por cada 100 nominales: valuarlos por unidad
    // multiplica la tenencia por cien. El tipo en la tabla es `bond_ars`, no
    // `bond` — con el nombre mal, PBA27 daba 4.665 millones en vez de 46.
    p.escala = /^bond/.test(p.tipo || "") || p.tipo === "letra" ? 100 : 1;

    // Futuros y FCI NO se valuan con precio de pantalla: los futuros van por el
    // modelo de no-acreditado y los FCI por VCP proyectado. Multiplicar por un
    // last de iol_quotes seria inventar plata, asi que quedan sin valuar y el
    // resumen dice por que.
    p.valuaAparte = p.tipo === "future" || p.tipo === "fci" || p.tipo === "option";
    p.valuado = (!p.valuaAparte && p.precio != null) ? (p.neto * p.precio) / p.escala : null;
  }
  items.sort((a, b) => (b.valuado ?? -Infinity) - (a.valuado ?? -Infinity));

  const conPrecio = items.filter((p) => p.valuado != null);
  const total = conPrecio.reduce((a, p) => a + p.valuado, 0);
  const aparte = items.filter((p) => p.valuaAparte);
  const sinPrecio = items.filter((p) => p.valuado == null && !p.valuaAparte);
  const shorts = items.filter((p) => p.neto < 0);

  let resumen = `${abiertas.length} posiciones abiertas sobre ${filas.length} operaciones historicas.`;
  if (conPrecio.length) resumen += ` ${conPrecio.length} valuadas a precio de pantalla: ${fmt0(total)} ARS.`;
  if (aparte.length) resumen += ` Fuera de ese total, con modelo propio: ${aparte.map((p) => `${p.ticker} (${p.tipo})`).join(", ")}.`;
  if (sinPrecio.length) resumen += ` Sin precio: ${sinPrecio.map((p) => p.ticker).join(", ")}.`;
  if (shorts.length) resumen += ` En rojo (mas ventas que compras): ${shorts.map((p) => `${p.ticker} ${fmt(p.neto, 0)}`).join(", ")}.`;

  return { ok: true, total, items, aparte, operaciones: filas.length, resumen };
}

/**
 * La senal de momentum y como esta parada la cartera real contra ella.
 * `momentum_signal` la reescribe el worker paper-cedears en cada corrida; si
 * `as_of_date` tiene mas de 4 dias, la rotacion no opera y aca se avisa igual.
 */
export async function momentum({ userId = null } = {}) {
  userId = userId || LP_USER_ID();
  let señal;
  try {
    const filas = await select("momentum_signal", { select: "top8,ranking,as_of_date,updated_at", id: "eq.current", limit: "1" });
    señal = filas[0];
  } catch (err) {
    return { ok: false, error: String(err.message || err), resumen: "No pude leer la senal de momentum." };
  }
  if (!señal) return { ok: false, resumen: "No hay senal de momentum cargada." };

  const diasAtraso = Math.floor((Date.now() - new Date(señal.as_of_date).getTime()) / 864e5);
  const rancia = diasAtraso > 4;

  // SOLO IOL: el test A/B de momentum corre en esa cuenta. Contra la cartera
  // completa el cruce miente, porque los mismos tickers comprados en Cocos
  // hacen parecer que el experimento esta completo cuando no lo esta.
  const c = await cartera({ userId, broker: "iol" });
  let tengo = null, faltan = null, sobran = null;
  if (c.ok) {
    const netos = new Map(c.items.map((p) => [p.ticker, p.neto]));
    tengo = señal.top8.filter((t) => (netos.get(t) || 0) > 0);
    faltan = señal.top8.filter((t) => !((netos.get(t) || 0) > 0));
    const enTop = new Set(señal.top8);
    sobran = c.items.filter((p) => p.neto > 0 && !enTop.has(p.ticker) && p.tipo === "cedear").map((p) => p.ticker);
  }

  let resumen = `Top-8 de momentum al ${señal.as_of_date}: ${señal.top8.join(", ")}.`;
  if (rancia) resumen += ` OJO: la senal tiene ${diasAtraso} dias, arriba del corte de 4 con el que la rotacion se abstiene de operar.`;
  if (tengo) {
    resumen += ` En la cuenta IOL (donde corre el test) tenes ${tengo.length} de los 8.`;
    if (faltan.length) resumen += ` Te faltan: ${faltan.join(", ")}.`;
    if (sobran?.length) resumen += ` Tenes fuera del top: ${sobran.join(", ")}.`;
  } else {
    resumen += " No pude cruzarlo contra tu cartera.";
  }

  return {
    ok: true,
    top8: señal.top8,
    ranking: señal.ranking,
    asOf: señal.as_of_date,
    diasAtraso,
    rancia,
    tengo, faltan, sobran,
    resumen,
  };
}

/** Precio de un papel segun IOL. Para los papeles del bot, esta es la fuente. */
export async function precio(ticker) {
  const t = String(ticker || "").toUpperCase().trim();
  if (!/^[A-Z0-9.]{1,12}$/.test(t)) return { ok: false, resumen: "Ese ticker no es valido." };
  let filas;
  try {
    filas = await select("iol_quotes", { select: "ticker,last,prev_close,variacion,quote_date,source,updated_at", ticker: `eq.${t}`, limit: "1" });
  } catch (err) {
    return { ok: false, error: String(err.message || err), resumen: `No pude traer el precio de ${t}.` };
  }
  const q = filas[0];
  if (!q) return { ok: false, resumen: `No tengo ${t} en iol_quotes. Los tickers ahi son los que sigue el bot.` };

  const minutos = Math.round((Date.now() - new Date(q.updated_at).getTime()) / 60000);
  const frescura = minutos < 90 ? `hace ${minutos} min` : `del ${new Date(q.updated_at).toISOString().slice(0, 16).replace("T", " ")}`;
  const v = q.variacion == null ? "" : ` (${q.variacion >= 0 ? "+" : ""}${fmt(q.variacion, 1)}%)`;
  return { ok: true, ...q, minutos, resumen: `${t} ${fmt(q.last)}${v}, dato ${frescura}. Fuente: ${q.source || "IOL"}.` };
}
