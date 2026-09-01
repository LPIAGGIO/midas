/* ticker-brief — research matinal pre-apertura, corrido en el VPS.
 *
 * Reemplaza a la tarea programada local "brief-matinal-alertas-tv" de la
 * máquina de LP, que se colgaba pidiendo permiso por cada dominio nuevo que
 * consultaba (WebFetch interactivo). Acá el research corre por la herramienta
 * web_search DEL SERVIDOR de la API de Anthropic: cero permisos, cero browser.
 *
 * Flujo: (1) el script junta el universo y el contexto tecnico de Supabase,
 * (2) UNA conversacion con claude-opus-5 + web_search que devuelve JSON,
 * (3) el script upsertea ticker_brief y borra los tickers que salieron del
 * universo. El modelo NUNCA toca la base — solo investiga y redacta.
 *
 * Cron VPS (hora local ART): 15 9 * * 1-5  — 09:15, para que el brief este
 * escrito antes de la pre-apertura de las 10:00.
 * ticker_brief es GLOBAL (un brief por ticker); la pantalla filtra por
 * usuario. NO filtrar el universo por user_id (decision de LP del 25/08). */
require("dotenv").config();
global.WebSocket = require("ws"); // Node 20 del VPS: supabase-js v2 lo exige
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY del .env
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const hoyBA = () => new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", weekday: "long", day: "numeric", month: "long", year: "numeric" });

// Molinos de contenido que el manifiesto del brief prohibe citar.
const DOMINIOS_BLOQUEADOS = [
  "timothysykes.com", "stockstotrade.com", "tradingkey.com", "biggo.com",
  "insidermonkey.com", "intellectia.ai",
];

const SYSTEM = `Sos el analista matinal de Midas (app de inversiones argentina). Tu trabajo: research pre-apertura de los papeles que te paso y redactar un brief por ticker. Escribis SIEMPRE en castellano rioplatense, sin emojis.

MANIFIESTO DE PROCEDENCIA — innegociable:
- Todo numero que aparezca en un brief (precio, %, target, fecha, EPS, nivel) tiene que salir de una busqueda de esta conversacion o de los datos tecnicos que te paso abajo. Si no conseguiste un dato, el brief dice "s/d" o no lo menciona — nunca se estima ni se recuerda de memoria.
- Los niveles tecnicos citados salen SOLO de las notas del bot que te paso (no los recalcules).

RESEARCH por ticker (2-4 busquedas por papel, sin excederte del limite):
- Noticias de las ultimas 24-48h del papel y su sector. Semis/memoria: mira tambien SK Hynix, Samsung, KOSPI y CXMT (el contagio asiatico mueve a MU y SNDK); fintech LatAm: real y pares; energia: el crudo.
- Catalizadores de HOY y de la semana: earnings propios y de pares, datos macro (Fed, CPI), upgrades/downgrades.

JERARQUIA DE FUENTES:
- TIER 1 (base del brief): Reuters, Bloomberg, WSJ, Financial Times, CNBC, Barron's, MarketWatch, Investor's Business Daily, AP, notas propias de Yahoo Finance, comunicados oficiales (IR/press release), filings SEC, transcripts de earnings.
- TIER 2 (con criterio): Seeking Alpha, TipRanks, Benzinga, GuruFocus, 247wallst, Motley Fool, prensa coreana seria (Seoul Economic Daily, Korea Herald, ETNews), Finviz, y para papeles argentinos La Nacion/Infobae/Ambito/El Cronista + IR de la empresa.
- NO cites molinos de contenido, notas IA sin firma, ni foros/Reddit/X — salvo sentimiento minorista explicito ("el sentimiento en redes esta...").
- Dato duro solo de tier 1-2; si solo esta en tier 3 no va o va como "rumor sin confirmar"; si un agregador cita a Reuters/WSJ referencia el ORIGINAL; un titular de opinion no define el rumbo (rumbo = precio + hechos + consenso).

SALIDA — tu respuesta final es SOLO un array JSON valido, sin texto alrededor ni markdown:
[{"ticker":"XX","brief":"...","rumbo":"alcista|bajista|neutral","accion":"ENTRAR|SALIR|ESPERAR|DEFENDER <nivel>","fuentes":["url1","url2"]}]
- brief: maximo 450 caracteres, formato "que paso -> catalizador de hoy/semana -> lectura con el nivel tecnico clave del bot". Concreto, sin relleno.
- Sin noticias propias del papel, decilo ("sin noticias propias; se mueve con el sector").
- fuentes: 2-4 URLs principales usadas (solo tier 1-2).
- La accion es lectura tecnico-informativa; la decision es del usuario.
- Incluí una entrada por CADA ticker de la lista, aunque no haya noticias.`;

