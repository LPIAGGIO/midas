-- Pantalla Fondos (Fase 1, 17/10/2026). Datos de mercado: lectura pública,
-- escribe solo el worker `fondos` con la service key. Ninguna tabla guarda
-- datos de usuario: el cruce con la cartera se calcula en el front.

create table if not exists public.fondos (
  ticker          text primary key,
  universo        text not null check (universo in ('etf_cedear','etf_usa','etf_ucits','fci')),
  nombre          text,
  familia         text,
  categoria       text,
  tipo_legal      text,            -- ETF | UIT | trust | ETN
  cik             text,
  series_id       text,
  comparador      text,            -- símbolo de Yahoo del índice elegido a mano
  comparador_nombre text,
  comparador_nota text,            -- "índice de precio, sin dividendos", "en USD vía BRL=X", etc.
  expense_ratio   numeric,         -- fracción (0.0035 = 0,35%)
  aum_usd         numeric,
  yield           numeric,         -- fracción, de Yahoo
  precio_usd      numeric,
  ret             jsonb,           -- {fondo:{m1,m3,a1,a5}, comp:{...}, spy:{...}, yahoo:{...}, cat:{...}, hasta:"YYYY-MM-DD"}
  vol_1a          numeric,         -- fracción anualizada, retornos diarios en USD
  max_caida_1a    numeric,         -- fracción negativa
  dividendos      jsonb,           -- [{fecha, monto}] últimos 12 meses
  div_12m_usd     numeric,
  sectores        jsonb,           -- {technology:0.99,...} de Yahoo (taxonomía de 11 sectores)
  paises          jsonb,           -- {US:0.83, TW:0.09,...} del N-PORT
  top10           jsonb,           -- [{ticker, nombre, peso}] de Yahoo, el más fresco
  holdings_fuente text,            -- ssga | nport | yahoo | trust
  holdings_fecha  date,
  holdings_n      integer,
  nport_fecha     date,
  nport_accession text,
  actualizado_at  timestamptz default now()
);

create table if not exists public.fondos_cedear (
  ticker          text primary key references public.fondos(ticker) on delete cascade,
  ratio           numeric,         -- CEDEARs por cada cuotaparte del ETF
  ratio_fuente    text,            -- comafi | derivado
  ratio_derivado  numeric,         -- sin redondear, del último snapshot
  ratio_desvio    numeric,         -- ratio_derivado / ratio - 1
  ratio_dudoso    boolean default false,
  ratio_desde     date,
  cusip           text,
  ccl_ref         numeric,         -- CCL de referencia del snapshot
  cedear_ars      numeric,
  actualizado_at  timestamptz default now()
);

create table if not exists public.fondos_holdings (
  fondo     text not null,
  fecha     date not null,
  clave     text not null,         -- cusip, o isin, o nombre normalizado si no hay ninguno
  fuente    text not null,         -- ssga | nport | trust
  cusip     text,
  isin      text,
  emisor6   text,                  -- primeros 6 del CUSIP: agrupa clases (GOOG/GOOGL)
  ticker    text,
  nombre    text,
  peso      numeric,               -- % del patrimonio (17.5 = 17,5%)
  pais      text,
  tipo      text,                  -- assetCat del N-PORT (EC, DBT, ...) o "commodity"
  primary key (fondo, fecha, clave)
);
create index if not exists fondos_holdings_fondo_peso on public.fondos_holdings (fondo, fecha, peso desc);
create index if not exists fondos_holdings_emisor on public.fondos_holdings (emisor6);

create table if not exists public.valores_maestro (
  ticker      text primary key,
  cusip       text,
  emisor6     text,
  isin        text,
  nombre      text,
  sector      text,                -- taxonomía de Yahoo
  industria   text,
  pais        text,
  fuente      text,                -- comafi | ssga | openfigi | yahoo
  actualizado_at timestamptz default now()
);
create index if not exists valores_maestro_cusip on public.valores_maestro (cusip);
create index if not exists valores_maestro_emisor on public.valores_maestro (emisor6);

alter table public.fondos          enable row level security;
alter table public.fondos_cedear   enable row level security;
alter table public.fondos_holdings enable row level security;
alter table public.valores_maestro enable row level security;

drop policy if exists fondos_read on public.fondos;
create policy fondos_read on public.fondos for select using (true);
drop policy if exists fondos_cedear_read on public.fondos_cedear;
create policy fondos_cedear_read on public.fondos_cedear for select using (true);
drop policy if exists fondos_holdings_read on public.fondos_holdings;
create policy fondos_holdings_read on public.fondos_holdings for select using (true);
drop policy if exists valores_maestro_read on public.valores_maestro;
create policy valores_maestro_read on public.valores_maestro for select using (true);

grant select on public.fondos, public.fondos_cedear, public.fondos_holdings, public.valores_maestro to anon, authenticated;
