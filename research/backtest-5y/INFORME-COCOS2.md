# Informe COCOS2 · targets cortos, promediar hacia abajo y escalonado en recuperación

Corrido el 29/09/2026. Scripts `cocos2-lib.js` (motor), `cocos2-run.js` (variantes,
walk-forward, DSR, control de azar), `cocos2-diag.js` y `cocos2-diag2.js`
(diagnósticos). Salidas: `cocos2-results.json`, `cocos2-run.log`,
`cocos2-diag.log`, `cocos2-diag2.log`. Todo local sobre `data/` y el cache
`signals.json`. No se tocó el VPS, Supabase ni ningún archivo previo del backtest.

**La primera línea: ningún target corto le gana a la resistencia. Los tapes de
+1%, +1,5% y +2% son las tres peores variantes del estudio (−0,67%, −0,54% y
−0,45% mensual out-of-sample), y la razón es aritmética: con el stop a 1,5×ATR
el bot arriesga 5-6% por operación, así que un target de 1-2% necesita acertar
más del 85% de las veces y acierta 66-78%. La única cosa que da positivo en las
dos ventanas es promediar hacia abajo con salida en la resistencia (C1: +0,66%
in-sample, +0,35% out-of-sample), pero el control con fechas barajadas da lo
mismo o más (+0,43% y +0,71%): promediar gana por la mecánica —stop más ancho,
promedio más bajo, más tiempo comprado en pesos— y no porque los soportes del
motor sean especiales. El 86% del resultado out-of-sample de C1 es un solo mes.
El escalonado en recuperación (D) no agrega nada.**

---

## 0. Qué se corrió, y qué reproduce

**Señales.** El cache `signals.json` (333.935 señales crudas, universo ampliado
del 24/09), filtrado a los **38 limpios** de `INVENTARIO.md` §5 (44.382 señales
crudas). Gate textual del worker (`gatePasa` de `engine.js`): score ≥ 7,
R:R ≥ 2 **medido con el stop técnico original**, sin contra-tendencia, régimen
risk_on o mixto con score ≥ 8 y R:R ≥ 2,5 a mitad de tamaño.

**Chequeo de consistencia:** el gate deja **528 órdenes en el IS y 371 en el
OOS**, exactamente las que reportó `atr.js` (`INFORME-ATR.md`) con el mismo
gate y universo. Las ventanas son las de siempre: IS 2023-10-19 → 2025-06-30
(20,4 meses), OOS 2025-07-01 → 2026-09-17 (14,6 meses).

**Rails (iguales para las 13 variantes).** Capital $20.000.000, tope $2.000.000
por papel (mixto: $1.000.000), una posición por papel, 6 entradas por día,
orden límite que vive 48 h, swing permitido. No hay tope de posiciones: el
límite es la caja (10 slots de 2M). El tope de 2M manda: el sizing por riesgo
(1,5% × 20M / distancia al stop) daría un tamaño **mayor** al tope en el
89-95% de los trades, así que el tope es lo que decide (se registra como
diagnóstico, no se usa). En C y D se reservan los 2M del slot desde que se
coloca la orden aunque se inviertan de a 500k: así la competencia por caja es
la misma en todas las variantes y la comparación aísla la regla de salida.

**Costos Cocos.** 0,0605% por punta (derechos BYMA + IVA); 0,053% por punta en
las dos patas cuando compra y venta caen el mismo día. Entradas y targets son
límites que descansan: no pagan spread. Stops, trailing, cierre de ventana y
las compras a mercado de la variante D cruzan el book: pagan 0,10% (sensibilidad
a 0,20% en la última columna de cada tabla).

**Stop.** 1,5 × ATR(14) diario desde la entrada. El ATR es el **promedio simple
de los últimos 14 true ranges sobre ruedas cerradas** con fecha anterior al
día, copia de `atr14()` del worker (parche del 29/09), no el Wilder de `atr.js`.
El stop inicial usa el ATR del día de la señal. Trailing: al cierre de cada
barra horaria, `stop = max(stop, cierre − 1,5 × ATR del día)`, nunca baja
(el bot lo hace cada 60 s con el menor de dos lecturas; el cierre horario es la
aproximación pesimista). Se dejó también la regla +2R del worker de IOL, pero
con R = 1,5 ATR nunca muerde: el trailing por ATR siempre está más arriba. El
`cocos-bot` no la tiene, así que da igual.

**Ejecución.** Copia de `simulate.js`: la señal de la barra *i* recién puede
llenarse en la *i+1*; fill al límite cuando la barra toca el nivel; la barra
del fill no se juzga; stop primero (pesimista) **con el fix del gap** (si la
barra abre debajo del stop, llena a la apertura); después las ventas límite de
la más baja a la más alta; después el trailing. Equity diaria con marca al
cierre. CCL por día de rueda (`conv = 1`, cantidad fraccionaria).

