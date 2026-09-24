# Informe · el mismo bot, pero con la tarifa de Cocos

**La primera línea, sin vueltas: con la comisión de Cocos el bot deja de
perder y pasa a ganar, pero gana poco. Los 38 limpios dan +0,26%/mes
in-sample y +0,32%/mes out-of-sample; el universo de 50 con alta real da
+0,88% y +0,74%. En plata: entre $18.000 y $62.000 por mes sobre un capital de
$7.000.000. El piso de 3% mensual que pide LP son $210.000 por mes: el mejor
número de todo este informe es el 29% de ese piso, y el del universo que el bot
opera de verdad es el 9%. Además —y esto es lo incómodo— en el in-sample el
resultado entero es el dólar: el papel aportó −0,05 puntos mensuales y el
arrastre del CCL +0,44. Con Cocos, el in-sample no es selección de papeles, es
cobrar carry de dólar pagando 0,121% de peaje por vuelta. En el out-of-sample
sí hay edge de precio (+0,36 pp de papel contra +0,12 de dólar), que es la
única parte del resultado que se parece a lo que el bot dice hacer.**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS ni
Supabase. Motor y reglas de ejecución idénticos a `INFORME.md`: **las columnas
Gold, Platinum y Black reproducen `results.json` número por número** (84
comparaciones, 0 descuadres — ver §0).

---

## 0. La tarifa: de dónde sale el número y qué incluye

La constante se tomó **literal** del worker, no se estimó:

```
// workers/niveles-auto/worker.js
const IVA = 1.21;
// En Cocos no hay comision del broker: se paga solo esto.
const FEE_COCOS = 0.0005 * IVA;
```

| | por punta | ida y vuelta |
|---|---:|---:|
| IOL Gold | 0,6655% | **1,3310%** nominal · **1,121%** medido (la segunda pata va bonificada cuando el trade cierra el mismo día: pasa en ~35% de las patas) |
| IOL Platinum | 0,4235% | 0,8470% nominal · 0,721% medido |
| IOL Black | 0,1815% | 0,3630% nominal · 0,321% medido |
| **Cocos** | **0,0605%** | **0,1210%** nominal **y medido** |

El costo medido de la corrida (comisiones pagadas sobre nocional comprado) da
**0,1212% en las dos ventanas**, contra 1,121% (IS) y 1,104% (OOS) de Gold. Es
el nominal de 0,1210% más la diferencia entre el nocional de salida y el de
entrada, y no se mueve entre ventanas porque en Cocos **no hay bonificación
intradiaria que modelar**: como no hay comisión de broker, las dos
patas cuestan lo mismo (el worker lo dice explícito en el bloque de cierre de
trade, donde calcula `feesAlt = (pxArsEnt + pxArsSal) * qty * FEE_COCOS`).

**Qué hay adentro de ese 0,0605%.** Son derechos de mercado 0,050% + IVA 21%.
El worker deja anotado que la cifra sale de medir **183 operaciones reales de
CEDEARs del libro de LP** ($11.093 M operados), y que BYMA cobra dos tasas
distintas: 0,044% cuando se compra y se vende el mismo papel en el día
("Compra/Venta Trading", 94 ops) y 0,050% cuando no ("Compra/Venta", 89 ops).
**El bot es swing —entra un día y sale otro— así que le corresponde la cara**,
que es la que está en la constante. El 0,0545% que figuraba antes era el
promedio ponderado de las dos y no describe ninguna de las dos operatorias.

**Qué NO está adentro, y por qué no corresponde sumarlo.** La memoria
`midas-cocos-costos` agrega la caución tomadora (3% TNA + BYMA + IVA, all-in =
tasa de mercado + 4,07 puntos) y la palanca T1. Eso **no aplica acá**: la
caución es el costo de financiar un descubierto, y el backtest **nunca se
apalanca** — el capital es $7.000.000 fijo, el tope por posición es 20% y el
simulador recorta la cantidad contra la caja libre. En Cocos, comprar CEDEARs
con plata propia y venderlos otro día cuesta exactamente los derechos de
mercado más IVA, dos veces. Si algún día LP corriera este bot con palanca T1
habría que sumarle ~0,069%/día corrido de funding, que sobre una tenencia
mediana de 4 días calendario sería ~0,28% por vuelta — o sea **más del doble
que toda la comisión**, y daría vuelta el signo. Este informe modela el caso
sin palanca, que es el que corre hoy.

La otra aclaración: Cocos no tiene API. El bot está en IOL porque es lo único
automatizable hoy. Todo lo que sigue mide qué pasaría **si la misma estrategia
se ejecutara donde LP ya opera a mano**, que es exactamente para lo que el
worker viene registrando la tarifa sombra desde julio.

