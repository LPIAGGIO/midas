/**
 * Worker trade-counterfactual — mide cada compra y cada venta de acciones y
 * CEDEARs contra el contrafactual del paper "Selling Fast and Buying Slow"
 * (Akepanidtaworn, Di Mascio, Imas & Schmidt, Journal of Finance 2023).
 *
 * LA PREGUNTA. El paper mide 783 carteras institucionales y encuentra una
 * asimetría fuerte: comprando le ganan a un contrafactual aleatorio por ~100 pb
 * al año, pero vendiendo pierden ~80 pb al año contra VENDER AL AZAR otra
 * posición de la propia cartera. La causa que proponen no es falta de skill
 * sino atención asimétrica: se piensa la compra y se despacha la venta con un
 * heurístico — se venden los extremos (el mejor y el peor de la cartera) porque
 * el retorno pasado es lo que salta a la vista en cualquier pantalla.
 *
 * Este worker construye esa misma medición sobre el libro propio. Sin ella la
 * pregunta "¿vendo bien?" no se puede contestar, porque la memoria guarda las
 * ventas que salieron bien y no las alternativas que uno se perdió.
 *
 * EL CONTRAFACTUAL. Para cada operación del día D se toman las OTRAS posiciones
 * que había ese día y no se tocaron, y se promedia su retorno a H ruedas. El
 * paper sortea UNA alternativa al azar; acá se promedian todas. Es la esperanza
 * de ese sorteo con mucha menos varianza, y hace falta: estas carteras tienen
 * ~10 posiciones contra las 78 promedio del paper, así que un solo sorteo sería
 * ruido puro.
 *
 * SE MIDE EN DÓLARES, sobre el subyacente. Un CEDEAR en pesos se mueve por el
 * papel Y por el dólar, y el dólar le pega igual a lo comprado y a lo vendido:
 * medirlo en pesos mete una varianza enorme que no dice nada sobre la decisión.
 * Es la misma corrección que ya cambió el resultado cuando se midió el alpha
 * con benchmark sectorial en vez de contra SPY.
 *
 * SIGNO. valor_agregado positivo = la decisión agregó valor, para los dos lados:
 *   compra: ret_trade - ret_contrafactual
 *   venta:  ret_contrafactual - ret_trade
 * Así las dos series se leen con la misma regla y se pueden comparar de frente,
 * que es todo el punto del paper.
 *
 * IDEMPOTENTE: upsert por (user, fecha, ticker, side, horizonte). Recalcula todo
 * en cada corrida — el universo es chico y así los horizontes largos se van
 * completando solos a medida que pasa el tiempo.
 *
 * Schedule: PM2 cron_restart 30 23 * * 1-6 (después del cierre de EE.UU.).
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// Horizontes en RUEDAS. El paper va de 7 a 730 días corridos; acá se usan
// ruedas porque el retorno se calcula sobre la serie diaria. Los cortos están
// para tener señal temprana, pero el propio paper muestra que el daño de las
// ventas recién aparece pasados los 90 días: leer los cortos como veredicto
// sería confundir ruido con hallazgo.
const HORIZONTES = [1, 5, 10, 21, 42, 63, 126, 252];

// Acciones argentinas → su ADR. Se mide sobre el ADR porque es la misma empresa
// cotizando en dólares, sin el ruido del tipo de cambio.
const ARG_ADR = {
  YPFD: "YPF", GGAL: "GGAL", PAMP: "PAM", BMA: "BMA", CEPU: "CEPU",
  EDN: "EDN", LOMA: "LOMA", SUPV: "SUPV", TGSU2: "TGS", CRES: "CRESY",
  IRSA: "IRS", BBAR: "BBAR", TECO2: "TEO",
};
const symDe = (tk) => ARG_ADR[tk] || tk;

/** Serie diaria de cierres ajustados desde Yahoo. Map fecha(ISO) → cierre. */
async function serie(sym) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y&events=div%2Csplit`,
      { headers: UA }
    );
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res?.timestamp) return null;
    // adjclose incorpora splits y dividendos: sin eso, un split se lee como una
    // caída del 90% y arruina la medición del papel que lo tuvo.
    const cierres = res.indicators?.adjclose?.[0]?.adjclose || res.indicators?.quote?.[0]?.close || [];
    const m = new Map();
    for (let i = 0; i < res.timestamp.length; i++) {
      const v = cierres[i];
      if (v == null || !Number.isFinite(v)) continue;
      m.set(new Date(res.timestamp[i] * 1000).toISOString().slice(0, 10), v);
    }
    return m.size ? m : null;
  } catch { return null; }
}

/** Retorno de sym entre la rueda de `desde` y H ruedas después. null si no llega. */
function retornoFwd(serieMap, fechasOrd, desde, H) {
  // Primera rueda en o después de la fecha de la operación.
  let i = fechasOrd.findIndex((d) => d >= desde);
  if (i < 0) return null;
  const j = i + H;
  if (j >= fechasOrd.length) return null;   // todavía no pasó ese horizonte
  const p0 = serieMap.get(fechasOrd[i]), p1 = serieMap.get(fechasOrd[j]);
  if (!(p0 > 0) || !(p1 > 0)) return null;
  return p1 / p0 - 1;
}

async function main() {
  log("trade-counterfactual arrancando");

  const { data: ops, error } = await supabase
    .from("positions")
    .select("user_id,ticker,instrument_type,operation_type,quantity,entry_date")
    .in("instrument_type", ["cedear", "stock"])
    .order("entry_date", { ascending: true });
  if (error) throw new Error(error.message);
  if (!ops?.length) { log("sin operaciones de acciones/CEDEARs"); return; }

  const porUsuario = new Map();
  for (const o of ops) {
    if (!o.entry_date || !o.ticker) continue;
    if (!porUsuario.has(o.user_id)) porUsuario.set(o.user_id, []);
    porUsuario.get(o.user_id).push({ ...o, ticker: String(o.ticker).toUpperCase().trim() });
  }

  // Una sola bajada de Yahoo por símbolo, compartida entre usuarios.
  const symbols = [...new Set(ops.map((o) => symDe(String(o.ticker).toUpperCase().trim())))];
  const series = {};
  for (const s of symbols) {
    const m = await serie(s);
    if (m) series[s] = { map: m, fechas: [...m.keys()].sort() };
    else log(`sin serie para ${s} — sus operaciones quedan sin medir`);
  }
  log(`series bajadas: ${Object.keys(series).length}/${symbols.length}`);

  let filas = [];
  for (const [userId, lista] of porUsuario) {
    // Tenencia acumulada por ticker, avanzando en el tiempo. Se necesita para
    // saber qué había en cartera el día de cada operación: el contrafactual son
    // las OTRAS posiciones vivas, no todo el universo.
    const tenencia = new Map();
    const porFecha = new Map();
    for (const o of lista) {
      if (!porFecha.has(o.entry_date)) porFecha.set(o.entry_date, []);
      porFecha.get(o.entry_date).push(o);
    }

    for (const fecha of [...porFecha.keys()].sort()) {
      const delDia = porFecha.get(fecha);
      const tocadosHoy = new Set(delDia.map((o) => o.ticker));

      // Alternativas = lo que había ANTES de operar hoy y no se tocó hoy.
      const alternativas = [...tenencia.entries()]
        .filter(([tk, q]) => q > 1e-9 && !tocadosHoy.has(tk))
        .map(([tk]) => tk);

      for (const o of delDia) {
        const sym = symDe(o.ticker);
        const ser = series[sym];
        if (!ser) continue;
        const side = o.operation_type === "sell" ? "sell" : "buy";

        for (const H of HORIZONTES) {
          const rt = retornoFwd(ser.map, ser.fechas, fecha, H);
          if (rt == null) continue;   // el horizonte todavía no ocurrió

          const rs = [];
          for (const alt of alternativas) {
            const sa = series[symDe(alt)];
            if (!sa) continue;
            const r = retornoFwd(sa.map, sa.fechas, fecha, H);
            if (r != null) rs.push(r);
          }
          if (!rs.length) continue;   // sin alternativas medibles no hay contrafactual
          const rc = rs.reduce((s, x) => s + x, 0) / rs.length;

          filas.push({
            user_id: userId, trade_date: fecha, ticker: o.ticker, sym, side, horizonte: H,
            ret_trade: Math.round(rt * 1e6) / 1e6,
            ret_contrafactual: Math.round(rc * 1e6) / 1e6,
            valor_agregado: Math.round((side === "sell" ? rc - rt : rt - rc) * 1e6) / 1e6,
            n_alternativas: rs.length,
            updated_at: new Date().toISOString(),
          });
        }
      }

      // Recién DESPUÉS de medir se aplica el movimiento del día: la operación de
      // hoy no puede formar parte de su propio contrafactual.
      for (const o of delDia) {
        const q = Number(o.quantity) || 0;
        const signo = o.operation_type === "sell" ? -1 : 1;
        tenencia.set(o.ticker, (tenencia.get(o.ticker) || 0) + signo * q);
      }
    }
  }

  if (!filas.length) { log("nada medible todavía"); return; }

  // Dedup por la clave única: un mismo ticker puede tener varias operaciones del
  // mismo lado en el mismo día (compras en tramos). Se queda la última.
  const porClave = new Map();
  for (const f of filas) porClave.set(`${f.user_id}|${f.trade_date}|${f.ticker}|${f.side}|${f.horizonte}`, f);
  filas = [...porClave.values()];

  for (let i = 0; i < filas.length; i += 500) {
    const { error: e } = await supabase.from("trade_counterfactual")
      .upsert(filas.slice(i, i + 500), { onConflict: "user_id,trade_date,ticker,side,horizonte" });
    if (e) throw new Error(`upsert: ${e.message}`);
  }

  const resumen = {};
  for (const f of filas) {
    const k = `${f.side}|${f.horizonte}`;
    if (!resumen[k]) resumen[k] = { n: 0, suma: 0 };
    resumen[k].n++; resumen[k].suma += f.valor_agregado;
  }
  log(`${filas.length} mediciones guardadas`);
  for (const H of HORIZONTES) {
    const b = resumen[`buy|${H}`], s = resumen[`sell|${H}`];
    if (!b && !s) continue;
    const fmt = (x) => (x ? `${((x.suma / x.n) * 100 >= 0 ? "+" : "")}${((x.suma / x.n) * 100).toFixed(2)}% (n=${x.n})` : "—");
    log(`  ${String(H).padStart(3)} ruedas · compras ${fmt(b).padEnd(20)} ventas ${fmt(s)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(`[${new Date().toISOString()}] fatal:`, err.message || err); process.exit(1); });