**Métricas.** Retorno por operación = P&L neto / nocional invertido (en C y D
el invertido es lo que se llenó, no el slot). Mensual = P&L total / 20M / meses.
*t* por operación sobre los retornos por trade; *t* por mes sobre la serie de
P&L por mes calendario sobre los 20M (los meses sin trades cuentan como 0).
DSR de Bailey-López de Prado sobre retornos diarios de la equity, con N = 13
configuraciones miradas. Control de azar con semilla 20260929, 200 sorteos.

---

## 1. La geometría que explica casi todo

| | IS | OOS |
|---|---:|---:|
| ATR% sobre la entrada (mediana) | 3,39% | 3,98% |
| **stop 1,5×ATR (mediana)** | **5,08%** | **5,97%** |
| stop TÉCNICO del motor (mediana) | 2,05% | 2,07% |
| resistencia sobre la entrada (mediana / p25) | 5,85% / 4,37% | 5,58% / 4,46% |
| spot arriba de la entrada en la señal | 3,11% | 3,07% |
| órdenes con resistencia < +3% | 3,0% | 0,8% |
| órdenes con resistencia < +1,5% | 0,0% | 0,0% |

El gate exige R:R ≥ 2 con el stop técnico (2% abajo). El stop que se ejecuta
está a 5-6%. **La resistencia está a 5,6-5,9%.** O sea que en la ejecución
real el R:R es 1:1, no 2:1: se arriesga lo mismo que se busca. Todo lo que
sigue es consecuencia de eso. Y los tapes de +1%, +1,5% y +2% muerden en el
100% de las órdenes (ninguna resistencia está tan cerca): "target a +X%" es
literalmente un target fijo a +X%.

---

## 2. Resultados · in-sample (20,4 meses · 528 órdenes)

| variante | n | ret medio/op | mediana | win | mensual (20M) | maxDD | t/op | t/mes | papel | CCL | costo | horas med | lotes | mensual c/spread 0,20% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A  res + parcial 50% | 108 | 0,19% | −0,16% | 49,1% | 0,19% | 9,0% | 0,26 | 0,33 | −0,53% | 1,02% | 0,120% | 120 | 1,00 | 0,17% |
| B  todo +1,0% | 117 | −0,50% | 0,89% | 70,1% | −0,27% | 7,5% | −1,11 | −1,12 | −0,84% | 0,48% | 0,114% | 19 | 1,00 | −0,28% |
| B  todo +1,5% | 115 | −0,06% | 1,39% | 66,1% | −0,02% | 6,8% | −0,11 | −0,06 | −0,76% | 0,84% | 0,117% | 24 | 1,00 | −0,03% |
| B  todo +2,0% | 113 | −0,05% | 1,52% | 64,6% | −0,02% | 7,3% | −0,09 | −0,05 | −0,77% | 0,85% | 0,118% | 48 | 1,00 | −0,04% |
| B  todo +3,0% | 111 | 0,48% | 1,82% | 59,5% | 0,26% | 6,6% | 0,80 | 0,48 | −0,39% | 1,00% | 0,119% | 72 | 1,00 | 0,24% |
| B  todo mitad de camino | 109 | 0,45% | 1,49% | 61,5% | 0,32% | 8,2% | 0,67 | 0,58 | −0,33% | 1,06% | 0,119% | 68 | 1,00 | 0,31% |
| B  mitad +1,5% / resto res | 108 | 0,02% | −0,24% | 47,2% | 0,07% | 8,5% | 0,03 | 0,13 | −0,64% | 0,88% | 0,119% | 120 | 1,00 | 0,04% |
| B  todo en la res (sin parcial) | 108 | 0,04% | −1,63% | 46,3% | 0,11% | 10,2% | 0,04 | 0,18 | −0,68% | 1,02% | 0,120% | 120 | 1,00 | 0,08% |
| C1 prom → res | 95 | 4,03% | 3,39% | 69,5% | 0,66% | 8,0% | 3,31 | 1,17 | 1,24% | 1,77% | 0,123% | 263 | 2,00 | 0,65% |
| C2 prom → +1,5% del prom | 114 | 0,96% | 1,39% | 83,3% | 0,01% | 6,7% | 2,08 | 0,03 | −0,00% | 0,17% | 0,118% | 27 | 1,58 | 0,01% |
| C3 prom → escalonado | 104 | 0,56% | 1,03% | 62,5% | −0,11% | 6,7% | 0,98 | −0,40 | −0,77% | 0,29% | 0,119% | 144 | 1,51 | −0,12% |
| D1 recup → res | 107 | −0,26% | −0,65% | 46,7% | 0,25% | 3,7% | −0,32 | 0,71 | −0,32% | 1,35% | 0,121% | 120 | 2,10 | 0,22% |
| D2 recup → +1,5% del prom | 115 | −0,32% | 1,39% | 67,0% | −0,02% | 3,3% | −0,64 | −0,16 | −0,74% | 0,76% | 0,118% | 24 | 1,47 | −0,03% |