---

## 0.b Chequeo de consistencia (esto va antes que nada)

Se volvió a correr el caso base con el tier de Cocos agregado y se comparó
contra `results.json`, métrica por métrica:

| Corrida | comparaciones | descuadres |
|---|---:|---:|
| 38/base/IS · gold, platinum, black | 21 | 0 |
| 38/base/OOS · gold, platinum, black | 21 | 0 |
| 50/base/IS · gold, platinum, black | 21 | 0 |
| 50/base/OOS · gold, platinum, black | 21 | 0 |

Se compararon trades, retorno mensual, P&L total, win rate, payoff, Sharpe y
max drawdown, con tolerancias de 1e−9 (relativas) y 1e−6 (pesos). **Los 84
valores coinciden.** Agregar el cuarto tier no movió nada de lo publicado: el
script aborta solo si aparece un descuadre, y no abortó. Además el barrido de
robustez reproduce las 50 celdas de `results.json` al noveno decimal (50/50) y
el umbral `volMedIS = 0,1281` coincide con el publicado.

---

## 1. El caso base: los 38 limpios, las cuatro tarifas

IS = 2023-10-19 → 2025-06-30 (20,4 meses, 111 trades).
OOS = 2025-07-01 → 2026-09-17 (14,6 meses, 94 trades).

**IN-SAMPLE**

| Métrica | Gold | Platinum | Black | **Cocos** |
|---|---:|---:|---:|---:|
| Trades | 111 | 111 | 111 | 111 |
| **Retorno mensual** | **−0,83%** | **−0,39%** | **+0,04%** | **+0,26%** |
| P&L total | −$1.182.915 | −$561.291 | +$60.333 | **+$371.145** |
| Comisiones pagadas | $1.742.433 | $1.120.809 | $499.185 | **$188.373** |
| Win rate | 31,5% | 33,3% | 36,9% | **38,7%** |
| Payoff | 1,33 | 1,58 | 1,75 | **1,86** |
| Sharpe anualizado | −1,48 | −0,69 | +0,11 | **+0,51** |
| Max drawdown | 19,2% | 11,8% | 5,8% | **4,8%** |
| Expectancy por trade | −$10.657 | −$5.057 | +$544 | **+$3.344** |
| Costo de ida y vuelta medido | 1,121% | 0,721% | 0,321% | **0,121%** |

**OUT-OF-SAMPLE**

| Métrica | Gold | Platinum | Black | **Cocos** |
|---|---:|---:|---:|---:|
| Trades | 94 | 94 | 94 | 94 |
| **Retorno mensual** | **−0,95%** | **−0,44%** | **+0,07%** | **+0,32%** |
| P&L total | −$963.500 | −$446.217 | +$71.066 | **+$329.708** |
| Comisiones pagadas | $1.452.740 | $935.457 | $418.174 | **$159.532** |
| Win rate | 39,4% | 39,4% | 41,5% | **43,6%** |
| Payoff | 0,88 | 1,19 | 1,47 | **1,57** |
| Sharpe anualizado | −1,78 | −0,82 | +0,17 | **+0,65** |
| Max drawdown | 17,7% | 12,7% | 8,0% | **5,7%** |
| Expectancy por trade | −$10.250 | −$4.747 | +$756 | **+$3.508** |
| Costo de ida y vuelta medido | 1,104% | 0,711% | 0,318% | **0,121%** |

El win rate y el payoff se mueven entre tarifas porque el signo del P&L de cada
trade depende de la comisión: 8 trades del IS y 4 del OOS cambian de perdedor
a ganador sólo por la tarifa.

**Lo que hay que mirar y no es la primera columna:** el bruto no cambió. Sigue
siendo 0,360% (IS) y 0,372% (OOS) del nocional. Cocos no mejora la estrategia;
le saca el peaje de encima. El P&L de Cocos es, casi exactamente, el bruto
menos $188.373: **la tarifa se lleva el 34% del bruto en el IS y el 33% en el
OOS, contra el 311% y el 297% que se llevaba Gold.**

En plata por mes: **$18.221/mes en el IS y $22.653/mes en el OOS.**

---

## 2. El universo de 50 con fecha de alta real

Mismos criterios que `INFORME.md` §2: cada joven entra el día de su primera
rueda horaria y las cáscaras de SPAC van truncadas.

