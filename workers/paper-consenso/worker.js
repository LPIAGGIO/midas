/**
 * Worker paper-consenso — paper trading del "consenso de superinversores".
 *
 * ESTRATEGIA (reglas fijadas en frio con LP, 13/09/2026):
 *   - Cartera = los 6 papeles con MAS GESTORES detras en los 13F del panel
 *     de superinversores (tabla superinvestors + si_holdings, ultimo filing
 *     de cada gestor). Desempate por valor agregado declarado.
 *   - ANTI-CHURN: para desplazar a un incumbente del top-6, el desafiante
 *     tiene que ganarle ESTRICTO (mas gestores; o igual y mas valor
 *     agregado). El empate lo retiene el que ya esta en cartera.
 *   - Equal-weight al armar; en cada rotacion, el producido de la venta va
 *     entero a la compra del entrante (sin rebalanceo continuo).
 *   - Fill pesimista: compra al ask, venta al bid (data912 arg_cedears).
 *   - Comision IOL Gold por pata (0,5% + derechos 0,05% + IVA = 0,6655%).
 *
 * EL ASTERISCO ES PARTE DEL EXPERIMENTO: el 13F llega con 45-166 dias de
 * atraso. Este paper mide si el consenso RANCIO de los grandes gestores
 * igual le gana al mercado — no asume que si.
 *
 * Corre 1x/dia habil en horario de mercado (pm2 cron). El dato 13F cambia
 * de verdad en las olas de filings (feb/may/ago/nov): entre olas el top-6
 * casi no se mueve y el worker solo snapshotea el equity.
 *
 * Capital paper: $10.000.000 ARS (constante abajo).
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

const CAPITAL_ARS = 10_000_000;
const N_TOP = 6;
const FEE_PATA = 0.005 * 1.21 + 0.0005 * 1.21;   // IOL Gold + derechos, con IVA = 0,6655%

// Usuario dueno de los avisos (LP) — mismo esquema que niveles-auto.
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

// ── Ranking 13F: [{tk13f, gestores, valor}] orden estable ───────────────
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

// ── Precios CEDEAR (data912, fill pesimista) ────────────────────────────
async function preciosCedear() {
  const r = await fetch("https://data912.com/live/arg_cedears");
  if (!r.ok) throw new Error(`data912 ${r.status}`);
  const arr = await r.json();
  const px = new Map();
  for (const x of arr || []) {
    const sym = String(x.symbol || "").toUpperCase();
    px.set(sym, {
      buy: Number(x.px_ask) > 0 ? Number(x.px_ask) : Number(x.c) || null,   // compra paga el ask
      sell: Number(x.px_bid) > 0 ? Number(x.px_bid) : Number(x.c) || null,  // venta cobra el bid
      last: Number(x.c) || null,
    });
  }
  return px;
}

// Top-6 con regla anti-churn: los incumbentes retienen el empate.
function topConAntiChurn(ranking, incumbentes) {
  const inSet = new Set(incumbentes);
  const orden = [...ranking].sort((a, b) => {
    const d = b.gestores - a.gestores || b.valor - a.valor;
    if (d !== 0) return d;
    // empate total: el incumbente primero
    return (inSet.has(b.tk13f) ? 1 : 0) - (inSet.has(a.tk13f) ? 1 : 0);
  });
  // ademas: un desafiante NO desplaza a un incumbente si empata en gestores
  // y no le gana en valor — eso ya lo resuelve el sort de arriba, porque el
  // orden (gestores, valor, incumbencia) es total.
  return orden.slice(0, N_TOP);
}

(async () => {
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const dow = new Date().toLocaleDateString("en-US", { timeZone: "America/Argentina/Buenos_Aires", weekday: "short" });
  if (dow === "Sat" || dow === "Sun") { log("finde: no opera"); return; }

  const ranking = await rankingConsenso();
  if (ranking.length < N_TOP) { log(`ranking corto (${ranking.length}), no opero`); return; }
  const { data: estadoRows } = await supabase.from("paper_consenso_state").select("*");
  const estado = estadoRows || [];
  const px = await preciosCedear();

  const rankBy = new Map(ranking.map((r) => [r.tk13f, r]));
  const incumbentes = estado.map((s) => s.ticker_13f);

  if (estado.length === 0) {
    // ── ARMADO INICIAL: equal-weight del capital en el top-6 ────────────
    const top = topConAntiChurn(ranking, []);
    const porPata = CAPITAL_ARS / N_TOP;
    let cash = CAPITAL_ARS;
    const compras = [];
    for (const t of top) {
      const ced = cedearDe(t.tk13f);
      const p = px.get(ced);
      if (!p?.buy) { log(`${ced}: sin precio data912 — ABORTO armado (probar proxima corrida)`); return; }
      const fee = porPata * FEE_PATA / (1 + FEE_PATA);
      const neto = porPata - fee;
      const qty = Math.floor(neto / p.buy);
      if (qty < 1) { log(`${ced}: no alcanza para 1 papel (${pesos(p.buy)})`); return; }
      const costo = qty * p.buy;
      cash -= costo + costo * FEE_PATA;
      compras.push({ t, ced, qty, precio: p.buy, fee: costo * FEE_PATA });
    }
    for (const c of compras) {
      await supabase.from("paper_consenso_state").insert({
        ticker: c.ced, ticker_13f: c.t.tk13f, qty: c.qty,
        entry_price: c.precio, entry_date: hoy, entry_gestores: c.t.gestores,
      });
      await supabase.from("paper_consenso_trades").insert({
        fecha: hoy, side: "buy", ticker: c.ced, qty: c.qty, price: c.precio,
        fee_ars: Math.round(c.fee), motivo: `armado inicial: ${c.t.gestores} gestores`,
      });
    }
    const detalle = compras.map((c) => `${c.ced} ${c.qty} × ${pesos(c.precio)} (${c.t.gestores} gestores)`).join("\n");
    await supabase.from("paper_consenso_equity").upsert({
      fecha: hoy, equity_ars: CAPITAL_ARS, cash_ars: Math.round(cash),
      detalle: compras.map((c) => ({ ticker: c.ced, qty: c.qty, px: c.precio, valor: Math.round(c.qty * c.precio) })),
    }, { onConflict: "fecha" });
    log(`ARMADO: ${compras.map((c) => c.ced).join(", ")} · caja ${pesos(cash)}`);
    await tg(`<b>PAPER CONSENSO · armado inicial</b> (simulado, ${pesos(CAPITAL_ARS)})\nLos 6 con mas gestores 13F detras:\n${detalle}\nRota solo cuando el ranking cambia. Aviso cada rotacion.`);
    return;
  }

  // ── ROTACION: comparar cartera actual vs top-6 anti-churn ─────────────
  const top = topConAntiChurn(ranking, incumbentes);
  const topSet = new Set(top.map((t) => t.tk13f));
  const salen = estado.filter((s) => !topSet.has(s.ticker_13f));
  const entran = top.filter((t) => !incumbentes.includes(t.tk13f));

  for (let i = 0; i < Math.min(salen.length, entran.length); i++) {
    const out = salen[i], inn = entran[i];
    const pOut = px.get(out.ticker), cedIn = cedearDe(inn.tk13f), pIn = px.get(cedIn);
    if (!pOut?.sell || !pIn?.buy) { log(`rotacion ${out.ticker}→${cedIn}: sin precio, la reintento manana`); continue; }
    const producido = out.qty * pOut.sell;
    const feeVenta = producido * FEE_PATA;
    const neto = producido - feeVenta;
    const qtyIn = Math.floor(neto / (pIn.buy * (1 + FEE_PATA)));
    if (qtyIn < 1) { log(`rotacion ${cedIn}: no alcanza para 1 papel`); continue; }
    const feeCompra = qtyIn * pIn.buy * FEE_PATA;
    const gOut = rankBy.get(out.ticker_13f)?.gestores ?? "?";
    const motivo = `sale ${out.ticker} (${gOut} gestores), entra ${cedIn} (${inn.gestores})`;
    await supabase.from("paper_consenso_trades").insert([
      { fecha: hoy, side: "sell", ticker: out.ticker, qty: out.qty, price: pOut.sell, fee_ars: Math.round(feeVenta), motivo },
      { fecha: hoy, side: "buy", ticker: cedIn, qty: qtyIn, price: pIn.buy, fee_ars: Math.round(feeCompra), motivo },
    ]);
    await supabase.from("paper_consenso_state").delete().eq("ticker", out.ticker);
    await supabase.from("paper_consenso_state").insert({
      ticker: cedIn, ticker_13f: inn.tk13f, qty: qtyIn,
      entry_price: pIn.buy, entry_date: hoy, entry_gestores: inn.gestores,
    });
    const pnlOut = (pOut.sell - Number(out.entry_price)) * out.qty - feeVenta;
    log(`ROTACION: ${motivo} · realizado ${out.ticker}: ${pesos(pnlOut)}`);
    await tg(`<b>PAPER CONSENSO · rotacion</b>\n${motivo}.\nVende ${out.qty} × ${pesos(pOut.sell)} (realizado ${pesos(pnlOut)}), compra ${qtyIn} × ${pesos(pIn.buy)}.\n<i>El 13F llega con 45-166 dias de atraso: la rotacion sigue al ranking, no al precio.</i>`);
  }

  // ── SNAPSHOT diario de equity ─────────────────────────────────────────
  const { data: estadoFinal } = await supabase.from("paper_consenso_state").select("*");
  let valor = 0; const detalle = [];
  for (const s of estadoFinal || []) {
    const p = px.get(s.ticker);
    const ref = p?.last ?? p?.sell ?? Number(s.entry_price);
    valor += s.qty * ref;
    detalle.push({ ticker: s.ticker, qty: Number(s.qty), px: ref, valor: Math.round(s.qty * ref) });
  }
  // caja = capital − costo historico neto (suma de trades)
  const { data: tr } = await supabase.from("paper_consenso_trades").select("side,qty,price,fee_ars");
  let cash = CAPITAL_ARS;
  for (const t of tr || []) {
    const bruto = Number(t.qty) * Number(t.price);
    cash += (t.side === "sell" ? bruto : -bruto) - Number(t.fee_ars);
  }
  await supabase.from("paper_consenso_equity").upsert({
    fecha: hoy, equity_ars: Math.round(valor + cash), cash_ars: Math.round(cash), detalle,
  }, { onConflict: "fecha" });
  log(`snapshot: cartera ${pesos(valor)} + caja ${pesos(cash)} = ${pesos(valor + cash)} (${(((valor + cash) / CAPITAL_ARS) - 1) * 100 > 0 ? "+" : ""}${((((valor + cash) / CAPITAL_ARS) - 1) * 100).toFixed(2)}%)`);
})().catch((e) => { console.error(e); process.exit(1); });
