/**
 * El cerebro. Envuelve el Claude Agent SDK (el mismo harness de Claude Code)
 * con la politica de permisos de Jarvis.
 *
 * La pieza clave es `canUseTool`: el SDK lo llama ANTES de ejecutar cualquier
 * herramienta que no este auto-aprobada. Ahi enganchamos el patron
 * propose -> confirm -> execute -> log:
 *
 *   1. clasificar     (lib/policy.js)
 *   2. auto / deny    -> se resuelve sin molestar al usuario
 *   3. confirm        -> se graba la accion pendiente, se manda el mensaje con
 *                        botones, y esta promesa queda esperando la decision
 *   4. se registra el desenlace en jarvis_actions pase lo que pase
 *
 * Si el usuario no contesta dentro de APPROVAL_TIMEOUT_MS, se deniega. El
 * default de un timeout es NO ejecutar.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { classify, matchesAllowlist, describeAction } from "./policy.js";
import * as db from "./db.js";

const MODEL = process.env.JARVIS_MODEL || "claude-opus-5";
const EFFORT = process.env.JARVIS_EFFORT || "medium";
const MAX_TURNS = Number(process.env.JARVIS_MAX_TURNS || 40);
const MAX_BUDGET_USD = Number(process.env.JARVIS_MAX_BUDGET_USD || 1.0);
const DAILY_BUDGET_USD = Number(process.env.JARVIS_DAILY_BUDGET_USD || 10);
const APPROVAL_TIMEOUT_MS = Number(process.env.JARVIS_APPROVAL_TIMEOUT_MS || 10 * 60 * 1000);
const WORKSPACE = process.env.JARVIS_WORKSPACE || process.cwd();

/** Aprobaciones en vuelo: actionId -> resolve(). El worker las resuelve al llegar el callback. */
const pending = new Map();

/** Llamado desde worker.js cuando el usuario aprieta un boton. */
export function resolveApproval(actionId, approved, decidedBy = "user") {
  const entry = pending.get(actionId);
  if (!entry) return false;
  pending.delete(actionId);
  clearTimeout(entry.timer);
  entry.resolve({ approved, decidedBy });
  return true;
}

export function hasPending(actionId) {
  return pending.has(actionId);
}

function waitForApproval(actionId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(actionId);
      resolve({ approved: false, decidedBy: "timeout" });
    }, APPROVAL_TIMEOUT_MS);
    pending.set(actionId, { resolve, timer });
  });
}

const SYSTEM_PROMPT = `
Sos Jarvis, el asistente personal de Leonardo Piaggio (LP). Corres 24/7 en su
servidor y te habla por Telegram desde el celular.

Quien es LP: economista, sabe finanzas a fondo (TIR, TEA, basis, carry,
sinteticos). Lee codigo, SQL e infra pero no es programador full-time.

Como te queres comunicar:
- Castellano rioplatense (vos, dale, fijate). Markdown simple, SIN emojis nunca.
- Directo al punto. Si algo no funciona, decilo en la primera oracion.
- Empeza por los huecos: antes de decir que algo esta bien, deci que falta o
  que supuesto es debil.
- Nada de halagos vacios. El acuerdo se gana despues de cuestionar.
- Estas en Telegram: respuestas cortas. Si necesitas explayarte, resumi primero
  y ofrece el detalle.

Como trabajas:
- Todo numero que le des tiene que tener fuente identificable. Si es una
  estimacion tuya, decilo.
- Cuando una accion tuya modifica algo, LP recibe un pedido de confirmacion
  automatico. No le pidas permiso por chat: proponé la accion y el sistema le
  muestra el boton. No repitas el pedido en texto.
- Si te deniegan una accion, no insistas ni busques la vuelta por otro camino.
  Preguntá que prefiere.
- Cuando aprendas algo durable sobre LP (una preferencia, un dato de su
  operatoria, un proyecto en curso), guardalo en tu memoria con la herramienta
  correspondiente. No guardes lo que ya esta en el repo o en la conversacion.
- Si no sabes algo y lo podes averiguar, averigualo. Si no lo podes averiguar,
  decilo en vez de inventar.
`.trim();

/**
 * Corre un turno del agente.
 *
 * @param {object} ctx  { userId, sessionId, sdkSessionId, chatId, isNewSession }
 * @param {string} prompt
 * @param {object} io   { onText, onThinking, onApprovalNeeded }
 * @returns {Promise<{text:string, costUsd:number, turns:number}>}
 */