| | 38 IS | 50 IS | 38 OOS | 50 OOS |
|---|---:|---:|---:|---:|
| Trades | 111 | 174 | 94 | 149 |
| Mensual Gold | −0,83% | −0,78% | −0,95% | −1,19% |
| Mensual Platinum | −0,39% | −0,12% | −0,44% | −0,42% |
| Mensual Black | +0,04% | +0,55% | +0,07% | +0,36% |
| **Mensual Cocos** | **+0,26%** | **+0,88%** | **+0,32%** | **+0,74%** |
| P&L Cocos | +$371.145 | **+$1.258.603** | +$329.708 | **+$756.965** |
| Sharpe Cocos | +0,51 | +1,27 | +0,65 | +1,12 |
| Max DD Cocos | 4,8% | 4,8% | 5,7% | 6,1% |
| Max DD Gold | 19,2% | 23,9% | 17,7% | 23,1% |
| Bruto por trade | 0,360% | 0,639% | 0,372% | 0,484% |
| Bruto sin CCL | −0,043% | +0,184% | +0,281% | +0,349% |

### El sesgo de selección recalculado

| Sesgo (50 menos 38, puntos mensuales) | IS | OOS |
|---|---:|---:|
| Gold | +0,04 | **−0,25** |
| Platinum | +0,28 | +0,02 |
| Black | +0,51 | +0,29 |
| **Cocos** | **+0,62** | **+0,42** |

**Con Cocos el sesgo deja de cambiar de signo entre ventanas.** En Gold sumar
los 12 papeles jóvenes mejoraba levemente el IS (+0,04) y empeoraba el OOS
(−0,25); con Cocos mejora las dos, y bastante. La explicación es la misma que
ya estaba en `INFORME.md`: los jóvenes tienen más edge bruto (0,64% contra
0,36% por trade en el IS) porque se mueven más, y la tarifa Gold se comía ese
movimiento extra junto con el drawdown que sube de 19% a 24%. Sin tarifa, el
movimiento extra queda del lado de LP.

**Pero ojo con leer el +0,88% como el número bueno.** El universo de 50 incluye
papeles que el bot real **no opera** (OKLO, RGTI, SATL, KEEL, LAR y compañía:
los que el INVENTARIO marcó como sucios o jóvenes), y es justamente donde el
bruto sin CCL del IS pasa de −0,04% a +0,18% — o sea que buena parte de la
mejora viene de papeles con historia corta y volatilidad alta, que es el tipo
de muestra donde uno espera que el backtest sea más optimista que la realidad.
El número que corresponde a lo que el bot mira hoy sigue siendo el de los 38.

---

## 3. La descomposición que importa: cuánto es el dólar

El bruto de cada pata se calcula dos veces: con el CCL de la fecha de salida (el
bruto real) y con el CCL de la entrada en las dos patas (lo que puso el papel).
La diferencia es el arrastre del dólar.

| En % del nocional | 38 IS | 38 OOS | 50 IS | 50 OOS |
|---|---:|---:|---:|---:|
| Bruto por trade | +0,360% | +0,372% | +0,639% | +0,484% |
| ...lo que puso el papel | **−0,043%** | +0,281% | +0,184% | +0,349% |
| ...lo que puso el dólar | **+0,403%** | +0,091% | +0,454% | +0,135% |

Llevado a puntos mensuales sobre el capital, que es como se lee el resultado:

| En %/mes del capital | 38 IS | 38 OOS | 50 IS | 50 OOS |
|---|---:|---:|---:|---:|
| Bruto | +0,392 | +0,480 | +1,090 | +0,991 |
| ...papel | **−0,046** | **+0,363** | +0,314 | +0,716 |
| ...dólar (CCL) | **+0,439** | **+0,117** | +0,775 | +0,276 |
| Costo Cocos | −0,132 | −0,157 | −0,207 | −0,248 |
| Costo Gold | −1,222 | −1,426 | −1,875 | −2,186 |
| **Neto Cocos** | **+0,260** | **+0,324** | **+0,883** | **+0,743** |
| Neto Gold | −0,830 | −0,946 | −0,785 | −1,195 |

**Con todas las letras: en el in-sample, el resultado positivo de Cocos es
entero el dólar.** El papel restó 0,046 puntos mensuales; el CCL puso 0,439. Si
en el IS el dólar hubiera estado planchado, el bot en Cocos habría dado
**−0,18%/mes** (papel −0,046 menos costo 0,132). Eso no es seleccionar
soportes: es estar largo dólar durante ~4 días calendario por trade y pagar
0,121% de peaje por el privilegio. El mismo carry lo consigue LP comprando el
CEDEAR y no tocándolo, sin pagar peaje ninguno y sin drawdown del 4,8%.

**En el out-of-sample la historia es otra y es mejor:** +0,363 puntos
mensuales de papel contra +0,117 del dólar. Ahí el 76% del bruto es edge de
precio de verdad. Es el único bloque de todo el proyecto donde el bot se
parece a lo que dice ser — y es una sola ventana de 14,6 meses con 94 trades.

