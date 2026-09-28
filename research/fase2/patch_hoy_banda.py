# -*- coding: utf-8 -*-
# Posiciones consolidadas: Hoy / % Hoy antes de Rdo. / % R., con la banda cian
# de la columna "MEP actual" del carry (28/09/2026, pedido de LP).
import io, sys
P = r'C:\Users\slider\Documents\Claude\Projects\Midas\src\MidasTerminal.jsx'
s = io.open(P, encoding='utf-8').read()
orig = len(s)
fallos = []

def sub(a, b, nombre):
    global s
    n = s.count(a)
    if n == 1:
        s = s.replace(a, b)
    else:
        fallos.append('%s (%d)' % (nombre, n))

# 1) encabezado: orden nuevo + banda
sub('''                <PTh dense align="right" style={HS} {...sortProps("pnl")}>Rdo.</PTh>
                <PTh dense align="right" style={HS} {...sortProps("pnlpct")}>% R.</PTh>
                <PTh dense align="right" style={HS} {...sortProps("hoy")}>Hoy</PTh>
                <PTh dense align="right" style={HS}>% Hoy</PTh>''',
'''                <PTh dense align="right" style={{ ...HS, ...BANDA_I, color: C.cat.cyan, fontWeight: 700 }} {...sortProps("hoy")}>Hoy</PTh>
                <PTh dense align="right" style={{ ...HS, ...BANDA_D, color: C.cat.cyan, fontWeight: 700 }}>% Hoy</PTh>
                <PTh dense align="right" style={HS} {...sortProps("pnl")}>Rdo.</PTh>
                <PTh dense align="right" style={HS} {...sortProps("pnlpct")}>% R.</PTh>''', '1/header')

# 2) constantes de la banda (tabla)
sub('''    const COLS = 13;''',
'''    const COLS = 13;
    // Banda de "Hoy · % Hoy": el mismo marco cian de la columna "MEP actual"
    // del carry (pedido de LP 28/09/2026). Borde izquierdo en Hoy y derecho
    // en % Hoy, en TODAS las filas, para que se lea como una sola franja.
    const BANDA_I = { borderLeft: `3px solid ${C.cat.cyan}` };
    const BANDA_D = { borderRight: `3px solid ${C.cat.cyan}` };''', '2/constantes')

# 3) fila de categoría: se parte para que la banda no se corte
sub('''                    <tr style={{ background: C.deep }}>
                      <td colSpan={COLS} style={{ ...RC, fontFamily: "inherit", fontWeight: 700, color: C.text }}>
                        {cat.label} <span style={{ color: C.dim, fontWeight: 400 }}>({cat.rows.length})</span>
                      </td>
                    </tr>''',
'''                    <tr style={{ background: C.deep }}>
                      <td colSpan={7} style={{ ...RC, fontFamily: "inherit", fontWeight: 700, color: C.text }}>
                        {cat.label} <span style={{ color: C.dim, fontWeight: 400 }}>({cat.rows.length})</span>
                      </td>
                      <td style={{ ...RC, ...BANDA_I }}></td>
                      <td style={{ ...RC, ...BANDA_D }}></td>
                      <td colSpan={COLS - 9} style={RC}></td>
                    </tr>''', '3/categoria')

# 4) subtotal
sub('''                        <td style={{ ...RN, fontWeight: 700 }}>{t.capital ? fMon(t.act, t.cur) : ""}</td>
                        <td style={{ ...RN, fontWeight: 700, color: colR(t.rdo) }}>{fMon(t.rdo, t.cur)}</td>
                        <td style={{ ...RN, fontWeight: 700, color: colR(t.rdo) }}>{t.capital && t.ini > 0 ? fPctR((t.rdo / t.ini) * 100) : ""}</td>
                        <td style={{ ...RN, fontWeight: 700, color: t.hasHoy ? colR(t.hoy) : C.dim }}>{t.hasHoy ? fMon(t.hoy, t.cur) : "—"}</td>
                        <td style={RN}></td>
                        <td style={RN}></td>''',
'''                        <td style={{ ...RN, fontWeight: 700 }}>{t.capital ? fMon(t.act, t.cur) : ""}</td>
                        <td style={{ ...RN, ...BANDA_I, fontWeight: 700, color: t.hasHoy ? colR(t.hoy) : C.dim }}>{t.hasHoy ? fMon(t.hoy, t.cur) : "—"}</td>
                        <td style={{ ...RN, ...BANDA_D, fontWeight: 700, color: t.hasHoy ? colR(t.hoy) : C.dim }}>{t.hasHoy && t.capital && t.act - t.hoy > 0 ? fPctR((t.hoy / (t.act - t.hoy)) * 100) : ""}</td>
                        <td style={{ ...RN, fontWeight: 700, color: colR(t.rdo) }}>{fMon(t.rdo, t.cur)}</td>
                        <td style={{ ...RN, fontWeight: 700, color: colR(t.rdo) }}>{t.capital && t.ini > 0 ? fPctR((t.rdo / t.ini) * 100) : ""}</td>
                        <td style={RN}></td>''', '4/subtotal')

