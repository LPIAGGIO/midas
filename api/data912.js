// Serverless: proxy unificado a data912.com.
//
// Consolida 4 endpoints en uno solo para no llenar el cupo de funciones
// del Vercel Hobby plan (max 12 funciones serverless).
//
// Usage:
//   GET /api/data912?type=bonos     → /live/arg_bonds
//   GET /api/data912?type=letras    → /live/arg_notes
//   GET /api/data912?type=acciones  → /live/arg_stocks
//   GET /api/data912?type=cedears   → /live/arg_cedears
//   GET /api/data912?type=opciones  → /live/arg_options
//
// Devuelve el array tal cual lo devuelve data912 (sin transformar).
// Cache de 15 segundos en CDN para reducir hits.

const SOURCES = {
  bonos:    "https://data912.com/live/arg_bonds",
  letras:   "https://data912.com/live/arg_notes",
  acciones: "https://data912.com/live/arg_stocks",
  cedears:  "https://data912.com/live/arg_cedears",
  usa:      "https://data912.com/live/usa_stocks",
  opciones: "https://data912.com/live/arg_options",
};

export default async function handler(req, res) {
  const { type } = req.query || {};
  if (!type || !SOURCES[type]) {
    return res.status(400).json({
      error: "Falta o inválido el query param 'type'.",
      allowed: Object.keys(SOURCES),
    });
  }

  try {
    const r = await fetch(SOURCES[type]);
    if (!r.ok) {
      return res.status(502).json({ error: `data912 returned ${r.status}` });
    }
    const data = await r.json();
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=60");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
