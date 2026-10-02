/**
 * scalp-estado: publica en Supabase el estado de los bots de grilla de Cocos
 * para la pantalla "Bot Scalping" de Midas (LP 02/10/2026: "un reporte
 * exclusivo para mí, para ver lo que está haciendo el bot, con las dos cuentas").
 *
 * SOLO LECTURA sobre los bots: lee de cada carpeta ~/workers/cocos*-scalp*
 * su .env (configuración), estado.json (tenencia, órdenes, resultado) y el
 * log del día (compras y ventas), y el precio del feed de CEDEARs. No manda
 * órdenes ni toca archivos de los bots. Escribe scalp_estado (una fila por
 * cuenta + papel) y scalp_resultados (una fila por día + cuenta + papel).
 * Corre cada 30 s en rueda y cada 5 min fuera de rueda.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const MODS = path.join(__dirname, "..", "cocos-bot", "node_modules");
const WebSocket = require(path.join(MODS, "ws"));
const { createClient } = require(path.join(MODS, "@supabase/supabase-js"));
const RAIZ = path.join(__dirname, "..");
const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661"; // LP
const UNA_VEZ = process.argv.includes("--una-vez");
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const leerEnv = (ruta) => { const o = {}; if (!fs.existsSync(ruta)) return o; for (const l of fs.readFileSync(ruta, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); } return o; };
const E = leerEnv(path.join(RAIZ, "cocos-bot", ".env"));
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
const diaAr = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const hhmmAr = () => { const s = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }); return Number(s.slice(0, 2)) * 100 + Number(s.slice(3, 5)); };
const num = (s) => Number(String(s).replace(/\./g, "").replace(",", "."));

let _feed = { t: 0, m: {} };
async function precios() {
  if (Date.now() - _feed.t < 25_000) return _feed.m;
  try {
    const r = await fetch("https://data912.com/live/arg_cedears", { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12_000) });
    if (r.status === 200) {
      const m = {};
      for (const x of await r.json()) if (x?.symbol) m[String(x.symbol).toUpperCase()] = { bid: Number(x.px_bid) || null, ask: Number(x.px_ask) || null, last: Number(x.c) || null };
      if (Object.keys(m).length > 50) _feed = { t: Date.now(), m };
    }
  } catch { /* se usa el último dato */ }
  return _feed.m;
}
function procesosPm2() {
  try {
    const a = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20e6 }));
    // Solo los procesos de los bots: scalp-resumen comparte carpeta con el de MU
    // y, como figura detenido entre corridas, lo hacía aparecer apagado.
    return new Map(a.filter((p) => /^cocos\d*-scalp/.test(p.name)).map((p) => [p.pm2_env?.pm_cwd, p.pm2_env?.status]));
  } catch { return new Map(); }
}
function leerBot(dir, hoy) {
  const env = { ...leerEnv(path.join(dir, ".env")) };
  const cred = env.SCALP_CREDENCIALES ? leerEnv(path.join(env.SCALP_CREDENCIALES, ".env")) : E;
  const cuenta = cred.COCOS_CUENTA || "72404";
  const ticker = String(env.SCALP_TICKER || "MU").toUpperCase();
  const real = env.SCALP_REAL === "1";
  const arch = path.join(dir, real ? "estado.json" : "estado-sim.json");
  let S = null;
  try { S = JSON.parse(fs.readFileSync(arch, "utf8")); } catch { /* todavía no arrancó */ }
  // Eventos de HOY: compras y ventas ejecutadas (solo de los tramos reales).
  const ev = []; let comprado = 0, vendido = 0, pnlLog = 0, ventas = 0;
  const logs = path.join(dir, "logs");
  if (fs.existsSync(logs)) {
    const archivos = fs.readdirSync(logs).filter((f) => /^out.*\.log$/.test(f)).map((f) => path.join(logs, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    for (const f of archivos) {
      let esReal = false;
      for (const l of fs.readFileSync(f, "utf8").split("\n")) {
        const m = /\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[scalp [A-Z0-9.]+\] (.*)$/.exec(l);
        if (!m) continue;
        const txt = m[2];
        if (txt.startsWith("SIMULADO")) { esReal = false; continue; }
        if (txt.includes("ÓRDENES REALES")) { esReal = true; continue; }
        if (!esReal) continue;
        const t = new Date(m[1]);
        if (diaAr(t) !== hoy) continue;
        let x;
        if ((x = /^COMPRA ejecutada · escalón (\d+) · (\d+) × \$([\d.]+)/.exec(txt))) { const q = +x[2], p = num(x[3]); ev.push({ t: m[1], tipo: "compra", esc: +x[1], q, px: p }); comprado += q * p; }
        else if ((x = /^VENTA ejecutada · escalón (\d+) · (\d+) × \$([\d.]+) · neto de la vuelta (-?)\$([\d.]+)/.exec(txt))) { const q = +x[2], p = num(x[3]), n = (x[4] ? -1 : 1) * num(x[5]); ev.push({ t: m[1], tipo: "venta", esc: +x[1], q, px: p, neto: n }); vendido += q * p; pnlLog += n; ventas++; }
        else if (/^refuerzo:/.test(txt)) ev.push({ t: m[1], tipo: "refuerzo", txt: txt.slice(10) });
        else if (/^(CORTE|CIERRE del día)/.test(txt)) ev.push({ t: m[1], tipo: "aviso", txt: txt.slice(0, 160) });
        else if (/^ERROR/.test(txt)) ev.push({ t: m[1], tipo: "error", txt: txt.slice(0, 160) });
      }
    }
  }
  return { dir, env, cuenta, ticker, real, S, ev, comprado, vendido, pnlLog, ventas };
}

async function pasada() {
  const hoy = diaAr();
  const px = await precios();
  const pm2 = procesosPm2();
  const dirs = fs.readdirSync(RAIZ).filter((d) => /^cocos\d*-scalp/.test(d)).map((d) => path.join(RAIZ, d));
  const filas = [], resultados = [];
  for (const dir of dirs) {
    let b;
    try { b = leerBot(dir, hoy); } catch (e) { log(`${path.basename(dir)}: ${e.message}`); continue; }
    if (!b.real) continue;                                     // solo bots con órdenes reales
    const S = b.S || {};
    const niveles = (S.niveles || []).map((n, k) => ({ k: k + 1, tenencia: n.held, costo: Math.round(n.costo) })).filter((n) => n.tenencia > 0);
    const tenencia = niveles.reduce((a, n) => a + n.tenencia, 0);
    const costo = niveles.reduce((a, n) => a + n.costo, 0);
    const p = px[b.ticker] || {};
    const ref = p.bid || p.last || null;
    const cfg = b.env;
    const lote = Number(cfg.SCALP_LOTE || 2), max = Number(cfg.SCALP_MAX || 10);
    const delDia = S.dia === hoy;
    filas.push({
      user_id: USER_ID, cuenta: b.cuenta, ticker: b.ticker, actualizado_at: new Date().toISOString(),
      online: pm2.get(dir) === "online", real: b.real,
      config: { lote, max, escalones: Math.floor(max / lote), paso: Number(cfg.SCALP_PASO || 0.003), ganancia: Number(cfg.SCALP_GANANCIA || 0.0025), refuerzo: Number(cfg.SCALP_REFUERZO_FRAC || 0), corte: Number(cfg.SCALP_CORTE || 0.018) },
      tenencia, costo, ancla: S.ancla ?? null, niveles,
      ordenes: (S.ordenes || []).filter((o) => !o.final).map((o) => ({ lado: o.lado, esc: o.nivel + 1, q: o.qty, px: o.px, ejecutado: o.cum })),
      bid: p.bid ?? null, ask: p.ask ?? null, ultimo: p.last ?? null,
      latente: tenencia > 0 && ref ? Math.round(tenencia * ref - costo) : 0,
      pnl_dia: delDia ? Math.round(S.pnl || 0) : Math.round(b.pnlLog), ventas_dia: delDia ? (S.rondas || 0) : b.ventas,
      reforzado: !!S.reforzado, fin: delDia ? (S.fin || null) : null,
      eventos: b.ev.slice(-60),
    });
    const latente = tenencia > 0 && ref ? Math.round(tenencia * ref - costo) : 0;
    const expo = Math.round(max * (1 + Number(cfg.SCALP_REFUERZO_FRAC || 0)) * (p.ask || p.last || p.bid || 0));
    resultados.push({ user_id: USER_ID, fecha: hoy, cuenta: b.cuenta, ticker: b.ticker, pnl: Math.round(b.pnlLog), ventas: b.ventas, comprado: Math.round(b.comprado), vendido: Math.round(b.vendido), tenencia_cierre: tenencia, costo_cierre: costo, latente_cierre: latente, exposicion_max: expo });
  }
  if (!filas.length) { log("sin bots reales"); return; }
  const { error } = await sb.from("scalp_estado").upsert(filas, { onConflict: "user_id,cuenta,ticker" });
  if (error) log(`scalp_estado: ${error.message}`);
  // El resultado del día solo se escribe en días hábiles (no pisar con ceros un feriado).
  const dow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" })).getDay();
  if (dow >= 1 && dow <= 5 && hhmmAr() >= 1035) {
    const { error: e2 } = await sb.from("scalp_resultados").upsert(resultados, { onConflict: "user_id,fecha,cuenta,ticker" });
    if (e2) log(`scalp_resultados: ${e2.message}`);
  }
  return filas.length;
}

async function main() {
  const n = await pasada();
  log(`publicado: ${n || 0} bots`);
  if (UNA_VEZ) process.exit(0);
  let ocupado = false, ultima = Date.now();
  setInterval(async () => {
    const hm = hhmmAr(), rueda = hm >= 1025 && hm <= 1710;
    if (ocupado || Date.now() - ultima < (rueda ? 29_000 : 299_000)) return;
    ocupado = true; ultima = Date.now();
    try { await pasada(); } catch (e) { log(`pasada: ${e.message}`); }
    ocupado = false;
  }, 5000);
}
main().catch((e) => { console.error(`[scalp-estado] ${e.message}`); process.exit(1); });
