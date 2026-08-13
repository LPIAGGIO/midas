/**
 * Worker earnings-calendar: cuando reportan los papeles que hay en cartera.
 *
 * POR QUE EXISTE: el 13/08/2026 LP llego al balance de NU sin que la fecha
 * estuviera registrada en ningun lado — la buscamos a mano el dia anterior.
 * Un evento binario que mueve 7,4% mediano (y hasta 19% en la cola) no puede
 * depender de que alguien se acuerde de mirar el calendario.
 *
 * QUE HACE:
 *  1. Junta los tickers con posicion abierta de TODOS los usuarios.
 *  2. Le pide a Yahoo la proxima fecha de balance de cada uno y la guarda.
 *  3. A cada usuario que tenga Telegram vinculado le avisa que papeles SUYOS
 *     reportan en los proximos 7 dias.
 *
 * El aviso se deduplica por (usuario, ticker, fecha) contra notification_log,
 * asi que aunque el worker corra todos los dias, el mensaje sale una sola vez
 * por balance. La excepcion deliberada es la vispera: el dia anterior se manda
 * de nuevo, porque es cuando hay que decidir si se aguanta o no.
 *
 * Schedule: PM2 cron_restart 07:15 ART lun-vie, antes de que abra el mercado
 * local. Corre y sale.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Verifica .env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const AVISO_DIAS = 7;

/* Los CEDEARs usan el mismo simbolo que el subyacente en casi todos los casos.
 * Las excepciones son los papeles ARGENTINOS, donde hay que ir al ADR — y los
 * que no tienen ADR directamente no se pueden consultar. */
const A_ADR = {
  GGAL: "GGAL", YPFD: "YPF", PAMP: "PAM", BMA: "BMA", TXAR: "TX",
  CRES: "CRESY", EDN: "EDN", TGSU2: "TGS", SUPV: "SUPV", BBAR: "BBAR",
  LOMA: "LOMA", CEPU: "CEPU", IRSA: "IRS", TECO2: "TEO", VIST: "VIST",
};
// Sin ADR o sin balance publicado en Yahoo: no tiene sentido consultarlos.
const SIN_ADR = new Set(["ALUA", "COME", "METR", "TRAN", "VALO", "BHIP", "CECO2", "AGRO", "MIRG", "CARC", "AUSO", "DGCU2", "HARG", "CAPX", "BYMA"]);

/* LISTA BLANCA, no lista negra. La primera version excluia
 * "future|fci|bond|caucion" y se colaron 5 bonos porque el tipo real en la
 * tabla es `bond_ars`, no `bond`. Con lista blanca, un tipo nuevo que aparezca
 * manana queda afuera solo — que es el default correcto: lo unico que tiene
 * balance son acciones y CEDEARs. */
const CON_BALANCE = new Set(["cedear", "stock"]);
const esOpcion = (t) => /^(GFG|YPF|PAM|ALU|COM|MET|TXA)[CV]\d/i.test(t || "");

function aSimboloUsa(ticker, tipo) {
  if (!CON_BALANCE.has(tipo)) return null;
  const t = String(ticker || "").trim().toUpperCase();
  if (!t || esOpcion(t) || SIN_ADR.has(t)) return null;
  return A_ADR[t] || t;
}

async function getAuth() {
  const r = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
  const sc = typeof r.headers.getSetCookie === "function"
    ? r.headers.getSetCookie()
    : (r.headers.get("set-cookie") ? [r.headers.get("set-cookie")] : []);
  const cookie = sc.map((c) => c.split(";")[0]).join("; ");
  const cr = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": UA, "Cookie": cookie },
  });
  const crumb = (await cr.text()).trim();
  if (!crumb || crumb.startsWith("{")) throw new Error("no se pudo obtener crumb de Yahoo");
  return { cookie, crumb };
}

const raw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : (typeof x === "number" ? x : null));
const aFecha = (x) => { const v = raw(x); return v ? new Date(v * 1000).toISOString().slice(0, 10) : null; };

