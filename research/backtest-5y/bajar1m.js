/* bajar1m.js — velas de 1 minuto (ultimos 7 dias) de Yahoo para el control
 * fino del INFORME-FINO. Todo local: no toca VPS ni Supabase.
 * Uso: node bajar1m.js
 * Salida: data-1m/<SYM>.json (crudo de Yahoo) + data-1m/_log.json
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, "data-1m");
const REGLAS = path.join(DIR, "..", "backtest-reglas");
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYM_MAP = { YPFD: "YPF", GGAL: "GGAL" };

const tr = JSON.parse(fs.readFileSync(path.join(REGLAS, "paper_trades_export.json"), "utf8"));
const DESDE = Date.parse("2026-09-08T00:00:00Z");
const syms = [...new Set(tr.filter((t) => t.entry_ts && Date.parse(t.entry_ts) >= DESDE).map((t) => SYM_MAP[t.sym] || t.sym))].sort();

async function main() {
  console.log(`tickers a bajar (1m, 7d): ${syms.length}`);
  const log = { started: new Date().toISOString(), ok: {}, failed: {} };
  for (const sym of syms) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=7d`;
    let got = null, err = null;
    for (let i = 1; i <= 2 && !got; i++) {
      try {
        const res = await fetch(url, { headers: UA });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const r = j?.chart?.result?.[0];
        if (!r || !r.timestamp?.length) throw new Error(j?.chart?.error?.description || "sin velas");
        got = { raw: j, n: r.timestamp.length, from: r.timestamp[0], to: r.timestamp[r.timestamp.length - 1] };
      } catch (e) { err = e.message; if (i === 1) await sleep(3000); }
    }
    if (got) {
      fs.writeFileSync(path.join(OUT, `${sym}.json`), JSON.stringify(got.raw));
      log.ok[sym] = { bars: got.n, from: new Date(got.from * 1000).toISOString().slice(0, 16), to: new Date(got.to * 1000).toISOString().slice(0, 16) };
      console.log(`  ${sym}: ${got.n} velas · ${log.ok[sym].from} → ${log.ok[sym].to}`);
    } else { log.failed[sym] = err; console.log(`  ${sym}: FALLO (${err})`); }
    await sleep(800);
  }
  log.finished = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, "_log.json"), JSON.stringify(log, null, 2));
  console.log(`listo: ${Object.keys(log.ok).length} ok, ${Object.keys(log.failed).length} fallidos`);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
