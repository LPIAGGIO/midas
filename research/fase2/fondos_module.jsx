/* ═══════════════════════════════════════════════════════════════════════
 * Fondos · ETF con CEDEAR (Fase 1, 17/10/2026; diseño en docs/fondos-diseno.md)
 *
 * Qué muestra: los ETF de EE.UU. que tienen CEDEAR en BYMA, con costo,
 * tamaño, rendimientos contra un índice elegido a mano y contra SPY,
 * volatilidad, dividendos, ratio y precio implícito del CEDEAR al CCL. Y lo
 * que la diferencia: el cruce de la composición del fondo contra la cartera
 * del usuario y sus grillas de Cocos.
 *
 * De dónde sale cada cosa (lo escribe el worker `fondos` en el VPS):
 *   fondos           perfil de Yahoo + rendimientos calculados del cierre
 *                    ajustado (en USD, al último cierre). Los de Yahoo
 *                    ("Morningstar") son al cierre de MES: al 17/10 SMH daba
 *                    +86,9% a 1 año al 30/09 y +57,7% al 16/10. Se muestran
 *                    los dos, rotulados.
 *   fondos_cedear    ratio (Comafi si figura; si no, derivado del precio) y
 *                    si está dudoso. Con ratio dudoso no hay precio implícito.
 *   fondos_holdings  composición completa: State Street diario o N-PORT de
 *                    la SEC (trimestral, ~60 días de atraso: la fecha va
 *                    siempre al lado).
 *   valores_maestro  CUSIP y sector de los subyacentes: el cruce se hace por
 *                    EMISOR (primeros 6 del CUSIP), así GOOG y GOOGL suman
 *                    juntos.
 *
 * El cruce NO suma dos veces lo de las grillas: `positions` ya incluye lo que
 * compraron los bots de Cocos (el extracto arma las posiciones). "Hoy" es la
 * tenencia neta; "techo" reemplaza lo que hoy tiene cada grilla por su máximo
 * teórico = max × (1 + refuerzo) + lateral_max × lote × lateral_frac (el
 * `max` de la config solo no es el techo: NVDA tenía 608 con max 320).
 * ═══════════════════════════════════════════════════════════════════════ */
const FONDOS_ANCLAS = { AAPL: 20, MSFT: 30, NVDA: 24, KO: 5, AMZN: 144, META: 24, GOOGL: 58 };
// Clases de un mismo emisor que Yahoo nombra distinto en su top 10.
const FONDOS_ALIAS = { GOOG: "GOOGL", "BRK-B": "BRKB", "BRK.B": "BRKB" };
/* Apalancados e inversos: su N-PORT son swaps y letras, no la cartera que
 * replican. La exposición económica es N veces la composición del fondo base. */
const FONDOS_DERIVADOS = { SPXL: ["SPY", 3], TQQQ: ["QQQ", 3], SH: ["SPY", -1], PSQ: ["QQQ", -1] };
// Tenencias informadas a mano y pendientes de confirmar contra el extracto.
const FONDOS_PROVISORIOS = {
  SPCX: "12.499 SPCX según la foto de Matriz; provisorio hasta el extracto de Cocos del lunes 19/10",
};
const FONDOS_SECTORES = {
  technology: ["Technology", "Tecnología"],
  communication_services: ["Communication Services", "Comunicaciones"],
  consumer_cyclical: ["Consumer Cyclical", "Consumo cíclico"],
  consumer_defensive: ["Consumer Defensive", "Consumo defensivo"],
  financial_services: ["Financial Services", "Financiero"],
  healthcare: ["Healthcare", "Salud"],
  industrials: ["Industrials", "Industria"],
  energy: ["Energy", "Energía"],
  basic_materials: ["Basic Materials", "Materiales"],
  realestate: ["Real Estate", "Inmobiliario"],
  utilities: ["Utilities", "Servicios públicos"],
};
const FONDOS_SECTOR_ES = Object.fromEntries(Object.values(FONDOS_SECTORES).map(([en, es]) => [en, es]));
const FONDOS_PAISES = {
  US: "EE.UU.", TW: "Taiwán", NL: "Países Bajos", JP: "Japón", CN: "China", KR: "Corea", GB: "Reino Unido",
  FR: "Francia", DE: "Alemania", CH: "Suiza", CA: "Canadá", IN: "India", BR: "Brasil", AU: "Australia",
  HK: "Hong Kong", MX: "México", ZA: "Sudáfrica", SA: "Arabia Saudita", IE: "Irlanda", DK: "Dinamarca",
  SE: "Suecia", ES: "España", IT: "Italia", KY: "Islas Caimán", BM: "Bermudas", IL: "Israel", SG: "Singapur",
  AR: "Argentina", CL: "Chile", PE: "Perú", CO: "Colombia", BE: "Bélgica", FI: "Finlandia", NO: "Noruega",
};

