# Informe · ¿dónde conviene el TP parcial ahora que la entrada es a mercado?

**La primera línea, sin vueltas: la guarda del breakeven que pedía LP es
redundante —no hay un solo trade, en 200 celdas, donde el parcial dispararía en
pérdida—, y el barrido del punto de disparo no mejora la configuración a
mercado: la mejora. La mejor celda del in-sample es apagar el parcial. Da
+2,81%/mes en el IS y +2,69% en el OOS contra +2,23% y +2,44% del parámetro
actual, y con menos drawdown (10,9% y 9,5% contra 12,7% y 9,7%). No hay
intercambio que discutir: el parcial de hoy está pagando retorno y no está
comprando drawdown. La estructura del barrido es limpia y monótona en las dos
ventanas: vender menos es mejor en 15 de 16 comparaciones, y vender más tarde es
mejor en casi todas — el límite de las dos perillas es el mismo, no vender. Pero
la mejora contra el parámetro actual no se distingue de cero (bootstrap de
bloques: IC 90% de −0,44 a +1,75 en el IS y de −0,32 a +0,94 en el OOS) y contra
un parcial puesto al azar en el camino la celda ganadora queda en el percentil
92,5 del in-sample, que no cruza el 5%. El DSR con N = 372 queda en 0,35 (IS) y
0,61 (OOS). Y la vara de siempre: contra SPY en pesos escalado a la exposición
de cada celda, apagar el parcial da **+0,25 puntos en el IS y +0,18 en el OOS**
—el primer exceso positivo en las dos ventanas de todo el proyecto— pero
cobrando el spread de 0,25% se da vuelta a **−0,63 y −0,94**. SPY quieto dio
3,98% y 4,11% por mes.**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS ni
Supabase. Motor, gate, reglas de entrada y reglas de salida idénticos a
`INFORME-AGRESIVIDAD.md`: **lo único que cambia acá es dónde se dispara el TP
parcial y cuánto se vende en él.**

La configuración de base está congelada y es la que eligió el walk-forward de
`INFORME-AGRESIVIDAD.md` §8: **entrada a mercado en la apertura de la barra
siguiente, stop y target móviles con la entrada, 30% por posición, 5 posiciones,
sin apalancamiento**, tarifa Cocos.

---

## 0. Chequeo de consistencia (esto va antes que nada)

La consigna era parar si la celda (50% del camino, 50% vendido) no reproducía el
`+2,23% / +2,44%` de `INFORME-AGRESIVIDAD`:

| | IS | OOS | publicado |
|---|---:|---:|---|
| Trades | 294 | 261 | 294 / 261 |
| **Retorno mensual (Cocos)** | **+2,23%** | **+2,44%** | +2,23% / +2,44% |
| Max drawdown | 12,7% | 9,7% | 12,7% / 9,7% |
| Sharpe | 1,45 | 1,99 | 1,45 / 1,99 |
| Win rate | 40,1% | 41,8% | 40,1% / 41,8% |
| Payoff | 2,08 | 1,97 | 2,08 / 1,97 |
| Parciales disparados | 115 | 110 | (no estaba publicado) |

Además se re-verificó el caso base de todo el proyecto (los 38 limpios, límite
en el nivel exacto, stop/target fijos, 20% por posición) contra `results.json` y
`results-cocos.json` en las cuatro tarifas.

**80 comparaciones, 0 descuadres.** El script aborta solo si aparece uno.

Huella de reproducibilidad: **8.478 números, FNV-1a `8ab12a15`**, verificada
corriendo dos veces con la misma semilla (20260917).

---

## 1. La guarda del breakeven: es redundante, y por qué

LP pidió que el parcial nunca se ejecute por debajo del breakeven. Lo primero
era verificar si eso ya se cumple por construcción. **Se cumple, y con margen.**

**El breakeven.** Definido como el precio al que la venta de esa pata empata
exactamente los costos de ida y vuelta de la posición:

```
bePx = entrada × (1 + fee + ½spread·cruza) / (1 − fee − ½spread)
```

Con la tarifa de Cocos (0,0605% por punta) eso deja el breakeven **0,1211% por
encima del precio de entrada**. Con el spread calibrado de 0,25% —media
horquilla en cada punta, y entrando a mercado cruzan las dos— queda **0,3717%
por encima**. Se ignora a propósito el arrastre del CCL: el disparo del parcial
es un precio que se pone por adelantado sobre el papel, no una cuenta en pesos.

**La distancia al target, medida.** Con entrada a mercado y target móvil, el
trayecto entrada → target de los trades que efectivamente se llenan es:

| | IS (n=294) | OOS (n=261) |
|---|---:|---:|
| Media | 7,14% | 7,15% |
| Mediana | 5,88% | 5,59% |
| Percentil 10 | 3,52% | 3,78% |
| **Mínimo** | **2,70%** | **2,87%** |
| R:R medio | 3,32 | 3,17 |

**La cuenta.** El disparo más agresivo de todo el barrido es el 25% del camino.
Aplicado al trade de target más corto de la muestra, cae en **+0,676% (IS)** y
**+0,717% (OOS)** sobre la entrada. Contra un breakeven de 0,1211% eso es 5,6
veces más arriba; contra el de 0,3717% que deja el spread, 1,8 veces. **Para que
la guarda mordiera haría falta un trade con el target a menos de 0,48% de la
entrada (1,49% con spread), y el más corto de la muestra está en 2,70%.** La
razón es el gate del motor: exige R:R ≥ 2 para entrar y el stop nunca es más
corto que 0,7% bajo el piso de la zona o 1×ATR, así que el target no puede
quedar pegado a la entrada.

