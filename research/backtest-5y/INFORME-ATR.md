# Stops por ATR — ¿alejar el stop compensa?

Corrido el 22-23/09/2026 a pedido de LP. Script `atr.js`, salida `run-atr.log`, datos `results-atr.json`. Todo local, sin tocar el VPS ni Supabase.

## Lo que hay que saber primero

1. **No mejora. El OOS dice que no.** En el out-of-sample ninguna configuración por ATR le gana al stop geométrico en Cocos, y en Platinum sólo k=1,5 mejora, por 0,04 pp, que es ruido. Con la regla fijada de antemano (elegir k por el mejor Platinum del IS) sale **k=2,5, que en el OOS da −0,92%/mes contra −0,73% del geométrico**: 0,19 pp peor. En Cocos, de +0,03% a −0,47%.
2. **La mejora del IS es arrastre del dólar, no del stop.** En el IS el ATR parece un salto enorme (Gold de −1,16% a +0,16%/mes). Pero el aporte del *papel* por operación sigue en cero (−0,28% / +0,06% / +0,00% del nocional). **Todo el bruto nuevo es CCL**, de 0,40% a 1,24-1,58%. Pasa porque con el stop lejos la posición dura 5 a 7 veces más (mediana de 24 h a 121-166 h), y en 2023-2025 estar más tiempo comprado en pesos era cobrar la devaluación. Es el mismo hallazgo de §14 con otra forma.
3. **El nulo no distingue.** Si se usa el ATR del mismo papel pero de otra fecha (rotación circular, p exacto), sale lo mismo o mejor. Ninguna celda baja de p=0,34 y en el IS las tres quedan **debajo** de la mediana del nulo (percentil 30-43). Alinear el stop con la volatilidad del momento no aporta nada. Lo único que "hace algo" es el ancho, y eso es un dial de exposición.
4. **El diagnóstico de LP era correcto.** El stop geométrico está a **0,67σ (IS) y 0,59σ (OOS)** en mediana, con probabilidad de tocarlo en un día de 51-56%. **El tope del 20% manda en el 100% de los trades**, y el riesgo real por operación queda en **0,40% de mediana (rango 0,26%-0,96%)**, no en el 1,5% del parámetro. El problema existe. Lo que no aparece es que arreglarlo gane plata.

## Qué se corrió

Mismas señales, mismo gate y mismo target para las cuatro configuraciones. El gate se evalúa sobre el kit original del motor, así que el conjunto de órdenes es idéntico: 528 en el IS y 371 en el OOS, 38 papeles limpios. Cambia sólo el stop:

- **geo**: el stop del motor, abajo del soporte (el caso base).
- **atrK**: stop = entrada − K × ATR(14) diario, con K = 1,5 / 2 / 2,5. ATR de Wilder sobre barras diarias con fecha anterior a la señal, o sea point-in-time.

Sizing con la regla real: qty = 7M × 1,5% / distancia al stop, con tope de 20% del capital y tope de capital libre. El trailing del bot es en unidades de R (arranca en +2R), así que con un stop más ancho el trailing también arranca más lejos. Es parte del efecto, y por eso en ATR el trailing cae a 0%.

El stop ejecuta con el **fix del gap** (llena al mínimo entre el stop y la apertura). **Chequeo de consistencia: PASÓ.** La configuración geo reproduce `results.json` al bit: n=111/94, Gold −1,159811 / −1,239238.

## Tabla principal

Mensual = P&L total / capital / meses. Exceso = mensual − (SPY en pesos B&H × exposición media de la variante). SPY B&H: +3,98%/mes en el IS y +4,11% en el OOS.

### In-sample (2023-10-19 → 2025-06-30, 20,4 meses)

| config | trades | % stop | % target | % trailing | tenencia med. | tope 20% manda | riesgo real med. |
|---|---|---|---|---|---|---|---|
| geo | 111 | 66,7% | 26,1% | 6,3% | 24 h | 100% | 0,40% |
| atr1.5 | 94 | 46,8% | 52,1% | 0,0% | 121 h | 62% | 1,30% |
| atr2 | 85 | 36,5% | 62,4% | 0,0% | 144 h | 38% | 1,50% |
| atr2.5 | 82 | 32,9% | 65,9% | 0,0% | 166 h | 27% | 1,50% |

