# Informe · el filtro de volatilidad contra el azar

**La primera línea, sin vueltas: el filtro de volatilidad NO selecciona, sólo
recorta exposición. Contra un nulo que saca la misma cantidad de trades al
azar, el filtro cae en el percentil 77 del in-sample (p = 0,23) y en el
percentil 45 del out-of-sample (p = 0,55). Contra el nulo honesto —apagar la
misma cantidad de días pero en bloques contiguos ubicados al azar— cae en el
percentil 59 y en el 47 (p = 0,41 y p = 0,53). Es decir: en el IS está apenas
mejor que la mitad de los sorteos, y en el OOS está exactamente en la mitad.
El test directo confirma lo mismo: la expectancy de los trades que el filtro
deja pasar no se distingue de la de los que bloquea (IS p = 0,28, OOS
p = 0,73). Y arriba de eso hay un lookahead que el informe anterior no vio: el
umbral de "volatilidad alta/baja" es la mediana de TODO el in-sample, aplicada
también a la primera rueda del in-sample. Corrido point-in-time con mediana
expansiva, el −0,38%/mes del IS se va a −0,81% y la mejora contra el base pasa
de 0,45 puntos a 0,02. La sección 3 y la sección 8 de `INFORME.md` quedan
corregidas: la "única recomendación defendible" no sobrevive.**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS ni
Supabase. Motor, reglas de ejecución y convenciones idénticos a `INFORME.md`:
el chequeo de arranque reproduce las 20 celdas de la tabla de §3 al noveno
decimal (Δ = 0,0e+0 en todas).

**Semilla del generador aleatorio: `20260917`** (mulberry32, `nulo.js`). Con
esa semilla cada número de este informe se reproduce exacto. 5.000 sorteos por
celda.

---

## 0. Por qué había que hacer esto

`INFORME.md` §3 concluye que `base + vol20 baja` es "la única recomendación
defendible" porque mejora el mensual en las dos ventanas (−0,38% contra −0,83%
en IS; −0,64% contra −0,95% en OOS). Y en el mismo párrafo admite que mejora
"porque opera menos, no porque opere mejor".

Esa admisión nunca se testeó. Y es la clave de todo, porque **en un sistema con
expectativa negativa, sacar trades al azar mejora el mensual por pura
aritmética**: si cada trade pierde $10.657 en promedio, sacar 35 trades
"mejora" el resultado en $373.000 sin necesidad de que el filtro entienda nada
del mercado. El mensual de un filtro que recorta un 40% de la operatoria no se
compara contra el base: se compara contra la distribución de todos los recortes
del 40% posibles.

Eso es lo que hace este informe.

---

## 1. Los dos modelos nulos

Para cada gate, el "padre" es el gate sin la condición de régimen (o sea, de
dónde sale el universo de señales que el filtro después recorta), y el "hijo"
es el gate del informe. El filtro deja pasar K señales de las N del padre.

**Nulo 1 · trades al azar.** Se sortean K de las N señales del padre sin
reemplazo, se corre la cartera completa con esa selección y se anota el
mensual. 5.000 veces. Es el nulo ingenuo.

**Nulo 2 · bloques de calendario.** El filtro real deja el bot **encendido**
durante un conjunto de ruedas y **apagado** durante otro, y los días apagados
vienen agrupados: en el IS son 10 bloques que suman 200 de 424 ruedas, con un
largo medio de 20 ruedas y uno de 69. El nulo apaga la misma cantidad total de
ruedas, en la misma cantidad de bloques y con exactamente las mismas
duraciones, pero ubicados al azar en el calendario (posiciones sorteadas por
barras y estrellas, con al menos una rueda de separación para que dos bloques
vecinos no se fusionen y no se rompa la distribución de duraciones). 5.000
veces.

**Este segundo nulo es el honesto.** Un filtro de régimen no elige trades: apaga
períodos enteros. El nulo 1, al romper ese agrupamiento, subestima la varianza
—cada sorteo mezcla pedazos de todos los regímenes y termina pareciéndose al
promedio— y por eso da una distribución más angosta y un percentil más
generoso para el filtro. Se ve en los números: en el IS Gold, el desvío del
nulo 1 es 0,223 pp mensuales y el del nulo 2 es 0,237; el percentil del filtro
baja de 76,8% a 59,1% al pasar de uno al otro. **Cuando los dos discrepan hay
que creerle al 2.**

