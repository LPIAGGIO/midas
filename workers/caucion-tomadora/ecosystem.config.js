// Toma caución a 1 día para cubrir el descubierto en pesos de las dos cuentas
// de Cocos. Órdenes reales solo con CAUCION_REAL=1 en .env. Lo enciende LP.
// Para frenarlo sin apagarlo: crear el archivo STOP en esta carpeta.
module.exports = { apps: [{ name: "caucion-tomadora", script: "worker.js", cwd: "/home/midas/workers/caucion-tomadora", exec_mode: "fork", instances: 1, autorestart: true, kill_timeout: 15000, out_file: "logs/out.log", error_file: "logs/error.log", time: true }] };
