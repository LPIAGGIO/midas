module.exports = {
  apps: [
    {
      name: "fundamentals-snapshot",
      script: "worker.js",
      // DIARIO de lunes a viernes, 07:00 ART (antes de que abra el mercado
      // local; los multiplos reflejan el cierre anterior de Wall Street).
      // Antes era quincenal (dias 1 y 15) con el argumento de que los
      // fundamentals cambian por trimestre — pero el 11/08/2026 quedo claro
      // que no alcanza: SNDK reporto el 5/8 y el snapshot del 1/8 seguia
      // mostrando crecimiento 251% cuando el real ya era 372%, margen 34% vs
      // 56%. Ademas ahora acumulamos historia (fundamentals_history) y la
      // granularidad diaria es la que permite calcular percentiles propios
      // de cada multiplo. Sabados y domingos se saltean: sin rueda no hay
      // dato nuevo, solo filas repetidas del viernes.
      // El worker corre, hace el upsert y sale; PM2 lo revive la proxima
      // corrida. TZ del VPS = America/Argentina.
      cron_restart: "0 7 * * 1-5",
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "200M",
    },
  ],
};
