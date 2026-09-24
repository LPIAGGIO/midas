import fs from 'node:fs'; import path from 'node:path';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36';
const TK=fs.readFileSync('tickers.txt','utf8').trim().split(/\s+/);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ok=0,skip=0,fail=[];
for (const sym of TK){
  for (const kind of ['daily','hourly']){
    const out=path.join('data',kind,sym+'.json');
    if (fs.existsSync(out)) { skip++; continue; }
    const url=kind==='daily'
      ?`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y`
      :`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1h&range=730d`;
    try{
      const j=await (await fetch(url,{headers:{'User-Agent':UA}})).json();
      const n=j?.chart?.result?.[0]?.timestamp?.length||0;
      if(!n){fail.push(sym+'/'+kind);continue;}
      fs.writeFileSync(out,JSON.stringify(j)); ok++;
    }catch(e){fail.push(sym+'/'+kind);}
    await sleep(110);
  }
}
console.log(`descargadas ${ok} series nuevas, ${skip} ya estaban, ${fail.length} fallaron`);
if(fail.length) console.log('fallaron: '+fail.slice(0,40).join(' '));
