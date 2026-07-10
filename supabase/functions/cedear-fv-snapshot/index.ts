// Logger de fair-value de CEDEARs: cada minuto en el overlap BA/NYSE pega a
// data912 (CEDEAR en pesos + accion US en USD), cruza por simbolo y loguea
// ambos precios + el cociente c_over_u (= CCL/ratio). La estabilidad intradia
// de ese cociente es la senal de rezago (cuando el US se mueve y el CEDEAR no).
// Invocada por pg_cron. verify_jwt=false (solo escribe data de mercado).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async () => {
  try {
    const [cedRes, usRes] = await Promise.all([
      fetch("https://data912.com/live/arg_cedears"),
      fetch("https://data912.com/live/usa_stocks"),
    ]);
    if (!cedRes.ok || !usRes.ok) {
      return new Response(JSON.stringify({ error: `feed ${cedRes.status}/${usRes.status}` }), { status: 502 });
    }
    const ced = await cedRes.json();
    const us = await usRes.json();
    const usMap = new Map((us as any[]).map((x) => [x.symbol, x]));
    const now = new Date().toISOString();

    const rows: any[] = [];
    for (const c of ced as any[]) {
      const u = usMap.get(c.symbol);
      if (!u) continue;
      const cLast = Number(c.c) || null;
      const uLast = Number(u.c) || null;
      // Solo CEDEARs con libro (bid&ask) y subyacente con precio.
      if (!(Number(c.px_bid) > 0 && Number(c.px_ask) > 0)) continue;
      if (!(uLast && uLast > 0)) continue;
      rows.push({
        snapshot_at: now,
        symbol: c.symbol,
        c_bid: Number(c.px_bid) || null,
        c_ask: Number(c.px_ask) || null,
        c_last: cLast,
        c_vol: Number(c.v) || null,
        u_bid: Number(u.px_bid) || null,
        u_ask: Number(u.px_ask) || null,
        u_last: uLast,
        c_over_u: cLast && uLast ? cLast / uLast : null,
      });
    }
    // Top 60 por volumen de CEDEAR (liquidos) para no inflar la tabla.
    rows.sort((a, b) => (b.c_vol ?? 0) - (a.c_vol ?? 0));
    const top = rows.slice(0, 60);

    if (top.length) {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { error } = await supabase.from("cedear_fv_log").insert(top);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
    return new Response(JSON.stringify({ inserted: top.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500 });
  }
});
