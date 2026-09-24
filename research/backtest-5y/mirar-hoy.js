import { loadSeries, analyzeAsOf } from './engine.js';
const TK = process.argv.slice(2);
const fmt = n => n==null ? '-' : (Math.round(n*100)/100).toLocaleString('es-AR');
for (const sym of TK) {
  const d = loadSeries('./data','daily',sym);
  const h = loadSeries('./data','hourly',sym);
  if (!d || !h) { console.log(sym+': sin datos'); continue; }
  const iH = h.length-1;
  const k = analyzeAsOf(d,h,iH);
  if (!k) { console.log(sym+': kit nulo'); continue; }
  const spot = k.spot;
  const dist = k.buy ? (k.buy/spot-1)*100 : null;
  const stopPct = (k.buy && k.stop) ? (1-k.stop/k.buy)*100 : null;
  // sigma diaria 252d
  const cl = d.slice(-253).map(x=>x.c); const rets=[];
  for(let i=1;i<cl.length;i++) rets.push(Math.log(cl[i]/cl[i-1]));
  const m=rets.reduce((a,b)=>a+b,0)/rets.length;
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-m)**2,0)/(rets.length-1));
  const sig = stopPct!=null ? (stopPct/100)/sd : null;
  const pasa = (k.score>=7 && k.rr>=2);
  console.log(`\n=== ${sym} | spot ${fmt(spot)} | ${k.estr} | RSI ${fmt(k.rsi)} | ATR ${fmt(k.atr)}`);
  if (!k.buy) { console.log('   sin zona de compra valida'); continue; }
  console.log(`   COMPRA ${fmt(k.buyZone.lo)}-${fmt(k.buy)} (${k.tipo}, ${k.buyZone.touches} toques) -> ${dist>0?'+':''}${fmt(dist)}% del spot`);
  console.log(`   STOP ${fmt(k.stop)} (${fmt(stopPct)}% = ${fmt(sig)} sigmas)  [${k.stopWhy||'-'}]`);
  console.log(`   TARGET ${fmt(k.target)}  R:R ${k.rr??'-'}  SCORE ${k.score}/10`);
  console.log(`   senales: ${k.senales.join(', ')||'ninguna'}`);
  console.log(`   >>> GATE DEL BOT (score>=7 y R:R>=2): ${pasa?'PASA':'RECHAZA'}`);
}
