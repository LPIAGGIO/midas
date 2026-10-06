/* ─────────── Futuros · Curva DLR (06/10/2026, etapa 1 de "Dólar, futuros y bonos") ───────────
 *
 * Reemplaza en el menú a "Futuros vs Caución". Lee la curva completa de
 * mtr_market_data (worker Matba en el VPS), el spot mayorista, la caución a
 * un día y la historia de ajustes (futures_settlements_history, cargada desde
 * 2023 con backfill_settles.js). Por cada contrato: último, variación contra
 * el ajuste anterior, puntas con su TNA, teórico (spot más caución al plazo),
 * diferencia y lectura, volumen e interés abierto. Después: la posición del
 * usuario según el Libro, los pases entre meses con su percentil histórico,
 * "qué pasó las otras veces" (el ajuste final contra el futuro a 1, 2 y 3
 * meses) y una calculadora de tasa en dólares para pesos cubiertos.
 * No toca el bot de scalping. */

const DLR_RE_CONTRATO = /^DLR\/([A-Z]{3})(\d{2})$/;

/** Último día hábil del mes (sin feriados): el vencimiento de un DLR. */
function vtoDlr(mes, anio) {
  const d = new Date(Date.UTC(anio, mes, 0));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

function percentilDe(valor, serie) {
  const v = (serie || []).filter((x) => Number.isFinite(x));
  if (valor == null || v.length < 5) return null;
  return (100 * v.filter((x) => x <= valor).length) / v.length;
}

const fmtMiles = (n, dec = 0) => (n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec }));
const fmtTasa = (n) => (n == null || !Number.isFinite(n) ? "—" : `${(n * 100).toFixed(1)}%`);

/** Curva DLR en vivo desde mtr_market_data. 15 s en rueda, 10 min fuera. */
function useCurvaDlr() {
  const [filas, setFilas] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState(null);
  const cargar = useCallback(async () => {
    try {
      const corte = new Date(Date.now() - 5 * 86400000).toISOString();
      const { data, error: err } = await supabase
        .from("mtr_market_data")
        .select("symbol,last,last_ts,bid,ask,bid_size,ask_size,volume,volume_nominal,open_interest,settlement,settlement_ts,updated_at")
        .like("symbol", "DLR/%")
        .gt("updated_at", corte);
      if (err) throw err;
      const out = [];
      for (const r of data || []) {
        const m = DLR_RE_CONTRATO.exec(String(r.symbol || "").toUpperCase());
        if (!m) continue;                          // afuera los "M" y los pases DLR/x/y
        const v = parseVtoFuturoEs(r.symbol);
        if (!v) continue;
        const vto = vtoDlr(v.mes, v.anio);
        const dias = daysToExpiry(vto);
        if (dias <= 0) continue;
        out.push({
          symbol: r.symbol, key: normalizarTickerFuturo(r.symbol), label: v.label, vto, dias, sortKey: v.sortKey,
          last: r.last != null ? Number(r.last) : null, lastTs: r.last_ts,
          bid: r.bid != null ? Number(r.bid) : null, ask: r.ask != null ? Number(r.ask) : null,
          bidSize: r.bid_size != null ? Number(r.bid_size) : null, askSize: r.ask_size != null ? Number(r.ask_size) : null,
          volumen: r.volume_nominal != null ? Number(r.volume_nominal) : (r.volume != null ? Number(r.volume) : null),
          oi: r.open_interest != null ? Number(r.open_interest) : null,
          settlement: r.settlement != null ? Number(r.settlement) : null, settlementTs: r.settlement_ts,
        });
      }
      out.sort((a, b) => a.sortKey - b.sortKey);
      setFilas(out); setUpdatedAt(new Date()); setError(null);
    } catch (e) { setError(e.message || "No pude leer la curva"); }
  }, []);
  useEffect(() => {
    cargar();
    let t;
    const prog = () => { t = setTimeout(() => { cargar(); prog(); }, isActiveMarketWindow() ? 15000 : 600000); };
    prog();
    return () => clearTimeout(t);
  }, [cargar]);
  return { filas, updatedAt, error, refresh: cargar };
}