Que el IS y el OOS digan cosas opuestas sobre el origen del edge es, en sí
mismo, un dato: **no hay evidencia estable de que el motor seleccione**. Hay
evidencia de que a veces el dólar acompaña y a veces el papel.

---

## 4. Las cinco hipótesis muertas, re-corridas con Cocos

Regla de la casa: todo lo que reduce cantidad de trades pasa por el modelo
nulo, sin excepción. Semilla 20260917, 5.000 sorteos por celda.

### 4.1 La recompra post TP parcial — **revive a medias, y no sobrevive al nulo en las dos ventanas**

P&L incremental de la recompra sobre las dos ventanas juntas (35 meses):

| Nivel de recompra | Gold | Platinum | Black | **Cocos** |
|---|---:|---:|---:|---:|
| `rc-entrada` (32 recompras) | −$88.659 | −$5.977 | +$76.706 | **+$118.048** |
| `rc-entrada-stop` (23 recompras) | +$25.596 | +$83.651 | +$141.706 | **+$170.733** |
| *sens.*: `rc-entrada`, gana el stop | +$27.818 | +$86.894 | +$145.970 | +$175.508 |
| *sens.*: `rc-entrada-stop`, gana el stop | +$100.823 | +$142.204 | +$183.585 | +$204.275 |

En puntos mensuales: `rc-entrada` aporta **0,048 pp/mes** y `rc-entrada-stop`
**0,070 pp/mes**. Sobre un base de +0,26/+0,32, es un 20% más de resultado.

`INFORME-RECOMPRA.md` decía que si se llegaba a Black el nivel a probar era el
de **mitad de camino al stop**. Con Cocos eso se confirma: `rc-entrada-stop` le
gana a `rc-entrada` en las dos ventanas y en las cuatro tarifas, y es el único
que no cambia de signo en ninguna celda.

**Contra el nulo** —recomprar la misma cantidad de veces, en trades elegidos al
azar entre los que tuvieron TP parcial, en una barra al azar posterior al TP,
al cierre de esa barra— la cosa queda así:

| | IS · percentil / p | OOS · percentil / p |
|---|---:|---:|
| `rc-entrada`, Cocos | 71,1% / **p = 0,289** | 98,1% / **p = 0,019** |
| `rc-entrada-stop`, Cocos | 85,8% / **p = 0,142** | 97,9% / **p = 0,021** |
| `rc-entrada`, Gold | 72,2% / p = 0,278 | 98,9% / p = 0,011 |

Y el bootstrap del aporte individual de cada recompra (¿el total es
distinguible de cero?):

| | IS · p(total ≤ 0) | OOS · p(total ≤ 0) |
|---|---:|---:|
| `rc-entrada`, Cocos | 0,495 | 0,143 |
| `rc-entrada-stop`, Cocos | 0,190 | 0,079 |

**Veredicto: revive el signo, no revive la evidencia.** Con Cocos la recompra
deja de restar y pasa a sumar en las dos ventanas y en las dos variantes de
nivel, cosa que en Gold no pasaba. Pero **en el in-sample no le gana al azar
(p = 0,14 y 0,29)** y el aporte total no es distinguible de cero (p = 0,19 y
0,49). Sólo el out-of-sample pasa p < 0,05, y el propio nulo muestra por qué
hay que desconfiar: la mediana del nulo es **negativa** en las cuatro celdas
(−$46.000 a −$55.000 en el IS), o sea que recomprar en un momento cualquiera
destruye plata y recomprar en el nivel elegido no — lo cual es consistente con
que el nivel importe, pero con 32 y 23 fills en 35 meses no alcanza. Además el
supuesto intrabarra sigue pesando más que el efecto: la variante optimista
mueve el número de $118.048 a $175.508.

**Recomendación:** si LP operara esto en Cocos, la recompra a **mitad de camino
al stop** es defendible como experimento —aporta 0,07 pp/mes, nunca resta, y
tiene mecánica sensata— pero no como hallazgo. Es un trade cada cinco semanas.

### 4.2 El time-stop — **sigue muerto, y es el control que valida el ejercicio**

Era la hipótesis de control: `INFORME-TIMESTOP.md` mostró que el daño del
time-stop era de precio y no de comisión (Δgold ≈ Δblack), así que con Cocos no
debería cambiar nada. **Se confirma exacto.**

Δ del P&L aislado contra el base, IS, reloj de mercado (H = 8/16/24/48/72):

| H | Δ Gold | Δ Cocos |
|---|---:|---:|
| 8 | −$304.577 | −$306.432 |
| 16 | −$449.495 | −$452.233 |
| 24 | −$284.647 | −$286.381 |
| 48 | −$218.957 | −$220.291 |
| 72 | −$10.451 | −$10.514 |

