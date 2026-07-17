module.exports = {
  apps: [
    {
      name: "fundamentals-snapshot",
      script: "worker.js",
      // Los fundamentals cambian por trimestre (earnings); quincenal alcanza y
      // sobra. Dias 1 y 15 a las 07:00 ART, antes de que abra el mercado local.
      // El worker corre, hace el upsert y sale; PM2 lo revive la proxima corrida.
      // TZ del VPS = America/Argentina.
      cron_restart: "0 7 1,15 * *",
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "200M",
    },
  ],
};
