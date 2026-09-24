const fs=require('fs');
const n2=x=>x==null?'-':Number(x).toFixed(2);
const P=x=>x==null?'-':(x*100).toFixed(1)+'%';
const V=[['orden de llegada','results-sinranking.json'],['por R:R','results-rank-rr.json'],
         ['por score','results-rank-score.json'],['AZAR (control)','results-rank-azar.json']];
for (const tier of ['gold','cocos']) {
  console.log(`\n===== TIER ${tier.toUpperCase()} · universo 298 =====`);
  console.log('criterio            IS n   IS mensual   IS Sharpe  |  OOS n  OOS mensual  OOS Sharpe  OOS win');
  for (const [nm,f] of V) {
    if (!fs.existsSync(f)) { console.log(nm.padEnd(18)+'(falta)'); continue; }
    const r=JSON.parse(fs.readFileSync(f,'utf8'));
    const a=r.corridas['50/base/IS']?.metricas?.[tier], b=r.corridas['50/base/OOS']?.metricas?.[tier];
    if(!a||!b){console.log(nm.padEnd(18)+'(sin datos)');continue;}
    console.log(nm.padEnd(18)+String(a.n).padStart(6)+(n2(a.mensualPct)+'%').padStart(12)+n2(a.sharpe).padStart(12)+
      '  |'+String(b.n).padStart(6)+(n2(b.mensualPct)+'%').padStart(13)+n2(b.sharpe).padStart(12)+P(b.winRate).padStart(9));
  }
}
