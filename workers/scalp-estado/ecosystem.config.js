// PM2: publica el estado de los bots de scalping para la pantalla de Midas.
// Solo lectura sobre los bots; proceso persistente.
module.exports = {
  apps: [{
    name: "scalp-estado", script: "worker.js", cwd: "/home/midas/workers/scalp-estado",
    exec_mode: "fork", instances: 1, autorestart: true, max_memory_restart: "200M",
    out_file: "logs/out.log", error_file: "logs/error.log", time: true,
  }],
};
