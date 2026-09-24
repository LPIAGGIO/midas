# Informe · el barrido de un soporte contra el quiebre

**La primera línea, sin vueltas: la penetración no es bimodal, es un continuo
asimétrico con una sola moda (la mezcla de dos gaussianas que el BIC prefiere
tiene, ella misma, UNA moda: los centros quedan a 1,88 sd en el IS y 1,73 en el
OOS, por debajo del umbral de 2 que hace falta para que una mezcla tenga dos
picos). El test primario, pre-registrado, parte los 205 trades según si el motor
sigue derivando la misma zona en la barra del fill: "aguanta" es el 31,5% del IS
(35/111) y el 27,7% del OOS (26/94), y la diferencia de expectancy es
**+$9.258 con p = 0,477 en el IS** y **+$29.124 con p = 0,0021 en el OOS**. O
sea: aparece en una ventana y no en la otra, y aparece en la que no se usó para
elegir nada. Contra el nulo de descarte aleatorio, "solo aguanta" cae en el
percentil 78,5 del IS (p = 0,21) y en el 99,8 del OOS (p = 0,0024). De las cinco
features exploratorias, **ninguna sobrevive al nulo en las dos ventanas**: la
mejor del OOS (f5 Q1, percentil 99,2) está en el percentil 43,7 del IS, y la
mejor del IS (f4 = no, percentil 98,8, n = 11) está en el 11,9 del OOS. Y el
control desarma la lectura elegante: "el motor mantiene la zona" coincide en el
92,8% (IS) y el 96,8% (OOS) con algo mucho más pedestre —**la barra del fill
cerró arriba del nivel**— y la versión cruda separa MEJOR que la del motor, en
las dos ventanas (p = 0,0998 IS y p = 0,0001 OOS; pooled t = 3,58). El barrido y
el quiebre son distinguibles, pero por el precio, no por la lógica de zonas. Y
no se pueden cobrar: la observación llega al cierre de la hora en la que el bot
ya compró, y soltar ahí lo que cedió **empeora** las dos ventanas (IS −1,24% vs
−0,83%, OOS −1,20% vs −0,95% en Gold). Sobre la pregunta abierta del 79%: se
desploma a 37,1% al aflojar la tolerancia a ±2%, así que la mitad larga de ese
número es ruido de selección entre zonas vecinas —el nivel re-derivado está, en
mediana, 1,15% más abajo—, pero la muerte de la señal NO es artefacto: con ±2%
el motor sigue dejando de emitir la señal en 202 de 205 trades, sólo que el
motivo pasa a ser "score < 7".**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS ni
Supabase. Motor, reglas de ejecución y convenciones idénticas a `INFORME.md`.

**Semilla del generador aleatorio: `20260917`** (mulberry32, `barrido.js`), la
misma de `INFORME-NULO.md` y `INFORME-TIMESTOP.md`. 5.000 sorteos por celda.
Reproducibilidad verificada: dos corridas seguidas dan la misma huella FNV-1a
sobre los 2.376 números del informe (`1512cb20`).

---

## 0. De dónde sale esto, y qué reproduce antes de empezar

`INFORME-TIMESTOP.md` §4 dejó documentado, como subproducto, que **el motor
re-deriva una zona de soporte distinta en la barra inmediatamente posterior al
fill en el 79% de los trades** (85/110 en el IS y 75/92 en el OOS). Quedó
abierto si eso es una propiedad real de la señal o un artefacto de la
granularidad horaria, con un dato de contexto incómodo: la coincidencia del port
contra el bot real cae de 81% a 41% si se usa el cierre de barra en vez del spot
que vio el worker (`INFORME.md` §0).

La hipótesis de microestructura a testear: cuando el precio perfora un soporte,
a veces lo **barre** (penetra poco y revierte) y a veces lo **rompe** (penetra y
sigue). Si son dos regímenes distinguibles en el momento del fill, el bot está
comprando en los dos sin diferenciarlos.

Chequeos de arranque, todos obligatorios y todos limpios:

| Chequeo | Resultado |
|---|---|
| El caso base reproduce `INFORME.md` (IS y OOS, mensual y P&L total) | **Δ = 0,0e+0** |
| El replayer de trades reproduce el P&L de la cartera | **205/205**, diferencia máxima $0,00 |
| La equity reconstruida desde los legs reproduce la curva del simulador | **730/730 ruedas**, diferencia máxima $0,00 |
| La zona reconstruida en la barra de la señal reproduce el nivel de entrada | **205/205** |
| La reconstrucción del N del DSR anterior | **132**, σ(SR) idéntica a `results-timestop.json` |

El cuarto es el que más importa para lo que sigue: todas las mediciones de este
informe cuelgan de haber identificado bien **la zona en la que el bot compró**,
no una vecina. Sin ese 205/205, el bloque E mediría otra cosa.

---

## 1. Bloque A · la penetración post-entrada

Para cada trade se mide cuánto más abajo del nivel de entrada llegó el precio
antes de resolverse, desde la barra del fill inclusive hasta la salida,
normalizado por el **ATR14 diario que el propio motor calcula en la barra del
fill** (es el ATR del motor, no uno nuevo: la misma función que define el stop
cuando no hay zona debajo).

### IS · 111 trades

