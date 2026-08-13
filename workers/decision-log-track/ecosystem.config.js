module.exports = {
  apps: [
    {
      name: "decision-log-track",
      script: "worker.js",
      // 22:30 ART todos los dias: Wall Street ya cerro (18:00 ART) y el cierre
      // del dia esta consolidado en Yahoo. Corre de lunes a sabado — el sabado
      // sirve para recoger el cierre del viernes si el jueves quedo algo a
      // medias; el domingo no hay nada nuevo que medir.
      cron_restart: "30 22 * * 1-6",
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "200M",
    },
  ],
};
