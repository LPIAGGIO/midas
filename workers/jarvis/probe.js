/**
 * Probe: corre las skills sin LLM y sin el SDK, para ver el dato crudo.
 *
 *   node probe.js                 -> todas
 *   node probe.js workers         -> una sola
 *   node probe.js logs niveles-auto
 *
 * Esto es lo que se corre ANTES de enchufar el cerebro: si la skill devuelve
 * mal el dato, se ve aca y no despues de gastar tokens.
 */

import { workersStatus, workerLogs } from "./lib/skills.js";

const [, , cual, arg] = process.argv;

function mostrar(titulo, r) {
  console.log(`\n=== ${titulo} ===`);
  console.log(r.resumen);
  if (!r.ok) console.log("ERROR:", r.error);
}

const casos = {
  async workers() {
    const r = await workersStatus();
    mostrar("workers_status", r);
    if (r.ok) {
      console.log(`\n${"worker".padEnd(24)}${"estado".padEnd(14)}rst   tipo`);
      for (const w of r.workers) {
        console.log(
          w.nombre.padEnd(24) +
          w.estado.padEnd(14) +
          String(w.restarts).padStart(3) + "   " +
          (w.programado ? `cron ${w.cron}` : "continuo")
        );
      }
      console.log("\ncuenta:", JSON.stringify(r.cuenta));
    }
  },
  async logs() {
    const r = await workerLogs(arg || "niveles-auto", { lineas: 20 });
    mostrar(`worker_logs ${arg || "niveles-auto"}`, r);
    if (r.ok) console.log(r.log);
  },
};

const elegido = cual && casos[cual] ? [cual] : Object.keys(casos).filter((k) => k !== "logs");
for (const k of elegido) await casos[k]();
