# Informe · el test placebo · ¿el motor mide, o fabrica?

**La primera línea, sin vueltas: el motor NO fabrica señal, pero el edge que
midió este proyecto NO sobrevive al placebo. Las dos cosas a la vez, y hay que
leerlas juntas. Sobre series sintéticas donde por construcción no hay nada que
encontrar —retornos centrados, dólar sin deriva— la cañería completa da
−0,02%/mes (IS) y −0,05%/mes (OOS), que es exactamente el costo de Cocos más un
residuo de +0,067 pp/mes que se explica entero por el término de Jensen de
centrar retornos logarítmicos. O sea: el placebo cae donde tiene que caer y la
cañería está sana. Pero cuando el placebo conserva el drift real de los papeles
y el CCL de verdad —que es el test que pidió LP— los 100 universos de puro ruido
dan +0,25%/mes (bootstrap) y +0,23%/mes (bloques de 5), y el resultado real de
+0,26% (IS) y +0,32% (OOS) cae ADENTRO de esa distribución: percentil 58 y 62
con la referencia correcta, p = 0,43 y 0,39. En 42 de cada 100 universos de puro
ruido el mismo motor sacó MÁS plata que corriendo sobre los datos de verdad en el
in-sample, y en 38 de cada 100 en el out-of-sample. Con el CCL aleatorizado sin
deriva el in-sample real se va a −0,17%/mes y queda en el percentil 17 del mismo
placebo: apagado el
dólar, el bot rinde PEOR que el ruido. Y de yapa apareció un costo que ningún
informe del proyecto tenía: el stop del backtest se ejecuta siempre en el nivel
exacto, aunque la barra haya abierto por debajo. Cobrarlo cuesta 0,33 pp/mes
(IS) y 0,29 pp/mes (OOS) — más que todo el resultado.**

Todo corrió local sobre `data/`. No se tocó el VPS ni Supabase. Motor, gate y
reglas de ejecución idénticos a `INFORME.md` / `INFORME-COCOS.md`.

**Semilla del generador: `20260917`** (mulberry32, `placebo.js`). 100 universos
sintéticos por placebo, 4 placebos, 400 universos en total, más un control de
construcción. Huella de reproducibilidad: 1.997 números, FNV-1a `80f3fcd3`.

---

## 0. Por qué había que hacer esto

Todo lo que este proyecto midió en la semana —el signo del caso base, la
descomposición CCL/papel, el barrido de agresividad, el TP parcial— se apoya en
un supuesto que nunca se testeó: **que el motor y el simulador miden bien.**

Los modelos nulos que ya había (`nulo.js`, `timestop.js`, `barrido.js`,
`cocos.js`, `agresividad.js`, `parcial.js`) contestan siempre la misma clase de
pregunta: *dado el flujo de señales, ¿esta regla le gana al azar?* Ninguno
contesta la anterior: *el flujo de señales, ¿vale algo?* Para eso hace falta
correr la cañería entera sobre datos donde **por construcción no hay nada**. Si
igual aparece edge, el problema no es la estrategia: es la cañería.

Eso es este informe.

---

## 1. Chequeo de consistencia (esto va antes que nada)

`placebo.js` no reusa el cache `signals.json`: **regenera el flujo de señales
desde cero** con su propia copia del motor, porque para correr sobre series
sintéticas tiene que poder generarlo. Por lo tanto el primer chequeo no es
comparar métricas, es comparar el flujo entero.

| Chequeo | Resultado |
|---|---|
| Señales regeneradas vs `signals.json` | **55.937 vs 55.937** |
| Huella FNV-1a del flujo (sym, ts, entrada, stop, target, score, R:R, contra-tendencia, régimen) | **`9b5b5f58` vs `9b5b5f58`** |
| Caso base 38 limpios, Cocos, IS | **111 trades · +0,2603%/mes** (publicado: 111 · +0,2603%) |
| Caso base 38 limpios, Cocos, OOS | **94 trades · +0,3236%/mes** (publicado: 94 · +0,3236%) |
| Descomposición IS | bruto 0,360% · papel −0,043% · CCL +0,403% (idéntica a `INFORME-COCOS.md` §3) |
| Descomposición OOS | bruto 0,372% · papel +0,281% · CCL +0,091% |

