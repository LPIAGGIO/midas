/**
 * cocos-scalp: grilla intradía ESCALONADA sobre un CEDEAR en Cocos (API de
 * Primary). Prueba pedida por LP el 01/10/2026: "comprar y vender con muy
 * poca ganancia, escalonado, máximo 10 papeles, bajando y subiendo de a 2".
 *
 * QUÉ HACE
 *  - Compra LOTE papeles en la punta compradora (orden límite apoyada).
 *  - Cada lote comprado deja apoyada su venta a +GANANCIA sobre su costo.
 *  - Si el precio baja PASO desde el ancla (la primera compra del ciclo),
 *    compra otro lote; hasta MAX papeles (MAX/LOTE escalones).
 *  - Cuando un escalón se vende, vuelve a apoyar su compra (la grilla sube y
 *    baja de a un lote). Con todo vendido arranca un ciclo nuevo.
 *  - CORTE: si la punta compradora cae CORTE desde el ancla, cancela todo,
 *    vende lo que tenga y no opera más en el día. Lo mismo a HORA_CIERRE, con
 *    la pérdida diaria PERDIDA_MAX, o si aparece un archivo STOP en la carpeta.
 *
 * AISLAMIENTO (incidente 01/10: tabla compartida con niveles-auto): este bot
 * NO escribe en paper_iol_trades ni en ninguna tabla de otro worker. Su
 * estado vive en estado-<fecha>.json en esta carpeta; la verdad de las
 * órdenes es Primary. Las operaciones entran a Midas por el puente
 * cocos-operaciones, como cualquier orden de la cuenta.
 *
 * CUENTA COMPARTIDA: solo vende lo que él mismo compró. Mientras corre, LP no
 * tiene que operar a mano el mismo papel en Cocos.
 *
 *   node worker.js --chequeo     login, tick, libro, saldo y plan. Sin órdenes.
 *   SCALP_REAL=1 (en .env)       órdenes reales. Sin eso, simula contra el
 *                                libro real (compra si la punta vendedora
 *                                llega al precio; vende si llega la compradora).
 * Encenderlo con órdenes reales lo hace LP, no Claude.
 */
const fs = require("fs");
const path = require("path");
const MODS = path.join(__dirname, "..", "cocos-bot", "node_modules");
const WebSocket = require(path.join(MODS, "ws"));
const { createClient } = require(path.join(MODS, "@supabase/supabase-js"));

