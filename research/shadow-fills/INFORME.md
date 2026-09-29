# Libro sombra vs. fills reales del CEDEAR — validación con costos Cocos

Fecha: 29/09/2026. Datos: `paper_iol_trades` (modo `shadow`, `closed`) y `cedear_fv_log` (libro del CEDEAR por minuto). Solo SELECT.
Período: 04/09 a 29/09/2026 (17 ruedas con operaciones, 48 tickers).

## TL;DR

- **El edge del libro sombra no sobrevive.** La simulación original da +5,40 M ARS (+1,08% medio por operación, 68% de aciertos). Si se re-ejecuta contra el libro real del CEDEAR, queda en **−1,74 M ARS (−0,98% por operación, 44% de aciertos)** con criterio estricto y −1,68 M con el laxo.
- Aun en la versión más generosa posible (a todo lo que no se puede verificar le regalo el P&L del sim) da **−0,45 M ARS (−0,29% por operación)**.
- **El problema principal no es la liquidez del CEDEAR: es un bug de la simulación en dólares.** El fill sombra se da si el **mínimo de la rueda** (Yahoo 5m, `range=1d`) es ≤ límite, y ese mínimo incluye lo que operó el papel **antes de que existiera la orden**. En 98 de 247 posiciones verificables el subyacente **nunca bajó al límite con la orden viva** (en 48, ni a 1% del límite). Esas 98 explican +4,93 M del P&L simulado; las otras 149 suman −0,28 M.
- El 88% de la diferencia entre sim y realidad viene de entradas que no existieron; el 12% de peores salidas.
- Con 5 semanas de un solo régimen, ni el sim original era estadísticamente significativo por semana (t = 2,13 con 4 grados de libertad; hace falta 2,78 al 5%). La versión validada tampoco es significativamente negativa (t = −2,01). Lo que sí se puede afirmar: **no hay evidencia de edge**, y el número que se venía mirando estaba inflado por construcción.

## 1. Universo

| | |
|---|---|
| Filas cerradas del shadow | 418 |
| Hijas `tp_parcial` con padre todavía abierto (excluidas: la posición no cerró) | 20 |
| Posiciones cerradas (padre + hijas) | **287** (176 sin TP parcial, 111 con) — 398 patas |
| Posiciones sin ningún dato del CEDEAR en su ventana | **40** (13 tickers: GGAL nunca se loguea; ADI, JNJ, XOM, QCOM, ARM, LAR, HPQ, COIN, RGTI, GPRK, ADBE, AMD en huecos) |
| Posiciones con log | 247 (54 con cobertura < 80% de los minutos en que el logger corría) |

Detalle: las hijas `tp_parcial` no tienen `pnl_ars_alt` grabado (el worker no lo escribe al insertarlas). Lo recalculé con la misma fórmula del worker. Cualquier tablero que sume `pnl_ars_alt` de la tabla subestima el sim en ~1,84 M.

## 2. Método (lo más simple y conservador que pude justificar)

**Entrada.** Orden límite de compra en pesos a `L = px_ars_entrada` (lo mismo que asentó el sim). Ventana: desde `created_at` del padre hasta el último `exit_ts` de la posición.
- Estricto: existe si hubo algún snapshot con `0 < c_ask ≤ L`.
- Laxo: existe si hubo algún snapshot con `c_last ≤ L` **y** `c_vol` subió contra el snapshot anterior del mismo día (hubo operación). Sin el chequeo de volumen, el `c_last` de la apertura es el cierre de ayer y da fills falsos.
- Precio de entrada = L siempre (nunca mejor que el límite, aunque el ask estuviera abajo).
- Con `px_ars_orden` como límite (el precio realmente mandado) da 136 fills en vez de 135: indistinto.

