// PM2: foto diaria de la cuenta Cocos por la API de Primary, lun-vie cada 15 min
// de 10:00 a 12:45 ART (Cocos carga Matriz cuando LP se lo pide). One-shot: corre, guarda y sale. El VPS esta en hora ART.
//   pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: "cocos-sync",
      script: "worker.js",
      cwd: "/home/midas/workers/cocos-sync",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "*/15 10-12 * * 1-5",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