Criterio de lectura, fijado antes de mirar: si el filtro real cae cerca de la
mediana del nulo, **no selecciona — sólo reduce exposición**.

---

## 2. Bloque A · resultados de los nulos

### El filtro de volatilidad, que es el que estaba recomendado

| | IS Gold | OOS Gold | IS Black | OOS Black |
|---|---:|---:|---:|---:|
| Señales que deja pasar | 324 / 528 | 228 / 371 | 324 / 528 | 228 / 371 |
| Trades | 76 | 57 | 76 | 57 |
| **Mensual real** | **−0,38%** | **−0,64%** | **+0,21%** | **−0,03%** |
| Mediana del nulo 1 | −0,55% | −0,62% | +0,07% | +0,07% |
| **Percentil · nulo 1** | **76,8%** | **45,4%** | **73,8%** | **31,6%** |
| **p (una cola) · nulo 1** | **0,2318** | **0,5459** | **0,2619** | **0,6839** |
| Mediana del nulo 2 | −0,44% | −0,62% | +0,01% | +0,05% |
| **Percentil · nulo 2** | **59,1%** | **47,0%** | **78,5%** | **36,4%** |
| **p (una cola) · nulo 2** | **0,4095** | **0,5301** | **0,2148** | **0,6363** |
| p5 – p95 del nulo 2 | −0,82 a −0,04 | −0,99 a −0,28 | −0,37 a +0,41 | −0,33 a +0,38 |

Leído con el criterio de arriba: **el filtro cae cerca de la mediana del nulo
en las dos ventanas y con las dos tarifas. No selecciona — sólo reduce
exposición.** En el OOS, que es la ventana que no se miró al elegirlo, está
literalmente en la mitad de la distribución con Gold (percentil 45 y 47) y por
debajo de la mitad con Black (31 y 36): apagar el bot en fechas al azar
hubiera salido *mejor* que apagarlo cuando la volatilidad estaba alta.

El único número que se salva de la nada es el IS con el nulo 1 (percentil 77),
y es justamente el que hay que descartar: es la ventana donde se eligió el
filtro y es el nulo que subestima la varianza.

### Todos los gates del informe, Gold

| Gate | Ventana | Señales K/N | Mensual real | Nulo 1: pctil / p | Nulo 2: pctil / p |
|---|---|---:|---:|---:|---:|
| base + vol20 baja | IS | 324/528 | −0,38% | 76,8% / 0,232 | 59,1% / 0,410 |
| base + vol20 baja | OOS | 228/371 | −0,64% | 45,4% / 0,546 | 47,0% / 0,530 |
| base + SPY>EMA200 | IS | 520/528 | −0,87% | 11,4% / 0,886 | 19,4% / 0,806 |
| base + SPY>EMA200 | OOS | 371/371 | −0,95% | *no filtra nada* | *no filtra nada* |
| base + SPY>EMA50 | IS | 518/528 | −0,72% | 93,1% / 0,069 | 34,9% / 0,651 |
| base + SPY>EMA50 | OOS | 360/371 | −0,95% | 36,0% / 0,641 | 20,5% / 0,795 |
| base (worker) | IS | 528/646 | −0,83% | 75,8% / 0,242 | 67,7% / 0,323 |
| base (worker) | OOS | 371/503 | −0,95% | 22,0% / 0,780 | 42,8% / 0,572 |
| sin régimen + vol20 baja | IS | 346/646 | −0,63% | 58,9% / 0,411 | 50,9% / 0,491 |
| sin régimen + vol20 baja | OOS | 297/503 | −0,68% | 47,0% / 0,530 | 41,1% / 0,589 |
| sin régimen + SPY>EMA200 | IS | 591/646 | −1,19% | 18,5% / 0,815 | 17,8% / 0,822 |
| sin régimen + SPY>EMA200 | OOS | 486/503 | −1,06% | 10,3% / 0,897 | 5,3% / 0,947 |
| sin régimen + SPY>EMA50 | IS | 538/646 | −0,81% | 82,3% / 0,178 | 68,7% / 0,313 |
| sin régimen + SPY>EMA50 | OOS | 407/503 | −0,93% | 34,5% / 0,655 | 29,1% / 0,709 |
| *control*: SPY<EMA200 | IS | 55/646 | −0,00% | 81,8% / 0,182 | 77,9% / 0,222 |
| *control*: SPY<EMA200 | OOS | 17/503 | +0,05% | 84,9% / 0,151 | 63,9% / 0,362 |
| *control*: vol20 alta | IS | 300/646 | −0,56% | 57,7% / 0,424 | 52,6% / 0,474 |
| *control*: vol20 alta | OOS | 206/503 | −0,39% | 65,8% / 0,342 | 44,8% / 0,552 |

