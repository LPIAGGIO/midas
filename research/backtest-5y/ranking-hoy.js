import fs from 'node:fs';
import { loadSeries, analyzeAsOf } from './engine.js';
const TK = fs.readFileSync('tickers.txt','utf8').trim().split(/\s+/);
const f2 = n => n==null?'-':(Math.round(n*100)/100).toLocaleString('es-AR');
const rows=[]; let sinDatos=0, sinZona=0;
for (const sym of TK) {
  const d = loadSeries('./data','daily',sym), h = loadSeries('./data','hourly',sym);
  if (!d || !h || h.length<50 || d.length<260) { sinDatos++; continue; }
  let k; try { k = analyzeAsOf(d,h,h.length-1); } catch(e){ sinDatos++; continue; }
  if (!k || !k.buy || !k.stop || !k.target) { sinZona++; continue; }
  const cl=d.slice(-253).map(x=>x.c), r=[];
  for(let i=1;i<cl.length;i++) r.push(Math.log(cl[i]/cl[i-1]));
  const m=r.reduce((a,b)=>a+b,0)/r.length;
  const sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(r.length-1));
  const stopPct=(1-k.stop/k.buy);
  rows.push({sym, score:k.score, rr:k.rr??0, atr:k.atr, spot:k.spot, buy:k.buy, stop:k.stop, target:k.target,
    holgura: k.atr>0 ? (k.buy-k.stop)/k.atr : 0, sigmas: stopPct/sd, estr:k.estr,
    contra: /CONTRA/.test((k.senales||[]).join(' ')), dist:(k.buy/k.spot-1)*100});
}
const pasan = rows.filter(r=>r.score>=7 && r.rr>=2 && !r.contra);
pasan.sort((a,b)=> b.holgura-a.holgura || b.rr-a.rr || b.score-a.score);
console.log(`universo evaluado: ${rows.length} papeles con zona valida (${sinDatos} sin datos, ${sinZona} sin zona)`);
console.log(`PASAN EL GATE (score>=7, R:R>=2, a favor de tendencia): ${pasan.length}\n`);
console.log(' #  papel   holgura   sigmas   R:R  score  compra     stop    target   dist   tendencia');
pasan.forEach((r,i)=>console.log(
  String(i+1).padStart(2)+'  '+r.sym.padEnd(7)+(r.holgura.toFixed(2)+' ATR').padStart(9)+
  (r.sigmas.toFixed(2)).padStart(8)+(r.rr.toFixed(1)).padStart(6)+(r.score+'/10').padStart(7)+
  f2(r.buy).padStart(10)+f2(r.stop).padStart(9)+f2(r.target).padStart(9)+
  ((r.dist>0?'+':'')+r.dist.toFixed(1)+'%').padStart(8)+'   '+r.estr));
fs.writeFileSync('ranking-hoy.json', JSON.stringify(pasan,null,1));
const s=rows.filter(r=>r.score>=7&&r.rr>=2);
console.log(`\n(${s.length-pasan.length} descartados por contra-tendencia)`);
console.log(`distribucion de holgura entre los que pasan: min ${Math.min(...pasan.map(p=>p.holgura)).toFixed(2)} | mediana ${pasan[Math.floor(pasan.length/2)]?.holgura.toFixed(2)} | max ${Math.max(...pasan.map(p=>p.holgura)).toFixed(2)} ATR`);
