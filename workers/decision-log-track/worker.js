/**
 * Worker decision-log-track: mide a posteriori los veredictos guardados en
 * `decision_log`.
 *
 * POR QUE EXISTE: todo lo demas en Midas se mide contra una vara — el Sharpe
 * deflactado de las estrategias, el alpha de LP con benchmark sectorial, el
 * nivel_track del bot de niveles. Lo unico que no se medi­a eran las opiniones
 * del copiloto, que se evaporaban en el chat. Sin registro no hay forma de
 * saber si suman o restan, y la memoria reescribe los aciertos.
 *
 * QUE HACE: para cada fila con marcas pendientes, busca el precio del papel y
 * el del benchmark a 1, 5 y 21 RUEDAS despues del llamado, y los guarda. La
 * pantalla de Midas hace las cuentas de acierto y exceso.
 *
 * DECISIONES DE DISEÑO QUE IMPORTAN:
 *
 * 1. Se mide en RUEDAS, no en dias corridos. Un llamado de un viernes medido
 *    "un dia despues" tiene que compararse contra el lunes, no contra el
 *    sabado. Yahoo solo devuelve ruedas, asi que se cuentan barras.
 *
 * 2. Se mide desde la rueda SIGUIENTE al llamado, no desde la misma. Es la
 *    correccion de Coval-Hirshleifer-Shumway: si el llamado se hizo a media
 *    rueda, incluir el resto de ese dia mete adentro informacion que ya estaba
 *    en el precio cuando se opino. Para llamados INTRADIA es distinto — ahi el
 *    horizonte es el cierre del mismo dia, y se mide contra el cierre de ese
 *    dia (px_1d) porque es la unica medicion honesta de un scalp.
 *
 * 3. Siempre se guarda tambien el BENCHMARK. Medir un papel concentrado contra
 *    un indice amplio engaña: con SPY el alpha de LP daba negativo y
 *    significativo, con benchmark sectorial daba neutro. El exceso sobre el
 *    benchmark correcto es el unico numero que dice algo.
 *
 * Schedule: PM2 cron_restart todos los dias a las 22:30 ART (con Wall Street ya
 * cerrada y el cierre del dia consolidado). Corre y sale.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Verifica .env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" };
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

const MARCAS = [
  { col: "px_1d", bench: "bench_1d", ruedas: 1 },
  { col: "px_5d", bench: "bench_5d", ruedas: 5 },
  { col: "px_21d", bench: "bench_21d", ruedas: 21 },
];

/* Cache de series diarias: una sola bajada por simbolo aunque lo pidan varias
 * filas. Con 20-30 decisiones por semana esto es la diferencia entre 3 y 60
 * requests a Yahoo. */
const cache = new Map();

/* La barra diaria del dia EN CURSO no es un cierre: Yahoo la devuelve con el
 * ultimo precio operado. Si el worker corre a media rueda, congela ese precio
 * como si fuera el cierre y la medicion queda mal para siempre (paso el
 * 13/08/2026 corriendolo a mano a las 15:36). Se descarta.
 *
 * Tanto Wall Street (16:00 ET) como BYMA (17:00 ART) cierran a las 20:00 UTC;
 * se usa 21:00 UTC para darle una hora a Yahoo de consolidar el dato. El cron
 * normal corre 01:30 UTC, asi que este guard solo actua en corridas manuales.
 */
function enCurso(fechaBarra) {
  const ahora = new Date();
  return fechaBarra === ahora.toISOString().slice(0, 10) && ahora.getUTCHours() < 21;
}