function leerEnv() {
  const o = {};
  // Credenciales: las del bot de Cocos (las cargó LP). El .env propio, si
  // existe, solo aporta los parámetros SCALP_*.
  for (const ruta of [path.join(__dirname, "..", "cocos-bot", ".env"), path.join(process.cwd(), ".env")]) {
    if (!fs.existsSync(ruta)) continue;
    for (const l of fs.readFileSync(ruta, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  }
  // OTRA CUENTA (02/10/2026: segunda cuenta de Cocos de LP, "como dos personas
  // distintas usando el bot"): si el .env de la carpeta trae SCALP_CREDENCIALES,
  // el usuario, la clave y el número de cuenta salen del .env de ESA carpeta.
  // Nada más se comparte: estado, órdenes y logs son de cada carpeta.
  if (o.SCALP_CREDENCIALES) {
    const ruta = path.join(o.SCALP_CREDENCIALES, ".env");
    if (!fs.existsSync(ruta)) { console.error(`no existe ${ruta}`); process.exit(1); }
    const c = {};
    for (const l of fs.readFileSync(ruta, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) c[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); }
    for (const k of ["COCOS_API_USER_B64", "COCOS_API_PASS_B64", "COCOS_CUENTA"]) {
      if (!c[k]) { console.error(`falta ${k} en ${ruta}`); process.exit(1); }
      o[k] = c[k];
    }
  }
  const b64 = (k) => (o[k] ? Buffer.from(o[k], "base64").toString("utf8") : null);
  o.user = b64("COCOS_API_USER_B64"); o.pass = b64("COCOS_API_PASS_B64");
  return o;
}
const ENV = leerEnv();
const BASE = "https://api.cocos.xoms.com.ar";
const CUENTA = ENV.COCOS_CUENTA || "72404";
const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661"; // LP
const TK = String(ENV.SCALP_TICKER || "MU").toUpperCase();
const LOTE = Number(ENV.SCALP_LOTE || 2);
const MAX = Number(ENV.SCALP_MAX || 10);
const NIVELES = Math.floor(MAX / LOTE);
const PASO = Number(ENV.SCALP_PASO || 0.003);          // distancia entre escalones
const GANANCIA = Number(ENV.SCALP_GANANCIA || 0.0025);  // objetivo por lote
const CORTE = Number(ENV.SCALP_CORTE || 0.018);        // caída desde el ancla que corta todo
// REFUERZO (LP 01/10/2026): con la grilla llena, si el precio cae a
// ancla × (1 − REFUERZO_MULT × profundidad de la grilla) compra de una vez
// REFUERZO_FRAC de lo que tiene (0,5 → con 10 papeles compra 5) y desde ahí
// sale TODO junto en el promedio + GANANCIA. 0 = apagado. Medido en
// research/scalp/doble.py: gana ~25% más cuando el papel vuelve y pierde ~50%
// más cuando no; usa 1,5 veces el capital.
const REFUERZO_FRAC = Number(ENV.SCALP_REFUERZO_FRAC || 0);
const REFUERZO_MULT = Number(ENV.SCALP_REFUERZO_MULT || 2);
const PERDIDA_MAX = Number(ENV.SCALP_PERDIDA_MAX_ARS || 60000);
const HORA_INICIO = Number(ENV.SCALP_HORA_INICIO || 1035);
const HORA_CIERRE = Number(ENV.SCALP_HORA_CIERRE || 1645);
// Después de esta hora no se abre un ciclo NUEVO (01/10/2026: abrió uno a 28
// minutos del cierre, sin tiempo de llegar a su venta). Los escalones de un
// ciclo ya abierto siguen funcionando hasta HORA_CIERRE.
const HORA_ULTIMO_CICLO = Number(ENV.SCALP_HORA_ULTIMO_CICLO || 1615);
const REANCLA_MS = Number(ENV.SCALP_REANCLA_MIN || 10) * 60_000;
const REAL = ENV.SCALP_REAL === "1";
const CIERRE_VENDE = ENV.SCALP_CIERRE_VENDE === "1";    // por defecto NO vende al cierre: arrastra
const CHEQUEO = process.argv.includes("--chequeo");
const SOLO_SYNC = process.argv.includes("--sincronizar"); // actualiza el estado contra Primary y sale
const FEE = 0.00044 * 1.21;                              // 0,053% por punta (intradía)
// Banco de prueba de la LÓGICA (nunca con REAL): libro sintético que camina al
// azar y reloj acelerado. node worker.js con SCALP_FAKE=1 en el entorno.
const FAKE = !REAL && process.env.SCALP_FAKE === "1";
const CICLO_MS = FAKE ? 10 : 4000;
const FINAL = new Set(["FILLED", "CANCELLED", "REJECTED", "EXPIRED"]);

const log = (...a) => console.log(`[${new Date().toISOString()}] [scalp ${TK}]`, ...a);
const pesos = (n) => (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("es-AR");
const diaAr = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const hhmmAr = () => { const s = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }); return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5)); };
const esHabil = () => { const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay(); return d >= 1 && d <= 5; };
const dormir = (ms) => new Promise((ok) => setTimeout(ok, FAKE ? ms / 200 : ms));
if (!ENV.user || !ENV.pass) { console.error("faltan credenciales de Cocos (workers/cocos-bot/.env)"); process.exit(1); }