## 3. Resultados · out-of-sample (14,6 meses · 371 órdenes) — mirado una vez

| variante | n | ret medio/op | mediana | win | mensual (20M) | maxDD | t/op | t/mes | papel | CCL | costo | horas med | lotes | mensual c/spread 0,20% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A  res + parcial 50% | 83 | −0,96% | 0,86% | 53,0% | −0,49% | 12,8% | −1,44 | −1,18 | −0,93% | 0,18% | 0,119% | 93 | 1,00 | −0,52% |
| B  todo +1,0% | 96 | −1,01% | 0,89% | 67,7% | −0,67% | 10,6% | −2,49 | −2,78 | −0,87% | −0,04% | 0,114% | 20 | 1,00 | −0,68% |
| B  todo +1,5% | 94 | −0,82% | 1,29% | 66,0% | −0,54% | 9,3% | −1,84 | −2,06 | −0,83% | 0,11% | 0,116% | 24 | 1,00 | −0,55% |
| B  todo +2,0% | 91 | −0,71% | 1,71% | 64,8% | −0,45% | 9,0% | −1,44 | −1,45 | −0,74% | 0,13% | 0,117% | 24 | 1,00 | −0,47% |
| B  todo +3,0% | 90 | −0,39% | 2,57% | 63,3% | −0,19% | 7,9% | −0,67 | −0,52 | −0,40% | 0,21% | 0,119% | 46 | 1,00 | −0,21% |
| B  todo mitad de camino | 90 | −0,83% | 1,85% | 61,1% | −0,46% | 11,2% | −1,37 | −1,15 | −0,80% | 0,18% | 0,118% | 29 | 1,00 | −0,48% |
| B  mitad +1,5% / resto res | 83 | −0,90% | 0,41% | 51,8% | −0,49% | 11,3% | −1,58 | −1,41 | −0,88% | 0,14% | 0,118% | 93 | 1,00 | −0,51% |
| B  todo en la res (sin parcial) | 83 | −0,89% | 1,06% | 50,6% | −0,45% | 13,5% | −1,16 | −0,98 | −0,87% | 0,20% | 0,120% | 93 | 1,00 | −0,48% |
| C1 prom → res | 74 | 2,52% | 3,96% | 71,6% | 0,35% | 8,7% | 2,64 | 0,57 | 0,56% | 1,10% | 0,122% | 155 | 1,82 | 0,34% |
| C2 prom → +1,5% del prom | 94 | 1,18% | 1,39% | 89,4% | 0,18% | 2,4% | 4,05 | 0,93 | 0,50% | 0,36% | 0,119% | 24 | 1,48 | 0,17% |
| C3 prom → escalonado | 79 | 0,55% | 2,05% | 59,5% | 0,01% | 3,0% | 1,17 | 0,07 | −0,19% | 0,38% | 0,119% | 144 | 1,43 | 0,01% |
| D1 recup → res | 83 | −0,99% | 1,20% | 51,8% | −0,00% | 4,7% | −1,32 | −0,00 | −0,45% | 0,57% | 0,120% | 93 | 1,82 | −0,02% |
| D2 recup → +1,5% del prom | 94 | −0,77% | 1,36% | 67,0% | −0,09% | 2,5% | −1,72 | −0,76 | −0,71% | 0,43% | 0,117% | 24 | 1,45 | −0,10% |

**Exposición.** Con 2M por papel y ~6 fills por semana, la cartera tiene en
promedio entre el 3% y el 14% de los 20M invertidos (A: 9% IS, 6% OOS). Por
eso el "mensual sobre 20M" es chico aunque el retorno por operación no lo sea:
el capital está casi todo quieto. El retorno por operación es la lectura más
limpia de cada regla; el mensual es lo que LP vería en la cuenta.

**Caminos de salida (última pata):**

