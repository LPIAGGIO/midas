/**
 * Worker momentum-rotation — rotación mensual de la cartera momentum de
 * CEDEARs en IOL (Top-8 equal-weight, PLATA REAL).
 *
 * Las reglas frías salen de la tarea agendada
 * ~/.claude/scheduled-tasks/rebalanceo-momentum-cedears-iol/SKILL.md — este
 * worker las automatiza; la tarea de Claude queda como supervisión. En orden:
 *
 *   1. Día hábil BYMA o no opera (finde/feriado → aviso y termina).
 *   2. Top-8 FRESCO de momentum_signal (lo escribe paper-cedears a diario).
 *      Señal con más de 4 días NO se opera: rotar contra un objetivo viejo
 *      fue el bug del 16/07/2026.
 *   3. Tenencias reales del portfolio de IOL, NETAS del bot niveles-auto
 *      (comparten cuenta desde 04/09/2026): lo del bot no se vende y su
 *      reserva de cash no se gasta. El bot se lee de paper_iol_trades
 *      (modo='real', pending/open) y su cap de IOL_BOT_CAP_REAL del .env —
 *      este worker corre en el MISMO VPS con el MISMO .env que niveles-auto
 *      (symlink), así que el cap es siempre el vigente sin ssh de por medio.
 *   4. VENDE lo que salió del Top-8: al bid, en tramos si el nocional es
 *      grande, con guardia de precio (bid >2% abajo del cierre anterior →
 *      se saltea y se avisa). Espera el fill CONFIRMADO POR IOL.
 *   5. COMPRA equal-weight con el producido + la caja rotable: primero los
 *      DÓLARES (especie D), después los pesos al ask (spread >2% → saltea).
 *      Sin apalancamiento, todo a T1, límite siempre en tick.
 *
 * APORTE: la caja rotable (disponible ARS − reserva del bot) debería rondar
 * el aporte del mes (~$1,5M). Si da fuera del rango [APORTE_MIN, APORTE_MAX]
 * algo no cierra (el cap del bot quedó viejo, un depósito no entró, una
 * venta ajena liquidó): se CONGELA el despliegue de caja nueva — se rota
 * solo con el producido de las ventas — y se le avisa la cifra a LP.
 *
 * FILLS (lección del 14/09): una orden está ejecutada SOLO cuando IOL dice
 * terminada/ejecutada/cumplida con precioOperado. El precio de mercado
 * cruzando el límite NO es un fill: la orden pudo caerse, renumerarse o
 * quedar colgada. Nunca se asume.
 *
 * DRY-RUN: --dry-run o MOMENTUM_DRY_RUN=1 — arma el plan completo con los
 * libros vivos (ventas, compras, cantidades, límites en tick), lo loguea y
 * lo manda por Telegram marcado "DRY-RUN — nada ejecutado". Cero órdenes.
 */
"use strict";
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
if (typeof globalThis.WebSocket === "undefined") globalThis.WebSocket = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

const DRY_RUN = process.argv.includes("--dry-run") || process.env.MOMENTUM_DRY_RUN === "1";
const BOT_USER = process.env.IOL_BOT_USER || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const CAP_REAL = Number(process.env.IOL_BOT_CAP_REAL || 0);
const IOL_BASE = "https://api.invertironline.com";

const TOPN = 8;                       // Top-8 equal-weight
const SIGNAL_MAX_DIAS = 4;            // señal más vieja que esto no se opera
const APORTE_MIN = Number(process.env.MOMENTUM_APORTE_MIN || 1_000_000);
const APORTE_MAX = Number(process.env.MOMENTUM_APORTE_MAX || 2_000_000);
const GUARDIA_VENTA = 0.02;           // bid >2% bajo el cierre anterior: no se vende
const SPREAD_MAX = 0.02;              // ask >2% sobre el bid: no se compra
// "En tramos si el nocional es grande": el umbral no está cuantificado en la
// regla; $3M por orden es ~el sleeve típico y no mueve el libro de un CEDEAR
// líquido. Ajustable por env si LP quiere otra cosa.
const TRAMO_MAX_ARS = Number(process.env.MOMENTUM_TRAMO_ARS || 3_000_000);
const USD_MIN = 100;                  // menos de US$100 no vale una orden
const FILL_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 15 * 1000;
// Tolerancia del reparto del sobrante: cuando un nombre caro (tipo MU) no
// absorbe su sleeve, el resto puede pasarse hasta 10% del sleeve — más que
// eso ya no es "repartir parejo", es concentrar.
const OVERSHOOT_MAX = 0.10;