export async function runTurn(ctx, prompt, io) {
  const spent = await db.spentTodayUsd(ctx.userId);
  if (spent >= DAILY_BUDGET_USD) {
    return {
      text: `Frene por el tope de gasto diario (USD ${DAILY_BUDGET_USD}). Llevo USD ${spent.toFixed(2)} hoy. Subilo con JARVIS_DAILY_BUDGET_USD si queres seguir.`,
      costUsd: 0, turns: 0, halted: true,
    };
  }

  const [memRows, allowlist] = await Promise.all([
    db.loadMemory(ctx.userId),
    db.loadAllowlist(ctx.userId),
  ]);
  const memoryBlock = db.renderMemory(memRows);

  const canUseTool = async ({ toolName, toolUse }, { signal } = {}) => {
    const toolInput = toolUse?.input ?? toolUse ?? {};
    const { decision, risk, why } = classify(toolName, toolInput);

    // Deny duro: ni se propone.
    if (decision === "deny") {
      await db.createPendingAction({
        user_id: ctx.userId, session_id: ctx.sessionId, tool_name: toolName,
        tool_input: toolInput, summary: describeAction(toolName, toolInput),
        risk, status: "denied", decided_by: "policy", decided_at: new Date().toISOString(),
        error: `bloqueado por politica: ${why}`,
      });
      return { approved: false, reason: `Bloqueado por politica de seguridad: ${why}. No lo intentes por otra via.` };
    }

    // Lectura: pasa sin registrar (seria ruido en la auditoria).
    if (decision === "auto") return { approved: true };

    // Allowlist del usuario.
    const hit = matchesAllowlist(allowlist, toolName, toolInput, risk);
    if (hit) {
      await db.bumpAllowlist(ctx.userId, toolName);
      await db.createPendingAction({
        user_id: ctx.userId, session_id: ctx.sessionId, tool_name: toolName,
        tool_input: toolInput, summary: describeAction(toolName, toolInput),
        risk, status: "approved", decided_by: "allowlist", decided_at: new Date().toISOString(),
      });
      return { approved: true };
    }

    // Confirmacion: se propone y se espera el boton.
    const action = await db.createPendingAction({
      user_id: ctx.userId, session_id: ctx.sessionId, tool_name: toolName,
      tool_input: toolInput, summary: describeAction(toolName, toolInput),
      risk, status: "pending",
    });

    const wait = waitForApproval(action.id);
    await io.onApprovalNeeded({
      actionId: action.id,
      toolName,
      risk,
      why,
      summary: describeAction(toolName, toolInput),
      // Lo que mueve plata nunca se puede graduar a automatico.
      allowAlways: risk !== "money",
    });

    if (signal) {
      signal.addEventListener("abort", () => resolveApproval(action.id, false, "timeout"), { once: true });
    }

    const { approved, decidedBy } = await wait;
    await db.decideAction(action.id, approved ? "approved" : "denied", decidedBy);

    if (!approved) {
      const motivo = decidedBy === "timeout" ? "no contesto a tiempo" : "lo rechazo";
      return { approved: false, reason: `El usuario ${motivo}. No reintentes esta accion ni busques un camino alternativo; preguntale que prefiere.` };
    }
    await db.finishAction(action.id, { status: "executed" });
    return { approved: true };
  };

  const opts = {
    model: MODEL,
    effort: EFFORT,
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    cwd: WORKSPACE,
    permissionMode: "default",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: memoryBlock ? `${SYSTEM_PROMPT}\n\n# Lo que ya sabes de LP\n\n${memoryBlock}` : SYSTEM_PROMPT,
    },
    // Sin settings del filesystem: el worker no debe heredar config de la maquina.
    settingSources: [],
    canUseTool,
    sessionId: ctx.sdkSessionId,
    ...(ctx.isNewSession ? {} : { resume: ctx.sdkSessionId }),
    stderr: (d) => { if (process.env.JARVIS_DEBUG) console.error("[sdk]", d); },
  };

  let text = "";
  let resultText = "";
  let costUsd = 0;
  let turns = 0;
  const seen = new Set();

  // El SDK anida el mensaje crudo de la API en msg.message; las versiones
  // viejas lo exponian plano en msg.content. Se aceptan las dos formas para
  // no depender de la version exacta del paquete (esta en 0.x, la API mueve).
  const blocksOf = (msg) => msg?.message?.content ?? msg?.content ?? [];

  const q = query({ prompt, options: opts });
  try {
    for await (const msg of q) {
      seen.add(msg.type);
      if (process.env.JARVIS_DEBUG) console.error("[sdk msg]", msg.type);

      if (msg.type === "assistant") {
        turns++;
        for (const block of blocksOf(msg)) {
          if (block?.type === "text" && block.text) {
            text += block.text;
            io.onText?.(block.text);
          }
        }
      } else if (msg.type === "result") {
        if (typeof msg.total_cost_usd === "number") costUsd = msg.total_cost_usd;
        // El resumen final viene como string plano en msg.result.
        if (typeof msg.result === "string") resultText = msg.result;
        for (const block of blocksOf(msg)) {
          if (block?.type === "text" && block.text) resultText += block.text;
        }
      }
    }
  } finally {
    try { q.close?.(); } catch { /* ya cerrado */ }
    // Un turno que muere con aprobaciones colgadas las deja pendientes para siempre.
    for (const id of [...pending.keys()]) resolveApproval(id, false, "timeout");
  }

  const finalText = (text.trim() || resultText.trim());

  // Un turno que gasto plata y no devolvio texto es casi siempre un cambio de
  // forma en los mensajes del SDK, no un turno vacio de verdad. Que sea ruidoso
  // en el log: la primera vez que paso, la respuesta se perdio en silencio.
  if (!finalText && costUsd > 0) {
    console.error(
      `[jarvis] turno sin texto pero con costo USD ${costUsd.toFixed(4)}. ` +
      `Tipos de mensaje vistos: ${[...seen].join(", ")}. ` +
      `Revisar la forma de los mensajes del SDK en blocksOf().`,
    );
  }

  return { text: finalText, costUsd, turns };
}