| variante | IS | OOS |
|---|---|---|
| A  res + parcial 50% | res 44% · trailing 38% · stop 18% | res 49% · trailing 33% · stop 18% |
| B  todo +1,0% | target 79% · stop 15% · trailing 5% | target 78% · stop 16% · trailing 6% |
| B  todo +1,5% | target 74% · stop 17% · trailing 9% | target 73% · stop 17% · trailing 10% |
| B  todo +3,0% | target 59% · trailing 23% · stop 17% | target 67% · trailing 17% · stop 17% |
| B  todo mitad de camino | target 64% · trailing 18% · stop 17% | target 66% · stop 18% · trailing 17% |
| C1 prom → res | res 61% · trailing 25% · stop 13% | res 59% · trailing 28% · stop 8% · fin 4% |
| C2 prom → +1,5% del prom | target 96% · stop 3% | target 95% · stop 3% · trailing 2% |
| C3 prom → escalonado | res 48% · trailing 40% · stop 11% | res 56% · trailing 30% · stop 14% |
| D1 recup → res | res 46% · trailing 36% · stop 17% | res 49% · trailing 33% · stop 18% |
| D2 recup → +1,5% del prom | target 74% · stop 17% · trailing 8% | target 73% · stop 16% · trailing 11% |

---

## 4. Tabla comparativa · ordenada por retorno mensual OOS

| # | variante | n IS | mensual IS | t/mes IS | n OOS | mensual OOS | t/mes OOS | t/op OOS | DD OOS | OOS c/spread 0,20% |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | C1 prom → res | 95 | 0,66% | 1,17 | 74 | 0,35% | 0,57 | 2,64 | 8,7% | 0,34% |
| 2 | C2 prom → +1,5% del prom | 114 | 0,01% | 0,03 | 94 | 0,18% | 0,93 | 4,05 | 2,4% | 0,17% |
| 3 | C3 prom → escalonado | 104 | −0,11% | −0,40 | 79 | 0,01% | 0,07 | 1,17 | 3,0% | 0,01% |
| 4 | D1 recup → res | 107 | 0,25% | 0,71 | 83 | −0,00% | −0,00 | −1,32 | 4,7% | −0,02% |
| 5 | D2 recup → +1,5% del prom | 115 | −0,02% | −0,16 | 94 | −0,09% | −0,76 | −1,72 | 2,5% | −0,10% |
| 6 | B  todo +3,0% | 111 | 0,26% | 0,48 | 90 | −0,19% | −0,52 | −0,67 | 7,9% | −0,21% |
| 7 | B  todo +2,0% | 113 | −0,02% | −0,05 | 91 | −0,45% | −1,45 | −1,44 | 9,0% | −0,47% |
| 8 | B  todo en la res (sin parcial) | 108 | 0,11% | 0,18 | 83 | −0,45% | −0,98 | −1,16 | 13,5% | −0,48% |
| 9 | B  todo mitad de camino | 109 | 0,32% | 0,58 | 90 | −0,46% | −1,15 | −1,37 | 11,2% | −0,48% |
| 10 | B  mitad +1,5% / resto res | 108 | 0,07% | 0,13 | 83 | −0,49% | −1,41 | −1,58 | 11,3% | −0,51% |
| 11 | A  res + parcial 50% (el bot hoy) | 108 | 0,19% | 0,33 | 83 | −0,49% | −1,18 | −1,44 | 12,8% | −0,52% |
| 12 | B  todo +1,5% | 115 | −0,02% | −0,06 | 94 | −0,54% | −2,06 | −1,84 | 9,3% | −0,55% |
| 13 | B  todo +1,0% | 117 | −0,27% | −1,12 | 96 | −0,67% | −2,78 | −2,49 | 10,6% | −0,68% |

Ningún *t* por mes llega a 2 en el OOS salvo los negativos (+1,0% y +1,5%,
que pierden con *t* de −2,8 y −2,1). El spread de 0,20% en vez de 0,10% mueve
0,01-0,03 pp: no cambia ningún orden.

**DSR** (N = 13 configuraciones, sigma del SR diario entre variantes):

| | Sharpe | DSR |
|---|---:|---:|
| mejor del IS (C1) evaluada en el IS | 0,98 | 0,586 |
| mejor del IS (C1) evaluada en el OOS | 0,55 | 0,132 |
| A (el bot hoy) en el OOS | −1,17 | 0,001 |

C1 es la mejor en las dos ventanas, pero con 13 candidatas miradas la
probabilidad de que su Sharpe OOS sea distinto de cero es 13%.

---

## 5. Por qué dio lo que dio, variante por variante

