module.exports = {
  apps: [
    {
      name: "bond-emissions-sync",
      script: "worker.js",
      cwd: "/home/midas/workers/bond-emissions-sync",
      exec_mode: "fork",
      autorestart: false,
      // Mi/Ju 17:00 UTC = 14 hs ART. Las licitaciones del Tesoro son
      // tipicamente miercoles a la tarde; el articulo aparece esa noche
      // o jueves a la manana. Doble corrida para no perder ninguno.
      cron_restart: "0 17 * * 3,4",
      out_file: "/home/midas/workers/bond-emissions-sync/out.log",
      error_file: "/home/midas/workers/bond-emissions-sync/err.log",
      time: true,
    },
  ],
};