**El chequeo pasa: las 55.937 señales son las mismas una por una y el caso base
reproduce +0,26 / +0,32 al cuarto decimal.** El script aborta solo si no pasa;
no abortó.

Y como el script corre en `worker_threads`, hace falta un chequeo más: que el
resultado no dependa de cómo el sistema operativo reparta los universos entre
hilos. La semilla de cada universo depende sólo de `(placebo, k)`, nunca del
hilo. Verificado: la misma corrida con **4 hilos y con 7 hilos** da la misma
huella (`4439d33e` con `--univ=3`). La corrida completa de 100 universos da
**`80f3fcd3`**.

---

## 2. Cómo se construyen los placebos

Para cada uno de los 38 papeles limpios se construye una serie sintética que
conserva **el calendario de ruedas, la cantidad de barras, el volumen de cada
barra, la geometría intrabarra (o/c, h/c, l/c) y el nivel de precio de partida**.
Lo único que se aleatoriza es el camino del cierre.

Una barra sintética `i` es la barra REAL fuente `src[i]` con el cierre
reescalado. Según de dónde salga `src[i]` y qué retorno se aplique:

| Placebo | Retorno de la barra `i` | Qué destruye | Qué conserva |
|---|---|---|---|
| **1 · `rw`** | `N(mu, sd)` del papel | toda la estructura temporal **y la forma de la distribución** | volatilidad y drift |
| **2 · `boot`** | retorno real de una barra sorteada sin reemplazo | toda la estructura temporal | **el marginal exacto**: colas gordas, asimetría, drift |
| **3 · `bloque5`** | igual, pero permutando bloques contiguos de 5 barras | la estructura de más de 5 barras | el marginal exacto **y la autocorrelación de hasta 5 barras** |
| **4 · `nulo`** *(control propio)* | retorno real sorteado **menos la media** | la estructura temporal **y el drift** | el marginal salvo la ubicación |

Los tramos se encadenan: la diaria previa al arranque de la horaria (2021-09 →
2023-10) se sintetiza aparte con el mismo método, y la diaria del tramo horario
se arma **agregando las barras de 60 minutos sintéticas**, para que la serie
diaria y la horaria de cada papel sean coherentes entre sí — si no, las zonas de
soporte diarias quedarían en un precio y el spot en otro, y el motor no estaría
corriendo sobre nada parecido a un papel.

**SPY y QQQ también se sintetizan**, así que el régimen `risk_on / mixto /
risk_off` del gate del worker es el régimen del universo sintético. Es lo
correcto: el placebo tiene que aleatorizar todo lo que el motor mira.

### El control que hace falta para poder comparar: `ident`

Esa agregación de la diaria es una diferencia contra la cañería original, que usa
la diaria de Yahoo. Para medirla, el script corre la misma construcción con
**permutación identidad** (o sea, la serie real pasada por la misma máquina):

| | señales que pasan el gate | trades | mensual Cocos | bruto/op | papel/op |
|---|---:|---:|---:|---:|---:|
| Cañería original (real) IS | 528 | 111 | **+0,260%** | 0,360% | −0,043% |
| `ident` IS | 531 | 110 | **+0,366%** | 0,460% | −0,092% |
| Cañería original (real) OOS | 371 | 94 | **+0,324%** | 0,372% | +0,281% |
| `ident` OOS | 379 | 93 | **+0,407%** | 0,440% | +0,331% |

La construcción vale **+0,106 pp/mes (IS) y +0,083 pp/mes (OOS)**, por 3 y 8
señales de diferencia. Es chico pero no es cero, así que **todas las tablas de
este informe reportan las dos referencias**: el real de la cañería original y el
`ident`. La comparación honesta contra los placebos es contra `ident`, que pasó
por la misma máquina.

### El CCL

Dos versiones, como pidió la consigna:

- **`real`** — la serie verdadera de argentinadatos.
- **`sinDeriva`** — se toman los retornos diarios del CCL, se les resta la media
  y se permutan al azar. Misma volatilidad, misma forma, **deriva cero**. Cada
  universo `k` usa el sorteo `k`, y **el mismo sorteo `k` se aplica a la serie
  real y a `ident`**, así la comparación es pareada.

Mezclar los retornos del CCL sin centrarlos no sirve para esta pregunta: una
permutación conserva la suma, o sea conserva la deriva entera, y el carry
sobreviviría igual. Por eso la versión que contesta "¿es arrastre de dólar?" es
la centrada.

