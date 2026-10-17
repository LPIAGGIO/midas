# Pantalla Fondos: diseño (17/10/2026)

Pedido de LP del 17/10: una pantalla con tres universos (ETF de EE.UU. sin
CEDEAR, ETF con CEDEAR en BYMA, FCI argentinos), ficha por fondo y, lo que la
diferencia, el cruce de la composición contra la cartera real y las grillas de
Cocos. Todavía no hay nada construido: ni tablas ni workers. Lo único hecho
es un prototipo de solo lectura (`research/fondos/prototipo.py`) para
comprobar que las fuentes aguantan.

## 1. Huecos primero

1. **La cuenta afuera con ETF de EE.UU. tiene dos costos que no se ven en el
   expense ratio.** Un no residente sin tratado (Argentina no tiene tratado
   con EE.UU.) paga 30% de retención sobre los dividendos, y si tiene más de
   USD 60.000 en activos de EE.UU. queda expuesto al impuesto a la herencia de
   EE.UU. La alternativa que usa casi todo el mundo desde Argentina son los ETF
   UCITS domiciliados en Irlanda (CSPX, VWRA, IB01): pagan 15% de retención
   adentro del fondo y no tienen el problema de la herencia. Si el universo 1
   es solo de ETF de EE.UU., la pantalla puede empujar a la opción más cara en
   impuestos. **Decisión de LP (sección 8).** Ojo: los UCITS no presentan
   N-PORT, así que su composición sale solo de Yahoo (top 10).
2. **La composición completa viene atrasada.** El N-PORT de la SEC se publica
   60 días después del cierre de cada trimestre: hoy (17/10) lo último
   disponible es al **30/06/2026, 109 días de atraso**; el del 30/09 aparece a
   fines de noviembre. Solo State Street (SPY, DIA, XL*) publica el archivo
   diario y anda desde el VPS. iShares devuelve una página HTML en vez del CSV
   y Vanguard redirige a HTML (probado desde la PC y desde el VPS), así que
   para ellos queda N-PORT. Yahoo da el top 10 actualizado pero nada más. La
   fecha de cada composición va al lado del dato, con el mismo badge de atraso
   que Superinversores.
3. **"Contra su índice" no viene de ninguna fuente gratuita.** Yahoo da el
   rendimiento del fondo y el promedio de su categoría (Morningstar), no el
   del índice que replica (SMH sigue al MVIS US Listed Semiconductor 25, que
   no está en Yahoo). Para un ETF pasivo la diferencia contra su propio índice
   es casi exactamente el expense ratio, así que mostrarla aporta poco. Lo útil
   es compararlo contra una referencia elegida. **Decisión de LP.**
4. **Los ratios de CEDEAR no tienen una fuente oficial completa y legible.**
   BYMA open data no trae el ratio; el MCP de Cocos tampoco. La planilla de
   Comafi (`7281.xlsx`, formulario de emisión) trae 304 programas con CUSIP y
   ratio, pero le faltan SPY, QQQ, SMH, EWZ, GLD y otros. En la web los
   números se contradicen (SPY 20:1 en un lado, 60:1 en otro). Solución
   medida abajo: derivar el ratio del precio y usar Comafi como control.
5. **El cruce con las grillas depende de qué exposición se mire.** La grilla
   de NVDA tiene `config.max` 320 pero hoy tiene 608 en la 72404 (refuerzo +
   lateral): el `max` de la config no es el techo real. Hay que mostrar la
   tenencia de hoy y el techo teórico (`max × (1 + refuerzo) + lateral_max ×
   lote × lateral_frac`).
6. **Sin sector por papel en la composición.** N-PORT no trae sector y el
   archivo de SSGA para SPY trae la columna Sector vacía ("-"). El sector de
   cada papel sale de Yahoo (`assetProfile`), con caché propio, en la misma
   taxonomía de 11 sectores que ya usa `fundamentals_snapshot`. UNH no está en
   `fundamentals_snapshot`: el caché nuevo tiene que cubrir lo que falte.
