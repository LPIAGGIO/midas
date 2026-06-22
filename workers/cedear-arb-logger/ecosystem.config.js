// PM2 ecosystem para cedear-arb-logger.
// A DIFERENCIA de los otros workers (one-shot + cron_restart), este es
// LONG-RUNNING con autorestart: samplea cada 60s y se auto-gatea por
// horario (ventana 11:00-17:15 ART lun-vie) adentro del worker. El
// sampling intradia de alta frecuencia pide un proceso vivo, no un
// reinicio por minuto.
module.exports = {
  apps: [
    {
      name: "cedear-arb-logger",
      script: "./worker.js",
      cwd: "/home/midas/workers/cedear-arb-logger",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
