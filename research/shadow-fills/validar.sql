-- validar.sql — re-ejecuta las salidas/entradas del libro sombra contra el libro real del CEDEAR.
-- SOLO SELECT. Se corre dos veces cambiando el literal de la CTE prm ('s' = estricto, 'l' = laxo).
-- Devuelve UNA fila con un CSV compacto (una linea por pata). La columna pad (70 KB de 'x') existe solo
-- para que la herramienta MCP vuelque el resultado a archivo en vez de truncarlo; data/extraer.mjs la ignora.
-- Volcados: data/strict_raw.txt (modo 's') y data/laxo_raw.txt (modo 'l').
--
-- Posicion = fila padre (exit_reason <> 'tp_parcial') + sus hijas tp_parcial (mismo ticker y entry_ts).
-- Se excluyen las hijas cuyo padre sigue abierto (20 filas): la posicion no cerro.
--
-- ENTRADA (por posicion, ventana [created_at padre, max(exit_ts) de sus patas]):
--   estricto: primer snapshot con 0 < c_ask <= L, L = px_ars_entrada
--   laxo:     primer snapshot con 0 < c_last <= L Y c_vol subio contra el snapshot anterior del mismo dia
--             (hubo operacion; sin esto el c_last de la apertura es el cierre de ayer)
--   precio de entrada = L (conservador: nunca mejor que el limite)
-- SALIDA (por pata, siempre despues de te = entrada real):
--   stop / trailing / tp_parcial: el disparo lo decide el subyacente (el sim ya lo midio con
--     confirmacion de 10 min); se vende a mercado => c_bid del primer snapshot >= max(exit_ts sim, te).
--   target: venta limite descansando a T = target_usd * ratio de entrada (asi se espeja en Cocos).
--     se ejecuta en el primer snapshot >= te con c_bid >= T (estricto) o c_last >= T con volumen (laxo),
--     precio = T. Si antes (o nunca) el subyacente toca el stop final (u_bid, o u_last si no hay bid)
--     despues de max(te, exit_ts sim), sale a c_bid de ese snapshot. Si no pasa nada: se marca al
--     ultimo c_bid disponible (posicion abierta).
with prm as (select 's'::text as modo),
legs as (
  select l.id, l.ticker, l.exit_reason, l.qty, l.exit_ts, l.target, l.stop,
         p.id pid, p.created_at c0, p.entry_ts, p.px_ars_entrada L, p.px_ars_orden lord, p.ratio
  from paper_iol_trades l
  join paper_iol_trades p on p.modo='shadow' and p.status='closed' and p.exit_reason<>'tp_parcial'
       and p.ticker=l.ticker and p.entry_ts=l.entry_ts
  where l.modo='shadow' and l.status='closed'
),
pos as (select pid, ticker, c0, entry_ts, L, lord, max(exit_ts) x1 from legs group by 1,2,3,4,5,6),
mins as (select distinct date_trunc('minute', snapshot_at) m from cedear_fv_log where snapshot_at >= '2026-09-04'),
fill as (
  select pos.*,
   case when (select modo from prm)='s' then
     (select min(f.snapshot_at) from cedear_fv_log f where f.symbol=pos.ticker and f.snapshot_at between pos.c0 and pos.x1
        and f.c_ask>0 and f.c_ask<=pos.L)
   else
     (select min(f.snapshot_at) from cedear_fv_log f where f.symbol=pos.ticker and f.snapshot_at between pos.c0 and pos.x1
        and f.c_last>0 and f.c_last<=pos.L
        and f.c_vol > coalesce((select case when g.snapshot_at::date=f.snapshot_at::date then g.c_vol else 0 end
              from cedear_fv_log g where g.symbol=f.symbol and g.snapshot_at<f.snapshot_at order by g.snapshot_at desc limit 1),0))
   end te,
   (select count(*) from cedear_fv_log f where f.symbol=pos.ticker and f.snapshot_at between pos.c0 and pos.x1) nlog,
   (select count(*) from mins where mins.m between pos.c0 and pos.x1) nrun,
   (select f.c_ask from cedear_fv_log f where f.symbol=pos.ticker and f.snapshot_at between pos.entry_ts - interval '1 minute' and pos.entry_ts + interval '3 minutes'
       and f.c_ask>0 order by f.snapshot_at limit 1) ask_at_fill,
   (select min(f.c_ask) from cedear_fv_log f where f.symbol=pos.ticker and f.snapshot_at between pos.c0 and pos.x1 and f.c_ask>0) min_ask,
   (select min(f.snapshot_at) from cedear_fv_log f where f.symbol=pos.ticker and f.snapshot_at between pos.c0 and pos.x1
        and f.c_ask>0 and f.c_ask<=pos.lord) te_ord
  from pos
),
lx as (
  select legs.*, fill.te, fill.nlog, fill.nrun, fill.ask_at_fill, fill.min_ask, fill.te_ord,
    round(legs.target*legs.ratio) T,
    (select max(snapshot_at) from cedear_fv_log f where f.symbol=legs.ticker and f.c_bid>0) t_last
  from legs join fill on fill.pid=legs.pid
),
ex as (
  select lx.*,
    -- venta a mercado (stop/trailing/tp_parcial)
    b.snapshot_at tb, b.c_bid pb,
    -- target descansando
    case when lx.exit_reason='target' and lx.te is not null then
      case when (select modo from prm)='s' then
        (select min(f.snapshot_at) from cedear_fv_log f where f.symbol=lx.ticker and f.snapshot_at>=lx.te and f.c_bid>=lx.T)
      else
        (select min(f.snapshot_at) from cedear_fv_log f where f.symbol=lx.ticker and f.snapshot_at>=lx.te and f.c_last>=lx.T
           and f.c_vol > coalesce((select case when g.snapshot_at::date=f.snapshot_at::date then g.c_vol else 0 end
              from cedear_fv_log g where g.symbol=f.symbol and g.snapshot_at<f.snapshot_at order by g.snapshot_at desc limit 1),0))
      end end tt,
    case when lx.exit_reason='target' and lx.te is not null then
      (select min(f.snapshot_at) from cedear_fv_log f where f.symbol=lx.ticker and f.snapshot_at>=greatest(lx.te, lx.exit_ts)
         and f.c_bid>0 and coalesce(nullif(f.u_bid,0), f.u_last) <= lx.stop) end ts
  from lx
  left join lateral (select f.snapshot_at, f.c_bid from cedear_fv_log f
       where lx.exit_reason<>'target' and lx.te is not null and f.symbol=lx.ticker
         and f.snapshot_at>=greatest(lx.exit_ts, lx.te) and f.c_bid>0 order by f.snapshot_at limit 1) b on true
),
fin as (
  select ex.*,
    (select c_bid from cedear_fv_log f where f.symbol=ex.ticker and f.snapshot_at=ex.ts and f.c_bid>0 limit 1) pstop,
    (select c_bid from cedear_fv_log f where f.symbol=ex.ticker and f.snapshot_at=ex.t_last and f.c_bid>0 limit 1) plast
  from ex
)
select (select modo from prm) modo, count(*) n, string_agg(array_to_string(array[
   left(id::text,8), left(pid::text,8), ticker, exit_reason, qty::text, L::text, T::text, nlog::text, nrun::text, ask_at_fill::text, min_ask::text,
   to_char(te at time zone 'UTC','MMDD"T"HH24MISS'),
   to_char(te_ord at time zone 'UTC','MMDD"T"HH24MISS'),
   to_char(tb at time zone 'UTC','MMDD"T"HH24MISS'), pb::text,
   to_char(tt at time zone 'UTC','MMDD"T"HH24MISS'),
   to_char(ts at time zone 'UTC','MMDD"T"HH24MISS'), pstop::text,
   to_char(t_last at time zone 'UTC','MMDD"T"HH24MISS'), plast::text], ',', ''), '|' order by pid, id) csv, repeat('x', 70000) pad  -- pad: fuerza a que la herramienta MCP vuelque el resultado a archivo
from fin;