**Ni uno solo de los 17 gates evaluables llega a p < 0,05 contra el nulo 2.**
El mejor de toda la tabla contra el nulo honesto es el control "operar sólo con
SPY bajo su EMA200" en el IS (percentil 78, p = 0,22), que es la regla
*opuesta* a la que tiene el bot, y que igual no es significativa. El único que
asoma con p = 0,069 es `base + SPY>EMA50` en el IS contra el nulo 1, y se cae a
percentil 35 (p = 0,65) contra el nulo 2: es exactamente el caso que justifica
haber hecho los dos nulos.

**El régimen propio del worker** (base vs sin régimen) cae en el percentil 68
del IS y 43 del OOS contra el nulo 2. Tampoco selecciona. Nota metodológica:
el régimen del worker cambia intradía, así que para el nulo de bloques hay que
bajarlo a nivel rueda (día encendido = mayoría de barras en `risk_on`). Con esa
aproximación el mensual real del filtro es −0,78% (IS) y −0,80% (OOS) en vez de
−0,83% y −0,95%, y esos son los valores que se comparan contra el nulo, para
que la comparación sea entre iguales. Además, en los sorteos todas las señales
entran con riesgo pleno mientras que el filtro real mete 5 trades a medio
riesgo por la regla del régimen "mixto": son 5 trades en 35 meses, no mueve
nada. Para los gates de volatilidad y de EMA no hay ninguna aproximación — el
feature es diario y la máscara por rueda es idéntica a la de la señal (el
mensual "real por día" coincide al peso con el exacto).

### Las dos aritméticas que hay que tener juntas

El nulo 1 del IS sortea 324 de 528 señales y termina con 78,9 trades promedio;
el filtro real, con las mismas 324 señales, termina con 76. El nulo 2 termina
con 57,6 y el real con 76. Esa diferencia de conteo existe porque los skips por
tope de 5 posiciones dependen de *cuándo* caen las señales, y es parte de lo
que el nulo mide. No hay un sesgo de tamaño que explique el resultado: el
filtro real está en la mediana con más trades que el nulo 2 y con menos que el
nulo 1, y en los dos casos queda en el medio.

---

## 3. Bloque B · ¿selecciona o sólo recorta? El test directo

Se corre el gate **padre** (todas las señales, sin la condición de régimen), se
toman los trades que efectivamente se ejecutaron y se los parte en dos grupos
según si la condición del filtro se cumplía el día de la señal. Si el filtro
discrimina, el grupo "pasa" tiene que ganarle al grupo "bloquea". Welch, p a
dos colas.

### El filtro de volatilidad

| | IS | OOS |
|---|---|---|
| n pasa / n bloquea | 73 / 38 | 57 / 37 |
| Media Gold, pasa | −$6.694 | −$9.052 |
| Media Gold, bloquea | −$18.270 | −$12.095 |
| Desvío, pasa / bloquea | $62.622 / $48.036 | $43.619 / $39.371 |
| **t / p (Gold)** | **1,08 / 0,279** | **0,35 / 0,726** |
| Media Black, pasa vs bloquea | +$4.439 vs −$6.940 | +$1.813 vs −$872 |
| **t / p (Black)** | **1,04 / 0,296** | **0,30 / 0,763** |
| Bruto sobre nocional, pasa vs bloquea | +0,637% vs −0,172% | +0,445% vs +0,259% |
| **t / p (bruto)** | **1,04 / 0,301** | **0,29 / 0,772** |

