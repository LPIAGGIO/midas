// Sink que recibe ticks parseados y los persiste en Supabase con throttle.
//
// Disenio:
//   - Buffer en memoria: Map<securityId, lastTick>. Cada tick nuevo sobrescribe
//     al anterior del mismo simbolo. Solo importa el ULTIMO de cada uno.
//   - Timer cada FLUSH_INTERVAL_MS (default 2000): si el buffer tiene cambios,
//     hace UN upsert batched con todas las filas que cambiaron desde el ultimo
//     flush. Vacia el buffer.
//   - Si el upsert falla: log error, deja el buffer intacto, reintenta al
//     proximo tick del timer (no perdida de datos).
//
// Idempotente. Multiples ticks del mismo simbolo en la ventana de 2s
// resultan en un solo upsert con el ultimo estado.

const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");
const { makeLogger } = require("./logger");
const { getSymbolMeta } = require("./symbolsRegistry");

const TABLE = "mtr_market_data";

class SupabaseSink {
  constructor({
    supabaseUrl,
    supabaseKey,
    flushIntervalMs = 2000,
    logger = makeLogger("sink"),
  }) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("SupabaseSink: supabaseUrl y supabaseKey son obligatorios");
    }
    this.supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { transport: WebSocket },
    });
    this.flushIntervalMs = flushIntervalMs;
    this.logger = logger;

    /** @type {Map<string, object>} buffer de filas a escribir */
    this.buffer = new Map();
    this.flushTimer = null;
    this.started = false;

    // Stats acumulados para log periodico
    this.stats = { ticksReceived: 0, flushes: 0, rowsUpserted: 0, errors: 0 };
    this.statsTimer = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.flushTimer = setInterval(() => this._flush(), this.flushIntervalMs);
    this.statsTimer = setInterval(() => this._logStats(), 60_000);
    this.logger.info("sink iniciado", {
      flushIntervalMs: this.flushIntervalMs,
      table: TABLE,
    });
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.flushTimer);
    clearInterval(this.statsTimer);
    // Flush final para no perder ticks pendientes.
    await this._flush();
    this.logger.info("sink detenido", this.stats);
  }

  /**
   * Recibe un MarketDataTick parseado y lo agrega al buffer.
   * El upsert lo hace el timer.
   */
  ingest(tick) {
    if (!tick || !tick.securityId) return;
    this.stats.ticksReceived++;
    this.buffer.set(tick.securityId, this._tickToRow(tick));
  }

  /**
   * Transforma el shape del parser al shape de la tabla Supabase.
   * Los nombres de columna usan snake_case (convencion Postgres).
   */
  _tickToRow(tick) {
    const meta = getSymbolMeta(tick.securityId) || {};
    return {
      security_id: tick.securityId,
      symbol: meta.symbol || tick.securityId,
      segment: meta.segment || this._segmentFromId(tick.securityId),
      seq: tick.seq,
      bid: tick.bid,
      bid_size: tick.bidSize,
      ask: tick.ask,
      ask_size: tick.askSize,
      last: tick.last,
      last_ts: tick.lastTs,
      open: tick.open,
      high: tick.high,
      low: tick.low,
      close: tick.close,
      close_ts: tick.closeTs,
      settlement: tick.settlement,
      settlement_ts: tick.settlementTs,
      reference: tick.reference,
      reference_ts: tick.referenceTs,
      volume: tick.volume,
      volume_nominal: tick.volumeNominal,
      volume_effective: tick.volumeEffective,
      open_interest: tick.openInterest,
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Extrae el segmento desde el securityId. Format: "rx_DDF_DLR_JUN26" -> "rx_DDF".
   */
  _segmentFromId(securityId) {
    const parts = securityId.split("_");
    return parts.length >= 2 ? `${parts[0]}_${parts[1]}` : "unknown";
  }

  async _flush() {
    if (this.buffer.size === 0) return;

    const rows = Array.from(this.buffer.values());
    // Limpio el buffer ANTES del upsert. Si falla, los proximos ticks
    // van a regenerar las filas con datos mas frescos (no perdida).
    this.buffer.clear();

    try {
      const { error } = await this.supabase
        .from(TABLE)
        .upsert(rows, { onConflict: "security_id" });

      if (error) {
        this.stats.errors++;
        this.logger.error("upsert fallo", {
          message: error.message,
          code: error.code,
          rowsCount: rows.length,
        });
      } else {
        this.stats.flushes++;
        this.stats.rowsUpserted += rows.length;
        this.logger.debug("flush ok", { rows: rows.length });
      }
    } catch (err) {
      this.stats.errors++;
      this.logger.error("upsert exception", { error: err.message });
    }
  }

  _logStats() {
    this.logger.info("stats", { ...this.stats, bufferSize: this.buffer.size });
  }
}

module.exports = { SupabaseSink };
