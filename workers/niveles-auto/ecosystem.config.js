module.exports = {
  apps: [
    {
      name: "niveles-auto",
      script: "worker.js",
      // Cada 5 min, lun-vie, 10:00-18:55 ART (cubre pre-apertura BYMA, rueda
      // local y cierre de NY). One-shot: corre, procesa la cola y sale.
      cron_restart: "*/5 10-18 * * 1-5",
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "200M",
    },
  ],
};