Las tres variantes ancladas al breakeven (BE+0,5%, BE+1%, BE+2%) están por
encima del breakeven por definición, así que ahí la pregunta ni se plantea.

**El conteo, que es lo que pedía la consigna:** sobre las **200 celdas
evaluadas** (9 puntos de disparo × 3 fracciones × guarda sí/no × spread 0% y
0,25% × 2 ventanas), el parcial dispararía por debajo del breakeven en
**0 trades**. La guarda se subió a **0 posiciones**, cambió el resultado de
**0 de 48 celdas comparables** y el Δ de retorno y de drawdown es exactamente
cero en todas. Toda la grilla que sigue está corrida **con la guarda puesta**,
porque es la condición que pidió LP, pero los números son idénticos sin ella.

**Conclusión: la guarda es redundante con esta configuración.** No es redundante
por suerte, es redundante por el gate de R:R. Vale la pena dejarla escrita igual
en cualquier implementación futura: si alguna vez se afloja el R:R mínimo por
debajo de 2, o se permiten targets cortos, el 25% del camino puede caer adentro
de la comisión.

---

## 2. La grilla · retorno mensual

Retorno mensual neto en Cocos. Configuración de base congelada (mercado en la
apertura siguiente, stop/target móviles, 30%, 5 posiciones, sin apalancar). La
fila `sin parcial` no depende de la fracción vendida: se repite en las tres
columnas a propósito, para poder leerla como piso de comparación.

### 2.1 Sin spread

**IN-SAMPLE**

| punto de disparo | 25% vendido | 50% vendido | 75% vendido |
|---|---:|---:|---:|
| **sin parcial** | **+2,81%** | **+2,81%** | **+2,81%** |
| 25% del camino | +2,64% | +2,15% | +1,42% |
| 40% del camino | +2,47% | +1,92% | +1,90% |
| **50% del camino (ACTUAL)** | +2,67% | **+2,23%** | +1,82% |
| 60% del camino | +2,71% | +2,38% | +2,15% |
| 75% del camino | +2,78% | +2,56% | +2,43% |
| breakeven + 0,5% | +2,49% | +1,70% | +0,66% |
| breakeven + 1,0% | +2,69% | +2,11% | +1,33% |
| breakeven + 2,0% | +2,67% | +2,32% | +1,77% |

**OUT-OF-SAMPLE**

| punto de disparo | 25% vendido | 50% vendido | 75% vendido |
|---|---:|---:|---:|
| **sin parcial** | **+2,69%** | **+2,69%** | **+2,69%** |
| 25% del camino | +2,07% | +1,32% | +0,43% |
| 40% del camino | +2,70% | +2,13% | +1,54% |
| **50% del camino (ACTUAL)** | +2,63% | **+2,44%** | +1,84% |
| 60% del camino | +2,63% | +2,50% | +2,04% |
| 75% del camino | +2,77% | +2,92% | +2,90% |
| breakeven + 0,5% | +1,68% | +0,75% | −0,24% |
| breakeven + 1,0% | +1,97% | +1,20% | +0,37% |
| breakeven + 2,0% | +2,51% | +1,93% | +1,45% |

### 2.2 Con el spread calibrado de 0,25%

Es la tabla que hay que mirar para decidir cualquier cosa: el spread del CEDEAR
es el doble de la comisión de Cocos y el parcial **agrega una punta más** por
cada trade que lo dispara, así que castiga a las celdas que operan más.

**IN-SAMPLE**

| punto de disparo | 25% vendido | 50% vendido | 75% vendido |
|---|---:|---:|---:|
| **sin parcial** | **+1,93%** | **+1,93%** | **+1,93%** |
| 25% del camino | +1,69% | +1,13% | +0,36% |
| 40% del camino | +1,55% | +0,94% | +0,88% |
| **50% del camino (ACTUAL)** | +1,75% | **+1,26%** | +0,82% |
| 60% del camino | +1,79% | +1,43% | +1,17% |
| 75% del camino | +1,88% | +1,64% | +1,50% |
| breakeven + 0,5% | +1,55% | +0,76% | −0,30% |
| breakeven + 1,0% | +1,78% | +1,06% | +0,42% |
| breakeven + 2,0% | +1,66% | +1,26% | +0,66% |

**OUT-OF-SAMPLE**

| punto de disparo | 25% vendido | 50% vendido | 75% vendido |
|---|---:|---:|---:|
| **sin parcial** | **+1,57%** | **+1,57%** | **+1,57%** |
| 25% del camino | +0,86% | +0,05% | −0,88% |
| 40% del camino | +1,52% | +0,90% | +0,28% |
| **50% del camino (ACTUAL)** | +1,47% | **+1,24%** | +0,61% |
| 60% del camino | +1,48% | +1,32% | +0,84% |
| 75% del camino | +1,63% | +1,76% | +1,74% |
| breakeven + 0,5% | +0,49% | −0,45% | −1,45% |
| breakeven + 1,0% | +0,77% | −0,01% | −0,72% |
| breakeven + 2,0% | +1,19% | +0,50% | −0,10% |

### 2.3 La estructura, que es más informativa que cualquier celda

Dos patrones, y los dos aparecen en las dos ventanas y con las dos convenciones
de spread:

