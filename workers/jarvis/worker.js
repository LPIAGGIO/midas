/**
 * Worker jarvis: asistente autonomo personal, siempre prendido.
 *
 * Arquitectura (ver README.md):
 *   - El CEREBRO vive aca, en el VPS. Es el Claude Agent SDK, o sea el mismo
 *     harness de Claude Code corriendo como servicio.
 *   - La MEMORIA vive en Supabase (tablas jarvis_*), con user_id desde el dia 1.
 *   - Los CLIENTES son intercambiables. v1 es Telegram; la web y el ESP32 se
 *     enchufan despues al mismo contrato sin tocar el cerebro.
 *
 * Toda accion con efecto pasa por propose -> confirm -> execute -> log.
 * Ver lib/policy.js: es el unico lugar donde se decide que se puede hacer solo.
 *
 * OJO: Jarvis usa su PROPIO bot de Telegram. El worker telegram-notifier ya es
 * duenio del long-poll de @midas_ar_BOT; dos pollers sobre el mismo token se
 * roban los mensajes.
 *
 * Env (.env): JARVIS_BOT_TOKEN, ANTHROPIC_API_KEY, SUPABASE_URL,
 *             SUPABASE_SERVICE_ROLE_KEY. Opcionales: JARVIS_MODEL,
 *             JARVIS_EFFORT, JARVIS_MAX_BUDGET_USD, JARVIS_DAILY_BUDGET_USD,
 *             JARVIS_WORKSPACE, JARVIS_DEBUG.
 */

import "dotenv/config";
import * as tg from "./lib/telegram.js";
import * as db from "./lib/db.js";
import { runTurn, resolveApproval } from "./lib/agent.js";

const RISK_LABEL = { read: "lectura", write: "escritura", money: "PLATA" };

/** Sin API key el canal igual funciona: se puede vincular y probar. */
const HAS_BRAIN = !!process.env.ANTHROPIC_API_KEY;

/** Un turno por usuario a la vez: evita que dos mensajes peleen por la sesion. */
const busy = new Set();

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || "").trim();
  if (!chatId || !text) return;

  // Vinculacion. Es lo unico que se atiende sin usuario resuelto.
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    if (!code) {
      return tg.sendMessage(chatId, "Para vincular tu cuenta abri Jarvis desde Midas y segui el link, o mandame /start <codigo>.");
    }
    const userId = await db.consumeLinkCode(code, "telegram", chatId);
    if (!userId) return tg.sendMessage(chatId, "Ese codigo no sirve o ya se uso. Genera uno nuevo desde Midas.");
    return tg.sendMessage(chatId, "Listo, quedaste vinculado. Preguntame lo que quieras.");
  }

  const userId = await db.findUserByChannel("telegram", chatId);
  if (!userId) {
    return tg.sendMessage(chatId, "No te tengo vinculado. Mandame /start <codigo> con el codigo que genera Midas.");
  }

  if (text === "/ping") return tg.sendMessage(chatId, "pong");
  if (text === "/help") {
    return tg.sendMessage(chatId,
      "Soy Jarvis. Escribime en criollo y me arreglo.\n\n" +
      "/nuevo - arranca una conversacion limpia (me olvido del hilo, no de tu memoria)\n" +
      "/gasto - cuanto llevo gastado hoy\n" +
      "/pendientes - acciones esperando tu confirmacion\n" +
      "/ping - test del canal");
  }

  const session = await db.getOrCreateSession(userId, "telegram", chatId);

  if (text === "/nuevo") {
    await db.closeSession(session.id);
    return tg.sendMessage(chatId, "Listo, arranco de cero. Tu memoria de largo plazo queda intacta.");
  }
  if (text === "/gasto") {
    const spent = await db.spentTodayUsd(userId);
    return tg.sendMessage(chatId, `Hoy llevo USD ${spent.toFixed(4)}.`);
  }
  if (text === "/pendientes") {
    const { data } = await db.supabase.from("jarvis_actions")
      .select("summary, risk, created_at").eq("user_id", userId)
      .eq("status", "pending").order("created_at", { ascending: false }).limit(10);
    if (!data?.length) return tg.sendMessage(chatId, "No hay nada esperando confirmacion.");
    return tg.sendMessage(chatId, "Pendientes:\n" + data.map((a) => `- [${RISK_LABEL[a.risk]}] ${a.summary}`).join("\n"));
  }

  if (!HAS_BRAIN) {
    return tg.sendMessage(chatId,
      "El canal anda (te tengo vinculado y te leo), pero todavia no tengo cerebro: " +
      "falta cargar ANTHROPIC_API_KEY en el .env del worker. Con eso reinicio y ya te contesto en serio.");
  }

  if (busy.has(userId)) {
    return tg.sendMessage(chatId, "Dame un segundo, estoy terminando lo anterior.");
  }
  busy.add(userId);

  const typing = setInterval(() => tg.sendChatAction(chatId, "typing"), 5000);
  tg.sendChatAction(chatId, "typing");

  try {
    await db.logMessage(userId, session.id, "user", text, "telegram");

    const result = await runTurn(
      {
        userId,
        sessionId: session.id,
        sdkSessionId: session.sdk_session_id,
        chatId,
        isNewSession: !session.last_seen_at || session.started_at === session.last_seen_at,
      },
      text,
      {
        onApprovalNeeded: async ({ actionId, risk, why, summary, allowAlways }) => {
          const head = risk === "money"
            ? "PEDIDO DE CONFIRMACION - MUEVE PLATA"
            : "Pedido de confirmacion";
          await tg.sendApproval(
            chatId,
            `${head}\n\nQuiero ${summary}\n\nMotivo del pedido: ${why}.`,
            actionId,
            { allowAlways },
          );
        },
      },
    );

    await db.touchSession(session.id);

    const out = result.text || "(no devolvi texto; mira /pendientes por si quedo algo esperando confirmacion)";
    await tg.sendMessage(chatId, out);
    await db.logMessage(userId, session.id, "assistant", out, "telegram", result.costUsd);
  } catch (e) {
    console.error("[jarvis] turno fallido:", e);
    await tg.sendMessage(chatId, `Me colgue procesando eso: ${e.message}`);
  } finally {
    clearInterval(typing);
    busy.delete(userId);
  }
}

