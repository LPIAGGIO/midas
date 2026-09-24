# Inventario de datos historicos — backtest 5 años

Bajado el 2026-09-17 con `download_hist.js` (Node puro, fetch nativo, sin deps).
Fuente acciones: Yahoo Finance chart API. Fuente CCL: argentinadatos.com.
Todo local, no se toco ni el VPS ni Supabase.

- **Universo:** 48 tickers del bot + 2 benchmarks (SPY, QQQ) = 50 simbolos.
- **Total de barras bajadas: 297.304** (58.817 diarias + 238.487 horarias).
- **Fallos de descarga: 0.** Los 50 simbolos respondieron en ambas series, sin reintentos.

---

## 1. Diario — 5 años (`data/daily/<SYM>.json`)

Rango pedido `range=5y&interval=1d`. La serie completa son **1255 ruedas** (2021-09-17 → 2026-09-17).

| Ticker | Barras | Cierres validos | Primera | Ultima | Gaps > 5 ruedas |
|---|---:|---:|---|---|---|
| MU | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| SNDK | 400 | 400 | 2025-02-13 | 2026-09-17 | ninguno |
| GGAL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| NVDA | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| AMD | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| AAPL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| MSFT | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| GOOGL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| META | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| AMZN | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| KO | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| JNJ | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| XOM | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| MELI | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| NU | 1197 | 1197 | 2021-12-09 | 2026-09-17 | ninguno |
| INTC | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| SPCX | 67 | 67 | 2026-06-12 | 2026-09-17 | ninguno |
| TSLA | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| ORCL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| AVGO | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| VST | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| MCD | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| VIST | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| MSTR | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| HUT | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| MRNA | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| UBER | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| IBM | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| QCOM | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| OKLO | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| IREN | 1212 | 1212 | 2021-11-17 | 2026-09-17 | ninguno |
| MRVL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| PLTR | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| NBIS | 478 | 478 | 2024-10-21 | 2026-09-17 | ninguno |
| ADBE | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| COIN | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| NFLX | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| RGTI | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| KEEL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| ADI | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| SATL | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| LAR | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| HPQ | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| WMT | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| ARM | 755 | 755 | 2023-09-14 | 2026-09-17 | ninguno |
| LAC | 743 | 743 | 2023-10-02 | 2026-09-17 | ninguno |
| V | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| GPRK | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| SPY *(bench)* | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |
| QQQ *(bench)* | 1255 | 1255 | 2021-09-17 | 2026-09-17 | ninguno |

**Gaps:** ninguno. Ni un solo simbolo tiene un hueco mayor a 5 ruedas habiles en toda la serie.
**Cierres nulos:** cero en diario — los 58.817 bars diarios tienen precio.

---

## 2. Horario — 2 años (`data/hourly/<SYM>.json`)

Rango pedido `range=730d&interval=1h`. Yahoo corta el intradiario ahi: la serie completa son **5094 barras** (2023-10-19 → 2026-09-17), o sea ~700 ruedas de 7 barras.

| Ticker | Barras | Cierres validos | Primera | Ultima | Gaps > 5 ruedas |
|---|---:|---:|---|---|---|
| MU | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| SNDK | 2750 | 2738 | 2025-02-24 | 2026-09-17 | ninguno |
| GGAL | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| NVDA | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| AMD | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| AAPL | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| MSFT | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| GOOGL | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| META | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| AMZN | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| KO | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| JNJ | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| XOM | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| MELI | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| NU | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| INTC | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| SPCX | 465 | 465 | 2026-06-12 | 2026-09-17 | ninguno |
| TSLA | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| ORCL | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| AVGO | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| VST | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| MCD | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| VIST | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| MSTR | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| HUT | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| MRNA | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| UBER | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| IBM | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| QCOM | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| OKLO | 4116 | 4100 | 2024-05-10 | 2026-09-17 | ninguno |
| IREN | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| MRVL | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| PLTR | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| NBIS | 3334 | 3320 | 2024-10-21 | 2026-09-17 | ninguno |
| ADBE | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| COIN | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| NFLX | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| RGTI | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| KEEL | 803 | 803 | 2026-04-06 | 2026-09-17 | ninguno |
| ADI | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| SATL | 5094 | 4845 | 2023-10-19 | 2026-09-17 | ninguno |
| LAR | 2883 | 2870 | 2025-01-27 | 2026-09-17 | ninguno |
| HPQ | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| WMT | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| ARM | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |
| LAC | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| V | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| GPRK | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| SPY *(bench)* | 5094 | 5077 | 2023-10-19 | 2026-09-17 | ninguno |
| QQQ *(bench)* | 5094 | 5078 | 2023-10-19 | 2026-09-17 | ninguno |

