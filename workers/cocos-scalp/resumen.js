/**
 * cocos-scalp / resumen: mensaje de Telegram al cierre con el detalle del día
 * de cada grilla (LP 01/10/2026: "un mensaje exclusivo con las entradas y
 * salidas por papel, cuánto ganó o perdió por vuelta y al final del día").
 *
 * SOLO LECTURA: no manda órdenes ni toca el estado de los bots. Lee los logs
 * de ~/workers/cocos-scalp* (las líneas COMPRA/VENTA ejecutada de HOY, solo
 * de los tramos con órdenes reales) y el estado-<fecha>.json de cada uno.
 *   node resumen.js --dry     imprime el mensaje sin mandarlo
 */
const fs = require("fs");
const path = require("path");
const MODS = path.join(__dirname, "..", "cocos-bot", "node_modules");
const WebSocket = require(path.join(MODS, "ws"));
const { createClient } = require(path.join(MODS, "@supabase/supabase-js"));
const DRY = process.argv.includes("--dry");
const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661"; // LP
const RAIZ = path.join(__dirname, "..");
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const num = (s) => Number(String(s).replace(/\./g, "").replace(",", "."));
const pesos = (n) => (n < 0 ? "−$" : "+$") + Math.abs(Math.round(n)).toLocaleString("es-AR");
const plata = (n) => "$" + Math.round(n).toLocaleString("es-AR");

