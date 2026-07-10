// PM2 ecosystem para el worker mtr-market-data.
//
// PATRON DISTINTO al resto de tus workers (futures-settlement, mae-boletin, etc).
// Esos son "one-shot programado" (autorestart:false + cron_restart).
// Este es SERVICIO PERMANENTE:
//   - fork mode, 1 instancia (NUNCA cluster: duplicaria el WS y Primary cortaria)
//   - autorestart: true  -> si crashea, PM2 lo levanta
//   - max_memory_restart: '200M' -> safety net por memory leaks
//   - sin cron_restart -> queremos uptime continuo
//
// Arrancar:   pm2 start ecosystem.config.js
// Guardar:    pm2 save
// Ver logs:   pm2 logs mtr-market-data
// Reiniciar:  pm2 restart mtr-market-data

module.exports = {
  apps: [
    {
      name: "mtr-market-data",
      script: "src/index.js",
      cwd: "/home/midas/workers/mtr-market-data",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "200M",
      kill_timeout: 5000, // 5s para que el shutdown limpio mande SIGTERM al WS
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
      env: {
        NODE_ENV: "production",
        LOG_LEVEL: "info",
      },
    },
  ],
};
