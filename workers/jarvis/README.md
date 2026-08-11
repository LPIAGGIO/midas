# Jarvis

Asistente autónomo personal. Siempre prendido en el VPS, se le habla desde el celular.

## La idea en una línea

**Un solo cerebro, una sola memoria, un solo catálogo de tools, varios clientes.**

El error que mata estos proyectos es armar un segundo asistente que no sabe lo que hizo el primero. Por eso el cerebro vive en un solo lado y los clientes son intercambiables.

```
                    ┌─────────────────────────────┐
  Telegram  ──────► │  worker jarvis (VPS, PM2)   │
  Web       ──────► │  Claude Agent SDK           │ ◄──► Supabase (jarvis_*)
  ESP32-S3  ──────► │  + política de permisos     │      memoria + auditoría
   (después)        └─────────────────────────────┘
                              │
                              └──► MCPs (IOL, Supabase, TradingView...)
```

- **Cerebro**: `@anthropic-ai/claude-agent-sdk` — el mismo harness de Claude Code corriendo como servicio. Trae de fábrica las tools (leer, escribir, editar, bash, grep, búsqueda web), el loop de agente, manejo de contexto y soporte MCP. No se reimplementa nada.
- **Memoria**: Supabase, tablas `jarvis_*`, con `user_id` desde el día 1. Multi-tenant listo aunque hoy haya un solo usuario.
- **Clientes**: v1 es Telegram. La web y el ESP32 se enchufan después al mismo contrato sin tocar el cerebro.

## La regla de oro

Toda acción con efecto pasa por **propose → confirm → execute → log**.

| Riesgo | Qué es | Qué pasa |
|---|---|---|
| `read` | leer archivos, buscar, consultar precios | se ejecuta sola |
| `write` | escribir, editar, comandos de shell, mandar mensajes | botón de confirmación |
| `money` | órdenes, cauciones, FCI, transferencias | botón **siempre**, nunca automatizable |

Todo se decide en un solo archivo: [`lib/policy.js`](lib/policy.js). Es fail-closed: lo que no reconoce, lo pregunta.

Hay además una lista de **deny duro** — cosas que no se ejecutan aunque aprietes aprobar: `rm -rf /`, apagar el server, `curl | sh`, leer `.env` o claves SSH, `pm2 delete`, `DROP TABLE`, y tocar sus propias tablas de auditoría y permisos. Un agente que puede editar su propio log de auditoría no tiene log de auditoría.

Las acciones que aprobás repetidamente se pueden graduar a automáticas con el botón "no preguntar más por esto" (nunca las de plata).

## Estado

| Pieza | Estado |
|---|---|
| Schema Supabase (6 tablas + RLS) | aplicado |
| Política de permisos + 40 tests | pasa |
| Worker: Telegram, sesiones, memoria, aprobaciones, topes de gasto | escrito, sin desplegar |
| Bot de Telegram propio | **falta: BotFather** |
| `ANTHROPIC_API_KEY` en el VPS | **falta** |
| Fase 2 (proactivo: brief matutino, alertas) | pendiente |
| Cliente web / ESP32 | pendiente |

## Para ponerlo a andar

1. **Crear el bot**: hablarle a [@BotFather](https://t.me/BotFather) → `/newbot` → nombre y usuario (ej. `midas_jarvis_bot`) → copiar el token.

   > No se puede reusar el token de `@midas_ar_BOT`: Telegram entrega cada update una sola vez por token, y el worker `telegram-notifier` ya es dueño de ese long-poll. Dos pollers sobre el mismo token se roban los mensajes entre sí.

2. **Sacar una API key** de Anthropic en [console.anthropic.com](https://console.anthropic.com). Es lo que paga el cerebro; la suscripción de Claude no sirve para esto.

3. **Deploy** (igual que el resto de los workers: SCP directo, el dir del VPS no es un repo git):

   ```bash
   ssh -p 5008 midas@149.50.148.172 'mkdir -p ~/workers/jarvis/lib ~/jarvis-workspace'
   scp -P 5008 -r workers/jarvis/* midas@149.50.148.172:~/workers/jarvis/
   ssh -p 5008 midas@149.50.148.172 'cd ~/workers/jarvis && cp .env.example .env && nano .env && npm install && node selftest.js'
   ssh -p 5008 midas@149.50.148.172 'cd ~/workers/jarvis && pm2 start ecosystem.config.js && pm2 save'
   ```

4. **Vincular el chat**: generar un `link_code` y mandarle `/start <código>` al bot desde la app de Telegram (no desde el navegador — el botón START del `t.me` no manda el `/start` si no estás logueado en web.telegram.org).

   ```sql
   insert into jarvis_channel_links (user_id, channel, channel_ref, link_code)
   values ('<tu user_id>', 'telegram', 'pending', 'unclave');
   ```

## Costo

Lo que hace caro un agente siempre prendido no es el modelo: es despertarlo seguido reenviando el mismo contexto. Tres frenos:

- `JARVIS_MAX_BUDGET_USD` — tope por consulta (default 1 USD).
- `JARVIS_DAILY_BUDGET_USD` — tope por día; si se pasa, no arranca turnos nuevos (default 10 USD).
- `/gasto` — cuánto va gastado hoy.

Cada respuesta guarda su `cost_usd` en `jarvis_messages`, así que el gasto es auditable por conversación.

## Comandos

| Comando | Qué hace |
|---|---|
| *(texto libre)* | le hablás normal |
| `/nuevo` | arranca hilo limpio (no borra la memoria de largo plazo) |
| `/gasto` | gasto del día |
| `/pendientes` | acciones esperando confirmación |
| `/ping` | test del canal |

## Tablas

| Tabla | Para qué |
|---|---|
| `jarvis_sessions` | hilos de conversación por canal, con el `sdk_session_id` para retomar |
| `jarvis_memory` | hechos, preferencias, proyectos y referencias que sobreviven a la sesión |
| `jarvis_actions` | **auditoría**: toda acción propuesta, aprobada, denegada o ejecutada |
| `jarvis_allowlist` | lo graduado a automático |
| `jarvis_messages` | transcripción + costo por mensaje |
| `jarvis_channel_links` | qué chat de qué canal es de qué usuario |

## Deuda conocida

- **RAM**: el VPS tiene ~2 GB y el Agent SDK levanta un subproceso por turno. `max_memory_restart` está en 500M para que un cuelgue no se lleve puesto a `mtr-market-data`. Hay que mirarlo con carga real.
- **Un turno por usuario a la vez**: si le escribís mientras piensa, te pide que esperes. Suficiente para un usuario, no para varios.
- **Las aprobaciones viven en memoria del proceso**: si el worker reinicia con una confirmación colgada, esa acción queda `expired` y el turno se pierde. Sobrevive el registro, no el turno.
- **El workspace del agente** (`JARVIS_WORKSPACE`) es lo que puede leer y escribir. Arranca apuntando a un directorio vacío a propósito: ampliarlo es una decisión, no un default.