/* ───────── Primary REST (misma plomería que cocos-bot) ───────── */
let _tok = null, _tokAt = 0;
async function token(forzar = false) {
  if (_tok && !forzar && Date.now() - _tokAt < 20 * 60_000) return _tok;
  const r = await fetch(`${BASE}/auth/getToken`, { method: "POST", headers: { "X-Username": ENV.user, "X-Password": ENV.pass }, redirect: "manual" });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) throw new Error(`login Primary rechazado (HTTP ${r.status})`);
  _tok = t; _tokAt = Date.now();
  return t;
}
async function api(metodo, ruta, reintento = true) {
  const t = await token();
  const r = await fetch(`${BASE}${ruta}`, { method: metodo, headers: { "X-Auth-Token": t }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  if ((r.status === 401 || r.status === 302) && reintento) { await token(true); return api(metodo, ruta, false); }
  // Una orden nueva NUNCA se reintenta sola (no duplicar): solo las lecturas.
  if (r.status === 429 && reintento && !/newSingleOrder/.test(ruta)) { await dormir(3000); return api(metodo, ruta, false); }
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch { /* no json */ }
  if (r.status !== 200) throw new Error(`${ruta.split("?")[0]}: HTTP ${r.status} ${txt.slice(0, 160)}`);
  if (j?.status && j.status !== "OK") { const e = new Error(`${ruta.split("?")[0]}: ${j.status} ${j.message || j.description || ""}`.trim()); e.rechazo = true; throw e; }
  return j;
}
const simbolo = () => `MERV - XMEV - ${TK} - 24hs`;
const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
let TICK = 1;
const alTick = (px, modo) => { const n = px / TICK; const k = modo === "arriba" ? Math.ceil(n - 1e-9) : Math.floor(n + 1e-9); return Math.round(k * TICK * 1000) / 1000; };
async function disponible24() {
  const j = await api("GET", `/rest/risk/accountReport/${CUENTA}`);
  return Number(j?.accountData?.detailedAccountReports?.["1"]?.availableToOperate?.total) || 0;
}
async function tenenciaCuenta() {
  const j = await api("GET", `/rest/risk/detailedPosition/${CUENTA}`);
  let n = 0;
  for (const tipo of Object.values(j?.detailedPosition?.report || {})) for (const [sym, info] of Object.entries(tipo || {})) if (String(sym).toUpperCase() === TK) n += Number(info?.instrumentCurrentSize) || 0;
  return n;
}

/* ───────── libro: websocket de Primary, respaldo REST ───────── */
let book = { bid: null, ask: null, last: null, t: 0 }, wsConn = null, wsUltimo = 0, wsReint = 0;
async function wsConectar() {
  const reintentar = (m) => { const esp = Math.min(60_000, 5_000 * (1 + wsReint++)); log(`ws desconectado (${m}); reconecto en ${esp / 1000} s`); setTimeout(wsConectar, esp); };
  try {
    const ws = new WebSocket(BASE.replace("https://", "wss://") + "/", { headers: { "X-Auth-Token": await token() } });
    wsConn = ws;
    ws.on("open", () => { wsReint = 0; ws.send(JSON.stringify({ type: "smd", level: 1, entries: ["BI", "OF", "LA"], products: [{ symbol: simbolo(), marketId: "ROFX" }], depth: 1 })); log("ws Primary conectado"); });
    ws.on("message", (d) => {
      wsUltimo = Date.now();
      let j; try { j = JSON.parse(d.toString()); } catch { return; }
      if (j.type !== "Md") return;
      const md = j.marketData || {};
      // BI/OF vacíos = punta sin órdenes: se anula (no se arrastra la anterior).
      book = { bid: "BI" in md ? Number(md.BI?.[0]?.price) || null : book.bid, ask: "OF" in md ? Number(md.OF?.[0]?.price) || null : book.ask, last: Number(md.LA?.price) || book.last, t: Date.now() };
    });
    ws.on("close", (c) => { if (wsConn === ws) { wsConn = null; reintentar(`close ${c}`); } });
    ws.on("error", (e) => { if (wsConn === ws) { wsConn = null; reintentar(e.message); } });
  } catch (e) { reintentar(e.message); }
}
let _restT = 0, _fk = 344000, _fn = 0;
function libroFake() {
  _fn++;
  const giro = Number(process.env.SCALP_FAKE_GIRO || 0);
  const deriva = Number(process.env.SCALP_FAKE_DERIVA || 0) * (giro && _fn > giro ? -1 : 1);
  _fk = Math.max(1000, _fk + 25 * (Math.floor(Math.random() * 7) - 3) + deriva);
  return { bid: _fk, ask: _fk + 100, last: _fk, t: Date.now() };
}
async function libro() {
  if (FAKE) return libroFake();
  if (wsConn && wsConn.readyState === 1 && Date.now() - wsUltimo < 90_000 && book.t) return book;
  if (Date.now() - _restT > 10_000) {
    _restT = Date.now();
    try {
      const j = await api("GET", `/rest/marketdata/get?${q({ marketId: "ROFX", symbol: simbolo(), entries: "BI,OF,LA", depth: 1 })}`);
      const md = j?.marketData || {};
      book = { bid: Number(md.BI?.[0]?.price) || null, ask: Number(md.OF?.[0]?.price) || null, last: Number(md.LA?.price) || null, t: Date.now() };
    } catch (e) { log(`libro REST: ${e.message}`); }
  }
  return Date.now() - book.t < 30_000 ? book : { bid: null, ask: null, last: null, t: 0 };
}

/* ───────── órdenes: real o simulada ───────── */
let simN = 0; const simOrd = new Map();
async function ordenNueva(lado, qty, px) {
  if (!REAL) { const id = `SIM${++simN}|sim`; simOrd.set(id, { status: "NEW", cumQty: 0, avgPx: 0, lado, qty, px }); return id; }
  const j = await api("GET", `/rest/order/newSingleOrder?${q({ marketId: "ROFX", symbol: simbolo(), price: px, orderQty: qty, ordType: "LIMIT", side: lado, timeInForce: "DAY", account: CUENTA, cancelPrevious: false, iceberg: false })}`);
  const o = j?.order || {};
  if (!o.clientId) throw new Error(`Primary no devolvió clientId (${JSON.stringify(j).slice(0, 200)})`);
  return `${o.clientId}|${o.proprietary || ""}`;
}
async function ordenEstado(id) {
  if (!REAL) return simOrd.get(id) || null;
  const [clOrdId, proprietary] = String(id).split("|");
  return (await api("GET", `/rest/order/id?${q({ clOrdId, proprietary })}`))?.order || null;
}
async function ordenCancelar(id) {
  if (!REAL) { const o = simOrd.get(id); if (o && !FINAL.has(o.status)) o.status = "CANCELLED"; return; }
  const [clOrdId, proprietary] = String(id).split("|");
  await api("GET", `/rest/order/cancelById?${q({ clOrdId, proprietary })}`);
}
async function ordenesActivas() {
  if (!REAL) return null;
  return (await api("GET", `/rest/order/actives?${q({ accountId: CUENTA })}`))?.orders || [];
}
function simular(b) {
  for (const o of simOrd.values()) {
    if (FINAL.has(o.status)) continue;
    if (o.lado === "BUY" && b.ask > 0 && b.ask <= o.px) { o.status = "FILLED"; o.cumQty = o.qty; o.avgPx = o.px; }
    if (o.lado === "SELL" && b.bid > 0 && b.bid >= o.px) { o.status = "FILLED"; o.cumQty = o.qty; o.avgPx = o.px; }
  }
}

/* ───────── Telegram (solo eventos importantes, no cada vuelta) ───────── */
let _chat = null;
async function tg(texto) {
  if (!REAL || !ENV.TELEGRAM_BOT_TOKEN || !ENV.SUPABASE_URL) return;
  try {
    if (!_chat) {
      const sb = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
      const { data } = await sb.from("telegram_links").select("chat_id").eq("user_id", USER_ID).eq("enabled", true).maybeSingle();
      _chat = data?.chat_id || null;
    }
    if (_chat) await fetch(`https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: _chat, text: texto, parse_mode: "HTML" }) });
  } catch (e) { log(`telegram: ${e.message}`); }
}

/* ───────── estado ───────── */
// El estado NO es por día: los papeles que no se vendieron quedan para la
// rueda siguiente (LP 01/10/2026: "si no se venden, hay que dejarlos abiertos
// al próximo día"). Lo diario (P&L, vueltas, cierre) se reinicia en nuevoDia().
const ARCH = path.join(process.cwd(), REAL ? "estado.json" : "estado-sim.json");
function archivoPrevio() {
  // Migración: el estado de la versión anterior se llamaba estado-<fecha>.json.
  const v = fs.readdirSync(process.cwd()).filter((f) => /^estado-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
  return v.length ? path.join(process.cwd(), v[v.length - 1]) : null;
}
let S = { dia: diaAr(), real: REAL, ancla: null, reentrada: null, niveles: Array.from({ length: NIVELES }, () => ({ held: 0, costo: 0 })), ordenes: [], pnl: 0, rondas: 0, comprado: 0, vendido: 0, fin: null, base: null };
function heldTot() { return S.niveles.reduce((a, n) => a + n.held, 0); }
const NIVEL_REF = NIVELES;                       // índice del nivel del refuerzo en S.niveles
function normalizar() { while (S.niveles.length <= NIVEL_REF) S.niveles.push({ held: 0, costo: 0 }); if (S.reforzado == null) S.reforzado = false; }
const vivas = () => S.ordenes.filter((o) => !o.final);
// La simulación no retoma estado: sus órdenes viven en memoria.
if (REAL && !CHEQUEO) {
  const origen = fs.existsSync(ARCH) ? ARCH : archivoPrevio();
  if (origen) { S = JSON.parse(fs.readFileSync(origen, "utf8")); log(`retomo el estado (${path.basename(origen)}, del ${S.dia}): ${vivas().length} órdenes vivas, ${heldTot()} papeles, P&L ${pesos(S.pnl)}`); }
}
normalizar();
const guardar = () => { if (!CHEQUEO) fs.writeFileSync(ARCH, JSON.stringify(S)); };
let rechazos = 0, pausaCompras = 0, ultimoResumen = 0, ultimaTenencia = 0, excesos = 0;

async function colocar(lado, nivel, qty, px) {
  // Si la respuesta se pierde, la orden queda como "dudosa" y se busca en las
  // activas antes de volver a mandar (no duplicar).
  const o = { id: null, lado, nivel, qty, px, cum: 0, avg: 0, final: false, t: Date.now(), duda: false };
  try {
    o.id = await ordenNueva(lado, qty, px);
    S.ordenes.push(o); guardar(); rechazos = 0;
    log(`${lado === "BUY" ? "compra" : "venta"} apoyada · escalón ${nivel + 1} · ${qty} × ${pesos(px)}`);
  } catch (e) {
    if (e.rechazo) { rechazos++; log(`ERROR orden rechazada (${lado} ${qty} × ${px}): ${e.message}`); }
    else { o.duda = true; S.ordenes.push(o); guardar(); log(`ERROR sin respuesta al mandar ${lado} ${qty} × ${px}: ${e.message} — la busco antes de reintentar`); }
  }
}
function aplicarFill(o, cum, avg) {
  const dq = cum - o.cum; if (!(dq > 0)) return;
  const dN = cum * avg - o.cum * o.avg;
  const L = S.niveles[o.nivel];
  if (o.lado === "BUY") {
    L.held += dq; L.costo += dN; S.comprado += dN;
    if (S.ancla == null) { S.ancla = avg; S.reentrada = null; }
    log(`COMPRA ejecutada · escalón ${o.nivel + 1} · ${dq} × ${pesos(dN / dq)} · tengo ${heldTot()}`);
  } else {
    const costo = L.held > 0 ? L.costo * (dq / L.held) : 0;
    L.held -= dq; L.costo -= costo; if (L.held <= 0) { L.held = 0; L.costo = 0; }
    const neto = dN - costo - FEE * (dN + costo);
    S.pnl += neto; S.vendido += dN; S.rondas++;
    log(`VENTA ejecutada · escalón ${o.nivel + 1} · ${dq} × ${pesos(dN / dq)} · neto de la vuelta ${pesos(neto)} · P&L del día ${pesos(S.pnl)} · quedan ${heldTot()}`);
  }
  o.cum = cum; o.avg = avg;
}
async function sincronizar(b) {
  if (!REAL) simular(b);
  const vs = vivas(); if (!vs.length) return;
  const acts = await ordenesActivas();
  const porCl = new Map((acts || []).map((a) => [String(a.clOrdId), a]));
  const conocidas = new Set(S.ordenes.filter((o) => o.id).map((o) => String(o.id).split("|")[0]));
  for (const o of vs) {
    if (o.duda) {
      const hit = (acts || []).find((a) => a.instrumentId?.symbol === simbolo() && a.side === o.lado && Number(a.price) === o.px && Number(a.orderQty) === o.qty && !conocidas.has(String(a.clOrdId)));
      if (hit) { o.id = `${hit.clOrdId}|${hit.proprietary || ""}`; o.duda = false; conocidas.add(String(hit.clOrdId)); log(`orden dudosa encontrada en Primary: ${o.id}`); }
      else if (Date.now() - o.t > 20_000) { o.final = true; log("orden dudosa: no está en Primary, la descarto"); }
      continue;
    }
    let e = porCl.get(String(o.id).split("|")[0]) || null;
    if (!e) { try { e = await ordenEstado(o.id); } catch (err) { log(`estado ${o.id}: ${err.message}`); continue; } }
    if (!e) continue;
    aplicarFill(o, Number(e.cumQty) || 0, Number(e.avgPx) || o.px);
    const st = String(e.status || "").toUpperCase();
    if (FINAL.has(st)) {
      o.final = true;
      if (st === "REJECTED") { rechazos++; log(`ERROR orden rechazada por el mercado: ${e.text || ""}`); }
    }
  }
  guardar();
}
async function cancelar(o, motivo) {
  if (o.final || o.duda || (o.cancelT && Date.now() - o.cancelT < 20_000)) return;
  o.cancelT = Date.now();
  try { await ordenCancelar(o.id); log(`cancelo ${o.lado === "BUY" ? "compra" : "venta"} escalón ${o.nivel + 1} (${motivo})`); }
  catch (e) { log(`cancelar ${o.id}: ${e.message}`); }
}

/* Corta todo: cancela, espera los estados finales y vende lo que quede. */
async function liquidar(motivo) {
  S.fin = motivo; guardar();
  log(`CORTE (${motivo}): cancelo todo y vendo ${heldTot()} papeles`);
  for (let i = 0; i < 12 && vivas().length; i++) { for (const o of vivas()) { o.cancelT = 0; await cancelar(o, motivo); } await dormir(2500); await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`)); }
  for (let intento = 0; intento < 8 && heldTot() > 0; intento++) {
    const b = await libro();
    if (!(b.bid > 0)) { log("sin punta compradora para liquidar, espero"); await dormir(5000); continue; }
    // Todo al escalón 1 para vender en una sola orden.
    const tot = heldTot(), costo = S.niveles.reduce((a, n) => a + n.costo, 0);
    S.niveles.forEach((n, k) => { n.held = k === 0 ? tot : 0; n.costo = k === 0 ? costo : 0; });
    await colocar("SELL", 0, tot, alTick(b.bid * (1 - 0.003 * (1 + intento)), "abajo"));
    for (let i = 0; i < 10 && vivas().length; i++) { await dormir(2500); await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`)); }
    for (const o of vivas()) { o.cancelT = 0; await cancelar(o, "reintento de liquidación"); }
    await dormir(2500); await sincronizar(await libro()).catch(() => {});
  }
  const resto = heldTot();
  const msg = `CIERRE del día (${motivo}) · ${S.rondas} ventas · P&L neto ${pesos(S.pnl)}${resto ? ` · OJO: quedaron ${resto} papeles sin vender` : ""}`;
  log(msg); guardar();
  await tg(`<b>SCALP ${TK} · cuenta ${CUENTA}</b>\n${msg}`);
}

/* Cierre de la rueda SIN vender: cancela lo apoyado y deja los papeles para
 * mañana. (SCALP_CIERRE_VENDE=1 vuelve al cierre que liquida todo.) */
async function cerrarDia() {
  for (let i = 0; i < 12 && vivas().length; i++) { for (const o of vivas()) { o.cancelT = 0; await cancelar(o, "cierre de la rueda"); } await dormir(2500); await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`)); }
  const n = heldTot(), costo = S.niveles.reduce((a, x) => a + x.costo, 0);
  S.fin = n ? `cierre de la rueda: quedan ${n} papeles abiertos para mañana (costo ${pesos(costo)})` : "cierre de la rueda: sin papeles";
  guardar();
  const msg = `CIERRE del día (${S.fin}) · ${S.rondas} ventas · P&L realizado ${pesos(S.pnl)}`;
  log(msg); await tg(`<b>SCALP ${TK} · cuenta ${CUENTA}</b>\n${msg}`);
}
/* Rueda nueva con estado de una anterior: las órdenes eran por el día, así
 * que ya no existen; se consulta su estado final (una venta pudo ejecutarse
 * después del último registro) y recién ahí se reinicia lo diario. Si la
 * cuenta tiene MENOS papeles de los que el bot cree llevar, no opera. */
