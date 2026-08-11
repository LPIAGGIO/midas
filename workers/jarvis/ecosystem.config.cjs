module.exports = {
  apps: [
    {
      name: "jarvis",
      script: "worker.js",
      // Servicio permanente: mantiene abierto el long-poll de su propio bot.
      autorestart: true,
      instances: 1,
      exec_mode: "fork",
      // El VPS tiene ~2GB. El Agent SDK levanta un subproceso por turno, asi
      // que el techo es mas alto que el de los otros workers, pero acotado
      // para que un cuelgue no se lleve puesto a mtr-market-data.
      max_memory_restart: "500M",
      env: { NODE_ENV: "production" },
    },
  ],
};
