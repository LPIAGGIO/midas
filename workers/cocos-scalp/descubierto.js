#!/usr/bin/env node
/* Descubierto en pesos de las dos cuentas de Cocos (solo lectura): saldo
 * contado, lo pendiente de liquidar mañana y las cauciones tomadas hoy, para
 * saber cuánto hay que cubrir con caución antes de las 16:30.
 *   node descubierto.js */
const fs = require("fs");
function env(p) { const o = {}; for (const l of fs.readFileSync(p, "utf8").split("\n")) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].replace(/^['"]|['"]$/g, ""); } return o; }
const b64 = (o, k) => Buffer.from(o[k], "base64").toString("utf8");
const n0 = (x) => (x == null ? "—" : (x < 0 ? "-" : "") + Math.abs(Math.round(x)).toLocaleString("es-AR"));
(async () => {
  const B = "https://api.cocos.xoms.com.ar";
  for (const [nombre, p] of [["72404", "/home/midas/workers/cocos-bot/.env"], ["3893", "/home/midas/workers/cocos-cuenta2/.env"]]) {
    const o = env(p); const cta = o.COCOS_CUENTA || nombre;
    const r = await fetch(B + "/auth/getToken", { method: "POST", headers: { "X-Username": b64(o, "COCOS_API_USER_B64"), "X-Password": b64(o, "COCOS_API_PASS_B64") }, redirect: "manual" });
    const t = r.headers.get("x-auth-token"); if (!t) { console.log(cta + ": login " + r.status); continue; }
    const j = await (await fetch(B + "/rest/risk/accountReport/" + cta, { headers: { "X-Auth-Token": t } })).json();
    const a = j.accountData || {}; const d = a.detailedAccountReports || {};
    const ci = d["0"] || {}, h24 = d["1"] || {};
    const cashCI = ci.availableToOperate?.cash?.detailedCash?.ARS ?? ci.availableToOperate?.cash?.totalCash ?? null;
    const pend = h24.availableToOperate?.pendingMovements ?? 0, movs = h24.availableToOperate?.movements ?? 0;
    const calc = a.lastCalculation ? new Date(a.lastCalculation).toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" }) : "?";
    // cauciones del día (ordenes sobre CAUC o instrumentos de caucion)
    let cau = "sin consultar";
    try {
      const oj = await (await fetch(B + "/rest/order/all?accountId=" + cta, { headers: { "X-Auth-Token": t } })).json();
      const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).replace(/-/g, "");
      const cs = (oj.orders || []).filter((x) => /CAUC|PESOS|CAU/i.test(x.instrumentId?.symbol || "") && String(x.transactTime || "").startsWith(hoy));
      cau = cs.length ? cs.map((x) => `${x.side} ${x.instrumentId.symbol} ${n0(Number(x.orderQty))} @${x.price} ${x.status}`).join(" | ") : "ninguna hoy";
    } catch (e) { cau = "error: " + e.message; }
    // La app de Cocos muestra "Hoy (C.I.)" unos $400k mas negativo que este cash
    // (comisiones y derechos del dia que la API no descuenta); "En 24hs" de la
    // app = contado + ventas pendientes. Para la caucion manda la app.
    console.log(`CUENTA ${cta} (cálculo ${calc}) · contado ARS ${n0(cashCI)} (la app lo muestra ~400k más negativo) · en 24 hs ≈ ${n0((cashCI || 0) + movs)} (ventas pendientes ${n0(movs)}) · cauciones: ${cau}`);
  }
})();