async function universo() {
  const { data: alertas } = await supabase.from("price_alerts")
    .select("ticker,dir,usd_ref,nota,triggered_at").eq("canal", "screen");
  const { data: pos } = await supabase.from("positions")
    .select("ticker,quantity,operation_type,broker,instrument_type")
    .in("instrument_type", ["cedear", "stock"]).neq("broker", "iol");

  const netos = {};
  for (const p of pos || []) {
    const q = (p.operation_type === "sell" ? -1 : 1) * Number(p.quantity);
    netos[p.ticker] = (netos[p.ticker] || 0) + q;
  }
  const deCartera = Object.keys(netos).filter((t) => netos[t] > 0);
  const deAlertas = [...new Set((alertas || []).map((a) => a.ticker))];
  const todos = [...new Set([...deAlertas, ...deCartera])];

  // Si superan 10: 1ro alertas no disparadas, 2do posiciones mas grandes.
  const sinDisparar = new Set((alertas || []).filter((a) => !a.triggered_at).map((a) => a.ticker));
  todos.sort((a, b) => {
    const pa = sinDisparar.has(a) ? 0 : 1, pb = sinDisparar.has(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return (netos[b] || 0) - (netos[a] || 0);
  });
  return { tickers: todos.slice(0, 10), alertas: alertas || [] };
}

async function contexto(tickers) {
  const { data } = await supabase.from("ticker_context").select("*").in("ticker", tickers);
  return data || [];
}

function extraerJson(texto) {
  const i = texto.indexOf("["), j = texto.lastIndexOf("]");
  if (i < 0 || j <= i) throw new Error("la respuesta no trae un array JSON");
  return JSON.parse(texto.slice(i, j + 1));
}

async function correr() {
  const { tickers, alertas } = await universo();
  if (!tickers.length) { log("universo vacio, nada que investigar"); return; }
  log(`universo (${tickers.length}): ${tickers.join(", ")}`);
  const ctx = await contexto(tickers);

  const userMsg =
    `Hoy es ${hoyBA()} (Argentina). Papeles a investigar: ${tickers.join(", ")}\n\n` +
    `NIVELES Y NOTAS DEL BOT (price_alerts; las notas RATCHET son stops dinamicos de posiciones abiertas):\n` +
    JSON.stringify(alertas.filter((a) => tickers.includes(a.ticker) && /^(AUTO|RATCHET)/.test(a.nota || "")), null, 0) +
    `\n\nCONTEXTO POR TICKER (ticker_context: earnings, targets de analistas, snapshot fundamental, titulares previos):\n` +
    JSON.stringify(ctx, null, 0);

  const params = {
    model: "claude-opus-5",
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    tools: [{
      type: "web_search_20260209", name: "web_search",
      max_uses: 32, blocked_domains: DOMINIOS_BLOQUEADOS,
    }],
    messages: [{ role: "user", content: userMsg }],
  };

  // Con server tools el turno puede cortarse en pause_turn: se re-encola el
  // contenido del assistant y se sigue hasta end_turn. Y un stream largo con
  // muchas busquedas puede morir a mitad con overloaded/5xx (visto en la
  // corrida de prueba, 01/09) — eso se reintenta con espera, porque un cron
  // sin reintentos es un brief que ese dia no existe.
  const pedirConReintentos = async () => {
    for (let intento = 1; ; intento++) {
      try {
        // Fallback de refusal del lado del servidor (recomendacion Anthropic
        // para opus-5); si el SDK/API no acepta el beta, va sin el.
        try {
          return await anthropic.beta.messages.stream({
            ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
          }).finalMessage();
        } catch (e) {
          if (e?.status !== 400) throw e;
          return await anthropic.messages.stream(params).finalMessage();
        }
      } catch (e) {
        const transitorio = e?.status === 429 || e?.status >= 500 ||
          /overloaded|Overloaded|ECONNRESET|ETIMEDOUT|terminated/i.test(String(e?.message || e));
        if (!transitorio || intento >= 4) throw e;
        const espera = intento * 45;
        log(`intento ${intento} fallo (${String(e?.message || e).slice(0, 90)}), reintento en ${espera}s`);
        await new Promise((r) => setTimeout(r, espera * 1000));
      }
    }
  };
  let msg;
  for (let vuelta = 0; vuelta < 8; vuelta++) {
    msg = await pedirConReintentos();
    if (msg.stop_reason !== "pause_turn") break;
    params.messages.push({ role: "assistant", content: msg.content });
    log(`pause_turn, sigo (vuelta ${vuelta + 1})`);
  }
  if (msg.stop_reason === "refusal") throw new Error("la API rechazo el pedido (refusal)");

  const texto = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const briefs = extraerJson(texto);
  const busquedas = msg.usage?.server_tool_use?.web_search_requests;
  log(`briefs recibidos: ${briefs.length} · busquedas web: ${busquedas ?? "s/d"} · tokens out: ${msg.usage?.output_tokens}`);

  let ok = 0;
  for (const b of briefs) {
    if (!b?.ticker || !b?.brief) continue;
    const { error } = await supabase.from("ticker_brief").upsert({
      ticker: String(b.ticker).toUpperCase(),
      brief: String(b.brief).slice(0, 500),
      rumbo: ["alcista", "bajista", "neutral"].includes(b.rumbo) ? b.rumbo : "neutral",
      accion: String(b.accion || "ESPERAR").slice(0, 40),
      fuentes: Array.isArray(b.fuentes) ? b.fuentes.slice(0, 4) : [],
      updated_at: new Date().toISOString(),
    }, { onConflict: "ticker" });
    if (error) log(`upsert ${b.ticker}: ERROR ${error.message}`);
    else ok++;
  }

  // Limpieza: tickers que salieron del universo. Solo si el run escribio algo
  // (un run fallido no debe vaciar la pantalla).
  if (ok > 0) {
    const lista = tickers.map((t) => `"${t}"`).join(",");
    await supabase.from("ticker_brief").delete().not("ticker", "in", `(${lista})`);
  }
  log(`listo: ${ok}/${briefs.length} briefs escritos`);
}

correr().catch((e) => { log("FATAL", e.message); process.exit(1); });
