# Informe · el motor del bot niveles-auto contra 3 años de historia

**La primera línea, sin vueltas: el motor portado reproduce bien al bot real
(81% de las señales coinciden en el nivel exacto), y corrido sobre 35 meses de
barras horarias da NEGATIVO en IOL Gold, tanto in-sample (−0,83%/mes) como
out-of-sample (−0,95%/mes). El bruto antes de comisiones es apenas positivo —
0,36% del nocional por trade — contra un costo de ida y vuelta de 1,12% en
Gold. La estrategia no pierde por las reglas: pierde porque la comisión de
Gold es tres veces el edge que produce. En Black la cosa queda en cero
(+0,04%/mes IS, +0,07%/mes OOS), que no es un negocio pero tampoco una
sangría. Ningún filtro de régimen la da vuelta.**

Todo corrió local sobre `data/` (ver `INVENTARIO.md`). No se tocó el VPS ni
Supabase. Reglas tomadas de `workers/niveles-auto/worker.js` (config "NUEVA",
congelada el 16/09/2026), sin optimizar un solo parámetro del motor.

---

## 0. ¿El port es fiel? (esto va primero, si no lo demás no vale nada)

Se comparó lo que el motor portado produce contra lo que el worker emitió de
verdad entre el 23/07 y el 16/09/2026, alineando cada evaluación a la última
barra horaria **cerrada** antes de la señal real.

**Contra `paper_trades_export.json`** (ahí está el kit completo de cada señal
operada: `entry_limit`, `stop_inicial`, `target` exactos), 281 señales
evaluables:

| | Coinciden | Tasa |
|---|---:|---:|
| Nivel de entrada dentro de ±1% | 228 / 281 | **81,1%** |
| Nivel de entrada dentro de ±2% | 250 / 281 | 89,0% |
| Stop, condicional a que la entrada coincida | 205 / 228 | 89,9% |
| Target, condicional a que la entrada coincida | 199 / 228 | 87,3% |
| Kit completo (entrada + stop + target) | 182 / 228 | 79,8% |

**Contra `nivel_track_export.json`** (491 lotes de niveles emitidos), usando el
spot que el worker anotó en cada lote: **82,3%** de los soportes coinciden
dentro de ±1% y 90,6% dentro de ±2%.

**El detalle que importa para leer todo lo demás:** si en vez del spot que vio
el worker se usa el cierre de la barra horaria — que es lo único que tiene el
backtest — la coincidencia cae a **40,9%**. No es que el motor esté mal: es
que la elección de zona depende de dónde está el precio *en ese instante*, y
una hora de granularidad alcanza para que el precio cruce por encima de una
zona y el motor elija la de más abajo. El caso testigo: MU el 23/07, spot real
994,50 → soporte 991,10; cierre de la barra 990,24 → esa zona ya no está
"debajo del precio" y el motor cae a 957,83.

Consecuencia práctica: **los niveles del backtest son los correctos, pero la
elección entre zonas vecinas tiene ruido de timing.** Eso agrega varianza a los
resultados; no los sesga en una dirección conocida.

Aparte, el self-check interno (camino rápido cacheado vs camino lento y
literal) da 40/40 en barras al azar: la optimización de performance no cambia
un solo número.

---

## 1. El caso base: los 38 limpios, el filtro del worker tal cual

Universo: los 38 tickers con 5 años limpios del INVENTARIO (incluye SPY y QQQ,
que el bot real no opera; entre los dos aportaron 0 trades — nunca pasaron el
filtro). Capital $7.000.000, riesgo 1,5%, tope 20% por posición, máximo 5
posiciones y 5 entradas por día.

| Métrica | IS Gold | IS Platinum | IS Black | OOS Gold | OOS Platinum | OOS Black |
|---|---:|---:|---:|---:|---:|---:|
| Trades | 111 | 111 | 111 | 94 | 94 | 94 |
| Meses | 20,4 | 20,4 | 20,4 | 14,6 | 14,6 | 14,6 |
| **Retorno mensual** | **−0,83%** | **−0,39%** | **+0,04%** | **−0,95%** | **−0,44%** | **+0,07%** |
| P&L total | −$1.182.915 | −$561.291 | +$60.333 | −$963.500 | −$446.217 | +$71.066 |
| Win rate | 31,5% | 33,3% | 36,9% | 39,4% | 39,4% | 41,5% |
| Payoff (gan. med. / pérd. med.) | 1,33 | 1,58 | 1,75 | 0,88 | 1,19 | 1,47 |
| Sharpe anualizado | −1,48 | −0,69 | +0,11 | −1,78 | −0,82 | +0,17 |
| Max drawdown | 19,2% | 11,8% | 5,8% | 17,7% | 12,7% | 8,0% |

IS = 2023-10-19 → 2025-06-30. OOS = 2025-07-01 → 2026-09-17.

### La descomposición que explica todo

| | IS | OOS |
|---|---:|---:|
| Bruto por trade (% del nocional) | +0,360% | +0,372% |
| ...de eso, lo que puso el papel (sin el CCL) | **−0,043%** | **+0,281%** |
| ...de eso, lo que puso el dólar (arrastre del CCL) | +0,403% | +0,091% |
| Costo de ida y vuelta, Gold | 1,121% | 1,104% |
| Costo de ida y vuelta, Platinum | 0,721% | 0,711% |
| Costo de ida y vuelta, Black | 0,321% | 0,318% |

Dos cosas se leen acá y las dos son incómodas:

1. **En el in-sample, el edge de precio del motor es cero.** Los 0,36% brutos
   por trade son, enteros, el CCL que subió mientras la posición estaba
   abierta. Sacado el dólar, el papel aportó −0,04%. En el out-of-sample sí
   hay edge de precio (+0,28%), pero sigue quedando por debajo del costo
   Platinum y apenas arriba del Black.
2. **El arrastre del CCL no es alpha del bot.** Es estar largo dólar. LP lo
   consigue comprando el CEDEAR y no tocándolo, sin pagar 1,12% de comisión
   cada vuelta.

### Mecánica: el tope del 20% manda el tamaño, no el riesgo

El nocional promedio por trade es $1.397.000 = exactamente el tope del 20% del
capital. O sea que **el sizing por riesgo de 1,5% nunca llega a activarse**:
con stops típicos de 2-3%, la cantidad por riesgo daría posiciones de $4M+, y
el tope las corta antes. El riesgo real por trade queda en ~0,5% del capital,
no en 1,5%. Es el mismo efecto que LP ya había notado con el tope del 25% y
que motivó pasar a 35% y después a 20%: el freno que muerde es el tope.

### Cómo mueren los trades (IS + OOS, 205 trades)

| Camino de salida | n | Win rate | P&L Gold / trade | P&L Black / trade |
|---|---:|---:|---:|---:|
| stop seco | 117 (57%) | 4,3% | −$39.696 | −$29.782 |
| TP parcial → stop | 12 | 16,7% | −$20.525 | −$7.870 |
| TP parcial → target | 62 (30%) | 90,3% | +$41.925 | +$54.808 |
| TP parcial → trailing | 13 | 69,2% | +$11.567 | +$23.915 |

El sistema es lo que parece: pierde 6 de cada 10 veces una cantidad parecida a
la que gana las otras 4. Con payoff 1,33 (IS) y 0,88 (OOS) y win rate 31-39%,
la aritmética no cierra ni antes de comisiones en el IS.

De las señales que pasan el filtro, sólo **el 21% termina en trade** (111 de
528 en el IS): 278 órdenes expiran a las 48 h sin que el papel baje al nivel y
el resto se cae antes por tope de posiciones, por papel ya abierto o por
duplicada. Eso no es un defecto — las órdenes que no se llenan no cuestan
nada.

Duración del trade: mediana **24 horas de mercado**, promedio 65 (IS) y 45
(OOS), percentil 90 en 144 y 120. Es swing corto con cola larga: la mitad sale
al día siguiente y los que corren con trailing se quedan semanas. Esa cola es
la que explica el arrastre del CCL de la tabla de arriba — con el dólar
subiendo ~0,06% por día corrido en el IS, un promedio de ~4 días calendario
adentro deja justo el orden de magnitud de los 0,40 puntos.

---

## 2. Sesgo de selección: los 38 limpios contra los 50 con alta real

Segunda corrida con los 50 símbolos, cada joven entrando el día de su primera
rueda horaria real, y las cáscaras de SPAC truncadas en la diaria (OKLO
2024-05-10, RGTI 2022-03, SATL 2022-01, KEEL y LAR desde que arranca su
horario).

| | 38 IS | 50 IS | 38 OOS | 50 OOS |
|---|---:|---:|---:|---:|
| Trades | 111 | 174 | 94 | 149 |
| Mensual Gold | −0,83% | −0,78% | −0,95% | **−1,19%** |
| Mensual Platinum | −0,39% | −0,12% | −0,44% | −0,42% |
| Mensual Black | +0,04% | **+0,55%** | +0,07% | **+0,36%** |
| Bruto por trade | 0,360% | 0,639% | 0,372% | 0,484% |
| Bruto sin CCL | −0,043% | +0,184% | +0,281% | +0,349% |
| Win rate | 31,5% | 35,1% | 39,4% | 38,3% |
| Max DD Gold | 19,2% | 23,9% | 17,7% | 23,1% |

**La magnitud del sesgo es de 0,05 a 0,24 puntos mensuales en Gold, y cambia
de signo entre ventanas**: sumar los 12 papeles jóvenes/sucios mejora
levemente el IS (−0,78 vs −0,83) y empeora claramente el OOS (−1,19 vs −0,95).
No hay un sesgo optimista sistemático, que es lo que uno temía al arrancar.