async function nuevoDia() {
  log(`rueda nueva (el estado era del ${S.dia}): reviso las órdenes de ayer`);
  if (REAL) await sincronizar(await libro()).catch((e) => log(`sync: ${e.message}`));
  for (const o of vivas()) { o.final = true; log(`orden de ayer sin estado final (${o.lado} ${o.qty} × ${o.px}): la doy por vencida`); }
  const n = heldTot();
  S.dia = diaAr(); S.pnl = 0; S.rondas = 0; S.comprado = 0; S.vendido = 0; S.fin = null; S.reentrada = null; S.ordenes = [];
  if (REAL) {
    const t = await tenenciaCuenta().catch(() => null);
    if (t != null && t < n) { S.fin = `la cuenta tiene ${t} ${TK} y el bot lleva ${n}: no opero hasta revisar`; log(`ERROR ${S.fin}`); await tg(`<b>SCALP ${TK} · cuenta ${CUENTA}</b>\n${S.fin}`); }
    S.base = t != null ? t - n : null;
  }
  guardar();
  log(`arranco la rueda con ${n} papeles de ayer · ancla ${S.ancla ? pesos(S.ancla) : "—"}`);
}

async function ciclo() {
  if (S.dia !== diaAr()) { if (!esHabil() || hhmmAr() < HORA_INICIO) return; await nuevoDia(); }
  const b = await libro();
  await sincronizar(b);
  if (S.fin) return;
  if (fs.existsSync(path.join(process.cwd(), "STOP"))) return liquidar("archivo STOP");
  const hm = hhmmAr();
  if (hm >= HORA_CIERRE) return CIERRE_VENDE ? liquidar("hora de cierre") : cerrarDia();
  if (!esHabil() || hm < HORA_INICIO) return;
  if (rechazos >= 3) { for (const o of vivas()) await cancelar(o, "rechazos"); S.fin = "tres órdenes rechazadas seguidas"; guardar(); log(`ERROR ${S.fin}: me detengo, revisar a mano (tengo ${heldTot()} papeles)`); await tg(`<b>SCALP ${TK} · cuenta ${CUENTA}</b>\nTres órdenes rechazadas seguidas: me detuve con ${heldTot()} papeles. Revisar a mano.`); return; }
  if (!(b.bid > 0) || !(b.ask > 0)) return;                       // sin libro no se decide nada
  const tot = heldTot();
  const abierto = tot > 0 ? tot * b.bid - S.niveles.reduce((a, n) => a + n.costo, 0) : 0;
  if (S.ancla && b.bid <= S.ancla * (1 - CORTE)) return liquidar(`cayó ${(CORTE * 100).toFixed(1)}% desde el ancla ${pesos(S.ancla)}`);
  if (S.pnl + abierto <= -PERDIDA_MAX) return liquidar(`pérdida del día ${pesos(S.pnl + abierto)}`);

  // Control contra duplicados: la cuenta no puede tener MÁS papeles de los que
  // este bot cree tener (base = tenencia al arrancar, antes de la primera orden).
  if (REAL && S.base != null && Date.now() - ultimaTenencia > 60_000) {
    ultimaTenencia = Date.now();
    try {
      const t = await tenenciaCuenta();
      if (t > S.base + tot) { if (++excesos >= 2 && !pausaCompras) { pausaCompras = 1; log(`ERROR la cuenta tiene ${t} ${TK} y yo llevo ${tot} (base ${S.base}): pauso las compras`); await tg(`<b>SCALP ${TK} · cuenta ${CUENTA}</b>\nLa cuenta tiene ${t} y el bot lleva ${tot}: compras pausadas. Revisar.`); } }
      else excesos = 0;
    } catch (e) { log(`tenencia: ${e.message}`); }
  }

  const vs = vivas();
  // Fin de ciclo: todo vendido → la próxima compra vuelve al precio del ancla
  // y, si en REANCLA no se da, sigue a la punta.
  if (S.ancla && tot === 0 && !vs.some((o) => o.lado === "SELL" || o.cum > 0)) {
    S.reentrada = { px: alTick(S.ancla, "abajo"), hasta: Date.now() + REANCLA_MS };
    log(`ciclo completo · P&L del día ${pesos(S.pnl)} · ${S.rondas} ventas`);
    S.ancla = null; S.reforzado = false; guardar();
  }
  // Refuerzo ejecutado: se cancelan las ventas por escalón y, recién cuando no
  // queda ninguna viva, se junta todo en el escalón 1 para salir en el promedio.
  const ref = S.niveles[NIVEL_REF];
  if (ref.held > 0 && !vs.some((o) => o.lado === "BUY" && o.nivel === NIVEL_REF)) {
    const ventas = vs.filter((o) => o.lado === "SELL");
    if (ventas.length) { for (const v of ventas) await cancelar(v, "refuerzo: salida en el promedio"); return; }
    const costo = S.niveles.reduce((a, n) => a + n.costo, 0);
    S.niveles.forEach((n, k) => { n.held = k === 0 ? tot : 0; n.costo = k === 0 ? costo : 0; });
    S.reforzado = true; guardar();
    log(`refuerzo: ${tot} papeles a un promedio de ${pesos(costo / tot)} · salida conjunta a ${pesos(alTick((costo / tot) * (1 + GANANCIA), "arriba"))}`);
    return;
  }
  // Ventas: cada escalón con papeles y sin compra en curso tiene su venta.
  for (let k = 0; k < NIVELES; k++) {
    const L = S.niveles[k]; if (!(L.held > 0)) continue;
    if (vs.some((o) => o.lado === "BUY" && o.nivel === k)) continue;
    const v = vs.find((o) => o.lado === "SELL" && o.nivel === k);
    if (!v) await colocar("SELL", k, L.held, alTick((L.costo / L.held) * (1 + GANANCIA), "arriba"));
    else if (!v.duda && v.qty - v.cum !== L.held) await cancelar(v, "cantidad distinta a la tenencia");
  }
  // Compra: una sola apoyada, en el escalón siguiente al más bajo con papeles.
  let h = -1; S.niveles.forEach((n, k) => { if (n.held > 0) h = k; });
  const deseado = h + 1;
  const compras = vs.filter((o) => o.lado === "BUY");
  for (const c of compras) if (c.nivel !== deseado && c.cum === 0 && !(c.nivel === NIVEL_REF && tot >= MAX)) await cancelar(c, "la grilla se movió");
  const c0 = compras.find((c) => c.nivel === 0 && c.cum === 0);
  const enReentrada = S.reentrada && Date.now() < S.reentrada.hasta;
  const tarde = hm >= HORA_ULTIMO_CICLO;
  if (c0 && h === -1 && tarde) await cancelar(c0, "ya no se abren ciclos nuevos hoy");
  else if (c0 && h === -1 && !enReentrada && b.bid > c0.px * 1.001 && Date.now() - c0.t > 60_000) await cancelar(c0, "el precio se alejó");
  // Refuerzo: grilla llena, sin refuerzo previo en este ciclo.
  if (REFUERZO_FRAC > 0 && !S.reforzado && !compras.length && S.ancla && tot >= MAX && ref.held === 0 && !pausaCompras) {
    const pxRef = alTick(S.ancla * (1 - REFUERZO_MULT * PASO * (NIVELES - 1)), "abajo");
    const qtyRef = Math.round(tot * REFUERZO_FRAC);
    if (qtyRef > 0) await colocar("BUY", NIVEL_REF, qtyRef, Math.min(pxRef, b.ask));
  }
  if (!S.reforzado && !compras.length && deseado < NIVELES && tot + LOTE <= MAX && !pausaCompras && (deseado === 0 ? !tarde : S.ancla)) {
    let px;
    if (deseado === 0) px = enReentrada && b.bid > S.reentrada.px ? S.reentrada.px : b.bid;
    else px = Math.min(alTick(S.ancla * (1 - PASO * deseado), "abajo"), b.ask);
    await colocar("BUY", deseado, LOTE, px);
  }
  if (Date.now() - ultimoResumen > 5 * 60_000) {
    ultimoResumen = Date.now();
    log(`estado · tengo ${tot} · ancla ${S.ancla ? pesos(S.ancla) : "—"} · libro ${pesos(b.bid)}/${pesos(b.ask)} · abierto ${pesos(abierto)} · P&L del día ${pesos(S.pnl)} · ${S.rondas} ventas`);
  }
}