**A · resistencia con parcial del 50% (lo que corre hoy en el cocos-bot).**
+0,19% IS, −0,49% OOS. Del lado del papel pierde en las dos ventanas (−0,53% y
−0,93% del nocional); lo que la deja positiva en el IS es el CCL (+1,02%: 120
horas de tenencia mediana en 2023-2025 era cobrar devaluación). El camino de
salida lo dice todo: llega a la resistencia el 44-49% de las veces a +4,9% /
+3,6%, pero el **trailing por ATR saca el 33-38% de los trades en pérdida**
(−2,2% IS, −4,2% OOS): cada rebote sube el stop a "cierre − 1,5 ATR" y el
retroceso siguiente lo toca antes de que el papel llegue a la resistencia. El
stop duro (18%) cuesta −6,4% / −7,5% por vez, más que el target promedio. Con
un target a 5,6% y un stop a 6%, 49-53% de aciertos no alcanza.

**B · targets cortos (+1%, +1,5%, +2%).** Las tres peores. La aritmética de
`cocos2-diag.log` §5: +1% acierta 78-79% de las veces y cobra +0,7 / +1,1% neto,
pero el 15-16% que va al stop pierde −7,2 / −7,6%. 0,79 × 1,1 − 0,15 × 7,6 −
0,05 × 4 < 0. Para empatar con un stop de 7,2-7,6% hay que acertar el 87-91%
con el target de 1%, el 79-84% con 1,5% y el 75-80% con 2% (IS-OOS, sin contar
las salidas por trailing, que empeoran la cuenta). Ninguno llega. Acortar el
target no reduce el riesgo, sólo recorta la ganancia de los trades buenos; el
stop es el mismo. Por eso la mediana es positiva (+0,9 / +1,4%) y la media
negativa: muchas ganancias chicas, pocas pérdidas grandes. **Es la firma del
"recoger monedas delante de la aplanadora".**

**B · +3% y mitad de camino.** Las menos malas de las de un lote. +3% da +0,26%
IS y −0,19% OOS; mitad de camino +0,32% y −0,46%. Están más cerca de la
resistencia (5,6-5,9%), así que conservan parte de la cola derecha, y el
tiempo de tenencia baja (46-72 h) recortando el trailing. En el IS +3% supera a
A por 0,07 pp y en el OOS por 0,30 pp, con menos drawdown (7,9% vs 12,8%). Pero
*t* por mes de 0,48 y −0,52: no es distinguible de cero, y sigue perdiendo en
el OOS.

**B · mitad a +1,5% / resto en la resistencia, y todo en la resistencia sin
parcial.** Idénticas a A dentro del ruido (+0,07 / −0,49 y +0,11 / −0,45). El
parcial no compra ni vende nada: `INFORME-PARCIAL.md` ya lo había medido con la
entrada a mercado, y con el stop ATR sigue siendo así. El parámetro
`COCOS_BOT_TP_PARCIAL` da igual.

**C1 · promediar hacia abajo, salida en la resistencia.** La única positiva en
las dos ventanas (+0,66% / +0,35%) y con *t* por operación de 3,3 y 2,6. Por
qué: la pareada con "todo en la resistencia" sobre las **mismas señales** lo
muestra crudo. En las 50 (IS) y 30 (OOS) señales donde C1 llegó a promediar,
la variante de un lote salió por stop el **86-93%** de las veces y perdió
−3,4% / −7,0%; C1 en esas mismas señales ganó +4,8% / +1,6%. Tres cosas hacen
eso, y ninguna es "el soporte": (a) el stop está 1 ATR más lejos por cada
tramo (con 2 tramos, a −2,5 ATR del primer nivel), (b) el promedio baja, así
que la misma resistencia rinde el doble sobre el invertido, y (c) la tenencia
se duplica (263 h vs 120 h) y el CCL aporta +1,77% / +1,10% del nocional. Pero
la cola está ahí: los trades que llenaron los **4 tramos** —los que siguieron
cayendo— rinden **−5,1% / −5,6% sobre 2M con 24-40% de aciertos** (IS: 17
trades, −1,75M; OOS: 10, −1,12M). En el IS el mejor mes es el 47% del total; en
el OOS **el mejor mes (agosto 2026) es el 86% del total** y 9 de 15 meses son
positivos. La diferencia pareada C1 − B por señal tiene *t* de 1,3 / 1,5. Ver
el control en §6: promediar en fechas barajadas rinde igual o más.

**C2 · promediar, todo a +1,5% del promedio.** Un grid de reversión: compra a
−1, −2, −3 ATR y vende cuando el promedio recupera 1,5%. Acierta el 83-89% con
*t* por operación de 2,1 / 4,1, pero **sobre los 20M no hay nada**: +0,01% /
+0,18% mensual. Cada acierto es +1,4-1,6% sobre 500k-1M (7-15k pesos); cada
stop con 4 tramos es −11% / −20% sobre 2M (200-400k). En el IS 3 stops se
comieron 110 aciertos (P&L total +42k: el mejor mes es el 866% del total). La
esperanza es positiva pero microscópica y la varianza de un mes malo no. Y el
control con fechas barajadas está en el percentil 38 / 58: es exactamente lo
que da comprar caídas de 1 ATR en cualquier fecha.