| Decil | n | Penetración (med) | Rango | En % del precio | Vida | Win | Bruto/nocional | Gold/trade |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 11 | 0,05 | 0,01–0,11 | 0,22% | 5 | 72,7% | +2,87% | +$22.148 |
| 2 | 11 | 0,18 | 0,11–0,26 | 0,76% | 12 | 72,7% | +2,15% | +$13.181 |
| 3 | 11 | 0,30 | 0,27–0,35 | 1,75% | 2 | 27,3% | +1,08% | +$901 |
| 4 | 11 | 0,39 | 0,38–0,44 | 2,90% | 2 | 9,1% | −1,55% | −$34.125 |
| 5 | 11 | 0,47 | 0,44–0,51 | 2,54% | 3 | 18,2% | −1,05% | −$29.523 |
| 6 | 11 | 0,58 | 0,52–0,64 | 1,83% | 7 | 18,2% | +0,52% | −$8.357 |
| 7 | 11 | 0,70 | 0,65–0,75 | 2,89% | 8 | 27,3% | +1,48% | +$4.652 |
| 8 | 11 | 0,81 | 0,76–0,87 | 2,98% | 6 | 18,2% | −1,82% | −$42.512 |
| 9 | 11 | 0,99 | 0,89–1,24 | 3,66% | 8 | 45,5% | +0,93% | −$3.024 |
| 10 | 12 | **1,66** | 1,25–2,95 | 6,40% | 5 | 8,3% | −0,89% | −$28.305 |

### OOS · 94 trades

| Decil | n | Penetración (med) | Rango | En % del precio | Vida | Win | Bruto/nocional | Gold/trade |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| 1 | 9 | 0,06 | 0,03–0,11 | 0,38% | 7 | 100,0% | +4,22% | +$43.001 |
| 2 | 9 | 0,14 | 0,12–0,18 | 0,70% | 7 | 88,9% | +2,88% | +$23.793 |
| 3 | 10 | 0,27 | 0,20–0,31 | 1,52% | 6 | 70,0% | +1,96% | +$10.727 |
| 4 | 9 | 0,34 | 0,31–0,38 | 2,00% | 13 | 22,2% | +0,28% | −$11.493 |
| 5 | 10 | 0,47 | 0,38–0,51 | 1,75% | 5,5 | 60,0% | +1,40% | +$4.176 |
| 6 | 9 | 0,55 | 0,52–0,58 | 3,63% | 3 | 22,2% | −1,29% | −$32.926 |
| 7 | 9 | 0,63 | 0,60–0,72 | 2,63% | 4 | 11,1% | −0,69% | −$23.218 |
| 8 | 10 | 0,77 | 0,74–0,79 | 4,53% | 5 | 0,0% | −2,13% | −$44.996 |
| 9 | 9 | 0,94 | 0,82–1,10 | 3,18% | 3 | 22,2% | −0,64% | −$23.811 |
| 10 | 10 | **1,41** | 1,12–2,32 | 4,82% | 7 | 0,0% | −2,01% | −$44.068 |

### El cruce con el desenlace, y por qué no prueba lo que parece

| Camino | IS n | IS pen. p10/med/p90 | OOS n | OOS pen. p10/med/p90 |
|---|---:|---|---:|---|
| stop seco | 67 | 0,37 / 0,68 / 1,63 | 50 | 0,32 / 0,72 / 1,37 |
| tp parcial → target | 29 | 0,04 / 0,20 / 0,65 | 33 | 0,06 / 0,27 / 0,56 |
| tp parcial → stop | 7 | 0,41 / 0,74 / 1,05 | 5 | 0,44 / 0,72 / 1,28 |
| tp parcial → trailing | 7 | 0,08 / 0,30 / 0,83 | 6 | 0,12 / 0,19 / 0,33 |

La separación es enorme —los targets penetran un tercio de lo que penetran los
stops— y **es tautológica**. La penetración está medida *hasta la resolución*, y
un trade no puede morir en el stop sin haber penetrado, como mínimo, la
distancia al stop: mediana **0,44 ATR en el IS y 0,43 en el OOS**. De hecho
**78 de 111 (IS) y 59 de 94 (OOS)** tienen la penetración pegada al stop (≥98%
de esa distancia). La penetración medida así no es una variable independiente:
es, en buena medida, una etiqueta del desenlace, igual que la duración en
`INFORME-TIMESTOP.md` §1. Sirve para describir la forma de la distribución, no
para predecir nada.

### ¿Bimodal o continuo? Continuo

| | IS | OOS |
|---|---:|---:|
| Cuantiles (p5 / p25 / p50 / p75 / p95) en ATR | 0,06 / 0,30 / 0,52 / 0,82 / 1,66 | 0,07 / 0,27 / 0,51 / 0,77 / 1,41 |
| Mezcla EM de 2 gaussianas: centros | 0,48 y 1,50 | 0,43 y 1,12 |
| ...peso de la componente baja | 83,8% | 79,4% |
| ...separación estandarizada de los centros | **1,88 sd** | **1,73 sd** |
| BIC: 1 componente vs 2 | 185,8 vs **148,1** | 115,6 vs **106,4** |
| **Modas de la mezcla ajustada** | **1** | **1** |
| Densidad kernel: h de referencia (Silverman) | 0,137 → 3 modas | 0,135 → 2 modas |
| ...h crítico para una sola moda | 0,368 (**×2,69**) | 0,224 (**×1,67**) |

