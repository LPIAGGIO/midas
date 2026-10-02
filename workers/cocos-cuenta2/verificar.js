// Prueba el login de la segunda cuenta de Cocos y lista las cuentas que ve el
// usuario. SOLO LECTURA. Si ve una sola, anota su numero en .env (COCOS_CUENTA).
// Nunca imprime la clave ni el token.
const fs = require("fs"), path = require("path");
const ENV = path.join(__dirname, ".env");
const txt = fs.readFileSync(ENV, "utf8");
const b64 = (k) => { const m = txt.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? Buffer.from(m[1].trim(), "base64").toString("utf8") : null; };
(async () => {
  const B = "https://api.cocos.xoms.com.ar";
  const r = await fetch(`${B}/auth/getToken`, { method: "POST", headers: { "X-Username": b64("COCOS_API_USER_B64"), "X-Password": b64("COCOS_API_PASS_B64") }, redirect: "manual" });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) { console.log(`ACCESO RECHAZADO (HTTP ${r.status}). O el usuario/clave estan mal, o Cocos todavia no habilito la API para este usuario.`); process.exit(1); }
  const a = await (await fetch(`${B}/rest/accounts`, { headers: { "X-Auth-Token": t } })).json();
  const cuentas = (a.accounts || []).map((c) => String(c.name));
  console.log(`acceso OK · cuentas que ve este usuario: ${cuentas.join(", ") || "ninguna"}`);
  if (cuentas.length === 1) {
    const sin = txt.split("\n").filter((l) => l && !l.startsWith("COCOS_CUENTA=")).join("\n");
    fs.writeFileSync(ENV, `${sin}\nCOCOS_CUENTA=${cuentas[0]}\n`, { mode: 0o600 });
    console.log(`cuenta ${cuentas[0]} anotada`);
  } else if (cuentas.length > 1) console.log("ve mas de una cuenta: avisale a Claude cual es la nueva");
})().catch((e) => { console.log(`error: ${e.message}`); process.exit(1); });
