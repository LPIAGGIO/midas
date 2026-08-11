/**
 * Capa de estado de Jarvis sobre Supabase.
 *
 * Todo lleva user_id desde el dia 1 (multi-tenant listo aunque hoy haya un solo
 * usuario). El worker usa service_role, que bypassa RLS: la responsabilidad de
 * filtrar por user_id es de este modulo, no de la base.
 */

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el .env");

export const supabase = createClient(url, key, { auth: { persistSession: false } });

/* ---------------------------------------------------------------- canales */

export async function findUserByChannel(channel, channelRef) {
  const { data, error } = await supabase
    .from("jarvis_channel_links")
    .select("user_id, enabled")
    .eq("channel", channel)
    .eq("channel_ref", String(channelRef))
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.enabled) return null;
  return data.user_id;
}

export async function linkChannel(userId, channel, channelRef) {
  const { error } = await supabase
    .from("jarvis_channel_links")
    .upsert(
      { user_id: userId, channel, channel_ref: String(channelRef), link_code: null, enabled: true },
      { onConflict: "channel,channel_ref" },
    );
  if (error) throw error;
}

export async function consumeLinkCode(code, channel, channelRef) {
  const { data, error } = await supabase
    .from("jarvis_channel_links")
    .select("id, user_id")
    .eq("link_code", code)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { error: upErr } = await supabase
    .from("jarvis_channel_links")
    .update({ channel, channel_ref: String(channelRef), link_code: null, enabled: true })
    .eq("id", data.id);
  if (upErr) throw upErr;
  return data.user_id;
}

/* --------------------------------------------------------------- sesiones */

/** Devuelve la sesion activa del canal, o crea una nueva. */
export async function getOrCreateSession(userId, channel, channelRef) {
  const { data, error } = await supabase
    .from("jarvis_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", channel)
    .eq("channel_ref", String(channelRef))
    .eq("status", "active")
    .order("last_seen_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const { data: created, error: insErr } = await supabase
    .from("jarvis_sessions")
    .insert({ user_id: userId, channel, channel_ref: String(channelRef), sdk_session_id: crypto.randomUUID() })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

export async function touchSession(sessionId) {
  await supabase.from("jarvis_sessions").update({ last_seen_at: new Date().toISOString() }).eq("id", sessionId);
}

/** Cierra la sesion actual: la proxima consulta arranca con contexto limpio. */
export async function closeSession(sessionId) {
  await supabase.from("jarvis_sessions").update({ status: "closed" }).eq("id", sessionId);
}

/* ---------------------------------------------------------------- memoria */

export async function loadMemory(userId) {
  const { data, error } = await supabase
    .from("jarvis_memory")
    .select("kind, key, content, pinned")
    .eq("user_id", userId)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

export async function saveMemory(userId, { kind, key, content, source = "agent", pinned = false }) {
  const { error } = await supabase
    .from("jarvis_memory")
    .upsert(
      { user_id: userId, kind, key, content, source, pinned, updated_at: new Date().toISOString() },
      { onConflict: "user_id,kind,key" },
    );
  if (error) throw error;
}

/** Arma el bloque de memoria que se inyecta al system prompt. */
export function renderMemory(rows) {
  if (!rows.length) return "";
  const byKind = {};
  for (const r of rows) (byKind[r.kind] ||= []).push(r);
  const label = { preference: "Preferencias", fact: "Hechos", project: "Proyectos en curso", reference: "Referencias" };
  const parts = [];
  for (const kind of ["preference", "fact", "project", "reference"]) {
    if (!byKind[kind]?.length) continue;
    parts.push(`## ${label[kind]}\n` + byKind[kind].map((r) => `- **${r.key}**: ${r.content}`).join("\n"));
  }
  return parts.join("\n\n");
}

/* --------------------------------------------------------------- acciones */

export async function createPendingAction(row) {
  const { data, error } = await supabase.from("jarvis_actions").insert(row).select().single();
  if (error) throw error;
  return data;
}

export async function decideAction(actionId, status, decidedBy) {
  const { data, error } = await supabase
    .from("jarvis_actions")
    .update({ status, decided_by: decidedBy, decided_at: new Date().toISOString() })
    .eq("id", actionId)
    .eq("status", "pending")          // claim atomico: el primero que decide, gana
    .select()
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function finishAction(actionId, { status, result, error: errMsg }) {
  await supabase
    .from("jarvis_actions")
    .update({ status, result: result ?? null, error: errMsg ?? null, executed_at: new Date().toISOString() })
    .eq("id", actionId);
}

export async function getAction(actionId) {
  const { data, error } = await supabase.from("jarvis_actions").select("*").eq("id", actionId).maybeSingle();
  if (error) throw error;
  return data;
}

/** Marca como expiradas las pendientes viejas (cuelgues, reinicios del worker). */
export async function expireStaleActions(olderThanMs) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  await supabase
    .from("jarvis_actions")
    .update({ status: "expired", decided_by: "timeout", decided_at: new Date().toISOString() })
    .eq("status", "pending")
    .lt("created_at", cutoff);
}

/* -------------------------------------------------------------- allowlist */

export async function loadAllowlist(userId) {
  const { data, error } = await supabase
    .from("jarvis_allowlist")
    .select("*")
    .eq("user_id", userId)
    .eq("enabled", true);
  if (error) throw error;
  return data || [];
}

export async function bumpAllowlist(userId, toolName) {
  const { data } = await supabase
    .from("jarvis_allowlist")
    .select("id, approved_count")
    .eq("user_id", userId)
    .eq("tool_name", toolName)
    .is("input_matcher", null)
    .maybeSingle();
  if (data) {
    await supabase.from("jarvis_allowlist").update({ approved_count: data.approved_count + 1 }).eq("id", data.id);
  }
}

/* -------------------------------------------------------------- mensajes */

export async function logMessage(userId, sessionId, role, content, channel, costUsd = null) {
  await supabase.from("jarvis_messages").insert({
    user_id: userId, session_id: sessionId, role,
    content: String(content ?? "").slice(0, 20000), channel, cost_usd: costUsd,
  });
}

/** Gasto acumulado del dia, para el tope diario. */
export async function spentTodayUsd(userId) {
  const since = new Date(); since.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("jarvis_messages")
    .select("cost_usd")
    .eq("user_id", userId)
    .not("cost_usd", "is", null)
    .gte("created_at", since.toISOString());
  if (error) throw error;
  return (data || []).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
}