**No hay diferencia significativa en ninguna de las dos ventanas, con ninguna
de las tres métricas.** En el IS la diferencia tiene el signo que uno quiere
(los que pasan pierden $11.576 menos por trade) pero con desvíos de $50-60.000
y n = 73/38, el error estándar de la diferencia es $10.700: la señal es un
tercio del ruido. En el OOS la diferencia se achica a $3.043 y el p sube a
0,73, que es la forma estadística de decir "nada".

La brecha entre el bruto sobre nocional (+0,64% vs −0,17% en IS) y lo que
termina en el bolsillo es la de siempre: la vuelta cuesta 1,12% en Gold y se
come los dos lados.

### El resto de los gates

| Gate | Ventana | n pasa / bloquea | Media Gold pasa vs bloquea | p (Gold) |
|---|---|---:|---|---:|
| base + vol20 baja | IS | 73 / 38 | −$6.694 vs −$18.270 | 0,279 |
| base + vol20 baja | OOS | 57 / 37 | −$9.052 vs −$12.095 | 0,726 |
| base + SPY>EMA200 | IS | 109 / 2 | −$11.362 vs +$27.752 | 0,000 |
| base + SPY>EMA50 | IS | 106 / 5 | −$11.728 vs +$12.053 | 0,049 |
| base + SPY>EMA50 | OOS | 92 / 2 | −$10.541 vs +$3.115 | 0,713 |
| base (worker) | IS | 112 / 44 | −$10.879 vs −$10.086 | 0,923 |
| base (worker) | OOS | 92 / 37 | −$10.589 vs −$466 | 0,192 |
| sin régimen + vol20 baja | IS | 88 / 68 | −$9.530 vs −$12.111 | 0,757 |
| sin régimen + vol20 baja | OOS | 75 / 54 | −$7.444 vs −$8.021 | 0,937 |
| *control*: SPY<EMA200 | IS | 20 / 136 | −$248 vs −$12.185 | 0,300 |
| *control*: SPY<EMA200 | OOS | 5 / 124 | +$10.848 vs −$8.433 | 0,195 |
| *control*: vol20 alta | OOS | 54 / 75 | −$8.021 vs −$7.444 | 0,937 |

Los dos p significativos son de los filtros de EMA y van **en contra** del
filtro: los 2 y 5 trades que SPY>EMA200 y SPY>EMA50 bloquean en el IS son de
los mejores del período (+$27.752 y +$12.053 por trade). Con n = 2 y n = 5 eso
no es evidencia de nada más que de que esos filtros le sacan al bot los trades
que le sirven, que es lo que ya decía `INFORME.md`. Los tests con n de dos
dígitos de los dos lados —el de volatilidad y el del régimen del worker— dan
todos p > 0,19.

**Veredicto del bloque B: el filtro no discrimina.** Ni el de volatilidad ni el
del worker. Las diferencias de expectancy entre lo que pasa y lo que bloquea
son indistinguibles de cero.

---

## 4. Bloque C · lookahead en las etiquetas de régimen

### 4.1 Lo que está bien

- **El rezago de una rueda está aplicado, y verificado**: la volatilidad que
  lleva cada una de las **55.937** señales es la de la rueda D−1, en las 55.937.
  Ninguna lleva la de D.
- **Las EMA de SPY son causales**: recursivas desde el principio de la serie,
  sembradas con la SMA de las primeras n barras, sin ninguna pasada hacia atrás.
- **El régimen propio del worker es causal**: la ventana diaria de 126 ruedas
  se corta con fecha *estrictamente anterior* a la rueda en curso y el precio
  del día entra por la barra horaria ya cerrada. Recalculado desde cero, el
  régimen coincide con el del cache en 55.934 de 55.934 señales.
- **El `adjclose` no contamina nada.** La serie ajustada de SPY corrige
  dividendos con información posterior, así que en principio es un lookahead.
  Recorrido todo con el close crudo, el resultado es **idéntico al peso**
  (−0,38% IS, −0,64% OOS): el factor de ajuste es multiplicativo y constante
  entre dividendos, así que se cancela en los log-retornos y en la comparación
  precio-contra-EMA. Impacto medido: **cero**.

### 4.2 Lo que está mal: el umbral

