// Reconstruye de los logs el estado con que cada bot abrió una rueda (solo
// lectura): ancla, papeles arrastrados y las ventas que apoyó al abrir (una por
// lote arrastrado). Uso en el VPS: node estado_apertura.js 2026-10-05
const fs = require("fs");
const W = "/home/midas/workers";
const dia = process.argv[2];
const out = {};
for (const d of fs.readdirSync(W).filter((d) => /^cocos2?-scalp/.test(d) && fs.existsSync(`${W}/${d}/estado.json`)).sort()) {
  const env = Object.fromEntries(fs.readFileSync(`${W}/${d}/.env`, "utf8").split("\n").map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]));
  const f = fs.readdirSync(`${W}/${d}/logs`).filter((x) => x.startsWith("out-")).map((x) => `${W}/${d}/logs/${x}`).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const L = fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith(dia + "T10:3"));
  const i0 = L.findIndex((l) => /arranco la rueda/.test(l));
  const m = i0 >= 0 ? /con (\d+) papeles de ayer · ancla \$([\d.]+)/.exec(L[i0]) : null;
  const ventas = [];
  for (const l of L.slice(i0 + 1)) {
    if (/ejecutada|compra apoyada/.test(l)) break;
    const v = /venta apoyada · escalón (\d+) · (\d+) × \$([\d.]+)/.exec(l);
    if (v) ventas.push([Number(v[1]), Number(v[2]), Number(v[3].replace(/\./g, ""))]);
  }
  const cta = d.startsWith("cocos2") ? "3893" : "72404";
  const tk = env.SCALP_TICKER || "MU";
  (out[cta] = out[cta] || {})[tk] = {
    papeles: m ? Number(m[1]) : null, ancla: m ? Number(m[2].replace(/\./g, "")) : null,
    paso: Number(env.SCALP_PASO_PREVIO || env.SCALP_PASO), gan: Number(env.SCALP_GANANCIA_PREVIA || env.SCALP_GANANCIA),
    pasoNuevo: Number(env.SCALP_PASO), ganNueva: Number(env.SCALP_GANANCIA), lote: Number(env.SCALP_LOTE), ventas,
  };
}
console.log(JSON.stringify(out));