**C3 · promediar, escalonado 1/4 a +1/+2/+3% y resto en la resistencia.**
−0,11% / +0,01%. Combina lo peor de los dos: vende tres cuartos barato (como
B) y se queda con un cuarto para el trailing (que lo saca en −0,5 / −1,3%
el 30-40% de las veces). Peor que el nulo de fechas barajadas en las dos
ventanas (percentil 13 / 20).

**D1 y D2 · escalonado en recuperación.** +0,25% / −0,00% y −0,02% / −0,09%.
Se implementó con los cierres horarios de `data/hourly` (ruptura = cierre
debajo del nivel de entrada; recuperación = cierre arriba; el tramo entra al
cierre que recupera, a mercado, pagando 0,10%; stop a 1,5 ATR bajo el mínimo
de la ruptura). Promedia 1,8-2,1 lotes por trade. El problema es la selección
que hace sola: pone 500k en los trades que **nunca** rompieron (los buenos:
llegan a la resistencia sin sobresalto) y 1,5-2M en los que rompieron. En las
señales donde D agregó tramos, la variante de un lote con 2M desde el arranque
ganó **más** (1,87M vs 1,42M en el IS; 0,95M vs 0,57M en el OOS). D reduce el
drawdown (3,7-4,7% vs 12,8%) porque invierte menos, no porque elija mejor.

**E · control de fechas barajadas.** Ver §6. Resumen: A y B en el OOS están en
el percentil 12-22 del nulo (las fechas del motor son PEORES que fechas al azar
en la ventana reciente); C1 en el percentil 75 (IS) y **16 (OOS)**; C2 en 38 /
58; C3 en 13 / 20.

---

## 6. Control E · mismas señales, fechas barajadas (200 sorteos, semilla 20260929)

Cada señal gateada conserva su papel, su geometría relativa (entrada % debajo
del spot, resistencia % arriba de la entrada, riskMult) y recibe la fecha de
**otra** señal (permutación); el spot pasa a ser el cierre horario de su papel
en la fecha prestada y el ATR el de ese día. Se conserva el calendario (cuándo
hubo muchas señales, cuándo pocas) y se rompe el soporte concreto. Segunda
versión: fechas uniformes al azar, que rompe también el calendario.

| variante | ventana | real | nulo (perm.) media · p5 · p95 | percentil real | p (nulo ≥ real) | nulo uniforme media | percentil real |
|---|---|---:|---|---:|---:|---:|---:|
| A  res + parcial 50% | IS | 0,19% | 0,22% · −0,26% · 0,74% | 47% | 0,535 | 0,05% | 64% |
| A  res + parcial 50% | OOS | −0,49% | −0,01% · −0,60% · 0,71% | **12%** | 0,885 | 0,01% | 13% |
| B  todo +1,5% | IS | −0,02% | −0,03% · −0,37% · 0,36% | 53% | 0,475 | −0,28% | 84% |
| B  todo +1,5% | OOS | −0,54% | −0,28% · −0,76% · 0,23% | 22% | 0,785 | −0,26% | 15% |
| C1 prom → res | IS | 0,66% | 0,43% · −0,13% · 1,05% | 75% | 0,255 | 0,44% | 77% |
| C1 prom → res | OOS | 0,35% | **0,71%** · 0,14% · 1,30% | **16%** | 0,840 | 0,79% | 14% |
| C2 prom → +1,5% | IS | 0,01% | 0,06% · −0,20% · 0,37% | 38% | 0,620 | −0,01% | 53% |
| C2 prom → +1,5% | OOS | 0,18% | 0,12% · −0,21% · 0,41% | 58% | 0,420 | 0,08% | 67% |
| C3 prom → escalonado | IS | −0,11% | 0,08% · −0,20% · 0,37% | 13% | 0,870 | 0,02% | 20% |
| C3 prom → escalonado | OOS | 0,01% | 0,13% · −0,15% · 0,39% | 20% | 0,800 | 0,13% | 25% |
| D2 recup → +1,5% | IS | −0,02% | −0,00% · −0,14% · 0,13% | 47% | 0,535 | −0,08% | 73% |
| D2 recup → +1,5% | OOS | −0,09% | −0,07% · −0,27% · 0,11% | 43% | 0,575 | −0,06% | 38% |

