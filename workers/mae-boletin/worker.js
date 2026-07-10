/**
 * Worker mae-boletin: una vez por día a las 22:00 ART (lun-vie),
 * descarga el ReporteResumenFinal de MAE para la fecha del día y
 * upsertea en daily_close_prices.
 *
 * Schedule: PM2 cron_restart '0 22 * * 1-5'. El worker hace un sync
 * completo y termina; PM2 lo deja parado hasta el próximo tick.
 *
 * Override manual: FECHA=YYYY-MM-DD node worker.js
 */

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");
const { todayArDate, isBusinessDay, syncFecha } = require("./lib");

const MAE_API_KEY = process.env.MAE_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!MAE_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan vars de entorno. Verificá .env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

async function main() {
  const stamp = new Date().toISOString();
  const fecha = process.env.FECHA || todayArDate();

  if (!isBusinessDay(fecha)) {
    console.log(`[${stamp}] ${fecha} no es día hábil, skip`);
    return;
  }

  console.log(`[${stamp}] sync boletin MAE para ${fecha}`);
  await syncFecha(fecha, supabase, MAE_API_KEY);
  console.log(`[${new Date().toISOString()}] done`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
