/**
 * Worker insider-form4 — compras y ventas de INSIDERS (Form 4 de la SEC)
 * sobre el universo propio: los papeles del bot + tenencias USA de LP.
 *
 * Fuente OFICIAL: data.sec.gov (submissions por emisor) + Archives (el XML
 * de cada Form 4). Sin terceros, sin scraping de webs.
 *
 * Qué guarda: SOLO transacciones no-derivativas con código P (compra a
 * mercado abierto — el insider pone plata propia) o S (venta). Grants,
 * ejercicios de opciones, gifts y demás códigos quedan afuera: ensucian.
 *
 * Qué clasifica (paper Biggerstaff, Cicero & Wintoki, SSRN 2128127): las
 * operaciones del mismo insider en el mismo papel se agrupan en SECUENCIAS
 * (gap <= 45 días entre operaciones). Una sola operación = 'aislada'.
 * Secuencia sin operaciones nuevas por 45 días = 'finalizada' — ese es el
 * evento informativo del paper (el que acumulaba terminó de armar posición;
 * drift ~3 meses post-fin). El flag after_hours (filing presentado fuera de
 * rueda de NY) marca la variante más fuerte de la señal.
 *
 * Alertas Telegram: fin de secuencia RECIENTE (detectado en los últimos 10
 * días — el backfill histórico no spamea). La alerta es filtro de research,
 * no recomendación: la decisión sigue siendo de LP.
 *
 * Corre por pm2 cron 2 veces al día (mañana ART y post-cierre USA).
 * Volumen: ~25 emisores × pocos filings nuevos por día. Cortesía EDGAR.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws },
});
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// EDGAR pide identificarse con contacto real en el User-Agent (misma
// identidad que el worker de 13F).
const UA = { "User-Agent": "Midas Research lpiaggio@gmail.com" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Usuario dueño de las alertas (LP) — mismo esquema que niveles-auto.
const BOT_USER = "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ── Universo ────────────────────────────────────────────────────────────
// Papeles del bot + tenencias USA vía CEDEAR. Los emisores extranjeros
// (foreign private issuers: NU, GGAL, YPF, VIST, MELI no — MELI es Delaware)
// están exentos de la Section 16 y no presentan Form 4: se dejan en la lista
// igual (cuesta un request por corrida) por si algún insider presenta
// voluntariamente, y el log lo dice una sola vez.
const UNIVERSO = [
  "MU", "SNDK", "NVDA", "AMD", "AAPL", "MSFT", "GOOGL", "META", "AMZN",
  "KO", "JNJ", "XOM", "MELI", "INTC", "TSLA", "ORCL", "AVGO", "VST",
  "MCD", "SPCX", "NU", "GGAL", "YPF", "VIST",
];

const GAP_DIAS = 45;        // gap máximo dentro de una secuencia (paper: meses)
const BACKFILL_DESDE = "2026-03-01"; // 6 meses de historia alcanzan para clasificar
const ALERT_VENTANA_DIAS = 10;       // solo se alerta lo finalizado hace poco

let _tgChat = null;
async function tg(texto) {
  if (!TG_TOKEN) { log("[tg] sin TELEGRAM_BOT_TOKEN, no se envia"); return; }
  if (_tgChat == null) {
    const { data } = await supabase.from("telegram_links")
      .select("chat_id").eq("user_id", BOT_USER).eq("enabled", true).maybeSingle();
    _tgChat = data?.chat_id || "";
  }
  if (!_tgChat) { log("[tg] sin chat_id vinculado"); return; }
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: _tgChat, text: texto, parse_mode: "HTML" }),
  }).catch((e) => log("[tg]", e.message));
}

const tag = (s, t) => {
  const m = new RegExp(`<(?:[a-zA-Z0-9]+:)?${t}>\\s*([\\s\\S]*?)\\s*</(?:[a-zA-Z0-9]+:)?${t}>`).exec(s);
  return m ? m[1].trim() : null;
};
// Muchos campos del Form 4 vienen como <campo><value>X</value></campo>.
const tagVal = (s, t) => {
  const b = tag(s, t);
  if (b == null) return null;
  const v = tag(b, "value");
  return v != null ? v : b;
};

// ── CIKs del universo (company_tickers.json, un request por corrida) ────
async function resolverCiks() {
  const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: UA });
  if (!r.ok) throw new Error(`company_tickers HTTP ${r.status}`);
  const j = await r.json();
  const porTicker = new Map();
  for (const k of Object.keys(j)) {
    const e = j[k];
    porTicker.set(String(e.ticker).toUpperCase(), String(e.cik_str).padStart(10, "0"));
  }
  const out = [];
  for (const tk of UNIVERSO) {
    const cik = porTicker.get(tk);
    if (cik) out.push({ ticker: tk, cik });
    else log(`${tk}: sin CIK en SEC (no cotiza alla o el simbolo difiere) — se saltea`);
  }
  return out;
}

// ── Fetch + parseo de un Form 4 ─────────────────────────────────────────
// Devuelve filas {owner..., trans...} SOLO de codigos P/S no-derivativos.
function parseForm4(xml, accession, issuerCik, ticker, filedAt, afterHours) {
  // Duenio reportante: si el filing es grupal (raro), se toma el primero.
  const owners = [...xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/g)].map((m) => m[1]);
  const o = owners[0] || "";
  if (owners.length > 1) log(`${ticker} ${accession}: filing grupal (${owners.length} owners), se toma el primero`);
  const ownerCik = (tag(o, "rptOwnerCik") || "").replace(/^0+/, "") || "0";
  const ownerName = tag(o, "rptOwnerName") || null;
  const isDirector = /1|true/i.test(tagVal(o, "isDirector") || "");
  const isOfficer = /1|true/i.test(tagVal(o, "isOfficer") || "");
  const isTenPct = /1|true/i.test(tagVal(o, "isTenPercentOwner") || "");
  const title = tag(o, "officerTitle") || (isDirector ? "Director" : isTenPct ? "10% owner" : null);

  const filas = [];
  for (const m of xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g)) {
    const b = m[1];
    const code = (tag(b, "transactionCode") || "").trim().toUpperCase();
    if (code !== "P" && code !== "S") continue;
    const fecha = (tagVal(b, "transactionDate") || "").slice(0, 10);
    if (!fecha) continue;
    const shares = Number(tagVal(b, "transactionShares"));
    const price = Number(tagVal(b, "transactionPricePerShare"));
    if (!(shares > 0)) continue;
    filas.push({
      accession, issuer_cik: issuerCik, ticker,
      owner_cik: ownerCik, owner_name: ownerName, owner_title: title,
      is_director: isDirector, is_officer: isOfficer, is_ten_pct: isTenPct,
      trans_date: fecha, trans_code: code,
      shares, price_usd: Number.isFinite(price) ? price : null,
      value_usd: Number.isFinite(price) ? Math.round(shares * price) : null,
      filed_at: filedAt, after_hours: afterHours,
    });
  }
  return filas;
}

// acceptanceDateTime viene en hora del Este ("2026-09-09T18:31:22.000-04:00"
// o sin offset). Fuera de 9:30-16:00 ET = after hours.
function esAfterHours(acceptance) {
  const m = /T(\d{2}):(\d{2})/.exec(acceptance || "");
  if (!m) return false;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins < 9 * 60 + 30 || mins >= 16 * 60;
}

async function procesarEmisor({ ticker, cik }) {
  const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: UA });
  if (!r.ok) { log(`${ticker}: submissions HTTP ${r.status}`); return 0; }
  const j = await r.json();
  const rec = j.filings?.recent || {};
  const forms = rec.form || [];

  const candidatos = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== "4") continue;               // 4/A (enmiendas) afuera en v1
    if ((rec.filingDate[i] || "") < BACKFILL_DESDE) continue;
    candidatos.push({
      accession: rec.accessionNumber[i],
      filingDate: rec.filingDate[i],
      acceptance: rec.acceptanceDateTime ? rec.acceptanceDateTime[i] : null,
      primaryDoc: rec.primaryDocument ? rec.primaryDocument[i] : null,
    });
  }
  if (!candidatos.length) { log(`${ticker}: sin Form 4 desde ${BACKFILL_DESDE}`); return 0; }

  const { data: vistos } = await supabase.from("insider_seen")
    .select("accession").in("accession", candidatos.map((c) => c.accession));
  const ya = new Set((vistos || []).map((v) => v.accession));
  const nuevos = candidatos.filter((c) => !ya.has(c.accession));
  if (!nuevos.length) return 0;

  let guardadas = 0;
  for (const c of nuevos) {
    try {
      const accPlano = c.accession.replace(/-/g, "");
      // primaryDocument a veces viene con prefijo de hoja de estilo
      // ("xslF345X05/doc.xml"): el XML crudo es el basename.
      const doc = (c.primaryDoc || "").split("/").pop();
      let xml = null;
      if (doc && /\.xml$/i.test(doc)) {
        const rx = await fetch(`https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accPlano}/${doc}`, { headers: UA });
        if (rx.ok) xml = await rx.text();
      }
      if (!xml) {
        // Fallback: listar el directorio y agarrar el primer .xml que no sea hoja de estilo.
        const idx = await (await fetch(`https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accPlano}/`, { headers: UA })).text();
        const xmls = [...idx.matchAll(/href="[^"]*\/([^/"]+\.xml)"/g)].map((m) => m[1]).filter((f) => !/^xsl/i.test(f));
        if (xmls.length) {
          const rx2 = await fetch(`https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${accPlano}/${xmls[0]}`, { headers: UA });
          if (rx2.ok) xml = await rx2.text();
        }
      }
      if (xml) {
        const filas = parseForm4(xml, c.accession, cik, ticker, c.acceptance || null, esAfterHours(c.acceptance));
        for (const f of filas) {
          const { error } = await supabase.from("insider_filings")
            .upsert(f, { onConflict: "accession,owner_cik,trans_date,trans_code,shares,price_usd", ignoreDuplicates: true });
          if (error) log(`${ticker} ${c.accession}: upsert ${error.message}`);
          else guardadas++;
        }
      } else {
        log(`${ticker} ${c.accession}: no pude bajar el XML`);
      }
      await supabase.from("insider_seen").upsert(
        { accession: c.accession, ticker, filing_date: c.filingDate },
        { onConflict: "accession", ignoreDuplicates: true });
      await sleep(250); // cortesía EDGAR
    } catch (e) {
      log(`${ticker} ${c.accession}: ERROR ${e.message}`);
    }
  }
  if (guardadas) log(`${ticker}: ${nuevos.length} Form 4 nuevos, ${guardadas} transacciones P/S`);
  return guardadas;
}

// ── Clasificación de secuencias ─────────────────────────────────────────
const dias = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);

async function clasificar() {
  const { data: filas, error } = await supabase.from("insider_filings")
    .select("ticker,owner_cik,owner_name,owner_title,trans_date,trans_code,value_usd,after_hours")
    .order("trans_date", { ascending: true }).limit(20000);
  if (error) { log("clasificar: " + error.message); return; }
  const hoy = new Date().toISOString().slice(0, 10);

  // Agrupar por ticker|owner|lado y cortar en secuencias por gap.
  const grupos = new Map();
  for (const f of filas || []) {
    const lado = f.trans_code === "P" ? "buy" : "sell";
    const k = `${f.ticker}|${f.owner_cik}|${lado}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(f);
  }

  const finesRecientes = [];
  for (const [k, ops] of grupos) {
    const [ticker, owner_cik, side] = k.split("|");
    const secs = [];
    let cur = null;
    for (const op of ops) {
      if (cur && dias(cur.last, op.trans_date) <= GAP_DIAS) {
        cur.ops.push(op); cur.last = op.trans_date;
      } else {
        if (cur) secs.push(cur);
        cur = { first: op.trans_date, last: op.trans_date, ops: [op] };
      }
    }
    if (cur) secs.push(cur);

    for (const s of secs) {
      const activa = dias(s.last, hoy) <= GAP_DIAS;
      const status = s.ops.length === 1 ? (activa ? "activa" : "aislada") : (activa ? "activa" : "finalizada");
      const finalized_at = status === "finalizada" || status === "aislada"
        ? new Date(new Date(s.last + "T00:00:00Z").getTime() + GAP_DIAS * 86400000).toISOString().slice(0, 10)
        : null;
      const fila = {
        ticker, owner_cik, side,
        owner_name: s.ops[s.ops.length - 1].owner_name,
        owner_title: s.ops[s.ops.length - 1].owner_title,
        n_ops: s.ops.length,
        first_date: s.first, last_date: s.last,
        total_value_usd: s.ops.reduce((t, o) => t + (Number(o.value_usd) || 0), 0),
        after_hours_n: s.ops.filter((o) => o.after_hours).length,
        status, finalized_at,
        updated_at: new Date().toISOString(),
      };
      const { data: up, error: e2 } = await supabase.from("insider_sequences")
        .upsert(fila, { onConflict: "ticker,owner_cik,side,first_date" }).select("id,alerted").maybeSingle();
      if (e2) { log(`secuencia ${k}: ${e2.message}`); continue; }
      // Alertar SOLO fines de secuencia (>=2 ops) detectados hace poco: el
      // backfill histórico queda registrado pero mudo.
      if (status === "finalizada" && up && !up.alerted &&
          finalized_at && dias(finalized_at, hoy) <= ALERT_VENTANA_DIAS) {
        finesRecientes.push({ id: up.id, ...fila });
      }
    }
  }

  for (const s of finesRecientes) {
    const lado = s.side === "buy" ? "COMPRAS" : "VENTAS";
    const monto = s.total_value_usd ? `US$ ${Math.round(s.total_value_usd).toLocaleString("en-US")}` : "monto s/d";
    await tg(
      `<b>INSIDERS · fin de secuencia de ${lado} en ${s.ticker}</b>\n` +
      `${s.owner_name || "insider"}${s.owner_title ? ` (${s.owner_title})` : ""}: ` +
      `${s.n_ops} operaciones entre ${s.first_date} y ${s.last_date} · ${monto}` +
      `${s.after_hours_n ? ` · ${s.after_hours_n} filings after-hours` : ""}.\n` +
      `<i>Señal del paper BCW: el fin de una secuencia precede drift ~3 meses. ` +
      `Es un filtro de research, no una recomendación.</i>`);
    await supabase.from("insider_sequences").update({ alerted: true }).eq("id", s.id);
    log(`ALERTA fin de secuencia: ${s.ticker} ${s.side} ${s.owner_name} (${s.n_ops} ops)`);
  }
  log(`secuencias: ${grupos.size} grupos clasificados, ${finesRecientes.length} fines recientes alertados`);
}

(async () => {
  log(`insider-form4: ${UNIVERSO.length} emisores`);
  const emisores = await resolverCiks();
  let total = 0;
  for (const e of emisores) {
    try { total += await procesarEmisor(e); } catch (err) { log(`${e.ticker} ERROR ${err.message}`); }
    await sleep(400);
  }
  log(`filings procesados: ${total} transacciones nuevas`);
  await clasificar();
  log("listo");
})();
