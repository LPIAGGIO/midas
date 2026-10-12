// supabase/functions/iol-auth/index.ts
//
// Edge Function: maneja la autenticación contra IOL (InvertirOnline).
//
// Acciones soportadas (POST con body JSON `{action, ...}`):
//
//   { action: "login", username, password }
//     - Login inicial con credenciales IOL del usuario.
//     - Guarda los tokens y la metadata (customer_id, account_number) en
//       linked_brokers. Devuelve el estado del link.
//
//   { action: "refresh" }
//     - Refresca el access_token usando el refresh_token guardado.
//     - El worker periódico llama a esta acción cada ~12 min.
//
//   { action: "unlink" }
//     - Borra el linked_brokers row del usuario para IOL (todos los tokens).
//
//   { action: "status" }
//     - Devuelve el estado actual del link (sin exponer tokens).
//
// Auth: requiere Authorization header con JWT del usuario Supabase.
// La función SOLO permite modificar el linked_brokers del usuario autenticado.
//
// Despliegue: Supabase Dashboard → Edge Functions → "New Function" → "iol-auth".

import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.39.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const IOL_BASE = "https://api.invertironline.com";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ─── 1. Auth: identificar al user por su JWT ─────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "missing_authorization" }, 401);
    }

    // Cliente con anon key + el JWT del user, para validar quién es.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();

    if (userErr || !user) {
      return jsonResponse(
        { error: "invalid_authorization", detail: userErr?.message },
        401
      );
    }

    // Cliente con service_role para escribir los campos restringidos.
    // Solo se usa después de haber validado al user con su JWT.
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ─── 2. Routing por action ────────────────────────────────────────────
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid_json_body" }, 400);
    }

    switch (body.action) {
      case "login":
        return await handleLogin(serviceClient, user.id, body);
      case "refresh":
        return await handleRefresh(serviceClient, user.id);
      case "unlink":
        return await handleUnlink(serviceClient, user.id);
      case "status":
        return await handleStatus(serviceClient, user.id);
      default:
        return jsonResponse(
          { error: "unknown_action", action: body.action ?? null },
          400
        );
    }
  } catch (e: any) {
    console.error("iol-auth error:", e);
    return jsonResponse(
      { error: "internal_error", detail: String(e?.message || e) },
      500
    );
  }
});


// ─── action: login ──────────────────────────────────────────────────────