async function serie(sym) {
  if (cache.has(sym)) return cache.get(sym);
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y`;
    const j = await (await fetch(u, { headers: UA })).json();
    const r = j?.chart?.result?.[0];
    if (!r) { cache.set(sym, null); return null; }
    const q = r.indicators.quote[0];
    const b = [];
    for (let i = 0; i < r.timestamp.length; i++) {
      if (q.close[i] == null) continue;
      b.push({ d: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10), c: q.close[i] });
    }
    while (b.length && enCurso(b[b.length - 1].d)) b.pop();
    const out = b.length ? b : null;
    cache.set(sym, out);
    return out;
  } catch (e) {
    log(`  ${sym}: error bajando serie (${e.message})`);
    cache.set(sym, null);
    return null;
  }
}

/* Precio N ruedas DESPUES de la fecha del llamado.
 *
 * `base` = indice de la rueda del llamado (la ultima barra con fecha <= fecha
 * del llamado). Para horizonte intradia, la rueda 1 es el cierre de ESE MISMO
 * dia: el scalp se resuelve el mismo dia y medirlo contra mañana seria medir
 * otra cosa. Para el resto, la rueda 1 es la siguiente — un llamado hecho a
 * media rueda no puede acreditarse el movimiento que ya habia ocurrido.
 */
function precioA(barras, fechaLlamado, ruedas, intradia) {
  if (!barras || !barras.length) return null;
  let base = -1;
  for (let i = 0; i < barras.length; i++) {
    if (barras[i].d <= fechaLlamado) base = i; else break;
  }
  if (base < 0) return null;

  /* Si el llamado es de HOY y su propia rueda todavia no cerro, `serie()` ya
   * descarto esa barra y `base` quedo apuntando al cierre de AYER. Sin este
   * chequeo, un llamado intradia de hoy se mediria contra el cierre anterior
   * — un numero que existia ANTES de opinar. Paso el 13/08/2026: MU quedo
   * medido en 911,29 (cierre del 12) sobre una referencia de 932,98.
   *
   * Si la fecha no coincide pero es una fecha PASADA, es un feriado o fin de
   * semana y el ancla correcta si es la ultima rueda previa. */
  const hoy = new Date().toISOString().slice(0, 10);
  if (barras[base].d !== fechaLlamado && fechaLlamado >= hoy) return null;

  const idx = intradia ? base + ruedas - 1 : base + ruedas;
  if (idx >= barras.length) return null;   // todavia no paso; se mide en otra corrida
  return barras[idx].c;
}

async function main() {
  log("decision-log-track arrancando");

  // Solo lo que le falta al menos una marca. La de 21 ruedas es la ultima en
  // completarse, asi que sirve de filtro grueso.
  const { data: filas, error } = await supabase
    .from("decision_log")
    .select("id,ticker,sym,created_at,horizonte,benchmark,px_1d,px_5d,px_21d,bench_1d,bench_5d,bench_21d")
    .is("px_21d", null)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw new Error(`select: ${error.message}`);
  if (!filas || !filas.length) { log("nada pendiente de medir"); return; }
  log(`${filas.length} decisiones pendientes`);

  let tocadas = 0, marcasNuevas = 0;

  for (const f of filas) {
    const sym = f.sym || f.ticker;
    const fecha = String(f.created_at).slice(0, 10);
    const intradia = f.horizonte === "intradia";

    const bPapel = await serie(sym);
    if (!bPapel) { log(`  ${f.ticker}: sin serie para ${sym}, salteo`); continue; }
    const bBench = f.benchmark ? await serie(f.benchmark) : null;

    const patch = {};
    for (const m of MARCAS) {
      if (f[m.col] == null) {
        const p = precioA(bPapel, fecha, m.ruedas, intradia);
        if (p != null) { patch[m.col] = Math.round(p * 10000) / 10000; marcasNuevas++; }
      }
      if (f[m.bench] == null && bBench) {
        const p = precioA(bBench, fecha, m.ruedas, intradia);
        if (p != null) patch[m.bench] = Math.round(p * 10000) / 10000;
      }
    }

    if (!Object.keys(patch).length) continue;
    patch.tracked_at = new Date().toISOString();
    const { error: eu } = await supabase.from("decision_log").update(patch).eq("id", f.id);
    if (eu) { log(`  ${f.ticker}: update fallo (${eu.message})`); continue; }
    tocadas++;
    log(`  ${f.ticker} ${fecha} (${f.horizonte}) -> ${Object.keys(patch).filter((k) => k !== "tracked_at").join(", ")}`);
  }

  log(`listo: ${tocadas} decisiones actualizadas, ${marcasNuevas} marcas nuevas de precio`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] fatal:`, err.message || err);
    process.exit(1);
  });
