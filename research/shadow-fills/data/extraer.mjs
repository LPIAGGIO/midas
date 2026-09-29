// Extrae el CSV de los volcados del MCP de Supabase (texto con un JSON adentro) a .csv (una pata por linea).
// sim_raw.txt    <- sim.sql       (lo que asumio el libro sombra)
// strict_raw.txt <- validar.sql con prm.modo='s'
// laxo_raw.txt   <- validar.sql con prm.modo='l'
import fs from "node:fs";
for (const [src, dst] of [["sim_raw.txt", "sim.csv"], ["strict_raw.txt", "strict.csv"], ["laxo_raw.txt", "laxo.csv"]]) {
  const raw = fs.readFileSync(new URL(src, import.meta.url), "utf8");
  const inner = JSON.parse(raw).result;                 // texto con el JSON de filas adentro
  const rows = JSON.parse(inner.match(/\[\{.*\}\]/s)[0]);
  const lines = rows[0].csv.split("|");
  fs.writeFileSync(new URL(dst, import.meta.url), lines.join("\n") + "\n");
  console.log(dst, lines.length, "patas");
}
