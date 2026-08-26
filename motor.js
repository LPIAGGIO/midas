/* extraido de MidasTerminal.jsx - NO editar */
function caucionValueDevengado(p, asOfDate) {
  if (!p || p.instrument_type !== "caucion") return null;
  const capital = Number(p.quantity) || 0;
  if (capital === 0) return 0;

  const tna = Number(p.extra?.rate_tna);
  const termDays = Number(p.extra?.term_days);
  if (!p.entry_date || !Number.isFinite(tna) || !Number.isFinite(termDays)) {
    return capital; // fallback: capital sin intereses
  }

  const startMs = new Date(p.entry_date + "T00:00:00").getTime();
  const refMs = asOfDate
    ? (typeof asOfDate === "string"
        ? new Date(asOfDate + "T00:00:00").getTime()
        : asOfDate.getTime())
    : Date.now();

  let daysElapsed = Math.max(0, Math.floor((refMs - startMs) / 86400000));
  daysElapsed = Math.min(daysElapsed, termDays);

  const interes = capital * (tna / 100) * (daysElapsed / 365);
  return capital + interes;
}

function isNonBusinessDay(yyyymmdd) {
  if (BYMA_HOLIDAYS.has(yyyymmdd)) return true;
  // getDay(): 0=domingo, 6=sábado. Construimos en hora local fija para
  // evitar timezone shifts (yyyy-mm-ddT12:00:00 → mediodía siempre cae
  // el día correcto sin importar la TZ del browser).
  const d = new Date(yyyymmdd + "T12:00:00");
  const dow = d.getDay();
  return dow === 0 || dow === 6;
}

function isTradingDayAndMarketOpened() {
  // Mercado AR (BYMA/MERVAL): DÍA HÁBIL (lun-vie, NO feriado bursátil) y
  // 10:30 a 17:30 ART. Antes solo miraba lun-vie + horario → daba "abierto"
  // en feriados (ej 9 de Julio). Ahora usa isNonBusinessDay (BYMA_HOLIDAYS).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const arDate = `${g("year")}-${g("month")}-${g("day")}`;
  if (isNonBusinessDay(arDate)) return false; // fin de semana o feriado BYMA
  const hh = parseInt(g("hour") || "0", 10);
  const mm = parseInt(g("minute") || "0", 10);
  const mins = hh * 60 + mm;
  return mins >= 10 * 60 + 30 && mins < 17 * 60 + 30; // 10:30–17:30 ART
}

function getRefreshIntervalMs() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value;
  const hh = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const mm = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  const isWeekday = !["Sat", "Sun"].includes(wd);

  // BYMA opera:
  //   - Pre-apertura:        10:30 - 11:00 (precios se actualizan, pero
  //                          no se ejecutan órdenes hasta la apertura).
  //   - Negociación continua:11:00 - 17:00
  //   - Subasta de cierre:   17:00 - 17:05
  //
  // Como data912 publica precios desde la pre-apertura, consideramos
  // "mercado activo" desde 10:30 hasta 17:30 (margen post-cierre para
  // capturar últimas actualizaciones del feed).
  //
  // Usamos lógica de minutos para que 10:30 sea exacto y no 10:00.
  const nowMinutes = hh * 60 + mm;
  const START_MINUTES = 10 * 60 + 30; // 10:30
  const END_MINUTES = 17 * 60 + 30;   // 17:30
  const isMarketHours = nowMinutes >= START_MINUTES && nowMinutes < END_MINUTES;

  // Activo (lun a vie 10:30 a 17:30 ART): refresh cada 15 min.
  // Inactivo: cada 30 min.
  return isWeekday && isMarketHours ? 15 * 60_000 : 30 * 60_000;
}

function isActiveMarketWindow() {
  return getRefreshIntervalMs() === 15 * 60_000;
}

