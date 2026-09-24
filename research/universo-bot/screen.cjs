const https=require('https'), fs=require('fs');
const UNIVERSO=new Set("MU SNDK GGAL NVDA AMD AAPL MSFT GOOGL META AMZN KO JNJ XOM MELI NU INTC SPCX TSLA ORCL AVGO VST MCD VIST MSTR HUT MRNA UBER IBM QCOM OKLO IREN MRVL PLTR NBIS ADBE COIN NFLX RGTI KEEL ADI SATL LAR HPQ WMT ARM LAC V GPRK".split(" "));
function j(u){return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});}
const dormir=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const ced=await j('https://data912.com/live/arg_cedears');
 if(!ced){console.log('sin feed');return;}
 // 1) filtro de liquidez local
 const cand=[];
 for(const r of ced){
  const s=String(r.symbol||'').toUpperCase();
  const bid=+r.px_bid, ask=+r.px_ask, vol=+r.v||0;
  if(!(bid>0&&ask>bid)) continue;                 // descarta cruzados y sin punta
  const spr=(ask-bid)/((ask+bid)/2)*100;
  if(spr>0.60) continue;                          // spread ancho: no operable
  if(vol<2000) continue;                          // volumen flojo
  cand.push({s,bid,ask,spr,vol});
 }
 console.log(`CEDEARs con punta sana, spread <=0,60% y volumen >=2.000: ${cand.length}\n`);
 // 2) volatilidad del subyacente
 const out=[];
 for(const c of cand){
  const d=await j(`https://query1.finance.yahoo.com/v8/finance/chart/${c.s}?range=1y&interval=1d`);
  await dormir(40);
  if(!d||!d.chart||!Array.isArray(d.chart.result)||!d.chart.result[0]) continue;
  const R=d.chart.result[0];
  const qq=R.indicators&&R.indicators.quote&&R.indicators.quote[0];
  if(!qq||!Array.isArray(qq.close)||!R.meta||R.meta.regularMarketPrice==null) continue;
  const px=qq.close.filter(x=>x!=null);
  if(px.length<200) continue;
  const rr=[]; for(let i=1;i<px.length;i++) rr.push(px[i]/px[i-1]-1);
  const m=rr.reduce((a,b)=>a+b,0)/rr.length;
  const sd=Math.sqrt(rr.reduce((a,b)=>a+(b-m)**2,0)/rr.length);
  const volAnual=sd*Math.sqrt(252)*100;
  const ret12=(px[px.length-1]/px[0]-1)*100;
  out.push({...c, volAnual, ret12, precio:R.meta.regularMarketPrice, nombre:(R.meta.longName||R.meta.shortName||'')});
 }
 fs.writeFileSync('research/universo-bot/datos.json', JSON.stringify(out,null,1));
 // 3) ranking: volatilidad en banda operable 25-60%, spread fino, volumen alto
 const nuevos=out.filter(o=>!UNIVERSO.has(o.s));
 const enBanda=nuevos.filter(o=>o.volAnual>=25&&o.volAnual<=60);
 enBanda.sort((a,b)=>a.spr-b.spr);
 console.log('=== CANDIDATOS NUEVOS (fuera del universo actual, vol 25-60%) ===');
 console.log('papel    precio USA   vol anual   spread   volumen   12 meses   nombre');
 for(const o of enBanda.slice(0,25))
  console.log(o.s.padEnd(8)+o.precio.toFixed(2).padStart(10)+(o.volAnual.toFixed(0)+'%').padStart(11)+
   (o.spr.toFixed(2)+'%').padStart(9)+String(o.vol).padStart(9)+
   (((o.ret12>=0?'+':'')+o.ret12.toFixed(0)+'%')).padStart(11)+'   '+o.nombre.slice(0,28));
 console.log(`\n(${nuevos.length} papeles nuevos pasaron el filtro de liquidez; ${enBanda.length} quedaron en la banda de volatilidad)`);
 // 4) los del universo actual que NO deberian estar
 const viejos=out.filter(o=>UNIVERSO.has(o.s)&&o.volAnual>80);
 if(viejos.length){
  console.log('\n=== DEL UNIVERSO ACTUAL: volatilidad >80%, el stop queda adentro del ruido ===');
  for(const o of viejos.sort((a,b)=>b.volAnual-a.volAnual))
   console.log('  '+o.s.padEnd(8)+(o.volAnual.toFixed(0)+'%').padStart(6)+'  (desvio diario '+(o.volAnual/Math.sqrt(252)).toFixed(2)+'%)');
 }
})();