El umbral de "volatilidad alta/baja" es **la mediana de todo el in-sample**
(0,1281). Está congelado para el OOS — eso `README.md` lo dice y es cierto—
pero **también se aplica hacia atrás dentro del propio in-sample**: la señal
del 19/10/2023 se clasifica con una mediana que se calculó con datos hasta el
30/06/2025. Eso es lookahead de 20 meses sobre el 100% de las decisiones del IS.
Y hay un segundo detalle: la mediana se calcula **por señal**, no por rueda, así
que un día con 40 señales pesa 40 veces más que un día con una.

Re-corrido point-in-time (en la rueda D sólo se usa la volatilidad conocida
hasta D−1, con un mínimo de 60 observaciones):

| Variante del umbral | Señales IS | Mensual IS Gold | Señales OOS | Mensual OOS Gold |
|---|---:|---:|---:|---:|
| base, sin filtro de vol | 528 | −0,83% | 371 | −0,95% |
| **umbral del informe** (mediana IS por señal, 0,1281) | 324 | **−0,38%** | 228 | **−0,64%** |
| mediana IS por rueda (0,1245) | 315 | −0,40% | 210 | −0,62% |
| **mediana EXPANSIVA point-in-time** | 419 | **−0,81%** | 258 | **−0,79%** |
| **mediana MÓVIL 252 ruedas, point-in-time** | 276 | **−0,30%** | 201 | **−0,49%** |
| close crudo, sin adjclose (umbral del informe) | 324 | −0,38% | 228 | −0,64% |

**El impacto del lookahead vale hasta 0,43 puntos mensuales en el IS.** Con la
mediana expansiva —que es la implementación PIT más literal— la mejora contra
el base pasa de **0,45 puntos a 0,02** en el IS y de 0,31 a 0,16 en el OOS. El
filtro deja de tener nada que mostrar.

Ahora bien, con la mediana móvil de 252 ruedas —que también es point-in-time y
es la versión más parecida en nivel a la del informe, porque no arrastra la
volatilidad de 2022— el resultado sale *mejor* que el del informe (−0,30% IS,
−0,49% OOS). Los dos son PIT y dan cosas opuestas. Eso no es un empate: **es la
prueba de que el número depende enteramente de dónde se ponga el umbral, y el
umbral es la perilla que decide cuánto se recorta.** Los nulos de las dos
variantes PIT lo confirman: la expansiva cae en el percentil 14 (IS) y 36 (OOS)
del nulo 2, la móvil en el 60 y el 60. Las dos alrededor de la mediana, ninguna
con p < 0,39.

### 4.3 La perilla, medida

Si el filtro fuera un descubrimiento sobre el mercado, tendría que haber un
umbral que separa bien y umbrales que separan mal. Si es una perilla de
exposición, el mensual tiene que mejorar monótonamente a medida que se aprieta,
sin importar dónde se lo ponga. Barrido del cuantil de la volatilidad del IS
(umbral congelado, gate base + vol ≤ umbral), Gold:

| Cuantil | Umbral | Señales IS | Trades IS | Mensual IS | Exp/trade IS | Max DD IS | Señales OOS | Trades OOS | Mensual OOS | Exp/trade OOS |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0,25 | 0,0978 | 164 | 45 | **−0,03%** | −$799 | 7,4% | 121 | 25 | **−0,04%** | −$1.704 |
| 0,35 | 0,1089 | 227 | 59 | −0,13% | −$3.229 | 8,6% | 175 | 39 | −0,16% | −$4.289 |
| 0,50 | 0,1245 | 315 | 75 | −0,40% | −$7.597 | 12,0% | 210 | 51 | −0,62% | −$12.328 |
| 0,65 | 0,1377 | 392 | 89 | −0,68% | −$10.856 | 17,4% | 275 | 76 | −0,82% | −$11.021 |
| 0,75 | 0,1508 | 449 | 101 | −0,88% | −$12.430 | 20,2% | 317 | 82 | −0,75% | −$9.377 |
| 1,00 | (base) | 528 | 111 | −0,83% | −$10.657 | 19,2% | 371 | 94 | −0,95% | −$10.250 |