---

## 3. El resultado: los tres placebos y dónde cae el real

### 3.1 Retorno mensual (Cocos), con el CCL REAL

**IN-SAMPLE** (referencia: real +0,260% · `ident` +0,366%)

| Placebo | media | sd | p05 | p25 | p50 | p75 | p95 | real: pctil / p | **`ident`: pctil / p** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 · `rw` | +0,480% | 0,497 | −0,367 | +0,224 | +0,468 | +0,831 | +1,290 | 29,0 / 0,713 | **40,0 / 0,604** |
| 2 · `boot` | +0,245% | 0,471 | −0,537 | −0,106 | +0,279 | +0,576 | +0,968 | 47,0 / 0,535 | **58,0 / 0,426** |
| 3 · `bloque5` | +0,234% | 0,463 | −0,392 | −0,059 | +0,188 | +0,515 | +1,083 | 58,0 / 0,426 | **66,0 / 0,347** |
| 4 · `nulo` | +0,082% | 0,371 | −0,374 | −0,202 | +0,077 | +0,296 | +0,725 | 73,0 / 0,277 | **80,0 / 0,208** |

**OUT-OF-SAMPLE** (referencia: real +0,324% · `ident` +0,407%)

| Placebo | media | sd | p05 | p25 | p50 | p75 | p95 | real: pctil / p | **`ident`: pctil / p** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 · `rw` | +0,556% | 0,584 | −0,515 | +0,224 | +0,580 | +0,955 | +1,399 | 31,0 / 0,693 | **36,0 / 0,644** |
| 2 · `boot` | +0,223% | 0,435 | −0,509 | −0,074 | +0,276 | +0,526 | +0,890 | 57,0 / 0,436 | **62,0 / 0,386** |
| 3 · `bloque5` | +0,285% | 0,457 | −0,475 | −0,030 | +0,305 | +0,626 | +1,008 | 52,0 / 0,485 | **60,0 / 0,406** |
| 4 · `nulo` | +0,050% | 0,440 | −0,510 | −0,262 | +0,016 | +0,309 | +0,870 | 77,0 / 0,238 | **83,0 / 0,178** |

Contado de la forma más cruda posible, **cuántos de los 100 universos de puro
ruido le ganaron al bot**:

| | vs el real | vs `ident` |
|---|---:|---:|
| IS · `rw` | 71 / 100 | 60 / 100 |
| IS · `boot` | 53 / 100 | 42 / 100 |
| IS · `bloque5` | 42 / 100 | 34 / 100 |
| OOS · `rw` | 69 / 100 | 64 / 100 |
| OOS · `boot` | 43 / 100 | 38 / 100 |
| OOS · `bloque5` | 48 / 100 | 40 / 100 |

**Ninguna celda se acerca a p < 0,05.** El resultado real está en el medio de la
distribución del ruido, en las dos ventanas y con los tres placebos.

### 3.2 Edge bruto por operación (% del nocional)

Es la métrica que no depende de cuánta exposición tomó cada corrida, así que es
la que hay que mirar cuando la cantidad de trades no coincide.

| | real | `ident` | `rw` | `boot` | `bloque5` | `nulo` |
|---|---:|---:|---:|---:|---:|---:|
| **IS** | 0,360% | 0,460% | 0,419% | 0,349% | 0,328% | 0,248% |
| pctil de `ident` / p | — | — | 57 / 0,436 | 60 / 0,406 | 66 / 0,347 | 71 / 0,297 |
| **OOS** | 0,372% | 0,440% | 0,430% | 0,324% | 0,363% | 0,185% |
| pctil de `ident` / p | — | — | 47 / 0,535 | 60 / 0,406 | 56 / 0,446 | 71 / 0,297 |

Los 0,36% / 0,37% que `INFORME.md` §1 presenta como "el edge bruto del motor"
son **lo mismo que produce el motor sobre retornos mezclados al azar**.

### 3.3 La parte del papel, sin el dólar, por operación

Esta es la más limpia de todas: no depende del CCL (ni del real ni del
sorteado), porque se calcula usando el CCL de la entrada en las dos patas.

