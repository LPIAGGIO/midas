// Serverless: receptor de webhooks de TradingView → Alertas TV · Bot.
//
// TradingView dispara un POST con el "mensaje" de la alerta como body. Acá
// esperamos JSON (configurar el mensaje de la alerta en TV así):
//   {"secret":"<TV_WEBHOOK_SECRET>","ticker":"MU","usd":970,"dir":"up","nota":"resistencia diario"}
// Campos: ticker (CEDEAR/subyacente, obligatorio), y UNO de:
//   - usd: nivel en USD del chart USA → se convierte a pesos con CCL/ratio acá
//   - ars: nivel ya en pesos (si la alerta es sobre el CEDEAR BYMA)
// Opcionales: dir ("up"|"down", default "up"), nota, ratio (pisa el del catálogo).
//
// Env vars requeridas (Vercel → Settings → Environment Variables):
//   TV_WEBHOOK_SECRET          — la clave compartida (si no matchea → 401)
//   SUPABASE_SERVICE_ROLE_KEY  — para insertar en price_alerts
//   VITE_SUPABASE_URL          — ya existe (la usa el front)
//
// Inserta en price_alerts con canal='screen' + origen='tv' → aparece en la
// pantalla "Alertas TV · Bot" y dispara en pantalla (no Telegram).

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const SECRET = process.env.TV_WEBHOOK_SECRET;
  const SB_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SECRET || !SB_URL || !SB_KEY) return res.status(500).json({ error: "faltan env vars (TV_WEBHOOK_SECRET / SUPABASE_SERVICE_ROLE_KEY)" });

  // TV manda el mensaje como texto plano; puede venir como JSON parseado o string.
  let p = req.body;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return res.status(400).json({ error: "body no es JSON" }); } }
  if (!p || p.secret !== SECRET) return res.status(401).json({ error: "unauthorized" });

  const ticker = String(p.ticker || "").trim().toUpperCase().replace(/^(NASDAQ|NYSE|BATS|AMEX|BCBA):/, "");
  if (!ticker) return res.status(400).json({ error: "falta ticker" });
  const dir = p.dir === "down" ? "down" : "up";
  const nota = p.nota ? String(p.nota).slice(0, 200) : null;

  // Nivel en pesos: directo (ars) o convertido desde USD con CCL live + ratio.
  let priceArs = Number(p.ars) || null;
  let usdRef = Number(p.usd) || null;
  if (!priceArs && usdRef) {
    const ratio = Number(p.ratio) || null;
    if (!ratio) return res.status(400).json({ error: "con usd hace falta ratio (mandalo en el payload: \"ratio\":5)" });
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

  // user_id: LP (single-tenant del webhook por ahora; multiuser = un secret por usuario).
  const USER_ID = "cafc5a8c-1cee-4d57-a765-6aacf1acc661";
  const ins = await fetch(`${SB_URL}/rest/v1/price_alerts`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ user_id: USER_ID, ticker, price: Math.round(priceArs), dir, nota, usd_ref: usdRef, canal: "screen", origen: "tv" }),
  });
  if (!ins.ok) return res.status(502).json({ error: "insert falló", detail: (await ins.text()).slice(0, 200) });
  return res.status(200).json({ ok: true, ticker, price: Math.round(priceArs), dir });
}
