module.exports = {
  apps: [{
    name: "price-cache",
    script: "./worker.js",
    // Cron: cada minuto, lun-vie 10:00-17:59 ART (mercado abierto AR).
    // El timezone lo toma del sistema (VPS ya está en America/Argentina/Buenos_Aires).
    // El worker valida internamente con isMarketWindow() como defensa
    // en profundidad por si el cron pifia.
    cron_restart: "* 10-17 * * 1-5",
    autorestart: false,
    instances: 1,
    max_memory_restart: "200M",
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    merge_logs: true,
    time: true,
  }],
};
