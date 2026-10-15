/**
 * Worker cocos-sync: foto diaria de la cuenta de Cocos por la API oficial de
 * Primary (xOMS, el backend de Matriz), varias veces por dia.
 *
 * POR QUE (LP 29/09/2026): Midas arma la cartera de Cocos con el EXTRACTO que
 * sube LP, y el extracto sigue mandando ("matriz falla seguido lo que
 * muestra"). Esta foto es CONTROL: la pantalla compara la tenencia que tenia
 * el broker al abrir el dia contra lo que Midas armo hasta el cierre de ayer,
 * y marca las diferencias. Ejemplo que la origino: Midas mostraba 2.500 OKLO
 * y el broker 4.858.
 *
 * SOLO LECTURA: reporte de cuenta y posicion detallada. No hay ninguna
 * llamada de ordenes en este archivo.
 *
 * Cuentas (12/10/2026): sincroniza TODAS las filas de linked_brokers con clave
 * de Matriz cargada desde Midas (vault_secret_name 'matriz:...'). La clave se
 * lee de Vault con el RPC leer_credencial_matriz (solo service_role); el
 * usuario de Matriz es broker_user_id y la comitente broker_account_id. Cada
 * cuenta escribe su foto en broker_account_snapshot (account = comitente) y
 * actualiza su tarjeta (status, last_sync_at, status_message). Una falla en
 * una cuenta no corta las demas. Compatibilidad: la 72404 de LP usa el .env
 * (COCOS_API_USER_B64 / COCOS_API_PASS_B64, cargadas con
 * cargar-credenciales.sh) si su fila no tiene clave en Vault o si la de Vault
 * no entra. Claves y tokens nunca se imprimen.
 *
 * .env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (+ las de Cocos de arriba).
 * Schedule en ecosystem.config.js; tambien la dispara operaciones.js.
 *   node worker.js --dry-run                  → muestra las fotos sin escribir nada
 *   node worker.js --dry-run --comitente=3893 → solo esa comitente
 *   node worker.js --user=<uuid>              → solo las cuentas de ese usuario
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

/* Host de la API de Primary (xOMS) de cada broker. Los que estan en null
 * todavia no se averiguaron: la cuenta se saltea con un aviso en la tarjeta. */
const HOSTS = {
  cocos: "https://api.cocos.xoms.com.ar",
  eco: null,        // pendiente de averiguar el host
  bullmarket: null, // pendiente de averiguar el host
  veta: null,       // pendiente de averiguar el host
};
const MSG_SIN_HOST = "Sincronización por Matriz todavía no disponible para este broker";
const LP_USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661"; // LP (lpiaggio@gmail.com)
const LEGADO_COMITENTE = process.env.COCOS_CUENTA || "72404"; // la del .env
const arg = (k) => { const m = process.argv.find((x) => x.startsWith(`--${k}=`)); return m ? m.slice(k.length + 3) : null; };
const DRY = process.argv.includes("--dry-run");
const SOLO_COMITENTE = arg("comitente");
const SOLO_USER = arg("user");
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

function leerEnv() {
  const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  const raw = (k) => { const m = txt.match(new RegExp(`^${k}=(.*)$`, "m")); return m ? m[1].trim() : null; };
  const b64 = (k) => { const v = raw(k); return v ? Buffer.from(v, "base64").toString("utf8") : null; };
  return {
    user: b64("COCOS_API_USER_B64"), pass: b64("COCOS_API_PASS_B64"),
    sbUrl: raw("SUPABASE_URL"), sbKey: raw("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

const falla = (msg, tipo) => Object.assign(new Error(msg), { tipo });
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Matriz limita pedidos seguidos (HTTP 429): hasta 3 reintentos con espera creciente.
async function pedir(url, opts) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, opts);
    if (r.status !== 429 || i >= 3) return r;
    await espera(2000 * (i + 1));
  }
}

// tipo "credenciales": Matriz rechazo usuario/clave (401/403 o sin token).
async function token(host, cred) {
  const r = await pedir(`${host}/auth/getToken`, {
    method: "POST", headers: { "X-Username": cred.user, "X-Password": cred.pass }, redirect: "manual",
  });
  const t = r.headers.get("x-auth-token");
  if (r.status === 401 || r.status === 403 || (r.status === 200 && !t)) throw falla(`login rechazado (HTTP ${r.status})`, "credenciales");
  if (r.status !== 200) throw falla(`login: HTTP ${r.status}`, "red");
  return t;
}

