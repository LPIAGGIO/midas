// Serverless: proxy a la API de Estadísticas Monetarias del BCRA (v4.0).
//
// El cert del BCRA valida con cadena completa (fetch normal anda, sin -k).
// La v3.0 fue deprecada (410); usamos v4.0.
//
// Usage:
//   GET /api/bcra?list=1                  → lista de variables {idVariable,descripcion}
//   GET /api/bcra?var=1&desde=&hasta=     → serie de la variable (results[0].detalle)
//   GET /api/bcra?riesgo=1                → riesgo país { valor, fecha } (vía ámbito;
//                                           argentinadatos murió en jul-2026)
//
// Variables clave: 1 Reservas (USD MM, diaria), 5 TC mayorista, 4 TC
// minorista, 84 TC contable, 78 Variación de reservas por compra de
// divisas (compras/ventas diarias del BCRA, USD MM, signo = compra/venta),
// 47 Efecto monetario de compras netas al sector privado (ARS MM).
//
// Devuelve el body tal cual lo da el BCRA. Cache 1h (datos diarios).

const BASE = "https://api.bcra.gob.ar/estadisticas/v4.0/Monetarias";

export default async function handler(req, res) {
  const { list, desde, hasta } = req.query || {};
  const varId = req.query?.var;

  // Riesgo país (EMBI AR) — el BCRA no lo publica; lo da ámbito. Se normaliza a
  // { valor: number, fecha: 'YYYY-MM-DD' } para que el front no dependa del
  // formato de ámbito ("410", "16-07-2026").
  if (req.query?.riesgo) {
    try {
      const r = await fetch("https://mercados.ambito.com//riesgopais/variacion", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (!r.ok) return res.status(502).json({ error: `ámbito respondió ${r.status}` });
      const j = await r.json();
      const valor = Number(String(j?.ultimo || "").replace(/\./g, "").replace(",", "."));
      const m = String(j?.fecha || "").match(/^(\d{2})-(\d{2})-(\d{4})$/);
      const fecha = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
      if (!Number.isFinite(valor) || valor <= 0) return res.status(502).json({ error: "riesgo país sin valor" });
      res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
      return res.status(200).json({ valor, fecha });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    let url;
    if (list) {
      url = BASE;
    } else if (varId && /^\d+$/.test(String(varId))) {
      const qs = [];
      if (desde) qs.push(`desde=${encodeURIComponent(desde)}`);
      if (hasta) qs.push(`hasta=${encodeURIComponent(hasta)}`);
      url = `${BASE}/${varId}${qs.length ? "?" + qs.join("&") : ""}`;
    } else {
      return res.status(400).json({ error: "Usar ?list=1 o ?var=ID[&desde=&hasta=]" });
    }
    const r = await fetch(url, { headers: { "User-Agent": "Midas/1.0 (terminal)" } });
    if (!r.ok) return res.status(502).json({ error: `BCRA respondió ${r.status}` });
    const data = await r.json();
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
