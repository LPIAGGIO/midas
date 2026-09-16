/**
 * Worker fci-sweep — barrido overnight del cash ocioso de IOL a un FCI
 * money market (PLATA REAL).
 *
 * La plata que queda dormida en el disponible de IOL no rinde nada; un
 * money market ARS la remunera overnight. El ciclo es de dos patas:
 *
 *   node worker.js barrer   (PM2 "fci-sweep-tarde", 16:50 hábiles)
 *     1. Cancela las órdenes PENDIENTES del bot niveles-auto: su cash
 *        escrowado vuelve al disponible (intradía la liberación es ~
 *        inmediata, medido 14/09). Las EJECUTADAS no se tocan.
 *     2. Espera que el escrow liberado aparezca en el disponible.
 *     3. Suscribe (disponible − colchón) al FCI. Valida primero
 *        (soloValidar) y recién después manda la posta.
 *   node worker.js rescatar (PM2 "fci-sweep-maniana", 09:30 hábiles)
 *     Rescata TODAS las cuotapartes para que la plata esté de vuelta
 *     antes de que el bot vuelva a apoyar sus órdenes (~10:30), y MIDE
 *     a qué hora IOL acredita el rescate — dato que hoy no tenemos.
 *
 * Convivencia con el bot: acá NO se toca la DB. El bot reconcilia solo
 * las órdenes que le cancelaron (las re-apoya a la mañana); paper_iol_trades
 * se lee pero jamás se escribe desde este worker.
 *
 * Víspera de rotación momentum: el día antes de la rotación mensual NO se
 * barre nada (ni se cancela): la rotación necesita el libro y la caja
 * tal cual quedaron. Se controla por día del mes (FCI_SWEEP_SKIP_DOM,
 * default "14" porque la rotación corre el 15).
 *
 * HECHOS, no supuestos (lección del 14/09): una cancelación, suscripción
 * o rescate es un hecho SOLO cuando la respuesta de IOL lo dice. Nunca
 * se asume por timing ni por precio.
 *
 * DRY-RUN: --dry-run o FCI_SWEEP_DRY=1 — arma el plan completo, NO
 * cancela nada y de la suscripción corre SOLO el soloValidar (prueba el
 * caño sin mover un peso). En rescatar, valida y no manda el rescate.
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

const MODO = process.argv[2] || "";
const DRY_RUN = process.argv.includes("--dry-run") || process.env.FCI_SWEEP_DRY === "1";
const FORCE = process.argv.includes("--force");
const BOT_USER = process.env.IOL_BOT_USER || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
const IOL_BASE = "https://api.invertironline.com";

// Premier Renta Corto Plazo en pesos (clase B) — el money market ARS de la
// propia IOL: suscripción/rescate sin comisión y sin riesgo de rechazo por
// fondo de terceros. Cambiable por env si LP quiere otro.
const FONDO = process.env.FCI_SWEEP_FONDO || "PRCPPEB";
// Colchón que NUNCA se barre: cubre débitos nocturnos (derechos de mercado,
// ajustes de futuros, comisiones) que caerían en descubierto si el disponible
// queda en cero.
const BUFFER_ARS = Number(process.env.FCI_SWEEP_BUFFER_ARS || 200_000);
// Menos que esto no paga el trámite (el rendimiento overnight de <$100k es
// centavos y cada pata es una operación real que puede fallar).
const MONTO_MIN = 100_000;
// Tope duro para el rollout: las primeras corridas van con un cap chico
// desde el env hasta medir la hora de acreditación del rescate. Sin env, sin
// tope (se barre todo lo que el buffer deja).
const MAX_ARS = Number(process.env.FCI_SWEEP_MAX_ARS || 0) || null;
// Días del mes en que NO se barre (víspera de la rotación momentum, que
// corre el 15 y necesita la caja y las órdenes del bot tal cual están).
const SKIP_DOM = new Set(String(process.env.FCI_SWEEP_SKIP_DOM || "14")
  .split(",").map((s) => Number(s.trim())).filter(Number.isFinite));

// ── Calendario BYMA (porteado de momentum-rotation; mantener en sync) ───
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
// Hora ART del momento, para ventanas y para el log de acreditación.
function ahoraAr() {
  const s = new Date().toLocaleTimeString("en-GB", {
    timeZone: "America/Argentina/Buenos_Aires", hour12: false,
  });
  const [h, m] = s.split(":").map(Number);
  return { h, m, hhmm: s.slice(0, 5) };
}

const pesos = (n) => "$" + Math.round(n).toLocaleString("es-AR");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Telegram (mismo patrón que momentum: fallo de TG jamás frena) ───────
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

// ── IOL: token y operaciones (patrones de momentum-rotation) ────────────
async function iolToken() {
  const { data } = await supabase.from("linked_brokers")
    .select("access_token,access_expires_at").eq("user_id", BOT_USER).eq("broker", "iol").maybeSingle();
  if (!data?.access_token) throw new Error("sin access_token de IOL");
  if (data.access_expires_at && new Date(data.access_expires_at) <= new Date())
    throw new Error("access_token de IOL vencido (lo revive el keep-alive)");
  return data.access_token;
}
// Los access token de IOL viven ~15 min y la medición de acreditación puede
// durar 2 horas: se relee de Supabase (el keep-alive lo mantiene fresco) con
// cache corto. Lección de la rotación del 15/09 (401 a los 16 minutos).
let _tokCache = { v: null, at: 0 };
async function tokenFresco() {
  if (_tokCache.v && Date.now() - _tokCache.at < 5 * 60 * 1000) return _tokCache.v;
  _tokCache.v = await iolToken();
  _tokCache.at = Date.now();
  return _tokCache.v;
}

async function iolDetalle(numero, token) {
  const r = await fetch(`${IOL_BASE}/api/v2/operaciones/${encodeURIComponent(numero)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}
async function iolCancelar(numero, token) {
  // Endpoint medido 10/09: DELETE /api/v2/operaciones/{n}. La ruta
  // /operar/Cancelar devuelve 500 SIEMPRE — no usarla.
  const r = await fetch(`${IOL_BASE}/api/v2/operaciones/${encodeURIComponent(numero)}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`IOL cancelar ${numero}: ${r.status}`);
}

// Disponible ARS de la cuenta "inversión Argentina" en pesos. Mismo parseo
// que iol-cash-sync/momentum: la cuenta de Estados Unidos no participa.
async function disponibleArs(token) {
  const r = await fetch(`${IOL_BASE}/api/v2/estadocuenta`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`estadocuenta ${r.status}`);
  const j = await r.json().catch(() => null);
  let ars = 0;
  for (const c of j?.cuentas || []) {
    const tipo = String(c.tipo || "").toLowerCase();
    if (!(tipo.includes("argentina") && tipo.includes("peso"))) continue;
    // Bucket "inmediato" de saldos[]: cuenta.disponible netea los
    // compromisos T+1 y puede dar negativo con la cuenta sana (15/09).
    const saldos = Array.isArray(c.saldos) ? c.saldos : [];
    const inm = saldos.find((s) => String(s?.liquidacion ?? "").toLowerCase().includes("inmediato"));
    ars += inm ? (Number(inm.disponible) || Number(inm.saldo) || 0) : (Number(c.disponible) || 0);
  }
  return ars;
}

/* Suscripción/rescate de FCI. OJO: el shape de la respuesta NO está medido
 * todavía (a diferencia de Comprar/Vender). Por eso: se loguea el JSON
 * crudo SIEMPRE, y "éxito" exige HTTP ok y que el body no diga ok:false —
 * la primera corrida real (con cap chico) es la que confirma el contrato. */
