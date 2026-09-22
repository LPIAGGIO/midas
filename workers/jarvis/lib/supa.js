/**
 * Cliente minimo de Supabase por REST (PostgREST), con fetch nativo.
 *
 * Por que no `@supabase/supabase-js` aca: las skills tienen que poder correrse
 * con `node probe.js` sin instalar nada. El worker completo si usa el cliente
 * oficial (lib/db.js) porque necesita realtime y auth; las skills solo leen.
 *
 * Credenciales: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY en el VPS. En la PC de
 * LP alcanza VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY para lo publico
 * (momentum_signal, iol_quotes); `positions` tiene RLS de duenio y con la anon
 * key devuelve vacio, que es la seguridad funcionando, no un bug.
 */

/**
 * Las credenciales se leen AL USARLAS, no al importar el modulo. En ESM todos
 * los `import` corren antes del cuerpo del archivo que importa, asi que un
 * `const KEY = process.env...` en el top level se evalua antes de que el
 * llamador alcance a cargar su .env, y queda vacio para siempre.
 */
const creds = () => ({
  url: process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "",
  key: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || "",
});

export const hayCredenciales = () => { const c = creds(); return !!(c.url && c.key); };
export const esServiceKey = () => !!process.env.SUPABASE_SERVICE_ROLE_KEY;

/** El user_id operativo de LP. El mail de axongroup es OTRO usuario: no mezclar. */
export const LP_USER_ID = () => process.env.JARVIS_USER_ID || "cafc5a8c-1cee-4d57-a765-6aacf1acc661";

export async function select(tabla, params = {}, { timeoutMs = 12000 } = {}) {
  const { url, key } = creds();
  if (!url || !key) throw new Error("faltan SUPABASE_URL / KEY en el entorno");
  const qs = new URLSearchParams(params).toString();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/rest/v1/${tabla}?${qs}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`PostgREST ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}