| | real | `ident` | `rw` | `boot` | `bloque5` | `nulo` |
|---|---:|---:|---:|---:|---:|---:|
| **IS** | −0,043% | −0,092% | +0,291% | +0,221% | +0,166% | +0,063% |
| pctil de `ident` | — | — | **6,0** | **15,0** | **21,0** | 33,0 |
| **OOS** | +0,281% | +0,331% | +0,306% | +0,178% | +0,211% | +0,011% |
| pctil de `ident` | — | — | 47,0 | 64,0 | 61,0 | 78,0 |

Dos lecturas, las dos incómodas:

1. **En el in-sample el motor queda por DEBAJO del ruido**: percentil 15 contra
   el bootstrap y 21 contra los bloques. Sobre las mismas series con la
   estructura temporal destruida, elegir soportes al azar habría producido
   +0,17% a +0,22% por operación; el motor con la serie verdadera produjo
   −0,09%. **Comprar el soporte que el motor elige fue peor que comprar
   cualquier cosa.**
2. **En el out-of-sample el motor queda por encima de la mediana pero muy lejos
   de la significancia**: percentil 61-64, p = 0,37-0,40. El +0,363 pp/mes de
   "edge de precio" que `INFORME-COCOS.md` §3 llamaba *"la única evidencia del
   proyecto a favor de que el motor seleccione algo"* **no se distingue del
   ruido**.

### 3.4 Cuántas señales encuentra el motor en el ruido

| | señales que pasan el gate (IS) | trades (IS) | señales (OOS) | trades (OOS) |
|---|---:|---:|---:|---:|
| real | 528 | 111 | 371 | 94 |
| `ident` | 531 | 110 | 379 | 93 |
| `rw` | 513 | 166,1 | 408 | 134,2 |
| `boot` | 436 | 113,1 | 328 | 85,0 |
| `bloque5` | 451 | 117,3 | 339 | 86,8 |
| `nulo` | 266 | 76,6 | 192 | 56,1 |

**Sobre retornos mezclados al azar, el motor encuentra el 83-85% de las señales
que encuentra sobre los datos de verdad**, con los mismos scores ≥ 7, los mismos
R:R ≥ 2 y el mismo régimen. Los pivotes, las zonas de ±0,6% y el score no son un
detector de estructura de mercado: son un detector de **ruido con memoria de
rango**, que es lo que tiene cualquier serie de precios.

El `nulo` encuentra la mitad porque, al centrar los retornos, el SPY y el QQQ
sintéticos pasan mucho menos tiempo arriba de su EMA50 y el gate de régimen
bloquea más. Es un confundido conocido de ese placebo y por eso su comparación
de nivel vale menos que la de por operación.

---

## 4. El CCL aleatorizado: lo que se estaba midiendo era dólar

Ahora con el CCL sorteado sin deriva (100 sorteos, pareados con cada universo).

Primero, qué le pasa al **resultado real** cuando se le saca la deriva del dólar:

| | con CCL real | con CCL sin deriva (media de 100 sorteos) | sd |
|---|---:|---:|---:|
| real · IS | **+0,260%** | **−0,174%** | 0,343 |
| `ident` · IS | +0,366% | **−0,211%** | — |
| real · OOS | **+0,324%** | **+0,192%** | 0,402 |
| `ident` · OOS | +0,407% | **+0,264%** | — |

**El in-sample cambia de signo.** Sin la deriva del dólar, el caso base de Cocos
da −0,17%/mes. Es la confirmación directa y por simulación de lo que
`INFORME-COCOS.md` §3 había deducido por descomposición contable (−0,18%/mes) —
dos caminos independientes, el mismo número.

Y ahora la ubicación del real dentro de los placebos, con el mismo CCL sorteado
para los dos lados:

**IN-SAMPLE** (referencia `ident`: −0,211%)

| Placebo | media | p05 | p50 | p95 | `ident`: pctil / p | p pareado |
|---|---:|---:|---:|---:|---:|---:|
| `rw` | +0,326% | −0,435 | +0,292 | +1,348 | **15,0 / 0,852** | 0,822 |
| `boot` | +0,122% | −0,564 | +0,095 | +0,873 | **17,0 / 0,832** | 0,782 |
| `bloque5` | +0,148% | −0,496 | +0,114 | +0,828 | **17,0 / 0,832** | 0,753 |
| `nulo` | −0,024% | −0,624 | −0,073 | +0,630 | 31,0 / 0,693 | 0,654 |

