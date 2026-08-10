/**
 * Worker superinvestors-13f — carteras de superinversores desde los 13F de
 * la SEC (fuente OFICIAL: data.sec.gov + Archives, gratis y estable; no se
 * scrapea ninguna web de terceros).
 *
 * Qué hace, por gestor de la lista curada:
 *   1. Pide /submissions/CIK########.json y busca el último 13F-HR.
 *   2. Si ese período ya está guardado, no hace nada (idempotente).
 *   3. Si es nuevo, baja el information table XML del filing, lo parsea,
 *      agrega por CUSIP (un mismo papel puede venir en varias filas) y
 *      guarda las tenencias con su peso en la cartera.
 *
 * IMPORTANTE — el atraso es parte del dato: el 13F vence 45 días después
 * del cierre del trimestre y muchos gestores presentan sobre la fecha
 * límite. Se guardan report_date (período) y filing_date (presentación)
 * para que la pantalla los muestre SIEMPRE al lado de cada gestor. Al
 * 10/08/2026, la mayoría de los grandes todavía reportaba al 31/03.
 *
 * Limitaciones que hereda el dato (van también en la UI):
 *   - Solo acciones USA en LARGO: no hay shorts, ni bonos, ni posiciones
 *     fuera de EE.UU. (por eso un fondo puede parecer "todo comprado").
 *   - Un gestor que desregistra su fondo desaparece (caso Scion/Burry).
 *
 * Corre una vez por día (pm2 cron): son ~25 pedidos, nada de volumen.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !KEY) { console.error("faltan env"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, KEY, {
  auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: ws },
});
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// EDGAR pide identificarse con contacto real en el User-Agent.
const UA = { "User-Agent": "Midas Research lpiaggio@gmail.com" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Gestores seguidos. Los CIK se verificaron uno por uno contra EDGAR
// (varios tienen CIKs viejos deprecados que siguen existiendo con datos de
// 2002-2015: acá va el que presenta de verdad). Scion (Burry) y Greenlight
// (Einhorn) quedan afuera: dejaron de presentar 13F.
const GESTORES = [
  { cik: "0001067983", gestor: "Warren Buffett" },
  { cik: "0001656456", gestor: "David Tepper" },
  { cik: "0001336528", gestor: "Bill Ackman" },
  { cik: "0001061768", gestor: "Seth Klarman" },
  { cik: "0001167483", gestor: "Chase Coleman" },
  { cik: "0000934639", gestor: "Lee Ainslie" },
  { cik: "0001279936", gestor: "William Von Mueffling" },
  { cik: "0001034524", gestor: "Polen Capital" },
  { cik: "0000905567", gestor: "Yacktman" },
  { cik: "0000732905", gestor: "Tweedy Browne" },
  { cik: "0001096343", gestor: "Thomas Gayner" },
  { cik: "0000915191", gestor: "Prem Watsa" },
  { cik: "0000936753", gestor: "John Rogers" },
  { cik: "0000820124", gestor: "Harry Burn" },
  { cik: "0001016287", gestor: "David Katz" },
  { cik: "0001106129", gestor: "Jensen Investment" },
  { cik: "0001070134", gestor: "Mairs & Power" },
  { cik: "0001112520", gestor: "Chuck Akre" },
  { cik: "0000860643", gestor: "Tom Russo" },
];

// Universo propio: patrones de nombre de emisor → ticker. El 13F reporta
// CUSIP y nombre, no ticker; para los papeles que nos importan el nombre
// alcanza y es estable. Lo que no matchea queda con ticker null (se muestra
// igual por nombre en el ranking general).
const MAPA = [
  [/^MICRON/i, "MU"], [/SANDISK/i, "SNDK"], [/^NU HOLDINGS/i, "NU"],
  [/MERCADOLIBRE/i, "MELI"], [/EXXON/i, "XOM"], [/ALPHABET/i, "GOOGL"],
  [/^APPLE/i, "AAPL"], [/ADVANCED MICRO/i, "AMD"], [/BROADCOM/i, "AVGO"],
  [/^INTEL/i, "INTC"], [/JOHNSON\s*&?\s*JOHNSON/i, "JNJ"], [/NVIDIA/i, "NVDA"],
  [/^ORACLE/i, "ORCL"], [/QUALCOMM/i, "QCOM"], [/^ASML/i, "ASML"],
  [/^NIKE/i, "NKE"], [/TAIWAN SEMI/i, "TSM"], [/MICROSOFT/i, "MSFT"],
  [/^META PLATF/i, "META"], [/AMAZON/i, "AMZN"], [/^VISA/i, "V"],
  [/MASTERCARD/i, "MA"], [/BERKSHIRE/i, "BRK"], [/COCA[\s-]?COLA/i, "KO"],
  [/^TESLA/i, "TSLA"], [/JPMORGAN|JPMORGAN CHASE/i, "JPM"], [/WAL[\s-]?MART|WALMART/i, "WMT"],
  [/PROCTER/i, "PG"], [/(WALT )?DISNEY/i, "DIS"], [/^COINBASE/i, "COIN"],
  [/PALANTIR/i, "PLTR"], [/MICROSTRATEGY|^STRATEGY INC/i, "MSTR"],
  [/SALESFORCE/i, "CRM"], [/NETFLIX/i, "NFLX"], [/^BOEING/i, "BA"],
  [/^YPF/i, "YPF"], [/GRUPO FINANCIERO GALICIA|GRUPO GALICIA/i, "GGAL"],
  [/^CARVANA/i, "CVNA"], [/MOODY/i, "MCO"], [/^GE AEROSPACE|GENERAL ELECTRIC/i, "GE"],
];
const tickerDe = (issuer) => {
  for (const [re, tk] of MAPA) if (re.test(issuer || "")) return tk;
  return null;
};

const tag = (s, t) => {
  // Los 13F usan prefijos de namespace distintos según el filer (ns1:, etc).
  const m = new RegExp(`<(?:[a-zA-Z0-9]+:)?${t}>([^<]*)</(?:[a-zA-Z0-9]+:)?${t}>`).exec(s);
  return m ? m[1].trim() : null;
};

async function procesar(g) {
  const r = await fetch(`https://data.sec.gov/submissions/CIK${g.cik}.json`, { headers: UA });
  if (!r.ok) { log(`${g.cik} submissions HTTP ${r.status}`); return; }
  const j = await r.json();
  const rec = j.filings?.recent || {};
  const i = (rec.form || []).findIndex((f) => f === "13F-HR");
  if (i < 0) { log(`${g.gestor}: sin 13F-HR`); return; }

  const reportDate = rec.reportDate[i], filingDate = rec.filingDate[i];
  const acc = rec.accessionNumber[i];

  // ¿Ya lo tenemos? (idempotencia: no se re-baja lo mismo todos los días)
  const { data: ya } = await supabase.from("superinvestors")
    .select("last_report_date").eq("cik", g.cik).maybeSingle();
  if (ya?.last_report_date === reportDate) {
    log(`${g.gestor}: ya al día (${reportDate})`);
    return;
  }

  // El information table es el XML del filing que NO es primary_doc.
  const dir = `https://www.sec.gov/Archives/edgar/data/${String(Number(g.cik))}/${acc.replace(/-/g, "")}/`;
  const idx = await (await fetch(dir, { headers: UA })).text();
  const xmls = [...idx.matchAll(/href="[^"]*\/([^/"]+\.xml)"/g)].map((m) => m[1])
    .filter((f) => !/primary_doc/i.test(f));
  if (!xmls.length) { log(`${g.gestor}: sin information table en ${acc}`); return; }

  await sleep(200);
  const xml = await (await fetch(dir + xmls[0], { headers: UA })).text();
  const bloques = [...xml.matchAll(/<(?:[a-zA-Z0-9]+:)?infoTable>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?infoTable>/g)].map((m) => m[1]);
  if (!bloques.length) { log(`${g.gestor}: information table vacío`); return; }

  // Agregar por CUSIP: un mismo papel puede venir en varias filas (clases,
  // discreción compartida entre managers del mismo filer).
  const porCusip = new Map();
  for (const b of bloques) {
    const cusip = (tag(b, "cusip") || "").toUpperCase();
    if (!cusip) continue;
    const val = Number(tag(b, "value")) || 0;
    const sh = Number(tag(b, "sshPrnamt")) || 0;
    const issuer = tag(b, "nameOfIssuer") || null;
    const g0 = porCusip.get(cusip) || { cusip, issuer, value: 0, shares: 0 };
    g0.value += val; g0.shares += sh;
    if (!g0.issuer && issuer) g0.issuer = issuer;
    porCusip.set(cusip, g0);
  }
  const filas = [...porCusip.values()];

  // ESCALA: la columna `value` del 13F está en DÓLARES desde 2023, pero
  // varios filers siguen reportando en MILES (caso Baupost: Amazon "649.543"
  // con 3,1M de acciones = 21 centavos por acción, imposible). Se detecta por
  // el precio implícito mediano (valor/acciones): si da menos de 5, el filing
  // está en miles y hay que multiplicar por 1000. Sin esto, un gestor
  // aparecería 1000 veces más chico y ensuciaría todos los agregados.
  const implicitos = filas.filter((f) => f.shares > 0 && f.value > 0)
    .map((f) => f.value / f.shares).sort((a, b) => a - b);
  const mediana = implicitos.length ? implicitos[Math.floor(implicitos.length / 2)] : null;
  const escala = mediana != null && mediana < 5 ? 1000 : 1;
  if (escala !== 1) {
    for (const f of filas) f.value *= escala;
    log(`${g.gestor}: filing en MILES (precio implícito mediano ${mediana.toFixed(3)}), escalado ×1000`);
  }

  const total = filas.reduce((s, f) => s + f.value, 0);
  if (!(total > 0)) { log(`${g.gestor}: valor total 0, se saltea`); return; }

  const rows = filas.map((f) => ({
    cik: g.cik, report_date: reportDate, cusip: f.cusip, issuer: f.issuer,
    ticker: tickerDe(f.issuer), value_usd: Math.round(f.value),
    shares: Math.round(f.shares),
    pct_portfolio: Math.round((f.value / total) * 10000) / 100,
  }));
  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await supabase.from("si_holdings")
      .upsert(rows.slice(k, k + 500), { onConflict: "cik,report_date,cusip" });
    if (error) { log(`${g.gestor}: error holdings ${error.message}`); return; }
  }
  await supabase.from("superinvestors").upsert({
    cik: g.cik, nombre: j.name, gestor: g.gestor,
    last_report_date: reportDate, last_filing_date: filingDate,
    holdings_count: rows.length, total_value_usd: Math.round(total),
    updated_at: new Date().toISOString(),
  }, { onConflict: "cik" });
  log(`${g.gestor}: ${rows.length} posiciones al ${reportDate} (presentado ${filingDate}), US$ ${(total / 1e9).toFixed(1)}B`);
}

(async () => {
  log(`superinvestors-13f: ${GESTORES.length} gestores`);
  for (const g of GESTORES) {
    try { await procesar(g); } catch (e) { log(`${g.gestor} ERROR ${e.message}`); }
    await sleep(400); // cortesía con EDGAR
  }
  log("listo");
})();