7. **Composición de FCI: no hay API.** El endpoint de carteras de CAFCI
   (`api.cafci.org.ar`) devuelve 401 y `api.pub.cafci.org.ar` solo deja bajar
   la planilla diaria. La cartera de cada FCI queda para una fase posterior
   (CNV, AIF). Sin eso, el cruce con la cartera no aplica a FCI.
8. **Dato a confirmar antes de mostrar el cruce:** `positions` da 12.499 SPCX
   en Cocos principal (~USD 36.000, 28% de lo que hay en CEDEARs). Con eso,
   "Industria" sale como el segundo sector de la cartera. Hay que cruzarlo con
   la foto de Cocos antes de que el gráfico de sectores diga algo.

## 2. Fuentes, probadas el 17/10/2026

| Fuente | Qué da | PC | VPS | Fecha del dato | Notas |
|---|---|---|---|---|---|
| SEC `company_tickers_mf.json` | ticker → CIK, series, clase (28.593 filas) | ok | — | diario | SPY, DIA, GLD, IBIT no figuran: no son fondos registrados (UIT o trust) |
| SEC N-PORT (`browse-edgar?CIK=<series>&type=NPORT-P` + `primary_doc.xml`) | composición completa: nombre, CUSIP, ISIN, % del patrimonio, país, tipo de activo; AUM | ok | ok | trimestral, 60 días de atraso | SMH al 30/06: 26 papeles, NVDA 17,5%, TSM 9,3% (TW), ASML 5,0% (NL). UA "Midas Research lpiaggio@gmail.com" como el worker de 13F |
| SSGA `holdings-daily-us-en-<t>.xlsx` | composición completa diaria con ticker | ok | ok (seguir redirect) | diario | SPY al 15/10: 505 papeles. Columna Sector vacía |
| iShares CSV de holdings | — | HTML | HTML | — | no usable; iShares por N-PORT |
| Vanguard API de holdings | — | 301 a HTML | — | — | no usable; Vanguard por N-PORT |
| OpenFIGI `/v3/mapping` | CUSIP/ISIN → ticker | ok | ok | — | sin clave: 25 pedidos/min, 10 ids por pedido. Para resolver el N-PORT |
| Yahoo `quoteSummary` (con crumb) | top 10 con ticker, sectores, familia, categoría, expense ratio, AUM, yield, rendimientos 1m/3m/1a/5a (anualizado) y promedio de la categoría | ok | ok | diario | 59 ETF sin un error en una tanda con 0,4 s de pausa |
| Yahoo `chart` 5 años diario | cierres ajustados (volatilidad, drawdown) y dividendos | ok | ok | diario | |
| Yahoo `spark` | precio USD y tipo de instrumento (ETF/EQUITY) | ok | ok | en vivo | sirve para separar los CEDEAR de ETF |
| data912 `/live/arg_cedears` | precio de los CEDEAR en BYMA | ok | — | en vivo | ya lo usa el front (proxy `api/data912.js`) |
| Comafi `7281.xlsx` | ticker, CUSIP, ratio de 304 programas | ok | — | versión 27/01/2025 | incompleta para ETF; sirve de control |
| CAFCI `api.pub.cafci.org.ar/pb_get` | planilla diaria: 4.300 filas con clase, VCP, patrimonio, honorarios SG/SD, gastos, comisiones de ingreso/rescate/éxito, plazo de liquidación, calificación, variación mes/año/12m | ok | ok | VCP del 16/10 a las 12 del 17/10 | `fci_quotes` (ArgentinaDatos) tenía hasta el 15/10: la planilla viene un día más fresca |
| ArgentinaDatos `/finanzas/tasas/plazoFijo` | TNA de plazo fijo por banco | ok | — | diario | BNA 19,25% clientes |
| `mtr_market_data` (rx_MAE) | caución 1 día | ya en uso | | en vivo | |
| `fci_quotes` / `get_fci_prices` | historia de VCP por fondo y clase | ya en uso | | 1-3 días de atraso | ojo con las clases (memoria de FCI) |

## 3. Cómo se calcula cada número

