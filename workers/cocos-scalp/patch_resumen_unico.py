# -*- coding: utf-8 -*-
# resumen.js: UN solo mensaje de Telegram al cierre (LP 02/10/2026: "mandame
# un mensaje único... de cómo quedaría el lunes"). Con 18 bots el detalle por
# operación eran 19 mensajes; ese detalle ahora vive en la pantalla Bot
# Scalping de Midas. El mensaje único trae, por cuenta, cada papel con lo
# realizado, las ventas, los escalones cargados y el latente; y el total con
# el resultado verdadero (realizado + latente). `--detalle` conserva el
# formato viejo (un mensaje por papel). No se manda dos veces el mismo día.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'resumen.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''  if (!bots.length) { console.log("sin operaciones reales de scalp hoy: no mando nada"); return; }''',
    '''  const marca = path.join(__dirname, "logs", `resumen-enviado-${hoy}`);
  if (!DRY && !process.argv.includes("--forzar") && fs.existsSync(marca)) { console.log("el resumen de hoy ya se mandó"); return; }''', 'marca')

NL = chr(92) + 'n'   # barra invertida + n, tal cual va en el JavaScript
UNICO = '''  if (!process.argv.includes("--detalle")) {
    // Mensaje único: estado de cada bot (scalp_estado) + lo realizado hoy (logs).
    const E0 = env();
    const sb0 = createClient(E0.SUPABASE_URL, E0.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport: WebSocket } });
    const { data: est } = await sb0.from("scalp_estado").select("cuenta,ticker,tenencia,costo,latente,niveles,config,real").eq("user_id", USER_ID);
    const { data: hist } = await sb0.from("scalp_resultados").select("fecha,pnl").eq("user_id", USER_ID);
    const hoyPorBot = new Map(bots.map((b, i) => [`${b.cuenta}|${b.tk}`, partes[i]]));
    const filas = (est || []).filter((f) => f.real);
    if (!filas.length && !bots.length) { console.log("sin bots de scalp reales: no mando nada"); return; }
    const sg = (n) => (n > 0 ? "+" : n < 0 ? "−" : " ") + Math.abs(Math.round(n)).toLocaleString("es-AR");
    const orden = (c) => (c === "72404" ? "0" : "1" + c);
    const cuentas = [...new Set(filas.map((f) => f.cuenta))].sort((a, b) => orden(a).localeCompare(orden(b)));
    const L = [`<b>SCALP · cierre ${hoy.split("-").reverse().join("/")}</b>`];
    let tReal = 0, tLat = 0, tInv = 0, tVentas = 0;
    for (const c of cuentas) {
      const fs_ = filas.filter((f) => f.cuenta === c).sort((a, b) => a.ticker.localeCompare(b.ticker));
      let real = 0, lat = 0, inv = 0, ventas = 0;
      const lineas = ["papel  realizado  v  esc    latente"];
      for (const f of fs_) {
        const p = hoyPorBot.get(`${c}|${f.ticker}`) || { total: 0, vueltas: 0 };
        const esc = (f.niveles || []).filter((n) => !n.tipo || n.tipo === "escalon").length;
        const ext = (f.niveles || []).filter((n) => n.tipo === "extra").length;
        const tope = (f.config && f.config.escalones) || 5;
        real += p.total; lat += Number(f.latente) || 0; inv += Number(f.costo) || 0; ventas += p.vueltas;
        lineas.push(`${f.ticker.padEnd(5)} ${sg(p.total).padStart(10)} ${String(p.vueltas).padStart(2)}  ${esc}/${tope}${ext ? "+" + ext : "  "} ${(Number(f.tenencia) > 0 ? sg(Number(f.latente) || 0) : "—").padStart(9)}`);
      }
      L.push("", `<b>Cuenta ${c}</b>`, `<pre>${lineas.join("NLNL")}</pre>`, `Realizado ${sg(real)} en ${ventas} ventas · latente ${sg(lat)} · invertido $${Math.round(inv).toLocaleString("es-AR")}`);
      tReal += real; tLat += lat; tInv += inv; tVentas += ventas;
    }
    const acum = (hist || []).filter((h) => h.fecha !== hoy).reduce((a, h) => a + Number(h.pnl || 0), 0) + tReal;
    const ruedas = new Set((hist || []).map((h) => h.fecha).concat([hoy])).size;
    L.push("", "<b>Total del día</b>",
      `Realizado ${sg(tReal)} en ${tVentas} ventas`,
      `Latente ${sg(tLat)} (lo que sigue abierto)`,
      `<b>Resultado: ${sg(tReal + tLat)}</b>${tInv > 0 ? ` · ${((tReal + tLat) / tInv * 100).toFixed(2).replace(".", ",")}% de lo invertido` : ""}`,
      `Invertido $${Math.round(tInv).toLocaleString("es-AR")}`,
      "", `Acumulado ${ruedas} ${ruedas === 1 ? "rueda" : "ruedas"}: realizado ${sg(acum)} · con el latente de hoy ${sg(acum + tLat)}`,
      "v = ventas · esc = escalones cargados · lo abierto se arrastra a la próxima rueda");
    mensajes.length = 0; mensajes.push(L.join("NLNL"));
  } else if (!bots.length) { console.log("sin operaciones reales de scalp hoy: no mando nada"); return; }
  if (DRY) {'''.replace('NLNL', NL)
sub('''  if (DRY) {''', UNICO, 'unico')
sub('''  console.log(`resumen enviado: ${mensajes.length} mensajes`);''',
    '''  fs.writeFileSync(marca, new Date().toISOString());
  console.log(`resumen enviado: ${mensajes.length} mensajes`);''', 'marca-escribe')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
