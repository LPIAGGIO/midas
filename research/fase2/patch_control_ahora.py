# -*- coding: utf-8 -*-
# Cartel "Cocos coincide con Matriz" (LP 01/10/2026: "esto no actualizó más,
# quedaron cosas que Matriz no tenía"). El cartel comparaba SOLO la tenencia
# al abrir contra el extracto hasta el día anterior, con una foto que se dejaba
# de tomar a las 12:45: a la tarde seguía mostrando MU 75 y HUT 869 cuando la
# cuenta ya tenía MU 0 y HUT 400. Ahora muestra dos comparaciones:
#   - al abrir: como antes (valida el extracto);
#   - ahora: tenencia actual de Matriz contra las posiciones de Midas con lo
#     operado hoy (el puente de operaciones carga CEDEARs y acciones; los
#     futuros operados hoy siguen entrando con el extracto y se ven como
#     diferencia hasta que se sube).
# La foto pasa a tomarse toda la rueda (workers/cocos-sync, cron 10-17).
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    n = s.count(a)
    if n == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, n))

sub('''    const midas = new Map();
    for (const p of positions || []) {
      if (p.broker !== "cocos") continue;
      if (!p.entry_date || p.entry_date >= dia) continue;
      if (p.instrument_type === "fci" || p.instrument_type === "caucion" || p.instrument_type === "option") continue;
      const tk = (p.ticker || "").trim().toUpperCase();
      if (!tk) continue;
      if (p.instrument_type === "bond_ars" || p.instrument_type === "bond_usd") {
        const mat = parseLetraMaturity(tk);
        if (mat && mat < dia) continue;
      }
      midas.set(tk, (midas.get(tk) || 0) + (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0));
    }
    const broker = new Map();
    for (const x of foto.positions || []) {
      const tk = tickerMidasDesdeMatriz(x.tipo, x.simbolo);
      broker.set(tk, (broker.get(tk) || 0) + (Number(x.inicial) || 0));
    }
    const filas = [];
    for (const tk of new Set([...midas.keys(), ...broker.keys()])) {
      const b = broker.get(tk) || 0, m = midas.get(tk) || 0;
      if (Math.abs(b) < 1e-6 && Math.abs(m) < 1e-6) continue;
      filas.push({ tk, b, m, ok: Math.abs(b - m) < 1e-6 });
    }
    filas.sort((x, y) => Number(x.ok) - Number(y.ok) || x.tk.localeCompare(y.tk));
    return { filas, dif: filas.filter((f) => !f.ok).length };''',
'''    // midas = hasta el día anterior (contra la tenencia al abrir);
    // midasHoy = con lo operado hoy (contra la tenencia actual).
    const midas = new Map(), midasHoy = new Map();
    for (const p of positions || []) {
      if (p.broker !== "cocos") continue;
      if (!p.entry_date || p.entry_date > dia) continue;
      if (p.instrument_type === "fci" || p.instrument_type === "caucion" || p.instrument_type === "option") continue;
      const tk = (p.ticker || "").trim().toUpperCase();
      if (!tk) continue;
      if (p.instrument_type === "bond_ars" || p.instrument_type === "bond_usd") {
        const mat = parseLetraMaturity(tk);
        if (mat && mat < dia) continue;
      }
      const q = (p.operation_type === "sell" ? -1 : 1) * (Number(p.quantity) || 0);
      midasHoy.set(tk, (midasHoy.get(tk) || 0) + q);
      if (p.entry_date < dia) midas.set(tk, (midas.get(tk) || 0) + q);
    }
    const broker = new Map(), brokerHoy = new Map();
    for (const x of foto.positions || []) {
      const tk = tickerMidasDesdeMatriz(x.tipo, x.simbolo);
      broker.set(tk, (broker.get(tk) || 0) + (Number(x.inicial) || 0));
      brokerHoy.set(tk, (brokerHoy.get(tk) || 0) + (Number(x.actual) || 0));
    }
    const cero = (n) => Math.abs(n) < 1e-6;
    const filas = [];
    for (const tk of new Set([...midas.keys(), ...broker.keys(), ...midasHoy.keys(), ...brokerHoy.keys()])) {
      const b = broker.get(tk) || 0, m = midas.get(tk) || 0, bh = brokerHoy.get(tk) || 0, mh = midasHoy.get(tk) || 0;
      if (cero(b) && cero(m) && cero(bh) && cero(mh)) continue;
      filas.push({ tk, b, m, bh, mh, ok: cero(b - m), okHoy: cero(bh - mh) });
    }
    filas.sort((x, y) => Number(x.ok && x.okHoy) - Number(y.ok && y.okHoy) || x.tk.localeCompare(y.tk));
    return { filas, dif: filas.filter((f) => !f.ok).length, difHoy: filas.filter((f) => !f.okHoy).length };''', 'comp')

