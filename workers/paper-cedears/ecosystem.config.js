// PM2 ecosystem para paper-cedears (one-shot + cron diario). Corre 02:00 UTC:
// el cierre de NYSE del día hábil ya está disponible en Yahoo. autorestart
// false (one-shot, queda "stopped" entre corridas).
module.exports = {
  apps: [
    {
      name: "paper-cedears",
      script: "./worker.js",
      cwd: "/home/midas/workers/paper-cedears",
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