**OUT-OF-SAMPLE** (referencia `ident`: +0,264%)

| Placebo | media | p05 | p50 | p95 | `ident`: pctil / p | p pareado |
|---|---:|---:|---:|---:|---:|---:|
| `rw` | +0,354% | −0,789 | +0,416 | +1,353 | 44,0 / 0,564 | 0,545 |
| `boot` | +0,076% | −0,840 | +0,061 | +0,970 | 72,0 / 0,287 | 0,386 |
| `bloque5` | +0,151% | −0,719 | +0,140 | +1,041 | 61,0 / 0,396 | 0,406 |
| `nulo` | −0,050% | −0,696 | −0,086 | +0,803 | 75,0 / 0,257 | 0,327 |

**Con todas las letras, que es lo que pedía la consigna:** el resultado real
**no** se distingue del placebo ni con el CCL real ni con el CCL aleatorizado —
pero la diferencia entre los dos casos importa igual. Con el CCL real el bot
queda en el percentil 58-66 del in-sample; con el CCL sin deriva se hunde al
17. **Lo que el in-sample estaba midiendo era arrastre de dólar, y sacándoselo
el bot no sólo deja de ganar: rinde peor que elegir soportes al azar sobre las
mismas series mezcladas.** En el out-of-sample el papel aguanta —el bot pasa del
percentil 60 al 61-72— pero nunca cruza p < 0,05 ni de lejos.

---

## 5. ¿Fabrica señal la cañería? El placebo puro dice que no

El placebo `nulo` es el único que no tiene nada adentro: retornos centrados por
papel (drift cero) y CCL sin deriva. Descompuesto en puntos mensuales sobre el
capital, promediando los 100 universos:

| pp/mes | IS | OOS |
|---|---:|---:|
| Bruto | **+0,067** | **+0,044** |
| ...papel | +0,040 | +0,012 |
| ...dólar | +0,027 | +0,032 |
| Costo Cocos | −0,091 | −0,093 |
| **Neto** | **−0,024** | **−0,050** |

El criterio de lectura que fijó la consigna era: *si el placebo da cerca de
−costo, el motor está sano*. **Da −0,024% y −0,050% contra un costo de −0,091 y
−0,093.** Queda +0,067 y +0,044 pp/mes de bruto sin explicar. ¿Es señal
fabricada?

**No. Es el término de Jensen, y la cuenta cierra.** Centrar los retornos
*logarítmicos* no deja una serie sin deriva: deja una serie con deriva
aritmética `σ²/2`. La volatilidad horaria media de los 38 papeles es **1,072%**,
o sea `σ²/2 = 0,00574%` por barra; con 147 barras por mes eso son **+0,844% por
mes de deriva del activo**, que a la exposición de esta cartera (0,07-0,10 del
capital, `INFORME-AGRESIVIDAD.md` §5) da **+0,06 a +0,08 pp/mes**. La cañería
produjo **+0,040 pp/mes** de papel: *menos* que la deriva mecánica de las series
que le dieron de comer. Lo mismo del lado del dólar: +0,027 pp/mes es el σ²/2 de
los retornos del CCL centrados.

**Veredicto de esta sección: la cañería no inventa nada. Sobre series sin
información entrega el costo, ni un peso más.**

---

## 6. Los tres sospechosos, uno por uno

La consigna nombraba tres candidatos concretos por si el placebo salía positivo.
Se midieron los tres como variantes del simulador, sobre los datos reales y sobre
los 400 universos sintéticos. Δ en puntos mensuales contra su propia base.

| Sospechoso | Qué cambia la variante | Δ real IS | Δ real OOS | Δ medio en los placebos |
|---|---|---:|---:|---:|
| **Orden intrabarra de stop y target** | el target se evalúa ANTES que el stop (el base hace al revés) | **0,000** | **0,000** | +0,02 a +0,06 |
| **Fill al toque sin confirmación** | la límite se llena al CIERRE de la barra que tocó, no en el nivel | **+0,028** | **+0,150** | −0,22 a +0,08 |
| **El stop se llena siempre en el nivel exacto** | si la barra ABRIÓ debajo del stop, el stop se ejecuta en la apertura | **−0,331** | **−0,294** | −0,24 a −0,83 |