async function fetchEarnings(sym, auth) {
  const u = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`;
  const r = await fetch(u, { headers: { "User-Agent": UA, "Cookie": auth.cookie } });
  const j = await r.json();
  const e = j?.quoteSummary?.result?.[0]?.calendarEvents?.earnings;
  if (!e) return null;
  const fechas = (e.earningsDate || []).map(aFecha).filter(Boolean).sort();
  if (!fechas.length) return null;
  return {
    ticker: sym,
    earnings_date: fechas[0],
    // Yahoo devuelve DOS timestamps cuando la fecha no esta confirmada: es un
    // rango estimado, no un dia. Guardar el fin permite mostrarlo como tal en
    // vez de mentir con una precision que el dato no tiene.
    earnings_date_fin: fechas.length > 1 && fechas[1] !== fechas[0] ? fechas[1] : null,
    // Yahoo no expone BMO/AMC de forma confiable en calendarEvents. Se deja en
    // null antes que inventarlo: el horario decide si la reaccion es el mismo
    // dia o el siguiente, y equivocarlo es peor que no tenerlo.
    hora: null,
    eps_estimate: raw(e.earningsAverage),
    revenue_estimate: raw(e.revenueAverage),
    fetched_at: new Date().toISOString(),
  };
}

const tg = (chatId, text) =>
  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
  }).then((r) => r.json());

async function main() {
  log("earnings-calendar arrancando");

  // ── 1. Posiciones abiertas de todos los usuarios ──
  const { data: pos, error: ep } = await supabase
    .from("positions")
    .select("user_id,ticker,instrument_type,quantity,operation_type")
    .limit(20000);
  if (ep) throw new Error(`positions: ${ep.message}`);

  const neto = new Map();  // `${user}|${ticker}` -> { user_id, ticker, tipo, net }
  for (const p of pos || []) {
    const k = `${p.user_id}|${p.ticker}`;
    if (!neto.has(k)) neto.set(k, { user_id: p.user_id, ticker: p.ticker, tipo: p.instrument_type, net: 0 });
    const q = Number(p.quantity) || 0;
    neto.get(k).net += p.operation_type === "sell" ? -q : q;
  }
  const abiertas = [...neto.values()].filter((x) => Math.abs(x.net) > 1e-6);

  // ticker USA -> set de usuarios que lo tienen
  const porSimbolo = new Map();
  for (const a of abiertas) {
    const sym = aSimboloUsa(a.ticker, a.tipo);
    if (!sym) continue;
    if (!porSimbolo.has(sym)) porSimbolo.set(sym, { usuarios: new Set(), tickerLocal: a.ticker });
    porSimbolo.get(sym).usuarios.add(a.user_id);
  }
  log(`${abiertas.length} posiciones abiertas -> ${porSimbolo.size} simbolos a consultar`);
  if (!porSimbolo.size) { log("nada que consultar"); return; }

  // ── 2. Fechas de balance ──
  const auth = await getAuth();
  const filas = [], fallaron = [];
  const syms = [...porSimbolo.keys()];
  for (let i = 0; i < syms.length; i += 8) {
    const chunk = syms.slice(i, i + 8);
    const res = await Promise.all(chunk.map(async (s) => {
      try { return await fetchEarnings(s, auth); } catch { return null; }
    }));
    res.forEach((r, k) => { if (r) filas.push(r); else fallaron.push(chunk[k]); });
  }
  if (filas.length) {
    const { error } = await supabase.from("earnings_calendar").upsert(filas, { onConflict: "ticker" });
    if (error) throw new Error(`upsert: ${error.message}`);
  }
  log(`calendario: ${filas.length} con fecha${fallaron.length ? `, ${fallaron.length} sin dato (${fallaron.join(",")})` : ""}`);

  // ── 3. Aviso por Telegram ──
  if (!TELEGRAM_BOT_TOKEN) { log("sin TELEGRAM_BOT_TOKEN: no se avisa"); return; }

  const hoy = new Date().toISOString().slice(0, 10);
  const limite = new Date(Date.now() + AVISO_DIAS * 86400000).toISOString().slice(0, 10);
  const proximos = filas.filter((f) => f.earnings_date >= hoy && f.earnings_date <= limite);
  if (!proximos.length) { log("ningun balance en los proximos 7 dias"); return; }

  const { data: links } = await supabase.from("telegram_links").select("user_id,chat_id");
  const chatBy = new Map((links || []).map((l) => [l.user_id, l.chat_id]));

  const porUsuario = new Map();
  for (const f of proximos) {
    for (const uid of porSimbolo.get(f.ticker).usuarios) {
      if (!chatBy.has(uid)) continue;
      if (!porUsuario.has(uid)) porUsuario.set(uid, []);
      porUsuario.get(uid).push(f);
    }
  }

  for (const [uid, lista] of porUsuario) {
    const pendientes = [];
    for (const f of lista) {
      const dias = Math.round((new Date(f.earnings_date) - new Date(hoy)) / 86400000);
      // Dedup por balance, con una excepcion: la vispera se vuelve a mandar,
      // porque es el momento en que hay que decidir si se aguanta o no.
      const clave = dias <= 1 ? `${f.ticker}|${f.earnings_date}|vispera` : `${f.ticker}|${f.earnings_date}`;
      const { data: ya } = await supabase.from("notification_log").select("id")
        .eq("user_id", uid).eq("kind", "earnings").eq("dedup_key", clave).limit(1);
      if (ya && ya.length) continue;
      pendientes.push({ ...f, dias, clave });
    }
    if (!pendientes.length) continue;

    pendientes.sort((a, b) => a.earnings_date.localeCompare(b.earnings_date));
    const lineas = pendientes.map((f) => {
      const cuando = f.dias === 0 ? "HOY" : f.dias === 1 ? "mañana" : `en ${f.dias} días`;
      const fecha = f.earnings_date.slice(8, 10) + "/" + f.earnings_date.slice(5, 7);
      const rango = f.earnings_date_fin ? " <i>(fecha estimada)</i>" : "";
      const eps = f.eps_estimate != null ? ` · EPS esperado ${f.eps_estimate}` : "";
      return `• <b>${f.ticker}</b> — ${cuando} (${fecha})${rango}${eps}`;
    });
    const texto = `📅 <b>Balances de tu cartera</b>\n\n${lineas.join("\n")}\n\n<i>Un balance es un evento binario: define el precio de un salto y no hay stop que lo cubra. Revisá tamaño antes, no después.</i>`;

    try {
      const r = await tg(chatBy.get(uid), texto);
      if (!r?.ok) { log(`  telegram fallo para ${uid}: ${r?.description || "sin detalle"}`); continue; }
      for (const f of pendientes) {
        await supabase.from("notification_log").insert({
          user_id: uid, kind: "earnings", dedup_key: f.clave,
          title: `balance ${f.ticker}`, body: f.earnings_date,
        });
      }
      log(`  aviso enviado a ${uid}: ${pendientes.map((f) => f.ticker).join(",")}`);
    } catch (e) {
      log(`  error enviando a ${uid}: ${e.message}`);
    }
  }

  log("listo");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] fatal:`, err.message || err);
    process.exit(1);
  });
