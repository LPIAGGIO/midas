const https=require('https'), fs=require('fs');
function j(u){return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});}
const dormir=ms=>new Promise(r=>setTimeout(r,ms));
const TICKET=1400000;
(async()=>{
 const rows=JSON.parse(fs.readFileSync('panel-crudo.json','utf8')).filter(r=>r.spr!=null);
 for(const r of rows) r.volPesos=r.vol*(r.bid+r.ask)/2;
 const cand=rows.filter(r=>r.spr<=0.60 && r.volPesos>=TICKET*10);
 console.log(`candidatos por liquidez local: ${cand.length}\nresolviendo subyacentes en Yahoo...`);
 const out=[], fallados=[];
 let n=0;
 for(const c of cand){
  n++;
  const d=await j(`https://query1.finance.yahoo.com/v8/finance/chart/${c.s}?range=1y&interval=1d`);
  await dormir(120);
  const R=d&&d.chart&&d.chart.result&&d.chart.result[0];
  const qq=R&&R.indicators&&R.indicators.quote&&R.indicators.quote[0];
  if(!R||!qq||!Array.isArray(qq.close)||!R.meta||R.meta.regularMarketPrice==null){fallados.push(c.s);continue;}
  const px=qq.close.filter(x=>x!=null);
  if(px.length<200){fallados.push(c.s+'(corto)');continue;}
  const rr=[];for(let i=1;i<px.length;i++)rr.push(Math.log(px[i]/px[i-1]));
  const m=rr.reduce((a,b)=>a+b,0)/rr.length;
  const sd=Math.sqrt(rr.reduce((a,b)=>a+(b-m)**2,0)/(rr.length-1));
  out.push({...c, volAnual:sd*Math.sqrt(252)*100, sdDia:sd*100,
    ret12:(px[px.length-1]/px[0]-1)*100, precio:R.meta.regularMarketPrice,
    nombre:(R.meta.longName||R.meta.shortName||''), tipo:R.meta.instrumentType||''});
  if(n%40===0) console.log(`  ...${n}/${cand.length}`);
 }
 console.log(`\nresueltos en Yahoo: ${out.length} | no resueltos: ${fallados.length}`);
 if(fallados.length) console.log('  sin data: '+fallados.join(' '));
 const banda=out.filter(o=>o.volAnual>=20&&o.volAnual<=80);
 console.log(`\nen banda de volatilidad 20-80% anual: ${banda.length}`);
 console.log(`  descartados por vol <20% (no se mueve): ${out.filter(o=>o.volAnual<20).length}`);
 console.log(`  descartados por vol >80% (stop imposible): ${out.filter(o=>o.volAnual>80).length}`);
 banda.sort((a,b)=>b.volPesos-a.volPesos);
 fs.writeFileSync('universo-ampliado.json', JSON.stringify(banda,null,1));
 console.log('\nguardado universo-ampliado.json');
})();
