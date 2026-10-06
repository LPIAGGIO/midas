#!/usr/bin/env node
/* Lectura de la posición de un papel en Cocos, partida por plazo, en las dos
 * cuentas (solo lectura; no manda órdenes). Sirve para ver si Matriz ya ajustó
 * el "stock disponible" después de un rechazo por "Stock insuficiente".
 *   node stock.js NVDA
 * Imprime por cuenta: total, y cada bucket (CI / 24hs) con su tamaño. El
 * disponible para vender en 24hs que usa Matriz parece salir del bucket CI:
 * cuando ese bucket deja de ser negativo, las ventas vuelven a entrar. */
const fs = require("fs");
const TK = (process.argv[2] || "NVDA").toUpperCase();
function env(p) { const o = {}; for (const l of fs.readFileSync(p, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); } return o; }
const b64 = (o, k) => Buffer.from(o[k], "base64").toString("utf8");
(async () => {
  const B = "https://api.cocos.xoms.com.ar";
  for (const [nombre, p] of [["72404", "/home/midas/workers/cocos-bot/.env"], ["3893", "/home/midas/workers/cocos-cuenta2/.env"]]) {
    const o = env(p); const cta = o.COCOS_CUENTA || nombre;
    const r = await fetch(B + "/auth/getToken", { method: "POST", headers: { "X-Username": b64(o, "COCOS_API_USER_B64"), "X-Password": b64(o, "COCOS_API_PASS_B64") }, redirect: "manual" });
    const t = r.headers.get("x-auth-token"); if (!t) { console.log(cta + ": login " + r.status); continue; }
    const j = await (await fetch(B + "/rest/risk/detailedPosition/" + cta, { headers: { "X-Auth-Token": t } })).json();
    const rep = (j.detailedPosition && j.detailedPosition.report) || {};
    let info = null;
    for (const inst of Object.values(rep)) for (const [sym, x] of Object.entries(inst || {})) if (sym.toUpperCase() === TK) info = x;
    if (!info) { console.log(cta + " " + TK + ": sin posición"); continue; }
    const buckets = (info.detailedPositions || []).map((d) => `${d.settlType === 0 ? "CI" : d.settlType === 1 ? "24hs" : "plazo" + d.settlType}: ${d.totalCurrentSize} (inicial ${d.totalInitialSize}, hoy ${d.totalFilledSize})`);
    const ci = (info.detailedPositions || []).find((d) => d.settlType === 0);
    const veredicto = !ci ? "sin bucket CI" : ci.totalCurrentSize < 0 ? "CI NEGATIVO: Matriz todavía no ajustó" : "CI en positivo: debería dejar vender";
    console.log(`${cta} ${TK}: total ${info.instrumentCurrentSize} · ${buckets.join(" · ")} · ${veredicto}`);
  }
})();
