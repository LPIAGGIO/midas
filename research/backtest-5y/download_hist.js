// download_hist.js — descarga historico de precios para backtest 5y
// Plain Node.js, sin deps. Guarda JSON crudo en data/daily, data/hourly y data/ccl.json
// Uso: node download_hist.js

// (ESM: el package.json del repo Midas declara "type": "module")
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIR_DAILY = path.join(ROOT, 'data', 'daily');
const DIR_HOURLY = path.join(ROOT, 'data', 'hourly');
const CCL_FILE = path.join(ROOT, 'data', 'ccl.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const TICKERS = [
  'MU', 'SNDK', 'GGAL', 'NVDA', 'AMD', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN',
  'KO', 'JNJ', 'XOM', 'MELI', 'NU', 'INTC', 'SPCX', 'TSLA', 'ORCL', 'AVGO',
  'VST', 'MCD', 'VIST', 'MSTR', 'HUT', 'MRNA', 'UBER', 'IBM', 'QCOM', 'OKLO',
  'IREN', 'MRVL', 'PLTR', 'NBIS', 'ADBE', 'COIN', 'NFLX', 'RGTI', 'KEEL', 'ADI',
  'SATL', 'LAR', 'HPQ', 'WMT', 'ARM', 'LAC', 'V', 'GPRK',
  // benchmarks
  'SPY', 'QQQ',
];

const PAUSE_MS = 800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const d of [DIR_DAILY, DIR_HOURLY]) {
  fs.mkdirSync(d, { recursive: true });
}

const failures = [];

async function fetchJson(url, label) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const txt = await res.text();
      let json;
      try {
        json = JSON.parse(txt);
      } catch (e) {
        throw new Error('respuesta no-JSON (' + txt.slice(0, 120) + ')');
      }
      return { ok: true, json };
    } catch (err) {
      if (attempt === 2) {
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
      await sleep(1500);
    }
  }
  return { ok: false, error: 'unreachable' };
}

function barsOf(json) {
  try {
    const r = json.chart.result[0];
    return (r.timestamp || []).length;
  } catch (e) {
    return 0;
  }
}

function yahooError(json) {
  try {
    if (json && json.chart && json.chart.error) {
      const e = json.chart.error;
      if (e) return (e.code || 'error') + ': ' + (e.description || '');
    }
    if (!json || !json.chart || !json.chart.result || !json.chart.result[0]) {
      return 'sin chart.result';
    }
  } catch (e) {
    return 'json inesperado';
  }
  return null;
}

async function downloadSeries(sym, kind) {
  const url = kind === 'daily'
    ? `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5y`
    : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1h&range=730d`;
  const dir = kind === 'daily' ? DIR_DAILY : DIR_HOURLY;
  const out = path.join(dir, sym + '.json');

  const r = await fetchJson(url, sym + '/' + kind);
  if (!r.ok) {
    failures.push({ sym, kind, error: r.error });
    console.log(`  [FAIL] ${sym} ${kind}: ${r.error}`);
    return;
  }
  const yerr = yahooError(r.json);
  if (yerr) {
    failures.push({ sym, kind, error: yerr });
    console.log(`  [FAIL] ${sym} ${kind}: ${yerr}`);
    // igual guardamos la respuesta para poder inspeccionarla
    fs.writeFileSync(out, JSON.stringify(r.json));
    return;
  }
  fs.writeFileSync(out, JSON.stringify(r.json));
  console.log(`  [ok]   ${sym} ${kind}: ${barsOf(r.json)} barras`);
}

async function downloadCCL() {
  console.log('\n== CCL (argentinadatos) ==');
  const urlA = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/contadoconliqui';
  let r = await fetchJson(urlA, 'ccl');
  let source = urlA;
  let data = null;

  if (r.ok && Array.isArray(r.json) && r.json.length > 0) {
    data = r.json;
  } else {
    console.log('  endpoint directo fallo o vino vacio, probando el general...');
    await sleep(PAUSE_MS);
    const urlB = 'https://api.argentinadatos.com/v1/cotizaciones/dolares';
    const r2 = await fetchJson(urlB, 'ccl-all');
    source = urlB + ' (filtrado casa=contadoconliqui)';
    if (r2.ok && Array.isArray(r2.json)) {
      data = r2.json.filter((x) => x && x.casa === 'contadoconliqui');
    } else {
      failures.push({ sym: 'CCL', kind: 'ccl', error: (r.error || 'vacio') + ' / ' + (r2.error || 'vacio') });
      console.log('  [FAIL] CCL: no se pudo bajar');
      return;
    }
  }

  if (!data || data.length === 0) {
    failures.push({ sym: 'CCL', kind: 'ccl', error: 'serie vacia' });
    console.log('  [FAIL] CCL: serie vacia');
    return;
  }
  fs.writeFileSync(CCL_FILE, JSON.stringify({ source, n: data.length, data }));
  console.log(`  [ok]   CCL: ${data.length} registros (fuente: ${source})`);
}

async function main() {
  console.log(`Descargando ${TICKERS.length} tickers x 2 series...`);
  let i = 0;
  for (const sym of TICKERS) {
    i++;
    console.log(`[${i}/${TICKERS.length}] ${sym}`);
    await downloadSeries(sym, 'daily');
    await sleep(PAUSE_MS);
    await downloadSeries(sym, 'hourly');
    await sleep(PAUSE_MS);
  }

  await downloadCCL();

  console.log('\n== RESUMEN ==');
  console.log('Fallos: ' + failures.length);
  for (const f of failures) console.log('  - ' + f.sym + ' ' + f.kind + ': ' + f.error);
  fs.writeFileSync(path.join(ROOT, 'data', '_failures.json'), JSON.stringify(failures, null, 2));
}

main().catch((e) => {
  console.error('ERROR FATAL:', e);
  process.exit(1);
});