1. **Vender menos es mejor, siempre.** En **15 de las 16** comparaciones
   (8 puntos de disparo × 2 ventanas) el retorno cae monótonamente al pasar de
   25% a 50% a 75% vendido. La única excepción es `75% del camino` en el OOS,
   donde 50% y 75% quedan empatados arriba de 25%. Con spread, otra vez 15 de 16.
2. **Vender más tarde es mejor.** Yendo del 25% al 75% del camino, el retorno
   sube en casi todos los renglones; la monotonía estricta se cumple en 2 de 6
   columnas porque hay un pozo en `40% del camino` en el in-sample, pero la
   dirección no tiene ambigüedad: `25% del camino` es la peor fila de las cinco
   ancladas al camino en las dos ventanas, y `75% del camino` la mejor.

**Las dos perillas apuntan al mismo lugar y el límite de las dos es el mismo:
no vender.** Por eso la fila de arriba gana. Y explica por qué las tres
variantes ancladas al breakeven son malas: BE+0,5% dispara en promedio a +0,62%
de la entrada, o sea **apenas un 9% del camino al target** — es el extremo de la
perilla equivocada.

---

## 3. La grilla gemela: max drawdown

Lo que había que poder ver, según la consigna: una celda que da menos retorno
con mucho menos drawdown puede ser preferible. Acá está la tabla para verlo.

**Sin spread · IN-SAMPLE**

| punto de disparo | 25% | 50% | 75% |
|---|---:|---:|---:|
| **sin parcial** | **10,9%** | **10,9%** | **10,9%** |
| 25% del camino | 12,2% | 12,9% | 12,1% |
| 40% del camino | 13,1% | 15,3% | 13,5% |
| **50% del camino (ACTUAL)** | 11,4% | **12,7%** | 11,4% |
| 60% del camino | 11,9% | 13,1% | 13,6% |
| 75% del camino | 10,9% | 11,0% | 10,7% |
| breakeven + 0,5% | 12,1% | 12,4% | 11,4% |
| breakeven + 1,0% | 12,0% | 12,2% | 10,6% |
| breakeven + 2,0% | 11,1% | 11,2% | 12,8% |

**Sin spread · OUT-OF-SAMPLE**

| punto de disparo | 25% | 50% | 75% |
|---|---:|---:|---:|
| **sin parcial** | **9,5%** | **9,5%** | **9,5%** |
| 25% del camino | 9,4% | 9,4% | 9,3% |
| 40% del camino | 8,9% | 9,5% | 10,5% |
| **50% del camino (ACTUAL)** | 9,2% | **9,7%** | 10,8% |
| 60% del camino | 9,9% | 10,6% | 11,6% |
| 75% del camino | 9,6% | 9,5% | 9,6% |
| breakeven + 0,5% | 10,5% | 10,5% | 11,1% |
| breakeven + 1,0% | 10,1% | 10,0% | 8,3% |
| breakeven + 2,0% | 9,3% | 10,2% | 10,5% |

**Con spread 0,25%, los drawdowns de todas las celdas se agrandan y el orden se
acentúa:** `sin parcial` queda en 13,9% (IS) y 11,1% (OOS), y **ninguna** de las
24 celdas con parcial le gana en el in-sample, contra 2 de 24 en el
out-of-sample. Las celdas que venden el 75% son las que más se deterioran (la
peor, BE+0,5% al 75%, llega a 26,3% de drawdown en el IS).

**El resultado incómodo, que es el punto de este bloque: el parcial no compra
drawdown.** Sin spread, de las 24 celdas con parcial, **3 tienen menos drawdown
que apagarlo en el in-sample y 9 en el out-of-sample** — y ninguna de esas
combina eso con más retorno. **No hay intercambio que evaluar en el in-sample:
apagar el parcial domina en retorno (24 de 24) y en drawdown (21 de 24) a la
vez.** En el out-of-sample la dominancia se afloja (4 celdas con parcial dan más
retorno y 9 dan menos drawdown), pero ninguna de las que mejora el drawdown lo
hace por un margen que valga el retorno que resigna.

---

## 4. Qué hace el parcial, conceptualmente y con números

**La varianza sí la baja.** Medida sobre el P&L por trade, la desviación
estándar pasa de $125.535 (sin parcial, IS) a $101.707 con el parámetro actual y
a $57.740 en la celda más agresiva (BE+0,5%, 75% vendido). Y eso se traduce en
Sharpe: **16 de las 24 celdas con parcial tienen mejor Sharpe que apagarlo en el
in-sample** (la mejor, BE+2% al 50%, da 1,64 contra 1,46). O sea que el parcial
hace lo que dice hacer: suaviza la curva diaria.

**Pero no baja el drawdown**, que es la otra mitad de lo que uno le pide. Y el
motivo es mecánico y se ve en los caminos de salida (§5): **el parcial sólo
puede tocar los trades que ya se movieron a favor**. En la celda actual del
in-sample, **el 60,9% de los trades muere sin que el parcial llegue a
dispararse** (167 stops secos de 294, más 10 trailing y 2 fin de ventana). El
drawdown de esta cartera está hecho de rachas de stops secos, no de posiciones
que primero suben y después se dan vuelta. El parcial no participa de esa parte.