**Monótono en las dos ventanas.** El mensual mejora exactamente en proporción a
cuántos trades se sacan, y el límite de la perilla es el cero: con q = 0,25 el
bot opera 45 veces en 20 meses y el mensual da −0,03%, que es lo mismo que
apagarlo del todo. El drawdown baja igual de monótono, de 19,2% a 7,4%, que es
lo que pasa cuando uno reduce el tamaño de la apuesta. En el OOS la expectancy
por trade ni siquiera es monótona (−$1.704 → −$4.289 → −$12.328 → −$11.021 →
−$9.377), o sea que ni el orden se mantiene.

**La conclusión del bloque C, en una línea: el filtro de volatilidad es un
control de volumen, no un detector. La mediana del IS no tiene nada de especial
como umbral; lo único que hace es fijar cuánto se recorta.**

---

## 5. Bloque D · la fase del apagado

Para cada bloque en que el filtro de volatilidad apagó el bot se midió dónde
apagó y dónde reencendió, contra el precio de SPY (lo que el filtro mira) y
contra una canasta equiponderada de los 38 (lo que el bot opera de verdad). Se
descartaron los bloques pegados a los bordes de la ventana.

| | SPY / IS | SPY / OOS | Canasta / IS | Canasta / OOS |
|---|---:|---:|---:|---:|
| Bloques evaluables | 9 | 11 | 9 | 11 |
| Del apagado al mínimo | −2,63% | −0,32% | −3,23% | −0,47% |
| ...en ruedas | 6,8 | 4,0 | 6,0 | 3,1 |
| Del mínimo al reencendido | +6,15% | +2,18% | +9,50% | +3,77% |
| ...en ruedas | **16,3** | **6,7** | **17,1** | **7,6** |
| Ruedas mínimo→reencendido, nulo | 5,3 | 1,9 | 6,2 | 2,8 |
| Percentil del retraso | **100%** | **100%** | **100%** | **100%** |

**El filtro apaga casi arriba del mínimo y reenciende muchísimo después.** En
el IS el apagado se come sólo 2,6 puntos de caída de SPY (6,8 ruedas hasta el
piso) y después se queda afuera 16,3 ruedas más, durante las cuales SPY se
recupera 6,15%. El percentil 100% en las cuatro celdas quiere decir lo obvio:
como el bloque termina cuando la volatilidad ya bajó, y la volatilidad baja
después del rebote, el reencendido real cae siempre más tarde que cualquier
punto sorteado dentro del bloque.

La pregunta que importa no es si reenciende tarde —eso es mecánico— sino si
**reencender antes hubiera valido plata**. Para eso, el nulo: reencender en un
punto uniformemente al azar dentro del mismo bloque, y comparar el retorno de
las ruedas siguientes.

| Retorno DESPUÉS del reencendido | SPY / IS | SPY / OOS | Canasta / IS | Canasta / OOS |
|---|---:|---:|---:|---:|
| A 10 ruedas, real | +0,89% | +0,58% | +2,08% | +1,16% |
| A 10 ruedas, nulo (media) | +1,57% | +0,49% | +2,74% | +1,34% |
| Percentil / p | 15,3% / 0,847 | 59,7% / 0,403 | 23,5% / 0,765 | 40,4% / 0,596 |
| **A 20 ruedas, real** | **+0,08%** | **+1,82%** | **+0,81%** | **+3,71%** |
| **A 20 ruedas, nulo (media)** | **+1,55%** | **+1,37%** | **+3,08%** | **+2,99%** |
| **Percentil / p** | **4,6% / 0,954** | **87,4% / 0,126** | **4,1% / 0,959** | **88,5% / 0,115** |

**En el in-sample el filtro reenciende tarde de una manera que cuesta plata: el
retorno a 20 ruedas después del reencendido real es +0,08% contra +1,55% de un
reencendido al azar dentro del mismo bloque (percentil 4,6).** Reencender en
cualquier momento de la pausa hubiera sido mejor que esperar a que la
volatilidad bajara. En el out-of-sample pasa exactamente lo contrario
(percentil 87, p = 0,13): el reencendido real le gana al azar.

Con 9 y 11 bloques, el efecto **no replica**. La lectura honesta:

1. El retraso es real y es enorme (16 ruedas después del piso en el IS, 7 en el
   OOS), y es **intrínseco a pausar durante movimientos con reversión a la
   media**: el detector de volatilidad no puede apagarse antes de que la
   volatilidad suba ni encenderse antes de que baje, y la volatilidad baja
   cuando el rebote ya pasó. No se arregla afinando el detector.
