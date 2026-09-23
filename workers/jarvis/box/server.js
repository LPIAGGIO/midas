/**
 * El cuerpo de Jarvis: servidor que le habla a la caja ESP32-S3.
 *
 * La caja corre el firmware xiaozhi (MIT) como driver — microfono, parlante,
 * pantalla y wake word — pero el cerebro es nuestro. El firmware habla un
 * protocolo WebSocket documentado (docs/websocket.md del repo 78/xiaozhi-esp32),
 * asi que NO usamos el backend de ellos: implementamos el protocolo y listo.
 *
 * DOS PUERTAS, y las dos son obligatorias:
 *
 *   POST /xiaozhi/ota/   La caja pega aca ANTES de conectarse a nada. Es la
 *                        unica URL que hay que compilar en el firmware; la
 *                        respuesta le dice a que WebSocket ir. Tambien le
 *                        pasamos la hora (por eso el RTC arranca en 1970) y la
 *                        version de firmware: hay que devolver LA MISMA que
 *                        reporta, o va a intentar actualizarse en un loop.
 *
 *   WS   /ws            El canal de la conversacion. JSON para el control
 *                        (hello, stt, llm, tts) y frames binarios Opus para el
 *                        audio en los dos sentidos.
 *
 * ESTADO: el canal, la pantalla y la cara andan. El AUDIO todavia no: los
 * frames Opus entran y se cuentan, pero no se decodifican. Eso es a proposito
 * — primero se valida que la caja conecta, muestra texto y cambia de humor;
 * meter STT y TTS antes de eso es depurar dos cosas a la vez.
 */

import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PUERTO = Number(process.env.JARVIS_BOX_PORT || 8098);
const HOST = process.env.JARVIS_BOX_HOST || "0.0.0.0";
/** Como se ve el servidor desde la caja. Tiene que ser la IP de la PC en la LAN. */
const PUBLICA = process.env.JARVIS_BOX_PUBLIC || null;
/** Tema de la pantalla que se le pide a la caja al conectar: "dark" | "light" | "" (no tocar). */
const TEMA = process.env.JARVIS_BOX_THEME ?? "dark";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------------------------------------------------------- OTA ---- */

function respuestaOta(body, req) {
  // La version que devolvemos DEBE coincidir con la que reporta la caja. Si
  // devolvemos una distinta sin una url valida, entra en loop de actualizacion.
  const version = body?.application?.version || "1.0.0";
  const host = PUBLICA || req.headers.host?.split(":")[0] || "127.0.0.1";

  return {
    // Sin esto el reloj se queda en 1970 y cualquier cosa con horarios miente.
    server_time: {
      timestamp: Date.now(),
      timezone_offset: -new Date().getTimezoneOffset(), // Argentina: -180
    },
    firmware: { version, url: "" },
    websocket: {
      url: `ws://${host}:${PUERTO}/ws`,
      // El firmware manda este token como Authorization: Bearer <token>.
      token: process.env.JARVIS_BOX_TOKEN || "jarvis",
    },
  };
}

const http = createServer((req, res) => {
  let cuerpo = "";
  req.on("data", (c) => { cuerpo += c; if (cuerpo.length > 1e6) req.destroy(); });
  req.on("end", () => {
    if (req.url?.startsWith("/xiaozhi/ota")) {
      let body = null;
      try { body = JSON.parse(cuerpo || "{}"); } catch { /* la caja a veces pega vacio */ }
      const mac = req.headers["device-id"] || "?";
      log(`OTA  mac=${mac} fw=${body?.application?.version || "?"} board=${body?.board?.type || "?"}`);
      const r = respuestaOta(body, req);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(r));
    }
    if (req.url === "/salud") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, sesiones: sesiones.size }));
    }
    res.writeHead(404).end("no");
  });
});

/* ----------------------------------------------------------- WebSocket ---- */

const wss = new WebSocketServer({ server: http, path: "/ws" });
const sesiones = new Map();

/** Manda un JSON de control a la caja, siempre con el session_id. */
function enviar(ws, obj) {
  const s = sesiones.get(ws);
  if (!s || ws.readyState !== ws.OPEN) return false;
  ws.send(JSON.stringify({ session_id: s.id, ...obj }));
  return true;
}

/**
 * Lo que ve y dice la caja. `emocion` cambia la carita: el firmware acepta
 * happy, sad, angry, surprised, thinking, neutral y varias mas.
 *
 * Sin audio todavia, `tts.sentence_start` es lo que pone el texto en pantalla,
 * asi que alcanza para validar toda la cadena de ida.
 */