async function fciPost(ruta, simbolo, montoOCantidad, campo, soloValidar, token) {
  const body = { simbolo, [campo]: montoOCantidad, soloValidar };
  const r = await fetch(`${IOL_BASE}/api/v2/operar/${ruta}/fci`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  log(`[fci] POST ${ruta}/fci ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(j).slice(0, 500)}`);
  if (!r.ok || j?.ok === false)
    throw new Error(`IOL ${ruta} FCI ${simbolo} (${campo}=${montoOCantidad}, soloValidar=${soloValidar}): ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}
const fciSuscribir = (monto, soloValidar, token) => fciPost("suscripcion", FONDO, monto, "monto", soloValidar, token);
const fciRescatar = (cantidad, soloValidar, token) => fciPost("rescate", FONDO, cantidad, "cantidad", soloValidar, token);

// Órdenes PENDIENTES reales del bot niveles-auto (con número de IOL). Solo
// lectura: la reconciliación de las canceladas la hace el propio bot.
async function pendientesDelBot() {
  const { data, error } = await supabase.from("paper_iol_trades")
    .select("id,ticker,qty,px_ars_orden,broker_order_id")
    .eq("modo", "real").eq("status", "pending").not("broker_order_id", "is", null);
  if (error) throw new Error(`paper_iol_trades: ${error.message}`);
  return data || [];
}

// ── barrer: cancelar pendientes del bot + suscribir el disponible ───────
async function barrer() {
  const hoy = diaAr();
  let paso = "arranque";
  try {
    if (!esDiaHabil(hoy)) {
      log("BYMA cerrado (finde/feriado): no hay overnight que barrer");
      await tg(`<b>FCI-SWEEP · no barro</b> (${hoy})\nBYMA cerrado (finde/feriado).`);
      return;
    }
    /* VENTANA: PM2 re-ejecuta el proceso en cada reboot del VPS — sin esto,
     * un reboot a las 3 AM cancelaría órdenes del bot y suscribiría con el
     * mercado cerrado. Fuera de hora solo con --force, a conciencia. */
    const t0 = ahoraAr();
    const enVentana = (t0.h === 16 && t0.m >= 45) || (t0.h === 17 && t0.m <= 30);
    if (!DRY_RUN && !enVentana && !FORCE) {
      log(`fuera de ventana (16:45-17:30 ART, son las ${t0.hhmm}): no barro`);
      return;
    }
    // Víspera de la rotación momentum: NO se toca NADA — ni cancelar, porque
    // la rotación de mañana calcula la reserva del bot con esas pendientes
    // vivas, y el rescate de la mañana metería ruido en la caja rotable.
    const dom = Number(hoy.slice(8, 10));
    if (SKIP_DOM.has(dom)) {
      log(`día ${dom} está en FCI_SWEEP_SKIP_DOM: mañana rota momentum, no barro`);
      await tg(`<b>FCI-SWEEP · no barro</b> (${hoy})\nMañana rota momentum: la caja y las órdenes del bot quedan como están.`);
      return;
    }

    const token = await iolToken();
    paso = "lectura inicial";
    const [pendientes, disp0] = await Promise.all([pendientesDelBot(), disponibleArs(token)]);
    log(`modo ${DRY_RUN ? "DRY-RUN" : "REAL"} · disponible ARS ${pesos(disp0)} · ${pendientes.length} pendiente(s) del bot`);

    // ── Cancelar las pendientes del bot (su escrow vuelve al disponible) ──
    // Con cap de rollout puesto: si el disponible ya alcanza el cap, las
    // pendientes NI SE TOCAN — cancelar para después no barrer ese escrow
    // sería regalar la última ventana de fills del bot a cambio de nada.
    paso = "cancelación de pendientes del bot";
    let canceladas = 0, dejadas = 0, liberado = 0;
    const detalleCancel = [];
    const necesitaEscrow = !MAX_ARS || Math.floor(disp0 - BUFFER_ARS) < MAX_ARS;
    if (!necesitaEscrow) log(`cap ${pesos(MAX_ARS)} ya cubierto por el disponible: no toco las pendientes del bot`);
    for (const p of necesitaEscrow ? pendientes : []) {
      const num = p.broker_order_id;
      const j = await iolDetalle(num, token);
      const estado = String(j?.estadoActual ?? j?.estado ?? "");
      // Cancelable solo en estados vivos. "ejecutada" (o cualquier estado
      // que no reconozcamos) se deja quieta: cancelar a ciegas una orden
      // cuyo estado no entendemos es peor que dejar esa plata sin barrer.
      if (!/pendiente|proceso|iniciada/i.test(estado)) {
        log(`orden ${num} (${p.ticker} ×${p.qty}): estado "${estado || "?"}" — no se cancela`);
        dejadas++;
        continue;
      }
      if (DRY_RUN) {
        log(`[DRY-RUN] cancelaría orden ${num} (${p.ticker} ×${p.qty}, ~${pesos(p.qty * (Number(p.px_ars_orden) || 0))})`);
        liberado += p.qty * (Number(p.px_ars_orden) || 0);
        canceladas++;
        continue;
      }
      await iolCancelar(num, token);
      // El DELETE ok es la palabra de IOL; el detalle posterior es el recibo.
      const post = await iolDetalle(num, token);
      const estadoPost = String(post?.estadoActual ?? post?.estado ?? "?");
      log(`orden ${num} (${p.ticker} ×${p.qty}) cancelada — estado post: "${estadoPost}"`);
      detalleCancel.push(`${p.ticker} ×${p.qty} (orden ${num})`);
      liberado += p.qty * (Number(p.px_ars_orden) || 0);
      canceladas++;
    }
    // La DB no se toca: el bot reconcilia solo sus canceladas.

    // ── Esperar que el escrow liberado aparezca en el disponible ─────────
    // Intradía la liberación es ~inmediata (medido 14/09), pero "~" no es
    // un hecho: se espera verla en estadocuenta antes de dimensionar.
    paso = "espera de liberación del escrow";
    let disp = disp0;
    if (!DRY_RUN && canceladas > 0 && liberado > 0) {
      const objetivo = disp0 + liberado * 0.9; // 90%: px_ars_orden es estimación, no el escrow exacto
      const limite = Date.now() + 5 * 60 * 1000;
      for (;;) {
        disp = await disponibleArs(await tokenFresco());
        log(`disponible ${pesos(disp)} (objetivo ~${pesos(objetivo)})`);
        if (disp >= objetivo) break;
        if (Date.now() > limite) {
          // Se sigue con lo que hay: barrer de menos es inofensivo, y el
          // buffer ya cubre el resto. Pero se avisa, porque contradice la
          // medición del 14/09 y hay que mirarlo.
          log(`timeout esperando el escrow: sigo con ${pesos(disp)}`);
          await tg(`<b>FCI-SWEEP · ojo</b>\nCancelé ${canceladas} orden(es) (~${pesos(liberado)}) pero en 5 min el disponible no reflejó la liberación (${pesos(disp0)} → ${pesos(disp)}). Barro lo que hay igual.`);
          break;
        }
        await sleep(20_000);
      }
    }

    // ── Dimensionar y suscribir ──────────────────────────────────────────
    paso = "cálculo del monto";
    let monto = Math.floor(disp - BUFFER_ARS);
    const montoSinCap = monto;
    if (MAX_ARS) monto = Math.min(monto, MAX_ARS);
    if (monto < MONTO_MIN) {
      log(`monto ${pesos(Math.max(0, monto))} < mínimo ${pesos(MONTO_MIN)}: no barro`);
      await tg(`<b>FCI-SWEEP · no barro</b> (${hoy})\nDisponible ${pesos(disp)} − colchón ${pesos(BUFFER_ARS)} = ${pesos(Math.max(0, monto))}, abajo del mínimo ${pesos(MONTO_MIN)}.${canceladas ? `\n(${canceladas} orden(es) del bot quedaron canceladas igual — el bot las re-apoya mañana.)` : ""}`);
      return;
    }

    if (DRY_RUN) {
      paso = "soloValidar (dry-run)";
      // El disponible actual sigue neto del escrow (no cancelamos nada), así
      // que se valida con lo validable HOY y se reporta el plan completo.
      const montoValidable = Math.min(monto, Math.floor(disp0 - BUFFER_ARS));
      log(`[DRY-RUN] plan: cancelar ${canceladas} pendiente(s) (~${pesos(liberado)}), suscribir ${pesos(monto)} a ${FONDO}${MAX_ARS ? ` (cap ${pesos(MAX_ARS)}, sin cap daría ${pesos(montoSinCap)})` : ""}`);
      if (montoValidable >= MONTO_MIN) {
        await fciSuscribir(montoValidable, true, token);
        log(`[DRY-RUN] soloValidar OK por ${pesos(montoValidable)} — el caño funciona`);
      } else {
        log(`[DRY-RUN] sin monto validable hoy (el escrow sigue apoyado): soloValidar no corrió`);
      }
      await tg(
        `<b>FCI-SWEEP · DRY-RUN — nada ejecutado</b> (${hoy})\n` +
        `Cancelaría ${canceladas} orden(es) del bot (~${pesos(liberado)} escrowados).\n` +
        `Suscribiría ${pesos(monto)} a ${FONDO}${MAX_ARS ? ` (cap ${pesos(MAX_ARS)})` : ""}.\n` +
        (montoValidable >= MONTO_MIN ? `soloValidar OK por ${pesos(montoValidable)}.` : `soloValidar no corrió (escrow apoyado).`)
      );
      return;
    }

    // Validación previa SIEMPRE: si IOL va a rechazar (cutoff del fondo,
    // saldo, DDJJ), mejor enterarse sin haber mandado nada.
    paso = "suscripción soloValidar";
    await fciSuscribir(monto, true, token);
    log(`validación OK: suscribo ${pesos(monto)} a ${FONDO}`);
    paso = "suscripción real";
    const j = await fciSuscribir(monto, false, token);
    const numOp = j?.numeroOperacion ?? j?.numero ?? j?.id ?? null;
    log(`suscripción confirmada por IOL${numOp ? ` — operación ${numOp}` : ""}`);

    await tg(
      `<b>FCI-SWEEP · barrido ${hoy}</b>\n` +
      `Canceladas ${canceladas} orden(es) del bot${detalleCancel.length ? `:\n· ${detalleCancel.join("\n· ")}` : "."}\n` +
      (dejadas ? `${dejadas} orden(es) no cancelables (ejecutadas u otro estado) — sin tocar.\n` : "") +
      `Suscripto ${pesos(monto)} a ${FONDO}${numOp ? ` (op ${numOp})` : ""}${MAX_ARS ? ` — cap de rollout ${pesos(MAX_ARS)} activo` : ""}.\n` +
      `Queda colchón ~${pesos(disp - monto)}. Rescate mañana 09:30.`
    );
    log("fin barrer");
  } catch (e) {
    console.error(e);
    await tg(`<b>FCI-SWEEP FALLO ${paso}</b>\n${e.message}`).catch(() => {});
    process.exit(1);
  }
}

// ── rescatar: rescate total a la mañana + medición de la acreditación ───
async function rescatar() {
  const hoy = diaAr();
  let paso = "arranque";
  try {
    if (!esDiaHabil(hoy)) {
      log("BYMA cerrado: nada que rescatar hoy");
      return;
    }
    // Ventana: el rescate se pide 09:30 para que la plata esté antes de las
    // 10:30 (cuando niveles-auto apoya). Mismo motivo que en barrer: PM2
    // resucita el proceso en cada reboot.
    const t0 = ahoraAr();
    if (!DRY_RUN && !(t0.h >= 9 && t0.h < 11) && !FORCE) {
      log(`fuera de ventana (09:00-11:00 ART, son las ${t0.hhmm}): no rescato`);
      return;
    }

    const token = await iolToken();

    /* PASO 0 — SUSCRIPCIONES PENDIENTES (el ciclo real, medido 16/09): la
     * suscripción de las 16:50 cae DESPUÉS del cut-off del fondo y queda
     * "Iniciada" toda la noche, con el cash retenido. Cancelarla a la
     * mañana lo devuelve AL INSTANTE — sin cuotapartes, sin concertación,
     * sin acreditación que esperar. Y la remuneración nocturna llega igual
     * (crédito 22:00 del 15/09: $773,52 sobre $1,94M ≈ 14,6% TNA — a
     * CONFIRMAR con más noches; si no se repite, este ciclo no rinde y hay
     * que repensar el horario del barrido). */
    paso = "cancelación de suscripciones pendientes";
    let recuperado = 0, cancelSubs = 0;
    try {
      const rp = await fetch(`${IOL_BASE}/api/v2/operaciones?filtro.estado=pendientes`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const jp = rp.ok ? await rp.json().catch(() => []) : [];
      const lista = Array.isArray(jp) ? jp : (jp?.operaciones || []);
      for (const o of lista) {
        const sim = String(o.simbolo ?? "").toUpperCase();
        if (sim !== FONDO.toUpperCase()) continue;
        const num = String(o.numero ?? o.numeroOperacion ?? "");
        if (!num) continue;
        if (DRY_RUN) { log(`[DRY-RUN] cancelaría suscripción pendiente ${num} (~${pesos(Number(o.monto) || 0)})`); continue; }
        await iolCancelar(num, token);
        cancelSubs++;
        recuperado += Number(o.monto) || 0;
        log(`suscripción pendiente ${num} cancelada — cash de vuelta al instante`);
      }
    } catch (e) {
      log(`paso 0 falló (${e.message}) — sigo con el rescate por cuotapartes`);
    }
    if (cancelSubs > 0) {
      await tg(`<b>FCI-SWEEP · mañana</b> (${hoy})\nCancelé ${cancelSubs} suscripción(es) pendiente(s) de ${FONDO}: ~${pesos(recuperado)} de vuelta en el disponible, al instante. La remuneración de anoche llega como Crédito ~22:00.`);
    }

    paso = "lectura del portafolio";
    const r = await fetch(`${IOL_BASE}/api/v2/portafolio/argentina`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`portafolio ${r.status}`);
    const j = await r.json().catch(() => null);
    const activo = (j?.activos || []).find(
      (a) => String(a?.titulo?.simbolo || "").toUpperCase() === FONDO.toUpperCase()
    );
    const cuotapartes = Number(activo?.cantidad) || 0;
    if (cuotapartes <= 0) {
      log(`nada que rescatar por cuotapartes: no hay ${FONDO} concertado en el portafolio${cancelSubs ? " (las pendientes ya se cancelaron arriba)" : ""}`);
      return;
    }
    // Estimación en ARS de lo que vuelve — solo para MEDIR la acreditación
    // (el rescate va por cuotapartes, no por monto).
    const estimadoArs = Number(activo?.valorizado)
      || cuotapartes * (Number(activo?.ultimoPrecio) || 0);
    log(`${FONDO}: ${cuotapartes} cuotapartes (~${pesos(estimadoArs)})`);

    const disp0 = await disponibleArs(token);

    paso = "rescate soloValidar";
    await fciRescatar(cuotapartes, true, token);
    log("validación OK");
    if (DRY_RUN) {
      log(`[DRY-RUN] rescataría ${cuotapartes} cuotapartes de ${FONDO} (~${pesos(estimadoArs)}) — nada ejecutado`);
      await tg(`<b>FCI-SWEEP · DRY-RUN rescate — nada ejecutado</b> (${hoy})\nRescataría ${cuotapartes} cuotapartes de ${FONDO} (~${pesos(estimadoArs)}). soloValidar OK.`);
      return;
    }
    paso = "rescate real";
    const jr = await fciRescatar(cuotapartes, false, token);
    const numOp = jr?.numeroOperacion ?? jr?.numero ?? jr?.id ?? null;
    log(`rescate confirmado por IOL${numOp ? ` — operación ${numOp}` : ""}`);
    await tg(`<b>FCI-SWEEP · rescate pedido</b> (${hoy})\n${cuotapartes} cuotapartes de ${FONDO} (~${pesos(estimadoArs)})${numOp ? ` — op ${numOp}` : ""}. Midiendo la acreditación.`);

    // ── MEDIR la acreditación: dato que no tenemos y que decide si este ──
    // ciclo es viable. Umbral 50%: el disponible se mueve por mil motivos
    // a la mañana, un salto de la mitad del estimado solo puede ser el FCI.
    paso = "medición de acreditación";
    let avisado1035 = false, acreditado = false;
    for (;;) {
      const t = ahoraAr();
      const disp = await disponibleArs(await tokenFresco()).catch((e) => { log(`poll falló: ${e.message}`); return null; });
      if (disp != null) {
        log(`${t.hhmm} ART · disponible ${pesos(disp)} (base ${pesos(disp0)}, salto de ${pesos(disp - disp0)} / umbral ${pesos(estimadoArs * 0.5)})`);
        if (disp - disp0 > estimadoArs * 0.5) {
          acreditado = true;
          log(`rescate acreditado ~${t.hhmm} ART`);
          await tg(`<b>FCI-SWEEP · rescate acreditado ~${t.hhmm}</b>\nDisponible ${pesos(disp0)} → ${pesos(disp)}. Anotar la hora: es el dato del rollout.`);
          break;
        }
      }
      if (!avisado1035 && !acreditado && (t.h > 10 || (t.h === 10 && t.m >= 35))) {
        avisado1035 = true;
        // El bot reintenta solo cada 15 min si le falta saldo — no hay que
        // hacer nada, pero conviene saber que puede fallar los primeros tiros.
        await tg(`<b>FCI-SWEEP · rescate aún sin acreditar (10:35)</b>\nEl bot niveles-auto puede fallar por saldo en sus primeros intentos; se reintenta solo cada 15 min, no hay nada que hacer. Sigo midiendo hasta las 12:00.`);
      }
      if (t.h >= 12) {
        log("12:00 ART sin detectar la acreditación: corto la medición");
        await tg(`<b>FCI-SWEEP · rescate NO detectado a las 12:00</b>\nEl disponible no saltó >${pesos(estimadoArs * 0.5)} sobre la base ${pesos(disp0)}. Revisar a mano en IOL si el rescate ${numOp ? `(op ${numOp}) ` : ""}acreditó — puede que el salto quedara enmascarado por otros movimientos.`);
        break;
      }
      await sleep(5 * 60 * 1000);
    }

    await tg(
      `<b>FCI-SWEEP · rescate ${hoy} — resumen</b>\n` +
      `Rescatadas ${cuotapartes} cuotapartes de ${FONDO} (~${pesos(estimadoArs)}).\n` +
      (acreditado ? `Acreditación detectada — ver hora arriba.` : `Acreditación NO detectada hasta las 12:00 — revisar a mano.`)
    );
    log("fin rescatar");
  } catch (e) {
    console.error(e);
    await tg(`<b>FCI-SWEEP FALLO ${paso}</b>\n${e.message}`).catch(() => {});
    process.exit(1);
  }
}

// ── Main ────────────────────────────────────────────────────────────────
(async () => {
  if (MODO === "barrer") await barrer();
  else if (MODO === "rescatar") await rescatar();
  else {
    console.error("uso: node worker.js barrer|rescatar [--dry-run] [--force]");
    process.exit(1);
  }
})();
