// Tres corridas del mismo worker. El VPS está en hora argentina.
const base = (name, args, cron) => ({
  name,
  script: "worker.js",
  args,
  cwd: "/home/midas/workers/fondos",
  exec_mode: "fork",
  autorestart: false,
  cron_restart: cron,
  out_file: `/home/midas/workers/fondos/${name}.log`,
  error_file: `/home/midas/workers/fondos/${name}.err.log`,
  time: true,
});

module.exports = {
  apps: [
    // Composición: SSGA publica el archivo del día anterior a la mañana; el
    // N-PORT solo se baja si cambió el accession.
    base("fondos-holdings", "--holdings", "30 7 * * *"),
    // Perfil y ratios antes de la apertura de BYMA (10:30): cierres de la misma rueda.
    base("fondos-perfil", "--perfil", "15 8 * * 1-5"),
    // CUSIP y sector de los subyacentes, una vez por mes.
    base("fondos-maestro", "--maestro", "0 6 1 * *"),
  ],
};
