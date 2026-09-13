/**
 * Worker paper-consenso — paper trading del "consenso de superinversores".
 *
 * ESTRATEGIA (reglas de LP, ajustadas 13/09/2026):
 *   - Cartera = los papeles de los PRIMEROS 6 PUESTOS del ranking por
 *     cantidad de gestores 13F, CON EMPATES INCLUIDOS: el umbral es la
 *     cantidad de gestores del 6to papel, y entra TODO papel que iguale o
 *     supere ese umbral (hoy: 6to = 9 gestores -> entran META y TSM, 7
 *     papeles en total).
 *   - $1.000.000 POR EMPRESA al entrar (tamano fijo, no equal-weight de un
 *     pool): el que entra compra ~$1M al precio del dia; el que sale se
 *     vende entero y el producido queda en caja.
 *   - REVISION SEMANAL (lunes 11:30 ART), no diaria: los 13F cambian de
 *     verdad en las olas trimestrales de filings.
 *   - Fill pesimista: compra al ask, venta al bid (data912 arg_cedears).
 *   - Comision IOL Gold por pata (0,5% + derechos 0,05% + IVA = 0,6655%).
 *
 * EL ASTERISCO ES PARTE DEL EXPERIMENTO: el 13F llega con 45-166 dias de
 * atraso. Este paper mide si el consenso RANCIO de los grandes gestores
 * igual paga — no lo asume.
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

const POR_EMPRESA_ARS = 1_000_000;   // tamano fijo por papel (regla de LP)
const N_PUESTOS = 6;                 // el umbral sale del 6to papel del ranking
const FEE_PATA = 0.005 * 1.21 + 0.0005 * 1.21;   // IOL Gold + derechos, con IVA

const BOT_USER = "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

// ticker del 13F -> ticker CEDEAR local. Solo difieren los que difieren.
const CEDEAR_DE = { BRK: "BRKB" };
const cedearDe = (tk13f) => CEDEAR_DE[tk13f] || tk13f;

let _tgChat = null;
async function tg(texto) {
  if (!TG_TOKEN) { log("[tg] sin token"); return; }
  if (_tgChat == null) {
    const { data } = await supabase.from("telegram_links")
      .select("chat_id").eq("user_id", BOT_USER).eq("enabled", true).maybeSingle();
    _tgChat = data?.chat_id || "";
  }
  if (!_tgChat) return;
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: _tgChat, text: texto, parse_mode: "HTML" }),
  }).catch((e) => log("[tg]", e.message));
}

const pesos = (n) => `$${Math.round(n).toLocaleString("es-AR")}`;

// ── Ranking 13F: [{tk13f, gestores, valor}] ─────────────────────────────
async function rankingConsenso() {
  const { data: gs } = await supabase.from("superinvestors").select("cik,last_report_date");
  const ultimo = new Map((gs || []).map((g) => [g.cik, g.last_report_date]));
  let holdings = [], desde = 0;
  for (;;) {
    const { data: h, error } = await supabase.from("si_holdings")
      .select("cik,report_date,ticker,value_usd").range(desde, desde + 999);
    if (error) throw new Error(error.message);
    if (!h || !h.length) break;
    holdings = holdings.concat(h);
    if (h.length < 1000) break;
    desde += 1000;
  }
  const porTicker = new Map();
  for (const h of holdings) {
    if (!h.ticker) continue;
    if (ultimo.get(h.cik) !== h.report_date) continue;  // solo el ultimo filing de cada gestor
    const e = porTicker.get(h.ticker) || { tk13f: h.ticker, gestores: new Set(), valor: 0 };
    e.gestores.add(h.cik);
    e.valor += Number(h.value_usd) || 0;
    porTicker.set(h.ticker, e);
  }
  return [...porTicker.values()]
    .map((e) => ({ tk13f: e.tk13f, gestores: e.gestores.size, valor: e.valor }))
    .sort((a, b) => b.gestores - a.gestores || b.valor - a.valor);
}

// Cartera objetivo: umbral = gestores del papel en el 6to puesto; entra todo
// el que iguale o supere (empates INCLUIDOS, regla de LP 13/09).
function carteraObjetivo(ranking) {
  if (ranking.length < N_PUESTOS) return null;
  const umbral = ranking[N_PUESTOS - 1].gestores;
  return { umbral, papeles: ranking.filter((r) => r.gestores >= umbral) };
}

// ── Precios CEDEAR (data912, fill pesimista) ────────────────────────────
async function preciosCedear() {
  const r = await fetch("https://data912.com/live/arg_cedears");
  if (!r.ok) throw new Error(`data912 ${r.status}`);
  const arr = await r.json();
  const px = new Map();
  for (const x of arr || []) {
    const sym = String(x.symbol || "").toUpperCase();
    px.set(sym, {
      buy: Number(x.px_ask) > 0 ? Number(x.px_ask) : Number(x.c) || null,
      sell: Number(x.px_bid) > 0 ? Number(x.px_bid) : Number(x.c) || null,
      last: Number(x.c) || null,
    });
  }
  return px;
}

async function comprar(t, px, hoy, motivo) {
  const ced = cedearDe(t.tk13f);
  const p = px.get(ced);
  if (!p?.buy) { log(`${ced}: sin precio data912 — queda para la proxima revision`); return false; }
  const qty = Math.floor(POR_EMPRESA_ARS / (p.buy * (1 + FEE_PATA)));
  if (qty < 1) { log(`${ced}: $1M no alcanza para 1 papel (${pesos(p.buy)})`); return false; }
  const fee = qty * p.buy * FEE_PATA;
  await supabase.from("paper_consenso_state").insert({
    ticker: ced, ticker_13f: t.tk13f, qty,
    entry_price: p.buy, entry_date: hoy, entry_gestores: t.gestores,
  });
  await supabase.from("paper_consenso_trades").insert({
    fecha: hoy, side: "buy", ticker: ced, qty, price: p.buy, fee_ars: Math.round(fee), motivo,
  });
  return { ced, qty, precio: p.buy };
}

(async () => {
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const dow = new Date().toLocaleDateString("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short" });
  if (dow === "Sat" || dow === "Sun") { log("finde: no opera"); return; }

  const ranking = await rankingConsenso();
  const objetivo = carteraObjetivo(ranking);
  if (!objetivo) { log(`ranking corto (${ranking.length}), no opero`); return; }
  const px = await preciosCedear();
  const { data: estadoRows } = await supabase.from("paper_consenso_state").select("*");
  const estado = estadoRows || [];

  if (estado.length === 0) {
    // ── ARMADO INICIAL: $1M por papel del objetivo ──────────────────────
    const compras = [];
    for (const t of objetivo.papeles) {
      const c = await comprar(t, px, hoy, `armado inicial: ${t.gestores} gestores (umbral ${objetivo.umbral})`);
      if (c) compras.push({ ...c, gestores: t.gestores });
    }
    if (!compras.length) { log("armado: sin precios, reintento en la proxima revision"); return; }
    const detalle = compras.map((c) => `${c.ced} ${c.qty} × ${pesos(c.precio)} (${c.gestores} gestores)`).join("\n");
    log(`ARMADO: ${compras.length} papeles`);
    await tg(`<b>PAPER CONSENSO · armado inicial</b> (simulado, ${pesos(POR_EMPRESA_ARS)} por empresa)\nUmbral: ${objetivo.umbral} gestores (6to puesto, empates incluidos → ${objetivo.papeles.length} papeles):\n${detalle}\nRevision semanal, lunes. Aviso cada rotacion.`);
  } else {
    // ── REVISION SEMANAL: sincronizar cartera con el objetivo ───────────
    const objSet = new Set(objetivo.papeles.map((t) => t.tk13f));
    const tengoSet = new Set(estado.map((s) => s.ticker_13f));
    const salen = estado.filter((s) => !objSet.has(s.ticker_13f));
    const entran = objetivo.papeles.filter((t) => !tengoSet.has(t.tk13f));
    const rankBy = new Map(ranking.map((r) => [r.tk13f, r]));

    for (const out of salen) {
      const p = px.get(out.ticker);
      if (!p?.sell) { log(`${out.ticker}: sin precio para vender, queda para la proxima`); continue; }
      const fee = out.qty * p.sell * FEE_PATA;
      const gAhora = rankBy.get(out.ticker_13f)?.gestores ?? 0;
      const motivo = `sale: ${gAhora} gestores, umbral ${objetivo.umbral}`;
      await supabase.from("paper_consenso_trades").insert({
        fecha: hoy, side: "sell", ticker: out.ticker, qty: out.qty, price: p.sell, fee_ars: Math.round(fee), motivo,
      });
      await supabase.from("paper_consenso_state").delete().eq("ticker", out.ticker);
      const pnl = (p.sell - Number(out.entry_price)) * out.qty - fee;
      log(`SALE ${out.ticker}: ${pesos(pnl)} realizado (${motivo})`);
      await tg(`<b>PAPER CONSENSO · sale ${out.ticker}</b>\n${motivo}. Vende ${out.qty} × ${pesos(p.sell)} · realizado ${pesos(pnl)} (entro a ${pesos(Number(out.entry_price))} el ${out.entry_date}).`);
    }
    for (const t of entran) {
      const c = await comprar(t, px, hoy, `entra: ${t.gestores} gestores, umbral ${objetivo.umbral}`);
      if (c) {
        log(`ENTRA ${c.ced}: ${c.qty} × ${pesos(c.precio)}`);
        await tg(`<b>PAPER CONSENSO · entra ${c.ced}</b>\n${t.gestores} gestores lo tienen (umbral ${objetivo.umbral}). Compra ${c.qty} × ${pesos(c.precio)} (~$1M).\n<i>El 13F llega con 45-166 dias de atraso: la rotacion sigue al ranking, no al precio.</i>`);
      }
    }
    if (!salen.length && !entran.length) log(`sin cambios: cartera = objetivo (${estado.length} papeles, umbral ${objetivo.umbral})`);
  }

  // ── SNAPSHOT de equity (cada corrida) ─────────────────────────────────
  const { data: estadoFinal } = await supabase.from("paper_consenso_state").select("*");
  let valor = 0; const detalle = [];
  for (const s of estadoFinal || []) {
    const p = px.get(s.ticker);
    const ref = p?.last ?? p?.sell ?? Number(s.entry_price);
    valor += s.qty * ref;
    detalle.push({ ticker: s.ticker, qty: Number(s.qty), px: ref, valor: Math.round(s.qty * ref) });
  }
  // caja acumulada = -(compras) + (ventas) - fees; el "capital" del paper es
  // lo efectivamente puesto ($1M por entrada), asi que el equity se lee como
  // valor de cartera + caja residual de rotaciones.
  const { data: tr } = await supabase.from("paper_consenso_trades").select("side,qty,price,fee_ars");
  let flujo = 0, invertidoBruto = 0;
  for (const t of tr || []) {
    const bruto = Number(t.qty) * Number(t.price);
    if (t.side === "buy") { flujo -= bruto + Number(t.fee_ars); invertidoBruto += bruto + Number(t.fee_ars); }
    else flujo += bruto - Number(t.fee_ars);
  }
  await supabase.from("paper_consenso_equity").upsert({
    fecha: hoy, equity_ars: Math.round(valor + flujo + invertidoBruto), cash_ars: Math.round(flujo + invertidoBruto), detalle,
  }, { onConflict: "fecha" });
  const pnlTotal = valor + flujo;   // valor actual + flujo neto (que arranca en -invertido)
  log(`snapshot: cartera ${pesos(valor)} · P&L total ${pesos(pnlTotal)}`);
})().catch((e) => { console.error(e); process.exit(1); });
