// PM2 para trade-counterfactual (one-shot + cron diario). Corre 23:30 ART
// lun-sab: el cierre de EE.UU. del dia ya esta en Yahoo. autorestart false
// (one-shot, queda "stopped" entre corridas, como el resto de los cron).
module.exports = {
  apps: [
    {
      name: "trade-counterfactual",
      script: "./worker.js",
      cwd: "/home/midas/workers/trade-counterfactual",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "30 23 * * 1-6",
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
