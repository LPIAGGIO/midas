/**
 * Lectura de prueba de la cuenta de Cocos por la API oficial de Primary
 * (xOMS, el mismo backend de Matriz). SOLO LECTURA: reporte de cuenta y
 * posiciones. No hay ninguna llamada de ordenes en este archivo.
 *
 * Credenciales: ~/workers/cocos-sync/.env con COCOS_API_USER_B64 y
 * COCOS_API_PASS_B64 (base64), cargadas por LP con cargar-credenciales.sh.
 * Nunca se imprimen ni la clave ni el token.
 *
 *   node leer-cuenta.js            → resumen legible
 *   node leer-cuenta.js --crudo    → ademas el JSON completo de cada respuesta
 */
const fs = require("fs");
const path = require("path");

const BASE = "https://api.cocos.xoms.com.ar";
const CUENTA = process.env.COCOS_CUENTA || "72404";

function credenciales() {
  const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  const get = (k) => {
    const m = txt.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? Buffer.from(m[1].trim(), "base64").toString("utf8") : null;
  };
  const user = get("COCOS_API_USER_B64"), pass = get("COCOS_API_PASS_B64");
  if (!user || !pass) throw new Error("faltan credenciales en .env (correr cargar-credenciales.sh)");
  return { user, pass };
}

async function token() {
  const { user, pass } = credenciales();
  const r = await fetch(`${BASE}/auth/getToken`, {
    method: "POST",
    headers: { "X-Username": user, "X-Password": pass },
    redirect: "manual",
  });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) throw new Error(`login rechazado (HTTP ${r.status})`);
  return t;
}

async function get(t, ruta) {
  const r = await fetch(`${BASE}${ruta}`, { headers: { "X-Auth-Token": t }, redirect: "manual" });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch { /* no es JSON */ }
  return { status: r.status, j, txt: j ? null : txt.slice(0, 300) };
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("es-AR", { maximumFractionDigits: 2 }) : String(n));

(async () => {
  const crudo = process.argv.includes("--crudo");
  const t = await token();
  console.log(`login OK · cuenta ${CUENTA}`);

  const rep = await get(t, `/rest/risk/accountReport/${CUENTA}`);
  console.log(`\n== reporte de cuenta (HTTP ${rep.status}) ==`);
  if (rep.j) {
    const a = rep.j.accountData || rep.j;
    for (const k of ["portfolio", "currentCash", "collateral", "margin", "availableToCollateral", "dailyDiff", "uncoveredMargin"]) {
      if (a[k] != null) console.log(`${k.padEnd(22)} ${fmt(a[k])}`);
    }
    const det = a.detailedAccountReports || {};
    for (const [plazo, d] of Object.entries(det)) {
      const cash = d?.availableToOperate?.cash;
      console.log(`\n· plazo ${plazo} (liquida ${d?.settlementDate ?? "?"})`);
      if (cash?.detailedCash) for (const [mon, v] of Object.entries(cash.detailedCash)) console.log(`   disponible ${mon.padEnd(8)} ${fmt(v)}`);
      if (d?.availableToOperate?.total != null) console.log(`   disponible total   ${fmt(d.availableToOperate.total)}`);
      const cb = d?.currencyBalance?.detailedCurrencyBalance;
      if (cb) for (const [mon, v] of Object.entries(cb)) console.log(`   saldo ${mon.padEnd(8)} consumido ${fmt(v?.consumed)} · disponible ${fmt(v?.available)}`);
    }
    if (crudo) console.log(JSON.stringify(rep.j, null, 1));
  } else console.log(rep.txt);

  const pos = await get(t, `/rest/risk/position/getPositions/${CUENTA}`);
  console.log(`\n== posiciones (HTTP ${pos.status}) ==`);
  if (pos.j) {
    const arr = pos.j.positions || [];
    for (const p of arr) {
      const sym = p?.symbol || p?.instrument?.symbolReference || "?";
      const q = (p?.buySize ?? 0) - (p?.sellSize ?? 0);
      console.log(`${String(sym).padEnd(40)} neto ${fmt(q)} · compra ${fmt(p?.buySize)} @${fmt(p?.buyPrice)} · venta ${fmt(p?.sellSize)} @${fmt(p?.sellPrice)}`);
    }
    if (!arr.length) console.log("(sin posiciones en la respuesta)");
    if (crudo) console.log(JSON.stringify(pos.j, null, 1));
  } else console.log(pos.txt);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
