#!/usr/bin/env node
/* Libro en vivo (mejor compra, mejor venta y último operado) de los 10 CEDEARs
 * del scalp a 24 hs, por la API de Primary de Cocos. Solo lectura.
 *   node libro.js            (o node libro.js INTC AMD) */
const fs = require("fs");
function env(p) { const o = {}; for (const l of fs.readFileSync(p, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); } return o; }
const b64 = (o, k) => Buffer.from(o[k], "base64").toString("utf8");
const TKS = process.argv.slice(2).length ? process.argv.slice(2).map((x) => x.toUpperCase()) : ["MU", "SNDK", "NVDA", "GOOGL", "AMD", "INTC", "META", "AAPL", "MSFT", "AMZN"];
(async () => {
  const B = "https://api.cocos.xoms.com.ar";
  const o = env("/home/midas/workers/cocos-bot/.env");
  const r = await fetch(B + "/auth/getToken", { method: "POST", headers: { "X-Username": b64(o, "COCOS_API_USER_B64"), "X-Password": b64(o, "COCOS_API_PASS_B64") }, redirect: "manual" });
  const t = r.headers.get("x-auth-token");
  if (!t) { console.log("login " + r.status); return; }
  const hora = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(11, 19);
  for (const tk of TKS) {
    const s = `MERV - XMEV - ${tk} - 24hs`;
    await new Promise((res) => setTimeout(res, 2500));      // la API corta con "Rate limit exceeded" si se consulta seguido
    const txt = await (await fetch(B + "/rest/marketdata/get?marketId=ROFX&symbol=" + encodeURIComponent(s) + "&entries=BI,OF,LA&depth=1", { headers: { "X-Auth-Token": t } })).text();
    let j; try { j = JSON.parse(txt); } catch { console.log(`${tk.padEnd(5)} ${txt.slice(0, 60)}`); continue; }
    const m = j.marketData || {};
    const bi = (m.BI || [])[0], of = (m.OF || [])[0], la = m.LA;
    const spread = bi && of ? ((of.price / bi.price - 1) * 100).toFixed(2) + "%" : "-";
    console.log(`${tk.padEnd(5)} compra ${bi ? bi.price + " x" + bi.size : "-"} · venta ${of ? of.price + " x" + of.size : "-"} · spread ${spread} · último ${la ? la.price + " a las " + hora(la.date) : "-"}`);
  }
})();