/** Historia de ajustes de todos los DLR (paginada: Supabase corta en 1.000). */
function useHistoriaDlr() {
  const [hist, setHist] = useState({});          // ticker app (DLRDIC26) -> [{d, s}] ordenado
  const [listo, setListo] = useState(false);
  useEffect(() => {
    let vivo = true;
    (async () => {
      const desde = new Date(Date.now() - 4 * 365 * 86400000).toISOString().slice(0, 10);
      const todas = [];
      for (let off = 0; off < 40000; off += 1000) {
        const { data, error } = await supabase
          .from("futures_settlements_history")
          .select("ticker,settle_date,settlement")
          .like("ticker", "DLR%")
          .gte("settle_date", desde)
          .order("settle_date", { ascending: true })
          .range(off, off + 999);
        if (error || !data || !data.length) break;
        todas.push(...data);
        if (data.length < 1000) break;
      }
      if (!vivo) return;
      const m = {};
      for (const r of todas) (m[r.ticker] = m[r.ticker] || []).push({ d: r.settle_date, s: Number(r.settlement) });
      for (const k of Object.keys(m)) m[k].sort((a, b) => a.d.localeCompare(b.d));
      setHist(m); setListo(true);
    })();
    return () => { vivo = false; };
  }, []);
  return { hist, listo };
}

/** Interés abierto de la última foto de AYER (dlr_tick_log), para la variación. */
function useOiAyer() {
  const [oiAyer, setOiAyer] = useState({});
  useEffect(() => {
    (async () => {
      const hoy0 = new Date(); hoy0.setHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("dlr_tick_log")
        .select("symbol,open_interest,snapshot_at")
        .lt("snapshot_at", hoy0.toISOString())
        .order("snapshot_at", { ascending: false })
        .limit(80);
      const m = {};
      for (const r of data || []) if (!(r.symbol in m) && r.open_interest != null) m[r.symbol] = Number(r.open_interest);
      setOiAyer(m);
    })();
  }, []);
  return oiAyer;
}

function CurvaTnaSvg({ filas, spot }) {
  const pts = filas.filter((f) => f.px && f.dias > 0);
  if (pts.length < 2) return null;
  const W = 640, H = 170, L = 44, R = 12, T = 12, B = 28;
  const xs = pts.map((p) => p.dias), ys = [];
  pts.forEach((p) => { [p.tna, p.tnaBid, p.tnaAsk, p.tnaTeo].forEach((v) => { if (Number.isFinite(v)) ys.push(v); }); });
  const xMin = 0, xMax = Math.max(...xs) * 1.04;
  const yMin = Math.min(...ys) - 0.01, yMax = Math.max(...ys) + 0.01;
  const X = (d) => L + ((d - xMin) / (xMax - xMin)) * (W - L - R);
  const Y = (v) => T + (1 - (v - yMin) / (yMax - yMin)) * (H - T - B);
  const linea = (k) => pts.filter((p) => Number.isFinite(p[k])).map((p, i) => `${i ? "L" : "M"}${X(p.dias).toFixed(1)},${Y(p[k]).toFixed(1)}`).join(" ");
  const ticksY = []; for (let v = Math.ceil(yMin * 50) / 50; v <= yMax; v += 0.02) ticksY.push(v);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {ticksY.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={C.faint} strokeWidth="1" />
          <text x={L - 6} y={Y(v) + 3} fontSize="9" fill={C.dim} textAnchor="end">{(v * 100).toFixed(0)}%</text>
        </g>
      ))}
      {pts.map((p) => <text key={p.key} x={X(p.dias)} y={H - 10} fontSize="9" fill={C.dim} textAnchor="middle">{p.label.split(" ")[0].toLowerCase()}</text>)}
      <path d={linea("tnaTeo")} fill="none" stroke={C.dim} strokeWidth="1.2" strokeDasharray="4 3" />
      <path d={linea("tnaAsk")} fill="none" stroke={C.cat.rose} strokeWidth="1" opacity="0.7" />
      <path d={linea("tnaBid")} fill="none" stroke={C.cat.emerald} strokeWidth="1" opacity="0.7" />
      <path d={linea("tna")} fill="none" stroke={C.cat.cyan} strokeWidth="2" />
      {pts.filter((p) => Number.isFinite(p.tna)).map((p) => <circle key={p.key} cx={X(p.dias)} cy={Y(p.tna)} r="3" fill={C.cat.cyan} />)}
      <g fontSize="9" fill={C.muted}>
        <text x={L} y={T + 2}>TNA del último (azul) · puntas (verde compra, rosa venta) · teórica a caución (punteada)</text>
      </g>
    </svg>
  );
}

