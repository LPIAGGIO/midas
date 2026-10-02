# -*- coding: utf-8 -*-
# Bot Scalping (LP 02/10/2026): "hoy aparece positivo 73.376 pero si veo mi
# cartera el total es negativo" + "al costado poner cards: % ganado, proyección,
# TNA". La tabla mostraba solo lo REALIZADO, que en una grilla sin corte es
# siempre positivo; lo malo queda en el latente. Ahora:
#  - la tabla suma el latente al cierre de cada rueda y cierra con el
#    RESULTADO TOTAL (realizado acumulado + latente actual);
#  - al costado van tarjetas con rendimiento, proyección y TNA, siempre
#    separando lo realizado de lo abierto.
import io, sys
P = 'C:/Users/slider/Documents/Claude/Projects/Midas/src/MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
fallos = []
def sub(a, b, et):
    global s
    if s.count(a) == 1: s = s.replace(a, b)
    else: fallos.append('%s (%d)' % (et, s.count(a)))

sub('''supabase.from("scalp_resultados").select("fecha,cuenta,ticker,pnl,ventas,comprado")''',
    '''supabase.from("scalp_resultados").select("fecha,cuenta,ticker,pnl,ventas,comprado,costo_cierre,latente_cierre")''', 'select')
sub('''      const k = h.fecha; if (!m.has(k)) m.set(k, { fecha: k, porCuenta: {}, total: 0, ventas: 0 });
      const d = m.get(k); d.porCuenta[h.cuenta] = (d.porCuenta[h.cuenta] || 0) + Number(h.pnl || 0); d.total += Number(h.pnl || 0); d.ventas += h.ventas || 0;''',
    '''      const k = h.fecha; if (!m.has(k)) m.set(k, { fecha: k, porCuenta: {}, total: 0, ventas: 0, latente: null, invertido: 0 });
      const d = m.get(k); d.porCuenta[h.cuenta] = (d.porCuenta[h.cuenta] || 0) + Number(h.pnl || 0); d.total += Number(h.pnl || 0); d.ventas += h.ventas || 0;
      if (h.latente_cierre != null) d.latente = (d.latente || 0) + Number(h.latente_cierre);
      d.invertido += Number(h.costo_cierre || 0);''', 'histDias')

