/**
 * Worker cocos-sync: foto diaria de la cuenta de Cocos por la API oficial de
 * Primary (xOMS, el backend de Matriz), a las 10:00 ART en el pre-market.
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
 * Credenciales: .env con COCOS_API_USER_B64 / COCOS_API_PASS_B64 (cargadas por
 * LP con cargar-credenciales.sh; nunca se imprimen) y SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY. Schedule: PM2 cron lun-vie cada 15 min de 10:00 a 12:45
 * (VPS en ART): Cocos carga Matriz cuando LP se lo pide, a hora variable.
 *   node worker.js --dry-run   → muestra la foto sin escribir
 */
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const BASE = "https://api.cocos.xoms.com.ar";
const CUENTA = process.env.COCOS_CUENTA || "72404";
const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661"; // LP (lpiaggio@gmail.com)
const DRY = process.argv.includes("--dry-run");
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

async function token(env) {
  const r = await fetch(`${BASE}/auth/getToken`, {
    method: "POST", headers: { "X-Username": env.user, "X-Password": env.pass }, redirect: "manual",
  });
  const t = r.headers.get("x-auth-token");
  if (r.status !== 200 || !t) throw new Error(`login rechazado (HTTP ${r.status})`);
  return t;
}

async function getJson(t, ruta) {
  const r = await fetch(`${BASE}${ruta}`, { headers: { "X-Auth-Token": t }, redirect: "manual" });
  if (r.status !== 200) throw new Error(`${ruta}: HTTP ${r.status}`);
  const j = await r.json();
  if (j?.status && j.status !== "OK") throw new Error(`${ruta}: status ${j.status}`);
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

async function main() {
  const env = leerEnv();
  if (!env.user || !env.pass) throw new Error("faltan credenciales de Cocos en .env");
  const t = await token(env);
  const rep = await getJson(t, `/rest/risk/accountReport/${CUENTA}`);
  const det = await getJson(t, `/rest/risk/detailedPosition/${CUENTA}`);
  const a = rep.accountData || {};
  const fila = {
    user_id: USER_ID, broker: "cocos", account: CUENTA,
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
   * corre cada 15 min de 10:00 a 12:45 pisando la foto del dia, y cada foto
   * dice si Matriz estaba CARGADA: algun papel al abrir o saldo en pesos. La
   * pantalla solo compara contra fotos cargadas. */
  fila.totals.cargada = fila.positions.some((p) => p.inicial !== 0)
    || Math.abs(Number(fila.cash?.ci?.saldo?.ARS?.disponible) || 0) > 0;
  if (!fila.totals.cargada) {
    // No pisar una foto cargada del mismo dia con una vacia.
    log("Matriz sin cargar (sin papeles ni saldo): no piso la foto del dia si ya habia una cargada");
  }
  log(`foto ${fila.snapshot_date}: ${fila.positions.length} instrumentos · caja CI ARS ${fila.cash?.ci?.saldo?.ARS?.disponible ?? 0}`);
  for (const p of fila.positions) log(`  ${p.tipo} ${p.simbolo}: inicial ${p.inicial} · actual ${p.actual}`);
  if (DRY) { log("dry-run: no escribo"); return; }
  if (!env.sbUrl || !env.sbKey) throw new Error("faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env");
  const sb = createClient(env.sbUrl, env.sbKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } });
  // Una foto por dia: si se corre de nuevo el mismo dia, la pisa — salvo que
  // la nueva venga vacia y la guardada este cargada.
  if (!fila.totals.cargada) {
    const { data: prev } = await sb.from("broker_account_snapshot").select("totals")
      .eq("user_id", USER_ID).eq("broker", "cocos").eq("account", CUENTA).eq("snapshot_date", fila.snapshot_date).maybeSingle();
    if (prev?.totals?.cargada) { log("ya hay foto cargada hoy: no la piso"); return; }
  }
  const { error } = await sb.from("broker_account_snapshot").upsert(fila, { onConflict: "user_id,broker,account,snapshot_date" });
  if (error) throw new Error(`upsert: ${error.message}`);
  log("foto guardada");
}

main().then(() => process.exit(0)).catch((e) => { console.error(`[${new Date().toISOString()}] fatal:`, e.message); process.exit(1); });
