# Midas — reglas para trabajar en este repo

Terminal de inversión personal de Leonardo Piaggio (LP) para el mercado argentino,
con plata real: un bot opera en IOL y LP espeja operaciones en Cocos. Un error acá
no es un bug de pantalla: puede ser una orden, un stop sin vigilar o un P&L falso
sobre el que LP decide.

## Cómo hablar

- Castellano rioplatense, directo, sin emojis. Huecos y riesgos primero.
- Verificar antes de alarmar: terminar de mirar antes de decir que algo falta o
  está roto. Nunca afirmar el estado de una orden real solo con un grep del log:
  la verdad es `paper_iol_trades.broker_order_id` contra IOL.

## Plata real: reglas duras

- **No ejecutar órdenes de compra/venta desde el chat.** Se prepara el ticket
  exacto y LP lo carga. Cancelar una orden por MCP sí está permitido.
- **No reiniciar ni desplegar el bot `niveles-auto` con el mercado abierto.**
  Mercado = lunes a viernes 10:30–17:00 ART (BYMA **abre a las 10:30**, igual
  que EE.UU.). Deploy solo con `workers/niveles-auto/deploy-worker.sh`, que
  tiene la puerta de las 17:05. Un hook de Claude Code (`~/.claude/hooks/
  guard-bot-restart.js`) bloquea los reinicios en rueda.
- **Hora argentina:** Git Bash no resuelve zonas Olson
  (`TZ=America/Argentina/Buenos_Aires` devuelve GMT sin avisar). Usar
  `TZ='ART3' date` y cruzar con la hora del VPS.
- **El bot en el VPS corre `workers/niveles-auto/worker-deploy.js`**, no el
  `worker.js` del repo (este tiene el ranking por universo, sin desplegar).
  Un cambio al bot se aplica a los dos archivos.
- Apagar el bot: `linked_brokers.bot_enabled=false` en la base (no hace falta ssh).
- **Bot en Cocos (`workers/cocos-bot`, cuenta 72404, API de Primary):** misma
  regla de horario. La cuenta es COMPARTIDA con LP (opera a mano ahí): el bot
  no adopta órdenes ajenas y chequea la tenencia antes de vender. Encenderlo
  con órdenes reales (`pm2 start`) lo hace LP, no Claude.
- Stops del libro real: 1,5×ATR(14) diario, trailing que solo sube
  (`IOL_BOT_STOP_ATR`). Al mover un stop a mano se conserva `r_value`.

## Datos

- **Filtrar SIEMPRE por `user_id` en todo SELECT/UPDATE/DELETE de datos de
  usuario.** LP = `cafc5a8c-1cee-4d57-a765-6aacf1acc661` (lpiaggio@gmail.com).
  El mail de axongroup NO es su cuenta operativa.
- Antes de un borrado o update masivo: backup en una tabla
  `backup_<que>_<fecha>` y contar filas.
- Posiciones: nunca sumar `quantity` crudo; neto por `operation_type`, y cruzar
  contra la foto del broker (IOL por MCP; Cocos, pedirle a LP).
- Cocos: el extracto importado arma caja, FCI y posiciones. Borrar el archivo
  importado borra todo lo de ese broker. WTI y opciones se cargan a mano.
- Supabase project id: `utcltvmhpmlgolzyzkvl`.

## Código

- Frontend: monolito `src/MidasTerminal.jsx` (~2,2 MB, >45.000 líneas). Nunca
  regenerarlo entero: buscar con grep, leer rangos, reemplazar bloques puntuales.
- Parches grandes: script Python en `research/fase2/patch_*.py` que falla si un
  ancla no aparece exactamente una vez y no escribe nada si algo falla. Los
  heredocs de bash se comen las barras invertidas.
- Validar antes de subir: `npx vite build` (o esbuild + `node --check`).
- Deploy del front: commit (presente, sin emojis) + push a `main` → Vercel
  publica midas.ar solo. LP autorizó deployar sin preguntar; la pregunta se
  reserva para lo irreversible.
- Listas duplicadas front/worker que hay que tocar juntas: `FUND_UNIVERSE` y
  `FUND_SEGUIMIENTOS` (Fundamentals ↔ `workers/fundamentals-snapshot`).
- `api/` en Vercel está en el tope de 12 funciones: no agregar archivos ahí;
  colgar modos nuevos de un endpoint existente.

## Infra

- VPS: `ssh -p 5008 -i ~/.ssh/id_ed25519 midas@149.50.148.172`, workers en
  `~/workers/<nombre>/` con PM2. No son repos git: se despliega por `scp` y se
  deja backup `worker.js.bak-<fecha>`.
- Workers con `cron_restart` figuran "stopped" entre corridas; es normal.
- Los datos de mercado vienen de data912, IOL y Yahoo. Yahoo puede devolver
  instrumentos distintos en diario y horario: cruzar el cierre de las dos series.

## Investigación y bot

- Medir antes de construir. Backtests con separación in-sample / out-of-sample,
  control de azar con semillas y Sharpe deflactado.
- Todo link o idea que pase LP se evalúa contra el bot y la operatoria real, no
  en abstracto.
- Decisiones de posición: dos pasadas opuestas (bull y bear); el veredicto lo
  elige LP.
