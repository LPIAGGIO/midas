// PM2 ecosystem para paper-trader (one-shot + cron diario, como
// futures-settlement). Corre 1x/día a las 02:00 UTC: el OHLC diario de
// Kraken del día anterior ya cerró (00:00 UTC). autorestart:false → queda
// "stopped" entre corridas (normal). El --init se corre a mano una vez.
module.exports = {
  apps: [
    {
      name: "paper-trader",
      script: "./worker.js",
      cwd: "/home/midas/workers/paper-trader",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "0 2 * * *",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