export function decir(ws, texto, emocion = "neutral") {
  const s = sesiones.get(ws);
  if (!s) return;

  // Si ya habia una frase en curso, su `stop` pendiente cortaria esta a la
  // mitad. Se cancela antes de empezar la nueva: sin esto, dos `decir()`
  // seguidos mandan dos stop juntos y el segundo llega cuando la caja recien
  // empezo a hablar.
  if (s.stopPendiente) {
    clearTimeout(s.stopPendiente);
    s.stopPendiente = null;
    enviar(ws, { type: "tts", state: "stop" });
  }

  enviar(ws, { type: "llm", emotion: emocion, text: texto });
  enviar(ws, { type: "tts", state: "start" });
  enviar(ws, { type: "tts", state: "sentence_start", text: texto });

  // Sin frames de audio el estado "speaking" se cerraria de inmediato; damos
  // un respiro proporcional al largo para que el texto se llegue a leer.
  const ms = Math.min(6000, 1200 + texto.length * 55);
  s.stopPendiente = setTimeout(() => {
    s.stopPendiente = null;
    enviar(ws, { type: "tts", state: "stop" });
  }, ms);
}

wss.on("connection", (ws, req) => {
  const id = Math.random().toString(36).slice(2, 10);
  const mac = req.headers["device-id"] || "?";
  sesiones.set(ws, { id, mac, frames: 0, bytes: 0, escuchando: false });
  log(`WS   conectada  sesion=${id} mac=${mac}`);

  ws.on("message", (data, esBinario) => {
    const s = sesiones.get(ws);

    // Audio del microfono: Opus crudo. Todavia no lo decodificamos.
    if (esBinario) {
      s.frames++;
      s.bytes += data.length;
      if (s.frames % 50 === 0) log(`     audio sesion=${id} ${s.frames} frames / ${(s.bytes / 1024).toFixed(1)} KB`);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return log(`     json invalido de ${id}`); }

    switch (msg.type) {
      case "hello": {
        log(`     hello sesion=${id} audio=${JSON.stringify(msg.audio_params)} features=${JSON.stringify(msg.features || {})}`);
        // El device espera exactamente transport:"websocket" para dar por
        // abierto el canal de audio; sin eso se queda esperando y no habla.
        ws.send(JSON.stringify({
          type: "hello",
          transport: "websocket",
          session_id: id,
          audio_params: msg.audio_params || { format: "opus", sample_rate: 24000, channels: 1, frame_duration: 60 },
        }));
        // Tema OSCURO. El firmware arranca en tema claro (fondo blanco) y la cara
        // de particulas esta pensada para negro: la primera vez quedo un cuadrado
        // negro sobre blanco. La caja expone `self.screen.set_theme` por MCP y
        // Display::SetTheme lo persiste en NVS (display/theme), asi que alcanza
        // con pedirlo una vez; se repite en cada hello por si se reflasheo la NVS.
        if (msg.features?.mcp && TEMA) {
          enviar(ws, {
            type: "mcp",
            payload: { jsonrpc: "2.0", id: 1, method: "tools/call",
                       params: { name: "self.screen.set_theme", arguments: { theme: TEMA } } },
          });
        }
        decir(ws, "Good morning, sir.", "happy");
        break;
      }

      case "listen": {
        // start/stop del microfono, y `detect` cuando disparo el wake word.
        if (msg.state === "detect") {
          log(`     WAKE WORD sesion=${id} texto=${JSON.stringify(msg.text || "")}`);
          decir(ws, "Te escucho.", "thinking");
        } else {
          s.escuchando = msg.state === "start";
          log(`     listen=${msg.state} modo=${msg.mode || "-"} sesion=${id}`);
        }
        break;
      }

      case "abort":
        log(`     abort sesion=${id} motivo=${msg.reason || "-"}`);
        break;

      case "mcp": {
        // La caja expone SUS PROPIAS tools (volumen, pantalla, bateria) por
        // MCP. Aca despues se enchufan las skills de Jarvis. Si es una
        // RESPUESTA (sin method) mostramos result/error: asi se ve si el
        // set_theme del hello fue aceptado.
        const p = msg.payload || {};
        if (p.method) log(`     mcp sesion=${id} metodo=${p.method}`);
        else log(`     mcp sesion=${id} respuesta id=${p.id} ${p.error ? "ERROR " + JSON.stringify(p.error) : "result=" + JSON.stringify(p.result).slice(0, 120)}`);
        break;
      }

      default:
        log(`     ${msg.type} sesion=${id} ${JSON.stringify(msg).slice(0, 120)}`);
    }
  });

  ws.on("close", () => {
    const s = sesiones.get(ws);
    if (s?.stopPendiente) clearTimeout(s.stopPendiente);
    log(`WS   cerrada   sesion=${id} (${s?.frames || 0} frames de audio)`);
    sesiones.delete(ws);
  });
  ws.on("error", (e) => log(`WS   error sesion=${id}: ${e.message}`));
});

http.listen(PUERTO, HOST, () => {
  log(`Jarvis box escuchando en ${HOST}:${PUERTO}`);
  log(`  OTA para compilar en el firmware:  http://${PUBLICA || "<IP-DE-ESTA-PC>"}:${PUERTO}/xiaozhi/ota/`);
  if (!PUBLICA) log("  OJO: sin JARVIS_BOX_PUBLIC la url del websocket sale del header Host, que suele alcanzar.");
});
