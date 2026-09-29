-- subyacente.sql — ¿el SUBYACENTE en dolares toco el limite despues de creada la orden? SOLO SELECT.
-- El sim da el fill si el MINIMO DE LA RUEDA (Yahoo 5m, range=1d, incluye lo operado ANTES de crear la
-- orden) es <= entry_limit (worker-deploy.js, minRueda + linea ~2150). Aca se mide con el log por minuto:
-- umin = minimo de u_bid/u_last entre created_at y el cierre de la posicion.
-- gap > 0  => el subyacente nunca bajo al limite con la orden viva (fill imposible aun en dolares,
--             salvo una mecha de menos de un minuto que el log no ve).
with legs as (select p.id pid, p.ticker, p.exit_reason, p.created_at c0, p.entry_ts, p.entry_limit,
       max(l.exit_ts) x1, sum(case when l.pnl_ars_alt is null
         then (l.px_ars_salida-l.px_ars_entrada)*l.qty-(l.px_ars_entrada+l.px_ars_salida)*l.qty*0.000605 else l.pnl_ars_alt end) pnl,
       sum(l.qty)*max(p.px_ars_entrada) notional
  from paper_iol_trades l join paper_iol_trades p on p.modo='shadow' and p.status='closed' and p.exit_reason<>'tp_parcial'
       and p.ticker=l.ticker and p.entry_ts=l.entry_ts
  where l.modo='shadow' and l.status='closed' group by 1,2,3,4,5,6),
q as (select legs.*, extract(epoch from entry_ts-c0)/60 mtf,
  (select min(least(nullif(u_bid,0), u_last)) from cedear_fv_log f where f.symbol=legs.ticker and f.snapshot_at between legs.c0 and legs.x1) umin,
  (select count(*) from cedear_fv_log f where f.symbol=legs.ticker and f.snapshot_at between legs.c0 and legs.x1) nlog
 from legs),
c as (select *, (umin/entry_limit-1)*100 gap from q where nlog>0 and umin is not null)
select exit_reason, count(*) n,
  sum((gap>0)::int) nunca_toco, sum((gap>0.25)::int) nunca_toco_025, sum((gap>1)::int) nunca_toco_1,
  round(avg(case when gap>0 then pnl/notional end)*100,3) ret_sim_nunca_toco,
  round(avg(case when gap<=0 then pnl/notional end)*100,3) ret_sim_toco,
  round(sum(case when gap>0 then pnl end)) pnl_sim_nunca_toco,
  round(sum(case when gap<=0 then pnl end)) pnl_sim_toco,
  sum((mtf<6)::int) fill_en_menos_6min
from c group by rollup(exit_reason) order by 1;