// ── Calendario BYMA (porteado de futures-settlement; mantener en sync) ──
// IMPORTANTE: agregar los feriados 2027 antes de fin de 2026.
const BYMA_HOLIDAYS = new Set([
  "2026-01-01", "2026-02-16", "2026-02-17", "2026-03-23", "2026-03-24",
  "2026-04-02", "2026-04-03", "2026-05-01", "2026-05-25", "2026-06-15",
  "2026-07-09", "2026-07-10", "2026-08-17", "2026-10-12", "2026-11-06",
  "2026-12-07", "2026-12-08", "2026-12-24", "2026-12-25", "2026-12-31",
]);
const diaAr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
function esDiaHabil(iso) {
  if (BYMA_HOLIDAYS.has(iso)) return false;
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return dow !== 0 && dow !== 6;
}

const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const usd = (n) => "US$" + (Math.round(n * 100) / 100).toLocaleString("es-AR");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Telegram (mismo patrón que paper-consenso: fallo de TG jamás frena) ──
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
let _tgChat = null;
async function tg(texto) {
  if (!TG_TOKEN) { log("[tg] sin token"); return; }
  try {
    if (_tgChat == null) {
      const { data } = await supabase.from("telegram_links")
        .select("chat_id").eq("user_id", BOT_USER).eq("enabled", true).maybeSingle();
      _tgChat = data?.chat_id || "";
    }
    if (!_tgChat) return;
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: _tgChat, text: texto, parse_mode: "HTML" }),
    });
  } catch (e) { log("[tg]", e.message); }
}

// ── IOL: token, cotización, órdenes (patrones de niveles-auto) ──────────
async function iolToken() {
  const { data } = await supabase.from("linked_brokers")
    .select("access_token,access_expires_at").eq("user_id", BOT_USER).eq("broker", "iol").maybeSingle();
  if (!data?.access_token) throw new Error("sin access_token de IOL");
  if (data.access_expires_at && new Date(data.access_expires_at) <= new Date())
    throw new Error("access_token de IOL vencido (lo revive el keep-alive)");
  return data.access_token;
}

/* Ticks: BYMA exige múltiplos de la "alteración mínima" y el tick es POR
 * INSTRUMENTO (rechazos reales: SNDK 04/09, XOM 09/09). Fuente primaria: el
 * gcd del libro de puntas del propio papel; fallback: la escalera medida. */