**Y la cola derecha sí la recorta, medido.** El mejor trade del in-sample pasa
de **$1.024.859 sin parcial a $602.011** con el parámetro actual y a $436.918 en
la celda más agresiva. El percentil 90 del P&L por trade pasa de $122.329 a
$112.683 y a $54.598. Y como el resultado total de esta estrategia depende
enteramente de unos pocos trades, la dependencia empeora: **el decil superior de
trades explica el 188% del resultado total sin parcial, el 208% con el parámetro
actual y el 353% en la celda más agresiva** (arriba de 100% porque el resto de
la cartera, sumado, es negativo). Cuanto más se recorta la cola derecha, más
frágil queda el todo.

Tabla del intercambio, in-sample, ordenada como la consigna pedía verlo:

| celda | mensual | Δret | maxDD | ΔDD | ret/DD | sd por trade | mejor trade | top-10% |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| sin parcial | +2,81% | +0,58 pp | 10,9% | −1,8 pp | 0,26 | $125.535 | $1.024.859 | 188% |
| 75% camino, 25% | +2,78% | +0,55 pp | 10,9% | −1,8 pp | 0,26 | $117.369 | $803.839 | 192% |
| 75% camino, 75% | +2,43% | +0,20 pp | 10,7% | −2,0 pp | 0,23 | $104.601 | $698.092 | 202% |
| **50% camino, 50% (ACTUAL)** | **+2,23%** | — | **12,7%** | — | 0,18 | $101.707 | $602.011 | 208% |
| BE+2%, 50% (mejor Sharpe IS) | +2,32% | +0,09 pp | 11,2% | −1,5 pp | 0,21 | $98.487 | $593.099 | 195% |
| BE+0,5%, 75% | +0,66% | −1,57 pp | 11,4% | −1,3 pp | 0,06 | $57.740 | $436.918 | 353% |

**En una línea: el parcial cambia retorno y cola derecha por varianza diaria, no
por drawdown.** Si lo que se busca es dormir tranquilo medido en Sharpe, la
celda BE+2% al 50% es defendible (SR 1,64 contra 1,46, con 0,09 puntos más de
mensual y 1,5 puntos menos de drawdown que la actual). Si lo que se busca es
drawdown, el parcial no es la herramienta.

---

## 5. Los caminos de salida

Qué fracción de los trades termina por cada camino, in-sample, sin spread:

| celda | parciales | parcial→target | parcial→trailing | parcial→stop | stop seco | target seco | trailing seco |
|---|---:|---:|---:|---:|---:|---:|---:|
| sin parcial | 0 | — | — | — | 61,3% | 27,0% | 9,9% |
| 25% camino, 50% | 164 | 26,8% | 10,3% | **18,2%** | 42,3% | 0,0% | 0,7% |
| 40% camino, 50% | 130 | 26,4% | 8,8% | 7,8% | 53,6% | 0,0% | 1,7% |
| **50% camino, 50% (ACTUAL)** | **115** | **26,5%** | **7,1%** | **4,4%** | **56,8%** | 0,0% | 3,4% |
| 60% camino, 50% | 107 | 26,7% | 6,2% | 3,1% | 58,2% | 0,0% | 4,1% |
| 75% camino, 50% | 94 | 26,8% | 4,2% | 1,4% | 59,9% | 0,0% | 5,9% |
| BE+0,5%, 50% | 211 | 27,1% | 11,0% | **32,9%** | 27,4% | 0,0% | 0,0% |
| BE+1%, 50% | 187 | 27,1% | 11,0% | 24,7% | 35,6% | 0,0% | 0,0% |
| BE+2%, 50% | 147 | 27,1% | 10,5% | 11,2% | 49,5% | 0,0% | 0,0% |

Tres lecturas:

1. **La columna `parcial→target` es constante en 26-27% en todas las celdas.**
   Tiene que serlo: todo trade que llega al target pasa antes por cualquier
   disparo que esté en el camino. O sea que el parcial no agrega ni saca trades
   ganadores completos: sólo cambia **a qué precio** se vendió la primera mitad
   de ellos. En esos trades, el parcial siempre resta (vende una parte más
   barato que el target), y por eso mover el disparo más tarde mejora.
2. **La columna que manda es `parcial→stop`.** Es el único lugar donde el
   parcial paga: el trade subió, se vendió una parte, y el resto murió en el
   stop. Va de **1,4% de los trades (75% del camino) a 32,9% (BE+0,5%)**. Esa es
   la protección que se compra. Y la tabla del §2 muestra que **no alcanza para
   pagar lo que cuesta**: BE+0,5%, que es la celda que más protege, es también
   la peor de la grilla.
3. **`target seco` sólo existe cuando el parcial está apagado** (27,0% de los
   trades del in-sample). Es la cola derecha entera: la posición completa
   llegando al target. Es exactamente lo que el parcial recorta.

En el out-of-sample el patrón es el mismo, con `parcial→trailing` más alto
(10,0% contra 7,1% en la celda actual) y `parcial→stop` un poco más alto (5,7%
contra 4,4%).

---

## 6. Walk-forward estricto

### 6.1 La elección, hecha mirando sólo el in-sample

Criterio **pre-declarado en el código antes de correr el OOS**: la celda con
mayor retorno mensual neto en Cocos del in-sample, **sin spread** (la misma
convención con la que `INFORME-AGRESIVIDAD.md` §8.1 eligió la configuración de
entrada: el spread es un dato del mercado que se aplica después, en su propio
bloque), con la guarda de breakeven puesta y al menos 30 trades. Desempate por
menor drawdown. Se declararon además dos criterios secundarios: mayor Sharpe del
IS, y mayor mensual del IS midiendo con el spread puesto.