**Lectura.** Promediar hacia abajo en fechas al azar rinde +0,43% (IS) y
**+0,71% (OOS)** mensual; con las fechas reales del motor, +0,66% y +0,35%. En
la ventana reciente el patrón del motor le resta a la mecánica, no le suma.
Lo que gana C1 es comprar caídas de 1 ATR con un stop ancho y quedarse
comprado en pesos, y eso funciona igual en cualquier fecha de 2023-2026 (un
período en que el universo subió y el CCL también).

**Diferencia pareada C − un lote, sorteo por sorteo** (misma permutación para
las dos): ¿promediar le gana a no promediar también sobre fechas al azar?

| par | ventana | real C−A | nulo media · p5 · p95 | percentil real |
|---|---|---:|---|---:|
| C1 − todo en la res | IS | +0,55 | +0,12 · −0,62 · +0,96 | 84% |
| C1 − todo en la res | OOS | +0,80 | **+0,62** · −0,15 · +1,45 | 63% |
| C2 − todo +1,5% | IS | +0,03 | +0,09 · −0,26 · +0,50 | 40% |
| C2 − todo +1,5% | OOS | +0,71 | +0,40 · −0,07 · +0,87 | 83% |
| C3 − A | IS | −0,30 | −0,14 · −0,62 · +0,40 | 33% |
| C3 − A | OOS | +0,51 | +0,14 · −0,51 · +0,73 | 86% |
| D2 − todo +1,5% | IS | −0,00 | +0,02 · −0,25 · +0,27 | 43% |
| D2 − todo +1,5% | OOS | +0,44 | +0,20 · −0,18 · +0,55 | 87% |

Sí: sobre fechas al azar, promediar también le gana a no promediar (+0,62 pp
mensual en el OOS). La ventaja de C1 sobre A es de la mecánica, y la parte
atribuible al patrón (+0,18 pp en el OOS, percentil 63) no se distingue de
cero.

---

## 7. Sensibilidades y diagnósticos (post-hoc: leer como pistas, no como resultados)

**7.1 El trailing por ATR cuesta plata en todas las variantes y en las dos
ventanas.** Apagándolo (queda sólo el stop inicial a 1,5 ATR y la regla +2R):

| variante | IS con trailing → sin | OOS con trailing → sin |
|---|---:|---:|
| A  res + parcial 50% | 0,19% → **0,39%** | −0,49% → **−0,11%** |
| B  todo en la res | 0,11% → 0,35% | −0,45% → +0,04% |
| B  todo +1,5% | −0,02% → −0,06% | −0,54% → −0,44% |
| B  todo +3,0% | 0,26% → 0,36% | −0,19% → −0,06% |
| C1 prom → res | 0,66% → 1,24% | 0,35% → 0,52% |

Sin trailing, los trades van a la resistencia el 52-56% (contra 44-49%) y al
stop el 43-47%: el trailing convierte trades que iban a llegar en salidas a
−2/−4%. Es la observación con más magnitud de todo el anexo (+0,2 a +0,6 pp
mensual, en el mismo sentido en IS y OOS), **pero es post-hoc**: no era una de
las 13 hipótesis y hay que pre-registrarla y correrla con su propio nulo antes
de tocar el bot. La regla de "sólo sube" es correcta contra el ruido de un
papel ilíquido; lo que este número dice es que a 1,5 ATR está demasiado cerca
para un objetivo que está a 1,5-2 ATR.

**7.2 Referencia: el stop TÉCNICO (régimen anterior al 29/09) con los mismos
rails de 20M/2M.** `cocos2-diag2.log`:

| variante | mensual IS | mensual OOS | stop+trailing IS / OOS |
|---|---:|---:|---:|
| A  res + parcial 50% | −0,15% | −0,20% | 73% / 66% |
| B  todo +1,0% | −0,50% | −0,62% | 47% / 43% |
| B  todo +3,0% | −0,31% | −0,08% | 63% / 53% |
| B  todo en la res | −0,19% | −0,12% | 73% / 66% |

Con el stop técnico a 2% todo también pierde, por el otro lado: el stop salta
el 66-73% de las veces. Pasar a 1,5 ATR bajó los stops del 70% al 18% pero
subió el costo de cada uno de −2% a −6/−7,5%. La esperanza no cambió de signo
en el OOS. **No hay un valor del stop que arregle esto, porque el problema es
la relación entre la distancia al stop y la distancia a la resistencia** (§1).

**7.3 Spread 0,20%.** Mueve 0,01-0,03 pp en todas las variantes: irrelevante
frente al tamaño de los stops.