Lo interesante es otra cosa: los jóvenes **sí tienen más edge bruto** (0,64%
vs 0,36% por trade en IS) porque se mueven más — y por eso en Black, donde la
comisión no se los come, el universo de 50 rinde bastante mejor (+0,55%/mes IS,
+0,36%/mes OOS) que el de 38. En Gold ese mismo movimiento extra se lo lleva
la tarifa, más el drawdown que sube de 19% a 24%.

---

## 3. Filtros de régimen: ¿cuándo conviene apagar el bot?

Esto era lo que más importaba, así que va completo. Todos los filtros se
eligieron mirando sólo el IS; el OOS se corrió una vez y no se retocó nada.
El umbral de volatilidad es la **mediana del IS** (vol realizada 20d de SPY
anualizada = 0,128), congelado para el OOS.

| Filtro | n IS | Mensual IS | Exp/trade IS | n OOS | Mensual OOS | Exp/trade OOS |
|---|---:|---:|---:|---:|---:|---:|
| base (gate del worker) | 111 | −0,83% | −$10.657 | 94 | −0,95% | −$10.250 |
| sin régimen (opera todo) | 156 | −1,17% | −$10.655 | 129 | −0,97% | −$7.686 |
| sin régimen + SPY>EMA200 | 137 | −1,19% | −$12.377 | 125 | −1,06% | −$8.631 |
| sin régimen + SPY>EMA50 | 116 | −0,81% | −$9.961 | 111 | −0,93% | −$8.546 |
| sin régimen + vol20 baja | 91 | −0,63% | −$9.832 | 75 | −0,68% | −$9.265 |
| base + SPY>EMA200 | 109 | −0,87% | −$11.362 | 94 | −0,95% | −$10.250 |
| base + SPY>EMA50 | 106 | −0,72% | −$9.749 | 92 | −0,95% | −$10.541 |
| **base + vol20 baja** | 76 | **−0,38%** | −$7.168 | 57 | **−0,64%** | −$11.449 |
| *control*: sin régimen + SPY<EMA200 | 20 | −0,00% | −$248 | 5 | +0,05% | +$10.848 |
| *control*: sin régimen + vol20 alta | 69 | −0,56% | −$11.500 | 56 | −0,39% | −$7.010 |

### El que mejor separa

**`base + vol20 baja`**: es el mejor del IS por un margen claro (−0,38% contra
−0,83% del base, o sea 0,45 puntos mensuales) y **aguanta en el OOS** (−0,64%
contra −0,95%, 0,31 puntos). Es el único filtro que mejora en las dos
ventanas. Pero antes de festejar hay que mirar la columna de expectancy:

- En el IS mejora el trade promedio (−$7.168 vs −$10.657).
- En el OOS lo **empeora** (−$11.449 vs −$10.250).

Es decir: **mejora el mensual porque opera menos, no porque opere mejor.**
Recorta 40% de los trades y con eso recorta la pérdida y el drawdown (de 17,7%
a 12,8% en el OOS). Es una perilla de exposición, no un descubrimiento sobre
el mercado.

### Los que NO sirven

- **SPY sobre EMA200 empeora las cosas en las dos ventanas.** Filtrar por
  "mercado alcista" le saca al bot justamente los trades que le sirven.
- **SPY sobre EMA50** es neutro (mejora 0,11 pp en IS, 0,00 en OOS).
- **El gate de régimen propio del worker** (risk_on, o mixto exigente) mejora
  el mensual del IS contra no filtrar (−0,83 vs −1,17) pero **la expectancy
  por trade es idéntica** (−$10.657 vs −$10.655): otra vez, sirve por operar
  menos. Y en el OOS es directamente **peor por trade** (−$10.250 contra
  −$7.686 sin filtrar). El régimen risk_on/risk_off, que en el análisis de
  `nivel_track` del 01/09 parecía la única señal que sobrevivía a la
  deflación, acá no reproduce ese resultado.
- El régimen "mixto" (la regla B del 03/09, media posición) generó 5 trades en
  35 meses, todos juntos −$100.982. n=5: no prueba nada, pero tampoco aporta.

### El control que da vuelta la intuición

Los dos controles —operar **sólo** con SPY bajo su EMA200, u operar sólo en
volatilidad alta— salen *menos malos* que sus complementos en el OOS. Con
n=20 y n=5 en el primer caso no se puede concluir nada, pero la dirección es
la contraria a la que dice la regla actual del bot. Si algo, comprar soportes
sirve más cuando el mercado viene golpeado — que es lo que dice la literatura
de reversión a la media y lo contrario de lo que hace el filtro de régimen
hoy.

**Respuesta a la pregunta "cuándo apagar el bot":** con estos datos, la única
recomendación defendible es *bajar la exposición cuando la volatilidad de SPY
está por encima de su mediana*, y aun así el sistema sigue perdiendo en Gold.
No aparece ningún régimen donde el bot gane plata con tarifa Gold.

---

## 4. Robustez: stop y target ±30%

Se barrió el stop y el target multiplicando su distancia a la entrada por
0,7 / 0,85 / 1 / 1,15 / 1,3, sin elegir el mejor. Retorno mensual Gold:

**IS**

| stop \ target | 0,70 | 0,85 | 1,00 | 1,15 | 1,30 |
|---|---:|---:|---:|---:|---:|
| **0,70** | −0,70 | −0,74 | −0,70 | −0,63 | −0,65 |
| **0,85** | −0,87 | −0,95 | −0,92 | −0,87 | −0,90 |
| **1,00** | −0,95 | −0,97 | **−0,83** | −0,84 | −0,92 |
| **1,15** | −0,70 | −0,75 | −0,60 | −0,58 | −0,62 |
| **1,30** | −0,69 | −0,63 | −0,41 | −0,38 | −0,36 |

**OOS**

| stop \ target | 0,70 | 0,85 | 1,00 | 1,15 | 1,30 |
|---|---:|---:|---:|---:|---:|
| **0,70** | −1,12 | −1,16 | −1,20 | −1,23 | −1,13 |
| **0,85** | −1,14 | −1,24 | −1,23 | −1,33 | −1,21 |
| **1,00** | −1,15 | −0,97 | **−0,95** | −0,98 | −0,81 |
| **1,15** | −1,07 | −1,05 | −0,99 | −1,03 | −0,84 |
| **1,30** | −1,24 | −1,26 | −1,18 | −1,22 | −0,99 |

**Las 50 celdas dan negativo.** No hay una vecindad de parámetros donde el
signo se dé vuelta: el resultado no depende de haber elegido mal el stop o el
target, y tampoco hay un pico sospechoso que delate sobreajuste. La tendencia
consistente —stops más anchos pierden menos en el IS— no se repite en el OOS,
así que no es una regla, es ruido de muestra.

La variante de confirmación de salida (cerrar al cierre de la barra en vez de
al toque intrabarra, que es la aproximación optimista de los 10 minutos del
worker) mejora las dos ventanas pero no cambia el signo: IS −0,61% y OOS
−0,72% en Gold. La verdad de los 10 minutos reales está entre esa fila y el
caso base.

---

## 5. Deflated Sharpe Ratio

Se contaron **76 configuraciones evaluadas** en total (2 universos × 2
ventanas del caso base, 10 gates × 2 ventanas, 25 celdas del barrido × 2
ventanas, 2 variantes de confirmación). Ese es el N que entra en el DSR de
Bailey & López de Prado; σ(SR) es el desvío de los Sharpe diarios entre esas
variantes.

| Corrida | Sharpe anualizado | DSR |
|---|---:|---:|
| 38 limpios, base, IS, Gold | −1,48 | 0,00004 |
| 38 limpios, base, OOS, Gold | −1,78 | 0,0001 |
| 38 limpios, base, IS, **Black** | +0,11 | **0,14** |
| 38 limpios, base, OOS, **Black** | +0,17 | **0,20** |
| 50 con alta real, base, IS, Black | +0,81 | 0,44 |
| 50 con alta real, base, OOS, Black | +0,57 | 0,34 |
| Mejor filtro del IS (base + vol20 baja), OOS, Gold | −1,42 | 0,0005 |

**Ninguno llega ni cerca de 0,95.** El caso más favorable que produce todo el
estudio —los 50 papeles con tarifa Black en el in-sample, Sharpe 0,81— tiene
un DSR de 0,44: después de descontar que probamos 76 cosas, la probabilidad de
que ese Sharpe sea de verdad mayor que cero es una moneda al aire. Con Gold el
DSR es cero con cuatro decimales, que es lo que corresponde a un Sharpe
negativo.

---

## 6. Cortes adicionales (post-hoc, tomar con pinzas)

Estos cortes se miraron **después** de ver los resultados. No entran en el
walk-forward ni en el DSR de arriba; son hipótesis para mirar en el futuro, no
reglas para aplicar mañana.

**Por score** (205 trades, 38 limpios, IS+OOS):

| Score | n | Win | Gold / trade | Black total |
|---|---:|---:|---:|---:|
| 7 | 119 | 34,5% | −$12.165 | −$116.484 |
| 8 | 59 | 28,8% | −$11.495 | −$38.532 |
| 9 | 18 | 50,0% | +$614 | +$219.417 |
| 10 | 9 | 55,6% | −$3.516 | +$66.995 |

Hay un salto real entre 8 y 9: el score 9-10 (n=27) empata en Gold y gana en
Black, mientras 7-8 (n=178) pierde en todo. Si el score mide algo, lo mide en
el extremo. Pero 27 trades en 35 meses es un trade cada 27 ruedas: subir el
umbral a 9 deja al bot casi sin operar, y la evidencia para hacerlo es
justamente el tipo de corte post-hoc que el DSR castiga.