**Universo de ETF con CEDEAR.** De los 431 CEDEAR base que lista data912,
Yahoo marca 59 como ETF (SPY, QQQ, SMH, XLE, EWZ, GLD, IBIT, DIA, IWM, EEM,
ARKK, los XL*, etc.). VXX figura como ETF pero es un ETN: va con etiqueta.

**Ratio.** `ratio = round(precio_USD × CCL_ref / precio_CEDEAR)`, con CCL_ref
= mediana del CCL implícito de AAPL, MSFT, NVDA, KO, AMZN, META y GOOGL (los
mismos anclas que `EJEC_RATIOS`). Hoy: 57 de 59 redondean con desvío menor a
0,5% (SPY 60, QQQ 20, SMH 50, XLE 2, EWZ 2, GLD 50, IBIT 10). **Los 15 ETF que
figuran en la planilla de Comafi coinciden los 15.** Dudosos: IVV (da 691,
con un ratio tan grande el redondeo no se distingue del spread) y VXX (desvío
1,3%, el ETN se derrite). Regla: el ratio se guarda con su fuente (Comafi o
derivado), se recalcula cada día como mediana de varias tomas, y si cambia o
se aparta más de 1% se marca "a confirmar" y no se muestra el precio
implícito.

**Precio implícito del CEDEAR** = `precio_USD × CCL_ref / ratio`, en vivo en
el front con los datos que ya tiene. Prima o descuento = `precio_CEDEAR /
implícito − 1`.

**Rendimientos.** 1m/3m/1a/5a de Yahoo (5a anualizado, se aclara). Se
recalculan del cierre ajustado como control. Para el universo 2 van en USD: el
CEDEAR replica al ETF y la variación en pesos mezcla el CCL.

**Volatilidad** anual de 1 año de retornos diarios en USD, y máxima caída de 1
año. Ejemplos de hoy: ACWI 14%, BBCA 14%, CIBR 30%, ARKK 38%.

**Costo anual.** ETF: expense ratio de Yahoo. FCI: honorarios SG + SD + gastos
ordinarios de la planilla de CAFCI, por clase (Cocos Pesos Plus A 2,50% + 0,13%
contra clase C 1,25% + 0,13%).

**FCI contra caución y plazo fijo.** TNA del fondo a 7 y 30 días desde
`fci_quotes`, contra caución 1 día colocadora (`mtr_market_data`) y plazo
fijo a 30 días (BNA y promedio de bancos). Con la etiqueta de que el FCI
devenga neto de honorarios y el plazo fijo no tiene liquidez.

**El cruce.**
- Cartera: neto por `operation_type` de `positions` (todos los brokers),
  valuado en USD al CCL. Más `scalp_estado` para las grillas: tenencia de hoy y
  techo teórico.
- Fondo: composición completa (SSGA o N-PORT); si no hay, top 10 de Yahoo, y
  la pantalla dice que es parcial.
- **Por emisor, no por ticker**: GOOG y GOOGL son el mismo emisor (SPY tiene
  las dos clases). Se agrupa por los primeros 6 caracteres del CUSIP.
- Resultado: porcentaje del fondo que cae en papeles que ya tenés,
  exposición combinada por papel si comprás USD X del fondo, y sectores antes
  y después.

**Ejemplo real de hoy** (cartera en CEDEAR según `positions`, ~USD 130.000;
SPCX a confirmar):

| ETF | Del fondo, en papeles que ya tenés | Detalle |
|---|---|---|
| XLK | 55% (top 10) | NVDA 15,5, AAPL 13,6, MSFT 10,7, AMD 5,1, MU 4,5, INTC 3,4 |
| QQQ | 41% (top 10) | NVDA 8,3, AAPL 7,4, MSFT 5,8, MU 5,0, AMD 4,2, AMZN 4,1 |
| SPY | 39,5% (completo, SSGA 15/10) | contra 32,5% mirando solo el top 10 |
| SMH | 34% (top 10) | NVDA 19,3%, y NVDA ya está en las dos grillas (1.056 CEDEAR, ~USD 9.500) |
| XLC | 34% (top 10) | META 22,2, GOOGL 11,6 |