El ranking completo del in-sample, para que se vea que no hay cherry-picking:

| # | celda | IS mensual | IS maxDD | IS Sharpe | IS con spread |
|---:|---|---:|---:|---:|---:|
| 1 | **sin parcial** | **+2,81%** | 10,9% | 1,46 | +1,93% |
| 2 | 75% del camino, 25% | +2,78% | 10,9% | 1,56 | +1,88% |
| 3 | 60% del camino, 25% | +2,71% | 11,9% | 1,53 | +1,79% |
| 4 | BE+1%, 25% | +2,69% | 12,0% | 1,59 | +1,78% |
| 5 | 50% del camino, 25% | +2,67% | 11,4% | 1,54 | +1,75% |
| 6 | BE+2%, 25% | +2,67% | 11,1% | 1,58 | +1,66% |
| 7 | 25% del camino, 25% | +2,64% | 12,2% | 1,57 | +1,69% |
| 8 | 75% del camino, 50% | +2,56% | 11,0% | 1,55 | +1,64% |
| … | … | … | … | … | … |
| 14 | **50% del camino, 50% (el parámetro actual)** | +2,23% | 12,7% | 1,45 | +1,26% |
| … | … | … | … | … | … |
| 25 | BE+0,5%, 75% | +0,66% | 11,4% | 0,76 | −0,30% |

**Ganadora del IS: apagar el parcial.** Los tres criterios pre-declarados
coinciden en dos de tres: el de retorno sin spread y el de retorno con spread
eligen `sin parcial`; el de Sharpe elige `BE+2%, 50% vendido` (SR 1,64).

El parámetro que corre hoy en el worker queda **14º de 25**.

### 6.2 El out-of-sample, corrido una vez y sin retocar

| | ACTUAL (50%, 50%) | | **GANADORA (sin parcial)** | | mayor Sharpe IS (BE+2%, 50%) | |
|---|---:|---:|---:|---:|---:|---:|
| | IS | OOS | **IS** | **OOS** | IS | OOS |
| Trades | 294 | 261 | 282 | 257 | 295 | 264 |
| **Mensual (sin spread)** | +2,23% | +2,44% | **+2,81%** | **+2,69%** | +2,32% | +1,93% |
| **Mensual (spread 0,25%)** | +1,26% | +1,24% | **+1,93%** | **+1,57%** | +1,26% | +0,50% |
| Max drawdown | 12,7% | 9,7% | **10,9%** | **9,5%** | 11,2% | 10,2% |
| Win rate | 40,1% | 41,8% | 36,2% | 37,4% | 43,1% | 44,7% |
| Payoff | 2,08 | 1,97 | 2,63 | 2,41 | 1,90 | 1,68 |
| Sharpe | 1,45 | 1,99 | 1,46 | 1,96 | 1,64 | 1,88 |
| Parciales disparados | 115 | 110 | 0 | 0 | 147 | 138 |
| Exposición media | 0,59 | 0,57 | 0,64 | 0,61 | 0,56 | 0,52 |
| **Exceso vs SPY·expo (sin spread)** | −0,11 | +0,11 | **+0,25** | **+0,18** | +0,10 | −0,21 |
| **Exceso vs SPY·expo (con spread)** | −1,08 | −1,09 | **−0,63** | **−0,94** | −0,99 | −1,69 |

**La ganadora del IS aguantó el OOS**: +2,81% → +2,69%, con el drawdown bajando
de 10,9% a 9,5%. No se desinfló. Y mejora al parámetro actual en las dos
ventanas, en retorno y en drawdown, con y sin spread.

Dos cosas que hay que decir igual:

- **La celda que más rindió en el out-of-sample no es ésta.** Es `75% del
  camino, 50% vendido`, con +2,92% (y +1,76% con spread), que en el in-sample
  salía 8ª. No se reporta como ganadora porque la elección se hizo mirando el
  in-sample, que es la regla. Se anota para que quede constancia de cuánto
  ruido hay entre las primeras diez celdas: 0,25 puntos de mensual separan a la
  1ª de la 8ª en el IS.
- **La cantidad de trades cambia entre celdas** (294 con parcial, 282 sin) y no
  es un error: la media venta libera caja, y esa caja cambia el tamaño —a veces
  la existencia— de fills posteriores. Es el mismo canal que `INFORME-RECOMPRA`
  ya había medido; acá mueve 12 trades en el in-sample y 4 en el out-of-sample.

---

## 7. Modelos nulos (5.000 sorteos, semilla 20260917)

**Nulo 1 · el punto del parcial al azar.** Mismo todo, pero el disparo se
sortea uniforme sobre el camino entrada → target, trade por trade, vendiendo la
mitad (el parámetro del worker de hoy). Contesta: ¿apagar el parcial le gana al
parcial de siempre puesto en cualquier lado?

| | real | mediana del nulo | percentil | p (una cola) | p5 – p95 |
|---|---:|---:|---:|---:|---|
| IS | +2,81% | +2,40% | **92,5%** | **0,075** | +1,94 a +2,87 |
| OOS | +2,69% | +2,15% | **96,6%** | **0,034** | +1,66 a +2,64 |

**No cruza en el in-sample** (p = 0,075) y sí cruza en el out-of-sample
(p = 0,034), que es el orden equivocado para creerle.

