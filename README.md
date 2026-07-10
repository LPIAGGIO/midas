# Midas

**Terminal de inversión personal para el mercado argentino.** Cartera consolidada
multi-broker (Cocos + IOL), P&L por instrumento, libro de operaciones importado
del CSV de Cocos, análisis de dólar/carry/CEDEARs, indicadores macro del BCRA, y
un panel de administración con roles. App multi-usuario con seguridad por fila
(RLS) en Supabase.

Producción: **[midas.ar](https://midas.ar)** · Owner: Leonardo Piaggio.

> Antes se llamaba *EcoFlow*. El monolito y algunas cache keys (`ecoflow_*`)
> conservan el nombre viejo a propósito (no romper cache de usuarios).

---

## Arquitectura

Midas tiene cuatro piezas de infraestructura:

| Pieza | Qué corre | Dónde |
|---|---|---|
| **Frontend** | React 18 + Vite + Tailwind, monolito `src/MidasTerminal.jsx` | Vercel (auto-deploy en push a `main`) → midas.ar |
| **API proxies** | Vercel Serverless Functions (`api/*.js`), proxy a feeds externos con CORS/cache | Vercel |
| **Base de datos** | Postgres + Auth (Google OAuth) + RLS + Edge Functions + pg_cron | Supabase (`utcltvmhpmlgolzyzkvl`) |
| **Workers** | Procesos Node bajo PM2 (feeds de mercado, sync IOL, settlements de futuros, notificaciones) | VPS Hetzner (`ssh -p 5008 midas@149.50.148.172`) |

```
Usuario ──▶ midas.ar (React) ──┬─▶ Supabase (positions, cash, libro, auth, RLS)
                               ├─▶ /api/* (Vercel proxies) ─▶ data912 / BYMA / BCRA / IOL / Yahoo / A3
                               └─▶ Supabase Edge Functions (iol-sync, iol-quotes-close, ...)
                                        ▲
VPS PM2 workers ──▶ Supabase (mtr-market-data WS, iol-*-sync, futures-settlement, news-pulse, ...)
```

### Seguridad (RLS + roles)
- Todas las tablas con `user_id` tienen RLS por `auth.uid() = user_id`.
- **Admin god-mode** (`/admin`, solo `lpiaggio@gmail.com`): función `is_admin()`
  SECURITY DEFINER + policies permissivas `admin_all_<tabla>` (OR-combinadas) →
  el admin ve/edita/borra todo, el usuario normal solo lo suyo.
- Módulos visibles por usuario: `profiles.allowed_modules` (jsonb, `null` = ve
  todo). `status='suspended'` bloquea el acceso. El enforcement de módulos es UX;
  la data siempre está protegida por RLS.

---

## Estructura del repo

```
src/
  MidasTerminal.jsx      Monolito React (~36k líneas). Gate de auth + <MidasApp>.
  auth/                  AuthContext (Google OAuth via Supabase).
  lib/                   Cliente Supabase y helpers.
  cedearCatalog.js       ~425 CEDEARs (ticker, nombre, ratio de conversión).
  bondMaturities.js      Vencimientos de bonos/letras.
  dlrContracts.js        Contratos de futuro DLR.
api/                     Vercel Serverless (proxies a feeds, ver abajo).
supabase/
  migrations/            Migraciones SQL (schema + RLS + RPCs).
  functions/             Edge Functions (Deno).
workers/                 Workers Node (PM2 en el VPS). Ver abajo.
public/                  Estáticos.
```

---

## Feed de datos / precios

Regla de oro: **los precios salen de feeds gratis, NO se gasta cupo de IOL en
ver precios** (IOL se reserva para auth, estado de cuenta y ejecutar órdenes).

- **data912** (`/api/data912`): CEDEARs y acciones AR + acciones USA (subyacentes).
- **BYMA Open Data** (`/api/byma/*`): bonos.
- **MAE** (`/api/mae`, boletín): cierres de renta fija.
- **matbarofex / A3** (worker `mtr-market-data` vía WebSocket → tabla
  `mtr_market_data`): futuros DLR y cauciones en tiempo real.
- **BCRA** (`/api/bcra`, API v4.0): reservas, base monetaria, TC oficial, banda,
  TAMAR, inflación.
- **Yahoo Finance** (`/api/fundamentals`): fallback de precios USA + fundamentals
  de los subyacentes de CEDEARs.
- **dolarapi / criptoya**: dólares de referencia y cripto.
- **IOL** (`iol-quotes-close`, cierre 17:30): `cierreAnterior` oficial para que el
  P&L del día de bonos espeje a Cocos (el `previousClose` gratis viene mal escalado).

---

## Módulos principales (frontend)

- **Portfolio / Cartera consolidada**: neteo por (ticker, broker, settlement),
  valuación a mercado, caja por moneda (ARS / USD-MEP / USD-CCL), liquidez
  proyectada (CI / T1 / 30/60/90d).
- **P&L por Instrumento**: realizado + no realizado por ticker, comisiones
  acumuladas, cauciones (colocadora/tomadora).
- **Reporte de cartera** (estilo Balanz): costo, valor a mercado, TNA por tenencia.
- **Libro de operaciones / Importaciones**: importa el CSV `movimientos_cuenta` de
  Cocos como **fuente de verdad del libro** (trades, FCI, caución, aranceles,
  rentas). Deriva posiciones + caja + comisiones. Lotes de import borrables.
- **CEDEARs · Precio USA**: subyacente USA en vivo + teórico ARS = (USD × CCL) ÷
  ratio (para anticipar la corrección local cuando AR está cerrado).
- **Analizadores**: Sintético DLR, Carry Trade, Futuros vs Caución, Flujo de
  Posiciones, Ejecución Inteligente (CEDEAR vs papel USA directo).
- **Indicador Macro · BCRA**: reservas, compras/ventas, banda, TAMAR, REM.
- **Bot Trading / Paper**: seguimiento de momentum CEDEARs (real IOL + paper).
- **Admin** (`/admin`): usuarios, roles, permisos de módulos, borrado de datos.

---

## Workers (VPS, PM2)

Versionados en `workers/`. Se deployan **copiando el archivo al VPS** (no hay git
en el VPS): `scp -P 5008 workers/<w>/worker.js midas@149.50.148.172:~/workers/<w>/`.
Varios corren por PM2 `cron_restart` (aparecen "stopped" entre corridas).

| Worker | Qué hace |
|---|---|
| `mtr-market-data` | WS a A3/matbarofex → `mtr_market_data` (futuros DLR + cauciones live). Persistente. |
| `futures-settlement` | 01:00 ART. Captura el settlement del día y genera ajustes de acreditación de futuros (excluye los derivados del libro). |
| `iol-positions-sync` / `iol-cash-sync` | Sincronizan posiciones/caja de IOL. |
| `mae-boletin` | Cierres de renta fija del boletín MAE → `daily_close_prices`. |
| `news-pulse` | Cada 30 min: Google News RSS → clasifica → `market_news` (Pulso de Mercado). |
| `telegram-notifier` | Alertas de precio / posición al bot `@midas_ar_BOT`. |
| `caucion-acreditacion` | Acreditación de cauciones. |
| `equity-snapshot` | Snapshot diario del patrimonio → curva de NAV. |
| `cedear-arb-logger` | Loguea mispricing CEDEAR vs subyacente USA. |
| `paper-cedears` / `paper-trader` | Motores de paper trading. |
| `rem-sync` | Sincroniza el REM (Relevamiento de Expectativas del BCRA). |

> Nota: algunos workers viven solo en el VPS (ej `mtr-market-data`, `iol-*-sync`,
> `mae-boletin`); el objetivo es versionar todos bajo `workers/`.

---

## Edge Functions (Supabase, Deno)

Fuente en `supabase/functions/`, disparadas por `pg_cron`.

| Function | Qué hace |
|---|---|
| `iol-auth` | Login OAuth de IOL, guarda tokens en `linked_brokers`. |
| `iol-sync` | Keepalive del token IOL cada 10 min (los tokens expiran a los 20 min). |
| `iol-quotes-close` | 17:30 L-V: cierre oficial de IOL → `iol_quotes` (P&L del día). |
| `canje-snapshot` | Snapshot diario de canje de soberanos. |
| `cedear-fv-snapshot` | Logger de fair-value CEDEAR vs subyacente (overlap BA/NYSE). |
| `crypto-tick-snapshot` | Microestructura crypto (Kraken, público). |
| `kraken-trade` | (Legacy, paper crypto — conservado, sin uso activo.) |

---

## API proxies (Vercel, `api/*.js`)

`data912` · `byma/*` · `mae` · `mtr-md` · `bcra` · `bcra-rem` · `a3-cauciones` ·
`dolares` · `cripto` · `fundamentals` (Yahoo) · `refresh-instruments` ·
`snapshot-settlements`. Todos proxean feeds externos con CORS y cache; evitan
exponer keys y sortean CORS del navegador.

---

## Modelo de datos (tablas clave, Supabase)

- **`positions`** — posiciones (lotes). Se netean por (ticker, broker, settlement).
  `extra.source`: `csv_matriz` (import Portfolio Cocos), `derivado_libro` (import
  movimientos), `iol-positions-sync` (IOL). Convenciones: bonos /100, futuros
  ×mult, opciones ×100.
- **`cash_movements`** — efectivo por moneda. La caja del día excluye
  `movement_date > hoy` (pendientes de liquidar → liquidez proyectada).
- **`libro_movimientos`** — cuenta corriente completa de Cocos (dedup por
  `nro_comprobante`). Fuente de verdad del libro.
- **`import_batches`** — lotes de importación borrables.
- **`linked_brokers`** — tokens IOL (mantenidos por `iol-sync`).
- **`profiles`** / **`admin_users`** — roles, `allowed_modules`, `status`.
- **`api_quotas`** / **`api_call_log`** — cupo de API IOL (25k/mes).
- **`futures_daily_adjustments`** / **`futures_settlements_history`** — MTM y
  acreditación de futuros.
- **`iol_quotes`** — último + cierre anterior de IOL (P&L del día).
- **`mtr_market_data`** — futuros/cauciones live (worker WS).
- **`market_news`** — Pulso de Mercado. **`cedear_fv_log`** / **`crypto_tick_log`**
  — loggers de microestructura. **`daily_close_prices`** — cierres MAE/BYMA.

---

## Deploy

| Qué | Cómo |
|---|---|
| **Frontend** | `git push origin main` → Vercel auto-deploya a midas.ar. |
| **Edge functions** | Supabase CLI / MCP `deploy_edge_function`. Cron con `pg_cron`. |
| **Workers VPS** | `scp -P 5008 -i ~/.ssh/id_ed25519 workers/<w>/worker.js midas@149.50.148.172:~/workers/<w>/`. Cron toma el archivo nuevo; probar con `node worker.js --dry-run`. |
| **Migraciones** | Supabase MCP `apply_migration` (o CLI). |

**Reglas de oro del workflow:**
- Nunca regenerar el monolito completo — solo bloques buscar-y-reemplazar.
- Validar antes de deployar: `npm run build` (o `npx esbuild --loader:.jsx=jsx
  --format=esm src/MidasTerminal.jsx > built-check.js && node --check built-check.js`).
- Commit en presente, sin emojis. Push a `main` = deploy directo (sin esperar OK).
- No renombrar cache keys `ecoflow_*` (rompe cache sin beneficio).

---

## Desarrollo local

```bash
npm install
npm run dev      # Vite dev server
npm run build    # build de producción (valida el monolito)
```

Variables de entorno (`.env`, no versionado): `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY` (workers/edge), keys de Supabase para el frontend
(Vite `VITE_*`). Los workers tienen su propio `.env` en cada dir.

---

## Stack

React 18 · Vite · Tailwind CSS · Supabase (Postgres, Auth, RLS, Edge Functions,
pg_cron) · Vercel (hosting + serverless) · Node/PM2 (workers VPS) · Deno (edge).
