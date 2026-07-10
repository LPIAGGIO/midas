# mtr-market-data

Worker PM2 que mantiene una conexión WebSocket abierta contra el visor A3 de
matbarofex (`matbarofex.primary.ventures`, sesión guest) y persiste los precios
live de los **futuros DLR** en Supabase.

## Arquitectura

```
matbarofex WS ──► worker PM2 ──► Supabase (tabla mtr_market_data)
                  in-memory cache         ▲
                  flush cada 2s           │
                                          │
                       Vercel /api/mtr-md ┘
                       (lee, calcula price/priceSource)
                                          │
                                          ▼
                                   Frontend Midas
```

- **Worker**: una sola conexión WS, suscripta a los 12 contratos DLR estándar.
  Cachea ticks en memoria y hace un upsert batched cada 2s a Supabase.
- **Endpoint Vercel** (`/api/mtr-md`, en el repo de Midas): lee la tabla y
  devuelve un snapshot con `price` y `priceSource` calculados según la
  prioridad: `last (<30min) > mid > last_stale > settlement`.
- **Frontend Midas**: hace polling al endpoint Vercel via `useSWR` cada 2-3s.

## Deploy en el VPS

```bash
cd ~/workers
git clone <tu-repo>/mtr-market-data.git
cd mtr-market-data
npm install --production

# Configurar credenciales
cp .env.example .env
# Editar .env con SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
nano .env

# Arrancar
mkdir -p logs
pm2 start ecosystem.config.js
pm2 save
pm2 logs mtr-market-data    # ver que llegue al "ws abierto"
```

## Tabla Supabase

El DDL está fuera del worker (se corrió manualmente). Schema:

```sql
create table public.mtr_market_data (
  security_id     text primary key,
  symbol          text not null,
  segment         text not null,
  seq             bigint,
  bid             numeric,
  bid_size        numeric,
  ask             numeric,
  ask_size        numeric,
  last            numeric,
  last_ts         timestamptz,
  open            numeric,
  high            numeric,
  low             numeric,
  close           numeric,
  close_ts        timestamptz,
  settlement      numeric,
  settlement_ts   timestamptz,
  reference       numeric,
  reference_ts    timestamptz,
  volume          numeric,
  volume_nominal  numeric,
  volume_effective numeric,
  open_interest   numeric,
  updated_at      timestamptz not null default now()
);
```

PK por `security_id` → tabla siempre 12 filas (una por DLR), nunca crece.

## Protocolo del WS (resumen)

- **URL**: `wss://matbarofex.primary.ventures/ws?session_id=&conn_id=`
  (session/conn vacíos = guest read-only).
- **Header obligatorio**: `Origin: https://matbarofex.primary.ventures`
  (Primary lo valida).
- **Suscripción** (cliente → server):
  ```json
  {"_req":"S","topicType":"md","topics":["md.rx_DDF_DLR_JUN26",...],"replace":true}
  ```
- **Keep-alive**: cliente manda string `"ping"` cada 40s, server devuelve `"pong"`.
- **Tick recibido** (string pipe-delimited):
  ```
  M:rx_DDF_DLR_JUN26|271031|810|1436.5|1437.5|50|1436.5|2026-05-26T16:47:16Z|...
  ```
  Posiciones: `ID|SEQ|BSZ|BID|ASK|ASZ|LST|LSTD|VOL|VOE|VON|LOW|HGH|OPN|OIN|CLS|CLSD|STL|STLD|REFP|REFD`.

## Operación

### Logs

```bash
pm2 logs mtr-market-data --lines 100
# Cada 60s loguea stats:
#   [INFO] stats {"ticksReceived":234,"flushes":30,"rowsUpserted":120,"errors":0,"bufferSize":0}
```

### Healthcheck rápido

Si los precios en Supabase tienen `updated_at` > 1 min sin renovarse durante
horario de rueda → el worker está zombie. Reiniciar con `pm2 restart mtr-market-data`.

### Reconnect

El cliente WS reconecta automático con backoff exponencial (1s, 2s, 4s, ...,
cap 60s). Si Primary cierra el WS o hay corte de red, la recuperación es
transparente. Los datos en Supabase quedan stale durante la ventana de reconnect;
el endpoint Vercel devuelve `stale: true` cuando los datos tienen > 60s.

### Vencimiento de contratos

`src/symbolsRegistry.js` tiene los 12 DLR hardcodeados. Cuando un contrato
vence (ej. DLR_MAY26 después del 31/05) y aparecen nuevos:

1. Editar `symbolsRegistry.js`: quitar el vencido, agregar el nuevo.
2. `pm2 restart mtr-market-data` para que reabra el WS con la nueva lista.

TODO: refresh automático desde `/api/v2/ref-data` cada 24h (no bloqueante).

## Testing local

```bash
# Probar el parser sin conectar a nada
npm run test:parser

# Ejecutar el worker contra una Supabase local/test
SUPABASE_URL=http://localhost:54321 \
SUPABASE_SERVICE_ROLE_KEY=eyJ... \
LOG_LEVEL=debug \
node src/index.js
```

## Variables de entorno

Ver `.env.example`. Las críticas:

| Variable | Default | Descripción |
|---|---|---|
| `SUPABASE_URL` | — | URL del proyecto Supabase (obligatorio) |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Service role key, no la anon (obligatorio) |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `FLUSH_INTERVAL_MS` | `2000` | Ventana de batching antes de upsert |
| `PING_INTERVAL_MS` | `40000` | Frecuencia del ping al server WS |
| `WS_IDLE_TIMEOUT_MS` | `90000` | Tiempo sin recibir → reconnect forzado |