const fdPct = (v, dec = 1, signo = false) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  const s = (n * 100).toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return `${signo && n > 0 ? "+" : ""}${s}%`;
};
const fdNum = (v, dec = 0) => {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("es-AR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
const fdUsd = (v, dec = 0) => (v == null || !Number.isFinite(Number(v)) ? "—" : `US$ ${fdNum(v, dec)}`);
const fdAum = (v) => {
  const n = Number(v);
  if (!(n > 0)) return "—";
  return n >= 1e9 ? `US$ ${fdNum(n / 1e9, 1)} B` : `US$ ${fdNum(n / 1e6, 0)} M`;
};
const fdColor = (v) => (v == null ? C.dim : Number(v) >= 0 ? C.green : C.red);

async function fondosPaginar(armar) {
  let out = [], desde = 0;
  for (;;) {
    const { data, error } = await armar().range(desde, desde + 999);
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < 1000) break;
    desde += 1000;
  }
  return out;
}

/* Techo teórico de una grilla, en papeles. Si la config no trae los campos
 * del lateral se toma solo el refuerzo. */
function fondosTechoGrilla(cfg) {
  const max = Number(cfg?.max) || 0;
  const ref = Number(cfg?.refuerzo) || 0;
  const lat = (Number(cfg?.lateral_max) || 0) * (Number(cfg?.lote) || 0) * (Number(cfg?.lateral_frac) || 0);
  return max * (1 + ref) + lat;
}

/* Cartera del usuario en USD por ticker: neto de CEDEARs (todos los brokers)
 * y grillas. Devuelve null mientras carga. */
function useFondosCartera(user, cedearArs, ccl) {
  const [crudo, setCrudo] = useState(null);
  useEffect(() => {
    let vivo = true;
    if (!user) { setCrudo({ pos: [], grillas: [], maestro: [], error: null }); return () => { vivo = false; }; }
    setCrudo(null);
    (async () => {
      try {
        const pos = await fondosPaginar(() => supabase.from("positions")
          .select("id,ticker,operation_type,quantity")
          .eq("user_id", user.id).eq("instrument_type", "cedear").order("id", { ascending: true }));
        const { data: grillas } = await supabase.from("scalp_estado")
          .select("cuenta,ticker,tenencia,config,ultimo,online").eq("user_id", user.id);
        const tickers = [...new Set(pos.map((p) => String(p.ticker || "").toUpperCase()).filter(Boolean))];
        const { data: maestro } = tickers.length
          ? await supabase.from("valores_maestro").select("ticker,emisor6,sector").in("ticker", tickers)
          : { data: [] };
        if (vivo) setCrudo({ pos, grillas: grillas || [], maestro: maestro || [], error: null });
      } catch (e) {
        if (vivo) setCrudo({ pos: [], grillas: [], maestro: [], error: e?.message || String(e) });
      }
    })();
    return () => { vivo = false; };
  }, [user]);

  return useMemo(() => {
    if (!crudo) return null;
    const neto = new Map();
    for (const p of crudo.pos) {
      const t = String(p.ticker || "").toUpperCase();
      const q = Number(p.quantity) || 0;
      neto.set(t, (neto.get(t) || 0) + (p.operation_type === "sell" ? -q : q));
    }
    const grilla = new Map(); // ticker -> {ten, techo, ultimo}
    for (const g of crudo.grillas) {
      const t = String(g.ticker || "").toUpperCase();
      const v = grilla.get(t) || { ten: 0, techo: 0, ultimo: null, cuentas: 0 };
      v.ten += Number(g.tenencia) || 0;
      v.techo += fondosTechoGrilla(g.config);
      v.ultimo = v.ultimo || Number(g.ultimo) || null;
      v.cuentas += 1;
      grilla.set(t, v);
    }
    const maestro = new Map(crudo.maestro.map((m) => [m.ticker, m]));
    const filas = [];
    const todos = new Set([...neto.keys(), ...grilla.keys()]);
    for (const t of todos) {
      const q = Math.max(0, neto.get(t) || 0);
      const g = grilla.get(t);
      const px = cedearArs[t] || g?.ultimo || null;
      const fuera = Math.max(0, q - (g?.ten || 0));
      const qTecho = fuera + (g?.techo || 0);
      if (!(q > 0) && !(qTecho > 0)) continue;
      const usd = (n) => (px && ccl ? (n * px) / ccl : null);
      filas.push({
        ticker: t, q, qGrilla: g?.ten || 0, qTecho, cuentas: g?.cuentas || 0,
        hoyUsd: usd(q), grillaUsd: usd(g?.ten || 0), techoUsd: usd(qTecho),
        emisor6: maestro.get(t)?.emisor6 || null, sector: maestro.get(t)?.sector || null,
        sinPrecio: !px,
      });
    }
    const totHoy = filas.reduce((a, f) => a + (f.hoyUsd || 0), 0);
    const totTecho = filas.reduce((a, f) => a + (f.techoUsd || 0), 0);
    return { filas, totHoy, totTecho, error: crudo.error, porTicker: new Map(filas.map((f) => [f.ticker, f])) };
  }, [crudo, cedearArs, ccl]);
}

/* Matchea una tenencia del fondo con un papel de la cartera: por emisor si
 * los dos tienen CUSIP, si no por ticker. */
function fondosMatcher(cartera) {
  const porEmisor = new Map(), porTicker = new Map();
  for (const f of cartera?.filas || []) {
    if (f.emisor6) porEmisor.set(f.emisor6, f.ticker);
    porTicker.set(f.ticker, f.ticker);
  }
  return (h) => {
    if (h.emisor6 && porEmisor.has(h.emisor6)) return porEmisor.get(h.emisor6);
    const t = h.ticker ? String(h.ticker).toUpperCase() : null;
    if (!t) return null;
    const a = FONDOS_ALIAS[t] || t.replace(/[.\-\s]/g, "");
    return porTicker.get(t) || porTicker.get(a) || null;
  };
}

function FondosModule() {
  const { user } = useAuth();
  const [tab, setTab] = useState("cedear");
  const [base, setBase] = useState(null);
  const [error, setError] = useState(null);
  const [vivo, setVivo] = useState({ cedear: {}, usd: {}, at: null });
  const [sel, setSel] = useState(null);
  const [orden, setOrden] = useState({ k: "aum", dir: -1 });
  const [busca, setBusca] = useState("");
  const [cat, setCat] = useState("");
  const [solapa, setSolapa] = useState(null); // fondo -> {peso, n}

  useEffect(() => {
    let ok = true;
    (async () => {
      try {
        const [{ data: f, error: e1 }, { data: c, error: e2 }] = await Promise.all([
          supabase.from("fondos").select("*").eq("universo", "etf_cedear"),
          supabase.from("fondos_cedear").select("*"),
        ]);
        if (e1) throw e1;
        if (e2) throw e2;
        if (ok) setBase({ fondos: f || [], cedear: new Map((c || []).map((r) => [r.ticker, r])) });
      } catch (e) { if (ok) setError(e?.message || String(e)); }
    })();
    return () => { ok = false; };
  }, []);

  // Precios en vivo: CEDEAR en pesos (data912) y ETF en USD (Yahoo vía /api/fundamentals?price=).
  useEffect(() => {
    if (!base) return undefined;
    let ok = true;
    const traer = async () => {
      try {
        const r = await fetch(`/api/data912?type=cedears&_=${Date.now()}`);
        const arr = r.ok ? await r.json() : [];
        const cedear = {};
        for (const x of Array.isArray(arr) ? arr : []) if (x?.symbol && Number(x.c) > 0) cedear[x.symbol] = Number(x.c);
        const syms = [...new Set([...base.fondos.map((f) => f.ticker), ...Object.keys(FONDOS_ANCLAS)])];
        const usd = {};
        for (let i = 0; i < syms.length; i += 30) {
          try {
            const p = await fetch(`/api/fundamentals?price=${syms.slice(i, i + 30).join(",")}`);
            const j = p.ok ? await p.json() : {};
            Object.assign(usd, j?.prices || {});
          } catch { /* sigo con lo que haya */ }
        }
        if (ok) setVivo({ cedear, usd, at: new Date() });
      } catch { /* sin precio en vivo la tabla usa el del snapshot */ }
    };
    traer();
    const id = setInterval(traer, 120000);
    return () => { ok = false; clearInterval(id); };
  }, [base]);

  // CCL de referencia en vivo: mediana del CCL implícito de las anclas. Si no
  // hay precios, el del snapshot del worker.
  const ccl = useMemo(() => {
    const xs = Object.entries(FONDOS_ANCLAS)
      .map(([t, r]) => (vivo.cedear[t] > 0 && vivo.usd[t] > 0 ? (vivo.cedear[t] * r) / vivo.usd[t] : null))
      .filter(Boolean).sort((a, b) => a - b);
    if (xs.length >= 4) return { v: xs[Math.floor(xs.length / 2)], fuente: "en vivo" };
    const snap = base ? [...base.cedear.values()].find((c) => c.ccl_ref)?.ccl_ref : null;
    return snap ? { v: Number(snap), fuente: "del snapshot de las 08:15" } : { v: null, fuente: null };
  }, [vivo, base]);

  const cartera = useFondosCartera(user, vivo.cedear, ccl.v);

  // Solapamiento de cada fondo con la cartera (para la columna "Ya tenés").
  useEffect(() => {
    let ok = true;
    if (!base || !cartera || !cartera.filas.length) { setSolapa(null); return () => { ok = false; }; }
    (async () => {
      try {
        const emis = [...new Set(cartera.filas.map((f) => f.emisor6).filter(Boolean))];
        const tks = cartera.filas.map((f) => f.ticker);
        const [a, b] = await Promise.all([
          emis.length ? fondosPaginar(() => supabase.from("fondos_holdings").select("fondo,fecha,clave,emisor6,ticker,peso").in("emisor6", emis).order("fondo").order("clave")) : [],
          fondosPaginar(() => supabase.from("fondos_holdings").select("fondo,fecha,clave,emisor6,ticker,peso").in("ticker", tks).order("fondo").order("clave")),
        ]);
        const fechas = new Map(base.fondos.map((f) => [f.ticker, f.holdings_fecha]));
        const match = fondosMatcher(cartera);
        const visto = new Set(), out = {};
        for (const h of [...a, ...b]) {
          const k = `${h.fondo}|${h.fecha}|${h.clave}`;
          if (visto.has(k) || fechas.get(h.fondo) !== h.fecha || !match(h)) continue;
          visto.add(k);
          out[h.fondo] = (out[h.fondo] || 0) + Number(h.peso || 0) / 100;
        }
        if (ok) setSolapa(out);
      } catch { if (ok) setSolapa({}); }
    })();
    return () => { ok = false; };
  }, [base, cartera]);

  const filas = useMemo(() => {
    if (!base) return [];
    const match = fondosMatcher(cartera);
    return base.fondos.map((f) => {
      const c = base.cedear.get(f.ticker);
      const ars = vivo.cedear[f.ticker] || (c?.cedear_ars ? Number(c.cedear_ars) : null);
      const usd = vivo.usd[f.ticker] || (f.precio_usd ? Number(f.precio_usd) : null);
      const ratio = c?.ratio ? Number(c.ratio) : null;
      const implicito = ratio && usd && ccl.v && !c?.ratio_dudoso ? (usd * ccl.v) / ratio : null;
      const prima = implicito && ars ? ars / implicito - 1 : null;
      let ya = null, yaFuente = null;
      const der = FONDOS_DERIVADOS[f.ticker];
      if (cartera?.filas.length) {
        if (der && solapa) { ya = (solapa[der[0]] || 0) * der[1]; yaFuente = `${der[1]}x ${der[0]}`; }
        else if (f.holdings_fuente && f.holdings_fuente !== "yahoo" && solapa) { ya = solapa[f.ticker] || 0; yaFuente = "completa"; }
        else if (f.top10?.length) {
          ya = f.top10.reduce((s, h) => s + (match({ ticker: h.ticker }) ? Number(h.peso) || 0 : 0), 0);
          yaFuente = "top 10";
        }
      }
      return { ...f, c, ars, usd, ratio, implicito, prima, ya, yaFuente };
    });
  }, [base, vivo, ccl, cartera, solapa]);

  const categorias = useMemo(() => [...new Set(filas.map((f) => f.categoria).filter(Boolean))].sort(), [filas]);
  const valorOrden = (f, k) => ({
    ticker: f.ticker, expense: f.expense_ratio, aum: f.aum_usd, m1: f.ret?.fondo?.m1, m3: f.ret?.fondo?.m3,
    a1: f.ret?.fondo?.a1, a5: f.ret?.fondo?.a5, vol: f.vol_1a, yield: f.yield, prima: f.prima, ya: f.ya,
  }[k]);
  const visibles = useMemo(() => {
    const q = busca.trim().toUpperCase();
    return filas
      .filter((f) => (!cat || f.categoria === cat) && (!q || f.ticker.includes(q) || String(f.nombre || "").toUpperCase().includes(q)))
      .sort((a, b) => {
        const x = valorOrden(a, orden.k), y = valorOrden(b, orden.k);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === "string" ? x.localeCompare(y) : x - y) * orden.dir;
      });
  }, [filas, busca, cat, orden]);

  const th = { textAlign: "right", padding: "7px 8px", fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.07em", color: C.dim, whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" };
  const td = { padding: "6px 8px", fontSize: 12, color: C.text, whiteSpace: "nowrap", textAlign: "right", fontVariantNumeric: "tabular-nums" };
  const Th = ({ k, children, left, title }) => (
    <th title={title} style={{ ...th, textAlign: left ? "left" : "right", color: orden.k === k ? C.text : C.dim }}
      onClick={() => setOrden((o) => ({ k, dir: o.k === k ? -o.dir : k === "ticker" ? 1 : -1 }))}>
      {children}{orden.k === k ? (orden.dir < 0 ? " ↓" : " ↑") : ""}
    </th>
  );

  const seleccionado = sel ? filas.find((f) => f.ticker === sel) : null;

  return (
    <div style={{ padding: "20px 24px", maxWidth: 1400, margin: "0 auto" }}>
      <div className="flex items-baseline" style={{ gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: C.text, letterSpacing: "-0.01em", margin: 0 }}>Fondos</h1>
        <span style={{ fontSize: 12, color: C.muted }}>ETF y FCI, cruzados contra tu cartera</span>
      </div>
      <div className="flex" style={{ gap: 6, margin: "12px 0 14px", flexWrap: "wrap" }}>
        {[["cedear", "ETF con CEDEAR"], ["usa", "ETF EE.UU. y UCITS"], ["fci", "FCI"]].map(([k, l]) => (
          <button key={k} onClick={() => { setTab(k); setSel(null); }}
            style={{
              padding: "6px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer",
              border: `1px solid ${tab === k ? C.accentBorder : C.border}`,
              background: tab === k ? C.accentSoft : "transparent", color: tab === k ? C.text : C.muted,
            }}>{l}</button>
        ))}
      </div>

      {tab !== "cedear" ? (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: C.panel, padding: 22, fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>
          {tab === "usa"
            ? <>En construcción (fase 3). ETF de EE.UU. sin CEDEAR para una cuenta afuera, con su equivalente UCITS de Irlanda al lado: un no residente paga 30% de retención sobre los dividendos de un ETF de EE.UU. (Argentina no tiene tratado) y queda expuesto al impuesto a la herencia de EE.UU. arriba de US$ 60.000; el UCITS de Irlanda paga 15% adentro del fondo y no tiene ese problema.</>
            : <>En construcción (fase 2). FCI argentinos desde la planilla diaria de CAFCI: clase, plazo de rescate, honorarios totales y rendimiento contra caución y plazo fijo.</>}
        </div>
      ) : error ? (
        <div style={{ fontSize: 12, color: C.red, padding: 20 }}>No se pudo leer la tabla de fondos: {error}</div>
      ) : !base ? (
        <div className="flex items-center justify-center" style={{ height: 200 }}><Loader2 size={22} color={C.muted} className="eco-spin" strokeWidth={1.5} /></div>
      ) : !base.fondos.length ? (
        <div style={{ fontSize: 12.5, color: C.muted, padding: 20 }}>Todavía no hay datos: el worker de fondos corre lun-vie a las 08:15.</div>
      ) : seleccionado ? (
        <FondoFicha f={seleccionado} base={filas.find((x) => x.ticker === FONDOS_DERIVADOS[seleccionado.ticker]?.[0]) || null} ccl={ccl} cartera={cartera} user={user} onVolver={() => setSel(null)} />
      ) : (
        <>
          <div style={{ border: `1px solid ${C.borderStrong}`, background: C.deep, borderRadius: 8, padding: "10px 14px", marginBottom: 12, fontSize: 11.5, color: C.muted, lineHeight: 1.55 }}>
            <b style={{ color: C.text }}>{filas.length} ETF de EE.UU. con CEDEAR en BYMA.</b> Rendimientos en USD al último cierre
            ({siFmtFecha(filas[0]?.ret?.hasta)}), calculados del cierre ajustado de Yahoo (con dividendos); el de 5 años es anual.
            Costo, tamaño y yield: Yahoo. Precio implícito = precio del ETF × CCL ÷ ratio, con el CCL de referencia
            {ccl.v ? <> <b style={{ color: C.text }}>{fdNum(ccl.v, 1)}</b> ({ccl.fuente}; mediana de AAPL, MSFT, NVDA, KO, AMZN, META y GOOGL)</> : " (sin dato)"}.
            {cartera?.filas.length ? <> <b style={{ color: C.text }}>Ya tenés</b> = parte del fondo que cae en papeles de tu cartera (composición completa cuando hay; si no, top 10).</> : null}
          </div>
          <div className="flex" style={{ gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar ticker o nombre"
              style={{ background: C.deep, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, color: C.text, minWidth: 200 }} />
            <select value={cat} onChange={(e) => setCat(e.target.value)}
              style={{ background: C.deep, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, color: C.text }}>
              <option value="">Todas las categorías</option>
              {categorias.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {vivo.at ? <span style={{ fontSize: 11, color: C.dim, alignSelf: "center" }}>precios {vivo.at.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</span> : null}
          </div>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, background: C.panel, overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr style={{ background: "rgba(255,255,255,0.02)" }}>
                <Th k="ticker" left>ETF</Th>
                <th style={{ ...th, textAlign: "left", cursor: "default" }}>Categoría</th>
                <Th k="expense" title="Expense ratio anual (Yahoo)">Costo</Th>
                <Th k="aum" title="Patrimonio del fondo (Yahoo)">Tamaño</Th>
                <Th k="m1">1m</Th><Th k="m3">3m</Th><Th k="a1">1a</Th><Th k="a5" title="Anualizado">5a</Th>
                <Th k="vol" title="Volatilidad anual, 1 año de retornos diarios en USD">Vol.</Th>
                <Th k="yield" title="Yield de distribución (Yahoo)">Yield</Th>
                <th style={{ ...th, cursor: "default" }} title="CEDEAR por cuotaparte del ETF">Ratio</th>
                <th style={{ ...th, cursor: "default" }}>CEDEAR</th>
                <th style={{ ...th, cursor: "default" }} title="Precio del ETF × CCL ÷ ratio">Implícito</th>
                <Th k="prima" title="CEDEAR contra implícito: positivo = el CEDEAR está caro contra el CCL de referencia">Prima</Th>
                {cartera?.filas.length ? <Th k="ya" title="Parte del fondo que cae en papeles que ya tenés">Ya tenés</Th> : null}
              </tr></thead>
              <tbody>
                {visibles.map((f) => (
                  <tr key={f.ticker} onClick={() => setSel(f.ticker)} style={{ borderTop: `1px solid ${C.border}`, cursor: "pointer" }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                    <td style={{ ...td, textAlign: "left" }}>
                      <b>{f.ticker}</b>
                      {f.tipo_legal && f.tipo_legal !== "ETF" ? <span style={{ marginLeft: 6, fontSize: 9.5, color: C.cat.amber }}>{f.tipo_legal}</span> : null}
                      <div style={{ fontSize: 10.5, color: C.dim, maxWidth: 230, overflow: "hidden", textOverflow: "ellipsis" }}>{f.nombre}</div>
                    </td>
                    <td style={{ ...td, textAlign: "left", color: C.muted, fontSize: 11, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{f.categoria || "—"}</td>
                    <td style={td}>{fdPct(f.expense_ratio, 2)}</td>
                    <td style={td}>{fdAum(f.aum_usd)}</td>
                    {["m1", "m3", "a1", "a5"].map((k) => <td key={k} style={{ ...td, color: fdColor(f.ret?.fondo?.[k]) }}>{fdPct(f.ret?.fondo?.[k], 1, true)}</td>)}
                    <td style={td}>{fdPct(f.vol_1a, 0)}</td>
                    <td style={td}>{fdPct(f.yield, 1)}</td>
                    <td style={{ ...td, color: f.c?.ratio_dudoso ? C.cat.amber : C.text }} title={f.c ? `fuente: ${f.c.ratio_fuente}${f.c.ratio_dudoso ? " (a confirmar)" : ""}` : ""}>
                      {f.ratio ? `${fdNum(f.ratio)}:1` : "—"}{f.c?.ratio_dudoso ? " ?" : ""}
                    </td>
                    <td style={td}>{f.ars ? `$ ${fdNum(f.ars)}` : "—"}</td>
                    <td style={{ ...td, color: C.muted }}>{f.implicito ? `$ ${fdNum(f.implicito)}` : f.c?.ratio_dudoso ? "a confirmar" : "—"}</td>
                    <td style={{ ...td, color: f.prima == null ? C.dim : Math.abs(f.prima) < 0.005 ? C.muted : f.prima > 0 ? C.red : C.green }}>{fdPct(f.prima, 1, true)}</td>
                    {cartera?.filas.length ? (
                      <td style={{ ...td, color: f.ya > 0.25 ? C.cat.amber : f.ya > 0 ? C.text : C.dim }} title={f.yaFuente ? `con la composición ${f.yaFuente}` : ""}>
                        {f.ya == null ? "—" : fdPct(f.ya, 0)}{f.yaFuente === "top 10" ? <span style={{ fontSize: 9, color: C.dim }}> t10</span> : null}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FondosPie />
        </>
      )}
    </div>
  );
}

function FondosPie() {
  return (
    <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.6, marginTop: 14 }}>
      Fuentes: Yahoo Finance (perfil, precios, dividendos), SEC N-PORT (composición trimestral, se publica 60 días
      después del cierre), State Street (composición diaria de SPY, DIA y los XL*), Comafi y precio de mercado (ratio),
      data912 (CEDEAR en BYMA). Los rendimientos pasados no anticipan los futuros. No es una recomendación: es para
      ver qué le agrega un fondo a lo que ya tenés.
    </div>
  );
}

function FondoFicha({ f, base, ccl, cartera, user, onVolver }) {
  const der = FONDOS_DERIVADOS[f.ticker] && base ? { base, factor: FONDOS_DERIVADOS[f.ticker][1] } : null;
  const src = der ? der.base : f; // de quién se lee la composición
  const [hold, setHold] = useState(null);
  const [monto, setMonto] = useState(10000);
  const [vista, setVista] = useState("hoy"); // hoy | techo

  useEffect(() => {
    let ok = true;
    setHold(null);
    if (!src.holdings_fecha || src.holdings_fuente === "yahoo") { setHold([]); return () => { ok = false; }; }
    (async () => {
      try {
        const d = await fondosPaginar(() => supabase.from("fondos_holdings")
          .select("clave,ticker,nombre,peso,pais,emisor6,tipo")
          .eq("fondo", src.ticker).eq("fecha", src.holdings_fecha).order("peso", { ascending: false }).order("clave"));
        if (ok) setHold(d);
      } catch { if (ok) setHold([]); }
    })();
    return () => { ok = false; };
  }, [src.ticker, src.holdings_fecha, src.holdings_fuente]);

  const hoyIso = new Date().toISOString().slice(0, 10);
  const atrasoComp = src.holdings_fuente === "nport" ? siDiasAtraso(src.holdings_fecha, hoyIso) : null;
  const completa = hold && hold.length > 0;
  const factor = der ? der.factor : 1;
  const composicion = completa
    ? hold.map((h) => ({ ticker: h.ticker, nombre: h.nombre, peso: (Number(h.peso) / 100) * factor, emisor6: h.emisor6 }))
    : (src.top10 || []).map((h) => ({ ticker: h.ticker, nombre: h.nombre, peso: (Number(h.peso) || 0) * factor, emisor6: null }));
  const fuenteTxt = (der ? `exposición equivalente: ${factor}x la composición de ${src.ticker} · ` : "") + ({
    ssga: `State Street, archivo diario al ${siFmtFecha(src.holdings_fecha)}`,
    nport: `SEC N-PORT al ${siFmtFecha(src.holdings_fecha)}`,
    trust: "el fondo tiene el activo directamente (no presenta N-PORT)",
  }[src.holdings_fuente] || "solo el top 10 de Yahoo: no hay composición completa para este fondo");

  // Cruce
  const match = fondosMatcher(cartera);
  const montoN = Math.max(0, Number(monto) || 0);
  const totBase = vista === "hoy" ? cartera?.totHoy || 0 : cartera?.totTecho || 0;
  const cruce = useMemo(() => {
    if (!cartera?.filas.length) return null;
    const porT = new Map();
    for (const h of composicion) {
      const t = match(h);
      if (!t) continue;
      porT.set(t, (porT.get(t) || 0) + h.peso);
    }
    const filas = [...porT.entries()].map(([t, peso]) => {
      const c = cartera.porTicker.get(t);
      const base = (vista === "hoy" ? c?.hoyUsd : c?.techoUsd) || 0;
      const agrega = montoN * peso;
      return { t, peso, c, base, agrega, comb: (base + agrega) / (totBase + montoN || 1), antes: base / (totBase || 1) };
    }).sort((a, b) => b.peso - a.peso);
    const pesoYa = filas.reduce((s, r) => s + r.peso, 0);
    return { filas, pesoYa };
  }, [cartera, composicion, vista, montoN, totBase]);

  const sectores = useMemo(() => {
    const fs = f.sectores || {};
    const filas = Object.entries(FONDOS_SECTORES).map(([k, [en, es]]) => {
      const cart = (cartera?.filas || []).filter((c) => c.sector === en).reduce((s, c) => s + ((vista === "hoy" ? c.hoyUsd : c.techoUsd) || 0), 0);
      const pf = Number(fs[k]) || 0;
      return { es, fondo: pf, antes: totBase ? cart / totBase : 0, despues: (cart + montoN * pf) / ((totBase + montoN) || 1) };
    });
    const sinSector = (cartera?.filas || []).filter((c) => !c.sector || !FONDOS_SECTOR_ES[c.sector]);
    return { filas: filas.filter((r) => r.fondo > 0 || r.antes > 0).sort((a, b) => b.despues - a.despues), sinSector };
  }, [f.sectores, cartera, vista, montoN, totBase]);

  const paises = Object.entries(f.paises || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const r = f.ret || {};
  const filasRet = [
    { l: `${f.ticker} (en USD, al ${siFmtFecha(r.hasta)})`, v: r.fondo, bold: true },
    f.comparador ? { l: `${f.comparador_nombre || f.comparador}`, nota: f.comparador_nota, v: r.comp } : null,
    { l: "SPY (costo de oportunidad)", v: r.spy },
    { l: `${f.ticker} según Yahoo (al cierre de mes)`, v: r.yahoo, dim: true },
    { l: `Promedio de la categoría (Yahoo)`, nota: f.categoria, v: r.cat, dim: true },
  ].filter(Boolean);
  const divYieldCalc = f.div_12m_usd && f.usd ? Number(f.div_12m_usd) / f.usd : null;

  const card = { border: `1px solid ${C.border}`, borderRadius: 8, background: C.panel, padding: "12px 14px" };
  const kpi = (titulo, valor, pie, color) => (
    <div style={{ ...card, minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.08em", color: C.dim }}>{titulo}</div>
      <div className="eco-mono" style={{ fontSize: 18, fontWeight: 600, color: color || C.text, marginTop: 4 }}>{valor}</div>
      {pie ? <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3, lineHeight: 1.4 }}>{pie}</div> : null}
    </div>
  );
  const tdr = { padding: "5px 8px", fontSize: 12, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };
  const barra = (frac, color) => (
    <div style={{ height: 6, background: C.faint, borderRadius: 3, overflow: "hidden", minWidth: 60 }}>
      <div style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%`, height: "100%", background: color || C.accent }} />
    </div>
  );

  return (
    <div>
      <button onClick={onVolver} style={{ fontSize: 12, color: C.accent, background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 10 }}>
        ← Todos los ETF
      </button>
      <div className="flex items-baseline" style={{ gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, color: C.text, margin: 0 }}>{f.ticker}</h2>
        <span style={{ fontSize: 13, color: C.muted }}>{f.nombre}</span>
        {f.tipo_legal && f.tipo_legal !== "ETF" ? <span style={{ fontSize: 10.5, color: C.cat.amber, border: `1px solid ${C.cat.amber}55`, borderRadius: 3, padding: "1px 5px" }}>{f.tipo_legal}</span> : null}
      </div>
      <div style={{ fontSize: 11.5, color: C.dim, marginBottom: 14 }}>
        {[f.familia, f.categoria].filter(Boolean).join(" · ")}
        {f.tipo_legal === "UIT" ? " · fondo de inversión por unidades: no presenta N-PORT" : ""}
        {f.tipo_legal === "ETN" ? " · ETN: es deuda del emisor, no un fondo con activos propios" : ""}
      </div>

      <div className="flex" style={{ gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {kpi("Costo anual", fdPct(f.expense_ratio, 2), "expense ratio · Yahoo")}
        {kpi("Tamaño", fdAum(f.aum_usd), "patrimonio · Yahoo")}
        {kpi("Volatilidad 1a", fdPct(f.vol_1a, 0), `máx. caída 1a ${fdPct(f.max_caida_1a, 1)} · Midas sobre cierres de Yahoo`)}
        {kpi("Dividendos 12m", f.div_12m_usd ? fdUsd(f.div_12m_usd, 2) : "—",
          f.div_12m_usd ? `${(f.dividendos || []).length} pagos · ${fdPct(divYieldCalc, 2)} del precio · yield Yahoo ${fdPct(f.yield, 2)}` : "no distribuye en 12 meses")}
        {kpi("CEDEAR", f.ratio ? `${fdNum(f.ratio)}:1` : "—",
          f.c ? <>ratio {f.c.ratio_fuente === "comafi" ? "de Comafi" : "derivado del precio"}{f.c.ratio_dudoso ? <b style={{ color: C.cat.amber }}> · a confirmar</b> : null}</> : "sin CEDEAR")}
        {kpi("Precio implícito", f.implicito ? `$ ${fdNum(f.implicito)}` : "—",
          f.implicito ? <>CEDEAR $ {fdNum(f.ars)} · prima <b style={{ color: f.prima > 0 ? C.red : C.green }}>{fdPct(f.prima, 2, true)}</b> · CCL {fdNum(ccl.v, 1)}</> : f.c?.ratio_dudoso ? "no se calcula con ratio a confirmar" : null)}
      </div>

      <div style={{ ...card, marginBottom: 14, overflow: "auto" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Rendimiento</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            <th style={{ ...tdr, textAlign: "left", fontSize: 9.5, color: C.dim, textTransform: "uppercase" }}> </th>
            {["1 mes", "3 meses", "1 año", "5 años (anual)"].map((h) => <th key={h} style={{ ...tdr, fontSize: 9.5, color: C.dim, textTransform: "uppercase" }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {filasRet.map((x, i) => (
              <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={{ ...tdr, textAlign: "left", color: x.dim ? C.dim : C.text, fontWeight: x.bold ? 700 : 400, whiteSpace: "normal" }}>
                  {x.l}{x.nota ? <div style={{ fontSize: 10, color: C.dim, fontWeight: 400 }}>{x.nota}</div> : null}
                </td>
                {["m1", "m3", "a1", "a5"].map((k) => (
                  <td key={k} style={{ ...tdr, color: x.dim ? C.dim : fdColor(x.v?.[k]) }}>{fdPct(x.v?.[k], 1, true)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!f.comparador ? <div style={{ fontSize: 10.5, color: C.dim, marginTop: 6 }}>Sin índice de referencia con historia en Yahoo para este fondo: solo contra SPY.</div> : null}
      </div>

      <div className="flex" style={{ gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
        <div style={{ ...card, flex: "2 1 420px", minWidth: 320 }}>
          <div className="flex items-center" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.text }}>Composición</span>
            <span style={{ fontSize: 10.5, color: C.dim }}>{fuenteTxt}{completa ? ` · ${fdNum(hold.length)} papeles` : ""}</span>
            {atrasoComp != null ? <SiAtrasoBadge dias={atrasoComp} /> : null}
          </div>
          {hold == null ? <Loader2 size={18} color={C.muted} className="eco-spin" /> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {composicion.slice(0, 10).map((h, i) => {
                  const mio = match(h);
                  return (
                    <tr key={i} style={{ borderTop: i ? `1px solid ${C.border}` : "none" }}>
                      <td style={{ ...tdr, textAlign: "left", fontWeight: 700, width: 70 }}>{h.ticker || "—"}</td>
                      <td style={{ ...tdr, textAlign: "left", color: C.muted, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>{h.nombre}</td>
                      <td style={tdr}>{fdPct(h.peso, 1)}</td>
                      <td style={{ ...tdr, width: 120 }}>{barra(Math.abs(h.peso / (composicion[0]?.peso || 1)), mio ? C.cat.amber : C.accent)}</td>
                      <td style={{ ...tdr, fontSize: 10, color: C.cat.amber }}>{mio ? "ya tenés" : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {der ? (
            <div style={{ fontSize: 10.5, color: C.cat.amber, marginTop: 8, lineHeight: 1.5 }}>
              {factor < 0 ? "Fondo inverso" : `Fondo apalancado ${factor}x`}: rebalancea todos los días, así que en plazos largos no rinde {factor}x el índice. Su N-PORT son swaps y letras; acá se muestra la exposición que da.
            </div>
          ) : null}
          {!der && completa && f.holdings_fuente === "nport" && f.top10?.length ? (
            <div style={{ fontSize: 10.5, color: C.dim, marginTop: 8, lineHeight: 1.5 }}>
              Más reciente, top 10 de Yahoo: {f.top10.slice(0, 6).map((h) => `${h.ticker || h.nombre} ${fdPct(h.peso, 1)}`).join(" · ")}
            </div>
          ) : null}
        </div>
        <div style={{ ...card, flex: "1 1 260px", minWidth: 240 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Sectores <span style={{ fontSize: 10.5, color: C.dim, fontWeight: 400 }}>Yahoo</span></div>
          {Object.keys(f.sectores || {}).length ? Object.entries(f.sectores).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <div key={k} className="flex items-center" style={{ gap: 8, fontSize: 11.5, marginBottom: 4 }}>
              <span style={{ width: 120, color: C.muted }}>{FONDOS_SECTORES[k]?.[1] || k}</span>
              <span style={{ flex: 1 }}>{barra(v)}</span>
              <span className="eco-mono" style={{ width: 48, textAlign: "right" }}>{fdPct(v, 0)}</span>
            </div>
          )) : <div style={{ fontSize: 11.5, color: C.dim }}>Sin desglose sectorial (bonos, commodities o cripto).</div>}
          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, margin: "14px 0 8px" }}>Países <span style={{ fontSize: 10.5, color: C.dim, fontWeight: 400 }}>{f.nport_fecha ? `N-PORT al ${siFmtFecha(f.nport_fecha)}` : ""}</span></div>
          {paises.length ? paises.map(([k, v]) => (
            <div key={k} className="flex items-center" style={{ gap: 8, fontSize: 11.5, marginBottom: 4 }}>
              <span style={{ width: 120, color: C.muted }}>{FONDOS_PAISES[k] || k}</span>
              <span style={{ flex: 1 }}>{barra(v, C.cat.violet)}</span>
              <span className="eco-mono" style={{ width: 48, textAlign: "right" }}>{fdPct(v, 0)}</span>
            </div>
          )) : <div style={{ fontSize: 11.5, color: C.dim }}>{f.tipo_legal === "UIT" ? "State Street no publica el país en el archivo diario." : "Sin dato de países."}</div>}
        </div>
      </div>

      <div style={{ ...card, marginBottom: 14, borderColor: C.accentBorder }}>
        <div className="flex items-center" style={{ gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Cruce con tu cartera</span>
          {cartera?.filas.length ? (
            <>
              <span style={{ fontSize: 11.5, color: C.muted }}>si comprás</span>
              <input type="number" value={monto} min={0} step={1000} onChange={(e) => setMonto(e.target.value)}
                style={{ width: 110, background: C.deep, border: `1px solid ${C.border}`, borderRadius: 5, padding: "4px 8px", fontSize: 12, color: C.text }} />
              <span style={{ fontSize: 11.5, color: C.muted }}>US$ de {f.ticker}, contra tu cartera</span>
              {[["hoy", "de hoy"], ["techo", "con las grillas al techo"]].map(([k, l]) => (
                <button key={k} onClick={() => setVista(k)} style={{
                  padding: "3px 9px", fontSize: 11, borderRadius: 5, cursor: "pointer",
                  border: `1px solid ${vista === k ? C.accentBorder : C.border}`, background: vista === k ? C.accentSoft : "transparent",
                  color: vista === k ? C.text : C.muted,
                }}>{l}</button>
              ))}
            </>
          ) : null}
        </div>
        {!user ? (
          <div style={{ fontSize: 12, color: C.muted }}>Iniciá sesión para ver cuánto de este fondo ya tenés.</div>
        ) : cartera == null ? (
          <Loader2 size={18} color={C.muted} className="eco-spin" />
        ) : !cartera.filas.length ? (
          <div style={{ fontSize: 12, color: C.muted }}>No tenés CEDEARs cargados. La composición vale igual; el cruce aparece cuando cargues tu cartera.</div>
        ) : !ccl.v ? (
          <div style={{ fontSize: 12, color: C.muted }}>Sin CCL de referencia no se puede pasar la cartera a dólares.</div>
        ) : (
          <>
            <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.55, marginBottom: 10 }}>
              {cruce.pesoYa < 0 ? (
                <>
                  {f.ticker} es inverso: <b>resta</b> {fdUsd(-montoN * cruce.pesoYa)} de exposición a papeles que ya tenés por cada {fdUsd(montoN)}. Funciona como cobertura parcial, no como diversificación.
                </>
              ) : cruce.pesoYa > 0 ? (
                <>
                  <b>{fdPct(cruce.pesoYa, 0)}</b> de lo que comprás de {f.ticker} va a papeles que ya tenés{factor > 1 ? ` (con el apalancamiento ${factor}x)` : ""}
                  ({fdUsd(montoN * cruce.pesoYa)} de {fdUsd(montoN)}).
                  {cruce.filas[0] ? <> El más pesado es <b>{cruce.filas[0].t}</b>, {fdPct(cruce.filas[0].peso, 1)} del fondo
                    {cruce.filas[0].c?.cuentas ? <>, y ya está en {cruce.filas[0].c.cuentas === 1 ? "una grilla" : `las ${cruce.filas[0].c.cuentas} grillas`}</> : null}.</> : null}
                </>
              ) : <>Ninguno de los papeles {completa ? "del fondo" : "del top 10"} está en tu cartera: suma diversificación por nombre.</>}
              {!completa ? <span style={{ color: C.dim }}> Ojo: es con el top 10, la composición completa no está disponible.</span> : null}
            </div>
            {cruce.filas.length ? (
              <div style={{ overflow: "auto", marginBottom: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead><tr>
                    {["Papel", "En el fondo", vista === "hoy" ? "Tenés hoy" : "Tenés al techo", "De eso, grillas", "Va de tu compra", "Peso en tu cartera", "Después"].map((h, i) => (
                      <th key={h} style={{ ...tdr, textAlign: i ? "right" : "left", fontSize: 9.5, color: C.dim, textTransform: "uppercase" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {cruce.filas.map((x) => (
                      <tr key={x.t} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ ...tdr, textAlign: "left", fontWeight: 700 }}>
                          {x.t}{FONDOS_PROVISORIOS[x.t] ? <span title={FONDOS_PROVISORIOS[x.t]} style={{ color: C.cat.amber, fontWeight: 400 }}> *</span> : null}
                        </td>
                        <td style={tdr}>{fdPct(x.peso, 1)}</td>
                        <td style={tdr}>{fdUsd(x.base)}</td>
                        <td style={{ ...tdr, color: C.muted }}>{x.c?.qGrilla ? fdUsd(vista === "hoy" ? x.c.grillaUsd : (x.c.techoUsd - (x.c.hoyUsd - x.c.grillaUsd))) : "—"}</td>
                        <td style={tdr}>{fdUsd(x.agrega)}</td>
                        <td style={{ ...tdr, color: C.muted }}>{fdPct(x.antes, 1)}</td>
                        <td style={{ ...tdr, color: x.comb > x.antes ? C.cat.amber : C.text }}>{fdPct(x.comb, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {sectores.filas.length ? (
              <div style={{ overflow: "auto" }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: C.text, marginBottom: 6 }}>Sectores de tu cartera, antes y después</div>
                <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 620 }}>
                  <thead><tr>
                    {["Sector", `En ${f.ticker}`, "Tu cartera hoy", "Después"].map((h, i) => (
                      <th key={h} style={{ ...tdr, textAlign: i ? "right" : "left", fontSize: 9.5, color: C.dim, textTransform: "uppercase" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {sectores.filas.map((x) => (
                      <tr key={x.es} style={{ borderTop: `1px solid ${C.border}` }}>
                        <td style={{ ...tdr, textAlign: "left" }}>{x.es}</td>
                        <td style={{ ...tdr, color: C.muted }}>{fdPct(x.fondo, 0)}</td>
                        <td style={tdr}>{fdPct(x.antes, 1)}</td>
                        <td style={{ ...tdr, color: x.despues > x.antes + 0.005 ? C.cat.amber : x.despues < x.antes - 0.005 ? C.green : C.text }}>{fdPct(x.despues, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!Object.keys(f.sectores || {}).length ? <div style={{ fontSize: 10.5, color: C.dim, marginTop: 4 }}>Este fondo no tiene desglose sectorial: el "después" solo diluye.</div> : null}
              </div>
            ) : null}
            <div style={{ fontSize: 10.5, color: C.dim, marginTop: 10, lineHeight: 1.55 }}>
              Tu cartera: CEDEARs netos de todos los brokers ({fdUsd(vista === "hoy" ? cartera.totHoy : cartera.totTecho)}), al CCL {fdNum(ccl.v, 1)}.
              Lo que compraron los bots de Cocos ya está adentro (no se suma dos veces).
              {vista === "techo" ? " Al techo: cada grilla con su máximo teórico (escalones + refuerzo + lateral)." : ""}
              {" "}Cruce por emisor (GOOG y GOOGL cuentan juntos). Sectores de tu cartera: Yahoo.
              {sectores.sinSector.length ? ` Sin sector: ${sectores.sinSector.map((c) => c.ticker).join(", ")}.` : ""}
              {cartera.filas.filter((c) => FONDOS_PROVISORIOS[c.ticker]).map((c) => ` * ${FONDOS_PROVISORIOS[c.ticker]}.`).join("")}
              {cartera.filas.some((c) => c.sinPrecio) ? ` Sin precio (no suman): ${cartera.filas.filter((c) => c.sinPrecio).map((c) => c.ticker).join(", ")}.` : ""}
            </div>
          </>
        )}
      </div>
      <FondosPie />
    </div>
  );
}

