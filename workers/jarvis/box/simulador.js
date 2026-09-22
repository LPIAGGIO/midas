/**
 * Se hace pasar por la caja: repite el handshake y los mensajes que manda el
 * firmware xiaozhi, para poder probar el servidor SIN el hardware.
 *
 * Sirve para dos cosas distintas: validar el servidor antes de flashear, y
 * despues, cuando la caja real falle, saber de que lado esta el problema.
 *
 *   node box/simulador.js                 -> contra localhost
 *   node box/simulador.js 192.168.0.50    -> contra otra maquina
 */

import { WebSocket } from "ws";

const host = process.argv[2] || "127.0.0.1";
const puerto = process.env.JARVIS_BOX_PORT || 8098;
const MAC = "aa:bb:cc:dd:ee:ff";

const log = (...a) => console.log("  [caja]", ...a);

// 1) Lo primero que hace el firmware: pedir su configuracion al OTA.
const ota = await fetch(`http://${host}:${puerto}/xiaozhi/ota/`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Device-Id": MAC, "Client-Id": "sim" },
  body: JSON.stringify({
    application: { version: "1.0.0" },
    board: { type: "esp32-s3-touch-lcd-1.85c", mac: MAC },
  }),
}).then((r) => r.json());

log("OTA respondio:", JSON.stringify(ota));
if (!ota.websocket?.url) { console.error("  SIN websocket.url -> la caja no sabria a donde ir"); process.exit(1); }

const hora = new Date(ota.server_time.timestamp);
log(`hora recibida: ${hora.toISOString()} (offset ${ota.server_time.timezone_offset} min)`);

// 2) Conectar al websocket que indico el OTA.
const ws = new WebSocket(ota.websocket.url, {
  headers: {
    Authorization: `Bearer ${ota.websocket.token || ""}`,
    "Protocol-Version": "1",
    "Device-Id": MAC,
    "Client-Id": "sim",
  },
});

ws.on("open", () => {
  log("websocket abierto, mando hello");
  ws.send(JSON.stringify({
    type: "hello",
    version: 1,
    features: { mcp: true, aec: true },
    transport: "websocket",
    audio_params: { format: "opus", sample_rate: 24000, channels: 1, frame_duration: 60 },
  }));
});

let saludado = false;
ws.on("message", (d) => {
  const m = JSON.parse(d.toString());
  log("<-", JSON.stringify(m));

  if (m.type === "hello" && !saludado) {
    saludado = true;
    setTimeout(() => {
      log("-> simulo el wake word");
      ws.send(JSON.stringify({ type: "listen", state: "detect", text: "Jarvis" }));

      setTimeout(() => {
        log("-> simulo 10 frames de audio (bytes cualquiera, solo para el canal)");
        ws.send(JSON.stringify({ type: "listen", state: "start", mode: "auto" }));
        for (let i = 0; i < 10; i++) ws.send(Buffer.alloc(120, i));
        ws.send(JSON.stringify({ type: "listen", state: "stop" }));
        setTimeout(() => { log("listo, cierro"); ws.close(); }, 1500);
      }, 2500);
    }, 500);
  }
});

ws.on("close", () => { log("cerrado"); process.exit(0); });
ws.on("error", (e) => { console.error("  ERROR:", e.message); process.exit(1); });