La diferencia entre Gold y Cocos es del **0,6%** del efecto: el time-stop no
destruía valor por comisión, lo destruía por precio, y sacarle la comisión no
lo arregla. Lo mismo en el OOS y con el reloj corrido: en las 26 celdas que
cortan algo, la diferencia Gold-Cocos es del 0,6% del Δ, siempre.

**Contra el nulo** (cortar los mismos K trades en un momento al azar de su
vida): de las 26 celdas, **ninguna llega a p < 0,05 en Cocos**. La mejor es
`corrido H=48` en el OOS con percentil 92,0 (p = 0,080); 13 de las 26 caen por
debajo del percentil 50, o sea que cortar los trades más largos sale peor que
cortar al azar. En el IS con reloj corrido las tres H más chicas caen en el
percentil 17-19.

**Veredicto: sigue muerto.** Y eso es la buena noticia metodológica: el
ejercicio de Cocos no está inflando todo. Donde el problema era el precio, la
tarifa no cambia nada.

### 4.3 El corte por zona cedida — **el corte gratis mejora, el implementable sigue destruyendo valor**

El test primario de `INFORME-BARRIDO.md` partía los trades por si el motor
seguía derivando la misma zona en la barra del fill ("aguanta") o no ("cedió").
Etiqueta reusada de `results-barrido.json`; el join se verificó en **205/205
trades** por símbolo, fecha y P&L Gold.

**El corte gratis** (quedarse sólo con lo que aguanta, como si se pudiera no
tomar el trade), mensual Cocos contra el nulo de descarte aleatorio:

| Corte | K/N | Cocos real | base | mediana nulo | percentil | p |
|---|---:|---:|---:|---:|---:|---:|
| solo aguanta · IS | 35/111 | +0,26% | +0,26% | +0,07% | 79,9% | 0,201 |
| solo aguanta · OOS | 26/94 | **+0,66%** | +0,32% | +0,09% | 99,8% | **0,0022** |
| solo cedió · IS | 76/111 | +0,00% | +0,26% | +0,19% | 20,0% | 0,800 |
| solo cedió · OOS | 68/94 | −0,33% | +0,32% | +0,24% | 0,2% | 0,998 |
| *control* cerró arriba · IS | 41/111 | +0,48% | +0,26% | +0,09% | 96,1% | **0,039** |
| *control* cerró arriba · OOS | 29/94 | **+0,89%** | +0,32% | +0,09% | 100,0% | **0,0002** |

Mismo patrón que con Gold y Black: el test primario aparece en el OOS y no en
el IS, y el control crudo —"la barra del fill cerró arriba del nivel"— separa
mejor y en las dos ventanas.

**El corte implementable** —soltar al cierre de la barra del fill lo que
cedió, que es lo único que se puede ejecutar de verdad porque la variable se
observa cuando el bot ya compró—:

| | IS Cocos | OOS Cocos | IS Gold | OOS Gold |
|---|---:|---:|---:|---:|
| Base | +0,26% | +0,32% | −0,83% | −0,95% |
| Corte gratis | +0,26% | +0,66% | −0,11% | +0,28% |
| **Corte implementable** | **−0,43%** | **−0,25%** | **−1,24%** | **−1,20%** |

**Sigue destruyendo valor, y no por la comisión.** Descompuesta la brecha entre
el corte gratis y el implementable: en el IS son 0,687 puntos mensuales en
Cocos y 1,139 en Gold; la diferencia entre las dos (0,452 pp) es toda comisión,
y proyectada a la tarifa de Cocos da 0,055 pp. O sea que **el 92% del daño es
precio y el 8% comisión** (92,5%/7,5% en el OOS). La razón es mecánica: los
trades que "ceden" cierran la barra del fill por debajo del nivel de entrada, y
soltar ahí es cristalizar una pérdida que ya ocurrió. Bajar la comisión a cero
no arregla eso.

**Veredicto: no revive.** Lo que lo mata no era el costo de la vuelta, era el
momento de la observación. Sigue en pie la única línea que `INFORME-BARRIDO.md`
dejó abierta y **no se testeó**: cambiar el tipo de orden, no comprar al nivel
con una límite sino esperar 5-10 minutos y comprar sólo si el precio quedó
arriba.

### 4.4 El filtro de volatilidad — **confirmado: con costo casi nulo vale todavía menos**

`base + vol20 baja`, umbral = mediana del IS (0,1281, coincide con
`results.json`).

| | IS | OOS |
|---|---:|---:|
| Señales que pasan | 324/528 | 228/371 |
| Trades | 76 | 57 |
| Mensual Cocos, base | +0,26% | +0,32% |
| Mensual Cocos, con filtro | **+0,36%** | **+0,12%** |
| Expectancy Cocos, base | +$3.344 | +$3.508 |
| Expectancy Cocos, con filtro | +$6.756 | **+$2.168** |

