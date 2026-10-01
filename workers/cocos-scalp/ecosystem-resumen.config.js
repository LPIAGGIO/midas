// Resumen diario de las grillas por Telegram: lun-vie 16:52 (las grillas
// cierran 16:45). Solo lectura. Figura "stopped" entre corridas; es normal.
module.exports = {
  apps: [{
    name: "scalp-resumen", script: "resumen.js", cwd: "/home/midas/workers/cocos-scalp",
    exec_mode: "fork", instances: 1, autorestart: false, cron_restart: "52 16 * * 1-5",
    out_file: "logs/resumen-out.log", error_file: "logs/resumen-error.log", time: true,
  }],
};