function gcdInt(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
function tickTabla(pxArs) {
  const px = Number(pxArs) || 0;
  return px >= 50000 ? 25 : px >= 25000 ? 20 : px >= 10000 ? 10 : px >= 1000 ? 2.5 : 1;
}
function tickDePuntas(puntas, pxRef) {
  const centavos = new Set();
  for (const p of puntas || []) {
    for (const v of [p.precioCompra, p.precioVenta]) {
      const c = Math.round(Number(v) * 100);
      if (Number.isFinite(c) && c > 0) centavos.add(c);
    }
  }
  const unicos = [...centavos];
  if (unicos.length < 3) return null;
  let g = unicos[0];
  for (let i = 1; i < unicos.length; i++) g = gcdInt(g, unicos[i]);
  const tick = g / 100;
  if (!(tick >= 0.01) || tick > (pxRef || Math.min(...unicos) / 100) * 0.005) return null;
  return tick;
}
/* VENTA → piso (el límite es el mínimo aceptable: pisar garantiza el cruce,
 * perder un tick es más barato que quedarse comprado). COMPRA → techo: acá
 * se quiere el fill del rebalanceo, y un límite un tick ARRIBA del ask sigue
 * ejecutando al ask (el límite es el máximo, no el precio). Es la única
 * desviación deliberada del "siempre piso" de niveles-auto, que pisa porque
 * sus órdenes descansan en el libro esperando un nivel. */
const pisoTick = (px, t) => Math.floor(Math.round(px * 100) / Math.round(t * 100)) * Math.round(t * 100) / 100;
const techoTick = (px, t) => Math.ceil(Math.round(px * 100) / Math.round(t * 100)) * Math.round(t * 100) / 100;

/* Libro de un símbolo vía IOL: bid/ask de la primera punta, cierre anterior
 * (para la guardia de venta) y tick real. data912 de respaldo solo para
 * bid/ask/último — sin cierre anterior no hay guardia, y en ese caso la
 * venta se saltea (preferible a vender en un hueco sin referencia). */
async function libroIol(simbolo, token) {
  const r = await fetch(`${IOL_BASE}/api/v2/bCBA/Titulos/${encodeURIComponent(simbolo)}/Cotizacion`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j) return null;
  const p0 = (j.puntas || [])[0] || {};
  const bid = Number(p0.precioCompra) || null;
  const ask = Number(p0.precioVenta) || null;
  const ultimo = Number(j.ultimoPrecio) || null;
  return {
    bid, ask, ultimo,
    cierreAnterior: Number(j.cierreAnterior) || null,
    tick: tickDePuntas(j.puntas, ultimo || ask || bid),
  };
}
let _d912 = null;
async function libroData912(simbolo) {
  if (!_d912) {
    const r = await fetch("https://data912.com/live/arg_cedears", { headers: UA });
    const arr = r.ok ? await r.json().catch(() => []) : [];
    _d912 = new Map();
    for (const x of arr || []) {
      const s = String(x.symbol || "").toUpperCase();
      if (s) _d912.set(s, {
        bid: Number(x.px_bid) > 0 ? Number(x.px_bid) : null,
        ask: Number(x.px_ask) > 0 ? Number(x.px_ask) : null,
        ultimo: Number(x.c) > 0 ? Number(x.c) : null,
        cierreAnterior: null, tick: null,
      });
    }
  }
  return _d912.get(String(simbolo).toUpperCase()) || null;
}
async function libro(simbolo, token) {
  const l = await libroIol(simbolo, token).catch(() => null);
  if (l && (l.bid || l.ask || l.ultimo)) return l;
  return await libroData912(simbolo);
}

async function iolOrden(lado, simbolo, cantidad, precio, token) {
  const url = `${IOL_BASE}/api/v2/operar/${lado === "compra" ? "Comprar" : "Vender"}`;
  const body = {
    mercado: "bCBA", simbolo, cantidad, precio,
    plazo: "t1", validez: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19),
    tipoOrden: "precioLimite",
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.ok === false) {
    // La DDJJ por el canal REST no tiene el flujo del MCP (get_ddjj/accept):
    // si IOL la exige acá, la orden no sale y hay que avisar — no adivinar.
    const msg = JSON.stringify(j).slice(0, 300);
    if (/ddjj|declaraci/i.test(msg)) throw new Error(`IOL exige DDJJ por API en ${simbolo} — no hay flujo REST para aceptarla: ${msg}`);
    throw new Error(`IOL ${lado} ${simbolo} @$${precio}: ${r.status} ${msg}`);
  }
  return String(j?.numeroOperacion ?? j?.numero ?? j?.id ?? "");
}
async function iolCancelar(numero, token) {
  // Endpoint medido 10/09: DELETE /api/v2/operaciones/{n}. La ruta
  // /operar/Cancelar devuelve 500 SIEMPRE — no usarla.
  const r = await fetch(`${IOL_BASE}/api/v2/operaciones/${encodeURIComponent(numero)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`IOL cancelar ${numero}: ${r.status}`);
}
async function iolDetalle(numero, token) {
  const r = await fetch(`${IOL_BASE}/api/v2/operaciones/${encodeURIComponent(numero)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

/* Espera el fill de una orden. CONFIRMADO solo por IOL: estado terminada/
 * ejecutada/cumplida CON precioOperado (14/09). Timeout → se cancela y se
 * sigue sin ese tramo. Ojo: IOL cancela y renumera órdenes en el cierre de
 * rueda, pero esta rotación es intradía con límites cruzables — si en 10
 * minutos no llenó, algo raro pasa y mejor bajarla que perseguirla. */
async function esperarFill(numero, token, desc) {
  const desde = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    const j = await iolDetalle(numero, token);
    const estado = String(j?.estadoActual ?? j?.estado ?? "");
    // Lo ejecutado vive en el array "operaciones" (medido 15/09 con la orden
    // 188897671): no existe precioOperado/cantidadOperada en el detalle REST.
    const ops = Array.isArray(j?.operaciones) ? j.operaciones : [];
    const qtyOper = ops.reduce((s, o) => s + (Number(o.cantidad) || 0), 0);
    const pxOper = qtyOper > 0
      ? ops.reduce((s, o) => s + (Number(o.cantidad) || 0) * (Number(o.precio) || 0), 0) / qtyOper
      : 0;
    // "Parcialmente Terminada" es un estado TRANSITORIO mientras la orden
    // sigue llenándose (AVGO 15/09: el regex viejo lo tomó por final con 7 de
    // 26 ejecutados y el producido quedó en un cuarto). Final es terminada/
    // ejecutada/cumplida SIN "parcial" — con parcial, se sigue esperando.
    if (/terminada|ejecutada|cumplida/i.test(estado) && !/parcial/i.test(estado) && pxOper > 0)
      return { ok: true, px: pxOper, qty: qtyOper, estado };
    if (/cancelada|rechazada/i.test(estado))
      return { ok: false, motivo: `orden ${estado}`, estado };
    if (Date.now() - desde > FILL_TIMEOUT_MS) {
      log(`[fill] ${desc}: timeout ${FILL_TIMEOUT_MS / 60000} min (estado "${estado || "?"}") — cancelo`);
      await iolCancelar(numero, token).catch((e) => log(`[fill] no pude cancelar ${numero}: ${e.message}`));
      // Si operó parcial antes del timeout, ese parcial es real y se cuenta.
      const parcial = pxOper > 0 && qtyOper > 0 ? { px: pxOper, qty: qtyOper } : null;
      return { ok: false, motivo: "timeout", parcial, estado };
    }
  }
}

// ── Cuenta: cash y portfolio ────────────────────────────────────────────
async function cashIol(token) {
  const r = await fetch(`${IOL_BASE}/api/v2/estadocuenta`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`estadocuenta ${r.status}`);
  const j = await r.json().catch(() => null);
  let ars = 0, usdMep = 0;
  for (const c of j?.cuentas || []) {
    const tipo = String(c.tipo || "").toLowerCase();
    const disp = Number(c.disponible) || 0;
    // Solo las cuentas "inversión Argentina": pesos y dólares MEP. La de
    // Estados Unidos no participa del momentum.
    if (tipo.includes("argentina") && tipo.includes("peso")) ars += disp;
    else if (tipo.includes("argentina") && tipo.includes("dolar")) usdMep += disp;
  }
  return { ars, usd: usdMep };
}

/* CEDEARs del portfolio IOL. IOL puede reportar la especie en dólares por
 * separado (base+"D"); se agrupa por base SOLO si la base es un símbolo
 * conocido (Top-8 o el propio portfolio) — el sufijo a ciegas rompería
 * tickers que legítimamente terminan en D (AMD). */
async function cedearsIol(token, top8) {
  const r = await fetch(`${IOL_BASE}/api/v2/portafolio/argentina`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`portafolio ${r.status}`);
  const j = await r.json().catch(() => null);
  const filas = [];
  for (const a of j?.activos || []) {
    const t = a.titulo || {};
    if (!String(t.tipo || "").toLowerCase().includes("cedear")) continue;
    const sym = String(t.simbolo || "").toUpperCase();
    const qty = Math.floor(Number(a.cantidad) || 0);
    if (!sym || qty <= 0) continue;
    filas.push({ sym, qty, ultimo: Number(a.ultimoPrecio) || null, esUsd: String(t.moneda || "").toLowerCase().includes("dolar") });
  }
  const conocidos = new Set([...top8, ...filas.map((f) => f.sym)]);
  for (const f of filas) {
    f.base = f.sym.endsWith("D") && conocidos.has(f.sym.slice(0, -1)) ? f.sym.slice(0, -1) : f.sym;
  }
  return filas;
}

/* Regla de convivencia: lo del bot niveles-auto no es del momentum.
 * Tenencias: sus qty open se restan por ticker (especie en pesos, que es la
 * que el bot opera). Caja: reserva = CAP_REAL − nocional comprometido. */
async function libroDelBot() {
  const { data, error } = await supabase.from("paper_iol_trades")
    .select("ticker,qty,status,px_ars_orden,px_ars_entrada")
    .eq("modo", "real").in("status", ["pending", "open"]);
  if (error) throw new Error(`paper_iol_trades: ${error.message}`);
  const qtyPorTicker = new Map();
  let nocional = 0;
  for (const t of data || []) {
    const q = Number(t.qty) || 0;
    if (t.status === "open") {
      qtyPorTicker.set(t.ticker, (qtyPorTicker.get(t.ticker) || 0) + q);
      nocional += q * (Number(t.px_ars_entrada) || 0);
    } else {
      // Las PENDIENTES también cuentan: IOL escrowea el cash de una orden
      // apoyada y lo saca del disponible (medido 14/09: 3 órdenes pendientes
      // por ~$7M y el disponible bajó de $8,5M a $1,46M). O sea el disponible
      // ya viene neto de las pendientes, y la reserva del bot es lo que le
      // queda por comprometer: cap − (abierto + apoyado).
      nocional += q * (Number(t.px_ars_orden) || 0);
    }
  }
  return { qtyPorTicker, reserva: Math.max(0, CAP_REAL - nocional), nocional, filas: (data || []).length };
}

async function cclRef() {
  const r = await fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: UA }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  return Number(j?.venta) || Number(j?.compra) || null;
}

// ── Señal ───────────────────────────────────────────────────────────────
async function senalMomentum() {
  const { data, error } = await supabase.from("momentum_signal")
    .select("top8,as_of_date").eq("id", "current").maybeSingle();
  if (error) throw new Error(`momentum_signal: ${error.message}`);
  if (!data?.top8?.length) throw new Error("momentum_signal vacía — ¿corrió paper-cedears?");
  const edadDias = (Date.parse(diaAr()) - Date.parse(data.as_of_date)) / 86400000;
  if (edadDias > SIGNAL_MAX_DIAS)
    throw new Error(`señal vieja (${data.as_of_date}, ${Math.round(edadDias)} días) — el worker paper-cedears no está corriendo. NO se rota.`);
  return { top8: data.top8.map((t) => String(t).toUpperCase()), asOf: data.as_of_date };
}

// ── Plan de compras equal-weight ────────────────────────────────────────
// valorPorBase: valor a mercado (ARS) de lo que se MANTIENE del Top-8.
// Devuelve compras USD (especie D) y ARS, con límite ya en tick.
function planCompras(top8, valorPorBase, cajaArs, cajaUsd, ccl, libros) {
  const mantengo = top8.reduce((s, b) => s + (valorPorBase.get(b) || 0), 0);
  const total = mantengo + cajaArs + (ccl ? cajaUsd * ccl : 0);
  const sleeve = total / TOPN;
  const deficit = new Map(top8.map((b) => [b, Math.max(0, sleeve - (valorPorBase.get(b) || 0))]));
  const porDeficit = () => [...top8].sort((a, b) => (deficit.get(b) || 0) - (deficit.get(a) || 0));
  const comprasUsd = [], comprasArs = [], saltos = [];

  // DÓLARES PRIMERO (regla del rearmado): especie D contra su propio libro
  // en USD. Sin CCL no se puede dimensionar → el USD queda sin desplegar.
  if (ccl && cajaUsd >= USD_MIN) {
    for (const b of porDeficit()) {
      const lb = libros.get(b + "D");
      if (!lb?.ask || cajaUsd < USD_MIN) continue;
      const tick = lb.tick || 0.01;
      const lim = techoTick(lb.ask, tick);
      const qty = Math.floor(Math.min((deficit.get(b) || 0) / ccl, cajaUsd) / lim);
      if (qty < 1) continue;
      comprasUsd.push({ sym: b + "D", base: b, qty, limit: lim, moneda: "USD" });
      cajaUsd -= qty * lim;
      deficit.set(b, (deficit.get(b) || 0) - qty * lim * ccl);
    }
  }

  // PESOS al ask. Primera pasada: cada sleeve hasta donde entra. Después el
  // sobrante (nombres caros que no absorben lo suyo, tipo MU) se reparte de
  // a 1 unidad entre el resto, sin pasarse más de OVERSHOOT_MAX del sleeve.
  const comprar = (b, qty, lim) => {
    const ya = comprasArs.find((c) => c.sym === b);
    if (ya) ya.qty += qty; else comprasArs.push({ sym: b, base: b, qty, limit: lim, moneda: "ARS" });
    cajaArs -= qty * lim;
    deficit.set(b, (deficit.get(b) || 0) - qty * lim);
  };
  const libroOk = (b) => {
    const lb = libros.get(b);
    if (!lb?.ask) { saltos.push(`${b}: sin ask`); return null; }
    if (lb.bid > 0 && (lb.ask - lb.bid) / lb.bid > SPREAD_MAX) {
      saltos.push(`${b}: spread ${(((lb.ask - lb.bid) / lb.bid) * 100).toFixed(1)}% > ${SPREAD_MAX * 100}%`);
      return null;
    }
    return { lim: techoTick(lb.ask, lb.tick || tickTabla(lb.ask)) };
  };
  const saltados = new Set();
  for (const b of porDeficit()) {
    const l = libroOk(b);
    if (!l) { saltados.add(b); continue; }
    const qty = Math.floor(Math.min(deficit.get(b) || 0, cajaArs) / l.lim);
    if (qty >= 1) comprar(b, qty, l.lim);
  }
  for (let i = 0; i < 200; i++) {
    let mejor = null;
    for (const b of top8) {
      if (saltados.has(b)) continue;
      const lb = libros.get(b);
      const lim = lb?.ask ? techoTick(lb.ask, lb.tick || tickTabla(lb.ask)) : null;
      if (!lim || lim > cajaArs) continue;
      if ((deficit.get(b) || 0) - lim < -sleeve * OVERSHOOT_MAX) continue;
      if (!mejor || (deficit.get(b) || 0) > (deficit.get(mejor.b) || 0)) mejor = { b, lim };
    }
    if (!mejor) break;
    comprar(mejor.b, 1, mejor.lim);
  }
  return { sleeve, total, comprasUsd, comprasArs, saltos, sobranteArs: cajaArs, sobranteUsd: cajaUsd };
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  const hoy = diaAr();
  const modo = DRY_RUN ? "DRY-RUN" : "REAL";
  log(`rotación momentum ${hoy} · modo ${modo}`);

  if (!esDiaHabil(hoy)) {
    log("BYMA cerrado (finde/feriado): no se rota hoy");
    await tg(`<b>MOMENTUM · rotación NO corrió</b> (${hoy})\nBYMA cerrado (finde/feriado). Correla a mano el próximo hábil: <code>pm2 restart momentum-rotation</code> (o esperá que la tarea de Claude la levante).`);
    return;
  }
  /* VENTANA HORARIA (solo modo real): la rotación opera 10:30-13:00 ART.
   * PM2 ejecuta el proceso al registrarlo y lo resucita en cada reboot del
   * VPS — sin esta ventana, un reboot a cualquier hora dispararía una
   * rotación con el libro en cualquier estado. Retry manual fuera de hora:
   * --force (a conciencia). El dry-run corre a cualquier hora. */
  const horaAr = Number(new Date().toLocaleString("en-US", {
    timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hour12: false,
  }));
  const minAr = Number(new Date().toLocaleString("en-US", {
    timeZone: "America/Argentina/Buenos_Aires", minute: "2-digit",
  }));
  const enVentana = (horaAr > 10 || (horaAr === 10 && minAr >= 30)) && horaAr < 13;
  if (!DRY_RUN && !enVentana && !process.argv.includes("--force")) {
    log(`fuera de la ventana de rotación (10:30-13:00 ART, son las ${horaAr}:${String(minAr).padStart(2, "0")}): no opero`);
    return;
  }
  if (!(CAP_REAL > 0)) {
    // Sin el cap del bot no se puede calcular la reserva y la regla de
    // convivencia es sagrada: mejor no operar que pisarle el cash al bot.
    throw new Error("IOL_BOT_CAP_REAL no está en el .env — sin eso no hay reserva del bot ni caja rotable. No opero.");
  }

  const { top8, asOf } = await senalMomentum();
  log(`Top-8 (${asOf}): ${top8.join(", ")}`);

  const token = await iolToken();
  const [filas, bot, cash0, ccl] = await Promise.all([
    cedearsIol(token, top8), libroDelBot(), cashIol(token), cclRef(),
  ]);

  // Netear el bot: sus qty open salen de la especie en PESOS de cada ticker.
  const tenencias = [];   // {sym, base, qty (neta), esUsd, ultimo}
  for (const f of filas) {
    let qty = f.qty;
    if (!f.esUsd) {
      const delBot = bot.qtyPorTicker.get(f.sym) || 0;
      qty = Math.max(0, qty - delBot);
      if (delBot > 0) log(`${f.sym}: ${f.qty} en cuenta, ${delBot} del bot → ${qty} del momentum`);
    }
    if (qty > 0) tenencias.push({ ...f, qty });
  }

  const cajaRotable = Math.max(0, cash0.ars - bot.reserva);
  const congelada = cajaRotable < APORTE_MIN || cajaRotable > APORTE_MAX;
  log(`cash ARS ${pesos(cash0.ars)} · reserva bot ${pesos(bot.reserva)} (cap ${pesos(CAP_REAL)} − nocional ${pesos(bot.nocional)}) → caja rotable ${pesos(cajaRotable)} · USD ${usd(cash0.usd)}`);
  if (congelada) {
    log(`SANITY: caja rotable fuera de [${pesos(APORTE_MIN)}, ${pesos(APORTE_MAX)}] — se CONGELA el despliegue de caja nueva (solo producido de ventas)`);
  }

  // Libros de todo lo que se toca: lo que se vende + Top-8 (y su especie D).
  const libros = new Map();
  const simbolos = new Set();
  for (const t of tenencias) if (!top8.includes(t.base)) simbolos.add(t.sym);
  for (const b of top8) { simbolos.add(b); if (cash0.usd >= USD_MIN) simbolos.add(b + "D"); }
  for (const s of simbolos) {
    const l = await libro(s, token);
    if (l) libros.set(s, l);
  }

  // ── PLAN DE VENTAS: todo CEDEAR del momentum que salió del Top-8 ──────
  const ventas = [], ventasSalteadas = [];
  for (const t of tenencias) {
    if (top8.includes(t.base)) continue;
    const lb = libros.get(t.sym);
    if (!lb?.bid) { ventasSalteadas.push(`${t.sym}: sin bid — no se vende a ciegas`); continue; }
    if (!lb.cierreAnterior) { ventasSalteadas.push(`${t.sym}: sin cierre anterior (guardia imposible) — se saltea`); continue; }
    if (lb.bid < lb.cierreAnterior * (1 - GUARDIA_VENTA)) {
      ventasSalteadas.push(`${t.sym}: bid ${pesos(lb.bid)} está ${(((lb.cierreAnterior - lb.bid) / lb.cierreAnterior) * 100).toFixed(1)}% bajo el cierre ${pesos(lb.cierreAnterior)} — guardia de precio`);
      continue;
    }
    const tick = lb.tick || tickTabla(lb.bid);
    const lim = pisoTick(lb.bid, tick);
    // Tramos: ninguna orden por más de TRAMO_MAX_ARS de nocional.
    const maxQty = Math.max(1, Math.floor(TRAMO_MAX_ARS / lim));
    let resta = t.qty;
    while (resta > 0) {
      const q = Math.min(resta, maxQty);
      ventas.push({ sym: t.sym, qty: q, limit: lim, esUsd: t.esUsd, nocional: q * lim });
      resta -= q;
    }
  }

  // ── DRY-RUN: plan estimado de compras con aforo 85% sobre el producido ──
  if (DRY_RUN) {
    const producidoEst = ventas.filter((v) => !v.esUsd).reduce((s, v) => s + v.nocional, 0);
    const budgetArs = (congelada ? 0 : cajaRotable) + producidoEst * 0.85;
    const valorPorBase = new Map();
    for (const t of tenencias) {
      if (!top8.includes(t.base)) continue;
      const lb = libros.get(t.sym);
      const px = lb?.ultimo || lb?.bid || t.ultimo || 0;
      const enArs = t.esUsd && ccl ? px * ccl : px;
      valorPorBase.set(t.base, (valorPorBase.get(t.base) || 0) + t.qty * enArs);
    }
    const plan = planCompras(top8, valorPorBase, budgetArs, congelada ? 0 : cash0.usd, ccl, libros);
    const fmtV = ventas.map((v) => `  VENDER ${v.qty} ${v.sym} lim ${v.esUsd ? usd(v.limit) : pesos(v.limit)}`).join("\n") || "  (nada sale del Top-8)";
    const fmtCU = plan.comprasUsd.map((c) => `  COMPRAR ${c.qty} ${c.sym} lim ${usd(c.limit)}`).join("\n");
    const fmtCA = plan.comprasArs.map((c) => `  COMPRAR ${c.qty} ${c.sym} lim ${pesos(c.limit)}`).join("\n") || "  (sin compras)";
    log(`PLAN ventas:\n${fmtV}`);
    if (ventasSalteadas.length) log(`ventas salteadas:\n  ${ventasSalteadas.join("\n  ")}`);
    log(`PLAN compras (sleeve ${pesos(plan.sleeve)}, budget ARS ${pesos(budgetArs)}${congelada ? " — caja nueva CONGELADA" : ""}):\n${[fmtCU, fmtCA].filter(Boolean).join("\n")}`);
    if (plan.saltos.length) log(`compras salteadas:\n  ${plan.saltos.join("\n  ")}`);
    log(`sobrante estimado: ${pesos(plan.sobranteArs)} + ${usd(plan.sobranteUsd)}`);
    await tg(
      `<b>MOMENTUM · DRY-RUN — nada ejecutado</b> (${hoy})\n` +
      `Top-8 (${asOf}): ${top8.join(", ")}\n` +
      `Caja rotable: ${pesos(cajaRotable)}${congelada ? ` — FUERA del rango ${pesos(APORTE_MIN)}-${pesos(APORTE_MAX)}: caja nueva congelada` : ""} · USD ${usd(cash0.usd)}\n\n` +
      `<b>Ventas:</b>\n${fmtV}\n${ventasSalteadas.length ? `Salteadas:\n  ${ventasSalteadas.join("\n  ")}\n` : ""}\n` +
      `<b>Compras</b> (sleeve ${pesos(plan.sleeve)}, producido estimado con aforo 85%):\n${[fmtCU, fmtCA].filter(Boolean).join("\n")}\n` +
      `${plan.saltos.length ? `Salteadas: ${plan.saltos.join(" · ")}\n` : ""}` +
      `Sobrante estimado: ${pesos(plan.sobranteArs)}` + (plan.sobranteUsd > 0 ? ` + ${usd(plan.sobranteUsd)}` : "")
    );
    return;
  }

  // ── REAL: ventas primero, con fills confirmados ───────────────────────
  const resumen = [];
  if (congelada) {
    await tg(`<b>MOMENTUM · OJO con la caja</b> (${hoy})\nLa caja rotable dio ${pesos(cajaRotable)}, fuera del rango ${pesos(APORTE_MIN)}-${pesos(APORTE_MAX)} esperado para el aporte. NO despliego caja nueva: roto solo con el producido de ventas. Revisá el cap del bot / el depósito.`);
  }
  for (const v of ventas) {
    try {
      const num = await iolOrden("venta", v.sym, v.qty, v.limit, token);
      log(`VENTA ${v.sym} ×${v.qty} lim ${v.limit} → orden ${num}`);
      const fill = await esperarFill(num, token, `venta ${v.sym}`);
      if (fill.ok || fill.parcial) {
        const px = fill.ok ? fill.px : fill.parcial.px;
        const q = fill.ok ? (fill.qty || v.qty) : fill.parcial.qty;
        v.fill = { px, qty: q };
        resumen.push(`Vendí ${q} ${v.sym} a ${v.esUsd ? usd(px) : pesos(px)}${fill.ok ? "" : " (PARCIAL, timeout)"}`);
        await tg(`<b>MOMENTUM · venta ejecutada</b>\n${v.sym}: ${q} × ${v.esUsd ? usd(px) : pesos(px)}${fill.ok ? "" : " (parcial — el resto se canceló por timeout)"}`);
      } else {
        resumen.push(`Venta ${v.sym} SIN fill (${fill.motivo}) — cancelada`);
        await tg(`<b>MOMENTUM · venta sin fill</b>\n${v.sym} ×${v.qty}: ${fill.motivo}. Orden cancelada; ese papel queda para el próximo hábil.`);
      }
    } catch (e) {
      log(`VENTA ${v.sym} FALLÓ: ${e.message}`);
      resumen.push(`Venta ${v.sym} FALLÓ: ${e.message}`);
      await tg(`<b>MOMENTUM · FALLO venta ${v.sym}</b>\n${e.message}`);
    }
  }
  for (const s of ventasSalteadas) resumen.push(`Salteada: ${s}`);
  if (ventasSalteadas.length)
    await tg(`<b>MOMENTUM · ventas salteadas</b>\n${ventasSalteadas.join("\n")}\nQuedan para el próximo día hábil.`);

  // Caja POST-ventas leída de IOL (el disponible ya trae el aforo ~85% de
  // T+1 aplicado — no se estima, se lee). La reserva del bot se resta SIEMPRE.
  const cash1 = await cashIol(token);
  const cajaArsPost = Math.max(0, cash1.ars - bot.reserva);
  const producido = ventas.reduce((s, v) => s + (v.fill && !v.esUsd ? v.fill.px * v.fill.qty : 0), 0);
  // Congelada: nada de caja nueva — el budget es el producido de HOY (con el
  // tope de lo que IOL efectivamente muestra disponible neto de la reserva).
  const budgetArs = congelada ? Math.min(cajaArsPost, producido * 0.85) : cajaArsPost;
  const budgetUsd = congelada ? 0 : cash1.usd;
  log(`post-ventas: disponible ARS ${pesos(cash1.ars)} → budget ${pesos(budgetArs)}${congelada ? " (congelada)" : ""} · USD ${usd(budgetUsd)}`);

  // Valor a mercado de lo que se mantiene del Top-8 (para el sleeve).
  const valorPorBase = new Map();
  for (const t of tenencias) {
    if (!top8.includes(t.base)) continue;
    const lb = libros.get(t.sym);
    const px = lb?.ultimo || lb?.bid || t.ultimo || 0;
    const enArs = t.esUsd && ccl ? px * ccl : px;
    valorPorBase.set(t.base, (valorPorBase.get(t.base) || 0) + t.qty * enArs);
  }
  const plan = planCompras(top8, valorPorBase, budgetArs, budgetUsd, ccl, libros);
  log(`compras: sleeve ${pesos(plan.sleeve)} · ${plan.comprasUsd.length} en USD + ${plan.comprasArs.length} en ARS`);

  for (const c of [...plan.comprasUsd, ...plan.comprasArs]) {
    const fmt = c.moneda === "USD" ? usd : pesos;
    try {
      const num = await iolOrden("compra", c.sym, c.qty, c.limit, token);
      log(`COMPRA ${c.sym} ×${c.qty} lim ${c.limit} → orden ${num}`);
      const fill = await esperarFill(num, token, `compra ${c.sym}`);
      if (fill.ok || fill.parcial) {
        const px = fill.ok ? fill.px : fill.parcial.px;
        const q = fill.ok ? (fill.qty || c.qty) : fill.parcial.qty;
        resumen.push(`Compré ${q} ${c.sym} a ${fmt(px)}${fill.ok ? "" : " (PARCIAL, timeout)"}`);
        await tg(`<b>MOMENTUM · compra ejecutada</b>\n${c.sym}: ${q} × ${fmt(px)}${fill.ok ? "" : " (parcial — el resto se canceló por timeout)"}`);
      } else {
        resumen.push(`Compra ${c.sym} SIN fill (${fill.motivo}) — cancelada`);
        await tg(`<b>MOMENTUM · compra sin fill</b>\n${c.sym} ×${c.qty}: ${fill.motivo}. La caja queda; completá cuando liquide o el próximo hábil.`);
      }
    } catch (e) {
      log(`COMPRA ${c.sym} FALLÓ: ${e.message}`);
      resumen.push(`Compra ${c.sym} FALLÓ: ${e.message}`);
      await tg(`<b>MOMENTUM · FALLO compra ${c.sym}</b>\n${e.message}`);
    }
  }
  for (const s of plan.saltos) resumen.push(`Compra salteada: ${s}`);

  const cashFin = await cashIol(token).catch(() => null);
  const sinCambios = !ventas.length && !plan.comprasUsd.length && !plan.comprasArs.length;
  await tg(
    `<b>MOMENTUM · rotación ${hoy} — resumen</b>\n` +
    `Top-8 (${asOf}): ${top8.join(", ")}\n` +
    (sinCambios ? "No hubo que rotar: la cartera ya está en el Top-8 y no hay caja para desplegar.\n"
      : resumen.map((r) => `· ${r}`).join("\n") + "\n") +
    (cashFin ? `Queda: ${pesos(Math.max(0, cashFin.ars - bot.reserva))} rotables (+ reserva bot ${pesos(bot.reserva)}) · ${usd(cashFin.usd)}\n` : "") +
    `Lo que no entró hoy por aforo T+1 se completa cuando liquide.\n` +
    `Las posiciones sincronizan solas a Midas (iol-positions-sync): NO cargarlas a mano.`
  );
  log("fin");
})().catch(async (e) => {
  console.error(e);
  await tg(`<b>MOMENTUM · rotación ABORTADA</b>\n${e.message}`).catch(() => {});
  process.exit(1);
});