async function handleLogin(sb: SupabaseClient, userId: string, body: any) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    return jsonResponse({ error: "missing_credentials" }, 400);
  }

  // 1. POST a IOL /token con grant_type=password
  const tokenRes = await fetch(`${IOL_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username,
      password,
      grant_type: "password",
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    return jsonResponse(
      {
        error: "iol_auth_failed",
        iol_status: tokenRes.status,
        iol_response: safeParseJson(errText) ?? errText.slice(0, 500),
      },
      401
    );
  }

  const tokens = await tokenRes.json();
  const brokerUserId = decodeJwtSub(tokens.refresh_token);
  const accessExpiresAt = parseHttpDate(tokens[".expires"]);
  const refreshExpiresAt = parseHttpDate(tokens[".refreshexpires"]);

  // 2. Optional: fetch /estadocuenta para extraer el account number
  let brokerAccountId: string | null = null;
  try {
    const acctRes = await fetch(`${IOL_BASE}/api/v2/estadocuenta`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (acctRes.ok) {
      const acct = await acctRes.json();
      const arsAccount = (acct.cuentas || []).find(
        (c: any) => c.tipo === "inversion_Argentina_Pesos"
      );
      brokerAccountId =
        arsAccount?.numero ?? acct.cuentas?.[0]?.numero ?? null;
    }
  } catch {
    // No es crítico — el sync lo poblará después
  }

  // 3. Upsert linked_brokers
  const { data: linked, error: upErr } = await sb
    .from("linked_brokers")
    .upsert(
      {
        user_id: userId,
        broker: "iol",
        label: brokerAccountId ? `IOL · Cuenta ${brokerAccountId}` : "IOL",
        status: "active",
        status_message: null,
        broker_user_id: brokerUserId,
        broker_account_id: brokerAccountId,
        refresh_token: tokens.refresh_token,
        access_token: tokens.access_token,
        access_expires_at: accessExpiresAt,
        refresh_expires_at: refreshExpiresAt,
        last_sync_at: new Date().toISOString(),
        last_sync_status: "ok",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,broker,cuenta" }
    )
    .select(
      "id, broker, status, label, broker_user_id, broker_account_id, access_expires_at, refresh_expires_at, last_sync_at"
    )
    .single();

  if (upErr) {
    return jsonResponse(
      { error: "db_upsert_failed", detail: upErr.message },
      500
    );
  }

  return jsonResponse({ ok: true, linked });
}


// ─── action: refresh ────────────────────────────────────────────────────

async function handleRefresh(sb: SupabaseClient, userId: string) {
  const { data: row, error: selErr } = await sb
    .from("linked_brokers")
    .select("refresh_token, refresh_expires_at")
    .eq("user_id", userId)
    .eq("broker", "iol")
    .single();

  if (selErr || !row) {
    return jsonResponse({ error: "not_linked" }, 404);
  }
  if (!row.refresh_token) {
    return jsonResponse({ error: "no_refresh_token" }, 400);
  }

  // ¿El refresh_token ya expiró? Marcar como expired y avisar al user.
  if (
    row.refresh_expires_at &&
    new Date(row.refresh_expires_at) < new Date()
  ) {
    await sb
      .from("linked_brokers")
      .update({
        status: "expired",
        status_message: "Refresh token expirado — re-vincular IOL",
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("broker", "iol");
    return jsonResponse(
      { error: "refresh_token_expired", needs_relink: true },
      401
    );
  }

  // POST a IOL /token con grant_type=refresh_token
  const tokenRes = await fetch(`${IOL_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: row.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    await sb
      .from("linked_brokers")
      .update({
        status: "error",
        status_message: `Refresh fallido (HTTP ${tokenRes.status})`,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("broker", "iol");
    return jsonResponse(
      {
        error: "iol_refresh_failed",
        iol_status: tokenRes.status,
        iol_response: safeParseJson(errText) ?? errText.slice(0, 500),
      },
      401
    );
  }

  const tokens = await tokenRes.json();
  const accessExpiresAt = parseHttpDate(tokens[".expires"]);
  const refreshExpiresAt = parseHttpDate(tokens[".refreshexpires"]);

  const { data: linked, error: upErr } = await sb
    .from("linked_brokers")
    .update({
      status: "active",
      status_message: null,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      access_expires_at: accessExpiresAt,
      refresh_expires_at: refreshExpiresAt,
      last_sync_at: new Date().toISOString(),
      last_sync_status: "ok",
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("broker", "iol")
    .select(
      "id, broker, status, access_expires_at, refresh_expires_at, last_sync_at"
    )
    .single();

  if (upErr) {
    return jsonResponse(
      { error: "db_update_failed", detail: upErr.message },
      500
    );
  }

  return jsonResponse({ ok: true, linked });
}


// ─── action: unlink ─────────────────────────────────────────────────────

async function handleUnlink(sb: SupabaseClient, userId: string) {
  const { error } = await sb
    .from("linked_brokers")
    .delete()
    .eq("user_id", userId)
    .eq("broker", "iol");

  if (error) {
    return jsonResponse(
      { error: "db_delete_failed", detail: error.message },
      500
    );
  }
  return jsonResponse({ ok: true });
}


// ─── action: status ─────────────────────────────────────────────────────

async function handleStatus(sb: SupabaseClient, userId: string) {
  const { data, error } = await sb
    .from("linked_brokers")
    .select(
      "id, broker, status, status_message, label, broker_user_id, broker_account_id, access_expires_at, refresh_expires_at, last_sync_at, last_sync_status, bot_enabled, bot_extra_calls_allowed"
    )
    .eq("user_id", userId)
    .eq("broker", "iol")
    .maybeSingle();

  if (error) {
    return jsonResponse(
      { error: "db_query_failed", detail: error.message },
      500
    );
  }
  return jsonResponse({ linked: !!data, ...(data || {}) });
}


// ─── Helpers ────────────────────────────────────────────────────────────

function decodeJwtSub(jwt: string): string | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4;
    const fullPadded = pad ? padded + "=".repeat(4 - pad) : padded;
    const payload = JSON.parse(atob(fullPadded));
    return payload.sub != null ? String(payload.sub) : null;
  } catch {
    return null;
  }
}

function parseHttpDate(rfc1123: string | undefined): string | null {
  if (!rfc1123) return null;
  const t = new Date(rfc1123).getTime();
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function safeParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
