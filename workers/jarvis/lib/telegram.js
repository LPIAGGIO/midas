/**
 * Cliente de Telegram para Jarvis.
 *
 * OJO: Jarvis usa su PROPIO bot (JARVIS_BOT_TOKEN), distinto del bot de alertas
 * de Midas (@midas_ar_BOT). Telegram entrega cada update una sola vez por token:
 * si dos procesos hacen getUpdates sobre el mismo token, se roban los mensajes
 * entre si. El worker telegram-notifier ya es duenio de ese long-poll.
 */

const TOKEN = process.env.JARVIS_BOT_TOKEN;
if (!TOKEN) throw new Error("Falta JARVIS_BOT_TOKEN en el .env");

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT_S = 50;

async function call(method, body) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

/** Telegram corta los mensajes en 4096 chars; parte por lineas para no romper el markdown. */
function chunk(text, size = 3800) {
  const out = [];
  let buf = "";
  for (const line of String(text).split("\n")) {
    if (buf.length + line.length + 1 > size) { out.push(buf); buf = ""; }
    if (line.length > size) {
      for (let i = 0; i < line.length; i += size) out.push(line.slice(i, i + size));
    } else {
      buf += (buf ? "\n" : "") + line;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [""];
}

export async function sendMessage(chatId, text, extra = {}) {
  const parts = chunk(text);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    // Los botones van solo en el ultimo pedazo.
    const payload = { chat_id: chatId, text: parts[i], ...(i === parts.length - 1 ? extra : {}) };
    try {
      last = await call("sendMessage", payload);
    } catch (e) {
      // Si falla el parseo de Markdown, reintenta en texto plano antes de perder el mensaje.
      if (payload.parse_mode) {
        delete payload.parse_mode;
        last = await call("sendMessage", payload);
      } else throw e;
    }
  }
  return last;
}

/** Mensaje de confirmacion con botones Aprobar / Rechazar / Siempre. */
export async function sendApproval(chatId, text, actionId, { allowAlways = true } = {}) {
  const row = [
    { text: "Aprobar", callback_data: `ok:${actionId}` },
    { text: "Rechazar", callback_data: `no:${actionId}` },
  ];
  const keyboard = [row];
  if (allowAlways) keyboard.push([{ text: "Aprobar y no preguntar mas por esto", callback_data: `always:${actionId}` }]);
  return sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard } });
}

export async function answerCallback(callbackId, text) {
  try { await call("answerCallbackQuery", { callback_query_id: callbackId, text: text?.slice(0, 200) }); }
  catch { /* no es fatal: el usuario ya vio el mensaje editado */ }
}

export async function editMessage(chatId, messageId, text) {
  try { await call("editMessageText", { chat_id: chatId, message_id: messageId, text }); }
  catch { /* el mensaje pudo haber sido borrado */ }
}

export async function sendChatAction(chatId, action = "typing") {
  try { await call("sendChatAction", { chat_id: chatId, action }); } catch { /* cosmetico */ }
}

/**
 * Long-poll de updates. Devuelve un async iterator infinito.
 * Arranca descartando el backlog para no procesar mensajes viejos tras un reinicio.
 */
export async function* pollUpdates({ signal } = {}) {
  let offset = 0;
  try {
    const backlog = await call("getUpdates", { timeout: 0, offset: -1 });
    if (backlog.length) offset = backlog[backlog.length - 1].update_id + 1;
  } catch { /* arranca en 0 */ }

  while (!signal?.aborted) {
    let updates = [];
    try {
      updates = await call("getUpdates", {
        timeout: POLL_TIMEOUT_S,
        offset,
        allowed_updates: ["message", "callback_query"],
      });
    } catch (e) {
      console.error("[telegram] getUpdates:", e.message);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      yield u;
    }
  }
}