| config | tier | exp/trade | total | mensual | Sharpe | maxDD | exceso vs SPY |
|---|---|---|---|---|---|---|---|
| geo | Gold | −$14.899 | −$1.653.743 | −1,16% | −1,93 | 25,4% | −1,57 |
| geo | Platinum | −$9.302 | −$1.032.536 | −0,72% | −1,22 | 17,9% | −1,13 |
| geo | Cocos | −$907 | −$100.726 | −0,07% | −0,09 | 7,2% | −0,48 |
| atr1.5 | Gold | −$3.818 | −$358.926 | −0,25% | −0,28 | 17,3% | −0,93 |
| atr1.5 | Platinum | +$1.780 | +$167.278 | +0,12% | 0,20 | 13,3% | −0,56 |
| atr1.5 | Cocos | +$10.176 | +$956.584 | +0,67% | 0,89 | 9,0% | −0,01 |
| atr2 | Gold | +$147 | +$12.481 | +0,01% | 0,06 | 16,0% | −0,74 |
| atr2 | Platinum | +$5.188 | +$440.967 | +0,31% | 0,45 | 13,2% | −0,44 |
| atr2 | Cocos | +$12.749 | +$1.083.695 | +0,76% | 1,01 | 11,1% | +0,01 |
| atr2.5 | Gold | +$2.736 | +$224.330 | +0,16% | 0,27 | 12,3% | −0,55 |
| atr2.5 | Platinum | +$7.198 | +$590.260 | +0,41% | 0,62 | 9,7% | −0,29 |
| atr2.5 | Cocos | +$13.892 | +$1.139.155 | +0,80% | 1,13 | 7,2% | +0,10 |

### Out-of-sample (2025-07-01 → 2026-09-17, 14,6 meses) — mirado una sola vez

| config | trades | % stop | % target | % trailing | tenencia med. | tope 20% manda | riesgo real med. |
|---|---|---|---|---|---|---|---|
| geo | 94 | 58,5% | 35,1% | 6,4% | 24 h | 100% | 0,40% |
| atr1.5 | 74 | 44,6% | 54,1% | 0,0% | 97 h | 64% | 1,31% |
| atr2 | 73 | 41,1% | 57,5% | 0,0% | 123 h | 33% | 1,50% |
| atr2.5 | 67 | 38,8% | 59,7% | 0,0% | 163 h | 18% | 1,50% |

| config | tier | exp/trade | total | mensual | Sharpe | maxDD | exceso vs SPY |
|---|---|---|---|---|---|---|---|
| geo | Gold | −$13.431 | −$1.262.547 | −1,24% | −2,19 | 21,7% | −1,64 |
| geo | Platinum | −$7.930 | −$745.434 | −0,73% | −1,30 | 16,7% | −1,13 |
| geo | Cocos | +$322 | +$30.235 | +0,03% | 0,09 | 9,5% | −0,37 |
| atr1.5 | Gold | −$15.101 | −$1.117.460 | −1,10% | −1,67 | 23,1% | −1,70 |
| atr1.5 | Platinum | −$9.445 | −$698.939 | −0,69% | −1,03 | 19,2% | −1,29 |
| atr1.5 | Cocos | −$962 | −$71.157 | −0,07% | −0,07 | 13,8% | −0,68 |
| atr2 | Gold | −$18.038 | −$1.316.741 | −1,29% | −2,02 | 25,2% | −1,99 |
| atr2 | Platinum | −$13.020 | −$950.468 | −0,93% | −1,44 | 21,8% | −1,63 |
| atr2 | Cocos | −$5.494 | −$401.059 | −0,39% | −0,57 | 16,9% | −1,09 |
| atr2.5 | Gold | −$18.480 | −$1.238.181 | −1,22% | −1,91 | 24,9% | −2,01 |
| atr2.5 | Platinum | −$13.947 | −$934.470 | −0,92% | −1,41 | 22,0% | −1,71 |
| atr2.5 | Cocos | −$7.148 | −$478.902 | −0,47% | −0,69 | 17,9% | −1,26 |

**Ninguna celda del OOS le gana al benchmark apareado.** En el IS, Cocos con ATR empata a SPY (−0,01 / +0,01 / +0,10 pp). Eso es lo mejor que se puede decir.

## La pregunta de LP: los dos efectos

LP planteó dos efectos opuestos: con el stop más lejos salta menos veces (bueno), pero cada pérdida es más grande y la posición más chica (malo). Los dos se ven en los números. **Lo que decide el signo es un tercer efecto que no estaba en la pregunta: el tiempo de tenencia.**

- **Menos stop-outs: SÍ, y mucho.** Los trades que terminan en stop bajan de 67% a 33-47% en el IS y de 59% a 39-45% en el OOS. El win rate sube de 31-39% a 44-55%. Esta parte funciona como se esperaba.
- **Pérdidas más grandes y posiciones más chicas: SÍ.** Cada stop cuesta 3-5 veces más en precio (el stop mediano pasa de 2,0% a 6,6-11,1%). Con k≥2 el tamaño cae de 20% a 14-17% del capital. El sizing pasa a mandar en 62-82% de los trades, y el riesgo real sube de 0,40% a 1,50%.
- **Separación de los dos efectos (diagnóstico, k=2).** Salida ATR con el tamaño del geo (siempre 20%):
  - IS: Gold −0,58%/mes (geo −1,16, ATR completo +0,01).
  - OOS: Gold **−2,40%/mes** (geo −1,24, ATR completo −1,29).

  En el OOS **la salida por ATR sola pierde el doble que el geo**. Lo único que la salva de un desastre es que el sizing achica la posición. O sea, el efecto del sizing es real y va en la dirección que LP esperaba, pero está tapando una salida peor, no complementando una mejor.
