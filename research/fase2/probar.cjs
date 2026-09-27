// Corre el parser y la derivacion REALES del monolito sobre un CSV de Cocos y
// muestra la tenencia neta que armaria la app. Solo lectura: no toca la base.
//   node probar.cjs "<ruta csv>" [--detalle TICKER]
const fs = require('fs');
const { cargar } = require('./extraer.cjs');

// bondMaturities.js es ESM: se le sacan los "export" y va como prefijo del scope.
const BOND = fs.readFileSync(__dirname + '/../../src/bondMaturities.js', 'utf8').replace(/^export /gm, '');
const F = cargar(['_numAr', '_isoFromDMY', '_tickerFromInstrumento', '_categoriaMov',
  'esTickerOpcion', 'parseMovimientosCsv', 'fciOpFromMov', 'deriveFromLedger', 'FCI_LEDGER_MAP'], BOND);

const ruta = process.argv[2];
const idxDet = process.argv.indexOf('--detalle');
const det = idxDet > 0 ? process.argv[idxDet + 1].toUpperCase() : null;

const texto = fs.readFileSync(ruta, 'latin1');
const parsed = F.parseMovimientosCsv(texto, new Set());
const filas = (parsed.rows || parsed).map(({ status, ...r }) => r);
console.log('filas parseadas:', filas.length);

const cats = {};
for (const r of filas) cats[r.categoria] = (cats[r.categoria] || 0) + 1;
console.log('categorias:', JSON.stringify(cats));

const d = F.deriveFromLedger(filas);
const neto = new Map();
for (const p of [...d.positions, ...d.lots]) {
  const k = p.instrument_type + '|' + p.ticker;
  neto.set(k, (neto.get(k) || 0) + (p.side === 'buy' ? 1 : -1) * p.quantity);
}
console.log('\nTENENCIA NETA que armaria la app (distinta de cero):');
for (const [k, q] of [...neto.entries()].sort()) if (Math.abs(q) > 1e-6) console.log('  ' + k.padEnd(28) + q.toLocaleString('es-AR'));

if (det) {
  console.log('\nDETALLE ' + det + ':');
  for (const r of filas.filter((x) => (x.ticker || '').toUpperCase() === det))
    console.log('  ' + r.fecha_ejecucion + '  ' + (r.tipo_operacion || '').padEnd(34) + ' cat=' + r.categoria + '  cant=' + r.cantidad + '  precio=' + r.precio + '  total=' + r.total);
}
module.exports = { F, filas, d };