**Salida (por pata, siempre después de la entrada real `te`).**
- Stop / trailing / TP parcial: el disparo lo decide el subyacente, y el sim ya lo midió (con confirmación de 10 min). Se vende a mercado: `c_bid` del primer snapshot ≥ max(`exit_ts` del sim, `te`). No re-simulé el trailing.
- Target: venta límite apoyada en `T = target_usd × ratio de entrada` (así se espeja en Cocos: la venta se deja puesta con la entrada). Se ejecuta en el primer snapshot ≥ `te` con `c_bid ≥ T` (estricto) o `c_last ≥ T` con volumen (laxo), **a precio T**. Si antes el subyacente toca el stop final (u_bid, o u_last si no hay bid) después de max(`te`, `exit_ts` del sim), sale a `c_bid` de ese minuto. Si no pasa nada, se marca al último `c_bid` (no hubo ningún caso).
- Costo Cocos: 0,0605% por punta sobre el notional de cada punta (0,121% ida y vuelta), igual que `FEE_COCOS` del worker. El spread se paga implícitamente en las salidas a `c_bid`.

**No verificables (59 = 40 sin log + 19 con cobertura baja y sin fill encontrado).** Cota con los mínimos diarios de BYMA (Cocos, `get_price_history`): si ningún día entre la creación y el cierre el mínimo del CEDEAR llegó a L, la compra es imposible. Resultado: 6 imposibles, 53 posibles. En la "cota optimista" a las 53 posibles les regalo el P&L del sim.

## 3. Resultados

Retorno = P&L / notional de entrada (qty total × L). t por semana = media de las medias semanales / (desvío / √semanas); semanas ISO 36 a 40 (la 36 y la 40 son parciales).

| Versión | Ops | Media | Mediana | Desvío | t por op | t por semana (5 sem) | Win rate | P&L total |
|---|---|---|---|---|---|---|---|---|
| Sim original, todas | 287 | +1,08% | +1,50% | 3,69% | 4,95 | 2,13 | 68% | +5.401.104 |
| Sim original, solo con log | 247 | +1,11% | +1,52% | 3,85% | 4,53 | 1,92 | 66% | +4.650.872 |
| **Validado estricto** | **135** | **−0,98%** | **−1,12%** | 3,52% | −3,24 | −2,01 | 44% | **−1.739.691** |
| Validado laxo | 142 | −0,92% | −0,65% | 3,42% | −3,22 | −2,01 | 46% | −1.680.372 |
| Estricto + cota optimista | 188 | −0,29% | +0,46% | 3,56% | −1,13 | −1,11 | 54% | −448.522 |

Medias semanales (estricto): +0,28% (sem 36, n=3) · −3,11% (37, n=19) · 0,00% (38, n=75) · −1,53% (39, n=31) · −3,81% (40, n=7). El sim original: +1,29 · −0,03 · +1,51 · +0,95 · −0,12.

El t por operación exagera: las operaciones del mismo día y del mismo sector se mueven juntas. El número honesto es el semanal, y con 5 semanas no alcanza para nada en ninguna dirección.

### Cortes (estricto)

| Corte | Ops | Media | Win | P&L | (sim original, mismas categorías) |
|---|---|---|---|---|---|
| Intradía | 22 | −0,54% | 59% | −316.281 | 99 ops, +1,96%, 90% win |
| Overnight | 113 | −1,07% | 41% | −1.423.410 | 188 ops, +0,61%, 56% win |
| Padre = target | 60 | +1,99% | 95% | +1.784.018 | 193 ops, +3,09%, 99% win |
| Padre = stop | 72 | −3,47% | 3% | −3.483.868 | 86 ops, −3,35% |
| Padre = trailing | 3 | −0,65% | 0% | −39.841 | 8 ops, +0,16% |
| Con TP parcial | 49 | +0,90% | 67% | +580.757 | 111 ops, +2,64% |
| Sin TP parcial | 86 | −2,06% | 30% | −2.320.448 | 176 ops, +0,09% |

Lo que cambia no es cuánto gana un target o cuánto pierde un stop (eso se parece al sim). Cambia **la mezcla**: de 193 targets quedan 60, de 86 stops quedan 72. Los stops casi todos existieron; los ganadores, en su mayoría no. El intradía, que era la joya del sim (90% de aciertos), casi desaparece: de 99 quedan 22.

