# -*- coding: utf-8 -*-
# cocos-bot: libro en pesos por el WEBSOCKET de market data de Primary
# (30/09/2026, pedido de LP: "desde Primary no tenemos precios en tiempo
# real?"). Una conexion, suscripcion a todos los CEDEARs del universo, bid/ask/
# ultimo en tiempo real y sin limite de consultas. data912 y el REST de Primary
# quedan como respaldo si el websocket esta caido.
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''async function libro(tk, preciso = false) {
  const vacio = { bid: null, ask: null, last: null };''',
'''/* WEBSOCKET DE PRIMARY (30/09/2026). Se suscribe a todos los CEDEARs del
 * universo (mas cualquier papel con orden o posicion viva) y mantiene el
 * libro en memoria. Si se corta, reconecta solo con token nuevo. Un libro
 * del websocket vale mientras la conexion recibio ALGO en los ultimos 2 min
 * (los papeles poco operados pueden no cambiar en minutos; la conexion
 * entera sin mensajes es lo que indica que algo esta caido). */
const WebSocket = require("ws");
const wsLibro = new Map();
let wsConn = null, wsUltimoMsg = 0, wsReintento = 0, wsSuscriptos = new Set();
function wsSimbolos() {
  const tks = [...UNIVERSO].filter((tk) => !ARG_LOCAL.has(tk));
  for (const tk of wsSuscriptos) if (!tks.includes(tk)) tks.push(tk);
  return tks;
}
async function wsConectar() {
  try {
    const t = await token();
    const ws = new WebSocket(BASE.replace("https://", "wss://") + "/", { headers: { "X-Auth-Token": t } });
    wsConn = ws;
    ws.on("open", () => {
      wsReintento = 0;
      const products = wsSimbolos().map((tk) => ({ symbol: simbolo(tk), marketId: "ROFX" }));
      ws.send(JSON.stringify({ type: "smd", level: 1, entries: ["BI", "OF", "LA"], products, depth: 1 }));
      log(`[ws] Primary conectado · ${products.length} CEDEARs suscriptos`);
    });
    ws.on("message", (d) => {
      wsUltimoMsg = Date.now();
      let j; try { j = JSON.parse(d.toString()); } catch { return; }
      if (j.type !== "Md") return;
      const tk = String(j.instrumentId?.symbol || "").split(" - ")[2];
      if (!tk) return;
      const md = j.marketData || {};
      const prev = wsLibro.get(tk) || {};
      wsLibro.set(tk, {
        bid: Number(md.BI?.[0]?.price) || prev.bid || null,
        ask: Number(md.OF?.[0]?.price) || prev.ask || null,
        last: Number(md.LA?.price) || prev.last || null,
        t: Date.now(),
      });
    });
    const caida = (m) => { if (wsConn !== ws) return; wsConn = null; const esp = Math.min(60_000, 5_000 * (1 + wsReintento++)); log(`[ws] Primary desconectado (${m}); reconecto en ${esp / 1000} s`); setTimeout(wsConectar, esp); };
    ws.on("close", (c) => caida(`close ${c}`));
    ws.on("error", (e) => caida(e.message));
  } catch (e) {
    const esp = Math.min(60_000, 5_000 * (1 + wsReintento++));
    log(`[ws] no pude conectar (${e.message}); reintento en ${esp / 1000} s`);
    setTimeout(wsConectar, esp);
  }
}
function wsSuscribirExtra(tk) {
  if (wsSuscriptos.has(tk) || UNIVERSO.has(tk)) return;
  wsSuscriptos.add(tk);
  if (wsConn && wsConn.readyState === 1) {
    const products = wsSimbolos().map((x) => ({ symbol: simbolo(x), marketId: "ROFX" }));
    wsConn.send(JSON.stringify({ type: "smd", level: 1, entries: ["BI", "OF", "LA"], products, depth: 1 }));
  }
}
const wsVivo = () => wsConn && wsConn.readyState === 1 && Date.now() - wsUltimoMsg < 120_000;

async function libro(tk, preciso = false) {
  const vacio = { bid: null, ask: null, last: null };
  // 1) websocket de Primary: tiempo real, sin cupo
  const w = wsLibro.get(tk.toUpperCase());
  if (wsVivo() && w && (w.bid > 0 || w.last > 0)) return { bid: w.bid, ask: w.ask, last: w.last };
  // 2) respaldos: como antes''', 'libro')

sub('''  await token();
  log("login Primary OK");''', '''  await token();
  log("login Primary OK");
  wsConectar();''', 'arranque')

# los papeles con orden/posicion viva fuera del universo tambien se suscriben
sub('''  const vivas = await abiertasCocos();
  const usd = await usdConRespaldo(vivas);
  for (const t of vivas) {''', '''  const vivas = await abiertasCocos();
  for (const t of vivas) wsSuscribirExtra(String(t.ticker).toUpperCase());
  const usd = await usdConRespaldo(vivas);
  for (const t of vivas) {''', 'pasada')

sub('''    console.log("tick OKLO", await tickDe("OKLO"), "· libro", await libro("OKLO"));''',
'''    console.log("tick OKLO", await tickDe("OKLO"), "· libro REST", await libroPrimary("OKLO"));
    wsConectar(); await new Promise((r) => setTimeout(r, 6000));
    console.log("websocket:", wsVivo() ? "vivo" : "sin mensajes", "· libros recibidos:", wsLibro.size, "· OKLO por ws:", JSON.stringify(wsLibro.get("OKLO") || null));''', 'chequeo')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