**Gaps:** ninguno mayor a 5 ruedas.
**Cierres nulos:** hay entre 13 y 17 barras nulas por ticker (feriados a medias, subastas). La excepcion es **SATL con 249 nulas** (4845 validas sobre 5094): es un papel finito y hay horas sin una sola operacion. Cualquier estrategia intradiaria sobre SATL va a estar operando contra un libro que no existe.

---

## 3. CCL (`data/ccl.json`)

Salio por el endpoint directo, no hizo falta el fallback.

- **Fuente:** `https://api.argentinadatos.com/v1/cotizaciones/dolares/contadoconliqui`
- **Cobertura total del archivo:** 5.007 registros, 2013-01-02 → 2026-09-17. Tenemos mucho mas que 5 años (13+).
- **Dentro de la ventana de 5 años** (2020-09-17 → 2026-09-17): **2.192 registros**.
- **Gaps > 5 dias:** ninguno.
- Cada registro trae `compra`, `venta`, `fecha`, `casa`. Ultimo dato: 2026-09-17, compra 1597.9 / venta 1600.2.

**Ojo con esto:** 2192 registros en 6 años calendario es exactamente un dato por dia corrido, fines de semana y feriados incluidos. O sea que la serie **arrastra el ultimo valor** en los dias que no hubo mercado; no son observaciones independientes. Al cruzar CCL contra precios de acciones hay que hacer el join por fecha de rueda, no por dia calendario, o te vas a comer retornos de CCL en dias donde el equity no cotizo.

---

## 4. Problemas de calidad del dato (leer antes de backtestear)

La descarga no fallo, pero **"1255 barras" no significa "5 años de empresa"**. Hay dos trampas:

### 4.1 Cascaras de SPAC
`OKLO`, `RGTI` y `SATL` devuelven los 1255 dias completos, pero el tramo viejo **no es la empresa**: es el SPAC antes de la fusion. Evidencia directa del dato bajado:

| Ticker | 2021-09-17 | 2022-09-15 | 2024-11-21 | Que pasa |
|---|---|---|---|---|
| OKLO | 9,83 (vol 21k) | 9,74 (vol 1k) | 25,23 (vol 24,7M) | Clavado en el NAV del trust (~USD 10) con volumen irrisorio hasta 05/2024 |
| RGTI | 9,78 | 2,28 | 1,48 | De-SPAC 03/2022 |
| SATL | 9,88 (vol 9k) | 4,33 (vol 16k) | 1,27 | De-SPAC 01/2022, volumen de dos digitos de miles |

Un precio pegado a USD 10 con 1.000 acciones por dia no tiene volatilidad ni momentum reales. Si el backtest los toma como serie valida, cualquier señal de volatilidad, momentum o mean-reversion sobre ese tramo es ruido inventado, y peor: el salto post-fusion se lee como un retorno gigante que ninguna estrategia podria haber capturado.

### 4.2 Simbolos reciclados
`KEEL` y `LAR` tienen los 1255 dias en diario **pero el horario recien arranca en 2026-04-06 y 2025-01-27** respectivamente. Esa inconsistencia es la firma de un ticker reasignado a otra empresa: el diario viene empalmado con la historia del emisor anterior. Antes de usarlos hay que confirmar a mano desde cuando el simbolo es la empresa que el bot cree que es.

---

## 5. Que se puede backtestear con esto

**Nucleo solido — 38 tickers con 5 años limpios y continuos** (1255 ruedas, sin gaps, sin cascara de SPAC):
MU, GGAL, NVDA, AMD, AAPL, MSFT, GOOGL, META, AMZN, KO, JNJ, XOM, MELI, INTC, TSLA, ORCL, AVGO, VST, MCD, VIST, MSTR, HUT, MRNA, UBER, IBM, QCOM, MRVL, PLTR, ADBE, COIN, NFLX, ADI, HPQ, WMT, V, GPRK, SPY, QQQ.

Sobre ese grupo se puede correr un backtest diario de 5 años de punta a punta, con SPY y QQQ como benchmark, y cubre los tres regimenes que importan: el bear de 2022, la recuperacion 2023-2024 y lo que va de 2025-2026.

**Historia parcial — 7 tickers que empiezan tarde:**