El BIC prefiere dos componentes en las dos ventanas, y eso podría leerse como
"hay dos regímenes". **No es lo que dice.** Una mezcla de dos gaussianas con los
centros a menos de 2 desvíos es unimodal: la segunda componente no agrega un
pico, agrega **cola derecha**. Y eso es exactamente lo que pasa acá: evaluada
punto por punto, la mezcla ajustada tiene **una sola moda** en las dos ventanas.
Las 3 (IS) y 2 (OOS) modas que aparecen en la densidad kernel con el ancho de
Silverman se disuelven apenas se lo agranda: alcanza con multiplicarlo por 2,69
y por 1,67 respectivamente, que para n = 111 y n = 94 está dentro de lo que se
espera de las ondulaciones de muestra.

**Respuesta de la pregunta descriptiva: la penetración es un continuo
asimétrico a la derecha, con una sola moda alrededor de 0,45–0,50 ATR (≈2% del
precio), no dos poblaciones separadas.** El "barrido" y el "quiebre" no son dos
especies: son los dos extremos de una misma distribución, y el corte entre ellos
—donde uno lo ponga— es arbitrario.

---

## 2. Bloque B · el test primario, pre-registrado, una sola comparación

La variable de corte es la única que el enunciado admite: **evaluado en la barra
del fill, ¿el motor sigue derivando la misma zona de soporte (±0,5%) o ya derivó
otra?** Es observable al cierre de esa barra y no mira ninguna barra posterior.
El desenlace que se compara empieza en la barra siguiente, porque el simulador
no juzga la barra del fill. No hay lookahead.

| | IS | OOS |
|---|---:|---:|
| n "aguanta" / n "cedió" | **35 / 76** | **26 / 68** |
| % que aguanta | 31,5% | 27,7% |
| Expectancy Gold, aguanta | −$4.318 | **+$10.818** |
| Expectancy Gold, cedió | −$13.576 | −$18.305 |
| Diferencia | +$9.258 | **+$29.124** |
| Desvíos (aguanta / cedió) | $67.232 / $53.583 | $38.233 / $40.529 |
| Error estándar de la diferencia | $12.920 | $8.965 |
| **t de Welch / gl** | **0,72 / 54,7** | **3,25 / 47,8** |
| **p (t, dos colas)** | **0,4767** | **0,0021** |
| p (aproximación normal, la convención de los informes previos) | 0,4737 | 0,0012 |
| Expectancy Black, aguanta vs cedió | +$7.471 vs −$2.647 | +$22.787 vs −$7.668 |
| **p (Black)** | **0,4447** | **0,0014** |
| Bruto sobre nocional, aguanta vs cedió | +0,866% vs +0,127% | +1,964% vs −0,237% |
| p (bruto) | 0,4372 | 0,0013 |
| Win rate, aguanta vs cedió | 34,3% vs 30,3% | 69,2% vs 27,9% |
| Penetración mediana, aguanta vs cedió | 0,38 vs 0,61 ATR | 0,40 vs 0,56 ATR |

Juntando las dos ventanas (205 trades, 61 aguanta vs 144 cedió): +$2.133 contra
−$15.809 por trade en Gold, t = 2,16 con 97,6 gl, **p ≈ 0,033**; win 49,2%
contra 29,2%.

**¿Alcanza el n?** El grupo "aguanta" no es el 21% que se temía sino el 31,5%
(IS) y el 27,7% (OOS), o sea 35 y 26 trades. Con 26 de un lado y 68 del otro, el
test tiene potencia para detectar diferencias grandes y sólo grandes: el error
estándar de la diferencia es $8.965 en el OOS, así que cualquier efecto menor a
unos $18.000 por trade se pierde en el ruido. El efecto que aparece en el OOS es
de $29.124 —más de tres errores estándar— así que **sí alcanza para rechazar la
nula ahí**. En el IS el efecto medido es $9.258 con un error estándar de
$12.920: no alcanza ni para ver un efecto de ese tamaño. **Los dos resultados
son compatibles con un efecto verdadero de entre $9.000 y $29.000 por trade, y
también con cero.**

Lo que hay que decir con todas las letras: **el signo va en la dirección de la
hipótesis en las dos ventanas, pero sólo es significativo en una**, y es la que
no se miró para elegir nada. Eso es mejor que el patrón que mataron los tres
informes anteriores (donde el efecto aparecía en el IS y se caía en el OOS) pero
sigue siendo un resultado que **no replica**.

---

## 3. Bloque B.2 · el control que desarma la lectura elegante

Antes de festejar "el motor detecta cuándo el soporte aguanta", hay que
preguntarse qué está midiendo la variable. El motor mantiene la zona sólo si su
techo sigue por debajo del spot, o sea **si la barra del fill cerró por encima
del nivel** (× 1,001). Medido:

| | IS | OOS |
|---|---:|---:|
| Acuerdo entre "el motor mantiene la zona" y "la barra cerró arriba del nivel" | **92,8%** | **96,8%** |
| Matriz (mantiene/cerró arriba) | 34 sí-sí · 1 sí-no · 7 no-sí · 69 no-no | 26 sí-sí · 0 sí-no · 3 no-sí · 65 no-no |
| Gold/trade con la regla cruda, cerró arriba | +$1.952 (n=41) | **+$16.497 (n=29)** |
| Gold/trade con la regla cruda, cerró abajo | −$18.042 (n=70) | −$22.183 (n=65) |
| **p (Welch, regla cruda)** | **0,0998** | **0,0001** |

**La regla cruda separa mejor que la del motor, en las dos ventanas.** Pooled
(205 trades): +$7.978 contra −$20.036, t = 3,58 con 115,8 gl, **p ≈ 0,0005**;
win 55,7% contra 24,4%.