Contra el nulo de bloques (apagar la misma cantidad de ruedas, en bloques
contiguos con las mismas duraciones, ubicados al azar):

| | IS · percentil / p | OOS · percentil / p |
|---|---:|---:|
| Cocos, nulo de bloques | 80,7% / p = 0,193 | 34,0% / p = 0,661 |
| Cocos, nulo de señales al azar | 73,6% / p = 0,265 | 28,3% / p = 0,717 |
| Gold, nulo de bloques | 58,5% / p = 0,415 | 46,0% / p = 0,540 |

**Confirmado, y con el detalle que pedía la intuición: el filtro vale MENOS con
Cocos que con Gold.** En Gold el filtro mejoraba el mensual 0,45 pp en el IS
porque recortaba trades de expectancy negativa — en un sistema que pierde por
trade, sacar trades al azar mejora el mensual por pura aritmética. **Con Cocos
la expectancy por trade es positiva (+$3.344 y +$3.508), así que recortar
trades ahora TIENE UN COSTO.** Se ve en el OOS: el filtro baja el mensual de
+0,32% a +0,12% y cae al percentil 34 del nulo — apagar el bot en fechas al
azar hubiera salido mejor. En el IS el filtro sube el mensual, pero al
percentil 81 (p = 0,19), que no alcanza.

Esto es una inversión del argumento que vale la pena decir: **mientras el bot
perdía, apagarlo servía; si el bot gana, apagarlo cuesta.** La perilla de
exposición dejó de ser gratis.

### 4.5 El score ≥ 9 — **es el corte que más mejora el trade promedio, y sigue sin ser una regla**

Post-hoc. Se miró después de ver los resultados; no entra en el walk-forward.
205 trades, 38 limpios, IS+OOS juntos.

| Score | n | Win | Gold / trade | Black total | **Cocos total** | **Cocos / trade** |
|---|---:|---:|---:|---:|---:|---:|
| 7 | 119 | 34,5% | −$12.165 | −$116.479 | +$216.307 | +$1.818 |
| 8 | 59 | 28,8% | −$11.495 | −$38.533 | +$121.383 | +$2.057 |
| 9 | 18 | 50,0% | +$614 | +$219.416 | **+$271.508** | **+$15.084** |
| 10 | 9 | 55,6% | −$3.516 | +$66.996 | +$91.656 | +$10.184 |

Score 9-10 (n = 27, el 13% de los trades) aporta **$363.164 de los $700.853
totales de Cocos**: el 52% del resultado en el 13% de las operaciones. El trade
promedio pasa de $3.419 (todos) a $13.450 (score ≥ 9), casi cuatro veces.

Pero el corte **baja el mensual**, porque opera mucho menos:

| | K/N | Cocos con el corte | Cocos base | mediana nulo | percentil | p |
|---|---:|---:|---:|---:|---:|---:|
| score ≥ 9 · IS | 10/111 | +0,15% | +0,26% | +0,01% | 84,1% | 0,159 |
| score ≥ 9 · OOS | 17/94 | +0,15% | +0,32% | +0,06% | 71,8% | 0,282 |

**Veredicto: le gana al nulo en las dos ventanas pero sin llegar a p < 0,05, y
baja el retorno mensual en las dos.** Es el corte con mejor comportamiento
cualitativo de todo el informe —mejora el trade promedio, no cambia de signo,
gana en las dos ventanas— y aun así no alcanza: 27 trades en 35 meses es un
trade cada 27 ruedas, y el corte es post-hoc, que es justo lo que el DSR
castiga. Si sirve para algo es como **peso**, no como filtro: dedicarle más
tamaño a los score 9-10 en vez de apagar los 7-8.

---

## 5. Deflated Sharpe Ratio

### El N y el σ

`INFORME-FINO.md` dejó el conteo en **N = 172**. Este informe agrega **2**
configuraciones genuinamente nuevas: el corte post-hoc por score ≥ 9 en las dos
ventanas. **N = 174.**

La tarifa **no suma** al N bajo la convención del proyecto: las 172
configuraciones anteriores ya se evaluaban en tres tarifas cada una y contaban
una vez, porque la tarifa no es un grado de libertad buscado en los datos sino
un dato del broker. Igual se reporta la versión paranoica —cada tarifa cuenta
como una mirada distinta, **N = 346**— porque la conclusión más fuerte de este
informe depende de cuál se use.

