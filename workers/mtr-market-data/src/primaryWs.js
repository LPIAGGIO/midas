// Cliente WS contra matbarofex.primary.ventures.
//
// Responsabilidades:
//   1. Mantener UNA conexion abierta.
//   2. Suscribir todos los symbols en el onopen con un solo mensaje.
//   3. Recibir mensajes, parsearlos via tickParser, despachar a un callback.
//   4. Mandar "ping" string al server cada PING_INTERVAL_MS para keep-alive.
//   5. Watchdog: si el server no manda NADA por WS_IDLE_TIMEOUT_MS, cerrar
//      y reconectar (probablemente conexion zombie).
//   6. Reconnect con backoff exponencial cuando se cae.
//
// EVENTOS DEL WS (segun los frames observados):
//   - JSON object: subscription/control (ej. {_req:"S",topicType:"md",topics:[...]})
//     -> emitido por NOSOTROS, no recibimos eco.
//   - "M:rx_DDF_DLR_JUN26|..."  -> MarketDataTick suelto
//   - "[\"M:...\",\"M:...\"]" -> batch de ticks
//   - "X:{\"d\":...,\"t\":\"clock\"}" -> GlobalTick (clock/fixstatus)
//   - "pong" -> respuesta al ping
//   - "[]" -> heartbeat del server (batch vacio)

const WebSocket = require("ws");
const { parseFrame } = require("./tickParser");
const { buildTopics } = require("./symbolsRegistry");
const { makeLogger } = require("./logger");

const DEFAULT_URL = "wss://matbarofex.primary.ventures/ws?session_id=&conn_id=";
const DEFAULT_ORIGIN = "https://matbarofex.primary.ventures";

class PrimaryWsClient {
  constructor({
    url = DEFAULT_URL,
    origin = DEFAULT_ORIGIN,
    symbols,
    onTick,
    pingIntervalMs = 40_000,
    idleTimeoutMs = 90_000,
    logger = makeLogger("ws"),
  }) {
    if (!symbols || !symbols.length) {
      throw new Error("PrimaryWsClient: symbols obligatorio y no vacio");
    }
    if (typeof onTick !== "function") {
      throw new Error("PrimaryWsClient: onTick callback obligatorio");
    }

    this.url = url;
    this.origin = origin;
    this.symbols = symbols;
    this.onTick = onTick;
    this.pingIntervalMs = pingIntervalMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.logger = logger;

    this.ws = null;
    this.shouldRun = false;
    this.reconnectAttempts = 0;
    this.pingTimer = null;
    this.idleTimer = null;
    this.lastMessageAt = 0;
  }

  start() {
    this.shouldRun = true;
    this._connect();
  }

  async stop() {
    this.shouldRun = false;
    this._clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, "shutdown");
      } catch (_) {}
      this.ws = null;
    }
    this.logger.info("ws cliente detenido");
  }

  _connect() {
    if (!this.shouldRun) return;

    this.logger.info("conectando", { url: this.url, attempt: this.reconnectAttempts });

    let ws;
    try {
      ws = new WebSocket(this.url, {
        // Origin obligatorio: Primary lo valida (CORS server-side).
        origin: this.origin,
        handshakeTimeout: 15_000,
      });
    } catch (err) {
      this.logger.error("ws constructor fallo", { error: err.message });
      this._scheduleReconnect();
      return;
    }

    this.ws = ws;
    this.lastMessageAt = Date.now();

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.logger.info("ws abierto");
      this._subscribe();
      this._startPing();
      this._startIdleWatchdog();
    });

    ws.on("message", (data, isBinary) => {
      this.lastMessageAt = Date.now();
      if (isBinary) {
        this.logger.warn("frame binario inesperado, ignorando");
        return;
      }
      this._handleFrame(data.toString("utf8"));
    });

    ws.on("close", (code, reason) => {
      this.logger.warn("ws cerrado", {
        code,
        reason: reason ? reason.toString("utf8") : "",
      });
      this._clearTimers();
      this.ws = null;
      if (this.shouldRun) this._scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.logger.error("ws error", { error: err.message });
      // 'close' se va a disparar tambien, el reconnect se maneja ahi.
    });
  }

  _subscribe() {
    const topics = buildTopics(this.symbols);
    // replace:true en el primer mensaje. Si el WS tenia subs anteriores
    // (caso reconnect), las pisa con las nuestras. Sino, no afecta.
    const msg = {
      _req: "S",
      topicType: "md",
      topics,
      replace: true,
    };
    try {
      this.ws.send(JSON.stringify(msg));
      this.logger.info("suscripto a topics", { count: topics.length });
    } catch (err) {
      this.logger.error("send subscribe fallo", { error: err.message });
    }
  }

  _handleFrame(raw) {
    let events;
    try {
      events = parseFrame(raw);
    } catch (err) {
      this.logger.warn("parseFrame fallo", { error: err.message, sample: raw.substring(0, 100) });
      return;
    }

    for (const ev of events) {
      switch (ev.kind) {
        case "md":
        case "closing":
          if (ev.data && ev.complete) {
            this.onTick(ev.data);
          } else if (ev.data && !ev.complete) {
            // Tick truncado / segmento inesperado. Log periodico, no spam.
            this.logger.debug("tick incompleto, no propagado", {
              securityId: ev.data.securityId,
            });
          }
          break;
        case "global":
          // clock/fixstatus/etc. No los persistimos, pero podria loggearse
          // el estado del fix gateway una vez.
          if (ev.data?.t === "fixstatus") {
            this.logger.info("fix status", ev.data.d);
          }
          break;
        case "pong":
        case "empty":
          // Keep-alive del server. Nada que hacer (lastMessageAt ya se actualizo).
          break;
        case "book":
          // No suscribimos book por ahora. Ignorar.
          break;
        case "unknown":
          this.logger.warn("frame desconocido", { sample: ev.raw?.substring(0, 100) });
          break;
      }
    }
  }

  _startPing() {
    this._clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send("ping");
        } catch (err) {
          this.logger.warn("ping send fallo", { error: err.message });
        }
      }
    }, this.pingIntervalMs);
  }

  _startIdleWatchdog() {
    this._clearIdle();
    // Chequeo cada 10s si el server quedo silencioso. Tiempo limite configurable.
    this.idleTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastMessageAt;
      if (idleMs > this.idleTimeoutMs) {
        this.logger.warn("idle timeout, forzando reconnect", { idleMs });
        if (this.ws) {
          try {
            this.ws.terminate(); // close abrupto, dispara 'close' y reconnect
          } catch (_) {}
        }
      }
    }, 10_000);
  }

  _clearPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _clearIdle() {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  _clearTimers() {
    this._clearPing();
    this._clearIdle();
  }

  _scheduleReconnect() {
    if (!this.shouldRun) return;
    // Backoff exponencial: 1s, 2s, 4s, 8s, 16s, 32s, cap en 60s.
    const delayMs = Math.min(60_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    this.logger.info("reconectando", { delayMs, nextAttempt: this.reconnectAttempts });
    setTimeout(() => this._connect(), delayMs);
  }
}

module.exports = { PrimaryWsClient };