// tipo "cuenta": Matriz respondio pero no devuelve esa comitente para ese usuario.
async function getJson(host, t, ruta) {
  const r = await pedir(`${host}${ruta}`, { headers: { "X-Auth-Token": t }, redirect: "manual" });
  if (r.status !== 200) throw falla(`${ruta}: HTTP ${r.status}`, [400, 403, 404].includes(r.status) ? "cuenta" : "red");
  const j = await r.json();
  if (j?.status && j.status !== "OK") throw falla(`${ruta}: status ${j.status}`, "cuenta");
  return j;
}

// Saldo y disponible por plazo (0 = contado inmediato, 1 = 24 hs) y moneda.
// Solo se guardan las monedas con algo distinto de cero.
function armarCaja(rep) {
  const a = rep.accountData || {};
  const out = {};
  for (const [plazo, d] of Object.entries(a.detailedAccountReports || {})) {
    const saldo = {}, disp = {};
    for (const [mon, v] of Object.entries(d?.currencyBalance?.detailedCurrencyBalance || {})) {
      if (Number(v?.available) || Number(v?.consumed)) saldo[mon] = { disponible: Number(v.available) || 0, consumido: Number(v.consumed) || 0 };
    }
    for (const [mon, v] of Object.entries(d?.availableToOperate?.cash?.detailedCash || {})) {
      if (Number(v)) disp[mon] = Number(v);
    }
    out[plazo === "0" ? "ci" : plazo === "1" ? "24hs" : `plazo_${plazo}`] = {
      liquida: d?.settlementDate ? new Date(Number(d.settlementDate)).toISOString().slice(0, 10) : null,
      saldo, disponible: disp, disponible_total: Number(d?.availableToOperate?.total) || 0,
    };
  }
  return out;
}

// Tenencia por instrumento, sumando los plazos. "inicial" = lo que habia al
// abrir el dia (la comparacion justa contra Midas hasta ayer); "actual" =
// inicial + lo operado hoy hasta el momento de la foto.
function armarPosiciones(det) {
  const out = [];
  const rep = det?.detailedPosition?.report || {};
  for (const [tipo, instrumentos] of Object.entries(rep)) {
    for (const [sym, info] of Object.entries(instrumentos || {})) {
      const partes = info?.detailedPositions || [];
      const p0 = partes[0] || {};
      out.push({
        tipo, simbolo: sym,
        inicial: Number(info.instrumentInitialSize) || 0,
        actual: Number(info.instrumentCurrentSize) || 0,
        operado_hoy: Number(info.instrumentFilledSize) || 0,
        precio_mercado: Number(p0.marketPrice) || null,
        precio_inicial: partes.map((x) => Number(x.buyInitialPrice)).find((x) => x > 0) || null,
        moneda: p0.currency || null,
        valor_mercado: Number(info.instrumentMarketValue) || 0,
      });
    }
  }
  return out;
}

// Foto de UNA cuenta: reporte + posicion detallada. Devuelve la fila de
// broker_account_snapshot (sin escribir).
async function foto(host, t, userId, broker, cuenta) {
  const rep = await getJson(host, t, `/rest/risk/accountReport/${encodeURIComponent(cuenta)}`);
  const det = await getJson(host, t, `/rest/risk/detailedPosition/${encodeURIComponent(cuenta)}`);
  const a = rep.accountData || {};
  const fila = {
    user_id: userId, broker, account: cuenta,
    snapshot_at: new Date().toISOString(),
    snapshot_date: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), // fecha ART
    cash: armarCaja(rep),
    positions: armarPosiciones(det),
    totals: {
      portfolio: a.portfolio ?? null, currentCash: a.currentCash ?? null,
      availableToCollateral: a.availableToCollateral ?? null, collateral: a.collateral ?? null,
      margin: a.margin ?? null, dailyDiff: a.dailyDiff ?? null,
      totalMarketValue: det?.detailedPosition?.totalMarketValue ?? null,
    },
  };
  /* Matriz NO trae sola la tenencia de Cocos: son plataformas distintas y LP
   * le pide a Cocos cada mañana que "actualice Matriz" (29/09/2026). Hasta
   * entonces la cuenta puede verse vacia o con datos viejos. Por eso el cron
   * corre varias veces por dia pisando la foto del dia, y cada foto dice si
   * Matriz estaba CARGADA: algun papel al abrir o saldo en pesos. La pantalla
   * solo compara contra fotos cargadas. */
  fila.totals.cargada = fila.positions.some((p) => p.inicial !== 0)
    || Math.abs(Number(fila.cash?.ci?.saldo?.ARS?.disponible) || 0) > 0;
  return fila;
}

