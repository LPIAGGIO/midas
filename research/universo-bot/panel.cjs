const https=require('https'), fs=require('fs');
function j(u){return new Promise(r=>{https.get(u,{headers:{'User-Agent':'Mozilla/5.0'}},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>{try{r(JSON.parse(d))}catch(e){r(null)}});}).on('error',()=>r(null));});}
(async()=>{
 const ced=await j('https://data912.com/live/arg_cedears');
 if(!ced){console.log('sin feed');return;}
 console.log('CEDEARs en el panel BYMA:', ced.length);
 let conPunta=0, spreadOk=0, volOk=0;
 const rows=[];
 for(const r of ced){
  const s=String(r.symbol||'').toUpperCase();
  const bid=+r.px_bid, ask=+r.px_ask, vol=+r.v||0;
  const ok = bid>0 && ask>bid;
  if(ok) conPunta++;
  const spr = ok ? (ask-bid)/((ask+bid)/2)*100 : null;
  if(ok && spr<=0.60) spreadOk++;
  if(ok && spr<=0.60 && vol>=2000) volOk++;
  rows.push({s,bid,ask,spr,vol});
 }
 console.log('  con punta sana (bid>0 y ask>bid):', conPunta);
 console.log('  + spread <= 0,60%:', spreadOk);
 console.log('  + volumen >= 2.000 nominales:', volOk);
 fs.writeFileSync('panel-crudo.json', JSON.stringify(rows,null,0));
 // distribucion de spread entre los que tienen punta
 const sp=rows.filter(r=>r.spr!=null).map(r=>r.spr).sort((a,b)=>a-b);
 const q=p=>sp[Math.floor(sp.length*p)].toFixed(2);
 console.log(`\n  spread: p10 ${q(0.1)}%  mediana ${q(0.5)}%  p75 ${q(0.75)}%  p90 ${q(0.9)}%`);
 const vv=rows.filter(r=>r.spr!=null).map(r=>r.vol).sort((a,b)=>a-b);
 const qv=p=>vv[Math.floor(vv.length*p)];
 console.log(`  volumen: p25 ${qv(0.25)}  mediana ${qv(0.5)}  p75 ${qv(0.75)}`);
})();