**7.4 Concentración de C1.** IS: AMD +1,0M, MSTR +1,0M, HUT +0,8M contra INTC
−0,9M; 17 de 29 papeles positivos. OOS: MSTR, VST, MU, HUT, COIN +0,26-0,36M
cada uno contra QCOM −0,55M, ADBE −0,55M, ORCL −0,44M; 20 de 28 positivos. Los
ganadores son los papeles de más volatilidad, que es donde 1 ATR de escalón y
1,5 ATR de stop son más pesos.

---

## 8. Lo que no está modelado, y para qué lado tira

1. **Granularidad horaria.** El trailing del bot se recalcula cada 60 s con el
   menor de dos lecturas; acá al cierre de la barra. Sube más despacio: el
   backtest es **optimista** para el trailing (en la realidad saca todavía más).
2. **TP parcial y target como límites sin spread.** El `cocos-bot` vende el
   parcial contra el bid (cruza) y el target por orden límite. Cobrar 0,10% a la
   mitad de la posición en el 45% de los trades vale ~0,02% por operación. No
   cambia nada.
3. **Variante D.** Aproximación con cierres horarios (no hay tick). Un cierre
   horario debajo del nivel y otro arriba es un evento más raro y más lento que
   la ruptura/recuperación que vería el bot en minutos: D en la realidad
   agregaría tramos más seguido y a peor precio. Tira **en contra** de D.
4. **Trailing en C y D mientras promedia.** Se activa sólo cuando el cierre
   está arriba del primer nivel; abajo, el stop es el único "bajo el último
   tramo". Si se aplicara el trailing literal del bot (sube con cualquier
   rebote), los tramos 3 y 4 casi nunca se llenarían y C1 se acercaría a B.
   Es una decisión de diseño de la variante, no del bot: el bot **no tiene**
   promediado y habría que decidir esto antes de programarlo.
5. **Orden intrabarra.** Stop antes que target; tramo antes que stop; venta
   nunca en la misma barra en que se llenó un tramo. Todo pesimista.
6. **Sin earnings, sin libro, sin tick, sin ratio de CEDEAR**, igual que todo
   el proyecto (README §"qué se aproximó"). Universo: 38 limpios, no los 297 del
   universo ampliado (`midas-universo-ampliado`: ampliar empeora).
7. **El CCL.** En el IS todo lo positivo es el dólar (A: papel −0,53%, CCL
   +1,02%; C1: papel +1,24%, CCL +1,77%). Con el CCL quieto —o bajando— C1 se
   achica a la mitad y A se va a negativo también en el IS.

---

## 9. Veredicto

1. **Target: dejar la resistencia (`COCOS_BOT_TARGET_PCT=0`).** Los tapes de
   +1%, +1,5% y +2% son las tres peores variantes de las 13, en las dos
   ventanas, con *t* por mes de −2,8 / −2,1 / −1,5 en el OOS. No es ruido: es
   aritmética (stop a 6%, target a 1-2%, aciertos de 66-78%).
2. Si LP quiere un tape igual, **+3% es el único que no empeora a la
   resistencia en ninguna ventana** (+0,26 vs +0,19 IS; −0,19 vs −0,49 OOS; DD
   7,9% vs 12,8%). Pero *t* de 0,48 / −0,52: no hay evidencia de que sume, sólo
   de que no resta. Menos de 3%, no.
3. El parcial del 50% da igual (A ≈ B sin parcial). Se puede apagar o dejar.
4. **Promediar hacia abajo (C1) es lo único positivo en las dos ventanas, pero
   no por el patrón**: en fechas barajadas rinde igual (IS) o el doble (OOS:
   0,71% vs 0,35%). Lo que gana es stop más ancho + promedio más bajo + más
   tiempo comprado en pesos. El 86% del resultado OOS es un mes, DSR 0,13, y
   los 4 tramos (el caso "siguió cayendo") pierden 5% sobre 2M con 24-40% de
   aciertos. No lo programaría en el bot; si se prueba, en libro paper aparte.
5. C2 (grid +1,5%) acierta el 89% y no gana nada sobre 20M; C3 es peor que el
   azar. **El escalonado en recuperación (D) no agrega nada** en ninguna de sus
   dos salidas: pone menos plata en los trades buenos y más en los que
   rompieron.
6. Con estos rails el bot usa el 6-9% de los 20M en promedio. El techo del
   mensual no está en el target: está en que hay 6 fills por semana de 2M.
7. Lo que sí vale la pena medir a continuación, pre-registrado: **el trailing
   por ATR apagado o más ancho** (+0,2 a +0,6 pp mensual en las dos ventanas
   en todas las variantes, §7.1). Es la única palanca con magnitud que apareció,
   y no era una hipótesis de este anexo, así que hoy no vale como evidencia.