2. Que ese retraso cueste plata depende de la ventana. En el IS costó 1,5
   puntos de SPY por bloque; en el OOS no costó nada.

El caso testigo, para dimensionar: el bloque del **04/03/2025 al 10/06/2025**,
69 ruedas apagadas. SPY cayó 14,7% en las primeras 26 ruedas y el bot reencendió
44 ruedas después del piso, con el rebote de +21,1% ya hecho. Ese solo bloque es
un tercio de las ruedas apagadas del in-sample.

---

## 6. Deflated Sharpe Ratio · N de 84 a 100

`INFORME.md` contaba 76 configuraciones; `INFORME-RECOMPRA.md` las llevó a 84.
Este informe agrega **16**: 4 variantes del umbral de volatilidad (mediana por
rueda, mediana expansiva PIT, mediana móvil 252 PIT, close crudo) × 2 ventanas,
más el barrido de 4 cuantiles del umbral (0,25 / 0,35 / 0,65 / 0,75) × 2
ventanas. **N = 100.**

**Los 5.000 sorteos de cada nulo NO entran en el N**, y a propósito: son la
distribución de referencia contra la cual se juzga una configuración, no
configuraciones candidatas que uno podría haber elegido. Contarlas sería
castigar dos veces el mismo test.

Reconstrucción verificada: las 84 SR previas se reproducen exacto (σ(SR) gold
3,8635e−2 y black 2,3182e−2, iguales a `results-recompra.json` al quinto
decimal; las 50 celdas del barrido de robustez coinciden 50/50). Con las 16
nuevas, σ(SR) queda en **0,040737 (Gold)** y **0,023329 (Black)**.

| Corrida | Sharpe Gold | DSR Gold | Sharpe Black | DSR Black |
|---|---:|---:|---:|---:|
| base, IS | −1,48 | 0,00002 | +0,11 | 0,142 |
| base, OOS | −1,78 | 0,00007 | +0,17 | 0,197 |
| **base + vol20 baja, IS** | −0,78 | 0,00101 | +0,49 | 0,276 |
| **base + vol20 baja, OOS** | −1,42 | **0,00041** | −0,05 | 0,141 |
| vol20 baja, mediana por rueda, OOS | −1,44 | 0,00034 | −0,14 | 0,120 |
| vol20 baja, mediana EXPANSIVA PIT, IS | −1,50 | 0,00002 | −0,09 | 0,092 |
| vol20 baja, mediana EXPANSIVA PIT, OOS | −1,64 | 0,00014 | −0,04 | 0,141 |
| vol20 baja, mediana MÓVIL 252 PIT, IS | −0,62 | 0,00190 | +0,54 | 0,299 |
| vol20 baja, mediana MÓVIL 252 PIT, OOS | −1,17 | 0,00099 | +0,10 | 0,179 |
| vol20 baja q=0,25, IS | −0,04 | 0,01538 | +0,84 | **0,444** |
| vol20 baja q=0,25, OOS | −0,11 | 0,02790 | +0,80 | **0,436** |
| vol20 baja q=0,75, IS | −1,61 | 0,00001 | −0,13 | 0,084 |

**Ninguno llega ni cerca de 0,95.** El mejor de todo este informe es "operar
sólo en el cuartil de volatilidad más baja" con tarifa Black, Sharpe 0,84 y
DSR 0,444 — y es el que opera 45 veces en 20 meses, o sea el que está más cerca
de no operar. Después de descontar que se probaron 100 cosas, sigue siendo una
moneda al aire. El DSR del filtro recomendado en el OOS con Gold baja de 0,0005
(con N = 76) a **0,00041** (con N = 100).

---

## 7. Lo que no está modelado en este informe (y para qué lado tira)