function env() {
  const o = {};
  for (const l of fs.readFileSync(path.join(RAIZ, "cocos-bot", ".env"), "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); }
  return o;
}
function leerBot(dir) {
  const logs = path.join(dir, "logs");
  if (!fs.existsSync(logs)) return null;
  const ev = []; let tk = null;
  // La cuenta sale del log ("cuenta 3893 · tick ..."); las carpetas viejas,
  // anteriores a ese renglón, son de la 72404.
  let cuenta = "72404";
  const archivos = fs.readdirSync(logs).filter((f) => /^out.*\.log$/.test(f)).map((f) => path.join(logs, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  for (const f of archivos) {
    let real = false;
    for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      const m = /\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[scalp ([A-Z0-9.]+)\] (.*)$/.exec(l);
      if (!m) continue;
      const t = new Date(m[1]);
      const txt = m[3];
      // El modo (real o simulado) y la cuenta se leen de TODO el log, no solo de
      // hoy: un bot encendido ayer sigue operando hoy sin volver a anunciarse
      // (02/10/2026: el resumen omitia a los cuatro papeles prendidos la noche
      // anterior). Solo los eventos se filtran por fecha.
      if (txt.startsWith("SIMULADO")) { real = false; continue; }
      if (txt.includes("ÓRDENES REALES")) { real = true; tk = m[2]; continue; }
      const mc = /^cuenta (\d+) ·/.exec(txt);
      if (mc) { cuenta = mc[1]; continue; }
      if (t.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }) !== hoy) continue;
      if (!real) continue;
      const hora = t.toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }).slice(0, 5);
      let x;
      if ((x = /^COMPRA ejecutada · escalón (\d+) · (\d+) × \$([\d.]+)/.exec(txt))) ev.push({ t, hora, tipo: "compra", esc: +x[1], qty: +x[2], px: num(x[3]) });
      else if ((x = /^VENTA ejecutada · escalón (\d+) · (\d+) × \$([\d.]+) · neto de la vuelta (-?)\$([\d.]+)/.exec(txt))) ev.push({ t, hora, tipo: "venta", esc: +x[1], qty: +x[2], px: num(x[3]), neto: (x[4] ? -1 : 1) * num(x[5]) });
      else if (txt.startsWith("CORTE")) ev.push({ t, hora, tipo: "corte", txt: txt.replace(/: cancelo todo.*$/, "") });
    }
  }
  if (!tk) return null;
  ev.sort((a, b) => a.t - b.t);
  let est = null;
  const arch = fs.existsSync(path.join(dir, "estado.json")) ? path.join(dir, "estado.json") : path.join(dir, `estado-${hoy}.json`);
  if (fs.existsSync(arch)) { try { est = JSON.parse(fs.readFileSync(arch, "utf8")); } catch { /* sin estado */ } }
  return { tk, ev, est, cuenta };
}
function armar(b) {
  const L = [`<b>SCALP ${b.tk} · cuenta ${b.cuenta} · ${hoy.split("-").reverse().join("/")}</b>`];
  let comprado = 0, vendido = 0, qC = 0;
  for (const e of b.ev) {
    if (e.tipo === "compra") { L.push(`${e.hora} compra ${e.qty} × ${plata(e.px)} (${e.esc >= 7 ? "extra del lateral" : e.esc === 6 ? "refuerzo" : `escalón ${e.esc}`})`); comprado += e.qty * e.px; qC += e.qty; }
    else if (e.tipo === "venta") { L.push(`${e.hora} venta ${e.qty} × ${plata(e.px)} → <b>${pesos(e.neto)}</b>`); vendido += e.qty * e.px; }
    else L.push(`${e.hora} ${e.txt}`);
  }
  const ventas = b.ev.filter((e) => e.tipo === "venta");
  const total = ventas.reduce((a, e) => a + e.neto, 0);
  const gan = ventas.filter((e) => e.neto > 0), per = ventas.filter((e) => e.neto <= 0);
  L.push("");
  if (!ventas.length) L.push("Sin vueltas cerradas.");
  else {
    L.push(`Vueltas: ${ventas.length} (${gan.length} ganadas, ${per.length} perdidas)`);
    L.push(`Promedio por vuelta: ${pesos(total / ventas.length)}`);
    if (gan.length) L.push(`Mejor: ${pesos(Math.max(...ventas.map((e) => e.neto)))} · Peor: ${pesos(Math.min(...ventas.map((e) => e.neto)))}`);
  }
  L.push(`Operado: compras ${plata(comprado)} · ventas ${plata(vendido)}`);
  const quedan = b.est ? b.est.niveles.reduce((a, n) => a + n.held, 0) : null;
  if (quedan) L.push(`<b>Quedan ${quedan} papeles abiertos para mañana</b> (costo ${plata(b.est.niveles.reduce((a, n) => a + n.costo, 0))})`);
  if (b.est?.fin && !/^cierre de la rueda/.test(b.est.fin)) L.push(`Cierre: ${b.est.fin}`);
  L.push(`<b>Resultado realizado del día (neto de comisiones): ${pesos(total)}</b>`);
  if (comprado > 0) L.push(`Sobre lo operado: ${(total / comprado * 100).toFixed(3).replace(".", ",")}%`);
  return { texto: L.join("\n"), total, vueltas: ventas.length };
}
async function main() {
  // Antes del cierre de las grillas (16:45) no se manda: el detalle estaría a medias.
  const hm = Number(new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }).slice(0, 5).replace(":", ""));
  if (!DRY && !process.argv.includes("--forzar") && hm < 1700) { console.log(`son las ${hm}: el resumen sale después de las 17:00`); return; }
  const bots = fs.readdirSync(RAIZ).filter((d) => /^cocos\d*-scalp/.test(d)).map((d) => leerBot(path.join(RAIZ, d))).filter((b) => b && b.ev.length)
    .sort((a, b) => a.cuenta.localeCompare(b.cuenta) || a.tk.localeCompare(b.tk));
  const marca = path.join(__dirname, "logs", `resumen-enviado-${hoy}`);
  if (!DRY && !process.argv.includes("--forzar") && fs.existsSync(marca)) { console.log("el resumen de hoy ya se mandó"); return; }
  const partes = bots.map(armar);
  const mensajes = partes.map((p) => p.texto);
  if (bots.length > 1) {
    const cuentas = [...new Set(bots.map((b) => b.cuenta))];
    const L = ["<b>SCALP · total del día</b>"];
    let general = 0;
    for (const c of cuentas) {
      let sub = 0;
      L.push("", `<b>Cuenta ${c}</b>`);
      bots.forEach((b, i) => { if (b.cuenta !== c) return; sub += partes[i].total; L.push(`${b.tk}: ${pesos(partes[i].total)} en ${partes[i].vueltas} ventas`); });
      L.push(`Subtotal: ${pesos(sub)}`);
      general += sub;
    }
    if (cuentas.length > 1) L.push("", `<b>Total general: ${pesos(general)}</b>`);
    else L[L.length - 1] = `<b>Total: ${pesos(general)}</b>`;
    mensajes.push(L.join("\n"));
  }
  if (!process.argv.includes("--detalle")) {
    // Mensaje único: estado de cada bot (scalp_estado) + lo realizado hoy (logs).
    const E0 = env();
    const sb0 = createClient(E0.SUPABASE_URL, E0.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
    const { data: est } = await sb0.from("scalp_estado").select("cuenta,ticker,tenencia,costo,latente,niveles,config,real").eq("user_id", USER_ID);
    const { data: hist } = await sb0.from("scalp_resultados").select("fecha,pnl").eq("user_id", USER_ID);
    const hoyPorBot = new Map(bots.map((b, i) => [`${b.cuenta}|${b.tk}`, partes[i]]));
    const filas = (est || []).filter((f) => f.real);
    if (!filas.length && !bots.length) { console.log("sin bots de scalp reales: no mando nada"); return; }
    const sg = (n) => (n > 0 ? "+" : n < 0 ? "−" : " ") + Math.abs(Math.round(n)).toLocaleString("es-AR");
    const orden = (c) => (c === "72404" ? "0" : "1" + c);
    const cuentas = [...new Set(filas.map((f) => f.cuenta))].sort((a, b) => orden(a).localeCompare(orden(b)));
    const L = [`<b>SCALP · cierre ${hoy.split("-").reverse().join("/")}</b>`];
    let tReal = 0, tLat = 0, tInv = 0, tVentas = 0;
    for (const c of cuentas) {
      const fs_ = filas.filter((f) => f.cuenta === c).sort((a, b) => a.ticker.localeCompare(b.ticker));
      let real = 0, lat = 0, inv = 0, ventas = 0;
      const lineas = ["papel  realizado  v  esc    latente"];
      for (const f of fs_) {
        const p = hoyPorBot.get(`${c}|${f.ticker}`) || { total: 0, vueltas: 0 };
        const esc = (f.niveles || []).filter((n) => !n.tipo || n.tipo === "escalon").length;
        const ext = (f.niveles || []).filter((n) => n.tipo === "extra").length;
        const tope = (f.config && f.config.escalones) || 5;
        real += p.total; lat += Number(f.latente) || 0; inv += Number(f.costo) || 0; ventas += p.vueltas;
        lineas.push(`${f.ticker.padEnd(5)} ${sg(p.total).padStart(10)} ${String(p.vueltas).padStart(2)}  ${esc}/${tope}${ext ? "+" + ext : "  "} ${(Number(f.tenencia) > 0 ? sg(Number(f.latente) || 0) : "—").padStart(9)}`);
      }
      L.push("", `<b>Cuenta ${c}</b>`, `<pre>${lineas.join("\n")}</pre>`, `Realizado ${sg(real)} en ${ventas} ventas · latente ${sg(lat)} · invertido $${Math.round(inv).toLocaleString("es-AR")}`);
      tReal += real; tLat += lat; tInv += inv; tVentas += ventas;
    }
    const acum = (hist || []).filter((h) => h.fecha !== hoy).reduce((a, h) => a + Number(h.pnl || 0), 0) + tReal;
    const ruedas = new Set((hist || []).map((h) => h.fecha).concat([hoy])).size;
    L.push("", "<b>Total del día</b>",
      `Realizado ${sg(tReal)} en ${tVentas} ventas`,
      `Latente ${sg(tLat)} (lo que sigue abierto)`,
      `<b>Resultado: ${sg(tReal + tLat)}</b>${tInv > 0 ? ` · ${((tReal + tLat) / tInv * 100).toFixed(2).replace(".", ",")}% de lo invertido` : ""}`,
      `Invertido $${Math.round(tInv).toLocaleString("es-AR")}`,
      "", `Acumulado ${ruedas} ${ruedas === 1 ? "rueda" : "ruedas"}: realizado ${sg(acum)} · con el latente de hoy ${sg(acum + tLat)}`,
      "v = ventas · esc = escalones cargados · lo abierto se arrastra a la próxima rueda");
    mensajes.length = 0; mensajes.push(L.join("\n"));
  } else if (!bots.length) { console.log("sin operaciones reales de scalp hoy: no mando nada"); return; }
  if (DRY) { console.log(mensajes.join("\n\n────────\n\n")); return; }
  const E = env();
  const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
  const { data } = await sb.from("telegram_links").select("chat_id").eq("user_id", USER_ID).eq("enabled", true).maybeSingle();
  if (!data?.chat_id) throw new Error("LP no tiene Telegram vinculado");
  for (const m of mensajes) {
    // Telegram corta en 4096 caracteres: un día de muchas vueltas va en tramos.
    const lineas = m.split("\n"); let tramo = "";
    const tramos = [];
    for (const l of lineas) { if ((tramo + "\n" + l).length > 3800) { tramos.push(tramo); tramo = l; } else tramo = tramo ? tramo + "\n" + l : l; }
    if (tramo) tramos.push(tramo);
    for (const t of tramos) {
      const r = await fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: data.chat_id, text: t, parse_mode: "HTML" }) });
      if (!r.ok) throw new Error(`Telegram HTTP ${r.status} ${(await r.text()).slice(0, 150)}`);
    }
  }
  fs.writeFileSync(marca, new Date().toISOString());
  console.log(`resumen enviado: ${mensajes.length} mensajes`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(`[resumen scalp] ${e.message}`); process.exit(1); });