async function guardarFoto(sb, fila, pre) {
  // Una foto por dia y cuenta: si se corre de nuevo el mismo dia, la pisa —
  // salvo que la nueva venga vacia y la guardada este cargada.
  if (!fila.totals.cargada) {
    const { data: prev } = await sb.from("broker_account_snapshot").select("totals")
      .eq("user_id", fila.user_id).eq("broker", fila.broker).eq("account", fila.account)
      .eq("snapshot_date", fila.snapshot_date).maybeSingle();
    if (prev?.totals?.cargada) { log(`${pre} Matriz sin cargar y ya hay foto cargada hoy: no la piso`); return; }
  }
  const { error } = await sb.from("broker_account_snapshot").upsert(fila, { onConflict: "user_id,broker,account,snapshot_date" });
  if (error) throw new Error(`upsert: ${error.message}`);
  log(`${pre} foto guardada`);
}

// Estado de la tarjeta en "Cuentas y configuracion". Siempre por id + user_id.
async function marcar(sb, c, campos) {
  if (DRY) { log(`${c.pre} dry-run: linked_brokers quedaria ${JSON.stringify(campos)}`); return; }
  if (!c.rowId) return;
  const { error } = await sb.from("linked_brokers").update({ ...campos, updated_at: new Date().toISOString() })
    .eq("id", c.rowId).eq("user_id", c.userId);
  if (error) log(`${c.pre} no pude actualizar linked_brokers: ${error.message}`);
}