O sea: la partición del test primario no mide la lógica de zonas del motor, mide
**dónde quedó el precio una hora después de comprar**. Los 10 trades en que las
dos reglas discrepan —cerraron arriba del nivel pero el motor igual cambió de
zona— son de los mejores del período (+$26.767 en el IS, +$65.712 en el OOS): el
paso por el motor le agrega ruido a una variable que ya funcionaba sola.

Esto es, al mismo tiempo, una buena y una mala noticia para la hipótesis de
microestructura. La buena: el mecanismo que el enunciado postulaba —barre y
revierte contra rompe y sigue— **existe y se ve**, en la forma más literal
posible (el precio vuelve arriba del nivel dentro de la misma hora, o no). La
mala: el motor no aporta nada para detectarlo, y la detección llega tarde.

---

## 4. Bloque C · los cinco features point-in-time · EXPLORATORIO

**Esto es exploratorio y va marcado como tal.** Lista cerrada de cinco, ninguna
más, ningún umbral optimizado: se reportan los cuartiles y el test del cuartil
alto contra el bajo, nada más. Los cuartiles son **por rango** (cuatro grupos del
mismo tamaño) y no por valor de corte, porque f2 está topeada en 40 barras y con
cortes por valor el cuartil alto sale vacío.

Dos aclaraciones de medición que hay que hacer antes:

1. **La feature 1 no se puede medir como está escrita.** "(nivel − precio de
   fill) / ATR14" es **cero por construcción**: el simulador llena la orden
   límite exactamente en el nivel (`if (b.l <= p.entry)` → fill en `p.entry`),
   así que el precio de fill *es* el nivel en los 205 trades. Lo observable al
   cierre de la barra del fill es cuánto penetró esa barra: se usa
   **(nivel − low de la barra del fill) / ATR14**.
2. **La feature 2 necesita una ventana.** Con la zona por debajo del spot al
   momento de la señal, el primer toque posterior a la señal *es* el fill, así
   que "barras desde el primer toque" sólo puede referirse a toques anteriores.
   Se usa la misma ventana fija de la feature 4 —**N = 40, sin barrer**— para no
   agregar un parámetro libre: f2 = barras desde el primer toque dentro de las 40
   previas, 0 si no hubo ninguno. Eso hace que f2 = 0 sea exactamente f4 = no:
   las dos features comparten el mismo corte en su borde.

### f1 · profundidad ya penetrada al fill, (nivel − low)/ATR14

| | Q1 | Q2 | Q3 | Q4 | Q4 vs Q1 |
|---|---:|---:|---:|---:|---|
| IS · n | 27 | 28 | 28 | 28 | |
| IS · Gold/trade | −$11.475 | −$2.365 | −$12.703 | −$16.113 | dif −$4.638 · t −0,27 · **p = 0,790** |
| OOS · n | 23 | 24 | 23 | 24 | |
| OOS · Gold/trade | −$3.446 | −$1.536 | −$10.023 | −$25.703 | dif −$22.257 · t −1,89 · **p = 0,065** (Black p = 0,032) |
| POOL · Gold/trade | −$7.216 | −$3.703 | −$9.655 | −$21.100 | **p = 0,196** |

### f2 · barras desde el primer toque de la zona (ventana 40)

| | Q1 | Q2 | Q3 | Q4 | Q4 vs Q1 |
|---|---:|---:|---:|---:|---|
| IS · Gold/trade (n 27/28/28/28) | −$1.204 | −$17.681 | −$23.169 | −$236 | **p = 0,959** |
| OOS · Gold/trade (n 23/24/23/24) | −$10.988 | −$11.867 | −$4.588 | −$13.353 | **p = 0,845** |
| POOL · Gold/trade | −$5.250 | −$16.663 | −$17.276 | −$2.842 | **p = 0,832** |

No es monótona en ninguna ventana: los dos extremos son los menos malos y el
medio es el peor. Eso no es una señal, es una U que no se sostiene.

### f3 · volumen de la barra del fill / media de 20 barras

| | Q1 | Q2 | Q3 | Q4 | Q4 vs Q1 |
|---|---:|---:|---:|---:|---|
| IS · Gold/trade (n 27/28/28/28) | −$10.532 | −$12.148 | −$3.189 | −$16.754 | **p = 0,708** |
| OOS · Gold/trade (n 23/24/23/24) | −$471 | −$13.617 | −$6.558 | −$19.792 | **p = 0,112** (Black p = 0,080) |
| POOL · Gold/trade | −$8.659 | −$11.577 | −$3.519 | −$17.979 | **p = 0,367** |

### f4 · ¿la zona ya fue tocada en las últimas 40 barras? (binaria)

| | n "no" | Gold "no" | n "sí" | Gold "sí" | p |
|---|---:|---:|---:|---:|---:|
| IS | 11 | +$33.796 | 100 | −$15.547 | 0,189 |
| OOS | 11 | −$24.375 | 83 | −$8.378 | 0,225 |
| POOL | 22 | +$4.711 | 183 | −$12.295 | 0,387 |

**Cambia de signo entre ventanas con n = 11 de un lado.** Es el caso de libro de
"no prueba nada".

### f5 · posición del fill en el rango de su barra, (fill − low)/(high − low)

