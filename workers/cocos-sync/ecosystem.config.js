// PM2: foto diaria de la cuenta Cocos por la API de Primary, lun-vie una vez por hora (y cada vez que el puente de operaciones carga algo)
// de 10:35 a 17:35 ART (toda la rueda: el cartel de control compara tambien la tenencia ACTUAL). One-shot: corre, guarda y sale. El VPS esta en hora ART.
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
      cron_restart: "35 10-17 * * 1-5",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
