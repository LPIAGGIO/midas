// Logger minimal sin dependencias. Output formato:
//   [2026-05-26T20:15:00.123Z] [INFO] mensaje aca {"extra":"data"}
//
// Niveles: error(0) < warn(1) < info(2) < debug(3).
// Se filtra por LOG_LEVEL del entorno.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 2;

function fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const m = typeof msg === "string" ? msg : JSON.stringify(msg);
  const extra = meta ? " " + JSON.stringify(meta) : "";
  return `[${ts}] [${level.toUpperCase()}] ${m}${extra}`;
}

function makeLogger(scope = null) {
  const prefix = scope ? `[${scope}] ` : "";
  return {
    error: (msg, meta) => CURRENT >= 0 && console.error(fmt("error", prefix + msg, meta)),
    warn:  (msg, meta) => CURRENT >= 1 && console.warn (fmt("warn",  prefix + msg, meta)),
    info:  (msg, meta) => CURRENT >= 2 && console.log  (fmt("info",  prefix + msg, meta)),
    debug: (msg, meta) => CURRENT >= 3 && console.log  (fmt("debug", prefix + msg, meta)),
    child: (childScope) => makeLogger(scope ? `${scope}/${childScope}` : childScope),
  };
}

module.exports = { logger: makeLogger(), makeLogger };
