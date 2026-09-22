/**
 * Fuentes de mercado GLOBAL (commodities e indices del exterior).
 *
 * OJO CON LA REGLA: para todo lo del bot IOL (precios de sus papeles, saldos,
 * variaciones, ordenes) se consulta IOL, nunca esto. Aca solo vive lo que IOL
 * no tiene: WTI, Brent, Nikkei, Hang Seng, Shanghai.
 *
 * EL BUG DE YAHOO, medido el 21/09/2026: `chartPreviousClose` es el primer
 * cierre DEL RANGO pedido, no el cierre anterior al ultimo dato. Con range=10d
 * devolvia 102,48 (cierre del 10/09, once dias antes) mientras el cierre real
 * previo era 100,30 -> la variacion salia -9,4% en vez de -7,5%. Es el mismo
 * error que inflo "SNDK +11,9%" cuando era +1,1%. Aca se calcula contra el
 * ultimo cierre diario no nulo anterior al dato actual, y se expone la fecha
 * de ese cierre para que el numero tenga duenio.
 */

const UA = { "User-Agent": "Mozilla/5.0" };
const TIMEOUT_MS = 12000;

/** Lo que miramos cuando LP pregunta "como viene Asia" o "cuanto esta el WTI". */
export const GLOBAL = {
  WTI: { sym: "CL=F", nombre: "WTI", grupo: "energia" },
  BRENT: { sym: "BZ=F", nombre: "Brent", grupo: "energia" },
  NIKKEI: { sym: "^N225", nombre: "Nikkei 225", grupo: "asia" },
  HANGSENG: { sym: "^HSI", nombre: "Hang Seng", grupo: "asia" },
  SHANGHAI: { sym: "000001.SS", nombre: "Shanghai Composite", grupo: "asia" },
};

async function yahooChart(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=10d`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const r = j?.chart?.result?.[0];
    if (!r) throw new Error("respuesta sin datos");
    return r;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Precio + variacion honesta de un simbolo global.
 * La variacion se calcula contra el ultimo cierre diario anterior, NUNCA contra
 * chartPreviousClose (ver el comentario de arriba).
 */
export async function cotizacionGlobal(sym) {
  const r = await yahooChart(sym);
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const closes = r.indicators?.quote?.[0]?.close || [];
  const ultimo = meta.regularMarketPrice;
  const momento = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null;

  // Ultimo cierre diario no nulo que sea ANTERIOR al dato actual. El propio dia
  // en curso aparece en el array con el precio vivo: hay que saltearlo.
  let prev = null;
  let prevFecha = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] == null) continue;
    const fecha = new Date(ts[i] * 1000);
    if (momento && Math.abs(fecha - momento) < 12 * 3600e3) continue; // es la barra de hoy
    prev = closes[i];
    prevFecha = fecha;
    break;
  }

  const varPct = prev ? ((ultimo / prev) - 1) * 100 : null;
  return {
    sym,
    ultimo,
    prevClose: prev,
    prevCloseFecha: prevFecha ? prevFecha.toISOString().slice(0, 10) : null,
    varPct,
    momento: momento ? momento.toISOString() : null,
    moneda: meta.currency || null,
    // Para que quede explicito que NO usamos el campo que miente.
    chartPreviousCloseIgnorado: meta.chartPreviousClose ?? null,
  };
}

const fmt = (n, d = 2) => (n == null ? "s/d" : n.toLocaleString("es-AR", { minimumFractionDigits: d, maximumFractionDigits: d }));
const signo = (p) => (p == null ? "" : (p >= 0 ? "+" : "") + fmt(p, 1) + "%");

/** "¿Como viene Asia?" y "¿cuanto esta el WTI?" salen de aca. */
export async function mercadoGlobal({ grupo = null } = {}) {
  const claves = Object.keys(GLOBAL).filter((k) => !grupo || GLOBAL[k].grupo === grupo);
  const res = await Promise.allSettled(claves.map((k) => cotizacionGlobal(GLOBAL[k].sym)));

  const items = [];
  const fallaron = [];
  res.forEach((r, i) => {
    const def = GLOBAL[claves[i]];
    if (r.status === "fulfilled") items.push({ ...def, ...r.value });
    else fallaron.push({ ...def, error: String(r.reason?.message || r.reason) });
  });

  if (!items.length) {
    return { ok: false, fallaron, resumen: "No pude traer ningun dato de mercado global." };
  }

  // El vintage va SIEMPRE visible: un indice asiatico cerrado el viernes no es
  // el dato de hoy, y sin la fecha parece que si.
  const linea = (it) => `${it.nombre} ${fmt(it.ultimo)} (${signo(it.varPct)} vs cierre del ${it.prevCloseFecha})`;
  let resumen = items.map(linea).join(". ") + ". Fuente: Yahoo Finance.";
  if (fallaron.length) resumen += ` No pude traer: ${fallaron.map((f) => f.nombre).join(", ")}.`;

  return { ok: true, items, fallaron, resumen };
}