sub('''  const ok = comp.dif === 0;
  const color = ok ? C.green : C.cat.amber;''',
'''  const ok = comp.dif === 0 && comp.difHoy === 0;
  const color = ok ? C.green : C.cat.amber;
  const titulo = ok ? "Cocos coincide con Matriz"
    : comp.dif > 0 ? `Cocos: ${comp.dif} ${comp.dif === 1 ? "papel no coincide" : "papeles no coinciden"} con Matriz al abrir`
    : `Cocos: ${comp.difHoy} ${comp.difHoy === 1 ? "papel operado hoy falta" : "papeles operados hoy faltan"} en Midas`;''', 'titulo')

sub('''        <span style={{ fontWeight: 700, color }}>{ok ? "Cocos coincide con Matriz" : `Cocos: ${comp.dif} ${comp.dif === 1 ? "papel no coincide" : "papeles no coinciden"} con Matriz`}</span>
        <span style={{ color: C.dim }}>
          · foto {hora} · tenencia al abrir vs extracto hasta el día anterior''',
'''        <span style={{ fontWeight: 700, color }}>{titulo}</span>
        <span style={{ color: C.dim }}>
          · foto {hora} · al abrir y ahora''', 'cabecera')

sub('''                <th style={{ textAlign: "left", padding: "3px 14px 3px 0", fontWeight: 600 }}>Papel</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Matriz</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Midas</th>
                <th style={{ textAlign: "right", padding: "3px 0 3px 14px", fontWeight: 600 }}>Diferencia</th>''',
'''                <th style={{ textAlign: "left", padding: "3px 14px 3px 0", fontWeight: 600 }}>Papel</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Matriz al abrir</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Midas al abrir</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Dif.</th>
                <th style={{ textAlign: "right", padding: "3px 14px 3px 28px", fontWeight: 600 }}>Matriz ahora</th>
                <th style={{ textAlign: "right", padding: "3px 14px", fontWeight: 600 }}>Midas ahora</th>
                <th style={{ textAlign: "right", padding: "3px 0 3px 14px", fontWeight: 600 }}>Dif.</th>''', 'th')

sub('''                <tr key={f.tk} style={{ color: f.ok ? C.muted : C.text }}>
                  <td style={{ padding: "2px 14px 2px 0", fontWeight: 600 }}>{f.tk}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.b)}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.m)}</td>
                  <td style={{ textAlign: "right", padding: "2px 0 2px 14px", color: f.ok ? C.green : C.cat.amber, fontWeight: 700 }}>{f.ok ? "ok" : fN(f.m - f.b)}</td>
                </tr>''',
'''                <tr key={f.tk} style={{ color: f.ok && f.okHoy ? C.muted : C.text }}>
                  <td style={{ padding: "2px 14px 2px 0", fontWeight: 600 }}>{f.tk}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.b)}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.m)}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px", color: f.ok ? C.green : C.cat.amber, fontWeight: 700 }}>{f.ok ? "ok" : fN(f.m - f.b)}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px 2px 28px" }}>{fN(f.bh)}</td>
                  <td style={{ textAlign: "right", padding: "2px 14px" }}>{fN(f.mh)}</td>
                  <td style={{ textAlign: "right", padding: "2px 0 2px 14px", color: f.okHoy ? C.green : C.cat.amber, fontWeight: 700 }}>{f.okHoy ? "ok" : fN(f.mh - f.bh)}</td>
                </tr>''', 'tr')

sub('''            El extracto sigue siendo lo que manda. La foto se toma por la API de Primary cada 15 minutos de 10:00 a 12:45, y solo cuenta si Cocos ya cargó Matriz ese día. FCI y cauciones no están en Matriz.''',
'''            El extracto sigue siendo lo que manda. La foto se toma por la API de Primary cada 15 minutos durante toda la rueda, y solo cuenta si Cocos ya cargó Matriz ese día. <b>Al abrir</b> compara la tenencia inicial contra el extracto hasta el día anterior; <b>ahora</b>, la tenencia actual contra Midas con lo operado hoy. Los CEDEARs y acciones operados hoy entran solos cada 5 minutos; los <b>futuros operados hoy</b> entran recién con el extracto y hasta entonces figuran como diferencia. FCI y cauciones no están en Matriz.''', 'texto')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
