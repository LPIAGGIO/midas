// PM2: bot de niveles en Cocos (API de Primary). Proceso persistente: corre
// 24/7 y se auto-gatea a la rueda (lun-vie 10:30-17:05 ART) adentro.
//   pm2 start ecosystem.config.js && pm2 save
// Apagar del todo: pm2 stop cocos-bot. Sin entradas nuevas pero manejando
// los stops: linked_brokers.bot_enabled=false (broker 'cocos').
module.exports = {
  apps: [
    {
      name: "cocos-bot",
      script: "worker.js",
      cwd: "/home/midas/workers/cocos-bot",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "300M",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
