// PM2: puente del dia de las operaciones de la cuenta 3893 (Axon) de Cocos hacia
// Midas (cuenta '3893' de LP). Mismo operaciones.js que la 72404, con las
// credenciales de cocos-cuenta2. Cada 5 minutos, corrido 2 min de la de la 72404.
module.exports = {
  apps: [
    {
      name: "cocos-operaciones-3893",
      script: "operaciones.js",
      cwd: "/home/midas/workers/cocos-sync",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "2-59/5 10-17 * * 1-5",
      env: { COCOS_CUENTA: "3893", COCOS_CUENTA_MIDAS: "3893", COCOS_CRED_ENV: "/home/midas/workers/cocos-cuenta2/.env" },
      out_file: "logs/operaciones-3893-out.log",
      error_file: "logs/operaciones-3893-error.log",
      time: true,
    },
  ],
};
