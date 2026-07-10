// supabase/functions/iol-quotes-close/index.ts
//
// Pull de cotizaciones IOL para el P&L del dia (cierre 17:30 L-V).
//
// Motivo: el P&L HOY de Midas no cuadra con Cocos en BONOS porque el "cierre
// anterior" del feed gratis (BYMA) viene mal escalado. IOL trae el cierre
// anterior oficial (mismo que usa Cocos). Guardamos {last, cierreAnterior} en
// iol_quotes; Midas usa el last de la rueda anterior como cierre de ayer -> el
// P&L del dia espeja a Cocos.
//
// TOKEN: usamos el access_token que iol-sync mantiene fresco en linked_brokers
// (keepalive cada 10 min). NO refrescamos aca -> sin colision de rotacion con
// iol-sync. Si el token esta vencido, salteamos (el proximo keepalive lo renueva).
//
// Seguridad: header X-Sync-Secret == SYNC_SECRET (igual que iol-sync). Solo el
// cron lo dispara. Body opcional {tickers:[...]} para override manual/test.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const IOL_BASE = "https://api.invertironline.com";
const MERCADO = "bCBA";

Deno.serve(async (req: Request) => {
  const provided = req.headers.get("X-Sync-Secret");
  const expected = Deno.env.get("SYNC_SECRET");
  if (!expected) return json({ error: "server_misconfigured", detail: "SYNC_SECRET no seteado" }, 500);
  if (provided !== expected) return json({ error: "unauthorized" }, 401);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Token IOL fresco (mantenido por iol-sync). No refrescamos.
  const { data: link } = await sb
    .from("linked_brokers")
    .select("user_id, access_token, access_expires_at")
    .eq("broker", "iol")
    .eq("status", "active")
    .not("access_token", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!link?.access_token) return json({ error: "no_iol_token", detail: "ninguna cuenta IOL activa con token" }, 503);
  if (link.access_expires_at && new Date(link.access_expires_at) < new Date())
    return json({ error: "iol_token_stale", detail: "token vencido; espera el proximo keepalive de iol-sync" }, 503);

  // Panel: override por body {tickers:[...]} (test) o distinct de positions.
  let tickers: string[] = [];
  try {
    const body = await req.json();
    if (Array.isArray(body?.tickers)) tickers = body.tickers;
  } catch { /* sin body */ }
  if (!tickers.length) {
    const { data: rows } = await sb
      .from("positions")
      .select("ticker")
      .in("instrument_type", ["bond_ars", "bond_usd", "cedear", "stock"]);
    tickers = (rows || []).map((r: any) => r.ticker);
  }
  tickers = [...new Set(tickers.map((t) => (t || "").trim().toUpperCase()).filter(Boolean))];
  if (!tickers.length) return json({ ok: true, note: "sin tickers en cartera", written: 0 });

  const todayAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  const auth = { Authorization: `Bearer ${link.access_token}` };
  const out: any[] = [];
  const errors: any[] = [];
  let calls = 0;

  for (const t of tickers) {
    const startedAt = Date.now();
    let status = 0;
    try {
      const res = await fetch(
        `${IOL_BASE}/api/v2/${MERCADO}/Titulos/${encodeURIComponent(t)}/Cotizacion`,
        { headers: auth }
      );
      status = res.status;
      calls++;
      if (res.ok) {
        const q = await res.json();
        const last = num(q?.ultimoPrecio);
        const prev = num(q?.cierreAnterior);
        if (last != null || prev != null) {
          out.push({
            ticker: t, mercado: MERCADO, last, prev_close: prev,
            variacion: num(q?.variacion), quote_date: todayAR, source: "iol",
            updated_at: new Date().toISOString(),
          });
        }
      } else {
        errors.push({ ticker: t, status });
      }
    } catch (e: any) {
      errors.push({ ticker: t, error: String(e?.message || e).slice(0, 80) });
    }
    logApiCall(sb, link.user_id, `GET Cotizacion/${t}`, "prices", status, Date.now() - startedAt);
  }
  for (let i = 0; i < calls; i++) countCall(sb, link.user_id);

  if (out.length) {
    const { error } = await sb.from("iol_quotes").upsert(out, { onConflict: "ticker,mercado" });
    if (error) return json({ error: "upsert_failed", detail: error.message, fetched: out.length }, 500);
  }
  return json({ ok: true, tickers: tickers.length, written: out.length, errors });
});

function num(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function countCall(sb: SupabaseClient, userId: string) {
  sb.rpc("increment_api_call_count", { p_user_id: userId, p_broker: "iol", p_is_extra: false }).then(() => {}, () => {});
}
function logApiCall(sb: SupabaseClient, userId: string, endpoint: string, category: string, status: number, durationMs: number) {
  sb.from("api_call_log").insert({ user_id: userId, broker: "iol", endpoint, category, status, duration_ms: durationMs }).then(() => {}, () => {});
}
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
