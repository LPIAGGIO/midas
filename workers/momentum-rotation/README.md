# momentum-rotation

Rotación mensual de la cartera momentum de CEDEARs en IOL (Top-8 equal-weight,
**plata real**). Automatiza las reglas frías de la tarea agendada
`~/.claude/scheduled-tasks/rebalanceo-momentum-cedears-iol/SKILL.md`.

**ESTADO: BORRADOR — no deployado. No arrancar en el VPS sin revisión de LP.**

## Qué hace

1. Chequea día hábil BYMA (finde/feriado → avisa por Telegram y termina).
2. Lee el Top-8 fresco de `momentum_signal` (id=`current`, lo escribe
   `paper-cedears` a diario). Señal con más de 4 días → aborta sin operar.
3. Lee las tenencias reales del portfolio IOL (solo CEDEARs) y les **resta lo
   del bot niveles-auto** (`paper_iol_trades` con `modo='real'` y status
   `pending`/`open`). Regla de convivencia: lo del bot no se vende y su
   reserva de cash (`IOL_BOT_CAP_REAL` − nocional comprometido) no se gasta.
4. **Vende** lo que salió del Top-8: al bid, límite en tick (piso), en tramos
   de hasta `MOMENTUM_TRAMO_ARS` (default $3M), con guardia de precio (bid
   >2% bajo el cierre anterior → saltea y avisa). Espera cada fill
   **confirmado por IOL** (estado terminada/ejecutada/cumplida con
   `precioOperado`; timeout 10 min → cancela la orden y sigue).
5. **Compra** equal-weight con el producido + la caja rotable: primero los
   dólares MEP (especie D del CEDEAR, contra su propio libro en USD), después
   los pesos al ask (spread >2% → saltea). Límite de compra redondeado al
   tick para ARRIBA (garantiza el fill; el límite es máximo, no precio).
   Sin apalancamiento, todo a T1.
6. Telegram en cada paso + resumen final.

### Aporte y sanity check

Caja rotable = disponible ARS − reserva del bot. Debería rondar el aporte del
mes (~$1,5M). Si da fuera de `[MOMENTUM_APORTE_MIN, MOMENTUM_APORTE_MAX]`
(default $1,0M–$2,0M), el despliegue de **caja nueva se congela**: rota solo
con el producido de las ventas del día y avisa la cifra a LP por Telegram.

## Dry-run

```bash
node worker.js --dry-run
# o
MOMENTUM_DRY_RUN=1 node worker.js
```

Calcula el plan completo (ventas, compras, cantidades, límites en tick desde
los libros vivos de IOL, con data912 de respaldo), lo loguea y manda un
Telegram marcado **"DRY-RUN — nada ejecutado"**. No coloca ninguna orden.
Necesita igual el `.env` y el token IOL vigente en `linked_brokers` (las
tenencias salen del portfolio real, nunca de supuestos).

## Env

Symlink al `.env` de niveles-auto (convención de los workers del VPS):

```bash
ln -s ../niveles-auto/.env .env
```

Usa: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`,
`IOL_BOT_USER` (default cuenta de LP), `IOL_BOT_CAP_REAL` (**obligatorio** —
sin el cap del bot no hay reserva y el worker aborta), y opcionales
`MOMENTUM_DRY_RUN`, `MOMENTUM_APORTE_MIN/MAX`, `MOMENTUM_TRAMO_ARS`.

## PM2 (cron mensual, one-shot)

Mismo patrón que paper-cedears (one-shot: `autorestart: false` +
`cron_restart`; queda "stopped" entre corridas). `ecosystem.config.js`
sugerido — **OJO**: el cron pedido es día 15 10:47 ART, pero la SKILL de la
tarea agendada dice día 16 10:45. Confirmar con LP cuál manda antes de
deployar (y que no corran los dos el mismo mes).

```js
module.exports = {
  apps: [
    {
      name: "momentum-rotation",
      script: "./worker.js",
      cwd: "/home/midas/workers/momentum-rotation",
      exec_mode: "fork",
      instances: 1,
      autorestart: false,
      cron_restart: "47 10 15 * *",   // día 15, 10:47 ART (TZ del VPS = America/Argentina)
      out_file: "logs/out.log",
      error_file: "logs/error.log",
      time: true,
    },
  ],
};
```

Arranque manual equivalente:

```bash
pm2 start worker.js --name momentum-rotation --no-autorestart --cron-restart "47 10 15 * *"
```

Si el día 15 cae finde/feriado el worker avisa y NO opera; el reintento del
próximo hábil hoy es manual (`pm2 restart momentum-rotation`) o vía la tarea
de reintento de la SKILL — este worker no crea tareas agendadas de Claude.

## Qué NO hace (a propósito)

- No toca letras ni cauciones: solo CEDEARs, y solo los netos del bot.
- No refresca el token IOL (keep-alive de Supabase) ni escribe `positions`
  (sincroniza `iol-positions-sync` solo — no cargar posiciones a mano).
- No tiene flujo DDJJ: el canal REST no expone el get/accept del MCP. Si IOL
  exige DDJJ en una orden, esa orden falla y avisa por Telegram.
- Lo que no entra hoy por el aforo T+1 (~85% del producido) queda en caja; se
  completa al liquidar (corrida manual o el mes que viene).