async function handleCallback(cb) {
  const [verb, actionId] = String(cb.data || "").split(":");
  const chatId = cb.message?.chat?.id;
  if (!verb || !actionId) return;

  const userId = await db.findUserByChannel("telegram", chatId);
  const action = await db.getAction(actionId);

  // Chequeo de propiedad: nadie decide sobre acciones de otro.
  if (!action || !userId || action.user_id !== userId) {
    return tg.answerCallback(cb.id, "Esa accion no es tuya o ya no existe.");
  }
  if (action.status !== "pending") {
    await tg.answerCallback(cb.id, `Ya estaba ${action.status}.`);
    return tg.editMessage(chatId, cb.message.message_id, `${cb.message.text}\n\n--> ya resuelta (${action.status})`);
  }

  const approved = verb === "ok" || verb === "always";

  if (verb === "always") {
    if (action.risk === "money") {
      await tg.answerCallback(cb.id, "Lo que mueve plata no se puede automatizar.");
      return;
    }
    await db.supabase.from("jarvis_allowlist").upsert(
      { user_id: userId, tool_name: action.tool_name, input_matcher: null, reason: `graduada desde ${action.id}`, approved_count: 1 },
      { onConflict: "user_id,tool_name,input_matcher" },
    );
  }

  const ok = resolveApproval(actionId, approved, "user");
  if (!ok) {
    // El turno ya murio (reinicio del worker, timeout). No queda nada a que responder.
    await db.decideAction(actionId, approved ? "approved" : "denied", "user");
    await tg.answerCallback(cb.id, "Llego tarde: ese turno ya termino.");
    return tg.editMessage(chatId, cb.message.message_id, `${cb.message.text}\n\n--> llego tarde, el turno ya habia terminado`);
  }

  const label = verb === "always" ? "aprobada y agregada a la allowlist" : approved ? "aprobada" : "rechazada";
  await tg.answerCallback(cb.id, label);
  await tg.editMessage(chatId, cb.message.message_id, `${cb.message.text}\n\n--> ${label}`);
}

async function main() {
  for (const k of ["JARVIS_BOT_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[k]) { console.error(`Falta ${k} en el .env`); process.exit(1); }
  }
  // Sin cerebro el canal igual sirve: se puede vincular y probar Telegram.
  // Degrada explicito en vez de no arrancar.
  if (!HAS_BRAIN) {
    console.warn("[jarvis] SIN ANTHROPIC_API_KEY: el canal anda, el cerebro no. Cargala en el .env y reinicia.");
  }
  console.log("[jarvis] arriba. modelo:", process.env.JARVIS_MODEL || "claude-opus-5");

  // Limpieza de pendientes viejas al arrancar (reinicios dejan colgados).
  await db.expireStaleActions(60 * 60 * 1000).catch((e) => console.error("[jarvis] expire:", e.message));
  setInterval(() => db.expireStaleActions(60 * 60 * 1000).catch(() => {}), 15 * 60 * 1000);

  for await (const u of tg.pollUpdates()) {
    try {
      if (u.message) await handleMessage(u.message);
      else if (u.callback_query) await handleCallback(u.callback_query);
    } catch (e) {
      console.error("[jarvis] update:", e);
    }
  }
}

main().catch((e) => { console.error("[jarvis] fatal:", e); process.exit(1); });
