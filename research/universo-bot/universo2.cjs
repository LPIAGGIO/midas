const https=require('https'), fs=require('fs');
function j(u){return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});}
const dormir=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const rows=JSON.parse(fs.readFileSync('panel-crudo.json','utf8')).filter(r=>r.spr!=null);
 for(const r of rows) r.volPesos=r.vol*(r.bid+r.ask)/2;
 // UNIVERSO ENTERO: unico filtro duro = spread operable. El volumen lo maneja el sizing.
 const cand=rows.filter(r=>r.spr<=0.60);
 console.log(`CEDEARs con spread <=0,60%: ${cand.length}`);
 const out=[], fallados=[];
 let n=0;
 for(const c of cand){
  n++;
  const d=await j(`https://query1.finance.yahoo.com/v8/finance/chart/${c.s}?range=1y&interval=1d`);
  await dormir(90);
  const R=d&&d.chart&&d.chart.result&&d.chart.result[0];
  const qq=R&&R.indicators&&R.indicators.quote&&R.indicators.quote[0];
  if(!R||!qq||!Array.isArray(qq.close)||!R.meta||R.meta.regularMarketPrice==null){fallados.push(c.s);continue;}
  const px=qq.close.filter(x=>x!=null);
  if(px.length<200){fallados.push(c.s);continue;}
  const rr=[];for(let i=1;i<px.length;i++)rr.push(Math.log(px[i]/px[i-1]));
  const m=rr.reduce((a,b)=>a+b,0)/rr.length;
  const sd=Math.sqrt(rr.reduce((a,b)=>a+(b-m)**2,0)/(rr.length-1));
  out.push({...c, volAnual:sd*Math.sqrt(252)*100, sdDia:sd*100,
    precio:R.meta.regularMarketPrice, nombre:(R.meta.longName||R.meta.shortName||'').slice(0,40)});
  if(n%60===0) console.log(`  ...${n}/${cand.length}`);
 }
 console.log(`\nresueltos: ${out.length} | sin data en Yahoo: ${fallados.length}`);
 const banda=out.filter(o=>o.volAnual>=20&&o.volAnual<=80);
 console.log(`en banda 20-80% vol anual: ${banda.length}`);
 console.log(`  fuera: ${out.filter(o=>o.volAnual<20).length} muy quietos, ${out.filter(o=>o.volAnual>80).length} muy volatiles`);
 banda.sort((a,b)=>b.volPesos-a.volPesos);
 fs.writeFileSync('universo-ampliado.json', JSON.stringify(banda,null,1));
 fs.writeFileSync('tickers.txt', banda.map(o=>o.s).join(' '));
 console.log('\nguardado universo-ampliado.json y tickers.txt');
})();