**Nulo 2 · los dos ejes al azar.** El barrido movió dos perillas, así que el
nulo honesto sortea las dos: punto uniforme en el camino y fracción vendida
uniforme en (0, 1), trade por trade.

| | real | mediana del nulo | percentil | p (una cola) | p5 – p95 |
|---|---:|---:|---:|---:|---|
| IS | +2,81% | +2,49% | **77,6%** | **0,224** | +1,35 a +2,96 |
| OOS | +2,69% | +2,24% | **93,9%** | **0,061** | +1,02 a +2,71 |

**Contra el nulo completo, la celda ganadora no se distingue del azar en
ninguna de las dos ventanas.** Poner el parcial en cualquier lado y por
cualquier tamaño da, en mediana, +2,49% en el IS — o sea el 89% de lo que da la
celda elegida.

**Nulo 3 · selección de órdenes** (el nulo 1 de `INFORME-AGRESIVIDAD`,
re-corrido con el parcial apagado): llenar K señales al azar entre las N
emitidas, a mercado. Percentil **71,6% en el IS (p = 0,284)** y **88,1% en el
OOS (p = 0,119)**. Sigue sin ganarle al azar, igual que antes: apagar el parcial
no arregla lo que ya estaba roto en la selección.

**Nulo 4 · bootstrap de bloques** (bloques de 10 ruedas) sobre la diferencia
diaria de equity contra el parámetro actual:

| | Δ real | IC 90% | p(Δ ≤ 0) |
|---|---:|---|---:|
| IS | +0,58 pp/mes | **−0,44 a +1,75** | 0,180 |
| OOS | +0,25 pp/mes | **−0,32 a +0,94** | 0,234 |

**El intervalo de confianza del 90% incluye el cero en las dos ventanas.** La
mejora de apagar el parcial es consistente en signo —gana en las dos ventanas,
en retorno y en drawdown, con y sin spread— pero no es estadísticamente
distinguible de cero con esta cantidad de trades.

---

## 8. El benchmark obligatorio: SPY en pesos

De `INFORME-AGRESIVIDAD.md` §5, y de acá en más en todas las celdas: SPY en
pesos, comprado y no tocado, dio **+3,98%/mes en el in-sample** (maxDD 26,8%) y
**+4,11%/mes en el out-of-sample** (maxDD 13,6%). El exceso se calcula contra
ese benchmark escalado a la exposición bruta media de cada celda.

**Exceso sin spread (pp/mes)** · IS / OOS

| punto de disparo | 25% | 50% | 75% |
|---|---:|---:|---:|
| **sin parcial** | **+0,25 / +0,18** | +0,25 / +0,18 | +0,25 / +0,18 |
| 25% del camino | +0,19 / −0,29 | −0,04 / −0,75 | −0,32 / −1,28 |
| 40% del camino | −0,00 / +0,29 | −0,39 / −0,10 | −0,15 / −0,46 |
| **50% del camino (ACTUAL)** | +0,21 / +0,20 | **−0,11 / +0,11** | −0,35 / −0,32 |
| 60% del camino | +0,24 / +0,19 | +0,02 / +0,13 | −0,09 / −0,22 |
| 75% del camino | +0,27 / +0,32 | +0,10 / +0,51 | +0,03 / +0,56 |
| breakeven + 0,5% | +0,10 / −0,57 | −0,28 / −1,06 | −0,67 / −1,55 |
| breakeven + 1,0% | +0,28 / −0,34 | +0,05 / −0,78 | −0,18 / −1,19 |
| breakeven + 2,0% | +0,24 / +0,14 | +0,10 / −0,21 | −0,03 / −0,40 |

**Con el spread de 0,25% (pp/mes)** · IS / OOS

| punto de disparo | 25% | 50% | 75% |
|---|---:|---:|---:|
| **sin parcial** | **−0,63 / −0,94** | −0,63 / −0,94 | −0,63 / −0,94 |
| 25% del camino | −0,76 / −1,49 | −1,06 / −2,02 | −1,37 / −2,60 |
| 40% del camino | −0,93 / −0,88 | −1,38 / −1,32 | −1,18 / −1,73 |
| **50% del camino (ACTUAL)** | −0,72 / −0,96 | **−1,08 / −1,09** | −1,35 / −1,55 |
| 60% del camino | −0,68 / −0,97 | −0,93 / −1,05 | −1,07 / −1,42 |
| 75% del camino | −0,64 / −0,82 | −0,82 / −0,64 | −0,90 / −0,61 |
| breakeven + 0,5% | −0,86 / −1,79 | −1,27 / −2,37 | −1,75 / −2,91 |
| breakeven + 1,0% | −0,65 / −1,55 | −1,05 / −2,02 | −1,18 / −2,34 |
| breakeven + 2,0% | −0,78 / −1,20 | −0,99 / −1,69 | −1,22 / −2,03 |

**Lo que hay que leer acá, y es lo más cerca que estuvo el proyecto de algo
positivo:** sin spread, **apagar el parcial es la única celda de la grilla con
exceso positivo en las dos ventanas** (+0,25 y +0,18), y `75% del camino` lo
acompaña en las tres fracciones. Es el primer caso en todo el proyecto de una
configuración que, elegida en el in-sample, da exceso positivo sobre estar
comprado a la misma exposición en las dos ventanas.