| | Q1 | Q2 | Q3 | Q4 | Q4 vs Q1 |
|---|---:|---:|---:|---:|---|
| IS · Gold/trade (n 27/28/28/28) | −$12.862 | −$6.750 | −$11.820 | −$11.274 | **p = 0,930** |
| OOS · Gold/trade (n 23/24/23/24) | **+$8.852** | −$17.727 | −$15.000 | −$16.527 | dif −$25.380 · t −1,96 · **p = 0,057** (Black p = 0,035) |
| POOL · Gold/trade | −$2.810 | −$13.102 | −$9.021 | −$16.824 | **p = 0,224** |

### Resumen del bloque C

**Ninguna de las cinco llega a p < 0,05 en el in-sample. Ninguna.** Los tres p
que asoman —f1 (0,065), f5 (0,057) y f3 (0,112)— son todos del out-of-sample, y
los tres dicen la misma cosa por caminos distintos: **cuanto más hundida quedó
la barra del fill, peor sale el trade.** f1 alto es haber penetrado mucho; f5
alto es haber comprado lejos del mínimo de la barra, que con el fill pegado al
nivel es lo mismo que decir que la barra siguió cayendo; f3 alto es haberlo
hecho con volumen. Las tres son variaciones de la misma variable del bloque B, y
en el in-sample ninguna de las tres se ve.

---

## 5. Bloque D · el nulo, obligatorio

Cualquiera de estos cortes reduce la cantidad de trades, y en un sistema con
expectativa negativa **sacar trades al azar mejora el mensual por pura
aritmética**. Para cada corte que deja pasar K de los N trades del base, el nulo
saca al azar (N − K) y mide el mensual de los que quedan. 5.000 sorteos, semilla
20260917. Todo en modo **aislado** (el mismo set de trades, sin re-simular la
cartera), igual que en `INFORME-TIMESTOP.md` §C: así el corte real y el nulo
mueven exactamente las mismas piezas.

| Corte | Ventana | K/N | Mensual real | Mediana del nulo | Percentil | p (1 cola) | Percentil Black |
|---|---|---:|---:|---:|---:|---:|---:|
| **solo aguanta** (test primario) | IS | 35/111 | −0,11% | −0,27% | **78,5%** | 0,2148 | 80,2% |
| **solo aguanta** (test primario) | OOS | 26/94 | +0,28% | −0,26% | **99,8%** | **0,0024** | 99,8% |
| solo cedió | IS | 76/111 | −0,72% | −0,56% | 21,0% | 0,7904 | 19,6% |
| solo cedió | OOS | 68/94 | −1,22% | −0,68% | **0,1%** | 0,9988 | 0,1% |
| *control*: cerró arriba del nivel | IS | 41/111 | +0,06% | −0,30% | **95,4%** | **0,0466** | 95,9% |
| *control*: cerró arriba del nivel | OOS | 29/94 | +0,47% | −0,29% | **100,0%** | **0,0002** | 100,0% |
| *control*: cerró abajo del nivel | IS | 70/111 | −0,89% | −0,52% | 4,3% | 0,9566 | 4,0% |
| *control*: cerró abajo del nivel | OOS | 65/94 | −1,42% | −0,65% | **0,0%** | 1,0000 | 0,0% |
| f1 Q4 (alto) | IS | 28/111 | −0,32% | −0,21% | 28,7% | 0,7129 | 19,6% |
| f1 Q4 (alto) | OOS | 24/94 | −0,61% | −0,25% | 1,7% | 0,9834 | 0,6% |
| f1 Q1 (bajo) | IS | 27/111 | −0,22% | −0,22% | 50,2% | 0,4985 | 55,3% |
| f1 Q1 (bajo) | OOS | 23/94 | −0,08% | −0,24% | 81,6% | 0,1838 | 85,2% |
| f2 Q4 (alto) | IS | 28/111 | −0,00% | −0,22% | 86,2% | 0,1386 | 86,7% |
| f2 Q4 (alto) | OOS | 24/94 | −0,31% | −0,25% | 33,7% | 0,6629 | 34,2% |
| f2 Q1 (bajo) | IS | 27/111 | −0,02% | −0,21% | 82,6% | 0,1746 | 82,7% |
| f2 Q1 (bajo) | OOS | 23/94 | −0,25% | −0,23% | 47,5% | 0,5247 | 45,2% |
| f3 Q4 (alto) | IS | 28/111 | −0,33% | −0,21% | 26,8% | 0,7317 | 21,1% |
| f3 Q4 (alto) | OOS | 24/94 | −0,47% | −0,24% | 9,7% | 0,9030 | 6,7% |
| f3 Q1 (bajo) | IS | 27/111 | −0,20% | −0,21% | 52,2% | 0,4785 | 56,1% |
| f3 Q1 (bajo) | OOS | 23/94 | −0,01% | −0,23% | 89,6% | 0,1044 | 91,5% |
| f4 = sí | IS | 100/111 | −1,09% | −0,73% | 1,1% | 0,9892 | 1,0% |
| f4 = sí | OOS | 83/94 | −0,68% | −0,83% | 88,5% | 0,1150 | 88,9% |
| f4 = no | IS | 11/111 | +0,26% | −0,10% | **98,8%** | **0,0118** | 98,9% |
| f4 = no | OOS | 11/94 | −0,26% | −0,11% | 11,9% | 0,8808 | 11,5% |
| f5 Q4 (alto) | IS | 28/111 | −0,22% | −0,22% | 49,1% | 0,5095 | 37,8% |
| f5 Q4 (alto) | OOS | 24/94 | −0,39% | −0,24% | 19,9% | 0,8014 | 14,0% |
| f5 Q1 (bajo) | IS | 27/111 | −0,24% | −0,21% | 43,7% | 0,5631 | 49,8% |
| f5 Q1 (bajo) | OOS | 23/94 | **+0,20%** | −0,24% | **99,2%** | **0,0078** | 99,5% |