| Aproximación | Efecto |
|---|---|
| El nulo 2 baja el régimen del worker a nivel rueda (mayoría de barras) | Sólo afecta al par base vs sin régimen; los gates de vol y EMA son exactos |
| En los sorteos todas las señales entran con riesgo pleno; el filtro real mete 5 trades a medio riesgo (régimen "mixto") | 5 trades en 35 meses: irrelevante |
| El nulo 2 exige al menos 1 rueda de separación entre bloques | Preserva la distribución de duraciones; sin eso, dos bloques vecinos se fusionarían |
| El bloque D usa el cierre diario, no el intradía | El mínimo real del período puede estar dentro de una rueda; sesga la caída hacia abajo en magnitud, no en fase |
| El bloque D tiene 9 y 11 bloques | Es poca muestra; por eso el p del OOS y el del IS se contradicen |
| Los bloques pegados a los bordes de la ventana se descartan | 1 bloque por ventana, sin dirección conocida |
| Todo lo de `INFORME.md` §7 (earnings, libro de puntas, CCL diario, granularidad horaria) | Igual que en el informe principal |

---

## 8. Veredicto

**¿El filtro de volatilidad selecciona o sólo recorta exposición?**

**Sólo recorta exposición.** Los cuatro tests dicen lo mismo:

1. **Contra el nulo de trades al azar**, el filtro cae en el percentil 77 del IS
   (p = 0,23) y en el 45 del OOS (p = 0,55).
2. **Contra el nulo de bloques de calendario**, que es el honesto, cae en el
   percentil 59 del IS (p = 0,41) y en el 47 del OOS (p = 0,53). En Black, en
   el 32 y el 36 del OOS: apagar en fechas al azar hubiera salido mejor.
3. **La expectancy de lo que deja pasar no se distingue de la de lo que
   bloquea**: p = 0,28 en el IS y p = 0,73 en el OOS con Gold, y lo mismo con
   Black y con el bruto sobre nocional. El filtro no discrimina.
4. **El umbral tenía lookahead** —la mediana de todo el IS aplicada a la
   primera rueda del IS— y vale hasta 0,43 puntos mensuales. Corrido
   point-in-time con mediana expansiva, la mejora del IS contra el base se cae
   de 0,45 puntos a 0,02. Con mediana móvil de 252 ruedas sale mejor que el
   informe. Que dos implementaciones point-in-time igual de legítimas den
   resultados opuestos es la prueba final de que lo que se está moviendo es la
   perilla del volumen, no un detector.

Y el barrido del cuantil lo cierra: el mensual mejora monótonamente al apretar
el umbral, hasta −0,03% con q = 0,25, que es el mensual de un bot que casi no
opera. **El límite de esa perilla es el cero, no un número positivo.** Sigue sin
aparecer ningún régimen donde el bot gane plata con tarifa Gold.

**¿Y la fase del apagado?** El filtro reenciende, en promedio, 16 ruedas
después del piso en el IS y 7 en el OOS, contra 5 y 2 de un reencendido al
azar: el retraso está en el percentil 100 en las cuatro celdas. Pero eso le
cuesta plata sólo en el IS (retorno a 20 ruedas de +0,08% contra +1,55% del
nulo, percentil 4,6) y no en el OOS (percentil 87). **El retraso es intrínseco
a pausar durante movimientos con reversión a la media** —la volatilidad recién
baja cuando el rebote ya pasó— y no se arregla en el detector; que cueste o no
cueste depende de la ventana.

**La corrección que hay que hacerle a `INFORME.md`:** la frase "la única
recomendación defendible es bajar la exposición cuando la volatilidad de SPY
está por encima de su mediana" hay que leerla sacándole la palabra
"volatilidad". Lo defendible es **bajar la exposición**, punto. La volatilidad
de SPY no aporta nada por encima de sortear los días. Si LP quiere operar menos,
que opere menos; no hace falta un detector de régimen para eso, y poner uno da
la ilusión de que hay una regla donde sólo hay un dial de tamaño.

**Y la que no cambia:** la palanca sigue siendo la tarifa. Un sistema cuya única
mejora reproducible es operar menos está diciendo que cada vuelta destruye
valor, y lo que destruye valor en cada vuelta es el 1,12% de Gold contra un
edge de 0,36%.

---

*Generado offline el 17/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `nulo.js` (reusa `engine.js`; el chequeo de arranque
reproduce las 20 celdas de `INFORME.md` §3 con Δ = 0). Semilla 20260917,
5.000 sorteos por celda. Detalle completo en `results-nulo.json` y
`run-nulo.log`. Convenciones, aproximaciones y anti-lookahead en `README.md`,
`INFORME.md` e `INFORME-RECOMPRA.md`.*