## 4. De dónde sale la diferencia

Sobre las 247 posiciones con log: sim +4,65 M → validado estricto −1,74 M. Diferencia 6,39 M.

| Componente | P&L | % de la diferencia |
|---|---|---|
| A. Entradas que no existieron (112 posiciones; 103 de ellas ganadoras en el sim, retorno medio sim +3,14%) | 5,64 M | **88%** |
| B. Peores salidas en las 135 que sí existieron | 0,75 M | 12% |
| — targets a T fijo en pesos vs. teórico del sim (gap y CCL a favor que el sim cobraba) | 0,62 M | |
| — TP parcial al bid real | 0,19 M | |
| — 2 targets que el CEDEAR nunca pagó y terminaron en stop | 0,13 M | |
| — stops al bid del log (salieron algo MEJOR que en el sim) | −0,19 M | |

Selección adversa en estado puro: las 135 posiciones que sí se hubieran llenado ya perdían **en el propio sim** (−0,57% medio). Las 112 que no se llenaban ganaban +3,14%. El CEDEAR llega a tu límite cuando el papel sigue cayendo; cuando toca y rebota, no te llena.

### Por qué: el sim llena órdenes con precios de antes de que existieran

`worker-deploy.js` (~línea 2150): `bajo = p <= lim ? p : await minRueda(symU)` y `minRueda` baja `interval=5m&range=1d` de Yahoo y toma el mínimo de **toda la rueda**. Si el papel perforó el nivel a las 11:00 y la orden se crea a las 14:00 con el papel 1% arriba, el sim la llena igual a las 14:02:30 (los 150 s de confirmación), al precio límite. Es un fill con información del pasado.

Evidencia (log por minuto del subyacente, `subyacente.sql`):

| | Ops | El subyacente nunca bajó al límite con la orden viva | (por más de 0,25%) | (por más de 1%) | P&L sim de esas |
|---|---|---|---|---|---|
| Padre = target | 162 | 90 | 80 | 43 | +5,09 M |
| Padre = stop | 77 | 4 | 2 | 1 | −0,22 M |
| Padre = trailing | 8 | 4 | 4 | 4 | +0,06 M |
| **Total** | **247** | **98** | 86 | 48 | **+4,93 M** (las otras 149: −0,28 M, −0,27% medio) |

- 218 de 247 fills del sim ocurren a menos de 6 minutos de creada la orden.
- En el instante del fill del sim (172 casos con cotización): el subyacente estaba en mediana **+0,79% arriba** del precio de entrada (p25 +0,30%, p75 +1,78%). El ask del CEDEAR, +0,90% arriba de L (arriba de L en el 97% de los casos). El ratio pesos/USD del sim está bien (desvío mediano −0,02% contra el del libro) y el medio spread del CEDEAR es 0,08%. O sea: **no es el CCL ni el spread; es que el papel no estaba ahí.**
- Caso típico: AMD 04/09 cierra por target a las 14:41, a las 14:47 se re-crea la orden en el mismo nivel (463,88) y a las 14:51 "se llena" otra vez porque el mínimo de la rueda ya estaba debajo del nivel. Las re-entradas en el mismo nivel después de una salida son fills gratis.

Esto es independiente de la liquidez del CEDEAR. El caso SPCX (el subyacente cruzó y el CEDEAR no operó) existe, pero es el efecto chico: incluso operando el subyacente directo en Nueva York, el 40% de las entradas del sim eran imposibles. El libro real en IOL no sufre este bug desde el 14/09 (espera la confirmación de IOL), pero el libro sombra —el número con el que se decide si la estrategia sirve— sí.

## 5. Capital y frecuencia

| | Sim original | Validado estricto | Laxo |
|---|---|---|---|
| Posiciones | 287 | 135 | 142 |
| Por rueda (17 ruedas) | 16,9 | 7,9 | 8,4 |
| Notional medio por posición | 1,74 M | 1,69 M | 1,71 M |
| Máximo notional simultáneo | 72,6 M (14/09) | **46,6 M (15/09)** | 47,7 M |
| Duración mediana | 23,6 h | 45,0 h | 44,2 h |

