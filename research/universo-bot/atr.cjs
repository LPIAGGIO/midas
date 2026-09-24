const https=require('https'), fs=require('fs');
const D=JSON.parse(fs.readFileSync('research/universo-bot/datos.json','utf8'));
const UNIVERSO=new Set("MU SNDK GGAL NVDA AMD AAPL MSFT GOOGL META AMZN KO JNJ XOM MELI NU INTC SPCX TSLA ORCL AVGO VST MCD VIST MSTR HUT MRNA UBER IBM QCOM OKLO IREN MRVL PLTR NBIS ADBE COIN NFLX RGTI KEEL ADI SATL LAR HPQ WMT ARM LAC V GPRK".split(" "));
const cand=D.filter(o=>!UNIVERSO.has(o.s)&&o.volAnual>=25&&o.volAnual<=60);
function j(u){return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});}
const dormir=ms=>new Promise(r=>setTimeout(r,ms));
function Phi(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989423*Math.exp(-x*x/2);
 let p=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p;}
(async()=>{
 const RIESGO=1.5, TOPE=20, STOP_TIPICO=2.5;   // el stop geometrico tipico del bot
 const out=[];
 for(const c of cand){
  const d=await j(`https://query1.finance.yahoo.com/v8/finance/chart/${c.s}?range=3mo&interval=1d`);
  await dormir(40);
  if(!d||!d.chart||!Array.isArray(d.chart.result)||!d.chart.result[0]) continue;
  const q=d.chart.result[0].indicators.quote[0];
  if(!q||!Array.isArray(q.close)) continue;
  const H=q.high.filter(x=>x!=null),L=q.low.filter(x=>x!=null),C=q.close.filter(x=>x!=null);
  if(C.length<20) continue;
  let tr=0; for(let i=C.length-14;i<C.length;i++) tr+=Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));
  const px=C[C.length-1], atrPct=tr/14/px*100;
  const sd=c.volAnual/Math.sqrt(252);
  const stopATR=2*atrPct;
  const posATR=Math.min(TOPE, RIESGO/stopATR*100);
  const sigmasTipico=STOP_TIPICO/sd;                 // donde caeria el stop actual del bot
  const pToque=2*Phi(-sigmasTipico);
  out.push({...c, atrPct, stopATR, posATR, sd, sigmasTipico, pToque});
 }
 // ordenar: los que permiten posicion grande con stop sano
 out.sort((a,b)=>b.posATR-a.posATR || a.spr-b.spr);
 console.log('papel   precio    vol   spread   ATR    stop 2xATR  posicion   stop 2,5% en σ   P(toque 1d)');
 console.log('------------------------------------------------------------------------------------------');
 for(const o of out.slice(0,30))
  console.log(o.s.padEnd(7)+o.precio.toFixed(2).padStart(9)+(o.volAnual.toFixed(0)+'%').padStart(7)+
   (o.spr.toFixed(2)+'%').padStart(9)+(o.atrPct.toFixed(2)+'%').padStart(7)+(o.stopATR.toFixed(1)+'%').padStart(12)+
   (o.posATR.toFixed(1)+'%').padStart(10)+(o.sigmasTipico.toFixed(2)+'σ').padStart(17)+((o.pToque*100).toFixed(0)+'%').padStart(14));
 fs.writeFileSync('research/universo-bot/atr.json',JSON.stringify(out,null,1));
 console.log(`\n${out.length} candidatos analizados.`);
 const buenos=out.filter(o=>o.posATR>=15&&o.sigmasTipico>=1);
 console.log(`\n${buenos.length} pasan las DOS pruebas (posicion >=15% con stop por ATR, y el stop tipico de 2,5% cae en 1σ o mas):`);
 console.log('  '+buenos.map(o=>o.s).join(', '));
})();