// Todas las filas de linked_brokers con clave de Matriz (paginado: Supabase
// corta en 1.000).
const MSG_CLAVE_MALA = "Usuario o clave de Matriz incorrectos. No se reintenta hasta que vuelvas a cargar la clave (varios intentos fallidos bloquean el usuario en el broker).";
async function cuentasConClave(sb) {
  const out = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await sb.from("linked_brokers")
      .select("id, user_id, broker, cuenta, status, status_message, broker_user_id, broker_account_id, vault_secret_name")
      .like("vault_secret_name", "matriz:%")
      .order("id").range(desde, desde + 999);
    if (error) throw new Error(`linked_brokers: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const env = leerEnv();
  if (!env.sbUrl || !env.sbKey) throw new Error("faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env");
  const sb = createClient(env.sbUrl, env.sbKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });

  const objetivos = (await cuentasConClave(sb)).map((f) => ({
    rowId: f.id, userId: f.user_id, broker: f.broker, cuenta: f.cuenta, statusPrevio: f.status,
    msgPrevio: f.status_message, usuario: f.broker_user_id, comitente: f.broker_account_id,
    secreto: f.vault_secret_name, legado: false, soloEnv: false,
  }));
  /* Compatibilidad: la 72404 de LP se sincronizaba con las credenciales del
   * .env. Si su fila principal no tiene clave en Vault, sigue con esas; y si
   * la de Vault no entra, se prueba con las del .env antes de cortar. */
  const lp = objetivos.find((o) => o.userId === LP_USER_ID && o.broker === "cocos" && o.cuenta === "principal");
  if (lp) lp.legado = true;
  else if (env.user && env.pass) {
    const { data: fila } = await sb.from("linked_brokers").select("id, status, status_message")
      .eq("user_id", LP_USER_ID).eq("broker", "cocos").eq("cuenta", "principal").maybeSingle();
    objetivos.unshift({
      rowId: fila?.id || null, userId: LP_USER_ID, broker: "cocos", cuenta: "principal", statusPrevio: fila?.status,
      msgPrevio: fila?.status_message, usuario: null, comitente: LEGADO_COMITENTE, secreto: null, legado: true, soloEnv: true,
    });
  }

  let lista = objetivos;
  if (SOLO_COMITENTE) lista = lista.filter((o) => String(o.comitente) === SOLO_COMITENTE);
  if (SOLO_USER) lista = lista.filter((o) => o.userId === SOLO_USER);
  log(`${lista.length} cuenta(s) a sincronizar${DRY ? " (dry-run)" : ""}`);

  const tokens = new Map(); // host + usuario + clave → token, solo en memoria
  const vistas = new Set();
  let fallas = 0;
  for (const [i, c] of lista.entries()) {
    if (i) await espera(1500); // no encimar pedidos a Matriz
    c.pre = `[${c.userId.slice(0, 8)} ${c.broker} ${c.cuenta}${c.comitente ? " #" + c.comitente : ""}]`;
    try {
      const host = HOSTS[c.broker];
      if (!host) {
        log(`${c.pre} sin host de Matriz conocido: salteo`);
        if (c.msgPrevio !== MSG_SIN_HOST) await marcar(sb, c, { status_message: MSG_SIN_HOST, last_sync_status: "skipped" });
        continue;
      }
      if (!c.comitente) {
        log(`${c.pre} falta el numero de comitente`);
        await marcar(sb, c, { status: "error", last_sync_status: "error", status_message: "Falta el número de comitente. Volvé a cargar la conexión con el número de cuenta." });
        fallas++; continue;
      }
      /* Clave rechazada (LP 15/10/2026, a Pablo le bloquearon el usuario de
       * Cocos): si Matriz ya dijo que el usuario o la clave estan mal, NO se
       * reintenta cada hora — varios logins fallidos bloquean el usuario en el
       * broker. Se vuelve a probar recien cuando la persona guarda la clave de
       * nuevo (guardar_credencial_matriz pasa la fila a 'pending'). */
      if (c.statusPrevio === "error" && c.msgPrevio === MSG_CLAVE_MALA) {
        log(`${c.pre} la clave fue rechazada antes: no reintento hasta que la vuelvan a cargar`);
        fallas++; continue;
      }
      const k = `${c.userId}|${c.broker}|${c.comitente}`;
      if (vistas.has(k)) { log(`${c.pre} comitente repetida para el mismo usuario: salteo`); continue; }
      vistas.add(k);

      // Credenciales: Vault si la fila tiene clave; si no (solo la 72404 de LP), el .env.
      let cred = null, usoEnv = false;
      if (!c.soloEnv) {
        const { data: pass, error } = await sb.rpc("leer_credencial_matriz", { p_secret_name: c.secreto });
        if (error) throw new Error(`leer clave: ${error.message}`);
        if (pass && c.usuario) cred = { user: c.usuario, pass };
      }
      if (!cred && c.legado && env.user && env.pass) { cred = { user: env.user, pass: env.pass }; usoEnv = true; }
      if (!cred) {
        log(`${c.pre} no hay clave guardada`);
        await marcar(sb, c, { status: "error", last_sync_status: "error", status_message: "No encontramos la clave guardada. Volvé a cargar usuario y clave de Matriz." });
        fallas++; continue;
      }

      const login = async (cr) => {
        const tk = `${host}|${cr.user}|${cr.pass}`;
        if (!tokens.has(tk)) tokens.set(tk, await token(host, cr));
        return tokens.get(tk);
      };
      const sacar = async (cr) => foto(host, await login(cr), c.userId, c.broker, String(c.comitente));
      let fila, aviso = null;
      try { fila = await sacar(cred); }
      catch (e) {
        // La 72404 de LP no se corta: si la clave de Vault no entra o ese
        // usuario no ve la comitente, se prueba con el .env y se avisa.
        if ((e.tipo === "credenciales" || e.tipo === "cuenta") && c.legado && !usoEnv && env.user && env.pass) {
          log(`${c.pre} con la clave de Vault fallo (${e.message}); pruebo con la del .env`);
          fila = await sacar({ user: env.user, pass: env.pass });
          usoEnv = true;
          aviso = e.tipo === "credenciales"
            ? "La clave de Matriz cargada en Midas no entró; se usó la guardada en el servidor. Volvé a cargarla."
            : `El usuario de Matriz cargado no ve la comitente ${c.comitente}; se usó el guardado en el servidor.`;
        } else throw e;
      }

      log(`${c.pre} foto ${fila.snapshot_date}: ${fila.positions.length} instrumentos · caja CI ARS ${fila.cash?.ci?.saldo?.ARS?.disponible ?? 0} · portfolio ${fila.totals.portfolio ?? "-"}${fila.totals.cargada ? "" : " · Matriz sin cargar"}${usoEnv ? " · credenciales del .env" : ""}`);
      for (const p of fila.positions) log(`${c.pre}   ${p.tipo} ${p.simbolo}: inicial ${p.inicial} · actual ${p.actual}`);
      if (DRY) log(`${c.pre} dry-run: no escribo la foto`);
      else await guardarFoto(sb, fila, c.pre);
      await marcar(sb, c, { status: "active", last_sync_at: new Date().toISOString(), last_sync_status: "ok", status_message: aviso });
    } catch (e) {
      fallas++;
      // Nunca se loguea ni se guarda la clave: los errores solo llevan HTTP y ruta.
      log(`${c.pre} fallo: ${e.message}`);
      if (e.tipo === "credenciales") {
        await marcar(sb, c, { status: "error", last_sync_status: "error", status_message: MSG_CLAVE_MALA });
      } else if (e.tipo === "cuenta") {
        await marcar(sb, c, { status: "error", last_sync_status: "error", status_message: `Matriz no devolvió la comitente ${c.comitente}: revisá el número de cuenta.` });
      } else {
        // Falla transitoria (red, Matriz caida): no cambia el estado de la conexion.
        await marcar(sb, c, { last_sync_status: "error", status_message: c.statusPrevio === "pending" ? c.msgPrevio : "Matriz no respondió en la última sincronización; se reintenta sola." });
      }
    }
  }
  log(`listo: ${lista.length - fallas} ok, ${fallas} con falla`);
  if (lista.length && fallas === lista.length) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { console.error(`[${new Date().toISOString()}] fatal:`, e.message); process.exit(1); });