# 5) total
sub('''                  <td style={{ ...RN, fontWeight: 700 }}>{fMon(grand.act, "ARS")}</td>
                  <td style={{ ...RN, fontWeight: 700, color: colR(grand.rdo) }}>{fMon(grand.rdo, "ARS")}</td>
                  <td style={{ ...RN, fontWeight: 700, color: colR(grand.rdo) }}>{grand.ini > 0 ? fPctR((grand.rdo / grand.ini) * 100) : "—"}</td>
                  <td style={{ ...RN, fontWeight: 700, color: grand.hasHoy ? colR(grand.hoy) : C.dim }}>{grand.hasHoy ? fMon(grand.hoy, "ARS") : "—"}</td>
                  <td colSpan={3} style={RN}></td>''',
'''                  <td style={{ ...RN, fontWeight: 700 }}>{fMon(grand.act, "ARS")}</td>
                  <td style={{ ...RN, ...BANDA_I, fontWeight: 700, color: grand.hasHoy ? colR(grand.hoy) : C.dim }}>{grand.hasHoy ? fMon(grand.hoy, "ARS") : "—"}</td>
                  <td style={{ ...RN, ...BANDA_D, fontWeight: 700, color: grand.hasHoy ? colR(grand.hoy) : C.dim }}>{grand.hasHoy && grand.act - grand.hoy > 0 ? fPctR((grand.hoy / (grand.act - grand.hoy)) * 100) : "—"}</td>
                  <td style={{ ...RN, fontWeight: 700, color: colR(grand.rdo) }}>{fMon(grand.rdo, "ARS")}</td>
                  <td style={{ ...RN, fontWeight: 700, color: colR(grand.rdo) }}>{grand.ini > 0 ? fPctR((grand.rdo / grand.ini) * 100) : "—"}</td>
                  <td colSpan={2} style={RN}></td>''', '5/total')

# 6) fila del papel
sub('''            <td style={{ ...RN, color: pnlColor }}>{group.pnl != null ? fMon(group.pnl) : "—"}</td>
            <td style={{ ...RN, color: pnlColor }}>{fPctR(group.pnlPct)}</td>
            <td style={{ ...RN, color: hoyNulo ? C.dim : dailyColor }}>{hoyNulo ? "—" : fMon(dailyPnl)}</td>
            <td style={{ ...RN, color: hoyNulo ? C.dim : dailyColor }}>{hoyNulo ? "—" : fPctR(dailyPct)}</td>''',
'''            {/* Hoy · % Hoy con la banda cian de "MEP actual" (pedido de LP 28/09). */}
            <td style={{ ...RN, borderLeft: `3px solid ${C.cat.cyan}`, fontWeight: 700, color: hoyNulo ? C.dim : dailyColor }}>{hoyNulo ? "—" : fMon(dailyPnl)}</td>
            <td style={{ ...RN, borderRight: `3px solid ${C.cat.cyan}`, fontWeight: 700, color: hoyNulo ? C.dim : dailyColor }}>{hoyNulo ? "—" : fPctR(dailyPct)}</td>
            <td style={{ ...RN, color: pnlColor }}>{group.pnl != null ? fMon(group.pnl) : "—"}</td>
            <td style={{ ...RN, color: pnlColor }}>{fPctR(group.pnlPct)}</td>''', '6/fila')

if fallos:
    print('FALLOS, no escribo nada: ' + '; '.join(fallos)); sys.exit(1)
io.open(P, 'w', encoding='utf-8').write(s)
print('MidasTerminal.jsx: %d -> %d bytes' % (orig, len(s)))