function useStockPrices() {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let mounted = true;
    let timeoutId;

    const fetchAll = async () => {
      try {
        setLoading(true);
        const bust = `?_=${Date.now()}`;

        // Precio híbrido (idea Aquila): con BYMA cerrado el CEDEAR local queda
        // congelado, pero el subyacente sigue operando en NY hasta las ~18 ART.
        // Fuera de rueda traemos también el feed USA + CCL y valuamos los
        // CEDEARs al TEÓRICO = USD × CCL ÷ ratio (source "teorico"). En rueda,
        // manda el operado local como siempre.
        const bymaOpen = isTradingDayAndMarketOpened();
        // Las OPCIONES viajan en este mismo hook a propósito. Podrían tener el
        // suyo, pero `useStockPrices` ya está llamado en diez lugares y
        // `resolvePositionPrice` recibe su mapa: sumar las series acá hace que
        // las opciones se valúen en toda la app sin enhebrar un parámetro
        // nuevo por cada call site. Los símbolos no colisionan (GFGC7400AG no
        // se parece a ningún ticker de acción).
        const [stocksRes, cedearsRes, opcionesRes, usaRes, dolRes] = await Promise.all([
          fetch(`/api/data912?type=acciones&_=${Date.now()}`),
          fetch(`/api/data912?type=cedears&_=${Date.now()}`),
          fetch(`/api/data912?type=opciones&_=${Date.now()}`).catch(() => null),
          bymaOpen ? Promise.resolve(null) : fetch(`/api/data912?type=usa&_=${Date.now()}`).catch(() => null),
          bymaOpen ? Promise.resolve(null) : fetch(`/api/dolares`).catch(() => null),
        ]);

        const stocksArr = stocksRes.ok ? await stocksRes.json() : [];
        const cedearsArr = cedearsRes.ok ? await cedearsRes.json() : [];
        const opcionesArr = opcionesRes?.ok ? await opcionesRes.json().catch(() => []) : [];
        let usdMap = null, ccl = null;
        if (!bymaOpen && usaRes?.ok && dolRes?.ok) {
          try {
            const usaArr = await usaRes.json();
            const dol = await dolRes.json();
            const cclRow = Array.isArray(dol) ? dol.find((d) => (d.casa || "").toLowerCase() === "contadoconliqui") : null;
            ccl = cclRow ? Number(cclRow.venta) || Number(cclRow.compra) : null;
            if (ccl && Array.isArray(usaArr)) {
              usdMap = {};
              for (const it of usaArr) {
                const p = Number(it?.c) || ((Number(it?.px_ask) > 0 && Number(it?.px_bid) > 0) ? (Number(it.px_ask) + Number(it.px_bid)) / 2 : null);
                if (it?.symbol && p > 0) usdMap[String(it.symbol).trim().toUpperCase()] = p;
              }
            }
          } catch { usdMap = null; }
        }

        const map = {};

        const parseItem = (item) => {
          if (!item?.symbol) return;
          const ticker = String(item.symbol).trim().toUpperCase();
          if (map[ticker]) return;

          // El precio de cierre (c) puede venir 0/null con el mercado cerrado o
          // si el ticker no operó. En ese caso caemos al midpoint del book (o
          // ask/bid sueltos). Sin esto, esos CEDEARs quedaban SIN precio y se
          // valuaban a costo (bug: unos aparecían y otros "—" según si c ya
          // había cargado en el feed).
          let price = Number(item.c);
          if (!(price > 0)) {
            const ask = Number(item.px_ask), bid = Number(item.px_bid);
            if (ask > 0 && bid > 0) price = (ask + bid) / 2;
            else if (ask > 0) price = ask;
            else if (bid > 0) price = bid;
          }
          if (!(price > 0)) return;

          let changePct = null;
          let previousClose = null;
          if (item.pct_change != null && Number.isFinite(Number(item.pct_change))) {
            changePct = Number(item.pct_change);
            const denom = 1 + changePct / 100;
            if (denom > 0) {
              previousClose = Number(price) / denom;
            }
          }

          map[ticker] = {
            price: Number(price),
            bid: item.px_bid != null ? Number(item.px_bid) : null,
            ask: item.px_ask != null ? Number(item.px_ask) : null,
            volume: item.v != null ? Number(item.v) : null,
            source: "data912",
            changePct,
            previousClose,
          };
        };

        for (const item of stocksArr) parseItem(item);
        for (const item of cedearsArr) parseItem(item);
        for (const item of opcionesArr) parseItem(item);

        // Override teórico fuera de rueda (solo CEDEARs con ratio conocido y
        // subyacente en el feed USA). Guard ±12% vs el último local: si el
        // teórico se va más que eso, es un ratio/subyacente mal mapeado — se
        // conserva el precio local antes que valuar cualquier cosa.
        if (usdMap && ccl) {
          for (const item of cedearsArr) {
            const tk = String(item?.symbol || "").trim().toUpperCase();
            const cat = CEDEAR_CAT[tk];
            const usd = cat ? usdMap[tk] : null;
            const local = map[tk];
            if (!cat || !usd || !local) continue;
            const theo = (usd * ccl) / cat.r;
            if (!(theo > 0) || theo > local.price * 1.12 || theo < local.price * 0.88) continue;
            map[tk] = {
              ...local,
              price: theo,
              source: "teorico",
              changePct: local.previousClose > 0 ? (theo / local.previousClose - 1) * 100 : local.changePct,
            };
          }
        }

        // FIX 24/08/2026 - ENTRE RUEDAS, LOS CEDEARs CAIAN A COSTO.
        //
        // data912 se vacia al cerrar la rueda y no se vuelve a llenar hasta la
        // apertura. Medido a las 10:16 del 24/08 (BYMA abre 10:30): el endpoint
        // arg_cedears devolvia 3 instrumentos y arg_stocks 97. Sin precio, el
        // resolver saltaba directo a "cost" y la posicion se valuaba al PPP:
        // GLD figuraba en 13.340.000 (lo pagado) en vez de 13.510.000 (cierre
        // del viernes), escondiendo 170.000 ya ganados.
        //
        // El cierre lo tenemos en iol_quotes, que sincroniza el worker de IOL.
        // Lo usamos SOLO para los tickers que el feed no trajo, con source
        // "close" para que la UI lo muestre como cierre y no como precio vivo.
        // Los futuros ya hacian esto con su settlement; esta es la misma idea.
        try {
          // iol_quotes son ~33 filas (los tickers que sincroniza el worker),
          // asi que la traemos entera en vez de armar la lista de faltantes:
          // este hook no recibe los tickers de la cartera.
          {
            const { data: cierres } = await supabase
              .from("iol_quotes")
              .select("ticker, last, prev_close, quote_date");
            let repuestos = 0;
            for (const c of cierres || []) {
              const px = Number(c?.last);
              if (!(px > 0)) continue;
              const tk = (c.ticker || "").toUpperCase().trim();
              if (map[tk]?.price > 0) continue;
              const prev = Number(c?.prev_close);
              map[tk] = {
                price: px,
                previousClose: prev > 0 ? prev : null,
                changePct: prev > 0 ? (px / prev - 1) * 100 : null,
                source: "close",
                closeDate: c.quote_date || null,
              };
              repuestos++;
            }
            if (repuestos > 0) {
              console.info(`[useStockPrices] ${repuestos} ticker(s) completados con el ultimo cierre de iol_quotes`);
            }
          }
        } catch (e) {
          console.warn("[useStockPrices] no se pudo completar con cierres:", e?.message || e);
        }

        if (!mounted) return;
        const now = new Date().toISOString();
        setPrices(map);
        setLastFetch(now);
        setLoading(false);
        setError(null);

        console.info(
          `[useStockPrices] ${Object.keys(map).length} tickers cargados ` +
          `(stocks: ${stocksArr.length}, cedears: ${cedearsArr.length}, opciones: ${opcionesArr.length})`
        );
      } catch (e) {
        if (!mounted) return;
        setError(e.message || "Error cargando precios de acciones");
        setLoading(false);
      }
    };

    fetchAll();

    const scheduleNext = () => {
      const intervalMs = isActiveMarketWindow() ? 5 * 60 * 1000 : 30 * 60 * 1000;
      timeoutId = setTimeout(() => {
        fetchAll().finally(scheduleNext);
      }, intervalMs);
    };
    scheduleNext();

    return () => {
      mounted = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { prices, loading, error, lastFetch, refresh };
}

const C = {
  // Base oscura — adaptación Axon
  bg: "#0F1B2B",            // Gris Axon profundo · workspace + navbar
  panel: "#1A283E",         // Azul Axon · sidebar + cards (color principal de marca)
  deep: "#0D1A29",          // Negro Axon · inputs, elementos hundidos
  text: "#F6F7F6",          // Blanco Axon · texto principal

  // Texto y bordes (basados en Blanco Axon con alpha)
  muted: "rgba(246, 247, 246, 0.62)",
  dim: "rgba(246, 247, 246, 0.38)",
  faint: "rgba(246, 247, 246, 0.10)",
  border: "rgba(246, 247, 246, 0.07)",
  borderStrong: "rgba(246, 247, 246, 0.14)",

  // Acento principal — derivado claro del Azul Axon para trabajar
  // como color de estado activo, links, focus rings, refresh.
  accent: "#5B8DD6",
  accentSoft: "rgba(91, 141, 214, 0.10)",
  accentBorder: "rgba(91, 141, 214, 0.32)",
  accentGlow: "rgba(91, 141, 214, 0.20)",

  // Status semánticos — armonizados con el azul Axon de fondo
  red: "#F87171",
  green: "#4ADE80",
  yellow: "#FACC15",

  // Paleta categórica para charts, KPIs, tickers.
  // Se conserva una paleta amplia y diferenciable porque los charts
  // financieros priorizan contraste entre series por sobre coherencia
  // de marca. Los colores están afinados para legibilidad sobre el
  // fondo Azul Axon (#1A283E) y Gris Axon (#0F1B2B).
  cat: {
    cyan: "#5B8DD6",       // azul-axon-light (acento de marca)
    emerald: "#34D399",
    yellow: "#FACC15",
    pink: "#F472B6",
    violet: "#A78BFA",
    orange: "#FB923C",
    teal: "#22D3EE",
    lime: "#A3E635",
    rose: "#FB7185",
    amber: "#FBBF24",
    indigo: "#818CF8",
  },
};

function resolvePositionPrice(p, bondPrices, futurePrices, stockPrices, fciPrices) {
  const ticker = (p.ticker || "").trim().toUpperCase();

  // 1) Override manual del usuario — máxima prioridad.
  if (p.current_price != null) {
    return { price: Number(p.current_price), source: "manual" };
  }

  // 1b) FCI: VCP desde Supabase (hook useFciPrices). No tienen feed
  //     intra-día, el VCP se publica una vez por día hábil post-cierre.
  if (p.instrument_type === "fci" && fciPrices && ticker) {
    const fp = fciPrices[ticker];
    if (fp?.price != null && fp.price > 0) {
      return { price: Number(fp.price), source: "fci" };
    }
  }

  // 2) Para futuros, feed Primary (tiempo real).
  if (p.instrument_type === "future" && futurePrices && ticker) {
    const fp = futurePrices[ticker];
    if (fp?.price != null && !fp.error) {
      return { price: Number(fp.price), source: "primary" };
    }
    // Sin precio live (mercado cerrado o hueco temporal del feed):
    // usamos el último settlement como fallback. Es la referencia
    // oficial entre sesiones — sin esto la posición caía a "cost" y
    // dejaba de pesar en los totales de cartera.
    if (fp?.settlement != null && fp.settlement > 0 && !fp.error) {
      return { price: Number(fp.settlement), source: "settle" };
    }
  }

  // 3) Para bonos / ONs leemos del cache de precios (BYMA primero, data912
  //    como fallback — el merge ya está hecho en useBondPrices). Acá el
  //    source refleja CUÁL fuente terminó proveyendo el precio para que el
  //    badge UI lo muestre con honestidad.
  if (
    bondPrices &&
    ticker &&
    (p.instrument_type === "bond_ars" ||
      p.instrument_type === "bond_usd" ||
      p.instrument_type === "on")
  ) {
    const m = bondPrices[ticker];
    if (m?.price > 0) {
      // Mapeo del source interno al source "público" usado por el badge
      // UI. Supabase aporta dos sub-fuentes (mae_intraday, mae_close)
      // que la UI consolida bajo el badge "MAE". BYMA y data912 se
      // mantienen como labels propios.
      const src =
        m.source === "byma" || m.source === "data912"
          ? m.source
          : m.source === "mae_intraday" || m.source === "mae_close"
            ? "mae"
            : "market";
      return { price: m.price, source: src };
    }
  }

  // 3b) Para acciones / CEDEARs leemos del hook useStockPrices (data912).
  //     Para variantes de plaza (AAPLD/AAPLC) intentamos también el ticker
  //     base (AAPL) como fallback — data912 expone el base, las variantes
  //     no tienen feed propio en muchos casos.
  if (
    stockPrices &&
    ticker &&
    (p.instrument_type === "stock" || p.instrument_type === "cedear" ||
     // Las opciones viven en el MISMO mapa (useStockPrices las carga junto a
     // acciones y CEDEARs). El multiplicador de contrato ×100 no va acá: lo
     // aplica positionNotional, que es donde corresponde — este resolver
     // devuelve la PRIMA por acción, igual que el feed.
     p.instrument_type === "option")
  ) {
    let m = stockPrices[ticker];
    if (!m?.price && p.instrument_type !== "option") {
      // Intentar base sin sufijo D/C (variante MEP/CCL → ARS base). No aplica
      // a opciones: ahí la última letra es el mes de vencimiento, y recortarla
      // devolvería otra serie.
      const last = ticker.slice(-1);
      if ((last === "D" || last === "C") && ticker.length > 2) {
        const base = ticker.slice(0, -1);
        m = stockPrices[base];
      }
    }
    if (m?.price > 0) {
      return { price: m.price, source: "data912" };
    }
  }

  if (p.entry_price != null) {
    return { price: Number(p.entry_price), source: "cost" };
  }
  return null;
}

function getFutureMultiplier(p) {
  // Multiplicador (tamaño de contrato) del futuro. Si la posición trae uno
  // específico en metadata lo usamos — ej. WTI petróleo = 10 barriles/contrato
  // (extra.contract_size = 10). El resto (futuros DLR) cae al default de 1000.
  const cs = Number(p?.extra?.contract_size);
  return Number.isFinite(cs) && cs > 0 ? cs : FUTURE_MULTIPLIER_DEFAULT;
}

function positionFuturePnL(p, bondPrices, futurePrices) {
  if (p.instrument_type !== "future") return { value: 0, source: "cost" };
  const qty = Number(p.quantity) || 0;
  if (qty === 0 || p.entry_price == null) return { value: 0, source: "cost" };

  const resolved = resolvePositionPrice(p, bondPrices, futurePrices);
  // Si no hay precio actual, asumimos que el contrato sigue valuado a entry
  // → P&L = 0.
  if (!resolved) return { value: 0, source: "cost" };

  const direction = p.operation_type === "sell" ? -1 : 1;
  const pnl = direction * qty * getFutureMultiplier(p) * (resolved.price - Number(p.entry_price));
  return { value: pnl, source: resolved.source };
}

function applyPriceToPosition(p, price) {
  const qty = Number(p.quantity) || 0;
  // Bonos / ONs: precio cada 100 VN
  if (
    p.instrument_type === "bond_ars" ||
    p.instrument_type === "bond_usd" ||
    p.instrument_type === "on"
  ) {
    return (qty * price) / 100;
  }
  // Futuros: ya NO se valúan multiplicando qty × mult × precio (ese es el
  // notional). El "valor de cartera" del futuro es solo su P&L. Se maneja
  // en positionValueAtMarket directamente, no debería caer acá.
  if (p.instrument_type === "future") {
    return qty * getFutureMultiplier(p) * price; // legacy: solo para notional
  }
  // Opciones: contrato * 100 * prima
  if (p.instrument_type === "option") {
    return qty * 100 * price;
  }
  // Acciones, CEDEARs, FCI, USD, Cripto: cantidad * precio
  return qty * price;
}

function positionValueAtMarket(p, bondPrices, futurePrices, stockPrices, fciPrices) {
  // Cauciones: devengamiento prorata lineal sobre el capital colocado.
  // El valor "a mercado" hoy es capital + intereses corridos. Eso se
  // refleja directamente en TOTAL CARTERA. Y el P&L de la caución
  // (valueAtMarket - valueAtCost) son los intereses ganados a la fecha.
  if (p.instrument_type === "caucion") {
    const devengado = caucionValueDevengado(p);
    return {
      value: devengado != null ? devengado : (Number(p.quantity) || 0),
      source: "devengado",
    };
  }
  // Futuros: el "valor" que impacta en cartera es el P&L mark-to-market.
  // El notional NO se incluye (es exposición, no wealth real).
  if (p.instrument_type === "future") {
    return positionFuturePnL(p, bondPrices, futurePrices);
  }
  const resolved = resolvePositionPrice(p, bondPrices, futurePrices, stockPrices, fciPrices);
  if (!resolved) return null;
  return {
    value: applyPriceToPosition(p, resolved.price),
    source: resolved.source,
  };
}

function soberanoCanjeBase(ticker) {
  if (!ticker || typeof ticker !== "string") return null;
  const m = ticker.toUpperCase().trim().match(/^((?:AL|GD|AE|GE)\d{2,3})[CD]?$/);
  return m ? m[1] : null;
}

function parseLetraMaturity(ticker) {
  const mm = /^([ST])(\d{2})([EFMAYJLGSOND])(\d)$/.exec((ticker || "").toUpperCase().trim());
  if (!mm) return null;
  const dd = +mm[2], mon = LETRA_MES[mm[3]], yr = 2020 + (+mm[4]);
  if (!mon || dd < 1 || dd > 31) return null;
  return `${yr}-${String(mon).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function ticker_isBondLike(instrumentType) {
  return (
    instrumentType === "bond_ars" ||
    instrumentType === "bond_usd" ||
    instrumentType === "on"
  );
}

function readFciPricesCache() {
  try {
    const raw = sessionStorage.getItem(FCI_PRICES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.lastFetch || !parsed?.prices) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeFciPricesCache(payload) {
  try {
    sessionStorage.setItem(FCI_PRICES_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* sessionStorage puede fallar en private mode */
  }
}

function useFciPrices(positions) {
  const cached = readFciPricesCache();
  const [prices, setPrices] = useState(cached?.prices || {});
  const [lastFetch, setLastFetch] = useState(cached?.lastFetch || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Claves (= position.ticker) de los FCI que el usuario tiene en cartera.
  // Solo pedimos precios de ESOS fondos: fci_quotes tiene 1000+ fondos, no
  // tiene sentido (ni escala) traerlos todos.
  const fciClaves = useMemo(() => {
    if (!Array.isArray(positions)) return [];
    const set = new Set();
    for (const p of positions) {
      if (p?.instrument_type === "fci" && p.ticker) set.add(p.ticker);
    }
    return [...set].sort();
  }, [positions]);

  // String estable para la dependencia del effect: refetcheamos solo
  // cuando cambia el CONJUNTO de FCI en cartera, no en cada update de
  // positions (que cambia de identidad seguido).
  const clavesKey = fciClaves.join("||");

  useEffect(() => {
    let mounted = true;

    // Sin FCI en cartera: nada que pedir.
    if (fciClaves.length === 0) {
      setPrices({});
      setLoading(false);
      return () => { mounted = false; };
    }

    // Cache fresco que cubre TODOS los fondos en cartera → no pegamos a
    // Supabase. Si agregaste un FCI nuevo, alguna clave va a faltar en el
    // cache y refetcheamos igual.
    if (cached && refreshKey === 0) {
      const age = Date.now() - new Date(cached.lastFetch).getTime();
      // cached.prices está indexado por ticker normalizado (UPPER) — ver
      // armado del map más abajo. Normalizamos la clave para chequear.
      const cubreTodo = fciClaves.every(
        (c) => cached.prices?.[String(c).trim().toUpperCase()] != null
      );
      if (age < FCI_PRICES_TTL_MS && cubreTodo) {
        // Caché válido: re-aplicamos los precios EXPLÍCITAMENTE. No alcanza
        // con el initializer de useState — en un remontaje (volver al
        // dashboard) el primer render corre con `positions` todavía vacío,
        // el effect entra por la rama "sin FCI" y hace setPrices({}); cuando
        // `positions` carga y el effect vuelve a correr, esta rama tiene que
        // RESTAURAR los precios desde el caché, no asumir que siguen puestos.
        // Sin este setPrices los FCI quedaban en blanco al volver a la
        // pantalla (solo el botón "Actualizar" los traía, vía refreshKey).
        setPrices(cached.prices);
        setLastFetch(cached.lastFetch);
        setLoading(false);
        return () => { mounted = false; };
      }
    }

    setError(null);
    setLoading(true);

    (async () => {
      try {
        // La RPC hace el trabajo pesado del lado del servidor: agarra las
        // dos últimas filas de cada fondo y calcula la variación.
        const { data, error: qErr } = await supabase.rpc("get_fci_prices", {
          p_claves: fciClaves,
        });

        if (qErr) throw qErr;

        // Distancia en días entre dos snapshots: la usamos para decidir si
        // la variación es "diaria" de verdad o atraviesa un hueco de datos.
        const diasEntre = (a, b) => {
          if (!a || !b) return Infinity;
          const ms = new Date(a).getTime() - new Date(b).getTime();
          return Math.abs(ms) / 86400000;
        };
        const MAX_GAP_DIARIO = 5; // un fin de semana largo entra; más es hueco

        const map = {};
        for (const row of data || []) {
          const price = Number(row.vcp_actual);
          if (!Number.isFinite(price) || price <= 0) continue;

          let previousClose = null;
          let changePct = null;
          // Solo tratamos esto como variación del día si los dos snapshots
          // están pegados. fci-snapshot tiene huecos: un "anterior" de hace
          // dos semanas NO es el cierre de ayer, y mostrarlo como P&L del
          // día sería mentir.
          const prevVcp = Number(row.vcp_anterior);
          if (
            Number.isFinite(prevVcp) && prevVcp > 0 &&
            diasEntre(row.fecha_actual, row.fecha_anterior) <= MAX_GAP_DIARIO
          ) {
            previousClose = prevVcp;
            changePct =
              row.change_pct != null
                ? Number(row.change_pct)
                : ((price - prevVcp) / prevVcp) * 100;
          }

          // SIN proyección: Cocos muestra el ÚLTIMO VCP PUBLICADO (no el devengado
          // de hoy). Verificado 18/06: fci_quotes 16/06 = 1.386,666 = EXACTO el VCP
          // que mostraba Cocos. Proyectar hacia "hoy" dejaba a Midas por ENCIMA de
          // lo que muestra Cocos (overshoot, ~+2 pesos). Mostramos el VCP crudo más
          // reciente del feed = misma metodología que Cocos → matchea al peso. Si el
          // feed público (CAFCI/fci_quotes) viene 1-2 días atrás del feed interno de
          // Cocos, Midas queda apenas atrás (nunca por encima) y se acomoda solo
          // cuando el worker actualiza de noche. previousClose/changePct (arriba) se
          // mantienen solo para la variación % del día.
          const finalPrice = price;
          const estimated = false;

          // Indexamos por ticker NORMALIZADO (trim + UPPER). Los
          // consumidores (resolvePositionPrice, computeDailyPnL,
          // consolidatePositions) normalizan el ticker a mayúsculas, y el
          // ticker de un FCI es un string "fondo|categoria" con minúsculas.
          // Sin esta normalización la clave nunca matcheaba y el FCI
          // quedaba sin valuar, mostrándose como "—".
          map[String(row.clave).trim().toUpperCase()] = {
            price: finalPrice,
            vcpOficial: price,
            estimated,
            previousClose,
            changePct,
            priceDate: row.fecha_actual || null,
          };
        }

        if (!mounted) return;
        const nowIso = new Date().toISOString();
        setPrices(map);
        setLastFetch(nowIso);
        setLoading(false);
        writeFciPricesCache({ prices: map, lastFetch: nowIso });

        console.info(`[useFciPrices] ${Object.keys(map).length} FCI cargados`);
      } catch (e) {
        if (!mounted) return;
        setError(e.message || "Error cargando precios de FCI");
        setLoading(false);
      }
    })();

    return () => { mounted = false; };
  }, [clavesKey, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  return { prices, loading, error, lastFetch, refresh };
}

function applyConventionToValue(instrumentType, qty, price) {
  // Bonos / ONs: precio cada 100 VN
  if (
    instrumentType === "bond_ars" ||
    instrumentType === "bond_usd" ||
    instrumentType === "on"
  ) {
    return (qty * price) / 100;
  }
  // Futuros: contrato * 1000 (multiplicador típico DLR)
  if (instrumentType === "future") {
    return qty * 1000 * price;
  }
  // Opciones: contrato * 100 * prima
  if (instrumentType === "option") {
    return qty * 100 * price;
  }
  return qty * price;
}

function consolidatePositions(positions, bondPrices, futurePrices, fciPrices, stockPrices) {
  if (!positions?.length) return [];
  // Hoy (para descartar letras/boncaps ya vencidas de la tenencia).
  const _todayISO = new Date().toISOString().slice(0, 10);

  // Tipos donde NO consolidamos: cada operación queda individual.
  // Son instrumentos donde el "ticker" no identifica unívocamente un
  // activo fungible (cauciones a distinto plazo, opciones con strike
  // distinto). Los FCI sí consolidan: comprar más cuotapartes del mismo
  // ticker es ampliar la misma posición — el VCP es uno solo para todas
  // las cuotapartes del fondo.
  const NO_CONSOLIDATE = new Set(["caucion", "option"]);

  /**
   * Construye el detalle "neteado" de operaciones para mostrar en el
   * expandible de la fila CERRADA, y calcula el P&L realizado total
   * sumando el P&L de cada par sintético.
   *
   * Reemplaza el log crudo de movimientos por pares COMPRA↔VENTA donde
   * cada par representa una venta original con su contraparte de costo
   * al PPP que tenía la posición JUSTO ANTES de esa venta.
   *
   * Ejemplo:
   *   compra 100 @ 10  → PPP en ese momento = 10
   *   venta  40 @ 12   → emite par: compra-espejo "40 @ 10" + venta "40 @ 12"
   *                       (P&L par = 40 × (12-10) = 80 raw)
   *   compra 60 @ 14   → PPP ahora = (60×10 + 60×14) / 120 = 12  (60 quedaron del lote inicial)
   *   venta  50 @ 15   → emite par: compra-espejo "50 @ 12" + venta "50 @ 15"
   *                       (P&L par = 50 × (15-12) = 150 raw)
   *
   * Las operaciones sintéticas se marcan con isSynthetic=true para que
   * la UI deshabilite los botones edit/delete (no existen en la BD).
   *
   * IMPORTANTE: El P&L "raw" devuelto NO tiene aplicada la convención
   * del instrumento (×100 para opciones, ×1000 para futuros, /100 para
   * bonos). Lo aplicamos en el caller con applyConventionToValue.
   *
   * @returns { synthetic: [...], realizedPnlRaw: number }
   */
  const buildClosedOperationsSynthetic = (g) => {
    // Ordenar cronológicamente: entry_date asc, created_at asc como tiebreaker.
    // Una operación sin entry_date va al final (caso edge).
    const sorted = [...g.operations].sort((a, b) => {
      const da = a.entry_date || "9999-12-31";
      const db = b.entry_date || "9999-12-31";
      if (da !== db) return da.localeCompare(db);
      const ca = a.created_at || "";
      const cb = b.created_at || "";
      return ca.localeCompare(cb);
    });

    // Recorremos las operaciones en orden cronológico, calzando lotes.
    // En cada momento la posición está long (compras sin calzar) o
    // short (ventas sin calzar), nunca las dos cosas a la vez. Un SELL
    // calza contra compras abiertas (cierra un long); un BUY calza
    // contra ventas abiertas (cierra un short). El sobrante de
    // cualquiera de los dos abre/extiende el lado opuesto. Cada lote
    // calzado emite UNA fila sintética "closed_pair" con su precio de
    // compra y de venta reales — funcione el cierre por el lado long
    // o short. Esto hace que un short cerrado (vender y después
    // recomprar) calcule el P&L igual de bien que un long.
    let openBuyQty = 0;
    let openBuyValue = 0;   // suma(qty × price) de compras sin calzar
    let openSellQty = 0;
    let openSellValue = 0;  // suma(qty × price) de ventas sin calzar
    const synthetic = [];
    let realizedPnlRaw = 0;
    let synthIdx = 0;

    // Emite una fila "closed_pair" para un lote calzado y le suma el
    // P&L raw. El P&L de un par siempre es (precioVenta − precioCompra)
    // × qty, sin importar si el par se cerró por el lado long o short.
    // - entry_price guarda el precio de la pata compradora.
    // - sell_price guarda el precio de la pata vendedora.
    // - entry_date es la fecha de la operación que CIERRA el par.
    const pushPair = (closingOp, matchedQty, buyPrice, sellPrice, openDate = null, closeSide = null) => {
      synthetic.push({
        id: `${closingOp.id}__synth_pair_${synthIdx}`,
        isSynthetic: true,
        operation_type: "closed_pair",
        ticker: closingOp.ticker,
        instrument_type: closingOp.instrument_type,
        broker: closingOp.broker || "manual",
        quantity: matchedQty,
        entry_price: buyPrice,
        sell_price: sellPrice,
        entry_currency: closingOp.entry_currency,
        entry_date: closingOp.entry_date,
        notes: closingOp.notes || null,
        // Para futuros: fecha del lote que se ABRE (la pata vieja del par) y
        // qué lado cierra. filterClosedToToday los usa para el P&L del DÍA
        // (base = settle anterior si el lote venía arrastrado de días previos,
        // o el precio de apertura si se abrió hoy). closeDate = entry_date.
        openDate,
        closeSide,
      });
      synthIdx++;
      realizedPnlRaw += matchedQty * (sellPrice - buyPrice);
    };

    // ─── FUTUROS: matcheo LIFO ──────────────────────────────────────────
    // Para futuros el usuario day-tradea alrededor de un lote core (ej. un
    // short de fondo + scalps intradía: vender alto, recomprar más abajo).
    // La recompra tiene que cerrar el short abierto MÁS RECIENTE, no el
    // viejo — así el realizado refleja los scalps del día y el core queda
    // intacto. Por eso LIFO con stacks de lotes. Acciones/bonos siguen con
    // el promedio ponderado del lado abierto (abajo), que matchea el PPC
    // de Cocos para instrumentos contado.
    if (g.instrument_type === "future") {
      const openBuys = []; // [{ qty, price, date }] — stack (cierra desde el final)
      const openSells = [];
      const closeAgainst = (stack, remaining, makePair) => {
        let rem = remaining;
        while (rem > 0 && stack.length > 0) {
          const lot = stack[stack.length - 1];
          const matched = Math.min(rem, lot.qty);
          makePair(matched, lot);
          lot.qty -= matched;
          rem -= matched;
          if (lot.qty <= 1e-9) stack.pop();
        }
        return rem;
      };
      for (const op of sorted) {
        const qty = Number(op.quantity) || 0;
        const price = Number(op.entry_price) || 0;
        if (qty <= 0) continue;
        if (op.operation_type === "sell") {
          // cierra compras abiertas (long) LIFO; el sobrante abre/extiende short.
          // openDate = fecha del lote comprado (la pata que se abre).
          const rem = closeAgainst(openBuys, qty, (m, lot) =>
            pushPair(op, m, lot.price, price, lot.date, "long")
          );
          if (rem > 0) openSells.push({ qty: rem, price, date: op.entry_date });
        } else {
          // cierra ventas abiertas (short) LIFO; el sobrante abre/extiende long.
          // openDate = fecha del lote vendido (la pata que se abre).
          const rem = closeAgainst(openSells, qty, (m, lot) =>
            pushPair(op, m, price, lot.price, lot.date, "short")
          );
          if (rem > 0) openBuys.push({ qty: rem, price, date: op.entry_date });
        }
      }
      const sumQ = (arr) => arr.reduce((s, l) => s + l.qty, 0);
      const sumV = (arr) => arr.reduce((s, l) => s + l.qty * l.price, 0);
      return {
        synthetic,
        realizedPnlRaw,
        openBuyQty: sumQ(openBuys),
        openBuyValue: sumV(openBuys),
        openSellQty: sumQ(openSells),
        openSellValue: sumV(openSells),
      };
    }

    for (const op of sorted) {
      const qty = Number(op.quantity) || 0;
      const price = Number(op.entry_price) || 0;
      if (qty <= 0) continue;

      if (op.operation_type === "sell") {
        // Un SELL primero cierra compras abiertas (cierre de long).
        let remaining = qty;
        if (openBuyQty > 0) {
          const buyPPP = openBuyValue / openBuyQty;
          const matched = Math.min(remaining, openBuyQty);
          pushPair(op, matched, buyPPP, price);
          openBuyQty -= matched;
          openBuyValue -= matched * buyPPP;
          remaining -= matched;
        }
        // El sobrante abre/extiende un short.
        if (remaining > 0) {
          openSellQty += remaining;
          openSellValue += remaining * price;
        }
      } else {
        // Un BUY primero cierra ventas abiertas (cierre de short).
        let remaining = qty;
        if (openSellQty > 0) {
          const sellPPV = openSellValue / openSellQty;
          const matched = Math.min(remaining, openSellQty);
          pushPair(op, matched, price, sellPPV);
          openSellQty -= matched;
          openSellValue -= matched * sellPPV;
          remaining -= matched;
        }
        // El sobrante abre/extiende un long.
        if (remaining > 0) {
          openBuyQty += remaining;
          openBuyValue += remaining * price;
        }
      }
    }

    // Devolvemos también el estado FINAL del FIFO (lots vivos del lado
    // que quedó abierto). consolidatePositions lo necesita para calcular
    // basePriceForPnL correctamente cuando la posición cruzó el cero
    // (LONG→SHORT o SHORT→LONG): el PPP histórico de TODAS las compras
    // (g.weightedBuyPriceNumerator/totalBuyQty) incluye compras que YA se
    // cerraron y da MTM unrealized incorrecto en esos casos.
    return {
      synthetic,
      realizedPnlRaw,
      openBuyQty,
      openBuyValue,
      openSellQty,
      openSellValue,
    };
  };

  // ─── Normalización de soberanos hard-dollar (canje por bono base) ──────
  // AL30 / AL30D / AL30C son el MISMO bono en distinta plaza/moneda. Para
  // que vender AL30D teniendo AL30 sea un canje (cierre de la tenencia) y
  // no un short fantasma, los unificamos por bono BASE y, como la moneda de
  // referencia es PESOS, convertimos las patas en USD a pesos al MEP
  // implícito del feed (precio_pesos / precio_usd del mismo bono, ambos por
  // 100 VN). Si no hay MEP disponible, dejamos la pata sin tocar (degradación
  // segura: vuelve al comportamiento viejo, no rompe nada).
  const soberanoMep = (base) => {
    const arsP = bondPrices?.[base]?.price;
    const usdP = bondPrices?.[base + "D"]?.price ?? bondPrices?.[base + "C"]?.price;
    return arsP > 0 && usdP > 0 ? arsP / usdP : null;
  };
  const normalizedPositions = [];
  for (const p of positions) {
    const base = soberanoCanjeBase(p.ticker);
    if (!base) { normalizedPositions.push(p); continue; }
    const tkUpper = (p.ticker || "").toUpperCase().trim();
    const isUsdLeg =
      p.instrument_type === "bond_usd" ||
      /^USD/.test(p.entry_currency || "") ||
      /[CD]$/.test(tkUpper);
    let price = Number(p.entry_price) || 0;
    if (isUsdLeg) {
      const mep = soberanoMep(base);
      if (!mep) { normalizedPositions.push(p); continue; } // sin MEP → no unifico
      price = price * mep;
    }
    normalizedPositions.push({
      ...p,
      ticker: base,
      instrument_type: "bond_ars",
      entry_currency: "ARS",
      entry_price: price,
      // Conservamos el origen para el detalle expandible / debugging.
      _soberanoOrigTicker: tkUpper,
      _soberanoOrigCurrency: p.entry_currency || "ARS",
    });
  }

  const groups = new Map();

  for (const p of normalizedPositions) {
    const ticker = (p.ticker || "").trim().toUpperCase();
    const cur = p.entry_currency || "ARS";
    const t = p.instrument_type;

    // Letra/Boncap YA VENCIDA (amortizó) → no es tenencia. El vencimiento viene
    // en el CSV como "Renta y Amortización" (caja, sin ticker), no como venta,
    // así que sin esto la letra queda como posición fantasma sin precio. Su plata
    // ya está en el efectivo. El vto se lee del propio ticker (no del feed, que
    // deja de listarla al vencer).
    if (t === "bond_ars" || t === "bond_usd") {
      const mat = parseLetraMaturity(ticker);
      if (mat && mat < _todayISO) continue;
    }

    // Si es no-consolidable, le damos un groupKey único por id
    const groupKey = NO_CONSOLIDATE.has(t)
      ? `${t}|${ticker}|${cur}|${p.id}`
      : `${t}|${ticker}|${cur}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupKey,
        instrument_type: t,
        ticker,
        currency: cur,
        operations: [],
        totalBuyQty: 0,
        totalSellQty: 0,
        weightedBuyPriceNumerator: 0, // suma(qty × price) de compras
        weightedSellPriceNumerator: 0, // suma(qty × price) de ventas
        lastSellPrice: null, // precio de la última venta (por fecha)
        lastSellDate: null,  // fecha de la última venta
        firstDate: p.entry_date,
        lastDate: p.entry_date,
        notesAggregated: [],
      });
    }

    const g = groups.get(groupKey);
    g.operations.push(p);

    const qty = Number(p.quantity) || 0;
    const price = Number(p.entry_price) || 0;

    if (p.operation_type === "sell") {
      g.totalSellQty += qty;
      g.weightedSellPriceNumerator += qty * price;
      // Guardamos el precio de la última venta cronológica para que en
      // futuros con cierre (parcial o total) el "precio actual" se
      // pueda autoupdate al precio del cierre — como un override manual
      // implícito.
      if (
        price > 0 &&
        (g.lastSellDate == null || (p.entry_date && p.entry_date >= g.lastSellDate))
      ) {
        g.lastSellPrice = price;
        g.lastSellDate = p.entry_date;
      }
    } else {
      // Default es compra (incluye cauciones colocadas)
      g.totalBuyQty += qty;
      g.weightedBuyPriceNumerator += qty * price;
    }

    if (p.entry_date && p.entry_date < g.firstDate) g.firstDate = p.entry_date;
    if (p.entry_date && p.entry_date > g.lastDate) g.lastDate = p.entry_date;
    if (p.notes && p.notes.trim()) g.notesAggregated.push(p.notes);
  }

  // Calcular métricas finales para cada grupo
  const result = [];
  for (const g of groups.values()) {
    // Residuo de punto flotante → 0: las cuotapartes de FCI tienen 7
    // decimales y compras−ventas que cierran exacto en papel dejan
    // ~1e-16 acá — sin esto, un fondo cerrado aparecía como SHORT "−0"
    // (caso Cocos Ahorro USD 31/07). Umbral 1e-6: irrelevante para
    // cualquier instrumento real (ni una milésima de cuotaparte).
    let netQty = g.totalBuyQty - g.totalSellQty;
    if (Math.abs(netQty) < 1e-6) netQty = 0;
    const ppp = g.totalBuyQty > 0
      ? g.weightedBuyPriceNumerator / g.totalBuyQty
      : null;
    const ppv = g.totalSellQty > 0
      ? g.weightedSellPriceNumerator / g.totalSellQty
      : null;

    // Posición cerrada: la cantidad neta es exactamente 0 (compras y
    // ventas se calzaron). Se separa de la consolidada principal en una
    // sección "Posiciones cerradas" porque el PnL ya es realizado y no
    // es información de cartera viva.
    //
    // Solo aplica a tipos donde "cerrada" tiene sentido (futuros, bonos,
    // acciones). Para cauciones/opciones/FCI ya van separadas vía
    // NO_CONSOLIDATE.
    const isClosed = netQty === 0 && g.totalBuyQty > 0 && g.totalSellQty > 0;

    // Resolución de precio actual: usamos el resolvePositionPrice de
    // cualquier operación del grupo (todas comparten ticker), pero
    // reemplazamos quantity por la neta y entry_price por el PPP para
    // que "current_price manual" del modelo individual no se pierda
    // a nivel grupo.
    //
    // Detectar override manual + timestamp para resolver prioridad vs cierre.
    // Si el user editó el precio manualmente DESPUÉS de la última venta,
    // ese override gana. Si fue antes, el cierre gana (porque el manual viejo
    // ya no representa el precio actual real).
    let manualOverride = null;
    let manualOverrideAt = null; // timestamp del último manual update
    for (const op of g.operations) {
      if (op.current_price != null) {
        const ts = op.current_price_updated_at;
        // Tomamos el manual override más reciente (por timestamp) como ganador.
        if (manualOverrideAt == null || (ts && ts > manualOverrideAt)) {
          manualOverride = Number(op.current_price);
          manualOverrideAt = ts;
        }
      }
    }

    let currentPrice = null;
    let priceSource = "cost";

    // NOTA: la lógica de "manualBeatsClose" (manual gana vs cierre según
    // timestamp posterior a la última venta) se eliminó cuando se unificó
    // la prioridad a "manual gana siempre". Si más adelante hace falta
    // distinguir manuales viejos de actuales, recuperar la comparación
    // entre manualOverrideAt y lastSellDate.

    // Precio Primary API: si tenemos un precio fresco vía /api/mtr-md,
    // lo usamos como fuente para futuros — pero solo si NO hay manual
    // override. El override manual gana siempre (Modelo unificado:
    // "el usuario es la fuente de verdad", igual que para bonos).
    //
    // 2026-05-29: leemos fp.last en lugar de fp.price. fp.price tiene una
    // cascada que post-cierre cae al midpoint del book (bid+offer/2), que
    // puede dar precios artificiales como 1437.75 — el tick mínimo del DLR
    // es 0.50, así que .75 no existe ni en mercado ni en lo que liquida
    // Cocos. Con fp.last quedan coherentes el P&L TOTAL (esta función) y
    // el P&L HOY (computeDailyPnL, que ya usa fp.last desde el Tema 1).
    // Fallback abajo: primarySettlement si no hay last.
    const primaryPrice = (g.instrument_type === "future" && futurePrices)
      ? futurePrices[g.ticker]?.last
      : null;
    // Settlement de Primary: cuando el feed live no tiene precio
    // (mercado cerrado, ROFEX fuera de horario, hueco temporal), usamos
    // el último settlement como fallback. Es la referencia que Cocos
    // usa para valuar el futuro entre sesiones, así no terminamos
    // mostrando "—" y la posición pesando 0 en el total de la cartera.
    const primarySettlement = (g.instrument_type === "future" && futurePrices)
      ? futurePrices[g.ticker]?.settlement
      : null;

    // Orden de prioridad (unificado entre futuros, bonos, acciones):
    //   1. manualOverride (current_price cargado por el usuario) → gana siempre.
    //   2. Para futuros: primaryPrice (Matba-Rofex live).
    //   3. Para futuros sin live: settlement del feed (último settle conocido).
    //   4. Para futuros con ventas: lastSellPrice (cierre del lote vendido).
    //   5. Para bonos/ONs: bondPrices del feed (BYMA/data912).
    //   6. ppp (fallback a costo).
    //
    // Bug reportado por LP en mayo/2026: para futuros, el override manual
    // se guardaba en BD pero el render seguía mostrando el precio de
    // Primary. Causa: el orden anterior priorizaba Primary > manual
    // (excepto si había una venta posterior — "manualBeatsClose"). Esto
    // hacía imposible editar el precio de un futuro abierto sin ventas.
    // Fix: el manual gana antes que cualquier otra fuente, sin importar
    // el tipo de instrumento. Si el manual está obsoleto, el usuario lo
    // borra y vuelve al feed.
    if (manualOverride != null) {
      currentPrice = manualOverride;
      priceSource = "manual";
    } else if (g.instrument_type === "future" && primaryPrice != null && primaryPrice > 0) {
      // Primary API: precio real-time de Matba-Rofex.
      currentPrice = primaryPrice;
      priceSource = "primary"; // badge "PRIMARY"
    } else if (g.instrument_type === "future" && primarySettlement != null && primarySettlement > 0) {
      // Sin precio live → settlement más reciente del feed.
      currentPrice = primarySettlement;
      priceSource = "settle"; // badge "SETTLE"
    } else if (
      g.instrument_type === "future" &&
      g.lastSellPrice != null
    ) {
      // Futuro sin Primary y sin manual: usamos el último precio de venta.
      currentPrice = g.lastSellPrice;
      priceSource = "close"; // badge "CIERRE"
    } else if (
      bondPrices &&
      ticker_isBondLike(g.instrument_type) &&
      bondPrices[g.ticker]?.price > 0
    ) {
      currentPrice = bondPrices[g.ticker].price;
      // El priceSource refleja la fuente REAL del entry (byma/data912/
      // mae_intraday/mae_close), no un genérico "market". Esto permite
      // que el badge UI muestre el label correcto y que las métricas
      // de cobertura ("X de Y a mercado") consideren MAE como fuente
      // legítima. Supabase consolida sus dos sub-fuentes bajo "mae".
      const entrySource = bondPrices[g.ticker].source;
      priceSource =
        entrySource === "byma" || entrySource === "data912"
          ? entrySource
          : entrySource === "mae_intraday" || entrySource === "mae_close"
            ? "mae"
            : "market";
    } else if (
      (g.instrument_type === "stock" || g.instrument_type === "cedear") &&
      stockPrices &&
      stockPrices[(g.ticker || "").toUpperCase().trim()]?.price > 0
    ) {
      // Acciones/CEDEARs: feed data912 (useStockPrices). Sin esta rama caían
      // SIEMPRE a `ppp` (costo): ticker_isBondLike no cubre equity y la
      // cadena nunca consultaba stockPrices. Latente hasta que Pablo cargó
      // los primeros CEDEARs (11/06/2026) — nadie había tenido equity antes.
      currentPrice = stockPrices[(g.ticker || "").toUpperCase().trim()].price;
      priceSource = "data912";
    } else if (
      g.instrument_type === "fci" &&
      fciPrices &&
      fciPrices[g.ticker]?.price > 0
    ) {
      // FCI: VCP del hook useFciPrices (tabla fci_quotes de Supabase).
      // ticker_isBondLike() NO cubre "fci", así que sin esta rama el FCI
      // caería a `ppp` (costo) y nunca se valuaría al VCP.
      currentPrice = fciPrices[g.ticker].price;
      priceSource = "fci"; // badge "FCI"
    } else if (ppp != null) {
      currentPrice = ppp;
      priceSource = "cost";
    }

    // Valuación con la convención del instrumento.
    //
    // CASO ESPECIAL — Futuros:
    //   - valueAtMarket = P&L mark-to-market = qty_dirigida × mult × (price - PPP)
    //   - valueAtCost   = 0  (no pagás capital al abrir un futuro)
    //   - pnl           = valueAtMarket - valueAtCost = el P&L mismo
    //   - notional      = |qty_neta| × mult × precio_actual  (exposición, NO valor de cartera)
    //
    // Para una compra (long) de futuros, qty_neta es positiva → PnL positivo si
    // el precio sube. Para una venta (short), qty_neta es negativa → PnL
    // positivo si el precio baja. La fórmula `netQty × mult × (price - PPP)`
    // captura ambos signos correctamente.
    let valueAtMarket = null;
    let valueAtCost = null;
    let pnl = null;
    let pnlPct = null;
    let notional = null;
    let realizedPnl = null;     // P&L realizado por ventas/cierres
    let unrealizedPnl = null;   // P&L mark-to-market sobre la posición abierta

    if (g.instrument_type === "future") {
      const mult = FUTURE_MULTIPLIER_DEFAULT;

      // Construimos el sintético una sola vez. Devuelve los pares
      // COMPRA-espejo + VENTA neteados, y el P&L realizado total
      // calculado par-por-par con PPP cronológico (PPP al momento de
      // cada venta, no PPP final). También devuelve el estado FINAL
      // de los lots vivos (openBuyQty/Value, openSellQty/Value) que
      // usamos abajo para resolver basePriceForPnL en posiciones que
      // cruzaron el cero. Usamos esto como SOURCE OF TRUTH para el
      // detalle expandible y el realizedPnl global — así los números
      // de pantalla siempre cuadran.
      const synth = (g.totalBuyQty > 0 || g.totalSellQty > 0)
        ? buildClosedOperationsSynthetic(g)
        : {
            synthetic: [],
            realizedPnlRaw: 0,
            openBuyQty: 0,
            openBuyValue: 0,
            openSellQty: 0,
            openSellValue: 0,
          };
      const closedOperations = synth.synthetic;

      // ─── basePriceForPnL ────────────────────────────────────────────
      // Base usada para el P&L mark-to-market del lado VIVO. Tiene que
      // ser el PPP de los lots que efectivamente quedaron abiertos
      // después del FIFO de buildClosedOperationsSynthetic — NO el PPP
      // histórico de TODAS las compras (g.weightedBuyPriceNumerator /
      // g.totalBuyQty), que incluye compras ya cerradas.
      //
      // FIX 2026-05-29 (shorts puros): cuando totalBuyQty=0, ppp queda
      //   null y openUnrealizedPnl daba 0. Se usaba PPV global de ventas.
      // FIX 2026-06-01 (cruces de cero, ej. SHORT→LONG→SHORT): el ppp
      //   incluía compras ya cerradas y daba MTM unrealized incorrecto.
      //   Ahora ambos casos los maneja synth (FIFO con weighted average).
      //
      // Reglas:
      //   - netQty > 0 (LONG vivo) → openBuyValue/openBuyQty del FIFO.
      //   - netQty < 0 (SHORT vivo) → openSellValue/openSellQty del FIFO.
      //   - netQty == 0 (cerrado) → ppp (no se usa para unrealized; queda
      //       como referencia histórica para la fila CERRADA del split).
      //   - Edge case: si por qty inválidas el FIFO devuelve qty=0 en el
      //       lado que debería estar vivo, fallback al ppp histórico o
      //       al PPV global de ventas (compatibilidad pre-fix).
      let basePriceForPnL = null;
      if (netQty > 0 && synth.openBuyQty > 0) {
        basePriceForPnL = synth.openBuyValue / synth.openBuyQty;
      } else if (netQty < 0 && synth.openSellQty > 0) {
        basePriceForPnL = synth.openSellValue / synth.openSellQty;
      } else {
        // Fallback: ppp histórico o PPV global de ventas si no hay compras.
        basePriceForPnL = ppp;
        if (basePriceForPnL == null && g.totalSellQty > 0) {
          let sumVQ = 0;
          let sumQ = 0;
          for (const op of g.operations) {
            if (op && op.operation_type === "sell") {
              const q = Math.abs(Number(op.quantity) || 0);
              const pr = Number(op.entry_price) || 0;
              if (q > 0 && pr > 0) {
                sumVQ += q * pr;
                sumQ += q;
              }
            }
          }
          if (sumQ > 0) basePriceForPnL = sumVQ / sumQ;
        }
      }

      // P&L REALIZADO: para futuros se aplica el multiplicador al raw.
      //   raw = sum(qtyVendida × (PPVenta - PPP_momento))
      //   con multiplicador: raw × FUTURE_MULTIPLIER_DEFAULT
      if (g.totalSellQty > 0) {
        realizedPnl = synth.realizedPnlRaw * mult;
      } else {
        realizedPnl = 0;
      }

      // CASO ESPECIAL — cierre parcial:
      //   Si hay ventas Y todavía queda posición abierta (netQty != 0), el
      //   grupo se DIVIDE en dos entradas separadas:
      //     - Una "abierta" con netQty contratos, sólo P&L no realizado.
      //     - Una "cerrada" con totalSellQty contratos, sólo P&L realizado.
      //   Esto evita mostrar +885k de PnL "abierto" en una posición que
      //   parcialmente ya se realizó.
      const isPartialClose = netQty !== 0 && g.totalSellQty > 0;

      if (isPartialClose) {
        // Para la entrada ABIERTA: P&L no realizado solo (netQty × mult × (current − base))
        // base = ppp si hay compras, PPV si es short puro (ver fix arriba).
        let openUnrealizedPnl = 0;
        if (currentPrice != null && basePriceForPnL != null && priceSource !== "cost") {
          openUnrealizedPnl = netQty * mult * (currentPrice - basePriceForPnL);
        }
        const openNotional = currentPrice != null
          ? Math.abs(netQty) * mult * currentPrice
          : 0;
        const openPnlPct = openNotional > 0
          ? (openUnrealizedPnl / openNotional) * 100
          : null;

        // P&L LIFETIME del ticker: realizado de las ventas pasadas
        // + no realizado del lote actualmente vivo. Las dos filas del
        // split (abierta y cerrada) comparten el mismo lifetime porque
        // representan dos vistas de la misma historia con un ticker.
        // El usuario lo ve en el detalle expandible de cualquiera.
        const lifetimePnl = openUnrealizedPnl + realizedPnl;
        // % lifetime: sobre el notional total invertido (qty_lado_vivo
        // × base × mult). Para LONG: g.totalBuyQty × ppp. Para SHORT
        // PURO: g.totalSellQty × PPV. Es el denominador natural para
        // futuros — no pagás capital, pero el "% de retorno sobre
        // exposición" es la métrica que tiene sentido comparar.
        const lifetimeBaseQty = g.totalBuyQty > 0 ? g.totalBuyQty : g.totalSellQty;
        const lifetimeBaseNotional = (basePriceForPnL != null && lifetimeBaseQty > 0)
          ? lifetimeBaseQty * mult * basePriceForPnL
          : 0;
        const lifetimePnlPct = lifetimeBaseNotional > 0
          ? (lifetimePnl / lifetimeBaseNotional) * 100
          : null;

        // Filtrar las operations: solo las de compra van a la entrada abierta.
        // (las de venta van a la cerrada). Para el detalle expandible esto
        // significa que en la fila abierta se ven solo las compras.
        const openOperations = g.operations; // log completo: compras + ventas, sin neteo
        // closedOperations ya viene del sintético calculado arriba

        // Para la entrada CERRADA: precio actual = lastSellPrice, P&L realizado
        const closedPnl = realizedPnl;
        const initialNotional = (basePriceForPnL != null && g.totalSellQty > 0)
          ? g.totalSellQty * mult * basePriceForPnL
          : 0;
        const closedPnlPct = initialNotional > 0
          ? (closedPnl / initialNotional) * 100
          : null;

        // Push entrada ABIERTA
        result.push({
          groupKey: g.groupKey + "|open",
          instrument_type: g.instrument_type,
          ticker: g.ticker,
          currency: g.currency,
          operations: openOperations,
          operationsCount: openOperations.length,
          buyOpsCount: openOperations.length,
          sellOpsCount: 0,
          netQty,
          isShort: netQty < 0,
          isClosed: false,
          ppp: basePriceForPnL,  // <-- PPV cuando es short puro (antes era null)
          ppv: null,
          currentPrice,
          priceSource,
          valueAtMarket: openUnrealizedPnl,
          valueAtCost: 0,
          pnl: openUnrealizedPnl,
          pnlPct: openPnlPct,
          realizedPnl: 0,
          unrealizedPnl: openUnrealizedPnl,
          isPartialOpen: true,
          // HISTÓRICO de la fila ABIERTA (cierre parcial) = el REALIZADO histórico
          // del ticker (lo ya cobrado por las ventas pasadas). El no-realizado del
          // lote vivo ya se muestra como P&L TOTAL en la fila principal; repetirlo
          // acá era redundante. Por eso el label pasa a "Realizado histórico".
          lifetimePnl: realizedPnl,
          lifetimePnlPct: closedPnlPct,
          notional: openNotional,
          firstDate: g.firstDate,
          lastDate: g.lastDate,
          notesAggregated: g.notesAggregated,
        });

        // Push entrada CERRADA
        result.push({
          groupKey: g.groupKey + "|closed",
          instrument_type: g.instrument_type,
          ticker: g.ticker,
          currency: g.currency,
          operations: closedOperations,
          operationsCount: closedOperations.length,
          buyOpsCount: g.operations.filter((o) => o.operation_type !== "sell").length,
          sellOpsCount: g.operations.filter((o) => o.operation_type === "sell").length,
          netQty: 0,
          isShort: false,
          isClosed: true,
          ppp,
          ppv,
          currentPrice: g.lastSellPrice,
          priceSource: "close",
          valueAtMarket: closedPnl,
          valueAtCost: 0,
          pnl: closedPnl,
          pnlPct: closedPnlPct,
          realizedPnl: closedPnl,
          unrealizedPnl: 0,
          // HISTÓRICO de la fila CERRADA = su realizado (= P&L TOTAL de la fila).
          lifetimePnl: closedPnl,
          lifetimePnlPct: closedPnlPct,
          notional: 0,
          // Una info adicional útil para mostrar: cuántos contratos se cerraron
          closedQty: g.totalSellQty,
          firstDate: g.firstDate,
          lastDate: g.lastDate,
          notesAggregated: g.notesAggregated,
        });
        continue; // saltamos el push genérico de abajo
      }

      // CASOS NO PARTICULARES (sin venta, o cierre total):
      //   Cierre total (netQty = 0): solo P&L realizado. isClosed = true.
      //   Sin ventas (totalSellQty = 0): solo P&L no realizado. isClosed = false.

      // P&L NO REALIZADO (sobre netQty)
      if (netQty !== 0 && currentPrice != null && ppp != null && priceSource !== "cost") {
        unrealizedPnl = netQty * mult * (currentPrice - ppp);
      } else {
        unrealizedPnl = 0;
      }

      pnl = realizedPnl + unrealizedPnl;

      if (netQty !== 0 && currentPrice != null) {
        notional = Math.abs(netQty) * mult * currentPrice;
      } else {
        notional = 0;
      }

      valueAtMarket = pnl;
      valueAtCost = 0;

      if (notional && notional > 0) {
        pnlPct = (pnl / notional) * 100;
      } else if (isClosed && ppp != null && g.totalBuyQty > 0) {
        const initialNotional = g.totalBuyQty * mult * ppp;
        if (initialNotional > 0) pnlPct = (pnl / initialNotional) * 100;
      }
    } else {
      // ─────────────────────────────────────────────────────────────────
      //  Tipos consolidables NO-futuros (bond_ars, bond_usd, on, stock,
      //  cedear, fci, usd, crypto, option).
      //
      //  Acá replicamos la lógica de split open/closed que ya teníamos
      //  para futuros, pero usando applyConventionToValue() para respetar
      //  la convención de cada instrumento (ej. bonos /100, opciones ×100).
      //
      //  Convención PPP (Cocos/Balanz/IOL):
      //    - El PPP se calcula sólo sobre las compras y NO se mueve por
      //      ventas. Si compraste 35,9M a 139,32 y vendés 10M, el PPP de
      //      los 25,9M restantes sigue siendo 139,32.
      //    - El P&L realizado se calcula como (PPV − PPP) sobre la qty
      //      vendida, aplicando la convención del instrumento.
      // ─────────────────────────────────────────────────────────────────

      // Construimos el sintético una sola vez. Devuelve los pares
      // COMPRA-espejo + VENTA neteados, y el P&L realizado total
      // calculado par-por-par con PPP cronológico (PPP al momento de
      // cada venta, no PPP final). Source of truth tanto para el
      // detalle expandible como para realizedPnl global.
      const synth = (g.totalSellQty > 0)
        ? buildClosedOperationsSynthetic(g)
        : { synthetic: [], realizedPnlRaw: 0 };
      const closedOperations = synth.synthetic;

      // P&L REALIZADO sobre las ventas (si hubo). Aplicamos la convención
      // del instrumento al raw: para bonos /100, para opciones ×100, etc.
      // Hacemos un truco: applyConventionToValue(type, qty, price) nos
      // sirve si pasamos qty=1 y price=raw — devuelve el raw escalado.
      if (g.totalSellQty > 0) {
        // applyConventionToValue para no-futuros calcula:
        //   bonos:    (qty * price) / 100
        //   opciones: qty * 100 * price
        //   resto:    qty * price
        // Acá el "raw" ya es qty × Δprice (suma sobre los pares), así
        // que llamamos con qty=1 para que NO multiplique de nuevo, solo
        // aplique el factor (/100, ×100, o ×1).
        realizedPnl = applyConventionToValue(g.instrument_type, 1, synth.realizedPnlRaw);
      } else {
        realizedPnl = 0;
      }

      // CASO ESPECIAL — cierre parcial:
      //   netQty != 0 && hubo ventas → el grupo se DIVIDE en dos entradas:
      //     ABIERTA (netQty unidades, PPP, P&L no realizado vs precio actual)
      //     CERRADA (totalSellQty unidades, PPV, P&L realizado)
      //   Esto matchea el comportamiento que ya teníamos para futuros y
      //   replica la vista que dan Cocos / Balanz.
      const isPartialClose = netQty !== 0 && g.totalSellQty > 0;

      if (isPartialClose) {
        // Costo del LOTE VIVO (no el PPP histórico de TODAS las compras). Si la
        // posición cruzó cero —round-trips cerrados a otros precios, ej. SPCX
        // comprado y vendido varias veces y reabierto— el PPP de todas las compras
        // contamina el MTM (daba −15M fantasma). Usamos el costo running del lado
        // abierto del sintético, igual que la rama de futuros. Para una posición que
        // nunca se cerró, openBasePrice === ppp, así que NO cambia nada.
        const openBasePrice = (netQty > 0 && synth.openBuyQty > 0)
          ? synth.openBuyValue / synth.openBuyQty
          : (netQty < 0 && synth.openSellQty > 0)
            ? synth.openSellValue / synth.openSellQty
            : ppp;
        // ── Entrada ABIERTA: usa netQty + costo del lote vivo + precio actual ──
        const openValueAtMarket = currentPrice != null
          ? applyConventionToValue(g.instrument_type, netQty, currentPrice)
          : null;
        const openValueAtCost = openBasePrice != null
          ? applyConventionToValue(g.instrument_type, netQty, openBasePrice)
          : null;
        const openPnl = (openValueAtMarket != null && openValueAtCost != null)
          ? openValueAtMarket - openValueAtCost
          : null;
        const openPnlPct = (openPnl != null && openValueAtCost != null && Math.abs(openValueAtCost) > 0)
          ? (openPnl / Math.abs(openValueAtCost)) * 100
          : null;

        const openOperations = g.operations; // log completo: compras + ventas, sin neteo
        // closedOperations ya viene del sintético calculado arriba

        // ── Entrada CERRADA: usa totalSellQty + PPP + PPV ──
        const closedPnl = realizedPnl;
        const closedValueAtCost = applyConventionToValue(g.instrument_type, g.totalSellQty, ppp);
        const closedPnlPct = (closedValueAtCost != null && Math.abs(closedValueAtCost) > 0)
          ? (closedPnl / Math.abs(closedValueAtCost)) * 100
          : null;

        // HISTÓRICO de las dos filas del split = el REALIZADO histórico del
        // ticker (lo ya cobrado por las ventas pasadas), NO realizado + MTM.
        // La UI lo pinta bajo el label "Realizado histórico" y el no-realizado
        // del lote vivo ya se muestra como P&L TOTAL en la fila abierta:
        // mezclarlos daba un número que no era ninguna de las dos cosas.
        // Bug MU 10/08/2026: la fila cerrada mostraba "REALIZADO HISTÓRICO
        // −2.022.599,94 (−0,12%)" = realizado (≈−1,0M) + MTM del lote vivo de
        // 201 papeles (≈−1,0M), con el % sobre TODAS las compras (6.065) en vez
        // de sobre lo vendido. Esto ya estaba resuelto así en la rama de
        // futuros (ver los dos push de arriba); acá había quedado sin alinear.
        const lifetimePnl = closedPnl;
        const lifetimePnlPct = closedPnlPct;

        // Push entrada ABIERTA
        result.push({
          groupKey: g.groupKey + "|open",
          instrument_type: g.instrument_type,
          ticker: g.ticker,
          currency: g.currency,
          operations: openOperations,
          operationsCount: openOperations.length,
          buyOpsCount: openOperations.length,
          sellOpsCount: 0,
          netQty,
          isShort: netQty < 0,
          isClosed: false,
          ppp: openBasePrice,
          ppv: null,
          currentPrice,
          priceSource,
          valueAtMarket: openValueAtMarket,
          valueAtCost: openValueAtCost,
          pnl: openPnl,
          pnlPct: openPnlPct,
          realizedPnl: 0,
          unrealizedPnl: openPnl,
          // Igual que en futuros: marca la fila como "abierta de un cierre
          // parcial" para que el label del histórico sea "Realizado histórico"
          // (que es lo que ahora contiene lifetimePnl).
          isPartialOpen: true,
          lifetimePnl,
          lifetimePnlPct,
          notional: null,
          firstDate: g.firstDate,
          lastDate: g.lastDate,
          notesAggregated: g.notesAggregated,
        });

        // Push entrada CERRADA
        result.push({
          groupKey: g.groupKey + "|closed",
          instrument_type: g.instrument_type,
          ticker: g.ticker,
          currency: g.currency,
          operations: closedOperations,
          operationsCount: closedOperations.length,
          buyOpsCount: g.operations.filter((o) => o.operation_type !== "sell").length,
          sellOpsCount: g.operations.filter((o) => o.operation_type === "sell").length,
          netQty: 0,
          isShort: false,
          isClosed: true,
          ppp,
          ppv,
          currentPrice: g.lastSellPrice,
          priceSource: "close",
          // Para no-futuros, el "Total" de la fila cerrada lo dejamos en
          // el P&L realizado (mismo criterio que futuros): es lo que
          // efectivamente entró/salió de tu comitente al cerrar.
          valueAtMarket: closedPnl,
          valueAtCost: 0,
          pnl: closedPnl,
          pnlPct: closedPnlPct,
          realizedPnl: closedPnl,
          unrealizedPnl: 0,
          lifetimePnl,
          lifetimePnlPct,
          notional: 0,
          closedQty: g.totalSellQty,
          firstDate: g.firstDate,
          lastDate: g.lastDate,
          notesAggregated: g.notesAggregated,
        });
        continue; // saltamos el push genérico de abajo
      }

      // CASOS NO PARTICULARES (sin venta, o cierre total):
      if (isClosed) {
        // CIERRE TOTAL (netQty = 0, hubo compras y ventas que se calzaron
        // exactamente). Una sola fila cerrada con P&L realizado.
        const closedValueAtCost = (ppp != null)
          ? applyConventionToValue(g.instrument_type, g.totalSellQty, ppp)
          : null;
        valueAtMarket = realizedPnl;
        valueAtCost = 0;
        pnl = realizedPnl;
        unrealizedPnl = 0;
        pnlPct = (closedValueAtCost != null && Math.abs(closedValueAtCost) > 0)
          ? (realizedPnl / Math.abs(closedValueAtCost)) * 100
          : null;
      } else {
        // CASO STANDARD: posición abierta sin ventas (totalSellQty = 0).
        // Es la lógica que tenía el bloque antes de este fix.
        valueAtMarket = currentPrice != null
          ? applyConventionToValue(g.instrument_type, netQty, currentPrice)
          : null;
        valueAtCost = ppp != null
          ? applyConventionToValue(g.instrument_type, netQty, ppp)
          : null;
        if (valueAtMarket != null && valueAtCost != null) {
          pnl = valueAtMarket - valueAtCost;
          unrealizedPnl = pnl;
          pnlPct = Math.abs(valueAtCost) > 0
            ? (pnl / Math.abs(valueAtCost)) * 100
            : null;
        }
      }
    }

    // Para el detalle expandible: si es cierre total, mostramos pares
    // COMPRA-espejo + VENTA (sintético, ver buildClosedOperationsSynthetic).
    // Para posición abierta pura sin ventas, las operations crudas alcanzan.
    // El caso parcial se maneja arriba con su propio push.
    const operationsForRender = (isClosed && g.totalSellQty > 0)
      ? buildClosedOperationsSynthetic(g).synthetic
      : g.operations;

    result.push({
      groupKey: g.groupKey,
      instrument_type: g.instrument_type,
      ticker: g.ticker,
      currency: g.currency,
      operations: operationsForRender,
      operationsCount: operationsForRender.length,
      buyOpsCount: g.operations.filter((o) => o.operation_type !== "sell").length,
      sellOpsCount: g.operations.filter((o) => o.operation_type === "sell").length,
      netQty,
      isShort: netQty < 0,
      isClosed,
      ppp,
      ppv,
      currentPrice,
      priceSource,
      valueAtMarket,
      valueAtCost,
      pnl,
      pnlPct,
      realizedPnl,
      unrealizedPnl,
      // Para los casos no-split (fully open o fully closed), el lifetime
      // P&L coincide con pnl porque ya incluye realizedPnl + unrealizedPnl.
      lifetimePnl: pnl,
      lifetimePnlPct: pnlPct,
      notional,
      firstDate: g.firstDate,
      lastDate: g.lastDate,
      notesAggregated: g.notesAggregated,
    });
  }

  // Sort: posiciones con valor de mercado mayor primero. Las sin valor
  // (cauciones sin liquidar, opciones sin precio) van al final.
  result.sort((a, b) => {
    const av = a.valueAtMarket ?? -Infinity;
    const bv = b.valueAtMarket ?? -Infinity;
    return Math.abs(bv) - Math.abs(av);
  });

  return result;
}