**Por año** (Gold, por trade): 2023 −$17.161 (n=10), 2024 −$8.939 (n=74),
2025 −$6.323 (n=71), 2026 −$17.287 (n=50). El peor año es el que está
corriendo.

---

## 7. Lo que no está modelado (y para qué lado tira)

| Aproximación | Efecto sobre el resultado |
|---|---|
| Salidas por toque intrabarra sin la confirmación de 10 min | **Pesimista**: saca trades que el worker hubiera aguantado (la variante al cierre mejora ~0,2 pp/mes) |
| Sin spread ni tick en las salidas por stop (se vende en el nivel exacto) | **Optimista**: el stop real sale contra el bid, peor |
| Sin bloqueo por earnings (≤3 días) | **Optimista**: el backtest opera señales que el bot real descarta |
| Spot = cierre de la barra horaria | Ruido de timing en la elección de zonas vecinas, sin dirección conocida |
| Volumen del subyacente USA en vez del CEDEAR local | Afecta el score (componente de volumen del pivote) |
| `conv = 1` y cantidad fraccionaria | Irrelevante: el tope del 20% manda el tamaño en el 100% de los trades |
| CCL por día de rueda (serie diaria) | El serrucho intradiario del dólar no está; el arrastre sí |
| Sin libro sombra ni desplazo por cercanía | Menos trades que el bot real en días de saldo apretado |
| Sin alertas TV ni cola manual de LP | El backtest mira los 50 papeles siempre; el bot real mira lo que se le encola |

---

## 8. Veredicto

**¿El motor tiene edge?** Sí, uno muy chico y no siempre: 0,36-0,37% bruto por
trade, del cual en el in-sample **todo** es el arrastre del CCL y en el
out-of-sample 0,28 puntos son del papel. Contra eso:

- **Gold (0,6655% por punta)** se come el edge tres veces. −0,83%/mes IS,
  −0,95%/mes OOS. Con drawdowns del 17-19%. No hay vuelta: **en Gold, esta
  estrategia no se sostiene.**
- **Platinum (0,4235%)** achica la sangría a la mitad pero sigue negativa:
  −0,39% y −0,44% mensual.
- **Black (0,1815%)** la deja en cero: +0,04% y +0,07% mensual. Con el
  universo de 50 papeles, +0,55% y +0,36% — el único número simpático de todo
  el informe, y con DSR 0,34-0,44 no alcanza para llamarlo edge.

**¿Dónde está el edge, si está?** En tres lugares, por orden de solidez:

1. **En la tarifa.** Es la palanca más grande y la única que no depende de
   ninguna estimación: pasar de Gold a Black vale 0,87 puntos mensuales en el
   IS y 1,02 en el OOS, sobre exactamente los mismos trades. Todo el proyecto de construir volumen en IOL para
   escalar de tier deja de ser una optimización y pasa a ser la condición
   necesaria para que el sistema sea viable.
2. **En operar menos.** Bajar exposición cuando la volatilidad de SPY está
   arriba de su mediana mejora las dos ventanas (0,45 pp IS, 0,31 pp OOS),
   aunque por reducción de tamaño y no por mejor selección.
3. **Quizás en el score alto.** Score ≥ 9 empata en Gold y gana en Black, pero
   son 27 trades en 35 meses y es un corte post-hoc.

**¿Y el filtro de régimen que tiene hoy el bot?** No se sostiene. Exigir
risk_on no mejora la expectancy por trade en ninguna de las dos ventanas
(idéntica en IS, peor en OOS); sólo reduce la cantidad de trades. Y el filtro
"SPY sobre EMA200", que es la versión canónica de la misma idea, **empeora**
los resultados. Si LP quiere una perilla de encendido/apagado, la
volatilidad de SPY separa mejor que la tendencia.

**La conclusión operativa, en una línea:** con la tarifa que paga hoy, el bot
de niveles es una máquina de convertir un edge de 0,36% en una pérdida de
1,12%; el trabajo no es buscarle un filtro mejor, es bajar el costo de la
vuelta o dejar de dar tantas vueltas.

---

## 9. Anexo · ¿conviene recomprar la mitad que vende el TP parcial?

Pregunta posterior de LP, contestada aparte en **`INFORME-RECOMPRA.md`**
(script `recompra.js`, mismo motor y mismas convenciones; el caso base de ese
informe reproduce número por número el `38/base` de acá). El resumen: el
retroceso al nivel de entrada **sí** es selección adversa medible —la
probabilidad de terminar en stop pasa de 13,8% a 37,5% y la de target cae de
71,3% a 31,3%— pero la mitad recomprada igual tiene edge bruto positivo
(+0,65% del nocional sobre las dos ventanas). Como siempre, el edge no llega a
pagar la vuelta: en Gold la recompra resta $88.659 en 35 meses, en Platinum
queda en cero y en Black suma $76.707 (0,03 puntos mensuales, DSR 0,26 con
n=32). La alternativa tampoco existe: en 899 señales **cero** se perdieron por
falta de caja — los 43 skips por tope son del contador de 5 posiciones, que la
media venta no libera, así que el saldo liberado queda ocioso igual. Veredicto:
no recomprar mientras la tarifa sea Gold. Ese anexo agrega 8 configuraciones,
de modo que **el N del DSR pasa de 76 a 84**; ahí también se recalculó σ(SR) de
Black sobre las 76 variantes originales (en §5 había quedado sobre menos), lo
que mueve los DSR de Black unas milésimas sin cambiar ninguna conclusión.

---

## 10. Corrección · el filtro de volatilidad no sobrevive al modelo nulo

Pregunta posterior de LP, contestada aparte en **`INFORME-NULO.md`** (script
`nulo.js`, mismo motor y mismas convenciones; el chequeo de arranque reproduce
las 20 celdas de la tabla de §3 con Δ = 0). **Esto corrige la §3 y la §8 de
este informe.**

La §3 decía que `base + vol20 baja` es "la única recomendación defendible" y
admitía en el mismo párrafo que mejora "porque opera menos, no porque opere
mejor". Esa admisión ahora está testeada, y el resultado es peor de lo que
sugería. Contra un nulo que saca la misma cantidad de trades al azar, el filtro
cae en el **percentil 77 del IS (p = 0,23) y en el 45 del OOS (p = 0,55)**;
contra el nulo honesto —apagar la misma cantidad de ruedas, en bloques
contiguos con las mismas duraciones ubicados al azar— cae en el **percentil 59
(p = 0,41) y en el 47 (p = 0,53)**. En Black el OOS queda en el percentil 32 y
36: apagar el bot en fechas al azar hubiera salido mejor. La expectancy de los
trades que el filtro deja pasar **no se distingue** de la de los que bloquea
(Welch: IS p = 0,28, OOS p = 0,73). Y de los 17 gates evaluables de la tabla de
§3, **ninguno llega a p < 0,05** contra el nulo de bloques, incluido el gate de
régimen del worker (percentil 68 IS, 43 OOS).

Aparte apareció un lookahead que acá no se había visto: **el umbral de "vol
alta/baja" es la mediana de todo el in-sample aplicada también hacia atrás,
sobre la primera rueda del in-sample.** Congelarlo para el OOS —que es lo que
dice `README.md` y es cierto— no arregla eso. Re-corrido point-in-time con
mediana expansiva, el −0,38%/mes del IS se va a **−0,81%** y la mejora contra el
base cae de 0,45 puntos a 0,02; en el OOS de 0,31 a 0,16. Con mediana móvil de
252 ruedas, también point-in-time, sale mejor que el número publicado (−0,30%
IS, −0,49% OOS). Que dos implementaciones PIT igual de legítimas den resultados
opuestos, sumado a que el mensual mejora monótonamente al apretar el cuantil
del umbral (de −0,83% con el base a −0,03% con q = 0,25, con el drawdown
bajando de 19,2% a 7,4%), confirma que **lo que se está moviendo es la perilla
de exposición y no un detector de régimen**. El `adjclose` de SPY, en cambio, no
contamina nada: con close crudo el resultado es idéntico al peso.

