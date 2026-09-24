const fs=require('fs');
const rows=JSON.parse(fs.readFileSync('panel-crudo.json','utf8'));
const TICKET=1400000; // lo que pone el bot por posicion
const vivos=rows.filter(r=>r.spr!=null);
// volumen en pesos del dia (aprox: nominales x precio medio)
for(const r of vivos) r.volPesos = r.vol * (r.bid+r.ask)/2;
const conPlata = vivos.filter(r=>r.volPesos>0).sort((a,b)=>b.volPesos-a.volPesos);
console.log('CEDEARs que operaron algo hoy:', conPlata.length);
const cortes=[0.60,1.00];
for(const c of cortes){
  const a=vivos.filter(r=>r.spr<=c);
  const b=a.filter(r=>r.volPesos>=TICKET*3);   // el ticket es <=1/3 del volumen del dia
  const d=a.filter(r=>r.volPesos>=TICKET*10);
  console.log(`spread<=${c.toFixed(2)}%: ${a.length} papeles | con volumen>=3x ticket: ${b.length} | >=10x ticket: ${d.length}`);
}
console.log('\ntop 15 por volumen en pesos:');
for(const r of conPlata.slice(0,15))
  console.log('  '+r.s.padEnd(7)+('$'+Math.round(r.volPesos).toLocaleString('es-AR')).padStart(16)+('  spr '+r.spr.toFixed(2)+'%').padStart(13));
