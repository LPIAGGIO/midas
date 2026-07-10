module.exports = {
  apps: [
    {
      name: "iol-positions-sync",
      script: "worker.js",
      cwd: "/home/midas/workers/iol-positions-sync",
      exec_mode: "fork",
      autorestart: false,
      cron_restart: "*/30 * * * *",
      out_file: "/home/midas/workers/iol-positions-sync/out.log",
      error_file: "/home/midas/workers/iol-positions-sync/err.log",
      time: true,
    },
  ],
};
