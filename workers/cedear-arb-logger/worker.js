/**
 * Worker: cedear-arb-logger — mide el mispricing CEDEAR vs subyacente USA.
 *
 * OBJETIVO (fase research): juntar data real para responder UNA pregunta
 * antes de construir cualquier alerta o bot: ¿cuando el subyacente se mueve
 * en NYSE, el CEDEAR local (ARS) laguea de forma capturable despues del
 * spread? Con 0 comision en Cocos, ese lag —si existe y es persistente— es
 * el edge. Sin esta data, todo lo demas es construir sobre arena.
 *
 * COMO MIDE (aprendido del probe del 13/06):
 *   - Pata liquida = CEDEAR en ARS (data912 arg_cedears, campo `c`). La
 *     variante CCL "C" (USD) es ILIQUIDA en casi todos → su last queda
 *     stale y genera mispricing fantasma. NO se usa como precio, solo se
 *     loguea para referencia.
 *   - Subyacente USA = Yahoo chart v8 (regularMarketPrice + ts + market
 *     state). Gratis, sin key.
 *   - ratio = acciones por CEDEAR. SEMBRADO con los oficiales (cambian
 *     poco; la CNV avisa). Si un ratio cambia, el dev_pct de ese ticker se
 *     va a un sesgo constante → señal para revisarlo.
 *   - CCL implicito del ticker = cedear_ars / (under_usd / ratio).
 *   - CCL de referencia = MEDIANA del CCL implicito de los liquidos del
 *     snapshot (under fresco + NYSE abierto). Es el "dolar CEDEAR" del
 *     momento, fresco, sin depender de la variante C.
 *   - desvio % = (cedear_ars - fair_ars) / fair_ars * 100, con
 *     fair_ars = under_usd / ratio * ccl_ref. Negativo = CEDEAR barato
 *     (el subyacente subio y el local no ajusto aun) = posible compra.
 *
 * CADENCIA: long-running, sample cada 60s, gateado por horario ART
 * (11:00-17:15, lun-vie) = solapamiento NYSE-BYMA. Fuera de eso duerme.
 * PM2 autorestart:true (NO one-shot+cron como los otros workers: el
 * sampling intradia de alta frecuencia pide proceso vivo).
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws } }
);

const log = (m, x) => console.log(`[${new Date().toISOString()}] [INFO] ${m}`, x ? JSON.stringify(x) : '');
const logErr = (m, e) => console.error(`[${new Date().toISOString()}] [ERROR] ${m}`, e?.message || e || '');

// ── Universo: ticker CEDEAR (ARS en data912) → { yahoo, ratio } ──────────
// ratio = cuantos CEDEARs equivalen a 1 accion del subyacente.
// Sembrados de los oficiales y validados contra el probe del 13/06 (el
// cociente under/cedearC convergio limpio a estos enteros al cierre).
// TSLA marcado: el probe dio 15.65 por staleness de la variante C; el
// oficial historico es 15 → validar con liquidez la 1ra rueda.
const UNIVERSE = {
  AAPL:  { y: 'AAPL',  ratio: 20 },
  MSFT:  { y: 'MSFT',  ratio: 30 },
  NVDA:  { y: 'NVDA',  ratio: 24 },
  AMZN:  { y: 'AMZN',  ratio: 144 },
  META:  { y: 'META',  ratio: 24 },
  TSLA:  { y: 'TSLA',  ratio: 15 },
  AMD:   { y: 'AMD',   ratio: 10 },
  KO:    { y: 'KO',    ratio: 5 },
  MELI:  { y: 'MELI',  ratio: 120 },
  NFLX:  { y: 'NFLX',  ratio: 48 },
  BABA:  { y: 'BABA',  ratio: 9 },
  V:     { y: 'V',     ratio: 18 },
  MA:    { y: 'MA',    ratio: 33 },
  JPM:   { y: 'JPM',   ratio: 15 },
  PYPL:  { y: 'PYPL',  ratio: 8 },
  INTC:  { y: 'INTC',  ratio: 5 },
  QQQ:   { y: 'QQQ',   ratio: 20 },
  SPY:   { y: 'SPY',   ratio: 60 },
  WMT:   { y: 'WMT',   ratio: 18 },
  JNJ:   { y: 'JNJ',   ratio: 15 },
  COIN:  { y: 'COIN',  ratio: 27 },
  PLTR:  { y: 'PLTR',  ratio: 3 },
  MSTR:  { y: 'MSTR',  ratio: 20 },
  GLOB:  { y: 'GLOB',  ratio: 18 },
  CRM:   { y: 'CRM',   ratio: 18 },
  ORCL:  { y: 'ORCL',  ratio: 3 },
};

const SAMPLE_MS = 60_000;
const MIN_ARS_VOL = 5000;   // umbral de liquidez para entrar al CCL de referencia

const median = (arr) => {
  const a = arr.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// ¿Estamos en ventana de sampling? 11:00-17:15 ART (UTC-3), lun-vie.
function inWindow() {
  const now = new Date();
  const artH = (now.getUTCHours() + 24 - 3) % 24;
  const artMin = artH * 60 + now.getUTCMinutes();
  const dow = (now.getUTCDay()); // 0=dom..6=sab (ART no cruza dia en este rango)
  if (dow === 0 || dow === 6) return false;
  return artMin >= 11 * 60 && artMin <= 17 * 60 + 15;
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (MidasTerminal cedear-arb)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Yahoo chart por simbolo → { price, ts, open } (open = NYSE en rueda regular)
async function yahooQuote(sym) {
  const j = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;
  const now = Math.floor(Date.now() / 1000);
  const reg = meta.currentTradingPeriod?.regular;
  const open = reg ? now >= reg.start && now < reg.end : false;
  return { price: meta.regularMarketPrice, ts: meta.regularMarketTime, open };
}

async function sample() {
  // 1) CEDEARs locales (un solo fetch).
  let ced;
  try { ced = await fetchJson('https://data912.com/live/arg_cedears'); }
  catch (e) { return logErr('data912 fail', e); }
  const bySym = {}; for (const c of ced) bySym[c.symbol] = c;

  // 2) Subyacentes USA (chart por simbolo, en tandas de 6).
  const tickers = Object.keys(UNIVERSE);
  const ysyms = [...new Set(tickers.map((t) => UNIVERSE[t].y))];
  const yq = {};
  for (let i = 0; i < ysyms.length; i += 6) {
    const chunk = ysyms.slice(i, i + 6);
    const res = await Promise.allSettled(chunk.map((s) => yahooQuote(s)));
    res.forEach((r, k) => { if (r.status === 'fulfilled' && r.value) yq[chunk[k]] = r.value; });
  }

  // 3) Armar filas + juntar CCL implicitos de los liquidos para la referencia.
  const ts = new Date().toISOString();
  const prelim = [];
  const cclPool = [];
  for (const t of tickers) {
    const { y, ratio } = UNIVERSE[t];
    const arsRow = bySym[t];
    const under = yq[y];
    if (!arsRow || !arsRow.c || !under) continue;
    const cedearArs = arsRow.c;
    const fairUsd = under.price / ratio;
    const cclImpl = cedearArs / fairUsd;
    const cclVar = bySym[t + 'C'];
    prelim.push({
      ticker: t, under, ratio, cedearArs, cclImpl,
      arsVol: arsRow.v || 0, arsBid: arsRow.px_bid || null, arsAsk: arsRow.px_ask || null,
      cedearCcl: cclVar?.c || null,
    });
    // al pool de referencia solo si liquido, fresco y NYSE abierto
    // pool de referencia: liquido + NYSE abierto. FORCE_SAMPLE relaja el
    // open-check para poder testear inserciones fuera de rueda (sabado).
    const okOpen = under.open || process.env.FORCE_SAMPLE === '1';
    if ((arsRow.v || 0) >= MIN_ARS_VOL && okOpen && Number.isFinite(cclImpl)) cclPool.push(cclImpl);
  }
  const cclRef = median(cclPool);
  if (!cclRef) { log('sin CCL de referencia (NYSE cerrado o sin liquidos) — skip'); return; }

  // 4) desvio final contra el CCL de referencia.
  const rows = prelim.map((p) => {
    const fairArs = (p.under.price / p.ratio) * cclRef;
    const devPct = (p.cedearArs - fairArs) / fairArs * 100;
    return {
      ts, ticker: p.ticker,
      under_usd: p.under.price,
      under_ts: new Date(p.under.ts * 1000).toISOString(),
      under_mkt_open: p.under.open,
      cedear_ars: p.cedearArs,
      cedear_ccl_usd: p.cedearCcl,
      ratio: p.ratio,
      ccl_ref: +cclRef.toFixed(2),
      ccl_impl: +p.cclImpl.toFixed(2),
      fair_ars: +fairArs.toFixed(2),
      dev_pct: +devPct.toFixed(3),
      ars_vol: p.arsVol,
      ars_bid: p.arsBid,
      ars_ask: p.arsAsk,
    };
  });

  const { error } = await supabase.from('cedear_arb_log').insert(rows);
  if (error) return logErr('insert', error);
  const top = [...rows].sort((a, b) => Math.abs(b.dev_pct) - Math.abs(a.dev_pct))[0];
  log(`snapshot ok: ${rows.length} filas, CCLref ${cclRef.toFixed(1)}, mayor desvio ${top.ticker} ${top.dev_pct}%`);
}

async function tick() {
  if (!inWindow() && process.env.FORCE_SAMPLE !== '1') return;
  try { await sample(); } catch (e) { logErr('sample', e); }
}

log('cedear-arb-logger arriba — sample 60s, ventana 11:00-17:15 ART lun-vie');
tick();
setInterval(tick, SAMPLE_MS);