Lo que hay que corregir en la **§8**: el punto 2 de "¿dónde está el edge?"
—"en operar menos"— se mantiene, pero **sin la palabra volatilidad**. Lo
defendible es bajar la exposición, punto; la volatilidad de SPY no aporta nada
por encima de sortear los días, y el límite de esa perilla es el cero, no un
número positivo. La última frase de §3 ("la única recomendación defendible es
bajar la exposición cuando la volatilidad de SPY está por encima de su mediana")
queda **anulada**. Todo lo demás de este informe —el signo negativo en Gold, la
descomposición del edge, la robustez del barrido, el veredicto de la tarifa
como única palanca— queda **confirmado**: el nulo no toca ninguno de esos
resultados.

Ese anexo agrega 16 configuraciones (4 variantes del umbral × 2 ventanas + 4
cuantiles × 2 ventanas), de modo que **el N del DSR pasa de 84 a 100**; σ(SR)
queda en 0,040737 (Gold) y 0,023329 (Black), y el DSR de `base + vol20 baja` en
el OOS con Gold baja de 0,0005 a 0,00041. Los 5.000 sorteos de cada nulo no
entran en el N: son la distribución de referencia contra la que se juzga una
configuración, no configuraciones candidatas.

---

## 11. Anexo · el time-stop post-fill tampoco aparece

Tercera pregunta posterior de LP, contestada aparte en **`INFORME-TIMESTOP.md`**
(script `timestop.js`, mismo motor y mismas convenciones; el chequeo de arranque
reproduce el `38/base` de las dos ventanas con Δ = 0 y el replayer de trades
reproduce la cartera en 205/205). La hipótesis venía de Locke & Mann (JFE 2005):
los traders de pit que cerraban rápido —perdedores y ganadores— rendían mejor
después, y la disciplina sería "salir cuando la razón original del trade
desapareció". **No se verifica acá, ni en su versión cruda ni en la versión con
mecanismo.** Los trades largos rinden *mejor* en crudo (Spearman duración vs
bruto = +0,43 IS y +0,46 OOS, p < 0,0001), y controlado por camino de salida
—que es obligatorio, porque los stops son cortos por construcción y los targets
largos— el efecto se cae a +0,20 (IS, p = 0,033) y −0,03 (OOS, p = 0,75). El
barrido de time-stop (8 H × 2 relojes × 2 ventanas) no tiene una sola celda con
p < 0,05 contra el nulo, no es monótono en ninguna de las cuatro combinaciones,
y contra el nulo de trades al azar cae por debajo de la mediana en **las 26**
celdas que cortan algo: cortar los trades más largos sale peor que cortar al
azar. La salida por "razón muerta" queda en la mediana del nulo en su mejor
versión (percentil 67 IS, 27 OOS) y **peor que el azar** en su lectura literal
(percentil 0,5). Ese anexo deja además dos correcciones para este informe:

1. **La duración reportada en §1 está en horas corridas, no de mercado.** La
   frase "duración mediana 24 horas de mercado, promedio 65 (IS) y 45 (OOS),
   percentil 90 en 144 y 120" hay que leerla como **horas corridas** — el
   cálculo es `(exitTs − entryTs)/3600000` e incluye noches y fines de semana.
   Medida en barras horarias del papel, la mediana es **5 (IS) y 6 (OOS)**, el
   promedio 12,8 y 10,3, el percentil 90 es 28 en las dos y el máximo 102 y 118.
   La cola larga existe igual, pero es cuatro veces más corta de lo que sugería
   el número publicado.
2. **La señal del bot está muerta en el instante en que la orden se llena.** El
   motor define la entrada como el techo de la zona de soporte más cercana
   *debajo del spot*, y el fill ocurre justo cuando el precio baja a ese techo;
   en la barra siguiente esa zona ya no está debajo del spot y el motor re-deriva
   otra. En el 79% de los trades ése es el motivo por el que la señal original
   deja de existir una o dos barras después del fill. No cambia ningún número de este
   informe, pero hay que tenerlo en cuenta para cualquier regla futura que
   quiera re-evaluar la tesis de un trade abierto.

Ese anexo agrega 32 configuraciones (10 del reloj de mercado —las H = 120, 168 y
240 no cortan ningún trade y son idénticas al base, así que no cuentan—, 16 del
reloj corrido y 6 de razón muerta), de modo que **el N del DSR pasa de 100 a
132**; σ(SR) queda en 0,040723 (Gold) y 0,025716 (Black). Ninguna corrida del
anexo llega a DSR 0,25.

---

## 12. Anexo · el barrido de soportes contra el quiebre, y qué era el 79%

Cuarta pregunta posterior, ésta abierta por el propio §11: si el motor re-deriva
otra zona en la barra siguiente al fill en el 79% de los trades, ¿es eso una
propiedad de la señal o un artefacto de la granularidad horaria? Y detrás:
cuando el precio perfora un soporte, ¿se puede distinguir en el momento de
entrar entre el **barrido** (penetra poco y revierte) y el **quiebre** (penetra y
sigue)? Contestado aparte en **`INFORME-BARRIDO.md`** (script `barrido.js`,
mismo motor y mismas convenciones; el chequeo de arranque reproduce el `38/base`
de las dos ventanas con Δ = 0, el replayer reproduce la cartera en 205/205
trades, la equity reconstruida desde los legs reproduce la curva del simulador
en 730/730 ruedas y la zona reconstruida en la barra de la señal reproduce el
nivel de entrada en 205/205).

**Sobre el 79%: las dos cosas, y hay que separarlas.** El *número* es en buena
medida artefacto de selección entre zonas vecinas: recalculado con distintas
tolerancias de "misma zona" baja de 79,2% (±0,25% y ±0,5%) a 66,3% (±1%) y a
**37,1% (±2%)**, y el nivel re-derivado está, en mediana, apenas **1,15% por
debajo** del de entrada — es la zona de al lado, no otra cosa. Pero la *muerte de
la señal* no depende de la tolerancia: con ±2% el motor sigue sin emitir la señal
en **202 de 205** trades, en la barra siguiente al fill, sólo que el motivo pasa
de "re-derivó otra zona" a "score < 7" (de 13 a 76 casos). Lo que dice §11 —que
la señal está extinguida por construcción en el instante del fill— queda
**confirmado**; lo que hay que corregirle es la cifra: la parte atribuible a la
re-derivación de zona está entre el 37% y el 79%, no en el 79% fijo.

**Sobre el barrido contra el quiebre: se distingue, pero no por donde se
buscaba.** La penetración post-entrada normalizada por ATR14 es un **continuo
asimétrico con una sola moda** (≈0,45-0,50 ATR), no dos poblaciones: el BIC
prefiere dos gaussianas pero la mezcla ajustada es ella misma unimodal
(separación 1,88 sd en IS y 1,73 en OOS). El test primario pre-registrado —partir
por si el motor sigue derivando la misma zona en la barra del fill— da
**p = 0,477 en el IS (n = 35 vs 76) y p = 0,0021 en el OOS (n = 26 vs 68)**:
aparece en una ventana y no en la otra. Y el control lo desarma: esa partición
coincide en el 93-97% con algo mucho más simple —**la barra del fill cerró arriba
del nivel**— que separa **mejor y en las dos ventanas** (p = 0,0998 IS,
p = 0,0001 OOS; pooled p ≈ 0,0005, win 55,7% contra 24,4%). De las cinco features
point-in-time probadas, ninguna llega a p < 0,05 en el IS y **ninguna sobrevive
al nulo de descarte aleatorio en las dos ventanas**.

**Lo que lo mata es el costo.** La variable se observa al cierre de la hora en la
que el bot ya compró, así que el corte no es "no tomar el trade" sino "soltarlo a
ese cierre", con la vuelta de comisión completa. Ejecutado así, **empeora las dos
ventanas y las dos tarifas**: Gold −1,24% (IS) y −1,20% (OOS) contra −0,83% y
−0,95% del base; Black −0,59% y −0,44% contra +0,04% y +0,07%. El anexo deja
anotada la única línea que podría servir y que **no se testeó**: cambiar el tipo
de orden —no comprar al nivel con una límite sino esperar el cierre de la hora y
comprar sólo si el precio quedó arriba—, que ejecuta el edge una sola vez a
cambio de un precio de entrada peor.

Ese anexo agrega 28 configuraciones (24 cortes del bloque D + 4 del control), de
modo que **el N del DSR pasa de 132 a 160**; σ(SR) queda en 0,052149 (Gold) y
0,037895 (Black). Ahí aparece el **DSR más alto de todo el proyecto, 0,911**
(operar sólo lo que cerró arriba del nivel, Black, OOS) — sobre una cartera que,
por lo anterior, no se puede armar.

---

## 13. Anexo · ¿la variable del §12 se vuelve accionable con granularidad fina?

Quinta pregunta posterior, abierta por el propio §12: el hallazgo más limpio del
proyecto —**la barra del fill cerró arriba o abajo del nivel**— muere porque se
observa demasiado tarde. Si en vez de esperar el cierre de la hora se pudiera
decidir a los 5, 10 o 15 minutos del fill, ¿el signo se da vuelta? Contestado
aparte en **`INFORME-FINO.md`** (script `fino.js`, barras de 5 minutos de
`research/backtest-reglas/data` y de 1 minuto en `data-1m`). **La respuesta es
no**, y el anexo es un **estudio de factibilidad**, no una medición: la muestra
no son los 205 trades de este informe sino **157 trades llenados del libro
paper/sombra del bot** (de los cuales 148 son `shadow`, o sea señales que el
filtro de entrada rechaza), en **una sola ventana de 36 días** (11/08 → 16/09/2026)
y en **modo aislado**, sin cartera. Todo lo cuantitativo de ese anexo hay que
leerlo con esa advertencia.

**La observación no es el cuello de botella.** La variable se determina en la
**primera barra de 5 minutos** posterior al fill: mediana 5', p25 5', p75 10',
p90 42', y en el **74,5%** de los trades el signo ya no vuelve a cambiar en toda
la hora. A 1 minuto la mediana baja a **1'**. A los 5 minutos ya se sabe el 83-87%
de lo que se va a saber a los 60. De paso, el anexo mide algo que este informe no
tenía: como el fill cae en cualquier punto de la barra horaria, el lag real de la
variable en §12 no era de 60 minutos sino de **23 en mediana** (p25 14', p75 37').

**La señal cruda se replica, sobre otra muestra y otra granularidad.** El corte
gratis —expectancy de los que quedaron arriba contra los que quedaron abajo—
separa con **p ≤ 0,003 del minuto 10 en adelante** y con p < 0,0001 a los 30 y 60
(Gold +$718 contra −$31.165 a los 30'). A los 5 minutos todavía no llega
(p = 0,0616, con sólo 21 trades del lado de abajo). A 1 minuto también se ve
(p = 0,0196 al primer minuto, 0,0007 a los 10).

**Pero ejecutarla sigue sin producir nada.** Contra el nulo de soltar la misma
cantidad de posiciones al azar en un momento al azar de la misma ventana (5.000
sorteos, semilla 20260917), **ningún horizonte de ninguna tarifa pasa del
percentil 60**: el mejor es H = 30 en Gold con percentil 55,2 (p = 0,45) y 46,6
en Black (p = 0,53), y cuatro de los siete horizontes caen **por debajo** de la
mediana del nulo. La mediana del nulo ya está en −0,27%/−0,34% contra el −0,424%
del base: **soltar al azar ya mejora todo lo que consigue la regla.** Es el mismo
resultado que mató el filtro de volatilidad en la §10, en otro disfraz: lo que se
mueve es la perilla de exposición, no un detector.

**Y el delta que muestra el barrido no es precio, es comisión.** Descompuesto,
entre el **52% y el 93%** de la mejora es lo que se ahorra por cerrar el mismo
día (la segunda pata pasa a ser bonificada, 0,0605% en vez de 0,6655% en Gold).
Neutralizado ese efecto de calendario, el delta en Gold es **negativo en cinco de
los siete horizontes** y no llega a +0,03% en ninguno. El único número de ese
anexo que vale plata es, otra vez, de tarifa: **cerrar el mismo día ahorra 0,605%
del nocional en Gold**, y aplica a cerrar cualquier posición, no a esta señal.

**Chequeo de consistencia: H = 60 NO reproduce el resultado negativo de §12.** Da
**+0,150%** en Gold contra el −1,24%/−1,20% publicado. Reproduce el *veredicto*
—no hay mejora atribuible a la señal— pero no el *nivel*, por tres razones
declaradas: la muestra (94% libro sombra, con un grupo "abajo" bastante peor que
el de este informe), el modo (aislado, sin el canal de liberar la silla) y la
contabilidad de la comisión. Eso debilita todo lo cuantitativo de ese anexo y es
la razón por la que no propone ninguna regla.

**El control de 1 minuto no dice que la curva siga mejorando.** Con n = 111 y una
semana, el delta oscila (+0,111% a 1', +0,020% a 3', +0,095% a 5', +0,135% a 10')
con 12 a 14 posiciones soltadas: es ruido, y el anexo no concluye más que eso.

Ese anexo agrega 12 configuraciones (7 horizontes de 5m + el veredicto del cierre
de hora de reloj + 4 horizontes de 1m), de modo que **el N del DSR pasa de 160 a
172**. σ(SR) se deja en la del §12 (Gold 5,2149e−2, Black 3,7895e−2) porque las
nuevas corren sobre otra muestra y su Sharpe no está en la misma base: suman al N
pero no a σ. Re-deflactado, **el mejor DSR del proyecto baja de 0,911 a 0,9075**
(Gold, de 0,2386 a 0,2315) — el mismo número y la misma advertencia: es
out-of-sample solo y describe una cartera que no se puede armar.

**Lo que deja para hacer.** Nada que justifique pagar por datos de mejor
granularidad: el dato ya se observa bien, el problema es que soltar la posición
cuesta lo mismo que vale. Lo único que sigue abierto es lo que ya había anotado
el §12 y este anexo refuerza con un número: **cambiar el tipo de orden** —no
poner la límite en el nivel sino esperar y comprar sólo si el precio quedó
arriba—, y la espera debería ser de **5 a 10 minutos**, no de una hora. **No se
testeó** y no entra en ninguna conclusión.

---

## 14. Anexo · la cuarta tarifa: qué pasa en Cocos

Sexta pregunta posterior, y la que faltaba desde el principio: todo este estudio
se corrió con las tres tarifas de IOL y **nunca con la de Cocos**, que es el
otro lado donde LP opera y donde el broker no cobra comisión. Contestado aparte
en **`INFORME-COCOS.md`** (script `cocos.js`, mismo motor y mismas
convenciones). El chequeo de arranque compara las 84 métricas de Gold, Platinum
y Black del `38/base` y del `50/base` de las dos ventanas contra `results.json`
y da **0 descuadres**; el barrido de robustez reproduce 50/50 celdas, el
replayer 205/205 trades y el join con `results-barrido.json` 205/205.

**La tarifa.** `FEE_COCOS = 0.0005 * IVA` = **0,0605% por punta, 0,121% de ida
y vuelta**, tomada literal de `workers/niveles-auto/worker.js`. Son derechos de
mercado 0,050% + IVA, medidos sobre 183 operaciones reales de CEDEARs del libro
de LP; el 0,050% es la tasa de BYMA para operatoria que no cierra en el día, que
es la que le corresponde a un bot de swing. No hay bonificación intradiaria que
modelar (sin comisión de broker, las dos patas cuestan igual) y **no corresponde
sumar caución**: el backtest no se apalanca nunca.

**El caso base cambia de signo.** Los 38 limpios dan **+0,26%/mes IS y
+0,32%/mes OOS** ($371.145 y $329.708), con Sharpe +0,51 y +0,65 y drawdown
máximo de 4,8% y 5,7%. Los 50 con alta real dan **+0,88% y +0,74%**. El bruto no
se movió un peso: la tarifa se lleva el 34% del bruto en Cocos contra el 311%
que se llevaba Gold. **El sesgo de selección deja de cambiar de signo entre
ventanas** (+0,62 pp IS y +0,42 pp OOS a favor de los 50, contra +0,04 y −0,25
en Gold).

**Lo que revive y lo que no.** De las cinco hipótesis muertas: la **recompra**
pasa a sumar ($118.048 en el nivel de entrada, $170.733 a mitad de camino al
stop, sobre 35 meses) y confirma que el nivel bueno es el profundo, pero **no le
gana al nulo en el in-sample** (p = 0,29 y 0,14; el OOS sí, p = 0,019 y 0,021) y
el aporte total no es distinguible de cero por bootstrap. El **time-stop** sigue
muerto y sirve de control: la diferencia entre el Δ de Gold y el de Cocos es del
**0,6%** en las 26 celdas, ninguna con p < 0,05. El **corte por zona cedida**
mejora en su versión gratis pero el implementable sigue destruyendo valor
(−0,43% y −0,25%/mes), y el **92% de ese daño es precio, no comisión**. El
**filtro de volatilidad** vale todavía menos que antes: ahora que la expectancy
por trade es positiva, recortar trades cuesta plata — percentil 34 del nulo en
el OOS. El **score ≥ 9** cuadruplica el trade promedio (de $3.419 a $13.450) y
concentra el 52% del resultado en el 13% de los trades, pero baja el mensual en
las dos ventanas y no llega a p < 0,05.

**Lo que hay que corregir en la lectura de la §1 y la §8 de este informe.** El
punto 1 de "¿dónde está el edge?" —la tarifa— queda **confirmado y llevado a su
conclusión**: la palanca era tan grande que sola da vuelta el signo. Pero la
§8 decía que en Black la estrategia "queda en cero"; con Cocos hay que agregar
que **queda en +0,26/+0,32%/mes, y que en el in-sample eso es enteramente el
dólar**. La descomposición de la §1 (papel −0,043%, CCL +0,403% en el IS) no
cambia, pero pasa a primer plano: sin arrastre del CCL, el bot en Cocos habría
dado **−0,18%/mes en el in-sample**. Con la tarifa de Cocos, el in-sample no es
selección de papeles, es **carry de dólar con 0,121% de peaje**. En el
out-of-sample sí hay edge de precio (+0,363 puntos mensuales de papel contra
+0,117 del dólar) y es la única evidencia del proyecto a favor de que el motor
seleccione algo.

Ese anexo agrega **2** configuraciones (el corte post-hoc por score ≥ 9 en las
dos ventanas), de modo que **el N del DSR pasa de 172 a 174**: la tarifa no suma
al N porque no es un grado de libertad buscado en los datos, y las 172
anteriores ya se evaluaban en tres tarifas contando una vez (igual se reporta la
versión paranoica, N = 346). σ(SR) se reconstruyó sobre las mismas 160 variantes
—gold 5,2146e−2 contra el 5,2149e−2 publicado, black 3,7987e−2 contra
3,7895e−2— y el de Cocos queda en **3,6560e−2**. El mejor DSR que produce Cocos
es **0,9609 y pasa 0,95** — pero es la misma corrida prohibida de la §12:
"operar sólo lo que cerró arriba del nivel" en el OOS, n = 29, cartera que no se
puede armar (ejecutada de verdad da −0,25%/mes). Con el N paranoico queda en
0,944 y no pasa. **El mejor DSR de una cartera armable es 0,336** (los 50, Cocos,
IS); el caso base de los 38 está en 0,082 y 0,148.

**El veredicto operativo:** con la tarifa de Cocos el bot es rentable pero
chico — entre $18.000 y $22.600 por mes sobre $7.000.000, o entre $52.000 y
$62.000 con el universo optimista de 50. El piso de 3% mensual que pide LP son
$210.000: el caso base llega al 9-11% de ese piso y el universo de 50 al 25-29%.
**Aun con costo cero el techo del sistema es +0,39%/mes (IS) y +0,48%/mes
(OOS)**, así que ni regalando la comisión entera se llega: falta un factor de 6
a 8. Después de este anexo, la palanca de la tarifa queda agotada; lo único que
queda por subir es el bruto.

---

## 15. Anexo · ¿se llega al 3% mensual entrando más agresivo y más grande?

Séptima pregunta posterior, y la más grande: el §14 cerró con "la palanca de la
tarifa queda agotada; lo único que queda por subir es el bruto", y el §1 había
dejado anotado que de 528 señales del in-sample sólo 111 terminan en trade
porque **278 órdenes expiran sin que el papel baje al nivel**. La hipótesis
natural: entrando más arriba se llenan muchas más órdenes, y si el edge cae
menos que proporcionalmente, el producto (operaciones × tamaño × edge) sube.
Contestado aparte en **`INFORME-AGRESIVIDAD.md`** (script `agresividad.js`,
mismo motor y mismas convenciones; el chequeo de arranque reproduce las 56
métricas de las cuatro tarifas del `38/base` de las dos ventanas contra
`results.json` y `results-cocos.json` con 0 descuadres, y aborta si aparece
uno). Se barrieron cinco niveles de agresividad de entrada (nivel exacto,
límite +0,25%, +0,50%, +1,00%, y a mercado en sus dos versiones), las dos
convenciones de stop/target (fijos al nivel o móviles con la entrada), cinco
topes de tamaño (20% a 60%), cuatro topes de posiciones simultáneas (3, 5, 8,
10) y cuatro niveles de spread.

**La respuesta corta es que no, y el motivo no es el que suponía la hipótesis.**

**El dato que reordena la pregunta, y que no estaba medido en ningún informe
anterior: el nivel de entrada está en promedio 4,4% por debajo del precio del
momento de la señal** (3,8% en el OOS). El motor define la entrada como el techo
de la zona de soporte más cercana debajo del spot, y esa zona vive donde hay
pivotes. O sea que la orden pide que el papel caiga 4,4% en 48 horas. Subir el
límite un punto entero es moverse menos de un cuarto del camino: **la tasa de
llenado pasa de 21,0% a 28,6% y ahí se queda**, comprando 40 trades más en 20
meses. El edge bruto por operación, mientras tanto, se cae de 0,360% a 0,135%
en el in-sample y sube de 0,372% a 0,433% y después baja a 0,345% en el
out-of-sample: las dos ventanas dicen cosas opuestas sobre el mismo escalón.
**Ninguno de los tres escalones de límite produce algo distinguible del caso
base.** El único que llena de verdad es entrar a mercado (55-70% de llenado,
2,0-2,4%/mes), pero paga el premio de 4,4% entero: ya no compra soportes,
compra pantalla.

**Lo que encontró el barrido y da vuelta la premisa del motor.** Partiendo los
trades de cada variante agresiva entre los que igual se hubieran llenado con el
límite en el nivel y los que sólo existen porque se pagó de más: los que **nunca
tocaron el nivel** rinden **+1,75% bruto por operación** y los que **sí lo
tocaron** rinden **−1,05%**, con p < 0,0001 en las dos ventanas y el mismo signo
en las ocho celdas. Es el mismo hallazgo que el §12 encontró en la barra del
fill ("cerró arriba del nivel") y el §14 confirmó con Cocos, ahora en el momento
de elegir el tipo de orden — que es exactamente donde los dos informes decían
que había que probarlo. **Comprar un soporte con paciencia es, por
construcción, quedarse sólo con los papeles que están cayendo.** La variable
sigue sin ser accionable de forma directa (se sabe después), pero acá por fin
tiene una lectura operativa: la única manera de ejecutarla es no esperar.

**Lo demás, en orden.** La convención de stop/target **móvil** domina en
promedio en el IS (+0,89% contra +0,78%), pero el corte real es el tamaño del
premio: hasta medio punto conviene **fijo** (el kit se queda donde el motor lo
puso), y entrando a mercado conviene **móvil** (si no, el trade queda con stop
de 6% y target de 1%: win rate 63,7% y payoff 0,85). El **tamaño** escala casi
lineal y el drawdown también (de 20% a 60% por posición el mensual se triplica
y el drawdown se multiplica por 2,7), pero **sólo si se permite exposición
arriba del 100%**: con el tope de caja intacto, agrandar la posición cambia
cinco apuestas chicas por dos grandes y el caso base pasa de +0,26% a −0,28% en
el IS. El tope de posiciones no muerde arriba de 5 (8 y 10 dan las mismas 120
operaciones) y destruye el resultado abajo (3 posiciones: +0,01%).

**La grilla y el 3%.** De 120 celdas, **12 llegan o superan el 3% mensual y 10
necesitan apalancamiento de 1,5x a 3x** (el funding de la caución, 0,069% por
día corrido, les saca hasta 1,03 puntos mensuales). Las dos que no lo necesitan
aparecen **sólo en el out-of-sample**. **En el in-sample ninguna celda sin
apalancamiento llega a 3%: el techo es 2,27%.**

**El walk-forward.** La celda elegida mirando sólo el IS —a mercado en la
apertura de la barra siguiente (la versión pesimista), stop/target móviles, 30%
por posición, sin apalancar— da **+2,23%/mes en el IS y +2,44%/mes en el OOS**,
con drawdowns de 12,7% y 9,7%. Aguantó: es la única configuración del proyecto
que se eligió en el IS y no se desinfló afuera. Pero no le gana al nulo de
selección en el in-sample (percentil 67, p = 0,33; en el OOS queda al filo,
p = 0,053), el bootstrap de bloques de la mejora contra el base incluye el cero
en las dos ventanas (IC 90%: −0,47 a +4,16 en el IS, −0,06 a +4,43 en el OOS) y
el nulo de exposición muestra de dónde sale: **el caso base no puede alcanzar la
exposición de la variante agresiva ni agrandando la posición al 116% del
capital** —se queda en 0,37 contra 0,59— y forzando la comparación, la ventaja
es de 1,32 puntos en el IS pero sólo 0,42 en el OOS.

**El spread, por primera vez medido.** Calibrado con `cedear_fv_log` (Supabase,
sólo lectura: 1.750.080 filas, 209 CEDEARs, 71 días), la horquilla media
ponderada de los papeles del universo es **0,25%** (de 0,158% en MU a 0,969% en
JNJ). Cobrando media horquilla por cada punta que cruza, **el caso base de Cocos
pasa de +0,26%/+0,32% a +0,12%/+0,16%** y la celda elegida de +2,23%/+2,44% a
+1,26%/+1,24%. **La mitad del resultado que publicaba el §14 era una horquilla
que no estaba modelada**, tal como ese mismo informe advertía en su §6.

**Y el control que faltaba en todo el proyecto.** Como cualquier variante que
llena más órdenes sube la exposición media, hay que compararla contra estar
simplemente comprado a esa misma exposición. **SPY en pesos, comprado y no
tocado, dio +3,98%/mes en el in-sample y +4,11%/mes en el out-of-sample**
(drawdowns de 26,8% y 13,6%); el índice equiponderado de los 38, +7,61% y
+6,88%. Contra ese benchmark escalado a la exposición de cada variante, **once
de doce celdas dan exceso negativo**, incluido el caso base del bot (−0,15 en el
IS, −0,07 en el OOS) y la celda elegida (−0,11 y +0,11, o sea cero). Eso
generaliza lo que el §14 decía del CCL —"el mismo carry lo consigue LP comprando
el CEDEAR y no tocándolo"— y lo extiende al activo entero: **el 3% mensual que
pide LP, en estas dos ventanas, lo daba el 75% del capital parado en un CEDEAR
de índice, sin operar.** La advertencia obligatoria: es un camino realizado en
un período de devaluación más mercado americano en subida, no una ley — pero es
la vara correcta para las mismas dos ventanas en las que se mide el bot.

Ese anexo agrega **150 configuraciones** (variante de entrada × convención de
stop/target × tope por posición × tope de posiciones × permiso de
apalancamiento × ventana, deduplicadas), de modo que **el N del DSR pasa de 174
a 324** (paranoico, de 346 a 496). No entran en el N los 5.000 sorteos de cada
nulo, las 73 corridas de calibración del nulo de exposición ni el barrido de
spread (el spread es un dato del mercado, misma convención que la tarifa).
σ(SR) de Cocos queda en 3,6559e−2 (la publicada, sobre las 160 variantes
previas) y 4,3712e−2 calculada sobre las 150 nuevas; se reportan las dos sin
elegir. **El mejor DSR del anexo es 0,632** (la celda elegida, OOS, Sharpe 1,99)
— el más alto que produjo hasta hoy una cartera armable, contra el 0,336 previo,
y sigue muy lejos de 0,95. El castigo por multiplicidad no es cosmético: pasar
de 174 a 324 miradas le saca 5 puntos de DSR a esa misma corrida y usar el σ
nuevo le saca 15 más.

**Lo que hay que corregir en la lectura de este informe.** El §14 decía que "lo
único que queda por subir es el bruto"; este anexo muestra que el bruto **sí**
se puede subir (de 0,36% a 0,70-0,83% por operación entrando a mercado) y que
aun así no alcanza, porque lo que sube con él es la exposición y el resultado no
le gana a tener esa exposición quieta. Y agrega un costo que ninguno de los
informes anteriores tenía: **el spread del CEDEAR, 0,25%, que es el doble de
toda la comisión de Cocos.** Todo lo demás —la descomposición del edge, el
veredicto de la tarifa, el signo del caso base— queda confirmado.

---

## 16. Anexo · ¿dónde va el TP parcial ahora que la entrada es a mercado?

Octava pregunta posterior, abierta por el propio §15: el motor vende la mitad de
la posición al 50% del camino al target (`TP_PARCIAL_FRAC_CAMINO = 0,5`), pero
ese parámetro se congeló cuando la entrada era una orden límite **en** el
soporte. Con la entrada a mercado que eligió el walk-forward del §15, "la mitad
del camino" cae en otro lugar y el parcial protege distinto. Contestado aparte
en **`INFORME-PARCIAL.md`** (script `parcial.js`, mismo motor y mismas
convenciones; el chequeo de arranque reproduce el `+2,23% / +2,44%` de
`INFORME-AGRESIVIDAD` y el `38/base` de las cuatro tarifas en 80/80
comparaciones, y aborta si aparece una sola). Se barrieron nueve puntos de
disparo (sin parcial, 25%, 40%, 50%, 60% y 75% del camino, y tres anclados al
breakeven: BE+0,5%, BE+1% y BE+2%) por tres fracciones vendidas (25%, 50%, 75%),
con y sin la guarda de breakeven que pidió LP, con y sin el spread de 0,25%.

**La guarda del breakeven es redundante, y no por casualidad.** El parcial nunca
dispararía en pérdida: el disparo más agresivo del barrido —25% del camino
aplicado al trade de target más corto de la muestra— cae en **+0,68% sobre la
entrada**, y el breakeven está en **+0,12%** (+0,37% con el spread de 0,25%).
Sobre **200 celdas evaluadas, 0 trades** dispararían abajo del breakeven y
**0 de 48 celdas** cambian de resultado con la guarda puesta. El motivo es el
gate: exigir R:R ≥ 2 y un stop que nunca es más corto que 1×ATR deja el target,
en el peor caso de la muestra, a 2,70% de la entrada. **Si alguna vez se afloja
el R:R mínimo, la guarda pasa a hacer falta.**

**El parámetro actual está mal puesto, y la corrección es apagarlo.** La celda
(50% del camino, 50% vendido) queda **14ª de 25** en el in-sample. La ganadora
del in-sample es **no hacer parcial**: +2,81%/mes en el IS y +2,69% en el OOS
—contra +2,23% y +2,44%— y con **menos** drawdown (10,9% y 9,5% contra 12,7% y
9,7%). Con el spread de 0,25%, +1,93% y +1,57% contra +1,26% y +1,24%. La
estructura del barrido es limpia y monótona en las dos ventanas: **vender menos
es mejor en 15 de 16 comparaciones y vender más tarde es mejor en casi todas** —
las dos perillas apuntan al mismo límite, que es no vender.

**No hay intercambio retorno/drawdown que evaluar.** En el in-sample apagar el
parcial gana en retorno en 24 de 24 celdas y en drawdown en 21 de 24. El parcial
**sí** baja la varianza diaria (16 de 24 celdas mejoran el Sharpe; la mejor,
BE+2% al 50%, da 1,64 contra 1,46) y **sí** recorta la cola derecha (el mejor
trade del in-sample pasa de $1.024.859 a $602.011, y el decil superior explica
del 188% al 353% del resultado total según la celda), pero **no compra
drawdown**: el 61% de los trades muere en un stop seco sin que el parcial llegue
a dispararse nunca. El parcial sólo puede tocar los trades que ya se movieron a
favor, y el drawdown de esta cartera está hecho de rachas de stops secos.

**Contra los nulos, la mejora no aparece.** Contra un parcial puesto al azar en
el camino (5.000 sorteos), la celda ganadora queda en el **percentil 92,5 del
in-sample (p = 0,075)** —no cruza— y en el 96,6 del out-of-sample; contra el
nulo completo que sortea las dos perillas, percentil **77,6 (p = 0,224)** y 93,9.
El bootstrap de bloques de la mejora contra el parámetro actual **incluye el
cero en las dos ventanas** (IC 90%: −0,44 a +1,75 en el IS, −0,32 a +0,94 en el
OOS). Y el nulo de selección de órdenes sigue sin cruzar (percentil 71,6 IS,
88,1 OOS): apagar el parcial no arregla lo que ya estaba roto.

**El benchmark.** Sin spread, apagar el parcial da **+0,25 pp/mes de exceso en
el IS y +0,18 en el OOS** contra SPY en pesos escalado a la misma exposición —
el primer exceso positivo en las dos ventanas de todo el proyecto. **Con el
spread medido de 0,25%, las 25 configuraciones dan exceso negativo en las dos
ventanas sin una sola excepción**, y la ganadora queda en −0,63 y −0,94.

Ese anexo agrega **48 configuraciones** (punto de disparo × fracción vendida ×
ventana, deduplicadas, menos la celda 50%/50% que ya estaba contada como la
elegida del §15), de modo que **el N del DSR pasa de 324 a 372**; la guarda de
breakeven no suma porque produce carteras idénticas al número, y la versión
paranoica que igual la cuenta deja N = 594 (de 496). σ(SR) de Cocos queda en
2,8910e−2 calculado sobre las 48 celdas nuevas (contra 3,6559e−2 publicado y
4,3712e−2 del §15); la nueva es más chica porque el barrido es más angosto y las
celdas se parecen entre sí, así que castiga menos. **El detalle sin maquillar:
la celda ganadora de este anexo tiene un DSR MÁS BAJO que la que venía de antes**
—0,3495 contra 0,3544 en el IS y 0,6078 contra 0,6212 en el OOS— porque da más
plata con casi el mismo Sharpe diario y el N creció. El récord del proyecto para
una cartera armable sigue siendo el del §15, re-deflactado a **0,6212**.

**Lo que hay que corregir en la lectura del §15.** Nada de lo cuantitativo: la
celda elegida ahí sigue siendo la referencia y sus números se reprodujeron
exactos. Lo que se agrega es que **uno de sus componentes heredados —el TP
parcial al 50% del camino— estaba costando entre 0,25 y 0,58 puntos mensuales**
y no estaba comprando el drawdown que justificaba tenerlo. Si LP toca el
parámetro del worker, la recomendación defendible no es apagarlo de una sino
**moverlo al 75% del camino vendiendo el 25%** (2ª del in-sample con +2,78% y
drawdown 10,9%, 3ª del out-of-sample con +2,77%): está a 0,03 puntos de la
ganadora, o sea dentro del ruido, y deja el mecanismo puesto.

---

## 17. Anexo · el test placebo · el motor mide bien, y lo que mide es nada

Novena pregunta posterior, y la que había que hacer primero: **todo lo anterior
se apoya en que el motor y el simulador miden bien, y eso nunca se validó contra
datos sin señal.** Contestado aparte en **`INFORME-PLACEBO.md`** (script
`placebo.js`, que no reusa el cache: regenera las 55.937 señales desde
`engine.js` y las compara una por una contra `signals.json` —huella FNV-1a
`9b5b5f58` idéntica— y reproduce el caso base de Cocos en +0,2603% y +0,3236%;
aborta si cualquiera de las dos cosas falla). Se corrió la cañería completa sobre
**400 universos sintéticos**: random walk gaussiano con la misma volatilidad y el
mismo drift (100), bootstrap de los retornos horarios reales (100), bootstrap de
bloques de 5 barras (100), y un cuarto placebo propio con los retornos centrados
y el dólar sin deriva (100), cada uno con el CCL real y con el CCL aleatorizado.

**La cañería está sana.** Sobre el placebo puro —drift cero por papel, CCL sin
deriva— la máquina entrega **−0,02%/mes (IS) y −0,05%/mes (OOS)** contra un costo
de Cocos de −0,09, o sea que produce el costo y nada más; el residuo bruto de
+0,067 pp/mes es, entero, el **término de Jensen** de centrar retornos
logarítmicos (σ²/2 = 0,844%/mes del activo a la exposición de esta cartera).
De los tres sospechosos que había que revisar: **el orden intrabarra de stop y
target da Δ = 0,000** en las dos ventanas (en 205 trades no hay una sola barra
que toque las dos puntas), y **el fill al toque sin confirmación va para el otro
lado** (esperar el cierre de la barra mejora el real en +0,03 pp IS y +0,15 pp
OOS). El tercero sí existe pero no es señal fabricada sino **un costo que este
informe nunca modeló: el stop se ejecuta siempre en el nivel exacto, aunque la
barra haya abierto por debajo.** Cobrándolo, el caso base de Cocos pasa de
+0,260% a **−0,071%/mes (IS)** y de +0,324% a **+0,030%/mes (OOS)**. Son 0,33 y
0,29 pp/mes, encima de los 0,14/0,16 del spread del §15: con los dos, el caso
base queda en **−0,21% y −0,13%/mes**.

**Y lo que la cañería mide es nada.** Con el CCL real, los 100 universos de puro
ruido dan **+0,245%/mes (bootstrap) y +0,234%/mes (bloques)** en el in-sample, y
+0,223% / +0,285% en el out-of-sample. El resultado real —comparado contra el
control de construcción, que es la referencia correcta— cae en el **percentil 58
(IS, p = 0,43) y 62 (OOS, p = 0,39)** del bootstrap. **En 42 de cada 100
universos de ruido con el mismo drift y el mismo marginal, el mismo motor sacó
más plata que con los datos de verdad en el IS; 38 de cada 100 en el OOS.**
Ninguna de las 16 comparaciones de mensual ni de las 8 de bruto por operación se
acerca a p < 0,05. El motor encuentra además el **83-85% de las señales** sobre
retornos mezclados al azar: los pivotes, las zonas de ±0,6% y el score no
detectan estructura de mercado, detectan que una serie de precios tiene rango.

**El CCL aleatorizado confirma de qué estaba hecho el in-sample.** Sin deriva del
dólar el caso base real da **−0,174%/mes** (la descomposición contable del §14
decía −0,18%: dos caminos independientes, el mismo número) y cae al **percentil
17** del bootstrap: apagado el dólar, el bot rinde *peor* que elegir soportes al
azar sobre series mezcladas. Medido sólo por la parte del papel, en el in-sample
el motor está en el **percentil 15-21** de los placebos que conservan el drift.

**Lo que hay que corregir en la lectura de este informe.** La §14 decía que el
+0,363 pp/mes de papel del out-of-sample era *"la única evidencia del proyecto a
favor de que el motor seleccione algo"*: está en el **percentil 61-64** del
placebo (p = 0,37-0,40) y **no es evidencia**. La §1 decía que el edge bruto del
motor es 0,36%/0,37% por operación: es lo mismo que el motor produce sobre ruido
(0,33-0,42%). Y el in-sample no fue neutro, fue **peor que el azar**. Lo que el
placebo **no** toca: los modelos nulos de las §10 a §13 y §16 —todos miden
diferencias contra el base con la misma cañería de los dos lados—, la cadena de
consistencia del port, el veredicto de la tarifa del §14 y el del benchmark del
§15, que el placebo confirma por otra vía: **el bot produce sobre los datos
reales lo mismo que produce sobre retornos mezclados al azar.**

Ese anexo **no agrega configuraciones al N del DSR**: los 400 universos no son
candidatos evaluados en los datos, son la distribución de referencia contra la
que se juzga el caso base, igual que los 5.000 sorteos de los nulos anteriores.
El N queda en 372 (paranoico 594).

---

## 18. Anexo · la revisión de un tercero · el nulo de bloques no era el correcto, el 79% sí era granularidad, y el test de pasa-vs-bloquea no tenía poder

Décima pregunta posterior, y la primera que **no** la hizo LP: el método del
nulo de bloques de `INFORME-NULO.md` §1 se publicó en un foro y el usuario
**`mazda_miata`** respondió con dos aportes de método y una corrección de
lectura. Los tres se implementaron tal cual los planteó y están contestados
aparte en **`INFORME-ROTACION.md`** (script `rotacion.js`, mismo motor y mismas
convenciones; el chequeo de arranque reproduce las 20 celdas de la §3 con
Δ = 0, **el nulo de bloques publicado en 17/17 celdas con Δp = 0,0e+0**, la zona
de la señal en 205/205 trades y la tabla del 79% de `INFORME-BARRIDO.md` §6 en
12/12 celdas). **Las tres críticas son correctas.**

**1. El nulo de bloques no era plenamente intercambiable, y se reemplazó.** El
nulo 2 de `INFORME-NULO.md` sorteaba las posiciones de arranque de cada bloque
apagado **de forma independiente**, y eso destruye el acoplamiento entre la
duración de un bloque y el estado del mercado: permite que el bloque de 69
ruedas caiga donde el mercado estaba tranquilo, que es una configuración que el
proceso real no puede producir. El reemplazo que propone es tomar la serie
indicadora de encendido/apagado como **un objeto rígido y rotarla módulo T**
(`estado[(t + j) mod T]`), lo que preserva por construcción el multiconjunto
completo de duraciones, el orden de los bloques y los huecos, porque nunca se
corta la serie. El artefacto de costura —el bloque que queda a caballo del punto
de corte y se parte en dos— se resolvió **restringiendo las rotaciones a las que
no parten ningún bloque**, y se verificó que el total de días apagados y el
multiconjunto de duraciones se preservan exactamente en las T rotaciones de los
17 gates. Como hay sólo T rotaciones distintas, **el p es exacto por enumeración,
no Monte Carlo**, y el bloque entero cuesta 6.264 simulaciones en vez de 85.000.

**Ninguna conclusión cambia.** Los 17 gates siguen sin llegar a p < 0,05: el
filtro de volatilidad pasa de p = 0,4095 a **0,4359** en el IS y de 0,5301 a
**0,4476** en el OOS; el régimen del worker, de 0,3231 y 0,5721 a **0,3414** y
**0,5560**; el mejor de toda la tabla sigue siendo el control opuesto al del bot
(`SPY<EMA200`, IS) con p = 0,2245 en Gold y **0,1020** en Black. La celda de
`INFORME-COCOS.md` §D.4 —la única otra que se había evaluado contra este nulo—
pasa de 0,1932 a **0,1709** (IS) y de 0,6605 a **0,5952** (OOS). La mediana de
la diferencia absoluta de p en los 17 gates es **0,018**. El desvío del nulo de
rotación es **0,958×**
el del nulo de bloques: apenas 4% más angosto. **La crítica es válida en el
mecanismo y casi irrelevante en la magnitud, y eso no la hace menos correcta:
publicamos un nulo mal construido que daba lo mismo por casualidad.** Lo único
que hay que suavizar de `INFORME-NULO.md` es la frase "apagar el bot en fechas
al azar hubiera salido mejor" en el OOS con Black: con el nulo correcto el
filtro queda en la mitad de la distribución (percentil 43,5), no debajo. Aparece
además un detalle que no se había visto: en 3 de los 17 gates —los tres
controles— **la propia serie real cruza la costura**, así que el conteo de
bloques publicado tenía uno de más.

**2. El 79% SÍ era, en buena parte, granularidad. Esto corrige `INFORME-BARRIDO.md`
§6.** Ese anexo había partido la respuesta en dos: el número exagera (cae a
37,1% con tolerancia ±2%) pero *"la muerte de la señal NO es artefacto: es una
propiedad del motor"*. El test que propone el tercero no necesita datos de tick:
si es granularidad, la tasa de desacuerdo tiene que **escalar con el rango
intrabarra de la barra del fill medido en unidades del ancho de la zona**. Se
corrió con tres definiciones de ancho (la amplitud del clúster `zonaHi − zonaLo`,
que no existe en 113 de 205 trades porque la zona tiene un solo pivote; la banda
de agrupamiento `ZONE_TOL × nivel` = 0,6%; y el máximo de las dos) y las cuatro
tolerancias. **La tasa no es plana: crece en las 12 celdas, sin una sola
excepción.** Con la banda de agrupamiento va de 56,1% a 75,6% entre quintiles
extremos con ±0,5% y de **17,1% a 53,7% con ±2%** (Spearman ρ = 0,29,
p = 0,00004; logit b₁ = 0,86 sobre log ratio, p = 0,0003; replica en las dos
ventanas). Los tres asteriscos, sin maquillar: en la tolerancia publicada de
±0,5% la tendencia es **marginal** (ρ = 0,129, p = 0,065) y no replica por
ventana; el ratio no separa granularidad de "la barra fue ancha porque el
soporte se rompió de verdad"; y extrapolando el modelo a granularidad perfecta
queda un **piso de 51-57% (±0,5%) y 8-13% (±2%)** que la granularidad no
explica. **El 79% se parte en tres, no en dos: elección de zona vecina,
granularidad de la barra horaria, y una extinción residual por construcción del
motor. Sólo la tercera es propiedad del motor.**

**3. El test de pasa-contra-bloquea no tiene poder, y lo presentamos como si lo
tuviera.** Su aritmética se verificó al cuarto dígito: IS diferencia $11.576 con
t = 1,08 implica SE = **$10.698** y un efecto mínimo significativo de **$20.967**
—1,81× el observado—; OOS diferencia $3.043 contra SE **$8.676**, mínimo
detectable **$17.005**, y **31,2×** más operaciones para que el efecto observado
llegue a ser significativo. El poder formal: **19,1% de potencia en el IS y 6,4%
en el OOS**, cuando el piso de cualquier test con α = 0,05 es 5%. Para 80% de
potencia harían falta **744 trades en el IS y 5.999 en el OOS**, contra los 111
y 94 que hay — unos 11 y unos 85 años a la cadencia del bot (5,9 operaciones por
mes). **Ese test no es
corroboración independiente del modelo nulo: es no informativo en las dos
direcciones**, y no puede decir ni que el filtro selecciona ni que no
selecciona. Hay que bajarlo de la lista de evidencia del §8 de
`INFORME-NULO.md`, que pasa de cuatro patas a tres. El veredicto sobre el filtro
de volatilidad **no cambia**, porque se apoya en el nulo (ahora de rotación), en
el lookahead del umbral y en el barrido monótono del cuantil, y ninguno de esos
depende del test de expectancy. Los dos p "significativos" que ese §3 reportaba
—con n = 2 y n = 5 del lado bloqueado— son el reverso del mismo problema.

Ese anexo **no agrega configuraciones al N del DSR**: las T rotaciones son la
distribución de referencia contra la que se juzga una configuración, igual que
los 5.000 sorteos que reemplazan; los cortes por quintil de ratio son
descriptivos sobre los mismos 205 trades del caso base y no tienen curva de
equity propia; y el cálculo de poder no evalúa ninguna configuración. **El N
queda en 372 (paranoico 594) y σ(SR) no se recalcula.** El cambio de nulo
tampoco afecta a ningún DSR publicado: el DSR se deflacta por cuántas
configuraciones se probaron y por la dispersión de sus Sharpe, y ninguna de las
dos cosas depende de con qué nulo se juzgó cada una. El mejor DSR de una cartera
armable sigue siendo **0,6212**.

**Lo que hay que corregir en la lectura de este informe.** De la §10: los
percentiles y p del nulo de bloques hay que leerlos con los de rotación de la
tabla de `INFORME-ROTACION.md` §2 — el veredicto "el filtro no selecciona, sólo
recorta exposición" queda **confirmado**, pero uno de sus cuatro apoyos (el test
de expectancy) queda **anulado por falta de poder**. De la §12: la frase "la
muerte de la señal NO es artefacto: es una propiedad del motor" hay que leerla
como **"una parte de la muerte de la señal es propiedad del motor y otra parte
—creciente con el rango de la barra— es granularidad horaria"**. Todo lo demás
del informe —el signo del caso base, la descomposición del edge, el veredicto de
la tarifa, el benchmark de la §15, el placebo de la §17— queda **intacto**: esta
revisión no toca ninguno de esos resultados.

---

*Generado offline el 17/09/2026 sobre las series de `research/backtest-5y/data`
(50 símbolos, 5.094 barras horarias 2023-10-19 → 2026-09-17, 1.255 ruedas
diarias, CCL de argentinadatos). Motor portado de
`workers/niveles-auto/worker.js`. Scripts: `engine.js`, `simulate.js`. Detalle
completo en `results.json` y `run.log`; aproximaciones y anti-lookahead en
`README.md`.*
