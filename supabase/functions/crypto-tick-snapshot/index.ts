// Logger de microestructura crypto (Kraken, data publica, sin keys).
// Cada invocacion (1/min via pg_cron) poolea el Ticker de Kraken cada ~6s
// durante ~54s -> resolucion ~6 segundos por par (BTC/USD, ETH/USD). Guarda
// bid/ask/last/vol24/spread para medir reversion neta de fee. verify_jwt=false.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const KRAKEN = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD";
const ITER = 9;       // ~9 snapshots
const GAP_MS = 6000;  // cada 6s -> ~54s total

function symbolOf(key: string): string | null {
  const k = key.toUpperCase();
  if (k.includes("XBT") || k.includes("BTC")) return "BTC/USD";
  if (k.includes("ETH")) return "ETH/USD";
  return null;
}

Deno.serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < ITER; i++) {
    try {
      const r = await fetch(KRAKEN);
      if (r.ok) {
        const j = await r.json();
        const result = j?.result || {};
        const now = new Date().toISOString();
        const rows: any[] = [];
        for (const [key, v] of Object.entries(result as Record<string, any>)) {
          const symbol = symbolOf(key);
          if (!symbol) continue;
          const ask = Number(v?.a?.[0]) || null;
          const bid = Number(v?.b?.[0]) || null;
          const last = Number(v?.c?.[0]) || null;
          const vol24 = Number(v?.v?.[1]) || null;
          const spread_pct = (ask && bid && ask > 0 && bid > 0)
            ? ((ask - bid) / ((ask + bid) / 2)) * 100
            : null;
          rows.push({ snapshot_at: now, symbol, bid, ask, last, vol24, spread_pct });
        }
        if (rows.length) {
          const { error } = await supabase.from("crypto_tick_log").insert(rows);
          if (error) errors++; else inserted += rows.length;
        }
      } else {
        errors++;
      }
    } catch (_e) {
      errors++;
    }
    if (i < ITER - 1) await new Promise((res) => setTimeout(res, GAP_MS));
  }

  return new Response(JSON.stringify({ inserted, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});
