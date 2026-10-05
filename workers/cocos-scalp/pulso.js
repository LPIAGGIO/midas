#!/usr/bin/env node
/* Pulso de los scalps para el chat (solo lectura): una línea por papel y cuenta
 * con lo realizado hoy, las ventas, los escalones cargados y el latente al
 * último precio. No toca nada: lee estado.json, .env, los logs y data912.
 *   node pulso.js            tabla completa
 */
const fs = require("fs");
const path = require("path");
const W = path.join(__dirname, "..");
const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
const hora = new Date().toLocaleTimeString("en-GB", { timeZone: "America/Argentina/Buenos_Aires" }).slice(0, 5);
const env = (d) => Object.fromEntries(fs.readFileSync(path.join(W, d, ".env"), "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
const n0 = (x) => (x > 0 ? "+" : x < 0 ? "-" : " ") + Math.abs(Math.round(x)).toLocaleString("es-AR");

(async () => {
  const px = {};
  try {
    for (const r of await (await fetch("https://data912.com/live/arg_cedears")).json()) px[r.symbol] = r.c || r.px_bid;
  } catch (e) { console.log("sin precios de data912: " + e.message); }
  const dirs = fs.readdirSync(W).filter((d) => /^cocos2?-scalp/.test(d) && fs.existsSync(path.join(W, d, "estado.json"))).sort();
  const cuentas = {};
  for (const d of dirs) {
    const e = env(d), s = JSON.parse(fs.readFileSync(path.join(W, d, "estado.json"), "utf8"));
    const cta = d.startsWith("cocos2") ? "3893" : "72404";
    const tk = e.SCALP_TICKER || "MU", niv = Number(e.SCALP_MAX) / Number(e.SCALP_LOTE);
    const held = s.niveles.reduce((a, n) => a + n.held, 0), costo = s.niveles.reduce((a, n) => a + n.costo, 0);
    const esc = s.niveles.slice(0, niv).filter((n) => n.held > 0).length;
    const ref = s.niveles[niv] && s.niveles[niv].held > 0, ext = s.niveles.slice(niv + 1).filter((n) => n.held > 0).length;
    const abierta = s.dia === hoy;
    const lat = held > 0 && px[tk] ? held * px[tk] - costo : 0;
    // eventos de hoy en el log
    let log = "";
    try { const f = fs.readdirSync(path.join(W, d, "logs")).filter((x) => x.startsWith("out-")).map((x) => path.join(W, d, "logs", x)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]; log = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith(hoy)).join("\n"); } catch { /* sin log */ }
    const cuenta = (re) => (log.match(re) || []).length;
    const fila = { tk, abierta, real: abierta ? s.pnl : 0, ventas: abierta ? s.rondas : 0, esc, niv, ref, ext, held, costo, lat, px: px[tk],
      compras: cuenta(/COMPRA ejecutada/g), errores: cuenta(/ERROR/g), espera: /espero a que Cocos cargue/.test(log) && !abierta, fin: abierta ? s.fin : null, laterales: cuenta(/lateral: \d+ min/g), refuerzos: cuenta(/refuerzo: \d+ papeles/g), rechazos: cuenta(/rechaz/gi) };
    (cuentas[cta] = cuentas[cta] || []).push(fila);
  }
  console.log(`PULSO ${hoy} ${hora}`);
  let T = { real: 0, lat: 0, costo: 0, ventas: 0 };
  for (const cta of Object.keys(cuentas).sort((a, b) => (a === "72404" ? -1 : 1))) {
    const fs_ = cuentas[cta];
    const t = fs_.reduce((a, f) => ({ real: a.real + f.real, lat: a.lat + f.lat, costo: a.costo + f.costo, ventas: a.ventas + f.ventas }), { real: 0, lat: 0, costo: 0, ventas: 0 });
    console.log(`\nCUENTA ${cta} · realizado ${n0(t.real)} · ventas ${t.ventas} · latente ${n0(t.lat)} · neto ${n0(t.real + t.lat)} · cargado $${(t.costo / 1e6).toFixed(1)}M`);
    for (const f of fs_) {
      const notas = [f.abierta ? "" : (f.espera ? "ESPERA TENENCIA" : "sin abrir"), f.fin ? "FRENADO: " + f.fin : "", f.ref ? "REFUERZO" : "", f.ext ? `+${f.ext} extra` : "", f.errores ? `${f.errores} ERROR` : "", f.rechazos ? `${f.rechazos} rechazos` : ""].filter(Boolean).join(" · ");
      console.log(`  ${f.tk.padEnd(5)} real ${n0(f.real).padStart(9)} · v ${String(f.ventas).padStart(2)} · c ${String(f.compras).padStart(2)} · esc ${f.esc}/${f.niv} · lat ${n0(f.lat).padStart(10)} · px ${f.px ?? "?"}${notas ? " · " + notas : ""}`);
    }
    T = { real: T.real + t.real, lat: T.lat + t.lat, costo: T.costo + t.costo, ventas: T.ventas + t.ventas };
  }
  console.log(`\nTOTAL · realizado ${n0(T.real)} · ventas ${T.ventas} · latente ${n0(T.lat)} · neto ${n0(T.real + T.lat)} · cargado $${(T.costo / 1e6).toFixed(1)}M`);
})();
