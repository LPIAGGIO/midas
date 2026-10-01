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
  const archivos = fs.readdirSync(logs).filter((f) => /^out.*\.log$/.test(f)).map((f) => path.join(logs, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  for (const f of archivos) {
    let real = false;
    for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      const m = /\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[scalp ([A-Z0-9.]+)\] (.*)$/.exec(l);
      if (!m) continue;
      const t = new Date(m[1]);
      if (t.toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }) !== hoy) continue;
      const txt = m[3];
      if (txt.startsWith("SIMULADO")) { real = false; continue; }
      if (txt.includes("ÓRDENES REALES")) { real = true; tk = m[2]; continue; }
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
  const arch = path.join(dir, `estado-${hoy}.json`);
  if (fs.existsSync(arch)) { try { est = JSON.parse(fs.readFileSync(arch, "utf8")); } catch { /* sin estado */ } }
  return { tk, ev, est };
}
function armar(b) {
  const L = [`<b>SCALP ${b.tk} · ${hoy.split("-").reverse().join("/")}</b>`];
  let comprado = 0, vendido = 0, qC = 0;
  for (const e of b.ev) {
    if (e.tipo === "compra") { L.push(`${e.hora} compra ${e.qty} × ${plata(e.px)} (escalón ${e.esc})`); comprado += e.qty * e.px; qC += e.qty; }
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
  if (quedan) L.push(`<b>OJO: quedaron ${quedan} papeles sin vender</b> (costo ${plata(b.est.niveles.reduce((a, n) => a + n.costo, 0))})`);
  if (b.est?.fin) L.push(`Cierre: ${b.est.fin}`);
  else if (b.est) L.push("El bot no registró el cierre del día (revisar).");
  L.push(`<b>Resultado del día (neto de comisiones): ${pesos(total)}</b>`);
  if (comprado > 0) L.push(`Sobre lo operado: ${(total / comprado * 100).toFixed(3).replace(".", ",")}%`);
  return { texto: L.join("\n"), total, vueltas: ventas.length };
}
async function main() {
  // Antes del cierre de las grillas (16:45) no se manda: el detalle estaría a medias.
  const hm = Number(new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }).slice(0, 5).replace(":", ""));
  if (!DRY && !process.argv.includes("--forzar") && hm < 1646) { console.log(`son las ${hm}: el resumen sale después de las 16:45`); return; }
  const bots = fs.readdirSync(RAIZ).filter((d) => /^cocos-scalp/.test(d)).map((d) => leerBot(path.join(RAIZ, d))).filter((b) => b && b.ev.length);
  if (!bots.length) { console.log("sin operaciones reales de scalp hoy: no mando nada"); return; }
  const partes = bots.map(armar);
  const mensajes = partes.map((p) => p.texto);
  if (bots.length > 1) mensajes.push(`<b>SCALP · total del día</b>\n${bots.map((b, i) => `${b.tk}: ${pesos(partes[i].total)} en ${partes[i].vueltas} vueltas`).join("\n")}\n<b>Total: ${pesos(partes.reduce((a, p) => a + p.total, 0))}</b>`);
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
  console.log(`resumen enviado: ${mensajes.length} mensajes`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(`[resumen scalp] ${e.message}`); process.exit(1); });
