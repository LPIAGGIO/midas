module.exports = {
  apps: [
    {
      name: "earnings-calendar",
      script: "worker.js",
      // 07:15 ART lun-vie: antes de que abra el mercado local, para que el
      // aviso llegue cuando todavia se puede decidir algo. El domingo no
      // aporta (las fechas no cambian) y el sabado tampoco.
      cron_restart: "15 7 * * 1-5",
      autorestart: false,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "200M",
    },
  ],
};