σ(SR) se reconstruyó corriendo de nuevo las 160 variantes que componen el σ
publicado (76 originales + 8 recompra + 16 nulo + 26 time-stop + 6 razón
muerta + 28 barrido), ahora con el tier de Cocos:

| | reconstruido acá | publicado en `INFORME-FINO.md` |
|---|---:|---:|
| σ(SR) Gold | 5,2146e−2 | 5,2149e−2 |
| σ(SR) Black | 3,7987e−2 | 3,7895e−2 |
| **σ(SR) Cocos** | **3,6560e−2** | — |

La reconstrucción de Gold coincide en cuatro cifras significativas y la de
Black en tres (las diferencias vienen de que el informe anterior tomaba algunos SR guardados
en `results.json` y acá se recalcularon). El σ de Cocos es levemente menor que
el de Black, como corresponde: menos costo, menos dispersión entre variantes.

### Los DSR

| Corrida | n | Sharpe Cocos | **DSR Cocos (N=174)** | DSR paranoico (N=346) |
|---|---:|---:|---:|---:|
| 38 limpios, base, IS | 111 | +0,51 | 0,082 | 0,060 |
| 38 limpios, base, OOS | 94 | +0,65 | 0,148 | 0,117 |
| 50 con alta real, base, IS | 174 | +1,27 | **0,336** | 0,275 |
| 50 con alta real, base, OOS | 149 | +1,12 | 0,300 | 0,251 |
| base + vol20 baja, IS | 76 | +0,81 | 0,149 | 0,112 |
| base + vol20 baja, OOS | 57 | +0,30 | 0,077 | — |
| score ≥ 9 (post-hoc), IS | 10 | +1,16 | 0,256 | 0,196 |
| score ≥ 9 (post-hoc), OOS | 17 | +0,74 | 0,175 | 0,141 |
| *cartera no armable*: solo aguanta, OOS | 26 | +2,35 | 0,845 | 0,802 |
| *cartera no armable*: **cerró arriba del nivel, OOS** | 29 | **+2,86** | **0,961** | 0,944 |

**El mejor DSR que produce Cocos es 0,9609 y SÍ pasa 0,95 — pero es el mismo
número prohibido de siempre.** Es la corrida "operar sólo lo que cerró arriba
del nivel" en el out-of-sample, que `INFORME-BARRIDO.md` §5 y `INFORME-FINO.md`
ya establecieron que **describe una cartera que no se puede armar**: la
variable se observa después de que el bot compró, y ejecutarla de verdad da
−0,25%/mes en Cocos (§4.3). Con la tarifa Black el mismo número era 0,9075;
Cocos lo empuja arriba de 0,95 por primera vez en el proyecto. Con el N
paranoico queda en 0,944 y no pasa. O sea: el único DSR del proyecto que cruza
el umbral lo cruza por 0,011, depende de cómo se cuente el N, es
out-of-sample solo, tiene n = 29 y no es implementable. **No es un hallazgo, es
un recordatorio de para qué sirve el DSR.**

**El mejor DSR de una cartera que SÍ se puede armar es 0,336** (los 50 papeles,
Cocos, in-sample, Sharpe 1,27). El caso base de los 38 —que es el bot real—
está en 0,082 (IS) y 0,148 (OOS). Ninguno se acerca a 0,95: después de
descontar que el proyecto probó 174 cosas, la probabilidad de que esos Sharpe
sean de verdad mayores que cero es de 8% a 15%.

---

## 6. Lo que no está modelado (además de todo lo de `INFORME.md` §7)

| Aproximación | Efecto sobre el resultado de Cocos |
|---|---|
| Cocos no tiene API: la ejecución sería **manual** | **Optimista y grande**: el bot emite el nivel y LP tiene que espejarlo a mano. Slippage, demora y órdenes no puestas no están modelados |
| Sin caución ni palanca T1 | Correcto para el caso sin apalancar; con palanca habría que sumar ~0,069%/día corrido, que es más que toda la comisión |
| Derechos de BYMA al 0,050% (tasa de swing) | Correcto para este bot. Si algún trade cerrara el mismo día pagaría 0,044%; el efecto es de tercer orden |
| El tick y el spread del CEDEAR local | **Optimista**: en Cocos se opera el CEDEAR, con menos liquidez que el subyacente en NYSE. Este es el costo que reemplaza a la comisión, y el backtest no lo tiene |
| El ratio del CEDEAR y el redondeo a unidades enteras | Irrelevante mientras el tope del 20% mande el tamaño, que es en el 100% de los trades |
| Los 38 limpios incluyen SPY y QQQ, que el bot no opera | Irrelevante: entre los dos aportaron 0 trades |