function FuturosCurvaModule() {
  const { filas: crudas, updatedAt, error, refresh } = useCurvaDlr();
  const { hist, listo: histLista } = useHistoriaDlr();
  const oiAyer = useOiAyer();
  const { positions } = useUserPositions();
  const [spot, setSpot] = useState(null);
  const [caucion, setCaucion] = useState(null);
  const [teaPesos, setTeaPesos] = useState("30");
  const [contratoCalc, setContratoCalc] = useState("");
  const [now, setNow] = useState(new Date());

  useEffect(() => { const i = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(i); }, []);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/dolares");
        if (r.ok) { const fx = await r.json(); const may = fx.find((d) => (d.casa || "").toLowerCase() === "mayorista"); if (may?.venta) setSpot(Number(may.venta)); }
      } catch { /* queda el seed */ }
      try {
        const r = await fetch("/api/a3-cauciones");
        if (r.ok) { const p = extractCaucion1d(await r.json()); if (p?.rate) setCaucion(Number(p.rate)); }
      } catch { /* sin caución */ }
    })();
  }, []);

  const spotUsado = spot ?? DLR_SPOT_SEED;
  const caucUsada = caucion ?? 20;
  const hoyIso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });

  // ── contratos con sus cuentas ──
  const filas = useMemo(() => crudas.map((f) => {
    const h = hist[f.key] || [];
    const prev = [...h].reverse().find((x) => x.d < hoyIso);          // ajuste de ayer (la historia no rota de noche)
    const settlePrev = prev ? prev.s : f.settlement;
    const px = f.last ?? (f.bid && f.ask ? (f.bid + f.ask) / 2 : null) ?? f.settlement;
    const tnaDe = (p) => (p && spotUsado && f.dias > 0 ? (p / spotUsado - 1) * (365 / f.dias) : null);
    const teorico = spotUsado * (1 + (caucUsada / 100) * (f.dias / 365));
    const dif = px && teorico ? px / teorico - 1 : null;
    const lectura = dif == null ? "—" : dif < -0.002 ? "conviene a plazo" : dif > 0.002 ? "conviene contado" : "en línea";
    const oiPrev = oiAyer[f.symbol];
    return {
      ...f, px, settlePrev, var: px && settlePrev ? px / settlePrev - 1 : null,
      tna: tnaDe(px), tnaBid: tnaDe(f.bid), tnaAsk: tnaDe(f.ask), teorico, tnaTeo: tnaDe(teorico), dif, lectura,
      oiVar: f.oi != null && oiPrev != null ? f.oi - oiPrev : null,
      devAcum: px && spotUsado ? px / spotUsado - 1 : null,
    };
  }), [crudas, hist, hoyIso, spotUsado, caucUsada, oiAyer]);

  // ── pases entre meses, con percentil contra la historia de ajustes ──
  const pases = useMemo(() => filas.slice(1).map((f, i) => {
    const a = filas[i];
    const spread = f.px && a.px ? f.px - a.px : null;
    const tramoDias = f.dias - a.dias;
    const tnaTramo = spread != null && a.px && tramoDias > 0 ? (f.px / a.px - 1) * (365 / tramoDias) : null;
    const ha = hist[a.key] || [], hb = hist[f.key] || [];
    const porFecha = new Map(hb.map((x) => [x.d, x.s]));
    const serie = ha.filter((x) => x.d < hoyIso && porFecha.has(x.d)).slice(-120).map((x) => porFecha.get(x.d) - x.s);
    return {
      de: a, a: f, spread, tramoDias, tnaTramo,
      pct: percentilDe(spread, serie), n: serie.length,
      min: serie.length ? Math.min(...serie) : null, max: serie.length ? Math.max(...serie) : null,
      med: serie.length ? [...serie].sort((x, y) => x - y)[Math.floor(serie.length / 2)] : null,
    };
  }), [filas, hist, hoyIso]);

  // ── posición del usuario según el Libro (compras − ventas) ──
  const posicion = useMemo(() => {
    const m = new Map();
    for (const p of positions || []) {
      if (p.instrument_type !== "future" || !p.ticker) continue;
      const k = normalizarTickerFuturo(p.ticker);
      if (!k || !k.startsWith("DLR")) continue;
      const signo = p.operation_type === "sell" ? -1 : 1;
      const q = Number(p.quantity) || 0;
      const e = m.get(k) || { neto: 0, bruto: 0 };
      e.neto += signo * q; e.bruto += signo * q * (Number(p.entry_price) || 0);
      m.set(k, e);
    }
    const out = [];
    for (const [k, e] of m) {
      if (!e.neto) continue;
      const f = filas.find((x) => x.key === k);
      const idx = f ? filas.indexOf(f) : -1;
      const sig = filas[idx + 1] || null;
      const px = f?.px ?? null;
      out.push({
        key: k, neto: e.neto, lado: e.neto < 0 ? "vendido" : "comprado", contratos: Math.abs(e.neto),
        pxMedio: e.neto ? e.bruto / e.neto : null, px, label: f?.label || k.replace("DLR", ""), dias: f?.dias ?? null,
        pnlDia: f && px && f.settlePrev ? e.neto * (px - f.settlePrev) * 1000 : null,
        expoUsd: Math.abs(e.neto) * 1000, expoArs: px ? Math.abs(e.neto) * 1000 * px : null,
        siguiente: sig ? { label: sig.label, pase: sig.px && px ? sig.px - px : null, tnaTramo: sig.px && px && sig.dias > f.dias ? (sig.px / px - 1) * (365 / (sig.dias - f.dias)) : null } : null,
      });
    }
    return out.sort((a, b) => (a.dias ?? 999) - (b.dias ?? 999));
  }, [positions, filas]);

  // ── qué pasó las otras veces: ajuste final contra el futuro a 1, 2 y 3 meses ──
  const despues = useMemo(() => {
    const horizontes = [30, 60, 90];
    const res = horizontes.map((h) => ({ h, n: 0, debajo: 0, difs: [] }));
    for (const [tk, serie] of Object.entries(hist)) {
      const v = parseVtoFuturoEs(tk);
      if (!v || !serie.length) continue;
      const vto = vtoDlr(v.mes, v.anio);
      if (vto >= hoyIso) continue;
      const ult = serie[serie.length - 1];
      if (ult.d < vto.slice(0, 7) + "-20") continue;                     // historia incompleta
      const final = ult.s;
      for (const r of res) {
        const limite = new Date(vto + "T12:00:00Z"); limite.setUTCDate(limite.getUTCDate() - r.h);
        const lim = limite.toISOString().slice(0, 10);
        const antes = [...serie].reverse().find((x) => x.d <= lim);
        if (!antes) continue;
        r.n++; if (final < antes.s) r.debajo++;
        r.difs.push(final / antes.s - 1);
      }
    }
    return res.map((r) => ({ ...r, pctDebajo: r.n ? (100 * r.debajo) / r.n : null, difMedia: r.difs.length ? r.difs.reduce((a, b) => a + b, 0) / r.difs.length : null }));
  }, [hist, hoyIso]);

  // ── calculadora: pesos a tasa, cubiertos con un futuro → tasa en dólares ──
  const calc = useMemo(() => {
    const f = filas.find((x) => x.key === contratoCalc) || filas[2] || filas[0];
    const tea = parseFloat(String(teaPesos).replace(",", ".")) / 100;
    if (!f || !f.px || !Number.isFinite(tea) || f.dias <= 0) return null;
    const crecPesos = Math.pow(1 + tea, f.dias / 365);
    const usdFin = crecPesos * spotUsado / f.px;                           // dólares por cada dólar oficial de hoy
    const teaUsd = Math.pow(usdFin, 365 / f.dias) - 1;
    const devImpl = Math.pow(f.px / spotUsado, 365 / f.dias) - 1;
    return { f, tea, teaUsd, tnaUsd: (usdFin - 1) * (365 / f.dias), devImpl, periodo: usdFin - 1 };
  }, [filas, contratoCalc, teaPesos, spotUsado]);

  const oiTotal = filas.reduce((a, f) => a + (f.oi || 0), 0);
  const oiVarTotal = filas.reduce((a, f) => a + (f.oiVar || 0), 0);
  const tresMeses = filas.find((f) => f.dias >= 75) || filas[filas.length - 1];
  const enRueda = isActiveMarketWindow();
  const th = { fontSize: 9.5, color: C.dim, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 500, padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap" };
  const td = { fontSize: 12, color: C.text, padding: "6px 8px", textAlign: "right", whiteSpace: "nowrap", borderTop: `1px solid ${C.border}` };
  const colorVar = (v) => (v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.muted);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
        <div>
          <span style={{ fontSize: 9.5, color: C.dim, letterSpacing: "0.22em", textTransform: "uppercase" }}>Analizadores · Futuros</span>
          <h1 className="eco-display" style={{ fontSize: 24, fontWeight: 700, letterSpacing: "-0.01em", color: C.text, lineHeight: 1.1, margin: 0 }}>Dólar futuro · la curva entera</h1>
          <p style={{ fontSize: 11.5, color: C.muted, maxWidth: 760, margin: "4px 0 0 0", lineHeight: 1.5 }}>
            Los contratos DLR de Matba Rofex con sus puntas, su tasa y el precio teórico a caución; los pases entre meses contra su historia; tu posición según el Libro; y qué pasó las otras veces.
          </p>
        </div>
        <div className="flex items-center gap-2.5 flex-shrink-0">
          <span style={{ fontSize: 10.5, color: C.muted }}>{enRueda ? "en rueda · cada 15 s" : "mercado cerrado · ajustes de ayer"}{updatedAt ? ` · ${updatedAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
          <RefreshButton onClick={refresh} spinning={false} />
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 mb-5" style={{ backgroundColor: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.25)" }}>
          <AlertTriangle size={16} color={C.red} strokeWidth={1.8} />
          <span style={{ fontSize: 12, color: C.text }}>{error}</span>
        </div>
      )}

      <SectionLabel>Referencias</SectionLabel>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-5">
        <KpiCard label="Oficial (A3500)" value={`$${fmtMiles(spotUsado, 2)}`} sub={spot ? "mayorista, hoy" : "seed"} color={C.cat.cyan} />
        <KpiCard label="Caución 1 día" value={`${caucUsada.toFixed(1)}%`} sub={caucion ? "TNA, en vivo" : "sin dato, uso 20%"} color={C.cat.emerald} />
        <KpiCard label={tresMeses ? `Dólar ${tresMeses.label.toLowerCase()}` : "Dólar a 3 meses"} value={tresMeses?.px ? `$${fmtMiles(tresMeses.px, 1)}` : "—"} sub={tresMeses?.devAcum != null ? `${fmtPct(tresMeses.devAcum * 100)} sobre el oficial · TNA ${fmtTasa(tresMeses.tna)}` : ""} color={C.cat.violet} />
        <KpiCard label="Interés abierto" value={`US$${fmtMiles(oiTotal / 1000)} M`} sub={oiVarTotal ? `${oiVarTotal > 0 ? "+" : ""}${fmtMiles(oiVarTotal / 1000)} M contra ayer` : "sin la foto de ayer"} color={C.cat.amber} />
        <KpiCard label="Contratos" value={String(filas.length)} sub={filas.length ? `hasta ${filas[filas.length - 1].label.toLowerCase()}` : ""} color={C.cat.teal} />
      </div>

      {posicion.length > 0 && (
        <>
          <SectionLabel>Tu posición</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-5">
            {posicion.map((p) => (
              <div key={p.key} style={{ backgroundColor: C.panel, border: `1px solid ${C.border}`, padding: "12px 14px" }}>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <span className="eco-display" style={{ fontSize: 15, fontWeight: 600, color: C.text }}>DLR {p.label} · {p.lado} {p.contratos}</span>
                  <span className="eco-mono" style={{ fontSize: 12, color: C.muted }}>{p.dias != null ? `${p.dias} días` : ""}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2">
                  <Metric label="Resultado hoy" value={p.pnlDia != null ? `${p.pnlDia >= 0 ? "+" : "−"}$${fmtMiles(Math.abs(p.pnlDia))}` : "—"} color={colorVar(p.pnlDia)} />
                  <Metric label="Último" value={p.px ? `$${fmtMiles(p.px, 1)}` : "—"} color={C.text} />
                  <Metric label="Precio medio (Libro)" value={p.pxMedio ? `$${fmtMiles(p.pxMedio, 1)}` : "—"} color={C.text} />
                  <Metric label="Exposición" value={`US$${fmtMiles(p.expoUsd)}${p.expoArs ? ` · $${fmtMiles(p.expoArs / 1e6, 1)} M` : ""}`} color={C.muted} />
                </div>
                {p.siguiente && p.siguiente.pase != null && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                    Rolar a <b style={{ color: C.text }}>{p.siguiente.label}</b>: el pase está en <b style={{ color: C.text }}>${fmtMiles(p.siguiente.pase, 1)}</b> por dólar (TNA del tramo {fmtTasa(p.siguiente.tnaTramo)}).
                    {p.neto < 0 ? ` Estando vendido, rolar cobra el pase: $${fmtMiles(p.siguiente.pase * p.contratos * 1000)} por los ${p.contratos} contratos.` : ` Estando comprado, rolar paga el pase: $${fmtMiles(p.siguiente.pase * p.contratos * 1000)} por los ${p.contratos} contratos.`}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10.5, color: C.dim, marginTop: -8, marginBottom: 16 }}>La posición sale de las filas de futuros del Libro (compras menos ventas). El resultado de hoy es contra el ajuste de ayer, por US$1.000 por contrato.</div>
        </>
      )}

      <SectionLabel>La curva</SectionLabel>
      <div style={{ backgroundColor: C.panel, border: `1px solid ${C.border}`, padding: "10px 12px 4px", marginBottom: 12 }}>
        <CurvaTnaSvg filas={filas} spot={spotUsado} />
      </div>
      <div style={{ overflowX: "auto", backgroundColor: C.panel, border: `1px solid ${C.border}`, marginBottom: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>contrato</th><th style={th}>días</th><th style={th}>último</th><th style={th}>var</th>
              <th style={th}>compra · TNA</th><th style={th}>venta · TNA</th><th style={th}>TNA</th><th style={th}>teórico</th><th style={th}>dif.</th>
              <th style={{ ...th, textAlign: "left" }}>qué dice</th><th style={th}>volumen</th><th style={th}>int. abierto</th><th style={th}>var IA</th>
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.key}>
                <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{f.label.toLowerCase()}</td>
                <td style={td}>{f.dias}</td>
                <td className="eco-mono" style={td}>{f.px ? fmtMiles(f.px, 1) : "—"}</td>
                <td className="eco-mono" style={{ ...td, color: colorVar(f.var) }}>{f.var != null ? fmtPct(f.var * 100) : "—"}</td>
                <td className="eco-mono" style={td}>{f.bid ? `${fmtMiles(f.bid, 1)} · ${fmtTasa(f.tnaBid)}` : "—"}</td>
                <td className="eco-mono" style={td}>{f.ask ? `${fmtMiles(f.ask, 1)} · ${fmtTasa(f.tnaAsk)}` : "—"}</td>
                <td className="eco-mono" style={{ ...td, fontWeight: 600 }}>{fmtTasa(f.tna)}</td>
                <td className="eco-mono" style={{ ...td, color: C.muted }}>{fmtMiles(f.teorico, 1)}</td>
                <td className="eco-mono" style={{ ...td, color: f.dif == null ? C.muted : f.dif < 0 ? C.green : C.cat.orange }}>{f.dif != null ? fmtPct(f.dif * 100) : "—"}</td>
                <td style={{ ...td, textAlign: "left", color: C.muted, fontSize: 11 }}>{f.lectura}</td>
                <td className="eco-mono" style={{ ...td, color: C.muted }}>{f.volumen != null ? fmtMiles(f.volumen) : "—"}</td>
                <td className="eco-mono" style={{ ...td, color: C.muted }}>{f.oi != null ? fmtMiles(f.oi) : "—"}</td>
                <td className="eco-mono" style={{ ...td, color: colorVar(f.oiVar) }}>{f.oiVar != null ? `${f.oiVar > 0 ? "+" : ""}${fmtMiles(f.oiVar)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 10.5, color: C.dim, padding: "8px 10px", lineHeight: 1.5 }}>
          Teórico = oficial más la caución a un día al plazo del contrato. "Conviene a plazo" cuando el futuro cotiza por debajo de ese teórico; "conviene contado" cuando cotiza por encima. La variación es contra el ajuste de ayer. Fuera de rueda las puntas pueden faltar y el último es el ajuste.
        </div>
      </div>

      <SectionLabel>Pases entre meses</SectionLabel>
      <div style={{ overflowX: "auto", backgroundColor: C.panel, border: `1px solid ${C.border}`, marginBottom: 20 }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={{ ...th, textAlign: "left" }}>tramo</th><th style={th}>pase $</th><th style={th}>días</th><th style={th}>TNA del tramo</th><th style={th}>percentil</th><th style={th}>mín · mediana · máx</th><th style={{ ...th, textAlign: "left" }}>lectura</th></tr></thead>
          <tbody>
            {pases.map((p) => (
              <tr key={p.a.key}>
                <td style={{ ...td, textAlign: "left", fontWeight: 600 }}>{p.de.label.toLowerCase()} → {p.a.label.toLowerCase()}</td>
                <td className="eco-mono" style={td}>{p.spread != null ? fmtMiles(p.spread, 1) : "—"}</td>
                <td style={td}>{p.tramoDias}</td>
                <td className="eco-mono" style={{ ...td, fontWeight: 600 }}>{fmtTasa(p.tnaTramo)}</td>
                <td className="eco-mono" style={{ ...td, color: p.pct == null ? C.muted : p.pct >= 80 ? C.cat.orange : p.pct <= 20 ? C.green : C.text }}>{p.pct != null ? `${p.pct.toFixed(0)}%` : "—"}</td>
                <td className="eco-mono" style={{ ...td, color: C.muted }}>{p.n ? `${fmtMiles(p.min, 1)} · ${fmtMiles(p.med, 1)} · ${fmtMiles(p.max, 1)}` : "—"}</td>
                <td style={{ ...td, textAlign: "left", color: C.muted, fontSize: 11 }}>{p.pct == null ? (histLista ? "sin historia común" : "cargando historia") : p.pct >= 80 ? "pase caro contra sus últimas 120 ruedas" : p.pct <= 20 ? "pase barato contra sus últimas 120 ruedas" : "en su rango"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ fontSize: 10.5, color: C.dim, padding: "8px 10px", lineHeight: 1.5 }}>El pase es la diferencia de precio entre dos vencimientos seguidos; la TNA del tramo es la devaluación que descuenta ese mes. El percentil compara el pase de hoy con los ajustes de las últimas 120 ruedas en que cotizaron los dos contratos.</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-5">
        <div style={{ backgroundColor: C.panel, border: `1px solid ${C.border}`, padding: "12px 14px" }}>
          <CardHeader icon={Repeat} iconColor={C.cat.violet} label="Qué pasó las otras veces" />
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 8, lineHeight: 1.5 }}>Para cada contrato ya vencido desde 2023: el ajuste final contra lo que cotizaba el futuro 1, 2 y 3 meses antes.</div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr><th style={{ ...th, textAlign: "left" }}>horizonte</th><th style={th}>casos</th><th style={th}>terminó debajo</th><th style={th}>dif. media</th></tr></thead>
            <tbody>
              {despues.map((r) => (
                <tr key={r.h}>
                  <td style={{ ...td, textAlign: "left" }}>{r.h / 30} {r.h === 30 ? "mes" : "meses"}</td>
                  <td className="eco-mono" style={td}>{r.n}</td>
                  <td className="eco-mono" style={{ ...td, fontWeight: 600 }}>{r.pctDebajo != null ? `${r.pctDebajo.toFixed(0)}% (${r.debajo} de ${r.n})` : "—"}</td>
                  <td className="eco-mono" style={{ ...td, color: colorVar(r.difMedia == null ? null : -r.difMedia) }}>{r.difMedia != null ? fmtPct(r.difMedia * 100) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10.5, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>"Terminó debajo" es cuántas veces el que vendió el futuro cobró el pase entero. La diferencia media es cuánto quedó el ajuste final por debajo (negativo) o por encima del futuro.</div>
        </div>

        <div style={{ backgroundColor: C.panel, border: `1px solid ${C.border}`, padding: "12px 14px" }}>
          <CardHeader icon={Calculator} iconColor={C.cat.emerald} label="Tasa en dólares de tus pesos cubiertos" />
          <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>Pesos colocados a una tasa y un futuro vendido por el mismo monto: lo que queda en dólares oficiales al vencimiento.</div>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <label style={{ fontSize: 10, color: C.dim, letterSpacing: "0.1em", textTransform: "uppercase" }}>TEA en pesos
              <input value={teaPesos} onChange={(e) => setTeaPesos(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, backgroundColor: C.deep, color: C.text, border: `1px solid ${C.border}`, padding: "6px 8px", fontSize: 13 }} />
            </label>
            <label style={{ fontSize: 10, color: C.dim, letterSpacing: "0.1em", textTransform: "uppercase" }}>Contrato
              <select value={contratoCalc || (calc?.f.key ?? "")} onChange={(e) => setContratoCalc(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4, backgroundColor: C.deep, color: C.text, border: `1px solid ${C.border}`, padding: "6px 8px", fontSize: 13 }}>
                {filas.map((f) => <option key={f.key} value={f.key}>{f.label} · {f.dias} días</option>)}
              </select>
            </label>
          </div>
          {calc ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Metric label="Devaluación implícita" value={fmtTasa(calc.devImpl)} color={C.muted} />
              <Metric label="En el período" value={fmtPct(calc.periodo * 100)} color={colorVar(calc.periodo)} />
              <Metric label="TNA en dólares" value={fmtTasa(calc.tnaUsd)} color={colorVar(calc.tnaUsd)} />
              <Metric label="TEA en dólares" value={fmtTasa(calc.teaUsd)} color={colorVar(calc.teaUsd)} large />
            </div>
          ) : <div style={{ fontSize: 11.5, color: C.muted }}>Cargando la curva…</div>}
          <div style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.5 }}>Es contra el dólar oficial, que es a lo que liquida el futuro. Lo que rinde el instrumento en pesos lo ponés vos (el PBA27 hoy ronda 30% de TEA).</div>
        </div>
      </div>
    </div>
  );
}
