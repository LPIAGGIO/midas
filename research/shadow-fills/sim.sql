-- sim.sql — lo que asumio el libro sombra, una linea por pata (padre + hijas tp_parcial). SOLO SELECT.
-- Columnas: leg, pid, ticker, exit_reason, qty, px_ars_entrada, px_ars_salida, pnl_ars_alt (vacio en las hijas),
--           created_at padre, entry_ts, exit_ts, intradia padre, intradia pata, entry_price, exit_price,
--           target, stop, stop_inicial, ratio, px_ars_orden padre, recolocaciones padre
select count(*), string_agg(array_to_string(array[left(l.id::text,8), left(p.id::text,8), l.ticker, l.exit_reason, l.qty::text,
  l.px_ars_entrada::text, l.px_ars_salida::text, coalesce(l.pnl_ars_alt::text,''),
  to_char(p.created_at at time zone 'UTC','MMDD"T"HH24MISS'), to_char(l.entry_ts at time zone 'UTC','MMDD"T"HH24MISS'),
  to_char(l.exit_ts at time zone 'UTC','MMDD"T"HH24MISS'), (case when p.intradia then '1' else '0' end),
  (case when l.intradia then '1' else '0' end), round(l.entry_price,4)::text, round(l.exit_price,4)::text,
  round(l.target,4)::text, round(l.stop,4)::text, round(l.stop_inicial,4)::text, l.ratio::text,
  coalesce(p.px_ars_orden::text,''), coalesce(p.recolocaciones::text,'')], ',', ''), '|' order by p.id, l.id) csv
from paper_iol_trades l
join paper_iol_trades p on p.modo='shadow' and p.status='closed' and p.exit_reason<>'tp_parcial'
     and p.ticker=l.ticker and p.entry_ts=l.entry_ts
where l.modo='shadow' and l.status='closed';