**Y lo que lo desarma: cobrando el spread medido, las 25 configuraciones dan
exceso negativo en las dos ventanas, sin una sola excepción.** La menos mala en
el in-sample es apagar el parcial (−0,63) y en el out-of-sample es `75% del
camino, 75% vendido` (−0,61). **Ninguna
configuración del barrido le gana a comprar el índice y quedarse quieto una vez
que se paga la horquilla.**

Nota de honestidad sobre el benchmark: SPY comprado y quieto tampoco paga
spread en este cálculo. Cobrarle la punta de entrada (media horquilla, una sola
vez) le sacaría 0,006 pp/mes en el IS y 0,009 en el OOS escalado a la exposición
— tres órdenes de magnitud menos que lo que le cuesta a la estrategia, que cruza
la horquilla 15 a 18 veces por mes por las dos puntas. La comparación sigue
siendo desfavorable por un margen enorme.

---

## 9. Deflated Sharpe Ratio · N de 324 a 372

`INFORME-AGRESIVIDAD.md` dejó el conteo en **N = 324** (paranoico 496). Este
anexo agrega **48 configuraciones genuinamente nuevas**: cada combinación
distinta de (punto de disparo × fracción vendida × ventana), deduplicada, menos
la celda (50% del camino, 50% vendido) que ya estaba contada como la
configuración elegida del anexo anterior. **N = 372.**

**La guarda de breakeven no suma al N**, y eso hay que justificarlo: produce una
cartera **idéntica al número** en las 48 celdas comparables (§1), así que no es
un grado de libertad que se haya ejercido — mirarla no pudo sesgar nada. Igual
se reporta la versión paranoica que la cuenta como si fuera una decisión más:
**98 miradas nuevas, N paranoico = 594.** Tampoco entran en el N los 5.000
sorteos de cada nulo ni el barrido de spread (misma convención de siempre: el
spread es un dato del mercado).

σ(SR) de Cocos: **3,6559e−2** publicado (sobre las 160 variantes previas),
**4,3712e−2** de las 150 celdas de `agresividad` y **2,8910e−2** calculado sobre
las 48 celdas nuevas de este anexo. Se reportan las tres sin elegir; la nueva es
más chica porque las 48 celdas son variaciones de una misma configuración y se
parecen mucho entre sí, así que castiga menos — no es un mérito, es un artefacto
de que este barrido es más angosto que el anterior.

| Corrida | n | Sharpe | DSR con N=324 | **DSR con N=372** | con σ nuevo | paranoico (N=594) |
|---|---:|---:|---:|---:|---:|---:|
| ACTUAL (50% camino, 50%) · IS | 294 | +1,45 | 0,3675 | **0,3544** | 0,5520 | 0,3126 |
| ACTUAL (50% camino, 50%) · OOS | 261 | +1,99 | 0,6318 | **0,6212** | 0,7630 | 0,5853 |
| **GANADORA (sin parcial) · IS** | 282 | +1,46 | 0,3636 | **0,3495** | 0,5636 | 0,3045 |
| **GANADORA (sin parcial) · OOS** | 257 | +1,96 | 0,6185 | **0,6078** | 0,7511 | 0,5719 |
| mayor Sharpe IS (BE+2%, 50%) · IS | 295 | +1,64 | 0,4692 | **0,4548** | 0,6599 | 0,4076 |
| mayor Sharpe IS (BE+2%, 50%) · OOS | 264 | +1,88 | 0,5819 | **0,5709** | 0,7207 | 0,5342 |

**Ninguno llega a 0,95.** Y el detalle que hay que decir sin maquillar: **la
celda ganadora de este anexo tiene un DSR más BAJO que la celda que venía de
antes** (0,3495 contra 0,3544 en el IS; 0,6078 contra 0,6212 en el OOS). Da más
plata y tiene menos drawdown, pero su Sharpe diario es apenas más alto (1,46
contra 1,45 en el IS, 1,96 contra 1,99 en el OOS) y el N creció: el castigo por
multiplicidad se come la diferencia entera. **Pasar de 324 a 372 miradas le saca
1 a 2 puntos de DSR a todas las corridas, y la versión paranoica (594) saca 4 a
5 más.** El récord del proyecto para una cartera armable sigue siendo el del
anexo anterior, ahora re-deflactado: **0,6212**, la configuración que ya estaba.

---

## 10. Lo que no está modelado (además de todo lo de `INFORME.md` §7 y `INFORME-AGRESIVIDAD.md` §11)

| Aproximación | Efecto |
|---|---|
| El parcial se ejecuta al precio exacto del disparo si la barra horaria lo tocó | **Optimista**, igual que todas las salidas del proyecto. Con granularidad horaria no se sabe si el precio se sostuvo |
| El breakeven se calcula con la tarifa de Cocos y sin el arrastre del CCL | Simplificación deliberada: el disparo es un precio sobre el papel. Con el CCL a favor el breakeven real es más bajo, así que la guarda sería **todavía más redundante** |
| El spread se cobra por punta que cruza, con horquilla fija | El parcial agrega una punta por trade que lo dispara. La horquilla real se ensancha justo cuando uno vende apurado. **Optimista para las celdas que operan más** |
| La media venta libera caja y eso cambia fills posteriores | Está modelado, y mueve la cantidad de trades entre celdas (294 vs 282 en el IS). No es ruido del simulador: es un canal real |
| Vender fracciones exactas de la posición (25%, 75%) | Con CEDEARs enteros no siempre se puede. Es de segundo orden frente al tope del 30% por posición |
| Sigue siendo una estrategia que opera 15-18 veces por mes **a mano** en Cocos | **Optimista y grande**, igual que en los dos anexos anteriores. Apagar el parcial baja la cantidad de operaciones, que es lo único que mejora de este lado |