| Ticker | Ruedas | Desde | Motivo |
|---|---:|---|---|
| SPCX | 67 | 2026-06-12 | IPO 06/2026. Solo 67 ruedas. |
| SNDK | 400 | 2025-02-13 | Spinoff de WDC (02/2025). La historia corta es real, no hay dato previo. |
| NBIS | 478 | 2024-10-21 | Reanudo cotizacion 10/2024 (ex-YNDX). Sin historia previa utilizable. |
| LAC | 743 | 2023-10-02 | Spinoff/escision 10/2023. |
| ARM | 755 | 2023-09-14 | IPO 09/2023. |
| NU | 1197 | 2021-12-09 | IPO 12/2021. |
| IREN | 1212 | 2021-11-17 | IPO 11/2021. |

**Mas los 5 sucios de la seccion 4** (OKLO, RGTI, SATL, KEEL, LAR): tienen 1255 barras nominales pero historia util mucho mas corta.

### La consecuencia practica

Si armas el backtest sobre los 50 y dejas que el motor use "lo que haya", **12 de 50 simbolos (24%) entran al ranking con historia corta o falsa**. Eso rompe el resultado por tres lados:

1. **Sesgo de supervivencia al reves (sesgo de seleccion).** Estos papeles estan en el universo del bot *hoy* porque les fue bien. NBIS, OKLO, SNDK, SPCX entraron a la lista despues de subir. Un backtest que arranca en 2021 y los incluye esta comprando en 2021 una lista que recien se armo en 2026.
2. **Sesgo de recencia.** Los jovenes solo existen en el tramo alcista final. Si el ranking los puntua contra los viejos que si comieron 2022, los jovenes ganan por construccion: nunca tuvieron un bear market que perder.
3. **Retornos fantasma en los de-SPAC.** El salto de USD 10 a USD 25 de OKLO no era capturable: antes de la fusion ese papel no tenia ni volumen para entrar ni volatilidad para señalar.

**Recomendacion para el diseño del backtest:** correr el caso base solo sobre los 38 limpios, y meter a los jovenes unicamente con fecha de alta real (entran al universo el dia de su primera rueda liquida, no antes). Los de-SPAC, o se truncan a la fecha de fusion, o se dejan afuera. Comparar las dos corridas: la diferencia entre ellas **es** la magnitud del sesgo, y conviene medirla antes que taparla.

### Horario
El intradiario alcanza para ~2 años (6 tickers tienen menos: SPCX desde 2026-06-12, KEEL desde 2026-04-06, SNDK desde 2025-02-24, LAR desde 2025-01-27, NBIS desde 2024-10-21, OKLO desde 2024-05-10). Sirve para testear reglas de ejecucion y timing dentro del dia, no para testear la señal de fondo — 700 ruedas es muestra corta para eso, y ademas cae entera dentro de un unico regimen alcista.

---

## 6. Archivos

```
research/backtest-5y/
├── download_hist.js        script de descarga (ESM; el package.json de Midas es "type":"module")
├── INVENTARIO.md           este archivo
└── data/
    ├── daily/<SYM>.json    50 archivos, JSON crudo de Yahoo
    ├── hourly/<SYM>.json   50 archivos, JSON crudo de Yahoo
    ├── ccl.json            { source, n, data[] }
    └── _failures.json      [] (vacio)
```

El JSON es la respuesta cruda de Yahoo sin tocar: `chart.result[0].timestamp` + `chart.result[0].indicators.quote[0]` (open/high/low/close/volume).

**Diferencia importante entre las dos series, verificada sobre el dato bajado:**

- **Diario: trae `indicators.adjclose[0].adjclose`.** Difiere de `close` (NVDA: close 21,90 vs adj 21,80 en la primera rueda). **Para retornos diarios hay que usar `adjclose`**, que es el unico que corrige splits *y* dividendos.
- **Horario: NO trae `adjclose`.** Solo el quote crudo. Chequee el split 10:1 de NVDA del 10/06/2024 y **los precios horarios si vienen ajustados por split** (NVDA cotiza ~120 en 06/06/2024, ya post-split, sin salto artificial). Pero **no hay ajuste por dividendo**: en los que pagan (KO, JNJ, XOM, IBM, MCD, WMT, V, HPQ, PG-likes) va a aparecer un hueco chico a la baja cada ex-date. Para estrategias intradiarias es despreciable; para acumular retorno horario a lo largo de meses, no.
- `events` viene vacio en ambas: Yahoo no devolvio el detalle de splits/dividendos. Si hace falta la fecha exacta de cada ex-date hay que pedirla aparte con `&events=div%2Csplit`.
