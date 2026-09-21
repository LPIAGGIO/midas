/**
 * Skills: las MANOS de Jarvis. Funciones puras de dominio, sin LLM y sin SDK.
 *
 * Por que viven aparte de lib/tools.js: se prueban solas con `node probe.js`,
 * sin gastar un token ni levantar el agente. Si una skill devuelve mal el dato,
 * se ve aca y no despues de tres turnos de conversacion.
 *
 * Cada skill devuelve { ok, ...datos, resumen } donde `resumen` es el texto que
 * Jarvis puede leer en voz alta sin post-procesar.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const exec = promisify(execFile);

/**
 * PM2 da el contador ACUMULADO de restarts, no cuando pasaron. 127 reinicios
 * pueden ser de anoche o de hace tres meses: una sola foto no distingue.
 * Guardamos la foto anterior para poder hablar de delta, que es lo unico que
 * significa algo. Mismo principio que la reconciliacion de caja: la suma cruda
 * miente, el delta no.
 */
const SNAP = join(dirname(fileURLToPath(import.meta.url)), "..", ".workers-snapshot.json");

async function leerSnapshot() {
  try { return JSON.parse(await readFile(SNAP, "utf8")); } catch { return null; }
}

async function guardarSnapshot(workers) {
  const snap = { ts: Date.now(), restarts: Object.fromEntries(workers.map((w) => [w.nombre, w.restarts])) };
  try { await writeFile(SNAP, JSON.stringify(snap), "utf8"); } catch { /* no es critico */ }
}

/**
 * Donde corre PM2. En el VPS es local; desde la PC de LP va por SSH.
 * JARVIS_PM2_LOCAL=1 fuerza local (para cuando el worker vuelva al VPS).
 */
const PM2_LOCAL = process.env.JARVIS_PM2_LOCAL === "1";
const VPS_HOST = process.env.JARVIS_VPS_HOST || "midas@149.50.148.172";
const VPS_PORT = process.env.JARVIS_VPS_PORT || "5008";
const VPS_KEY = process.env.JARVIS_VPS_KEY || "";

async function pm2Raw(args) {
  if (PM2_LOCAL) {
    const { stdout } = await exec("pm2", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  const ssh = ["-p", VPS_PORT, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
  if (VPS_KEY) ssh.push("-i", VPS_KEY);
  ssh.push(VPS_HOST, ["pm2", ...args].join(" "));
  const { stdout } = await exec("ssh", ssh, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/**
 * Clasifica un proceso de PM2. La distincion que importa: un worker one-shot
 * (autorestart:false + cron_restart) aparece "stopped" tanto si corrio bien
 * como si reventó. Lo unico que los separa es el exit_code, y por eso hasta hoy
 * los que fallaban de noche no se enteraba nadie.
 */
function clasificar(p, delta) {
  const env = p.pm2_env || {};
  const programado = !!env.cron_restart;
  const status = env.status;
  const exit = env.exit_code;

  if (status === "online") {
    // Inestable solo si se reinicio DESDE LA ULTIMA VEZ QUE MIRAMOS. Sin foto
    // previa no hay veredicto: el acumulado solo no dice nada.
    if (delta != null && delta >= 3) return "inestable";
    return "ok";
  }
  if (programado) {
    if (exit === 0) return "ok";
    if (exit === null || exit === undefined) return "nunca_corrio";
    return "fallo";
  }
  // Continuo y apagado: alguien lo bajo o se murio.
  return "caido";
}

const ORDEN = { fallo: 0, caido: 1, inestable: 2, nunca_corrio: 3, ok: 4 };

/**
 * Estado de todos los workers. Es la pregunta "como viene el bot" y tambien
 * "que se rompio anoche", que hasta ahora no tenia donde preguntarse.
 */
export async function workersStatus({ soloProblemas = false } = {}) {
  let raw;
  try {
    raw = await pm2Raw(["jlist"]);
  } catch (err) {
    return { ok: false, error: String(err.message || err), resumen: "No pude hablar con PM2. Puede ser el SSH al VPS." };
  }

  let lista;
  try {
    lista = JSON.parse(raw);
  } catch {
    return { ok: false, error: "pm2 jlist no devolvio JSON", resumen: "PM2 contesto algo que no pude leer." };
  }

  const previo = await leerSnapshot();
  const horasDesdeFoto = previo ? Math.round((Date.now() - previo.ts) / 36e5) : null;

  const workers = lista.map((p) => {
    const env = p.pm2_env || {};
    const restarts = env.restart_time || 0;
    const antes = previo?.restarts?.[p.name];
    const delta = antes == null ? null : restarts - antes;
    return {
      nombre: p.name,
      estado: clasificar(p, delta),
      programado: !!env.cron_restart,
      cron: env.cron_restart || null,
      restarts,
      restartsNuevos: delta,
      exit: env.exit_code ?? null,
      memMb: Math.round((p.monit?.memory || 0) / 1048576),
      desde: env.pm_uptime ? new Date(env.pm_uptime).toISOString() : null,
    };
  });

  workers.sort((a, b) => (ORDEN[a.estado] - ORDEN[b.estado]) || a.nombre.localeCompare(b.nombre));

  const problemas = workers.filter((w) => w.estado !== "ok");
  const cuenta = workers.reduce((acc, w) => ({ ...acc, [w.estado]: (acc[w.estado] || 0) + 1 }), {});

  const ventana = horasDesdeFoto == null
    ? " (primera medicion: todavia no puedo comparar contra nada)"
    : ` (comparado contra hace ${horasDesdeFoto}h)`;

  let resumen;
  if (!problemas.length) {
    resumen = `Los ${workers.length} workers vienen bien${ventana}.`;
  } else {
    const linea = (w) => {
      if (w.estado === "fallo") return `${w.nombre} fallo en su ultima corrida (exit ${w.exit})`;
      if (w.estado === "caido") return `${w.nombre} esta apagado y deberia estar prendido`;
      if (w.estado === "inestable") return `${w.nombre} se reinicio ${w.restartsNuevos} veces desde la ultima medicion`;
      return `${w.nombre} nunca corrio`;
    };
    resumen = `${problemas.length} de ${workers.length} workers con problemas${ventana}: ` + problemas.map(linea).join("; ") + ".";
  }

  await guardarSnapshot(workers);
  return { ok: true, total: workers.length, cuenta, horasDesdeFoto, workers: soloProblemas ? problemas : workers, resumen };
}

/** Las ultimas lineas de log de un worker. Para el "y por que fallo". */
export async function workerLogs(nombre, { lineas = 40 } = {}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(nombre || ""))) {
    return { ok: false, error: "nombre invalido", resumen: "Ese nombre de worker no es valido." };
  }
  try {
    const raw = await pm2Raw(["logs", nombre, "--lines", String(lineas), "--nostream"]);
    return { ok: true, nombre, log: raw.trim(), resumen: `Ultimas ${lineas} lineas de ${nombre}.` };
  } catch (err) {
    return { ok: false, error: String(err.message || err), resumen: `No pude leer los logs de ${nombre}.` };
  }
}