**1. El orden intrabarra no mueve nada.** Cero en las dos ventanas sobre datos
reales: en 205 trades no hay una sola barra que toque el stop y el target a la
vez. El simulador ya resuelve el empate del lado pesimista y el empate no existe.
Sospechoso descartado.

**2. El fill al toque no fabrica edge — va para el otro lado.** Esperar el cierre
de la barra para comprar **mejora** el resultado real (+0,03 pp en el IS, +0,15
en el OOS). O sea que el supuesto actual es conservador, no optimista. Hay que
leerlo con una salvedad: esa variante también descarta los fills donde la barra
cerró debajo del stop (111 → 98 trades en el IS, 94 → 86 en el OOS), así que
parte de la mejora es no tomar trades perdidos, no mejor precio. De paso, es la
primera medición directa de la línea que `INFORME-BARRIDO.md` §5 y
`INFORME-FINO.md` dejaron abierta ("no poner la límite en el nivel sino esperar
y comprar sólo si el precio quedó arriba"): la parte de "esperar" sola ya vale
+0,15 pp/mes en el OOS. Sigue sin testearse la parte de "comprar sólo si quedó
arriba" dentro de la cartera.

**3. El stop SÍ está roto, y es el hallazgo caro de este informe.** El simulador
cierra en `pos.stop` exacto cada vez que `b.l <= pos.stop`, aunque la barra haya
abierto 3% más abajo. Eso convierte el stop en una orden límite: el backtest
nunca paga un gap. Cobrándolo —ejecutar en la apertura cuando la barra abrió
debajo del stop— el caso base de Cocos pasa de **+0,260% a −0,071%/mes en el
in-sample** y de **+0,324% a +0,030% en el out-of-sample**.

Esto **no es señal fabricada** (el placebo lo sufre igual o más: −0,39 pp en el
bootstrap), es **un costo no modelado**, y es más grande que todo el resultado
que el proyecto viene reportando. `README.md` ya avisaba que "la salida por stop
se ejecuta en el nivel exacto" y lo llamaba optimista, pero nunca se había
medido. **Son 0,33 pp/mes, que se suman a los 0,14 pp/mes del spread de 0,25%
que midió `INFORME-AGRESIVIDAD.md` §9.** Con los dos, el caso base de Cocos está
en **−0,21%/mes (IS) y −0,13%/mes (OOS)**.

---

## 7. Lo que no está modelado en este anexo

| Aproximación | Efecto |
|---|---|
| La diaria del tramo horario se arma agregando las barras de 60' | Medido con `ident`: vale +0,106 pp/mes (IS) y +0,083 (OOS). Por eso todas las comparaciones se hacen contra `ident` |
| La geometría intrabarra y el volumen viajan con la barra fuente | Conserva el marginal del rango y del volumen; en el `rw` la geometría queda en su lugar mientras el cierre se aleatoriza, así que el rango conserva su clustering real |
| Los 38 papeles se sintetizan **independientes entre sí** | El placebo destruye la correlación transversal. Eso ANGOSTA la distribución del placebo (menos días de todo-para-abajo), o sea que el test es **conservador**: con correlación, la distribución sería más ancha y el real quedaría todavía más adentro |
| El CCL `sinDeriva` corre los retornos, no sólo los mezcla | Es a propósito: permutar sin centrar conserva la deriva entera y no contestaría la pregunta. Deja el σ²/2, que está cuantificado en §5 |
| El `nulo` opera 30% menos por el gate de régimen | Su comparación de nivel está sesgada a favor del bot; por eso el veredicto se apoya en la métrica por operación |
| El spread del CEDEAR (0,25%) no está en ninguna corrida | Baja todo en paralelo, real y placebo; no cambia ninguna ubicación relativa |
| 100 universos por placebo, no 5.000 | El error estándar del percentil es ~5 puntos. Alcanza de sobra para lo que se concluye (nada está cerca del borde); no alcanzaría para defender un p = 0,04 |

---

## 8. Veredicto

**¿El motor fabrica señal?** **No.** Sobre series sin información entrega
−0,02%/mes y −0,05%/mes, que es el costo de Cocos; el residuo de +0,067 pp es el
término de Jensen y la cuenta cierra al primer decimal. De los tres sospechosos
que nombró la consigna, dos no existen (el orden intrabarra da Δ = 0,000; el fill
al toque va para el otro lado) y el tercero —el stop que nunca se desliza— no
fabrica señal sino que **omite un costo de 0,33 pp/mes**.

**¿El edge medido esta semana sobrevive al placebo?** **No.** En las 16
comparaciones de mensual y en las 8 de bruto por operación, el resultado real cae
adentro de la distribución del ruido. Contra el bootstrap de retornos reales —el
test que la consigna marcaba como el que importa— el bot queda en el **percentil
58 (IS, p = 0,43) y 62 (OOS, p = 0,39)**. En 42 y 38 de cada 100 universos de
puro ruido con el mismo drift y el mismo marginal, el mismo motor sacó más plata
que con los datos de verdad.

**¿Qué era, entonces, el +0,26 / +0,32?** Drift del activo más carry de dólar,
cobrado a través de una exposición chica y comprado con 0,121% de peaje. El
placebo lo muestra sin ambigüedad: si uno le da al motor 38 series de ruido que
suben lo mismo que subieron los papeles de verdad, y un dólar que sube lo mismo
que subió el CCL, el motor entrega los mismos +0,25%/mes. No hace falta que haya
soportes.

**Lo que este informe invalida, sin suavizar:**

1. **La última evidencia positiva del proyecto se cae.** `INFORME-COCOS.md` §3
   decía que el +0,363 pp/mes de papel del out-of-sample era "la única evidencia
   del proyecto a favor de que el motor seleccione algo". Está en el percentil
   61-64 del placebo, p = 0,37-0,40. **No es evidencia.**
2. **El in-sample es peor de lo que se había reportado.** No es que el papel
   aportó −0,046 pp y el dólar +0,439; es que el papel aportó −0,046 pp *cuando
   el ruido aportaba +0,17 a +0,22 por operación*. Percentil 15-21. El motor no
   fue neutro en el in-sample: fue **peor que el azar**.
3. **El nivel absoluto de todo el proyecto está 0,33 pp/mes arriba de donde
   debería.** Sumado al spread de 0,25% de `INFORME-AGRESIVIDAD.md` §9, el caso
   base de Cocos queda en −0,21%/mes (IS) y −0,13%/mes (OOS). La celda elegida
   del §15 (+2,23 / +2,44, o +1,26 / +1,24 con spread) hay que releerla con el
   mismo descuento, que en esa configuración es más grande porque opera más.

**Lo que este informe NO invalida:**

- **Los modelos nulos anteriores** (§10 a §13, §16). Todos miden *diferencias*
  contra el caso base con la misma cañería de los dos lados; el placebo no los
  toca. El filtro de volatilidad, el time-stop y la zona cedida siguen muertos
  exactamente por donde estaban muertos.
- **La cadena de consistencia.** Las 55.937 señales, el port del motor, la
  reproducción de las métricas publicadas: todo intacto.
- **El veredicto de la tarifa** (§14) y **el del benchmark** (§15). El placebo es,
  de hecho, la versión fuerte del control de `INFORME-AGRESIVIDAD.md` §5: ahí se
  comparaba contra estar comprado en SPY a la misma exposición y once de doce
  celdas daban exceso negativo; acá se compara contra **el propio motor corriendo
  sobre ruido** y el resultado es el mismo.

**La conclusión operativa, en una línea:** la cañería mide bien, y lo que mide
bien es que no hay nada — el bot de niveles, tal como está, produce sobre los
datos reales lo mismo que produce sobre retornos mezclados al azar, y buena parte
de ese "lo mismo" desaparece cuando se le cobra el gap del stop que el backtest
le viene regalando.

---

*Generado offline el 19/09/2026 sobre las series de `research/backtest-5y/data`.
Script: `placebo.js` (regenera las 55.937 señales desde `engine.js` y reproduce
`signals.json` con huella idéntica; el caso base reproduce +0,2603% y +0,3236%
de `results-cocos.json`; el script aborta si alguna de las dos cosas falla).
Semilla 20260917, 100 universos por placebo, 400 universos en total. Huella de
reproducibilidad: 1.997 números, FNV-1a `80f3fcd3`. Detalle completo en
`results-placebo.json` y `run-placebo.log`. Convenciones, aproximaciones y
anti-lookahead en `README.md` e `INFORME.md`.*
