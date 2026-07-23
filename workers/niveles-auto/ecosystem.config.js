module.exports = {
  apps: [
    {
      name: "niveles-auto",
      script: "worker.js",
      // Servicio PERSISTENTE: procesa la cola manual cada 60s las 24hs (un
      // análisis pedido un domingo sale en <1 min) y escanea posiciones
      // nuevas cada 5 min solo en ventana de mercado (lun-vie 10-19 ART,
      // gateado dentro del worker).
      autorestart: true,
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "250M",
    },
  ],
};
