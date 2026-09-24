// bajar-nuevos.js — baja daily(5y)+hourly(730d) de los candidatos nuevos
import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const TICKERS = ['LLY','AXP','C','EWZ','AMGN','UNH','RIO','TMUS','CSCO','BA'];
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
for (const kind of ['daily','hourly']) fs.mkdirSync(path.join(ROOT,'data',kind),{recursive:true});
for (const sym of TICKERS) {
  for (const kind of ['daily','hourly']) {
    const url = kind==='daily'
      ? `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y`
      : `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1h&range=730d`;
    try {
      const res = await fetch(url,{headers:{'User-Agent':UA,'Accept':'application/json'}});
      const j = await res.json();
      const n = j?.chart?.result?.[0]?.timestamp?.length || 0;
      if (!n) { console.log(`  [FAIL] ${sym} ${kind}`); continue; }
      fs.writeFileSync(path.join(ROOT,'data',kind,sym+'.json'), JSON.stringify(j));
      console.log(`  ok ${sym} ${kind}: ${n} barras`);
    } catch(e){ console.log(`  [ERR] ${sym} ${kind}: ${e.message}`); }
    await sleep(700);
  }
}