Con USD 10.000 en SMH (composición N-PORT del 30/06), USD 3.774 van a NVDA,
MU, AMD, INTC y QCOM. Hoy los semis y la memoria ya son el 33% de la cartera
en CEDEAR. Sin solapamiento en el top 10: EEM, EFA, EWJ, EWY, FXI, IWM, VEA,
XLF, XLI, XLU, XLB, IBB, GDX, URA y otros. La diferencia de 7 puntos en SPY
entre el top 10 y la composición completa es el motivo para no quedarse con
Yahoo solo.

## 4. Tablas nuevas en Supabase

Todas con RLS de lectura pública (son datos de mercado, como `si_holdings`);
escribe solo el worker con la service key. Ninguna guarda datos de usuario: el
cruce se calcula en el front con las posiciones que el usuario ya lee.

- **`fondos`** (PK `ticker`): `universo` (`etf_cedear` | `etf_usa` |
  `etf_ucits` | `fci`), `nombre`, `familia`, `categoria`, `tipo_legal`
  (ETF/UIT/trust/ETN), `cik`, `series_id`, `comparador`, `expense_ratio`,
  `aum_usd`, `yield`, `ret_1m`, `ret_3m`, `ret_1a`, `ret_5a_anual`,
  `ret_fecha`, `ret_cat` jsonb, `vol_1a`, `max_caida_1a`, `dividendos` jsonb
  (12 meses), `sectores` jsonb, `paises` jsonb, `top10` jsonb,
  `holdings_fuente`, `holdings_fecha`, `actualizado_at`.
- **`fondos_cedear`** (PK `ticker`): `ratio`, `ratio_fuente` (comafi |
  derivado), `ratio_desvio`, `ratio_dudoso`, `cusip`, `ratio_desde`,
  `actualizado_at`. El precio implícito no se guarda: se calcula en vivo.
- **`fondos_holdings`** (PK `ticker_fondo, fecha, cusip`): `fuente` (nport |
  ssga | yahoo), `isin`, `emisor6`, `ticker`, `nombre`, `peso`, `pais`,
  `tipo_activo`. Solo la última fecha por fondo y la anterior (para ver qué
  cambió). Los ETF de bonos guardan los 50 mayores y el resto agregado (AGG
  tiene más de 10.000 líneas). Volumen esperado: unos 25.000 registros; el
  front pide un fondo por vez y pagina (tope de 1.000 filas).
- **`valores_maestro`** (PK `cusip`): `isin`, `figi`, `ticker`, `nombre`,
  `sector`, `industria`, `pais`, `actualizado_at`. Caché de OpenFIGI + Yahoo
  `assetProfile`, se refresca una vez por mes.
- **`fci_ficha`** (PK `codigo_cafci`): `fondo` (mismo nombre que
  `fci_quotes`), `clase`, `categoria`, `moneda`, `horizonte`, `gerente`,
  `depositaria`, `plazo_liq_dias`, `honorarios_sg`, `honorarios_sd`,
  `gastos`, `com_ingreso`, `com_rescate`, `com_exito`, `calificacion`,
  `patrimonio`, `var_mes`, `var_anio`, `var_12m`, `fecha`.
- **`tasas_referencia`** (PK `fecha, serie`): caución 1 día, plazo fijo 30
  días BNA y promedio. Chica; puede ir como modo dentro de una tabla
  existente si se prefiere.

## 5. Workers en el VPS

- **`fondos`** (nuevo, `~/workers/fondos`, node_modules y `.env` por symlink
  como `superinvestors-13f`). Dos modos con dos crons de PM2:
  - `--perfil` lun-vie 08:15: arma el universo (CEDEAR ETF desde data912 +
    Yahoo spark; ETF de EE.UU. y UCITS desde una lista sembrada en el worker),
    baja `quoteSummary` y `chart`, deriva los ratios y controla contra Comafi.
    ~150 fondos × 2 pedidos a Yahoo con pausa: unos 3 minutos.
  - `--holdings` diario 07:30 para SSGA, y semanal (domingo) para N-PORT:
    busca el último NPORT-P por series id y solo baja si el accession cambió;
    resuelve CUSIP con OpenFIGI (con caché) y el sector con Yahoo.
  - `--dry-run` como todos.
