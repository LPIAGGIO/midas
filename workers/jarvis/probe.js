/**
 * Probe: corre las skills sin LLM y sin el SDK, para ver el dato crudo.
 *
 *   node probe.js                 -> todas
 *   node probe.js workers
 *   node probe.js momentum
 *   node probe.js cartera
 *   node probe.js global
 *   node probe.js precio MU
 *   node probe.js logs niveles-auto
 *
 * Esto es lo que se corre ANTES de enchufar el cerebro: si la skill devuelve
 * mal el dato, se ve aca y no despues de gastar tokens.
 */

// Carga de .env a mano: el probe tiene que correr sin `npm install`, asi que no
// puede depender de dotenv. Busca en el worker y en la raiz del repo.
import { readFileSync } from "node:fs";
for (const f of [".env", "../../.env.local", "../../.env"]) {
  try {
    for (const cruda of readFileSync(new URL(f, import.meta.url), "utf8").split(/\r?\n/)) {
      const linea = cruda.trim();
      if (!linea || linea.startsWith("#")) continue;
      const i = linea.indexOf("=");
      if (i < 1) continue;
      const k = linea.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = linea.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no existe, seguimos */ }
}

import { workersStatus, workerLogs } from "./lib/skills.js";
import { mercadoGlobal } from "./lib/mercado.js";
import { cartera, momentum, precio } from "./lib/cartera.js";
import { hayCredenciales, esServiceKey } from "./lib/supa.js";

const [, , cual, arg] = process.argv;

function mostrar(titulo, r) {
  console.log(`\n=== ${titulo} ===`);
  console.log(r.resumen);
  if (r.error) console.log("ERROR:", r.error);
}

const casos = {
  async workers() {
    const r = await workersStatus();
    mostrar("workers_status", r);
    if (r.ok) {
      console.log(`\n${"worker".padEnd(24)}${"estado".padEnd(13)}rst  tipo`);
      for (const w of r.workers) {
        console.log(
          w.nombre.padEnd(24) + w.estado.padEnd(13) +
          String(w.restarts).padStart(3) + "  " +
          (w.programado ? `cron ${w.cron}` : "continuo")
        );
      }
    }
  },

  async momentum() {
    const r = await momentum();
    mostrar("momentum", r);
    if (r.ok && r.ranking) {
      console.log("\nranking 12-1:");
      for (const x of r.ranking.slice(0, 10)) {
        console.log(`  ${String(x.t).padEnd(7)}${String(x.mom).padStart(7)}%${r.top8.includes(x.t) ? "  <- top8" : ""}`);
      }
    }
  },

  async cartera() {
    const r = await cartera();
    mostrar("cartera", r);
    if (r.ok) {
      console.log(`\n${"ticker".padEnd(9)}${"neto".padStart(12)}${"precio".padStart(13)}${"valuado".padStart(15)}`);
      for (const p of r.items.slice(0, 25)) {
        console.log(
          p.ticker.padEnd(9) +
          p.neto.toLocaleString("es-AR").padStart(12) +
          (p.precio == null ? "s/d" : p.precio.toLocaleString("es-AR")).padStart(13) +
          (p.valuado == null ? "s/d" : Math.round(p.valuado).toLocaleString("es-AR")).padStart(15)
        );
      }
    }
  },

  async global() {
    const r = await mercadoGlobal();
    mostrar("mercado_global", r);
    if (r.ok) {
      console.log("");
      for (const it of r.items) {
        console.log(
          `  ${it.nombre.padEnd(20)}${it.ultimo.toLocaleString("es-AR").padStart(12)}  ` +
          `${((it.varPct >= 0 ? "+" : "") + it.varPct.toFixed(1) + "%").padStart(7)}  ` +
          `vs cierre ${it.prevCloseFecha}   [Yahoo decia ${it.chartPreviousCloseIgnorado}]`
        );
      }
    }
  },

  async precio() {
    const r = await precio(arg || "MU");
    mostrar(`precio ${arg || "MU"}`, r);
  },

  async logs() {
    const r = await workerLogs(arg || "niveles-auto", { lineas: 20 });
    mostrar(`worker_logs ${arg || "niveles-auto"}`, r);
    if (r.ok) console.log(r.log);
  },
};

console.log(
  hayCredenciales()
    ? `Supabase: ${esServiceKey() ? "service key (ve todo)" : "anon key (RLS tapa positions)"}`
    : "Supabase: SIN credenciales en el entorno"
);

const elegido = cual && casos[cual] ? [cual] : ["workers", "momentum", "global", "cartera"];
for (const k of elegido) await casos[k]();
