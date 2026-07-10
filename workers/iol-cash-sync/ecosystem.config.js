// PM2 ecosystem para el worker iol-cash-sync.
//
// One-shot programado: corre, sincroniza, sale. Cada 15 minutos.
// El VPS está en hora ART; el horario no importa acá (corre 24/7).
//
// Arrancar:  pm2 start ecosystem.config.js
// Guardar:   pm2 save
// Ver logs:  pm2 logs iol-cash-sync

module.exports = {
  apps: [
    {
      name: "iol-cash-sync",
      script: "worker.js",
      cwd: "/home/midas/workers/iol-cash-sync",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "*/15 * * * *",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
