// PM2: grilla intradía sobre un CEDEAR en Cocos. Sin autorestart: si se cae,
// no vuelve a mandar órdenes solo. Órdenes reales: SCALP_REAL=1 en .env.
// Lo enciende LP. Para cortar todo y vender: crear el archivo STOP en la carpeta.
module.exports = {
  apps: [{
    name: "cocos-scalp", script: "worker.js", cwd: "/home/midas/workers/cocos-scalp",
    exec_mode: "fork", instances: 1, autorestart: false, kill_timeout: 15000,
    out_file: "logs/out.log", error_file: "logs/error.log", time: true,
  }],
};