function computeFutureUncreditedPnl(g, futureAdjLookup, futurePrices) {
  // FIX 24/08/2026 (2) - UN CONTRATO CERRADO NO TIENE NADA PENDIENTE.
  //
  // Por definicion: si el neto es cero, el broker ya liquido todo. No hace
  // falta ningun settle para saberlo, y salir aca ANTES de mirar precios evita
  // depender de que el feed siga listando el contrato.
  //
  // Sin este corte, un vencido que desaparecio del feed devolvia el P&L de
  // VIDA. Paso con DLRABR26 (vencio en abril): mtr_market_data ya no lo tiene,
  // el fallback al settle no encontraba nada, la base volvia a ser el precio de
  // entrada y el encabezado restaba -7.218.996 de plata cobrada hace cuatro
  // meses. Los otros vencidos -MAY, JUN, JUL, AGO- zafaban solo porque el feed
  // todavia los lista con su ultimo settle.
  //
  // Medido: con este corte el patrimonio pasa de 154.941.742,42 a
  // 162.160.738,42, que es la suma de las posiciones abiertas.
  if (g?.isClosed || Number(g?.netQty) === 0) return 0;

  const price = Number(g?.currentPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const mult = FUTURE_MULTIPLIER_DEFAULT;
  const tk = (g.ticker || "").toUpperCase().trim();
  let tc = futureAdjLookup?.tickerConfirmed?.get(tk) || null;

  // FIX 24/08/2026 - EL ENCABEZADO RESTABA ~25M QUE YA ESTABAN EN LA CAJA.
  //
  // `tc` marca "hasta que settle ya cobre". Salia UNICAMENTE de los ajustes
  // confirmados en futures_daily_adjustments. Pero los futuros de LP vienen
  // del Libro: Cocos le acredita el ajuste diario y eso entra por la cuenta
  // corriente importada ("Credito Indice" / "Debito Indice"), sin pasar nunca
  // por esa tabla. Con la tabla vacia tc quedaba null, la base pasaba a ser el
  // PRECIO DE ENTRADA, y la funcion devolvia el P&L de VIDA del contrato
  // -incluidos los ya vencidos y cobrados hace meses- como si estuviera
  // pendiente de acreditar. Medido contra Cocos el 24/08: -25.030.645,65.
  //
  // El settle ya no depende de esa tabla: lo trae el feed (mtr_market_data via
  // /api/mtr-md), la misma fuente que da el precio. Todo lo anterior al ultimo
  // settle esta cobrado, venga por adjustments o por el Libro; lo posterior no.
  // En un contrato CERRADO las dos patas quedan basadas en el mismo settle y
  // el aporte da 0, que es lo correcto.
  if (!tc) {
    const settle = Number(futurePrices?.[tk]?.settlement);
    if (Number.isFinite(settle) && settle > 0) {
      // Corte = ultimo dia habil. Un lote comprado HOY todavia no settleo, asi
      // que su base sigue siendo el precio de entrada.
      const hoyAR = new Date().toLocaleDateString("en-CA", { timeZone: "America/Argentina/Buenos_Aires" });
      const d = new Date(hoyAR + "T12:00:00Z");
      do { d.setUTCDate(d.getUTCDate() - 1); } while (isNonBusinessDay(d.toISOString().slice(0, 10)));
      tc = { date: d.toISOString().slice(0, 10), settle };
    }
  }
  let sum = 0;
  for (const op of g.operations || []) {
    if (!op) continue;
    const qty = Number(op.quantity) || 0;
    if (!qty) continue;

    // Grupos CERRADOS: sus operations son pares sintéticos (closed_pair).
    // Cada pata se basa por separado: la anterior al último settle
    // acreditado va al settle (ya cobrada hasta ahí); la posterior, a su
    // precio. Par viejo → 0; cerrado hoy → realizado pendiente de acreditar.
    if (op.isSynthetic) {
      if (op.operation_type !== "closed_pair") continue;
      const buyDate = op.closeSide === "buy" ? op.entry_date : (op.openDate || op.entry_date);
      const sellDate = op.closeSide === "sell" ? op.entry_date : (op.openDate || op.entry_date);
      const baseBuy = (tc && buyDate && buyDate <= tc.date) ? tc.settle : Number(op.entry_price);
      const baseSell = (tc && sellDate && sellDate <= tc.date) ? tc.settle : Number(op.sell_price);
      if (Number.isFinite(baseBuy) && Number.isFinite(baseSell)) {
        sum += (baseSell - baseBuy) * qty * mult;
      }
      continue;
    }

    const sign = op.operation_type === "sell" ? -1 : 1;
    const base = (tc && op.entry_date && op.entry_date <= tc.date)
      ? tc.settle
      : Number(op.entry_price);
    if (!Number.isFinite(base)) continue;
    sum += (price - base) * sign * qty * mult;
  }
  return sum;
}

function convertValue(amount, fromCurrency, toCurrency, fx) {
  if (amount == null || isNaN(amount)) return null;
  if (fromCurrency === toCurrency) return amount;

  // Mismas monedas vía alias
  if (
    (fromCurrency === "USD-MEP" && toCurrency === "USD-MEP") ||
    (fromCurrency === "USD-CCL" && toCurrency === "USD-CCL")
  ) return amount;

  if (!fx) return null;

  // Tasa ARS por unidad de moneda extranjera
  const ratesArs = {
    "ARS":     1,
    "USD-MEP": fx.mep?.sell || null,
    "USD-CCL": fx.ccl?.sell || null,
  };
  const fromRate = ratesArs[fromCurrency];
  const toRate = ratesArs[toCurrency];
  if (!fromRate || !toRate) return null;

  // amount en ARS = amount * fromRate; luego dividir por toRate
  return (amount * fromRate) / toRate;
}

function getPositionMaturity(p) {
  const t = p.instrument_type;
  const ticker = (p.ticker || "").toUpperCase();
  if (t === "bond_ars" && BOND_REGISTRY[ticker]?.maturityDate) {
    return BOND_REGISTRY[ticker].maturityDate;
  }
  if (t === "future") {
    const c = DLR_REGISTRY.find((x) => x.ticker === ticker);
    if (c) return c.maturityDate;
  }
  if (t === "caucion" && p.entry_date && p.extra?.term_days) {
    const start = new Date(p.entry_date);
    return new Date(start.getTime() + Number(p.extra.term_days) * 86400000)
      .toISOString().slice(0, 10);
  }
  if (t === "option" && p.extra?.expiry) {
    return p.extra.expiry;
  }
  return null;
}

function addBusinessDays(yyyymmdd, n) {
  if (!yyyymmdd || n < 0) return yyyymmdd;
  let cursor = new Date(yyyymmdd + "T12:00:00");
  let added = 0;
  while (added < n) {
    cursor.setDate(cursor.getDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (!isNonBusinessDay(iso)) {
      added++;
    }
  }
  return cursor.toISOString().slice(0, 10);
}

function caucionValueAtMaturity(p) {
  if (!p || p.instrument_type !== "caucion") return null;
  const capital = Number(p.quantity) || 0;
  if (capital === 0) return 0;

  const tna = Number(p.extra?.rate_tna);
  const termDays = Number(p.extra?.term_days);
  if (!Number.isFinite(tna) || !Number.isFinite(termDays)) return capital;

  return capital * (1 + (tna / 100) * (termDays / 365));
}

function computeLiquidityBreakdown(positions, fx, valuationCurrency, windowKey, bondPrices, movements, futurePrices, futureAdjLookup, iolCashByCurrency) {
  const result = { ARS: 0, "USD-MEP": 0, "USD-CCL": 0 };

  // 0) Efectivo disponible de IOL (broker_cash_snapshots, campo `available`).
  // Es liquidez real de hoy, asi que entra a la base — fluye a CI y a
  // todas las ventanas. Usamos `available` (disponible), nunca `total`:
  // el saldo total incluye plata "comprometida" por compras sin liquidar.
  if (iolCashByCurrency) {
    for (const k of ["ARS", "USD-MEP", "USD-CCL"]) {
      result[k] += Number(iolCashByCurrency[k]) || 0;
    }
  }

  const todayIso = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const today = new Date(todayIso + "T12:00:00");

  // 1) Saldo CI base: sumamos todos los cash_movements con fecha <= hoy.
  // Esto está disponible siempre, independiente del window seleccionado.
  if (movements && movements.length > 0) {
    for (const m of movements) {
      if (m.movement_date > todayIso) continue;
      if (!(m.currency in result)) continue;
      const sign = (m.movement_type === "deposit" || m.movement_type === "sale_proceeds") ? 1 : -1;
      result[m.currency] += sign * Number(m.amount);
    }
  }

  // 1b) Cauciones VIGENTES como cuasi-cash con devengamiento prorata.
  //
  // Modelo: una caución colocadora es plata que prestaste, devenga
  // intereses lineales hasta el vencimiento, y es muy líquida (en el
  // mercado se puede cancelar anticipadamente o esperar el vencimiento,
  // típicamente 1 día). Por eso la consideramos cuasi-cash:
  //   valor_a_hoy = capital × (1 + TNA × días_corridos / 365)
  //
  // En CI sumamos este valor devengado a hoy. En T1+ además sumamos los
  // intereses pendientes hasta vencer (ver 3b), pero el devengado a hoy
  // sigue siendo la base — así CI ≤ T1 ≤ 30d ≤ 60d ≤ 90d siempre.
  //
  // Cauciones YA VENCIDAS (maturity < hoy) se saltan acá: idealmente
  // ya deberían estar como cash_movement automático en pending (Fase 2,
  // requiere cron). Si todavía no se procesaron, no contamos ni el cash
  // ni el devengado para no inflar la liquidez con plata fantasma.
  if (positions && positions.length > 0) {
    for (const p of positions) {
      if (p.instrument_type !== "caucion") continue;
      const maturityDate = getPositionMaturity(p);
      if (!maturityDate) continue;
      // Si ya venció, saltar (no se contó como cash todavía → caso edge
      // a manejar con cash_movement automático en Fase 2).
      if (new Date(maturityDate + "T12:00:00") < today) continue;

      const devengado = caucionValueDevengado(p, todayIso);
      if (devengado == null || !Number.isFinite(devengado)) continue;
      const cur = p.currency || "ARS";
      if (cur in result) result[cur] += devengado;
    }
  }

  // 2) Si el window es CI, ya terminamos.
  if (windowKey === "CI") {
    return result;
  }

  // 3) Para T1 / 30d / 60d / 90d sumamos flujos futuros dentro de la ventana.
  let cutoff;
  if (windowKey === "T1") {
    const nextBiz = addBusinessDays(todayIso, 1);
    cutoff = new Date(nextBiz + "T12:00:00");
  } else {
    const days = windowKey === "30d" ? 30 : windowKey === "60d" ? 60 : 90;
    cutoff = new Date(today.getTime() + days * 86400000);
  }

  // Pre-cómputo: ¿cuáles positions vencen DENTRO de la ventana?
  // Las usamos para evitar doble-contar movements automáticos
  // (purchase_cost / sale_proceeds) cuya position asociada también
  // entrará al cálculo de Liquidez vía vencimiento.
  //
  // Caso típico del bug: comprás un bono S29Y6 con plazo T1. Eso
  // genera un purchase_cost con fecha mañana (sale del cash) Y la
  // position en sí entra en cartera hoy. Al vencer S29Y6 dentro de
  // la ventana, valueAtMarket sumaría su valor al vencimiento, pero
  // ese valor YA INCLUYE el millón comprado en T1. Si además sumamos
  // el movement T1 al cálculo, restamos el millón dos veces (una al
  // egresar mañana y otra implícita al vencer el bono más adelante).
  // El resultado: Liquidez quedaba ~$1.3M debajo del Total real.
  //
  // Solución: si el movement automático corresponde a una position
  // que vence DENTRO de la ventana, lo saltamos. El efecto neto sobre
  // tu cash queda absorbido por el flujo del vencimiento.
  const positionMaturesInWindow = new Set();
  if (positions && positions.length > 0) {
    for (const p of positions) {
      const md = getPositionMaturity(p);
      if (!md) continue;
      const matDate = new Date(md);
      if (matDate >= today && matDate <= cutoff) {
        positionMaturesInWindow.add(p.id);
      }
    }
  }

  // 3a) Movements futuros (ya cargados): por ej, una venta T+1 cargada hoy
  // genera un sale_proceeds con movement_date = mañana hábil.
  //
  // EXCEPCIÓN: movements automáticos cuya position asociada vence
  // dentro de la ventana NO se cuentan (ver explicación arriba).
  if (movements && movements.length > 0) {
    for (const m of movements) {
      if (m.movement_date <= todayIso) continue; // los <= hoy ya están en CI
      const md = new Date(m.movement_date + "T12:00:00");
      if (md > cutoff) continue;
      if (!(m.currency in result)) continue;

      // Skip si es movement automático y la position vence en ventana
      // (su valor está implícito en el flujo del vencimiento).
      if (m.related_position_id && positionMaturesInWindow.has(m.related_position_id)) {
        continue;
      }

      const sign = (m.movement_type === "deposit" || m.movement_type === "sale_proceeds") ? 1 : -1;
      result[m.currency] += sign * Number(m.amount);
    }
  }

  // 3b) Vencimientos / cobros de posiciones.
  //
  // Para BONOS / ONs / FCI / OPCIONES: solo aplicamos en windows >= 30d.
  // T1 raramente captura un vencimiento de bono y mezclarlo confunde
  // más que aporta.
  //
  // Para CAUCIONES: aplicamos en TODAS las windows (incluido T1), porque
  // las cauciones overnight vencen al día siguiente y T1 las captura.
  // Sumamos solo (montoTotal_al_vencer − devengado_a_hoy) = intereses
  // pendientes. El devengado_a_hoy ya está en CI (sección 1b), así que
  // sumar el total al vencer sería double-count.
  {
    const nonFuture = positions.filter((p) => p.instrument_type !== "future");
    const groups = consolidatePositions(nonFuture, bondPrices, futurePrices);

    for (const g of groups) {
      if (g.netQty === 0 || g.isClosed) continue;

      const sample = g.operations[0];
      if (!sample) continue;
      const matDate = getPositionMaturity(sample);
      if (!matDate) continue;
      const md = new Date(matDate + "T12:00:00");
      if (md < today || md > cutoff) continue;

      const cur = g.currency || "ARS";
      if (!(cur in result)) continue;

      if (sample.instrument_type === "caucion") {
        // Cauciones: sumar SOLO los intereses pendientes hasta vencer.
        // El devengado a hoy ya está en CI (1b).
        const totalAtMaturity = caucionValueAtMaturity(sample);
        const devengadoHoy = caucionValueDevengado(sample, todayIso);
        if (
          totalAtMaturity != null &&
          devengadoHoy != null &&
          Number.isFinite(totalAtMaturity) &&
          Number.isFinite(devengadoHoy)
        ) {
          result[cur] += (totalAtMaturity - devengadoHoy);
        }
      } else {
        // Bonos / ONs / FCI / Opciones: solo para windows >= 30d.
        if (windowKey === "T1") continue;
        if (g.valueAtMarket == null) continue;
        result[cur] += g.valueAtMarket;
      }
    }
  }

  // 3c) P&L NO acreditado de FUTUROS abiertos.
  //
  // El P&L "no acreditado" es la parte del P&L total contable del futuro
  // que TODAVÍA NO se reflejó como cash en la cuenta. Equivale a:
  //   nonAcreditedPnL = P&L_total_contable − SUM(actual_amount de adjustments confirmed)
  //
  // En la práctica, este monto contiene dos componentes que el usuario
  // ve día a día:
  //   (a) Pending adjustments (ajustes generados por el cron del día
  //       siguiente que esperan ser confirmados en el modal).
  //   (b) P&L vivo intraday del día corriente (todavía no se generó el
  //       pending porque el cron corre a las 7 AM del día hábil siguiente).
  //
  // ¿Por qué se suma a T1 / 30D / 60D / 90D y NO a CI?
  //   - CI = saldo cash estrictamente actual. El P&L no acreditado todavía
  //     no es cash, es una promesa que se va a materializar progresivamente
  //     a medida que el usuario confirme cada pending.
  //   - T1+ = "cuánto vas a tener disponible cuando se acrediten los
  //     próximos ajustes". Sumar el P&L no acreditado refleja eso.
  //
  // Cubrimos TODOS los futuros abiertos sin filtrar por vencimiento en
  // ventana. La razón: aunque el contrato venza dentro de 90 días o dentro
  // de 6 meses, el cash de los ajustes va goteando todos los días — no es
  // un flujo único al vencimiento como un bono. Para T1 / 30d / 60d / 90d
  // el monto relevante es el mismo: el P&L que todavía no se cobró.
  //
  // No double-counting porque:
  //   - Los acreditados YA están en cash (item 1: sumamos cash_movements
  //     incluyendo los deposits que vienen de confirmar adjustments).
  //   - El P&L no acreditado SOLO contiene lo no acreditado (lo restamos
  //     vía SUM(realizedPnL) del futureAdjLookup).
  //
  // ROFEX siempre liquida en ARS, sin importar la moneda registrada de
  // la posición.
  //
  // Defensive coding: try/catch + checks de Number.isFinite en cada suma.
  // Si consolidatePositions o el lookup devuelven algo inesperado,
  // logueamos y seguimos — preferible mostrar liquidez sin el aporte
  // de futuros que crashear la card entera.
  if (windowKey !== "CI") {
    try {
      const futures = Array.isArray(positions)
        ? positions.filter((p) => p && p.instrument_type === "future")
        : [];
      if (futures.length > 0) {
        const futureGroups = consolidatePositions(futures, bondPrices, futurePrices);
        if (Array.isArray(futureGroups)) {
          for (const g of futureGroups) {
            if (!g) continue;
            if (g.isClosed) continue;       // cerrado → su P&L ya está en cash
            if (g.netQty === 0) continue;    // neteo total → idem
            if (!Number.isFinite(g.pnl)) continue;

            // Settle-based (computeFutureUncreditedPnl): mismo modelo que el
            // patrimonio — solo el MTM que la caja todavía no recibió. La
            // fórmula vieja (lifetime − Σ actual_amount) arrastraba la
            // historia previa a la carga de adjustments como "por cobrar".
            const nonAcreditedPnL = computeFutureUncreditedPnl(g, futureAdjLookup, futurePrices);
            if (nonAcreditedPnL != null && Number.isFinite(nonAcreditedPnL)) {
              result["ARS"] += nonAcreditedPnL;
            }
          }
        }
      }
    } catch (err) {
      console.warn(
        "[computeLiquidityBreakdown] Error sumando P&L no acreditado de futuros:",
        err
      );
    }
  }

  return result;
}

function positionValueAtCost(p) {
  if (p.instrument_type === "caucion") return Number(p.quantity) || 0;
  // Futuros: no pagaste capital al abrir, solo garantía (que ya está en
  // otra posición). El costo a efectos de P&L es 0.
  if (p.instrument_type === "future") return 0;
  if (p.entry_price == null) return null;
  return applyPriceToPosition(p, Number(p.entry_price));
}

function computePortfolioTotals(positions, fx, valuationCurrency, bondPrices, futurePrices, futureAdjLookup, stockPrices, fciPrices) {
  let totalMarket = 0;
  let totalCost = 0;
  let unvalued = 0;
  let valuedAny = false;
  let pricesFromMarket = 0; // posiciones con precio data912 / manual
  let pricesFromCost = 0;   // posiciones que cayeron al fallback
  // P&L de futuros que YA se acreditó como cash (suma de actual_amount
  // de adjustments confirmed). Lo separamos de totalMarket porque ese
  // monto ya está sumado en balanceByCurrency (cash) y duplicaríamos si
  // lo metiéramos también en value. Sin embargo SÍ debe contar para el
  // P&L "vs costo" (al usuario le importa cuánto ganó en total, no solo
  // lo no acreditado). En el return final lo sumamos al pnl.
  let realizedFuturesPnL = 0;
  // Idem para los tipos consolidables (bono/accion/CEDEAR/ON/FCI): el P&L de
  // lo que YA se cerro no es tenencia. Ver el detalle en la rama del split.
  let realizedClosedPnL = 0;

  // Separamos las posiciones en TRES grupos según cómo se valúan:
  //
  //  1) Futuros: vista consolidada. valor = P&L (realizado + no realizado),
  //     costo = 0. El "valor de mercado" del notional NO se incluye.
  //
  //  2) Consolidables con split (bond_ars, bond_usd, on, stock, cedear):
  //     vista consolidada para que las VENTAS resten correctamente del
  //     valor de mercado y el P&L realizado se cuente bien. Antes este
  //     loop iteraba operación por operación con positionValueAtMarket(),
  //     que NO respeta operation_type='sell' y por eso una venta de bono
  //     SUMABA al total en lugar de restar. Bug reportado por LP en mayo
  //     2026: T30J6 vendí 10M de un total de 35,9M y el "Total" de la
  //     cartera estaba inflado en ~14M.
  //
  //  3) Resto (caucion, fci, usd, crypto, option): loop individual.
  //     Estos tipos NO mezclan compras y ventas del mismo ticker (una
  //     caución colocada se cobra, no se vende; un FCI se rescata, etc).
  //     Por eso el bug del split no aplica acá.
  const futurePositions = [];
  const consolidableSplitPositions = [];
  const individualPositions = [];

  // FCI entró al split el 31/07/2026: desde que el importador carga la
  // historia completa (suscripciones Y rescates como filas), el loop
  // individual valuaba cada rescate como tenencia POSITIVA (mismo bug que
  // T30J6 en mayo) — con la historia de LP eso inflaba el TOTAL ~+280M.
  const SPLIT_TYPES = new Set(["bond_ars", "bond_usd", "on", "stock", "cedear", "fci"]);

  for (const p of positions) {
    if (p.instrument_type === "future") {
      futurePositions.push(p);
    } else if (SPLIT_TYPES.has(p.instrument_type)) {
      consolidableSplitPositions.push(p);
    } else {
      individualPositions.push(p);
    }
  }

  // ── (1) FUTUROS: vista consolidada ──────────────────────────────────
  if (futurePositions.length > 0) {
    const futureGroups = consolidatePositions(futurePositions, bondPrices, futurePrices);
    for (const g of futureGroups) {
      // El "valor de mercado" de un futuro consolidado es su P&L total
      // (realizado + no realizado). El costo es 0.
      if (g.pnl == null) continue;

      // P&L NO acreditado settle-based (ver computeFutureUncreditedPnl):
      // lo único que el futuro aporta al patrimonio es el MTM que la caja
      // todavía no recibió. Todo lo demás (ajustes confirmados + historia
      // previa a la carga) YA está dentro del cash — sumarlo acá duplica
      // (fantasma de +1,9M detectado 12/06 contra Cocos).
      const nonAcreditedPnL = computeFutureUncreditedPnl(g, futureAdjLookup, futurePrices);
      if (nonAcreditedPnL == null) {
        unvalued++;
        continue;
      }
      // Para el P&L "histórico" del card: lo acreditado = lifetime − no acreditado.
      const groupRealizedPnL = g.pnl - nonAcreditedPnL;

      const convertedNonAcredited = convertValue(nonAcreditedPnL, g.currency || "ARS", valuationCurrency, fx);
      const convertedRealized = convertValue(groupRealizedPnL, g.currency || "ARS", valuationCurrency, fx);
      if (convertedNonAcredited == null) {
        unvalued++;
        continue;
      }
      valuedAny = true;
      totalMarket += convertedNonAcredited;
      if (convertedRealized != null) realizedFuturesPnL += convertedRealized;
      // costo de futuros = 0, no suma a totalCost
      if (g.priceSource === "market" || g.priceSource === "manual" ||
          g.priceSource === "close" || g.priceSource === "primary" ||
          g.priceSource === "mae") {
        pricesFromMarket++;
      } else {
        pricesFromCost++;
      }
    }
  }

  // ── (2) CONSOLIDABLES CON SPLIT: vista consolidada ──────────────────
  // Acá entra cada grupo (bond, stock, cedear, on) que ya viene splitteado
  // por consolidatePositions:
  //   - Posición 100% abierta (sin ventas): 1 fila, valor mkt + costo normales
  //   - Cierre parcial: 2 filas (una "open" con netQty + costo, una "closed"
  //     con valor=P&L realizado y costo=0)
  //   - Cierre total: 1 fila "closed" con valor=P&L realizado y costo=0
  // Sumando linealmente, el total queda correcto porque las cerradas
  // aportan SOLO el P&L (sin doble-contar capital).
  if (consolidableSplitPositions.length > 0) {
    // fciPrices va acá desde que fci entró a SPLIT_TYPES (sin él los FCI
    // caerían a costo silenciosamente).
    const groups = consolidatePositions(consolidableSplitPositions, bondPrices, futurePrices, fciPrices, stockPrices);
    for (const g of groups) {
      if (g.valueAtMarket == null) {
        unvalued++;
        continue;
      }
      const convertedMarket = convertValue(
        g.valueAtMarket, g.currency || "ARS", valuationCurrency, fx
      );
      if (convertedMarket == null) {
        unvalued++;
        continue;
      }
      valuedAny = true;

      // FIX 24/08/2026 - "TENENCIA VALORIZADA" INCLUIA LO YA VENDIDO.
      //
      // consolidatePositions parte cada ticker en un grupo ABIERTO (netQty != 0,
      // valor = mercado) y uno CERRADO (isClosed, valor = P&L realizado,
      // costo = 0). Este loop los sumaba a los dos en totalMarket, que es lo
      // que la UI muestra como "Tenencia valorizada". Resultado: al patrimonio
      // se le sumaba el resultado historico de operaciones que ya no existen.
      //
      // Medido contra el broker el 24/08: la lista daba 160.223.293,95 y el
      // encabezado 150.083.703,50. Los 10.139.590,45 de diferencia son el
      // realizado de los 27 tickers con neto cero (MU -13,3M, SNDK -4,9M,
      // SPCX -4,8M contra NU +5,9M e YPFD +3,5M). Coincide dentro de $3.000,
      // que es el ruido de calcular contra PPP en vez de flujo de caja.
      //
      // Ahora van a realizedClosedPnL, igual que los futuros ya acreditados:
      // salen de la tenencia pero se siguen contando en el P&L vs costo, asi
      // que el "historico" no cambia. Mismo criterio que ya usa
      // computeLiquidityBreakdown ("cerrado -> su P&L ya esta en cash").
      if (g.isClosed) {
        realizedClosedPnL += convertedMarket;
        continue;
      }

      totalMarket += convertedMarket;

      if (g.valueAtCost != null) {
        const convertedCost = convertValue(
          g.valueAtCost, g.currency || "ARS", valuationCurrency, fx
        );
        if (convertedCost != null) totalCost += convertedCost;
      }

      // Para clasificar fuente: priceSource del grupo viene de useBondPrices
      // (byma/data912/mae/manual) o "cost"/"close". Las cerradas siempre son
      // "close" → cuentan como market.
      const src = g.priceSource;
      const fromMarket =
        src === "byma" ||
        src === "data912" ||
        src === "mae" ||
        src === "market" ||
        src === "manual" ||
        src === "close";
      if (fromMarket) {
        pricesFromMarket++;
      } else {
        pricesFromCost++;
      }
    }
  }

  // ── (3) INDIVIDUALES: loop simple (caucion, fci, usd, crypto, option) ──
  for (const p of individualPositions) {
    const marketRes = positionValueAtMarket(p, bondPrices, futurePrices, stockPrices, fciPrices);
    const cost = positionValueAtCost(p);

    // Si no hay precio de mercado, caemos a costo — la posición sigue
    // siendo parte de la cartera y tiene que sumar al TOTAL, no quedarse
    // "unvalued". consolidatePositions hace el mismo fallback (cuando
    // fciPrices/bondPrices no tienen la clave, currentPrice = ppp y
    // priceSource = "cost"), y sin esta rama acá el TOTAL del top card
    // quedaba incoherente con los totales que ves en la tabla consolidada.
    let positionValue, positionSource;
    if (marketRes != null) {
      positionValue = marketRes.value;
      positionSource = marketRes.source;
    } else if (cost != null) {
      positionValue = cost;
      positionSource = "cost";
    } else {
      unvalued++;
      continue;
    }

    const convertedValue = convertValue(
      positionValue, p.entry_currency || "ARS", valuationCurrency, fx
    );
    if (convertedValue == null) {
      unvalued++;
      continue;
    }
    valuedAny = true;
    totalMarket += convertedValue;

    if (cost != null) {
      const convertedCost = convertValue(
        cost, p.entry_currency || "ARS", valuationCurrency, fx
      );
      if (convertedCost != null) totalCost += convertedCost;
    }

    // Considerar como "from market" cualquier fuente real de mercado
    // (BYMA, data912, MAE, market legacy) o manual (override del usuario).
    // Solo "cost" cae a pricesFromCost.
    const fromMarket =
      positionSource === "byma" ||
      positionSource === "data912" ||
      positionSource === "mae" ||
      positionSource === "fci" ||
      positionSource === "market" || // legacy
      positionSource === "manual";
    if (fromMarket) {
      pricesFromMarket++;
    } else {
      pricesFromCost++;
    }
  }

  // PNL vs costo: tiene que incluir los P&L acreditados de futuros
  // (que sacamos de totalMarket para no duplicar con cash, pero que
  // siguen contando como "ganancia respecto al costo de inicio").
  // pnl viejo  = totalMarket - totalCost = bonosPnL + futurosPnL_total
  // pnl nuevo  = (totalMarket + realizedFuturesPnL) - totalCost
  //            = bonosPnL + futurosPnL_no_acreditado + futurosPnL_acreditado
  //            = bonosPnL + futurosPnL_total      ← equivalente al viejo
  const pnl = totalMarket + realizedFuturesPnL + realizedClosedPnL - totalCost;
  const pnlPct = totalCost > 0 ? (pnl / totalCost) * 100 : null;

  return {
    value: valuedAny ? totalMarket : null,
    valueAtCost: valuedAny ? totalCost : null,
    pnl: valuedAny ? pnl : null,
    pnlPct: valuedAny ? pnlPct : null,
    realizedFuturesPnL,
    realizedClosedPnL,
    unvalued,
    pricesFromMarket,
    pricesFromCost,
  };
}

module.exports = {computePortfolioTotals, consolidatePositions, positionValueAtMarket, positionValueAtCost, convertValue, computeFutureUncreditedPnl};
