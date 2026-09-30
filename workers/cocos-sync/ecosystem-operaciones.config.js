// PM2: puente del dia de las operaciones de Cocos (API de Primary) hacia
// Midas. One-shot cada 5 minutos, lun-vie de 10:00 a 17:55 ART.
module.exports = {
  apps: [
    {
      name: "cocos-operaciones",
      script: "operaciones.js",
      cwd: "/home/midas/workers/cocos-sync",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "*/5 10-17 * * 1-5",
      out_file: "logs/operaciones-out.log",
      error_file: "logs/operaciones-error.log",
      time: true,
    },
  ],
};