### Cómo se lee esta tabla

**De los cinco features, ninguno sobrevive al nulo en las dos ventanas.** Los dos
que asoman se contradicen entre sí:

- **f5 Q1** está en el percentil 99,2 del OOS (p = 0,0078) y en el **43,7 del
  IS** (p = 0,56). En el IS cae **cerca de la mediana del nulo: no selecciona,
  sólo recorta.**
- **f4 = no** está en el percentil 98,8 del IS (p = 0,012) y en el **11,9 del
  OOS** (p = 0,88), o sea *peor que el azar* en la ventana que no se miró. Y son
  11 trades.
- Los ocho restantes (f1 Q1/Q4, f2 Q1/Q4, f3 Q1/Q4, f5 Q4, f4 = sí) caen todos
  **cerca de la mediana del nulo o por debajo** en al menos una ventana. **No
  seleccionan: sólo recortan.**

El corte del test primario sí resiste, pero con la misma asimetría de siempre:
percentil 78,5 en el IS (que es "apenas mejor que la mitad de los sorteos", el
mismo lugar donde cayó el filtro de volatilidad de `INFORME-NULO.md`) y 99,8 en
el OOS. Su espejo lo confirma: "solo cedió" cae en el **percentil 0,1 del OOS**,
o sea que quedarse con los que cedieron es significativamente **peor** que
quedarse con un subconjunto al azar del mismo tamaño. Y el control crudo —cerró
arriba del nivel— es el único corte de todo el informe que le gana al nulo en las
**dos** ventanas (percentil 95,4 y 100,0).

### El mismo corte, pero implementable · esto es lo que lo mata

Todos los nulos de este proyecto miden el corte **gratis**: el trade descartado
simplemente no existe. Acá eso no es realizable, y hay que decirlo con el número
en la mano. La variable se observa **al cierre de la barra del fill**, cuando el
bot ya compró el papel al nivel. La única forma de ejecutar el corte es
**soltarlo a ese cierre**, con la vuelta de comisión completa (segunda pata
bonificada, porque es el mismo día).

| | IS | OOS |
|---|---:|---:|
| Trades que se sueltan | 76 | 68 |
| **Mensual Gold, implementable** | **−1,24%** | **−1,20%** |
| Mensual Gold, corte "gratis" | −0,11% | +0,28% |
| Mensual Gold, base | −0,83% | −0,95% |
| **Mensual Black, implementable** | **−0,59%** | **−0,44%** |
| Mensual Black, corte "gratis" | +0,18% | +0,58% |
| Mensual Black, base | +0,04% | +0,07% |

**El corte implementable empeora las dos ventanas y las dos tarifas.** La
diferencia entre el +0,28% del OOS y el −1,20% de la versión ejecutable es,
entera, el costo de entrar y salir 68 veces más lo que el papel ya perdió dentro
de esa primera hora. Un efecto de $29.000 por trade no alcanza cuando la vuelta
cuesta 1,12% de un nocional de $1,4 millones, o sea unos $15.700 por trade —y
encima hay que pagarlo en los 68 que se sueltan, no en los 26 que se quedan.

La única implementación que podría funcionar es **no poner la orden límite en el
nivel y comprar recién al cierre de la hora si el precio quedó arriba**, pero eso
cambia el precio de entrada (se compra más caro, arriba del nivel, perdiendo
parte del edge medido) y es una regla distinta del bot, no un filtro sobre esta.
Queda anotada como lo único que vale la pena probar de todo esto; **no se testeó
acá** y no entra en ninguna conclusión.

---

## 6. Bloque E · artefacto o propiedad · la respuesta a la pregunta abierta

El chequeo decisivo: recalcular el 79% aflojando la definición de "misma zona".
Se replica el cálculo **exacto** de `INFORME-TIMESTOP.md` §4 —primera barra de la
vida del trade en la que alguna condición de D1 se dispara, y motivo de ese
primer disparo— con cuatro tolerancias. La barra de corte mediana es 1 y el p90
es 2 en las cuatro, igual que en el informe anterior.

| Tolerancia | IS: re-derivó / cortados | OOS: re-derivó / cortados | **POOL** | Otros motivos (POOL) |
|---|---:|---:|---:|---|
| **±0,25%** | 85/110 = 77,3% | 75/92 = 81,5% | **79,2%** | R:R<2 27 · score<7 13 · otros 2 |
| **±0,50%** | 85/110 = 77,3% | 75/92 = 81,5% | **79,2%** | R:R<2 27 · score<7 13 · otros 2 |
| **±1,00%** | 65/110 = 59,1% | 69/92 = 75,0% | **66,3%** | R:R<2 33 · score<7 33 · otros 2 |
| **±2,00%** | 40/110 = 36,4% | 35/92 = 38,0% | **37,1%** | R:R<2 49 · score<7 76 · otros 2 |
| Trades que D1 corta, sobre 205 | 110/111 | 92/94 | **202/205** | *igual en las cuatro tolerancias* |

Medido en cambio sobre los 205 trades y en la barra inmediatamente posterior al
fill (sin buscar el primer disparo), la tasa es 68,8% a ±0,25% y ±0,5%, 57,6% a
±1% y 31,7% a ±2% — la misma forma.

Dato que cierra la interpretación: **el nivel re-derivado está, en mediana, un
1,15% por debajo del de entrada** (p25 = 0,00%, p75 = 2,41%). Es la zona vecina
de abajo, no un nivel de otro barrio.