El punto 1 y el punto 4 van juntos y son los que más preocupan: **al sacar la
comisión de broker, el costo que queda sin medir (spread del CEDEAR local +
ejecución manual) pasa a ser del mismo orden que todo lo que sí se mide.** Un
spread efectivo de 0,10% por punta —perfectamente posible en un CEDEAR fuera de
los cinco más líquidos— duplicaría el costo total y se llevaría la mitad del
resultado.

---

## 7. Veredicto

**¿Con la comisión de Cocos el bot es rentable?** Sí, y por primera vez en todo
el proyecto sin asteriscos de signo: **+0,26%/mes in-sample y +0,32%/mes
out-of-sample** sobre los 38 papeles limpios, con drawdown máximo de 4,8% y
5,7%. Son $18.000 y $22.600 por mes sobre $7.000.000. Con el universo de 50
—que incluye papeles que el bot no opera— sube a +0,88% y +0,74%, o sea
$61.800 y $52.000 por mes.

**¿Alcanza para el piso de 3% mensual?** No, ni cerca. 3% de $7.000.000 son
$210.000 por mes. El caso base da entre el **8,7% y el 10,8% de ese piso**; el
universo optimista de 50, entre el **25% y el 29%**. Para llegar a 3% mensual
con este bruto habría que multiplicar el resultado por diez, y el bruto es lo
único que la tarifa no toca: con costo cero, el techo del sistema es +0,39%/mes
(IS) y +0,48%/mes (OOS). **Aun regalando la comisión entera, el bot no llega al
piso de LP: le falta un factor de 6 a 8.**

**¿Qué revive con Cocos?**

1. **El sistema entero**, de negativo a levemente positivo. Es el único cambio
   grande, y no viene de las reglas.
2. **La recompra a mitad de camino al stop**, con reservas: +0,07 pp/mes, gana
   en las dos ventanas, pero no le gana al nulo en el in-sample (p = 0,14) y el
   aporte total no es distinguible de cero.
3. **El universo de 50**, que con Cocos deja de tener sesgo de signo cambiante.

**¿Qué NO revive?**

1. **El time-stop.** El daño era de precio; Gold y Cocos difieren en 0,6%. 26
   celdas, ninguna con p < 0,05. *(Este era el control, y salió como tenía que
   salir: el ejercicio no está inflando todo.)*
2. **El corte por zona cedida.** El corte gratis mejora, pero el implementable
   sigue en −0,43% y −0,25%, y el 92% de ese daño es precio, no comisión.
3. **El filtro de volatilidad.** Con Cocos vale menos que antes, no más:
   ahora que la expectancy por trade es positiva, recortar trades cuesta plata.
   Percentil 34 del nulo en el OOS.
4. **El score ≥ 9** como filtro: mejora el trade promedio 4×, pero baja el
   mensual en las dos ventanas y no llega a p < 0,05. Como **peso** sigue
   abierto; como filtro, no.

**Lo que hay que decir con todas las letras:** en el in-sample, el resultado
positivo de Cocos **es el dólar**. El papel restó 0,046 puntos mensuales y el
CCL puso 0,439. Sin arrastre del dólar, el bot en Cocos habría dado −0,18%/mes
en el in-sample. Eso no es un bot de soportes: es carry de dólar con 0,121% de
peaje y una tenencia mediana de 4 días. En el out-of-sample sí hay edge de
precio (+0,363 contra +0,117 del dólar), y es la única evidencia del proyecto a
favor de que el motor seleccione algo. Que las dos ventanas discrepen sobre el
origen del edge es exactamente lo que uno esperaría si el edge no existiera de
forma estable.

**La conclusión operativa, en una línea:** con la tarifa de Cocos el bot deja
de ser una máquina de quemar plata y pasa a ser un negocio de $20.000 por mes
con un Sharpe de 0,5-0,65 y un DSR de 0,08-0,15 — defendible como experimento,
insuficiente como respuesta al pedido de 3% mensual, y con la mitad del
resultado explicada por el dólar; el trabajo que queda no es bajar más el costo
(ya está casi en cero) sino subir el bruto, y ahí las únicas dos líneas abiertas
son el tipo de orden que dejó anotado `INFORME-BARRIDO.md` y el peso por score.

---

*Generado offline el 18/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `cocos.js` (reusa `engine.js`; el caso base reproduce
`results.json` en 84/84 comparaciones y el barrido de robustez en 50/50 celdas;
el replayer reproduce la cartera en 205/205 trades; el join con
`results-barrido.json` da 205/205). Semilla 20260917, 5.000 sorteos por nulo.
Huella de reproducibilidad: 4.893 números, FNV-1a `8b0354e9`. Detalle completo
en `results-cocos.json` y `run-cocos.log`. Convenciones, aproximaciones y
anti-lookahead en `README.md` e `INFORME.md`.*