La versión real tiene menos operaciones pero las tiene abiertas el doble de tiempo (las que existen son las que se van a stop, que tardan más). El pico de 46,6 M es con el tamaño de posición que usa el sombra (~1,7 M ARS por operación); escala lineal con ese tamaño.

## 6. Limitaciones (qué no se pudo medir bien)

- **Muestreo por minuto.** El log guarda una foto del book por minuto. Un toque de L que dure segundos entre dos fotos no se ve, así que el estricto **subestima** fills. El laxo lo compensa en parte y la cota con mínimos diarios lo acota para los no verificables. Aun regalando todo, el resultado es negativo.
- **Huecos del log.** Hasta el 18/09 el logger arranca a las 14:00 UTC y BYMA abre 13:30: faltan los primeros 30 minutos. Algunos símbolos tienen huecos (AMD el 04/09 de 14:28 a 14:42). GGAL no se loguea nunca.
- **Cola y profundidad.** Asumí que te llenan cuando el precio toca, sin prioridad de cola, y que el bid absorbe toda la cantidad en los stops (notional mediano 1,7 M ARS). Las dos cosas son optimistas.
- **Target a T exacto.** Si el CEDEAR abre con gap arriba de T, una venta apoyada se ejecuta en la apertura, a veces arriba de T. Tomé T (conservador). Explica parte de los 0,62 M del punto B, no del A.
- **Trailing no re-simulado.** Uso el momento de salida que decidió el sim con el subyacente. Si la entrada real fue más tarde, el trailing real sería distinto.
- **Muestra.** 5 semanas calendario (dos parciales) de septiembre de 2026, un solo régimen. 135 operaciones que no son independientes.

## 7. Veredicto

1. Con fills reales y costos de Cocos, **el edge no sobrevive**: estricto −0,98% por operación, laxo −0,92%, y la cota más generosa −0,29%. En ninguna versión la media es positiva.
2. Casi toda la ganancia del libro sombra (88% de la brecha) venía de entradas que no podían existir. La causa principal es un bug de la simulación, no la plaza local: el fill usa el mínimo de toda la rueda, incluido lo que operó antes de crear la orden.
3. La selección adversa es brutal: los trades que realmente se llenan son los que siguen cayendo. Por eso el win rate baja de 68% a 44% y el perfil pasa a "muchos stops enteros, pocos targets".
4. Confianza: alta en que **el sim original sobreestima**, porque es un mecanismo, no ruido: 98 fills con el subyacente nunca en el nivel. Baja en el número exacto del resultado real: 5 semanas y un régimen no permiten decir si es −1% o 0%. Estadísticamente no hay evidencia ni de edge positivo ni de edge negativo significativo (t semanal −2,01 con 4 grados de libertad).
5. Antes de seguir midiendo, hay que arreglar el sombra, si no cada semana suma más ruido sesgado: (a) `minRueda` tiene que mirar solo barras posteriores a `created_at`; (b) el fill sombra tiene que exigir `ask del CEDEAR ≤ L` (data912 ya trae `arsAsk`); (c) el target valuado a T fijo en pesos y solo si el bid lo paga; (d) grabar `pnl_ars_alt` en las hijas `tp_parcial`. Recién con eso vale la pena acumular muestra, y harían falta del orden de meses, no semanas.

## Archivos

- `validar.sql` — re-ejecución estricta/laxa (entrada y salidas por pata). `sim.sql` — lo que asumió el sim. `subyacente.sql` — ¿el subyacente tocó el límite con la orden viva?
- `analizar.mjs` — estadísticas, cortes, descomposición, capital. `node analizar.mjs` regenera `data/resultados.json`, `data/posiciones.csv` (una fila por posición, para auditar) y `data/run.log`.
- `data/extraer.mjs` — pasa los volcados del MCP (`*_raw.txt`) a CSV. `data/minimos_diarios_bcba.txt` — mínimos diarios de BYMA (Cocos) para la cota.