- **`fci-snapshot`** (existente): sumarle la bajada de la planilla de CAFCI
  (`pb_get`, un solo archivo de ~1 MB) para llenar `fci_ficha`. Efecto
  lateral bueno: la planilla trae el VCP un día antes que ArgentinaDatos; se
  puede usar para achicar el atraso de la valuación de FCI, pero eso es otro
  cambio y se decide aparte.
- Nada en `api/` (tope de 12 funciones): el front lee las tablas de Supabase y
  usa el proxy de data912 que ya existe para el precio del CEDEAR.

## 6. Pantalla

Entrada **Analizadores → Fondos**, visible sin login (el listado y la ficha son
datos de mercado). El cruce pide login y degrada bien sin cartera: muestra la
composición y dice "cargá tu cartera para ver el solapamiento".

- **Tres solapas**: ETF con CEDEAR · ETF EE.UU. (y UCITS si se aprueba) · FCI.
- **Listado**: ticker, nombre, categoría, costo anual, AUM, 1m/3m/1a/5a,
  volatilidad, yield, y en la solapa CEDEAR ratio, precio implícito y prima.
  Columna "Ya tenés" con el % del fondo en papeles de tu cartera. Filtros por
  categoría y búsqueda. Orden por cualquier columna.
- **Ficha del ETF**: cabecera con los números y la fuente de cada uno ("Yahoo,
  al 15/10"); composición en tres bloques (top 10, sectores, países) con fecha
  y badge de atraso; rendimiento contra el comparador; dividendos de 12 meses;
  y el bloque **"Cruce con tu cartera"**: por papel, peso en el fondo, lo que ya
  tenés (cartera y grillas, por separado), y la exposición combinada si comprás
  USD X (campo editable). Sectores antes y después. Una frase arriba del
  bloque: "SMH: 34% de lo que comprás va a papeles que ya tenés. NVDA es el
  19,3% del fondo y ya está en las dos grillas".
- **Ficha del FCI**: clase y las otras clases del mismo fondo con sus
  honorarios, plazo de rescate (T+0 / T+1), costo total, patrimonio, TNA 7 y
  30 días contra caución y plazo fijo, gráfico del VCP. Sin composición hasta
  la fase 4.
- Pie fijo con las limitaciones (atraso del N-PORT, top 10 parcial donde
  corresponda, "no es una recomendación").

## 7. Fases

1. **ETF con CEDEAR + cruce**: tablas `fondos`, `fondos_cedear`,
   `fondos_holdings`, `valores_maestro`; worker `fondos`; solapa 1, ficha y
   cruce. Es lo que diferencia la pantalla.
2. **FCI**: planilla de CAFCI en `fci-snapshot`, `fci_ficha`,
   `tasas_referencia`, solapa 3. Barato: un archivo por día.
3. **ETF EE.UU. (y UCITS)**: lista sembrada, solapa 2.
4. **Después**: composición de FCI (CNV), aviso de cambio de ratio,
   qué cambió en la composición de un trimestre al otro.

Se puede invertir 2 y 3; FCI es lo más barato de construir.

## 8. Decisiones para LP

1. **Universo 1.** A) solo ETF de EE.UU.; B) EE.UU. + sus equivalentes UCITS
   de Irlanda, uno al lado del otro con la retención de dividendos visible;
   C) solo UCITS. Recomendación: B.
2. **Comparador de rendimiento.** A) un índice o ETF de referencia elegido a
   mano por fondo (SMH contra ^SOX, EWZ contra ^BVSP); B) el promedio de la
   categoría de Yahoo; C) siempre SPY (costo de oportunidad). Recomendación: A
   con C al lado; B solo como dato.
3. **Exposición de las grillas en el cruce.** A) tenencia de hoy; B) techo
   teórico; C) las dos. Recomendación: C.
4. **Orden de fases**: 1-2-3 o 1-3-2.
5. **SPCX**: confirmar los 12.499 de Cocos principal con la foto de la
   tenencia antes de mostrar los sectores.