### La respuesta, en dos partes

**1. El número "79%" es, en su mayor parte, artefacto de selección entre zonas
vecinas.** Se desploma a 37,1% al pasar la tolerancia de ±0,5% a ±2%, y la
distancia típica de la zona re-derivada (1,15%) está justo en el rango donde el
motor agrupa pivotes (ZONE_TOL = 0,6%, o sea que dos zonas contiguas pueden estar
separadas por poco más de eso). El caso testigo del 40,9% de `INFORME.md` §0 —el
precio pegado a un nivel y el motor eligiendo la de más abajo— es el mismo
fenómeno visto desde el otro lado.

**2. La muerte de la señal NO es artefacto: es una propiedad del motor.** En las
cuatro tolerancias, incluida ±2%, **D1 sigue cortando 202 de 205 trades** con
barra mediana 1. Lo único que cambia es la etiqueta: al aflojar la tolerancia, el
motivo "re-derivó otra zona" le cede el lugar a "score < 7" (de 13 a 76 casos) y
a "R:R < 2" (de 27 a 49). Esos dos motivos aparecen porque, con tolerancia
grande, el motor termina puntuando la zona vecina de abajo —que es la que está
realmente debajo del spot— y esa zona no llega al gate. Es la misma mecánica con
otro nombre.

**En una línea: el 79% exagera, la cifra defendible es que entre el 37% y el 79%
de los casos el motivo es la elección de zona vecina; pero que la señal deja de
existir en la barra siguiente al fill es real y ocurre en el 98,5% de los trades
(202/205), con cualquier tolerancia.** Es propiedad del motor, no de los datos:
la entrada está definida como el techo de la zona más cercana *debajo del spot*,
y el fill ocurre justo cuando el spot baja a ese techo.

---

## 7. Deflated Sharpe Ratio · N de 132 a 160

`INFORME.md` contaba 76 configuraciones, `INFORME-RECOMPRA.md` las llevó a 84,
`INFORME-NULO.md` a 100 y `INFORME-TIMESTOP.md` a 132. Este informe agrega **28**:
los 24 cortes del bloque D (2 del test primario + 5 features × 2 lados × 2
ventanas, contando la binaria f4 con sus dos grupos) más las 4 del control crudo
de B.2 (2 lados × 2 ventanas). **N = 160.**

Reconstrucción verificada: las 132 previas se reproducen exacto (N = 132, σ(SR)
gold 4,0723e−2 y black 2,5716e−2, idénticas a `results-timestop.json`; las 50
celdas del barrido de robustez coinciden 50/50). Con las 28 nuevas, σ(SR) queda
en **0,052149 (Gold)** y **0,037895 (Black)** — sube bastante porque estos cortes
dejan carteras de 11 a 100 trades, mucho más dispersas que las variantes
anteriores.

| Corrida | Sharpe Gold | DSR Gold | Sharpe Black | DSR Black |
|---|---:|---:|---:|---:|
| base, IS | −1,48 | 0,00000 | +0,11 | 0,0253 |
| base, OOS | −1,78 | 0,00000 | +0,17 | 0,0543 |
| solo aguanta, IS | −0,32 | 0,00063 | +0,61 | 0,0815 |
| **solo aguanta, OOS** | **+1,05** | **0,0912** | **+2,11** | **0,7342** |
| solo cedió, OOS | −2,82 | 0,00000 | −1,21 | 0,0015 |
| *control*: cerró arriba, IS | +0,18 | 0,00368 | +1,17 | 0,2581 |
| ***control*: cerró arriba, OOS** | **+1,62** | **0,2386** | **+2,64** | **0,9106** |
| *control*: cerró abajo, OOS | −3,39 | 0,00000 | −1,84 | 0,0002 |
| f5 Q1 (bajo), OOS | +0,92 | 0,0691 | +2,09 | 0,7266 |
| f4 = no, IS | +0,95 | 0,0120 | +1,24 | 0,2154 |
| f1 Q4 (alto), OOS | −2,70 | 0,00000 | −2,06 | 0,00002 |

**El mejor DSR de todo el proyecto aparece acá: 0,911**, para "operar sólo los
trades cuya barra de fill cerró arriba del nivel", tarifa Black, out-of-sample.
Es el primer número que se acerca al 0,95 convencional después de 160
configuraciones. Y hay que leerlo con las dos advertencias que lo rodean:

1. **Es out-of-sample solo.** La misma configuración en el in-sample da DSR 0,258
   con Black y 0,004 con Gold.
2. **No es ejecutable**, por lo del bloque D: la versión implementable da
   −1,20%/mes en Gold y −0,44% en Black, o sea peor que el base en las dos
   tarifas. Un DSR de 0,911 sobre una cartera que no se puede armar no es un
   descubrimiento, es una descripción.

En Gold nada llega a 0,25. El mejor es el mismo control en el OOS, con 0,239.

---

## 8. Lo que no está modelado en este informe (y para qué lado tira)

