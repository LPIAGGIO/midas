const fs=require('fs'); const {cargar}=require('./extraer.cjs');
const F=cargar(['parseMatrizFuturesCsv','esTickerOpcion','OPT_SUBY']);
for (const f of ['ReporteOperaciones_72404.csv','ReporteOperaciones_72404 (1).csv','ReporteOperaciones_72404 (2).csv','ReporteOperaciones_72404 (4).csv']) {
  const txt=fs.readFileSync('C:/Users/slider/Downloads/'+f,'utf8');
  const rows=F.parseMatrizFuturesCsv(txt,new Set(),null,null).filter(r=>r.status==='new');
  const net={}; for(const r of rows){ net[r.ticker]=(net[r.ticker]||0)+(r.side==='buy'?1:-1)*r.qty; }
  console.log(f.padEnd(34)+' ordenes '+String(rows.length).padStart(3)+'  neto '+JSON.stringify(net));
}
