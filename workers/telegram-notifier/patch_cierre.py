# -*- coding: utf-8 -*-
# telegram-notifier, resumen de cierre (30/09/2026, LP: "me mando cualquier cosa"):
#  1) futuresSettledToday comparaba settlement_ts en UTC: el settle de AYER se
#     publica 21:00 ART = 00:00 UTC de HOY → "ya hay settle de hoy" (falso) y el
#     P&L de futuros salia contra el settle viejo (DLRNOV26 −50.000 en vez del
#     +103.000 de Matriz). Ahora compara la fecha en hora argentina.
#  2) Tenencias "s/precio": data912 estaba caido a las 18:00 (HTTP 500/502) y no
#     habia reintento ni respaldo. Ahora reintenta 3 veces y, si sigue sin
#     precio, usa el cierre de cedear_fv_log (ultimo precio del dia y del dia
#     anterior, que lo escribe la edge function cada minuto en rueda).
import io, os, sys
P = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'worker.js')
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''  if (!data || !data.length || !data[0].settlement_ts) return false;
  return String(data[0].settlement_ts).slice(0, 10) === dateStr;''',
'''  if (!data || !data.length || !data[0].settlement_ts) return false;
  // En hora ARGENTINA: el settle de ayer se publica 21:00 ART = 00:00 UTC de
  // hoy, y comparando el string crudo daba "settle de hoy" cuando era el de
  // ayer (30/09/2026: DLRNOV26 −50.000 contra el settle viejo).
  const fechaArt = new Date(data[0].settlement_ts).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
  return fechaArt === dateStr;''', 'settle-tz')

sub('''async function loadData912() {
  if (_d912cache && Date.now() - _d912ts < 12000) return _d912cache;
  const SRC = ["arg_bonds", "arg_notes", "arg_stocks", "arg_cedears"].map((s) => `https://data912.com/live/${s}`);
  const map = {};
  await Promise.all(SRC.map(async (url) => {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Midas/0.1" } });
      if (!r.ok) return;
      for (const x of (await r.json()) || []) {
        if (x && x.symbol && x.c != null) map[x.symbol] = { c: Number(x.c), pct: x.pct_change != null ? Number(x.pct_change) : null };
      }
    } catch (e) { console.error("[data912]", e.message); }
  }));
  _d912cache = map; _d912ts = Date.now();
  return map;
}''',
'''async function loadData912() {
  if (_d912cache && Date.now() - _d912ts < 12000) return _d912cache;
  const SRC = ["arg_bonds", "arg_notes", "arg_stocks", "arg_cedears"].map((s) => `https://data912.com/live/${s}`);
  const map = {};
  // data912 fallo en rafagas de minutos el 30/09 (HTTP 500/502): hasta 3
  // intentos por feed, 20 s entre uno y otro, antes de darlo por vacio.
  await Promise.all(SRC.map(async (url) => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Midas/0.1" }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const arr = await r.json();
        if (!Array.isArray(arr) || !arr.length) throw new Error("vacio");
        for (const x of arr) if (x && x.symbol && x.c != null) map[x.symbol] = { c: Number(x.c), pct: x.pct_change != null ? Number(x.pct_change) : null };
        break;
      } catch (e) {
        console.error(`[data912] ${url.split("/").pop()}: ${e.message}${i < 2 ? " — reintento en 20 s" : ""}`);
        if (i < 2) await new Promise((ok) => setTimeout(ok, 20000));
      }
    }
  }));
  _d912cache = map; _d912ts = Date.now();
  return map;
}

// RESPALDO de cierre para CEDEARs/acciones cuando data912 no responde: el
// ultimo precio del dia y del dia anterior en cedear_fv_log (la edge function
// lo escribe cada minuto en rueda). Devuelve { c, pct } como data912.
async function cierreRespaldo(tickers, dateStr) {
  const out = {};
  if (!tickers.length) return out;
  const { data } = await supabase.from("cedear_fv_log").select("symbol,c_last,snapshot_at")
    .in("symbol", tickers).gte("snapshot_at", new Date(Date.now() - 6 * 86400000).toISOString())
    .order("snapshot_at", { ascending: false }).limit(20000);
  const porDia = {};
  for (const r of data || []) {
    const d = new Date(r.snapshot_at).toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
    const k = r.symbol;
    porDia[k] = porDia[k] || {};
    if (!porDia[k][d] && Number(r.c_last) > 0) porDia[k][d] = Number(r.c_last);   // viene ordenado desc: el primero es el ultimo del dia
  }
  for (const [tk, dias] of Object.entries(porDia)) {
    const fechas = Object.keys(dias).sort().reverse();
    if (!fechas.length || fechas[0] !== dateStr) continue;
    const hoy = dias[fechas[0]], ayer = fechas[1] ? dias[fechas[1]] : null;
    out[tk] = { c: hoy, pct: ayer > 0 ? ((hoy / ayer) - 1) * 100 : null, respaldo: true };
  }
  return out;
}''', 'data912')

sub('''    const d912 = await loadData912();
    const netByTicker = {};
    const typeByTicker = {};
    for (const p of tenencias) {
      netByTicker[p.ticker] = (netByTicker[p.ticker] || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
      typeByTicker[p.ticker] = p.instrument_type;
    }''',
'''    const d912 = await loadData912();
    const netByTicker = {};
    const typeByTicker = {};
    for (const p of tenencias) {
      netByTicker[p.ticker] = (netByTicker[p.ticker] || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
      typeByTicker[p.ticker] = p.instrument_type;
    }
    // Sin precio en data912 → respaldo con el cierre de cedear_fv_log.
    const faltan = Object.keys(netByTicker).filter((tk) => ["stock", "cedear"].includes(typeByTicker[tk]) && !(d912[tk] && d912[tk].c != null && d912[tk].pct != null));
    if (faltan.length) { const resp = await cierreRespaldo(faltan, dateStr).catch(() => ({})); for (const [tk, v] of Object.entries(resp)) d912[tk] = v; }''', 'respaldo')

sub('''      bl.push(`• ${ticker}: ${money(pnl)} (${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(2)}%)`);''',
'''      bl.push(`• ${ticker}: ${money(pnl)} (${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(2)}%)${d.respaldo ? " ·cierre" : ""}`);''', 'marca')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