| Aproximación | Efecto |
|---|---|
| Los nulos del bloque D miden el corte **gratis** (el trade descartado no existe) | **Optimista** para todo corte post-fill; el costo real está medido aparte en §5 |
| El simulador no juzga la barra del fill: un trade que perfora el stop dentro de esa hora no sale hasta la barra siguiente | **Optimista** en los "cedió" más violentos; su P&L real sería peor, lo que agranda la brecha del bloque B |
| El ATR14 es el diario del motor, no uno horario | Es el mismo con el que el motor define el stop; cambia la escala de la penetración, no su forma |
| La penetración se mide **hasta la resolución**, así que el stop la trunca por arriba | Hace tautológico el cruce con el desenlace (§1); no afecta la forma de la distribución por debajo de 0,43 ATR |
| La feature 1 se mide como (nivel − low de la barra), no (nivel − precio de fill), que es cero | Declarado en §4; sin eso la feature no existe |
| f2 usa una ventana fija de 40 barras, la misma de f4, y por eso comparten el corte en su borde | Sin barrer, sin optimizar; las dos son casi la misma variable en el extremo bajo |
| El modo aislado no modela el efecto de segundo orden de liberar la silla antes (tope de 5 posiciones) | Igual que en `INFORME-TIMESTOP.md`; el nulo y el corte real lo comparten |
| Todo lo de `INFORME.md` §7 (earnings, libro de puntas, CCL diario, granularidad horaria) | Igual que en el informe principal |

---

## 9. Veredicto

**¿La penetración es bimodal o continua?** **Continua.** Una sola moda alrededor
de 0,45–0,50 ATR, cola larga a la derecha. El BIC prefiere dos componentes
gaussianas, pero la mezcla que ajusta es ella misma unimodal (separación 1,88 y
1,73 sd, por debajo de 2) y las modas extra de la densidad kernel se disuelven
multiplicando el ancho de banda por 2,7 y 1,7. **No hay dos especies de
perforación: hay una distribución y un corte arbitrario.**

**¿El barrido se distingue del quiebre en el momento de entrar?** **Sí, pero no
como se esperaba y no de una forma que se pueda cobrar.** El test primario da
p = 0,477 en el IS y p = 0,0021 en el OOS; el control crudo —la barra del fill
cerró arriba del nivel— separa mejor y en las dos ventanas (p = 0,0998 y
p = 0,0001; pooled p ≈ 0,0005, con win 55,7% contra 24,4%). El mecanismo de
microestructura existe y se ve. Pero:

1. **No lo detecta el motor.** La partición del motor coincide en el 93-97% con
   "el precio cerró arriba del nivel", y los pocos casos en que discrepan le dan
   la razón al precio, no al motor. Pasar por la lógica de zonas sólo agrega
   ruido.
2. **Llega una hora tarde.** La variable se conoce al cierre de la barra en la
   que el bot ya compró. Ejecutar el corte cuesta una vuelta de comisión completa
   por cada trade que se suelta, y el resultado implementable es **peor que el
   base en las dos ventanas y en las dos tarifas** (Gold −1,24% y −1,20%, Black
   −0,59% y −0,44%).
3. **Ninguna de las cinco features point-in-time lo anticipa.** Ninguna llega a
   p < 0,05 en el in-sample y ninguna sobrevive al nulo en las dos ventanas. Las
   tres que asoman en el OOS (f1, f3, f5) son variantes de la misma cosa —cuánto
   se hundió la barra del fill— y en el IS no se ven.

**¿El 79% es artefacto o propiedad?** **Las dos cosas, y hay que separarlas.** El
*número* es en buena medida artefacto: cae a 37,1% con tolerancia ±2% y la zona
re-derivada está típicamente 1,15% más abajo, o sea que es la vecina. La
*muerte de la señal* es propiedad del motor y no depende de la tolerancia: con
±2% el motor sigue sin emitir la señal en 202 de 205 trades, en la barra
siguiente al fill, con el motivo cambiado de nombre. **La señal del bot está
extinguida por construcción en el instante en que la orden se llena, y eso se
confirma.**

**Lo que esto le agrega al proyecto.** Una cuarta hipótesis que no da una regla
para mañana, pero que deja el hallazgo más limpio de los cuatro informes: **la
suerte del trade se decide dentro de la primera hora**, y se decide en un lugar
donde el bot, tal como está armado hoy, no puede intervenir sin pagar la vuelta.
Eso apunta a una sola línea de trabajo futura, que no se testeó acá: **cambiar el
tipo de orden** —no comprar al nivel con una límite, sino esperar el cierre de la
hora y comprar sólo si el precio quedó arriba— lo que convierte el edge medido en
algo que se ejecuta una sola vez, sin la vuelta extra, a cambio de un precio de
entrada peor. Es la pregunta que queda.

**Y la que no cambia.** La palanca sigue siendo la tarifa. El único corte de todo
este informe que le gana al nulo en las dos ventanas produce +0,06% y +0,47%
mensual en Gold **si fuera gratis**, y −1,24% y −1,20% cuando se le carga el
costo de ejecutarlo. Un edge de $29.000 por trade contra una vuelta de $15.700
que hay que pagar en los 68 descartados y no en los 26 que se quedan: la
aritmética de `INFORME.md` §8 sigue mandando.

---

*Generado offline el 18/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `barrido.js` (reusa `engine.js`; el chequeo de arranque
reproduce el `38/base` de `INFORME.md` con Δ = 0, el replayer reproduce la
cartera en 205/205 trades y la equity reconstruida en 730/730 ruedas). Semilla
20260917, 5.000 sorteos por celda, huella de reproducibilidad FNV-1a `1512cb20`
sobre 2.376 números. Detalle completo en `results-barrido.json` y
`run-barrido.log`. Convenciones, aproximaciones y anti-lookahead en `README.md`,
`INFORME.md`, `INFORME-NULO.md` e `INFORME-TIMESTOP.md`.*
