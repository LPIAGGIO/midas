// Resumen diario de las grillas por Telegram: lun-vie 17:03 (la rueda
// cierra 17:00). Solo lectura. Figura "stopped" entre corridas; es normal.
module.exports = {
  apps: [{
    name: "scalp-resumen", script: "resumen.js", cwd: "/home/midas/workers/cocos-scalp",
    exec_mode: "fork", instances: 1, autorestart: false, cron_restart: "3 17 * * 1-5",
    out_file: "logs/resumen-out.log", error_file: "logs/resumen-error.log", time: true,
  }],
};
