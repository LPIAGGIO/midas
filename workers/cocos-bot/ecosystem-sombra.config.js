// PM2: instancia SOMBRA del bot de Cocos (sin filtro, sin órdenes reales).
// Corre en su propio directorio con su .env (COCOS_BOT_LIBRO=cocos_sombra).
module.exports = {
  apps: [
    {
      name: "cocos-sombra",
      script: "worker.js",
      cwd: "/home/midas/workers/cocos-sombra",
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
