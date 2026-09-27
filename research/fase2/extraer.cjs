// Extrae funciones top-level del monolito por nombre (brace matching) para
// testear el parser y la derivacion REALES sin copiar codigo a mano.
const fs = require('fs');
const SRC = fs.readFileSync(__dirname + '/../../src/MidasTerminal.jsx', 'utf8');
const BS = String.fromCharCode(92);

function extraer(nombre) {
  const re = new RegExp('^(?:async )?function ' + nombre + '\\s*\\(|^const ' + nombre + '\\s*=', 'm');
  const m = re.exec(SRC);
  if (!m) throw new Error('no encuentro ' + nombre);
  let j = SRC.indexOf('{', m.index), depth = 0, enStr = null, enRe = false;
  for (; j < SRC.length; j++) {
    const c = SRC[j];
    if (enStr) {
      if (c === BS) { j++; continue; }
      if (c === enStr) enStr = null;
      continue;
    }
    if (enRe) {
      if (c === BS) { j++; continue; }
      if (c === '/') enRe = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { enStr = c; continue; }
    if (c === '/' && SRC[j + 1] === '/') { j = SRC.indexOf('\n', j); continue; }
    if (c === '/' && SRC[j + 1] === '*') { j = SRC.indexOf('*/', j) + 1; continue; }
    if (c === '/') {
      // regex literal si lo precede un operador o apertura
      let k = j - 1; while (k >= 0 && /\s/.test(SRC[k])) k--;
      if (k < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(SRC[k]) || /\b(return|typeof|case)$/.test(SRC.slice(Math.max(0, k - 6), k + 1))) { enRe = true; continue; }
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  let fin = j + 1;
  if (SRC[fin] === ';') fin++;
  return SRC.slice(m.index, fin);
}

// Carga un conjunto de funciones en un scope comun y las devuelve.
function cargar(nombres, extra = '') {
  const cuerpo = nombres.map(extraer).join('\n\n');
  const exp = 'return {' + nombres.join(',') + '};';
  return new Function(extra + '\n' + cuerpo + '\n' + exp)();
}

module.exports = { extraer, cargar, SRC };

if (require.main === module) {
  for (const n of process.argv.slice(2)) {
    const f = extraer(n);
    console.log('// ' + n + ': ' + f.split('\n').length + ' lineas');
  }
}