async function main() {
  if (FAKE) TICK = 25;
  else {
    TICK = Number((await api("GET", `/rest/instruments/detail?${q({ marketId: "ROFX", symbol: simbolo() })}`))?.instrument?.minPriceIncrement) || 1;
    await wsConectar();
    for (let i = 0; i < 10 && !book.t; i++) await dormir(1000);
  }
  const b = await libro();
  const disp = FAKE ? null : await disponible24().catch(() => null);
  const ten = FAKE ? null : await tenenciaCuenta().catch(() => null);
  log(`${REAL ? "*** ÓRDENES REALES ***" : "SIMULADO"} · lote ${LOTE} · máximo ${MAX} (${NIVELES} escalones) · paso ${(PASO * 100).toFixed(2)}% · ganancia ${(GANANCIA * 100).toFixed(2)}% · ${REFUERZO_FRAC > 0 ? `refuerzo ${Math.round(MAX * REFUERZO_FRAC)} a −${(REFUERZO_MULT * PASO * (NIVELES - 1) * 100).toFixed(1)}% · ` : ""}corte ${CORTE >= 0.9 ? "apagado" : (CORTE * 100).toFixed(1) + "%"} · cierre ${HORA_CIERRE} · tope de pérdida ${pesos(PERDIDA_MAX)}`);
  log(`cuenta ${CUENTA} · tick ${TICK} · libro ${b.bid}/${b.ask} (último ${b.last}) · disponible ${disp == null ? "?" : pesos(disp)} · tenencia de ${TK} en la cuenta ${ten ?? "?"}`);
  if (b.bid > 0 && b.ask > 0) {
    const sp = (b.ask - b.bid) / b.bid;
    log(`spread ${(sp * 100).toFixed(3)}% · costo ida y vuelta ${(2 * FEE * 100).toFixed(3)}% · neto por vuelta de ${LOTE}: ${pesos(LOTE * b.bid * (GANANCIA - 2 * FEE))} · exposición máxima ${pesos(MAX * (1 + REFUERZO_FRAC) * b.ask)} · ${CORTE >= 0.9 ? "sin corte: no vende con pérdida" : `pérdida si corta con todo cargado ≈ ${pesos(MAX * b.ask * (CORTE - PASO * (NIVELES - 1) / 2 + 2 * FEE))}`}`);
  }
  if (CHEQUEO) process.exit(0);
  if (SOLO_SYNC) {
    if (!REAL) { log("--sincronizar solo tiene sentido con órdenes reales"); process.exit(1); }
    await sincronizar(b);
    log(`sincronizado · tengo ${heldTot()} (cuenta ${ten ?? "?"}) · órdenes vivas ${vivas().length} · P&L ${pesos(S.pnl)} · ${S.rondas} ventas`);
    guardar(); process.exit(0);
  }
  if (S.dia !== diaAr() && esHabil() && hhmmAr() >= HORA_INICIO) await nuevoDia();
  if (S.fin) log(`el día ya se cerró (${S.fin}). Mañana retoma solo.`);
  if (REAL && disp != null && b.ask > 0 && disp < MAX * (1 + REFUERZO_FRAC) * b.ask * 1.01) { log(`ERROR disponible ${pesos(disp)} menor a la exposición máxima ${pesos(MAX * b.ask)}: no arranco`); process.exit(1); }
  if (REAL && S.base == null && ten != null) { S.base = ten - heldTot(); guardar(); }
  let ocupado = false;
  setInterval(async () => {
    if (ocupado) return; ocupado = true;
    try { await ciclo(); } catch (e) { log(`ERROR ciclo: ${e.message}`); }
    ocupado = false;
  }, CICLO_MS);
}
// Al apagarlo: se cancelan las COMPRAS apoyadas; las ventas quedan en el
// mercado y los papeles en la cuenta. Para cerrar todo: crear el archivo STOP.
let saliendo = false;
async function salir() {
  if (saliendo) return; saliendo = true;
  for (const o of vivas()) if (o.lado === "BUY" && o.cum === 0 && o.id) { try { await ordenCancelar(o.id); } catch { /* sigue */ } }
  log(`apagado: compras canceladas; quedan ${heldTot()} papeles con sus ventas apoyadas`);
  process.exit(0);
}
process.on("SIGINT", salir); process.on("SIGTERM", salir);
main().catch((e) => { console.error(`[scalp ${TK}] fatal: ${e.message}`); process.exit(1); });