- **La descomposición del bruto (Gold, % del nocional):**

| | IS papel | IS CCL | OOS papel | OOS CCL |
|---|---|---|---|---|
| geo | −0,35% | +0,40% | +0,05% | +0,09% |
| atr1.5 | −0,28% | +1,24% | −0,38% | +0,43% |
| atr2 | +0,06% | +1,24% | −0,86% | +0,49% |
| atr2.5 | +0,00% | +1,58% | −1,17% | +0,55% |

**Respuesta directa.** Alejar el stop reduce los stop-outs, pero eso no compensa. En el precio del papel, el stop por ATR es neutro en el IS y claramente peor en el OOS: −0,4 a −1,2 pp por trade contra +0,05 del geo. Lo que en el IS parecía mejora es estar comprado más días durante una devaluación. En el OOS el CCL se movió menos, el colchón desapareció y quedó a la vista una salida que pierde más.

## Nulo por rotación circular

Se rota la serie diaria de ATR% de cada papel sobre el calendario de la ventana (mismo desplazamiento j para todos) y se enumeran las T−1 rotaciones: 423 en el IS y 305 en el OOS. El p es exacto: p = (#{nulo ≥ real} + 1)/(B + 1). H0: usar el ATR de hoy no vale más que usar el ATR del mismo papel en otra fecha.

| celda | Gold pctil / p | Platinum pctil / p | Cocos pctil / p |
|---|---|---|---|
| atr1.5 IS | 43,3% / 0,568 | 43,0% / 0,571 | 42,6% / 0,576 |
| atr2 IS | 32,6% / 0,675 | 30,7% / 0,693 | 29,8% / 0,703 |
| atr2.5 IS | 30,3% / 0,698 | 30,0% / 0,701 | 30,0% / 0,701 |
| atr1.5 OOS | 66,2% / 0,340 | 61,6% / 0,386 | 54,1% / 0,461 |
| atr2 OOS | 42,0% / 0,582 | 39,7% / 0,605 | 35,7% / 0,644 |
| atr2.5 OOS | 58,4% / 0,418 | 54,4% / 0,458 | 45,2% / 0,549 |

Ninguna se acerca a 0,05. En el IS las tres quedan debajo de la mediana, así que el ATR desalineado anduvo *mejor*. Es la firma de un dial, no de una señal. El barrido en k también es monótono en el IS (más ancho, mejor) y no monótono en el OOS, la otra firma de dial que ya vimos en §10 y §16.

## DSR

Contador: **395 → 401** (3 valores de k × 2 ventanas; el geo ya estaba contado). σ(SR) = 3,656e-2, el publicado de Cocos. El mejor DSR es atr2.5/IS/Cocos con **0,205**. En el OOS ninguna celda pasa de 0,035. Nada se acerca a 0,95.

## Veredicto

**No cambiar el stop del bot a ATR.** El resultado es igual de útil que una mejora: el stop geométrico está mal calibrado en sigmas, pero calibrarlo bien no hace ganar plata, porque el problema no es el stop sino que el motor no tiene edge de precio (§17). Con el stop lejos, el bot pasa a ser un vehículo para estar comprado CEDEARs varios días. Eso es beta más CCL, y SPY quieto lo hace mejor y más barato.

**Sobre el hallazgo colateral (el tope del 20% manda siempre).** Confirmado otra vez: 100% en las dos ventanas, con un riesgo real de 0,26% a 0,96% que nadie eligió. Pero "arreglarlo" subiendo el riesgo efectivo a 1,5% multiplica la exposición en un sistema de expectativa negativa. En el OOS, con k≥2, eso **aumentó** el drawdown de 16,7% a 22% en Platinum. Si LP quiere que el parámetro RISK_REAL signifique algo, lo coherente es bajarlo al riesgo que efectivamente se corre (~0,4%) o bajar el tope, no alejar el stop.

**Caveats.**
- El gate R:R≥2 se evaluó con el stop original para no cambiar el conjunto de señales. Con el stop por ATR el R:R real cae. El target mediano está a 5,6% de la entrada y el stop a 6,6-11,1%, así que el R:R queda del orden de 0,85 (k=1,5) a 0,5 (k=2,5). El bot vivo con stop ATR y el gate recalculado directamente no operaría.
- El trailing en unidades de R muere con el stop ancho (0% de salidas por trailing). Un trailing por ATR separado es otra variante, no testeada.
- Universo de 38, config actual (límite en el soporte, TP parcial 50/50). No se probó sobre la config a mercado de §15-§16.