---

## 11. Veredicto

**¿Mover el punto del parcial mejora la configuración a mercado? Sí, pero la
mejora es apagarlo, y no se distingue de cero.**

1. **La guarda del breakeven que pedía LP es redundante con esta
   configuración.** El parcial nunca dispararía en pérdida: el disparo más
   agresivo del barrido (25% del camino, sobre el target más corto de la
   muestra) cae en +0,68%, y el breakeven está en +0,12% (+0,37% con spread).
   **0 trades afectados en 200 celdas, 0 de 48 celdas con resultado distinto.**
   Es redundante por el gate de R:R ≥ 2, no por casualidad: si alguna vez se
   afloja ese gate, la guarda pasa a hacer falta.
2. **El parámetro actual —mitad de la posición al 50% del camino— está mal
   puesto para la entrada a mercado, y la dirección de la corrección es clara.**
   Queda 14º de 25 en el in-sample. Vender menos es mejor en 15 de 16
   comparaciones y vender más tarde es mejor en casi todas, en las dos ventanas
   y con las dos convenciones de spread. **Las dos perillas apuntan al mismo
   límite: no vender.**
3. **La ganadora del in-sample es apagar el parcial, y aguantó el
   out-of-sample**: +2,81% → +2,69% mensual (contra +2,23% y +2,44% del
   parámetro actual), con el drawdown bajando de 12,7% a 10,9% y de 9,7% a 9,5%.
   Con el spread de 0,25%, +1,93% y +1,57% contra +1,26% y +1,24%.
4. **No hay intercambio retorno/drawdown que evaluar.** En el in-sample, apagar
   el parcial gana en retorno en 24 de 24 celdas y en drawdown en 21 de 24. El
   parcial sí baja la varianza diaria (16 de 24 celdas tienen mejor Sharpe que
   apagarlo en el IS, la mejor con 1,64 contra 1,46) y sí recorta la cola
   derecha (el mejor trade del IS pasa de $1.024.859 a $602.011), pero **no
   compra drawdown**, porque el 61% de los trades muere en un stop seco sin que
   el parcial llegue a dispararse nunca.
5. **Contra los nulos, la mejora no está.** Contra un parcial puesto al azar en
   el camino, percentil 92,5 en el IS (p = 0,075) — no cruza; contra el nulo
   completo que sortea las dos perillas, percentil 77,6 (p = 0,224). El
   bootstrap de bloques de la mejora contra el parámetro actual incluye el cero
   en las dos ventanas (IC 90%: −0,44 a +1,75 en el IS, −0,32 a +0,94 en el
   OOS).
6. **El DSR empeora, no mejora.** Con N = 372, la celda ganadora queda en 0,3495
   (IS) y 0,6078 (OOS) — **por debajo** del 0,3544 / 0,6212 de la celda que ya
   estaba, porque su Sharpe diario es casi igual y el N creció. Ninguna llega a
   0,95. El proyecto lleva 372 miradas contadas (594 en la versión paranoica).
7. **Y el benchmark, que es la vara.** Sin spread, apagar el parcial da
   **+0,25 pp/mes de exceso en el IS y +0,18 en el OOS** sobre SPY en pesos
   escalado a la misma exposición — el primer exceso positivo en las dos
   ventanas de todo el proyecto. **Con el spread medido de 0,25%, las 27 celdas
   dan exceso negativo en las dos ventanas** —las 25, sin excepción— y la
   ganadora queda en −0,63 y −0,94. SPY comprado y quieto dio 3,98% y 4,11% por
   mes.

**En una línea: la mejor manera de acomodar el TP parcial a la entrada a mercado
es sacarlo, la evidencia de eso es consistente en signo pero no en
significancia, y ninguna celda del barrido —incluida la ganadora— le gana a
comprar el índice y quedarse quieto una vez que se paga la horquilla del
CEDEAR.** Si LP igual quiere tocar el parámetro del worker, la recomendación
defendible no es apagarlo de una: es **moverlo del 50% al 75% del camino y bajar
la fracción vendida del 50% al 25%**, que es la celda que queda 2ª en el
in-sample (+2,78%, drawdown 10,9%), 3ª en el out-of-sample (+2,77%) y conserva
la protección en un cuarto de la posición. La diferencia contra apagarlo es de
0,03 puntos mensuales en el in-sample: está dentro del ruido, y deja el mecanismo
puesto por si la ventana siguiente se parece menos a estas dos.

---

*Generado offline el 18/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `parcial.js` (reusa `engine.js`; la celda (50%, 50%)
reproduce `results-agresividad.json` y la celda base reproduce `results.json` /
`results-cocos.json` en 80/80 comparaciones, y el script aborta si hay una
sola). Sin accesos externos: el spread usa la calibración ya publicada en
`INFORME-AGRESIVIDAD.md` §9 (0,25%). Semilla 20260917, 5.000 sorteos por nulo.
Huella de reproducibilidad: 8.478 números, FNV-1a `8ab12a15`, verificada en dos
corridas. Detalle completo en `results-parcial.json` y `run-parcial.log`.
Convenciones, aproximaciones y anti-lookahead en `README.md` e `INFORME.md`.*
