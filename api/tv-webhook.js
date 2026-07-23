// Serverless: receptor de webhooks de TradingView → pantalla "Alertas TV · Bot".
//
// TradingView POSTea el "mensaje" de la alerta. Formato esperado (Message de la
// alerta en TV):
//   {"secret":"...","ticker":"MU","usd":970,"ratio":5,"dir":"up","nota":"resistencia diario"}
// Campos: ticker obligatorio; nivel = "ars" directo, o "usd" + "ratio" (se
// convierte acá con CCL live). Opcionales: dir up|down (default up), nota.
//
// SIN env vars nuevas: el secret NO se valida acá — lo valida Postgres
// (función tv_alert_insert, SECURITY DEFINER, secret en tabla tv_config sin
// policies). El endpoint usa la clave ANON (pública por diseño, ya presente
// en el build de Vercel), así que un secret inválido rebota en la base con
// 'unauthorized' y acá se traduce a 401.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SB_ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!SB_URL || !SB_ANON) return res.status(500).json({ error: "faltan env vars de Supabase en Vercel" });

  let p = req.body;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return res.status(400).json({ error: "body no es JSON" }); } }
  if (!p || !p.secret) return res.status(401).json({ error: "falta secret" });

  const ticker = String(p.ticker || "").trim().toUpperCase().replace(/^(NASDAQ|NYSE|BATS|AMEX|BCBA):/, "");
  if (!ticker) return res.status(400).json({ error: "falta ticker" });
  const dir = p.dir === "down" ? "down" : "up";
  const nota = p.nota ? String(p.nota) : null;

  let priceArs = Number(p.ars) || null;
  const usdRef = Number(p.usd) || null;
  if (!priceArs && usdRef) {
    const ratio = Number(p.ratio) || null;
    if (!ratio) return res.status(400).json({ error: "con usd hace falta ratio (ej: \"ratio\":5)" });
    try {
      const r = await fetch("https://dolarapi.com/v1/dolares/contadoconliqui", { headers: { "User-Agent": "Midas/1.0" } });
      const j = await r.json();
      const ccl = Number(j?.venta) || Number(j?.compra);
      if (!ccl) throw new Error("sin CCL");
      priceArs = (usdRef * ccl) / ratio;
    } catch (e) {
      return res.status(502).json({ error: "no pude resolver CCL: " + e.message });
    }
  }
  if (!priceArs || priceArs <= 0) return res.status(400).json({ error: "falta nivel (usd+ratio o ars)" });

  const rpc = await fetch(`${SB_URL}/rest/v1/rpc/tv_alert_insert`, {
    method: "POST",
    headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_secret: String(p.secret), p_ticker: ticker, p_price: priceArs, p_dir: dir, p_nota: nota, p_usd: usdRef }),
  });
  if (!rpc.ok) {
    const detail = (await rpc.text()).slice(0, 300);
    const unauthorized = /unauthorized/i.test(detail);
    return res.status(unauthorized ? 401 : 502).json({ error: unauthorized ? "secret invalido" : "insert falló", detail: unauthorized ? undefined : detail });
  }
  return res.status(200).json({ ok: true, ticker, price: Math.round(priceArs), dir });
}