ini = s.find('          {histDias.length > 0 && (')
fin = s.find('          <div style={{ color: C.dim, fontSize: 11, lineHeight: 1.6, maxWidth: 900 }}>')
if ini < 0 or fin < 0 or fin < ini: fallos.append('bloque')
NUEVO = r'''          {histDias.length > 0 && (() => {
            // Realizado acumulado (todas las ruedas) y latente de AHORA: el resultado
            // verdadero es la suma de los dos. El latente de días anteriores no se
            // suma: es una foto, no un resultado.
            const porC = {}; let acum = 0, vv = 0;
            for (const d of histDias) { for (const [c, v] of Object.entries(d.porCuenta)) porC[c] = (porC[c] || 0) + v; acum += d.total; vv += d.ventas; }
            const n = histDias.length, lat = total.lat, neto = acum + lat, inv = total.inv, expo = total.expo;
            const porRueda = acum / n, pct = (x, base) => (base > 0 ? (x / base) * 100 : null);
            const f2 = (x) => (x == null ? "—" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2).replace(".", ",")}%`);
            const tnaInv = pct(porRueda, inv) != null ? pct(porRueda, inv) * 250 : null;
            const tnaExpo = pct(porRueda, expo) != null ? pct(porRueda, expo) * 250 : null;
            const Card = ({ titulo, valor, col, lineas }) => (
              <div style={{ flex: "1 1 230px", minWidth: 220, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, padding: "12px 14px" }}>
                <div style={{ fontSize: 10, color: C.dim, letterSpacing: 1.1, textTransform: "uppercase", fontWeight: 600 }}>{titulo}</div>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: col || C.text, marginTop: 6 }}>{valor}</div>
                <div style={{ marginTop: 6, fontSize: 11, color: C.muted, lineHeight: 1.6 }}>{lineas.map((l, i) => <div key={i}>{l}</div>)}</div>
              </div>
            );
            return (
            <div style={{ marginBottom: 26 }}>
              <div style={{ fontSize: 11, color: C.dim, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600, marginBottom: 8 }}>Resultado por día</div>
              <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 6, overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: C.text }}>
                  <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    <th style={{ ...th, textAlign: "left" }}>Fecha</th>
                    {cuentas.map(([c]) => <th key={c} style={th}>Cuenta {c}</th>)}
                    <th style={th}>Realizado</th><th style={th}>Ventas</th><th style={th}>Latente al cierre</th>
                  </tr></thead>
                  <tbody>
                    {histDias.map((d) => (
                      <tr key={d.fecha} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={{ ...td, textAlign: "left" }}>{d.fecha.split("-").reverse().join("/")}</td>
                        {cuentas.map(([c]) => <td key={c} style={{ ...td, color: color(d.porCuenta[c] || 0) }}>{d.porCuenta[c] != null ? conSigno(d.porCuenta[c]) : "—"}</td>)}
                        <td style={{ ...td, color: color(d.total), fontWeight: 700 }}>{conSigno(d.total)}</td>
                        <td style={td}>{d.ventas}</td>
                        <td style={{ ...td, color: color(d.latente || 0) }}>{d.latente != null ? conSigno(d.latente) : "—"}</td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: `1px solid ${C.borderStrong}`, background: C.deep }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 700, color: C.muted, fontFamily: "'Roboto', sans-serif" }}>Realizado acumulado · {n} {n === 1 ? "rueda" : "ruedas"}</td>
                      {cuentas.map(([c]) => <td key={c} style={{ ...td, color: color(porC[c] || 0), fontWeight: 700 }}>{porC[c] != null ? conSigno(porC[c]) : "—"}</td>)}
                      <td style={{ ...td, color: color(acum), fontWeight: 700 }}>{conSigno(acum)}</td>
                      <td style={{ ...td, fontWeight: 700 }}>{vv}</td>
                      <td style={td} />
                    </tr>
                    <tr style={{ background: C.deep }}>
                      <td style={{ ...td, textAlign: "left", color: C.muted, fontFamily: "'Roboto', sans-serif" }}>Latente ahora (lo que sigue abierto)</td>
                      {cuentas.map(([c, fs]) => <td key={c} style={{ ...td, color: color(resumen(fs).lat) }}>{conSigno(resumen(fs).lat)}</td>)}
                      <td style={{ ...td, color: color(lat) }}>{conSigno(lat)}</td>
                      <td style={td} /><td style={td} />
                    </tr>
                    <tr style={{ background: C.deep, borderTop: `1px solid ${C.borderStrong}` }}>
                      <td style={{ ...td, textAlign: "left", fontWeight: 700, color: C.text, fontFamily: "'Roboto', sans-serif" }}>Resultado total</td>
                      {cuentas.map(([c, fs]) => { const x = (porC[c] || 0) + resumen(fs).lat; return <td key={c} style={{ ...td, color: color(x), fontWeight: 700 }}>{conSigno(x)}</td>; })}
                      <td style={{ ...td, color: color(neto), fontWeight: 700, fontSize: 13 }}>{conSigno(neto)}</td>
                      <td style={td} /><td style={td} />
                    </tr>
                  </tbody>
                </table>
              </div>
              <div style={{ flex: "1 1 480px", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Card titulo="Resultado total" valor={conSigno(neto)} col={color(neto)} lineas={[
                  `realizado ${conSigno(acum)} · latente ${conSigno(lat)}`,
                  `${f2(pct(neto, inv))} sobre lo invertido hoy`,
                  "Es el número que vale: lo cobrado más lo que falta cerrar.",
                ]} />
                <Card titulo="Realizado por rueda" valor={conSigno(porRueda)} col={color(porRueda)} lineas={[
                  `${(vv / n).toFixed(1).replace(".", ",")} ventas por rueda · ${conSigno(vv ? acum / vv : 0)} por venta`,
                  `${f2(pct(porRueda, inv))} diario sobre lo invertido`,
                ]} />
                <Card titulo="TNA del realizado" valor={tnaInv == null ? "—" : `${tnaInv.toFixed(0)}%`} col={C.text} lineas={[
                  "sobre lo invertido hoy, a 250 ruedas",
                  `sobre la exposición máxima: ${tnaExpo == null ? "—" : tnaExpo.toFixed(0) + "%"}`,
                  "No descuenta lo abierto: si el latente no se recupera, el rendimiento real es menor.",
                ]} />
                <Card titulo="Proyección del realizado" valor={`${conSigno(porRueda * 21)} / mes`} col={color(porRueda)} lineas={[
                  `${conSigno(porRueda * 250)} en un año (250 ruedas)`,
                  `Si se mantiene el promedio de ${n} ${n === 1 ? "rueda" : "ruedas"}.`,
                  n < 20 ? "Con tan pocas ruedas es orientativo, no un pronóstico." : "Promedio de las ruedas listadas.",
                ]} />
                <Card titulo="Capital en juego" valor={plata(inv)} col={C.text} lineas={[
                  `exposición máxima ${plata(expo)}`,
                  `usado ${expo > 0 ? ((inv / expo) * 100).toFixed(0) : "—"}% del máximo`,
                  `el latente es ${f2(pct(lat, inv))} de lo invertido`,
                ]} />
              </div>
              </div>
            </div>
            );
          })()}
'''
if not fallos:
    s = s[:ini] + NUEVO + s[fin:]
sub('''Realizado es neto de comisiones y solo cuenta lotes ya vendidos.''',
    '''Realizado es neto de comisiones y solo cuenta lotes ya vendidos; como el bot no vende con pérdida, el realizado siempre es positivo y lo malo queda en el latente: el número que vale es el resultado total.''', 'nota')
if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('ok')
