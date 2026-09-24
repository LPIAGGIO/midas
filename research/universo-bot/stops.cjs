const https=require('https');
// stop inicial en % de cada trade real del bot
const TR=[['LAC',1.72,'abierta'],['OKLO',1.36,'cerrada x2'],['HUT',1.75,'cerrada x3'],['MELI',1.40,'STOP saltado'],
 ['ORCL',1.50,'target'],['MRVL',3.76,'target'],['MSTR',4.75,'pendiente'],['MU',3.19,'pendiente'],
 ['NU',2.60,'pendiente'],['SNDK',2.81,'nunca entro'],['XOM',1.78,'nunca entro'],['ARM',1.34,'nunca entro'],
 ['QCOM',2.79,'nunca entro'],['ADBE',2.27,'nunca entro'],['VST',2.41,'nunca entro'],['SPCX',1.94,'nunca entro']];
function j(u){return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});}
// Phi: normal acumulada
function Phi(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);
 let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
(async()=>{
 console.log('papel   stop%   desvio diario   stop en sigmas   P(lo toca en 1 dia)   P(en 3 dias)   estado');
 console.log('--------------------------------------------------------------------------------------------');
 const filas=[];
 for(const [s,stop,est] of TR){
  const d=await j(`https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1y&interval=1d`);
  if(!d||!d.chart||!d.chart.result||!d.chart.result[0]) continue;
  const q=d.chart.result[0].indicators.quote[0].close.filter(x=>x!=null);
  const r=[]; for(let i=1;i<q.length;i++) r.push(q[i]/q[i-1]-1);
  const m=r.reduce((a,b)=>a+b,0)/r.length;
  const sd=Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/r.length)*100;
  const k=stop/sd;
  const p1=2*Phi(-k), p3=2*Phi(-k/Math.sqrt(3));
  filas.push({s,stop,sd,k,p1,p3,est});
 }
 filas.sort((a,b)=>a.k-b.k);
 for(const f of filas)
  console.log(f.s.padEnd(7)+(f.stop.toFixed(2)+'%').padStart(7)+(f.sd.toFixed(2)+'%').padStart(15)+
   (f.k.toFixed(2)+'σ').padStart(16)+((f.p1*100).toFixed(0)+'%').padStart(20)+((f.p3*100).toFixed(0)+'%').padStart(15)+'   '+f.est);
 const prom=filas.reduce((a,b)=>a+b.k,0)/filas.length;
 console.log('\nstop promedio del bot: '+prom.toFixed(2)+' desvios diarios');
 console.log('Un stop sano deberia estar en 1,5-2 sigmas. P(toque) con 2 sigmas en 1 dia = '+(2*Phi(-2)*100).toFixed(0)+'%');
})();
