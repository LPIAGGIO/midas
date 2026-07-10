// Entry point del worker mtr-market-data.
//
// Composicion:
//   1. Carga .env (Supabase URL + service role key + overrides opcionales).
//   2. Crea SupabaseSink y lo arranca (timer de flush).
//   3. Crea PrimaryWsClient con callback que tira ticks al sink.
//   4. Maneja SIGTERM/SIGINT: flushea pendientes y cierra WS limpio.

require("dotenv").config();

const { SupabaseSink } = require("./supabaseSink");
const { PrimaryWsClient } = require("./primaryWs");
const { getSymbolsToSubscribe } = require("./symbolsRegistry");
const { logger } = require("./logger");

function readIntEnv(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    logger.error("SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY obligatorios. Abortando.");
    process.exit(1);
  }

  const flushIntervalMs = readIntEnv("FLUSH_INTERVAL_MS", 2000);
  const pingIntervalMs = readIntEnv("PING_INTERVAL_MS", 40_000);
  const idleTimeoutMs = readIntEnv("WS_IDLE_TIMEOUT_MS", 90_000);
  const wsUrl = process.env.PRIMARY_WS_URL;
  const wsOrigin = process.env.PRIMARY_ORIGIN;

  const symbols = getSymbolsToSubscribe();
  logger.info("arrancando mtr-market-data", {
    symbolsCount: symbols.length,
    flushIntervalMs,
    pingIntervalMs,
    idleTimeoutMs,
  });

  const sink = new SupabaseSink({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
    flushIntervalMs,
  });
  sink.start();

  const wsClient = new PrimaryWsClient({
    url: wsUrl,
    origin: wsOrigin,
    symbols,
    onTick: (tick) => sink.ingest(tick),
    pingIntervalMs,
    idleTimeoutMs,
  });
  wsClient.start();

  // Shutdown handler. PM2 manda SIGINT en restart/stop. kill_timeout en
  // ecosystem.config.js da 5s antes de SIGKILL, suficiente para un flush
  // final y un close del WS.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutdown: senal ${signal} recibida, cerrando ordenadamente`);
    try {
      await wsClient.stop();
      await sink.stop();
    } catch (err) {
      logger.error("error durante shutdown", { error: err.message });
    }
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Catch-all para errores no manejados. Loggea y deja que PM2 reinicie.
  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", { error: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { reason: String(reason) });
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error("main fallo", { error: err.message, stack: err.stack });
  process.exit(1);
});
