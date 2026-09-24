# Informe · el time-stop post-fill contra el azar

**La primera línea, sin vueltas: el time-stop NO selecciona, y tampoco es una
perilla de exposición como el filtro de volatilidad. Es peor que eso: destruye
valor. En crudo, los trades largos rinden MEJOR que los cortos (Spearman
duración vs bruto sobre nocional = +0,434 en el IS y +0,455 en el OOS, p <
0,0001 las dos), o sea lo contrario de lo que predice Locke & Mann. Y eso es un
artefacto: los stops son cortos por construcción. Controlado por camino de
salida, la correlación se cae a +0,201 (IS, p = 0,033) y −0,033 (OOS, p = 0,75)
— cambia de signo entre ventanas, que es la forma estadística de decir que no
hay nada. De las 26 celdas del barrido de H que cortan algún trade, NINGUNA
llega a p < 0,05 contra el nulo, y en las 26 el time-stop real queda POR DEBAJO
de la mediana del nulo de trades al azar —en 12 de ellas bajo el percentil 5—:
cortar justo los trades más largos sale peor que cortar trades al azar. El barrido no es monótono en
ninguna de las cuatro combinaciones reloj × ventana, así que ni siquiera es un
dial. La versión con mecanismo —salir cuando el motor ya no generaría la
señal— tampoco le gana: en su lectura literal mata 110 de 111 trades en la
barra siguiente al fill (percentil 0,5 del nulo) y en su versión más indulgente
mejora el IS 0,11 puntos y empeora el OOS 0,09, con percentil 67 y 27. Tercera
hipótesis muerta de la semana.**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS ni
Supabase. Motor, reglas de ejecución y convenciones idénticos a `INFORME.md`:
el chequeo de arranque reproduce el `38/base` de las dos ventanas con **Δ = 0**
(mensual y P&L total), y el replayer de trades reproduce el P&L de la cartera
en **205/205** trades con diferencia máxima de $0,00.

**Semilla del generador aleatorio: `20260917`** (mulberry32, `timestop.js`),
la misma de `INFORME-NULO.md`. 5.000 sorteos por celda. Reproducibilidad
verificada: dos corridas completas dan una salida byte a byte idéntica.

---

## 0. La hipótesis, y por qué había que testearla acá

Locke & Mann, *"Professional Trader Discipline and Trade Disposition"* (JFE
2005), sobre 334 traders de pits del CME: los que cerraban rápido —perdedores
**y** ganadores— rendían mejor los seis meses siguientes; aguantar posiciones
demasiado tiempo predecía peor performance. La lectura del paper no es "cortá
pérdidas y dejá correr ganancias" sino **salir cuando la razón original del
trade desapareció**, gane o pierda.

La validez externa es débil —order flow a minutos, en pits, en 1995— así que
esto entró como hipótesis a testear, no como verdad a aplicar.

El bot de niveles tiene expiry de 48 h **antes** del fill (si el papel no baja
al nivel, la orden muere) pero **ningún time-stop después del fill**: una vez
llenada, la posición espera stop, target o trailing indefinidamente.

### Una corrección de medición antes de empezar

`INFORME.md` §1 dice "duración mediana **24 horas de mercado**, promedio 65 (IS)
y 45 (OOS), percentil 90 en 144 y 120". Esas son **horas corridas**, no horas de
mercado: el número sale de `(exitTs − entryTs)/3600000`, que cuenta también las
noches y los fines de semana. Medida en barras horarias del papel —que es lo
que pide el enunciado y lo que un time-stop puede contar de verdad— la duración
es mucho más corta:

| | IS | OOS |
|---|---:|---:|
| Mediana, barras de mercado | **5** | **6** |
| Promedio, barras de mercado | 12,8 | 10,3 |
| Percentil 90, barras de mercado | 28 | 28 |
| Máximo, barras de mercado | 102 | 118 |
| Mediana, horas corridas (lo que reporta `INFORME.md`) | 24 | 24 |
| Promedio, horas corridas | 69 | 54 |

Consecuencia práctica inmediata: **con el reloj de mercado, la mitad de arriba
del barrido pedido (H = 120, 168, 240) no corta absolutamente nada**, porque
ningún trade del caso base llega a vivir 120 barras de mercado. Por eso el
barrido se corre con **dos relojes**: barras de mercado del papel (lo pedido) y
horas corridas desde el fill (la unidad en la que estaba escrita la cola que
motivó la hipótesis). Las seis celdas que no cortan nada son, número por número,
el caso base, y **no cuentan como configuraciones nuevas en el N del DSR**.

---

## 1. Bloque A · P&L por duración, sin aplicar ninguna regla

Trades del caso base, 38 limpios, gate del worker, IS y OOS por separado.
Duración = barras horarias del papel desde el fill hasta la salida.

### IS · 111 trades

| Decil | n | Vida med. (rango) | Win % | Bruto / nocional | Gold / trade | Black / trade | Caminos de salida |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 11 | 1 (1-1) | 0,0% | −2,40% | −$44.558 | −$37.170 | 11 stop |
| 2 | 11 | 1 (1-1) | 0,0% | −2,27% | −$42.686 | −$35.315 | 11 stop |
| 3 | 11 | 2 (1-2) | 9,1% | −1,48% | −$32.030 | −$24.319 | 9 stop, 1 tgt, 1 tp→stop |
| 4 | 11 | 3 (2-4) | 36,4% | −0,08% | −$14.806 | −$5.233 | 6 stop, 3 tgt, 1 trail, 1 fin |
| 5 | 11 | 5 (4-5) | 36,4% | +0,68% | −$7.988 | +$4.682 | 7 stop, 3 tgt, 1 trail |
| 6 | 11 | 7 (5-7) | 36,4% | +1,13% | −$2.148 | +$10.818 | 8 stop, 1 tgt, 1 trail, 1 tp→stop |
| 7 | 11 | 9 (7-10) | 27,3% | −0,94% | −$31.756 | −$18.268 | 7 stop, 3 tgt, 1 trail |
| 8 | 11 | 13 (11-17) | 45,5% | +1,09% | −$2.696 | +$10.287 | 4 stop, 5 tgt, 2 trail |
| 9 | 11 | 21 (18-26) | 36,4% | +1,41% | +$978 | +$14.626 | 2 stop, 5 tgt, 4 tp→stop |
| **10** | 12 | **64 (28-102)** | **83,3%** | **+5,96%** | **+$64.305** | **+$78.261** | 8 tgt, 2 stop, 1 trail, 1 tp→stop |

### OOS · 94 trades

| Decil | n | Vida med. (rango) | Win % | Bruto / nocional | Gold / trade | Black / trade | Caminos de salida |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 9 | 1 (1-1) | 33,3% | −0,30% | −$16.302 | −$8.007 | 6 stop, 3 tgt |
| 2 | 9 | 1 (1-1) | 0,0% | −1,90% | −$36.762 | −$29.986 | 9 stop |
| 3 | 10 | 2 (1-2) | 10,0% | −1,78% | −$37.526 | −$28.738 | 9 stop, 1 tgt |
| 4 | 9 | 3 (3-3) | 11,1% | −1,38% | −$33.157 | −$23.432 | 8 stop, 1 tgt |
| 5 | 10 | 4 (4-5) | 30,0% | −0,49% | −$22.060 | −$11.221 | 6 stop, 3 tgt, 1 tp→stop |
| 6 | 9 | 6 (6-7) | 77,8% | +2,46% | +$16.962 | +$29.520 | 6 tgt, 3 stop |
| 7 | 9 | 7 (7-8) | 66,7% | +2,60% | +$18.517 | +$31.460 | 6 tgt, 3 stop |
| 8 | 10 | 12 (9-14) | 40,0% | +0,37% | −$13.101 | +$128 | 4 stop, 3 tgt, 2 tp→stop, 1 trail |
| 9 | 9 | 21 (14-27) | 66,7% | +1,58% | +$3.786 | +$17.062 | 5 tgt, 3 trail, 1 tp→stop |
| **10** | 10 | **35 (28-118)** | **60,0%** | **+2,65%** | **+$18.597** | **+$31.982** | 5 tgt, 2 stop, 2 trail, 1 tp→stop |

### La correlación, y por qué el número crudo no sirve

| Spearman duración vs ... | IS | OOS |
|---|---|---|
| bruto sobre nocional, todos | **rho +0,434 · p < 0,0001** | **rho +0,455 · p < 0,0001** |
| P&L gold, todos | rho +0,370 · p < 0,0001 | rho +0,396 · p < 0,0001 |
| bruto, sólo **ganadores** (bruto > 0) | rho +0,405 · p = 0,0033 (n=46) | rho −0,135 · p = 0,394 (n=41) |
| bruto, sólo **perdedores** | rho −0,053 · p = 0,674 (n=65) | rho +0,198 · p = 0,150 (n=53) |
| **bruto, ESTRATIFICADO por camino de salida** | **rho +0,201 · p = 0,0334** | **rho −0,033 · p = 0,750** |

El signo crudo es **positivo**: los trades que tardan más rinden **mejor**, que
es exactamente lo contrario de lo que predice el paper. Pero ese número no vale
nada, y hay que decirlo con todas las letras:

**el sesgo es de construcción.** Un trade que muere en el stop tiene que morir
rápido —el stop está a 2-3% y la barra que lo toca suele ser la primera o la
segunda— y un trade que llega al target tiene que recorrer varias veces esa
distancia, así que tarda. La duración no es una variable independiente: es
básicamente una etiqueta del desenlace. Los deciles 1 y 2 del IS son 22 stops
secos, ni uno solo de otra cosa; el decil 10 es 8 targets de 12.

Por eso el control. El Spearman estratificado rankea la duración **dentro de
cada camino de salida** y recién ahí junta los rangos: ahí el efecto se cae de
+0,43 a +0,20 en el IS y a −0,03 en el OOS. **Cambia de signo entre ventanas.**

### La tabla controlada (IS + OOS, terciles de duración dentro de cada camino)

| Camino | Tercil | n | Vida med. | Win % | Bruto / nocional | Gold / trade | Black / trade |
|---|---|---:|---:|---:|---:|---:|---:|
| stop seco | T1 (corto) | 39 | 1 | 0,0% | −2,20% | −$41.590 | −$34.303 |
| stop seco | T2 | 39 | 3 | 2,6% | −1,98% | −$40.853 | −$31.690 |
| stop seco | T3 (largo) | 39 | 8 | 10,3% | −1,31% | **−$36.644** | **−$23.352** |
| tp parcial → target | T1 | 20 | 4 | 100,0% | +3,72% | +$35.658 | +$47.363 |
| tp parcial → target | T2 | 21 | 10 | 85,7% | +3,32% | +$28.160 | +$41.435 |
| tp parcial → target | T3 | 21 | 33 | 85,7% | +5,74% | **+$61.658** | **+$75.270** |
| tp parcial → trailing | T1 | 4 | 5 | 75,0% | +1,70% | +$8.232 | +$19.300 |
| tp parcial → trailing | T2 | 4 | 14 | 50,0% | +1,63% | +$6.190 | +$18.085 |
| tp parcial → trailing | T3 | 5 | 28 | 80,0% | +2,67% | +$18.538 | +$32.271 |
| tp parcial → stop | T1 | 4 | 6 | 25,0% | +1,29% | +$2.558 | +$13.549 |
| tp parcial → stop | T2 | 4 | 18 | 0,0% | −0,94% | −$31.692 | −$18.203 |
| tp parcial → stop | T3 | 4 | 49 | 25,0% | −0,99% | −$32.440 | −$18.955 |

**Leído camino por camino, la dirección del paper aparece en uno solo de los
cuatro, y es el que tiene n = 12.** En los stops secos, los que tardan más
pierden **menos** ($36.644 contra $41.590). En los targets, los que tardan más
ganan **más** ($61.658 contra $35.658). En los trailing, igual. El único que va
en la dirección de Locke & Mann es `tp parcial → stop` (+$2.558 → −$32.440), y
son cuatro trades por tercil.

**Y sobre el punto específico del paper —que cerrar rápido predice bien en
ganadores Y en perdedores—: acá no predice bien en ninguno de los dos.** Entre
los ganadores, el IS da rho +0,405 (los que corren más ganan más) y el OOS
−0,135; entre los perdedores, IS −0,053 y OOS +0,198. Cuatro celdas, cuatro
signos distintos, tres p-valores arriba de 0,15.

---

## 2. Bloque B · el barrido de H

Regla: si la posición sigue abierta después de H horas, se cierra **a mercado**
(al cierre de esa barra). El chequeo se hace **después** de stop, TP parcial,
target y trailing: si la barra tocó una salida real, gana la salida real. Sólo
se cierra a mercado lo que de verdad seguía abierto al cierre de esa barra.

Un detalle importante de la mecánica: **el time-stop no agrega una vuelta de
comisión.** La posición se cierra una sola vez de todos modos; el time-stop
cambia el precio de salida, no la cantidad de patas. Todo el daño que se ve
abajo es de precio, no de tarifa — y se confirma en que el P&L incremental en
Gold y en Black es casi idéntico (por ejemplo −$304.577 contra −$306.061 en
H = 8 mercado / IS).

### Reloj de barras de mercado del papel

**IS** (base: 111 trades, gold −0,83%, platinum −0,39%, black +0,04%)

| H | Trades | Cerrados por TS | Win | Payoff | Gold | Plat | Black | Sharpe | Max DD | ΔP&L gold cartera | ΔP&L gold aislado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 116 | 42 | 31,0% | 0,98 | −1,04% | −0,58% | −0,13% | −2,44 | 23,3% | −$299.276 | −$304.577 |
| 16 | 114 | 25 | 28,1% | 1,12 | **−1,20%** | −0,75% | −0,30% | −2,35 | 25,7% | −$521.946 | −$449.495 |
| 24 | 112 | 13 | 28,6% | 1,29 | −1,04% | −0,60% | −0,17% | −1,83 | 23,1% | −$302.163 | −$284.647 |
| 48 | 112 | 8 | 30,4% | 1,25 | −1,00% | −0,56% | −0,12% | −1,89 | 21,6% | −$236.473 | −$218.957 |
| 72 | 112 | 3 | 30,4% | 1,39 | −0,85% | −0,41% | +0,03% | −1,48 | 19,6% | −$27.966 | −$10.451 |
| 120 / 168 / 240 | 111 | 0 | 31,5% | 1,33 | −0,83% | −0,39% | +0,04% | −1,48 | 19,2% | $0 | $0 |

**OOS** (base: 94 trades, gold −0,95%, platinum −0,44%, black +0,07%)

| H | Trades | Cerrados por TS | Win | Payoff | Gold | Plat | Black | Sharpe | Max DD | ΔP&L gold cartera | ΔP&L gold aislado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 99 | 32 | 40,4% | 0,76 | **−1,05%** | −0,52% | +0,01% | −2,27 | 17,5% | −$107.075 | −$102.677 |
| 16 | 93 | 19 | 40,9% | 0,82 | −0,94% | −0,44% | +0,06% | −1,91 | 15,4% | +$1.286 | −$23.894 |
| 24 | 93 | 11 | 40,9% | 0,80 | −0,99% | −0,49% | +0,01% | −1,99 | 16,6% | −$45.696 | −$67.010 |
| 48 | 95 | 3 | 40,0% | 0,84 | −1,00% | −0,49% | +0,02% | −1,88 | 17,3% | −$59.106 | −$75.527 |
| 72 | 95 | 1 | 40,0% | 0,86 | −0,94% | −0,43% | +0,08% | −1,79 | 17,2% | +$3.443 | −$12.977 |
| 120 / 168 / 240 | 94 | 0 | 39,4% | 0,88 | −0,95% | −0,44% | +0,07% | −1,78 | 17,7% | $0 | $0 |

### Reloj de horas corridas desde el fill

**IS**

| H | Trades | Cerrados por TS | Gold | Plat | Black | Sharpe | Max DD | ΔP&L gold cartera | ΔP&L gold aislado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 115 | 50 | −1,02% | −0,57% | −0,11% | −2,40 | 22,7% | −$267.884 | −$321.168 |
| 16 | 115 | 50 | −1,02% | −0,57% | −0,11% | −2,40 | 22,7% | −$267.884 | −$321.168 |
| 24 | 114 | 44 | −0,96% | −0,51% | −0,06% | −2,27 | 21,7% | −$179.020 | −$283.638 |
| **48** | 113 | 32 | **−0,81%** | −0,36% | +0,08% | −1,72 | 20,1% | **+$32.045** | **−$131.188** |
| 72 | 113 | 24 | −0,98% | −0,54% | −0,10% | −1,71 | 21,4% | −$216.042 | −$379.275 |
| 120 | 112 | 16 | **−1,09%** | −0,65% | −0,22% | −1,96 | 23,6% | −$372.686 | −$355.171 |
| 168 | 112 | 10 | −1,00% | −0,56% | −0,12% | −1,88 | 21,6% | −$239.909 | −$222.393 |
| 240 | 112 | 7 | −0,95% | −0,51% | −0,07% | −1,77 | 20,6% | −$165.283 | −$147.767 |

**OOS**

| H | Trades | Cerrados por TS | Gold | Plat | Black | Sharpe | Max DD | ΔP&L gold cartera | ΔP&L gold aislado |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 100 | 39 | **−1,14%** | −0,61% | −0,08% | −2,39 | 17,9% | −$202.592 | −$197.783 |
| 16 | 100 | 39 | **−1,14%** | −0,61% | −0,08% | −2,39 | 17,9% | −$202.592 | −$197.783 |
| 24 | 99 | 34 | −0,98% | −0,45% | +0,08% | −2,08 | 16,4% | −$39.343 | −$93.069 |
| **48** | 97 | 22 | **−0,85%** | −0,32% | +0,20% | −1,71 | 14,3% | **+$100.320** | **−$16.118** |
| 72 | 97 | 19 | −0,94% | −0,42% | +0,10% | −1,86 | 16,0% | +$2.904 | −$90.087 |
| 120 | 93 | 14 | −0,93% | −0,43% | +0,07% | −1,89 | 15,9% | +$11.065 | −$43.014 |
| 168 | 95 | 4 | −1,01% | −0,50% | +0,01% | −1,88 | 17,2% | −$64.257 | −$80.678 |
| 240 | 95 | 2 | −1,00% | −0,49% | +0,02% | −1,89 | 17,4% | −$58.642 | −$75.063 |

(H = 8 y H = 16 con reloj corrido dan el mismo resultado: con barras de 60
minutos y rueda de 6,5 h, las dos condiciones se cumplen por primera vez en la
misma barra —la primera de la rueda siguiente— en el 100% de los casos.)

### Las dos columnas de P&L incremental, que es donde está la trampa

- **Δ cartera** = P&L total con la regla menos P&L total del base. Incluye el
  efecto de segundo orden: al cerrar antes, **la silla del tope de 5 posiciones
  se libera antes y entran trades que el base no tomaba**.
- **Δ aislado** = la misma regla aplicada al **mismo set de trades del base**,
  sin liberar la silla. Es el efecto del time-stop y nada más.

**Las dos únicas celdas del barrido que mejoran el mensual en las dos ventanas
son H = 48 con reloj corrido** (IS −0,81% contra −0,83%; OOS −0,85% contra
−0,95%). Y el desglose las mata: **aislado, esa misma regla da −0,92% en el IS
y −0,96% en el OOS**, o sea peor que el base en las dos. El Δ aislado es
**−$131.188 (IS) y −$16.118 (OOS)**. Toda la mejora aparente viene de que la
silla se libera antes y el bot **opera más**, no de que corte mejor.

Dicho de otra manera: **este time-stop no recorta exposición, la aumenta.** El
conteo de trades sube en **23 de las 26 celdas** que cortan algo (111 → 116 en
H = 8 mercado / IS; 94 → 100 en H = 8 corrido / OOS; las tres excepciones bajan
de 94 a 93). No es la perilla de volumen del filtro de volatilidad: es una
perilla de rotación.

### ¿Es monótono? No

| Reloj / ventana | Mensual gold contra H creciente |
|---|---|
| mercado / IS | **NO monótono** (−1,04 → −1,20 → −1,04 → −1,00 → −0,85 → −0,83 → −0,83 → −0,83) |
| mercado / OOS | **NO monótono** (−1,05 → −0,94 → −0,99 → −1,00 → −0,94 → −0,95 → −0,95 → −0,95) |
| corrido / IS | **NO monótono** (−1,02 → −1,02 → −0,96 → −0,81 → −0,98 → −1,09 → −1,00 → −0,95) |
| corrido / OOS | **NO monótono** (−1,14 → −1,14 → −0,98 → −0,85 → −0,94 → −0,93 → −1,01 → −1,00) |

Esto es lo contrario del filtro de volatilidad de `INFORME-NULO.md` §4.3, donde
el mensual mejoraba monótonamente al apretar el umbral y por eso quedaba claro
que se estaba moviendo un dial de exposición. Acá **no hay dirección**: el
mensual sube y baja con H sin ninguna estructura, en las cuatro combinaciones.
Eso no habla a favor de la regla — habla de ruido. Un efecto real tendría que
tener, como mínimo, una forma.

---

## 3. Bloque C · el nulo

La advertencia de anoche vale igual acá, aunque por otro motivo: si el sistema
tiene expectativa negativa, cualquier cosa que cambie la operatoria puede
"mejorar" el mensual por aritmética. Así que el time-stop no se compara contra
el base: se compara contra la distribución de todos los cortes posibles.

**Los dos nulos corren sobre el SET DE TRADES DEL BASE**, sin re-simular la
cartera. Es a propósito: así el nulo y la regla real mueven exactamente las
mismas piezas y la comparación no mezcla el efecto de liberar la silla antes,
que ya se reportó aparte en el bloque B. El valor real que se compara es, por
lo tanto, el **aislado**.

- **Nulo 1 · trades al azar** (el del enunciado): se cierran a mercado K trades
  elegidos al azar entre los 111 (o 94), cada uno en un momento uniforme entre
  su fill y su salida real. K = la cantidad que corta el time-stop real.
- **Nulo 2 · los mismos trades, otro momento**: se cierran **exactamente los K
  trades que el time-stop trunca**, pero en un momento al azar de su vida en
  vez de en H. Aísla "importa *cuándo* cortar" de "importa *a quién* cortar".

5.000 sorteos cada uno.

### Reloj de barras de mercado

| H | Ventana | K | Mensual real (aislado) | Mediana nulo 2 | Nulo 1: pctil / p | Nulo 2: pctil / p |
|---:|---|---:|---:|---:|---:|---:|
| 8 | IS | 40 | −1,04% | −0,91% | 1,0% / 0,990 | 12,1% / 0,879 |
| 16 | IS | 24 | −1,14% | −1,02% | **0,1% / 0,999** | 10,4% / 0,896 |
| 24 | IS | 13 | −1,03% | −1,03% | 0,5% / 0,995 | 48,8% / 0,512 |
| 48 | IS | 8 | −0,98% | −1,00% | 0,8% / 0,992 | 56,2% / 0,438 |
| 72 | IS | 3 | −0,84% | −0,86% | 32,3% / 0,678 | 64,9% / 0,351 |
| 8 | OOS | 29 | −1,05% | −0,97% | 16,3% / 0,837 | 25,4% / 0,746 |
| 16 | OOS | 18 | −0,97% | −1,06% | 34,1% / 0,659 | 82,9% / 0,171 |
| 24 | OOS | 11 | −1,01% | −1,04% | 18,6% / 0,814 | 61,3% / 0,387 |
| 48 | OOS | 3 | −1,02% | −0,98% | 6,3% / 0,937 | 21,8% / 0,782 |
| 72 | OOS | 1 | −0,96% | −0,93% | 20,2% / 0,799 | 33,2% / 0,672 |

### Reloj de horas corridas

| H | Ventana | K | Mensual real (aislado) | Mediana nulo 2 | Nulo 1: pctil / p | Nulo 2: pctil / p |
|---:|---|---:|---:|---:|---:|---:|
| 8 | IS | 49 | −1,05% | −0,86% | 1,2% / 0,988 | 5,9% / 0,941 |
| 16 | IS | 49 | −1,05% | −0,86% | 1,1% / 0,989 | 5,8% / 0,942 |
| 24 | IS | 44 | −1,03% | −0,86% | 1,7% / 0,983 | 7,7% / 0,923 |
| **48** | IS | 32 | −0,92% | −0,88% | 10,0% / 0,900 | 33,7% / 0,664 |
| 72 | IS | 24 | −1,10% | −1,08% | 0,2% / 0,998 | 41,3% / 0,587 |
| 120 | IS | 16 | −1,08% | −1,11% | 0,3% / 0,997 | 62,5% / 0,376 |
| 168 | IS | 10 | −0,99% | −1,06% | 1,0% / 0,990 | 83,6% / 0,165 |
| 240 | IS | 7 | −0,93% | −0,99% | 3,2% / 0,968 | 80,0% / 0,200 |
| 8 | OOS | 36 | −1,14% | −1,05% | 5,5% / 0,945 | 21,0% / 0,790 |
| 16 | OOS | 36 | −1,14% | −1,04% | 5,3% / 0,947 | 20,0% / 0,800 |
| 24 | OOS | 31 | −1,04% | −1,02% | 18,1% / 0,819 | 43,1% / 0,569 |
| **48** | OOS | 20 | −0,96% | −1,09% | 37,0% / 0,630 | **88,6% / 0,114** |
| 72 | OOS | 17 | −1,03% | −1,05% | 17,1% / 0,829 | 56,4% / 0,436 |
| 120 | OOS | 13 | −0,99% | −1,05% | 27,5% / 0,725 | 73,4% / 0,266 |
| 168 | OOS | 4 | −1,02% | −1,00% | 6,8% / 0,932 | 35,2% / 0,648 |
| 240 | OOS | 2 | −1,02% | −1,01% | 4,1% / 0,959 | 46,7% / 0,534 |

### Cómo se lee esto

**Ni una sola de las 26 celdas llega a p < 0,05 contra ninguno de los dos
nulos.** El mejor p-valor de todo el barrido es **0,114** (H = 48 corrido, OOS,
nulo 2) y su compañero en el in-sample —la misma regla, la otra ventana— da
**0,664**. No replica.

Y hay algo más fuerte que la falta de significancia: **contra el nulo 1, el
time-stop real cae por DEBAJO de la mediana del azar en las 26 celdas que cortan
algo, sin una sola excepción**, y en 12 de ellas por debajo del percentil 5. La
celda menos mala es H = 48 corrido / OOS, y está en el percentil 37. La lectura
de eso es directa y es la más incómoda para la hipótesis:

**cortar justo los trades más largos sale sistemáticamente peor que cortar la
misma cantidad de trades elegidos al azar.** El time-stop no es neutro con
selección cero: selecciona, y selecciona mal. Elige para cortar exactamente los
trades que el decil 10 de la tabla del bloque A muestra que son los mejores.

Contra el nulo 2 —los mismos trades, otro momento— el resultado se aplana hacia
la mediana (percentiles entre 6 y 89), que es lo que uno espera cuando el
momento del corte no aporta información: **da lo mismo cortar a las H horas que
cortar en cualquier otro momento de la vida del trade.** El daño ya estaba
hecho al elegir a quién cortar.

---

## 4. Bloque D · la versión fiel al paper: "razón muerta"

El paper no dice "cerrá a las H horas": dice **salí cuando la razón original
desapareció**. En este bot la razón original es el setup de nivel: soporte con
score ≥ 7 y R:R ≥ 2. Se implementaron tres lecturas, de la más literal a la más
indulgente, y las tres se evalúan **barra a barra corriendo el motor completo**
sobre el papel en cuestión.

| Variante | Regla de muerte |
|---|---|
| **D1** (literal, la del enunciado) | En la barra actual el motor ya no generaría **esta** señal: no hay nivel, o el nivel vigente difiere del de entrada en más de 0,5%, o score < 7, o R:R < 2, o contra-tendencia |
| **D2** (anclada) | El **nivel original** ya no califica: la zona se disolvió, o su score cayó bajo 7, o el R:R vigente desde ese nivel cayó bajo 2, o contra-tendencia |
| **D3** (anclada, sin R:R) | Igual que D2 pero **sin** la condición de R:R |

**Self-check obligatorio, y encontró dos bugs:** evaluado en la barra de la
señal, el evaluador anclado tiene que devolver el mismo score y el mismo R:R
que emitió el motor. En la primera versión daba 93/205. Los dos culpables: (a)
la zona ancla se buscaba como "la primera dentro de ±0,6%" y dos zonas vecinas
pueden tener el techo a menos de 0,6% una de otra, así que a veces agarraba la
de abajo; (b) `volEnZona` del motor devuelve `null` cuando la zona tiene un
solo pivote (`lo === hi`) y por lo tanto **no** ajusta el score, mientras que la
copia le aplicaba un −1. Corregidos los dos, el evaluador anclado reproduce
score y R:R en **205/205**. Sin ese chequeo, todo el bloque D hubiera medido
otra cosa.

### El hallazgo que hay que decir primero: la señal del bot muere al llenarse

**D1, la lectura literal, cierra 110 de los 111 trades del IS y 92 de los 94 del
OOS, con barra de corte mediana = 1 y percentil 90 = 2.** O sea: la razón
original desaparece en la barra siguiente al fill en casi todos los casos.

No es un bug, es mecánica del motor, y es un resultado en sí mismo. El motor
define la entrada como *el techo de la zona de soporte más cercana **debajo del
spot***. El fill ocurre justo cuando el precio **baja** a ese techo. En la barra
siguiente el spot ya está en la zona o abajo, esa zona deja de estar "debajo del
spot", y el motor re-deriva otra zona más abajo. Los motivos de muerte lo
confirman: **85 de 110 en el IS y 75 de 92 en el OOS son "el motor re-derivó
otra zona"**.

**Conclusión metodológica: la regla del paper no es implementable literalmente
sobre este bot, porque la señal que justifica la orden está extinguida por
construcción en el instante en que la orden se llena.** Ese es el motivo por el
que hacen falta las variantes ancladas.

### Resultados

| Variante | Ventana | Trades | Cierres por razón muerta | Gold | Black | Sharpe | Max DD | ΔP&L gold cartera | ΔP&L black cartera |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | IS | 111 | — | −0,83% | +0,04% | −1,48 | 19,2% | — | — |
| **D1** | IS | 120 | 90 | −0,98% | −0,37% | −3,13 | 21,8% | −$210.807 | −$590.730 |
| **D2** | IS | 116 | 76 | −0,96% | −0,33% | −2,75 | 21,1% | −$181.277 | −$526.589 |
| **D3** | IS | 112 | 33 | **−0,72%** | +0,07% | −1,47 | 16,0% | **+$161.519** | +$34.790 |
| base | OOS | 94 | — | −0,95% | +0,07% | −1,78 | 17,7% | — | — |
| **D1** | OOS | 102 | 73 | −1,25% | −0,52% | −3,26 | 18,1% | −$305.913 | −$600.109 |
| **D2** | OOS | 100 | 60 | −1,07% | −0,28% | −2,72 | 15,6% | −$124.543 | −$353.206 |
| **D3** | OOS | 97 | 16 | **−1,04%** | −0,05% | −1,95 | 17,4% | **−$95.174** | −$123.567 |

Motivos de muerte y momento del corte (versión aislada, sobre el set base):

| Variante | Ventana | Corta | Barra mediana / p90 | Motivos |
|---|---|---:|---:|---|
| D1 | IS | 110/111 | 1 / 2 | 85 re-derivó otra zona · 14 R:R<2 · 10 score<7 · 1 contra-tend. |
| D1 | OOS | 92/94 | 1 / 2 | 75 re-derivó otra zona · 13 R:R<2 · 3 score<7 · 1 sin nivel |
| D2 | IS | 97/111 | 1 / 4 | 59 R:R<2 · 35 score<7 · 3 contra-tend. |
| D2 | OOS | 77/94 | 1 / 5 | 61 R:R<2 · 15 score<7 · 1 zona disuelta |
| D3 | IS | 48/111 | 1 / 13 | 45 score<7 · 3 contra-tend. |
| D3 | OOS | 23/94 | 2 / 12 | 20 score<7 · 2 zona disuelta · 1 contra-tend. |

El R:R es el motivo dominante de D2, y también está contaminado por la misma
mecánica: el target del motor es *la resistencia más cercana **arriba del
spot***, así que cuando el fill baja el spot puede aparecer una resistencia
intermedia que antes no calificaba, el target se desploma y con él el R:R —sin
que al soporte le haya pasado absolutamente nada. Por eso existe D3, que es la
única de las tres que mide de verdad "el nivel dejó de calificar".

### Contra el nulo

| Variante | Ventana | K | Mensual real (aislado) | Nulo 1: pctil / p | Nulo 2: pctil / p | Nulo 2 Black: pctil |
|---|---|---:|---:|---:|---:|---:|
| D1 | IS | 110 | −0,96% | 0,1% / 0,999 | **0,5% / 0,995** | 0,0% |
| D1 | OOS | 92 | −1,10% | 5,1% / 0,949 | **3,8% / 0,962** | 0,1% |
| D2 | IS | 97 | −0,94% | 1,9% / 0,981 | **1,0% / 0,990** | 0,0% |
| D2 | OOS | 77 | −0,97% | 27,0% / 0,730 | 15,8% / 0,842 | 3,5% |
| D3 | IS | 48 | −0,71% | 56,7% / 0,433 | 67,3% / 0,327 | 52,8% |
| D3 | OOS | 23 | −1,07% | 11,4% / 0,886 | 27,2% / 0,728 | 25,8% |

**D1 y D2 son significativamente PEORES que el azar** (percentiles 0,5 y 1,0 en
el IS): cerrar donde el motor dice que la razón murió sale peor que cerrar los
mismos trades en un momento cualquiera. **D3 cae en la mediana del nulo**
(percentil 67 en el IS, 27 en el OOS, p = 0,33 y 0,73): no selecciona.

### La comparación que pedía el enunciado

> "Si la versión con mecanismo le gana al time-stop por reloj, eso es evidencia
> a favor del paper; si no, el efecto es puro recorte de exposición."

| | Mejor del reloj (H=48 corrido) | D3 (mejor con mecanismo) |
|---|---|---|
| Mensual gold IS (cartera) | −0,81% | −0,72% |
| Mensual gold OOS (cartera) | −0,85% | −1,04% |
| Mensual gold IS (aislado) | −0,92% | −0,71% |
| Mensual gold OOS (aislado) | −0,96% | −1,07% |
| Percentil nulo 2 IS / OOS | 33,7% / 88,6% | 67,3% / 27,2% |
| ¿Mejora en las DOS ventanas? | sí en cartera, **no** aislado | **no** |

**La versión con mecanismo no le gana al reloj.** D3 le gana en el in-sample
(−0,71% aislado contra −0,92%) y le pierde en el out-of-sample (−1,07% contra
−0,96%). Los percentiles contra el nulo son un espejo: donde una está arriba de
la mediana la otra está abajo, y viceversa. Con dos ventanas y dos reglas que se
cruzan, lo único que se puede concluir es que ninguna de las dos tiene señal.

Y hay que agregar que la respuesta a la pregunta del enunciado no es la
alternativa que estaba escrita: no es que "el efecto sea puro recorte de
exposición". **No hay recorte de exposición**: en las seis variantes de D el
número de trades **sube** (111 → 112/116/120; 94 → 97/100/102), porque cerrar
antes libera la silla del tope de 5 posiciones. Lo que hay es más rotación, no
menos.

---

## 5. Deflated Sharpe Ratio · N de 100 a 132

`INFORME.md` contaba 76, `INFORME-RECOMPRA.md` las llevó a 84 e
`INFORME-NULO.md` a 100. Este informe agrega **32**:

- **10** del barrido con reloj de mercado: 5 H que cortan algo (8, 16, 24, 48,
  72) × 2 ventanas. Las H = 120, 168 y 240 **no cortan ningún trade en ninguna
  de las dos ventanas** y son numéricamente idénticas al caso base, así que no
  son configuraciones nuevas y no entran.
- **16** del barrido con reloj corrido: 8 H × 2 ventanas.
- **6** de la razón muerta: 3 variantes × 2 ventanas.

**N = 132.** Los 5.000 sorteos de cada nulo **no** entran en el N, por el mismo
criterio de `INFORME-NULO.md` §6: son la distribución de referencia contra la
que se juzga una configuración, no configuraciones candidatas.

Reconstrucción verificada: las 100 SR previas se reproducen exacto —σ(SR) gold
4,0737e−2 y black 2,3329e−2, iguales a `results-nulo.json`; las 50 celdas del
barrido de robustez coinciden 50/50—. Con las 32 nuevas, σ(SR) queda en
**0,040723 (Gold)** y **0,025716 (Black)**.

| Corrida | Sharpe Gold | DSR Gold | Sharpe Black | DSR Black |
|---|---:|---:|---:|---:|
| base, IS | −1,48 | 0,00002 | +0,11 | 0,106 |
| base, OOS | −1,78 | 0,00006 | +0,17 | 0,158 |
| timestop mercado H=8, IS | −2,44 | 0,00000 | −0,29 | 0,039 |
| timestop mercado H=16, IS | −2,35 | 0,00000 | −0,58 | 0,018 |
| timestop mercado H=72, OOS | −1,79 | 0,00006 | +0,19 | 0,163 |
| timestop corrido H=8, IS | −2,40 | 0,00000 | −0,26 | 0,043 |
| **timestop corrido H=48, IS** | −1,72 | 0,00002 | +0,20 | 0,126 |
| **timestop corrido H=48, OOS** | −1,71 | 0,00009 | **+0,44** | **0,241** |
| timestop corrido H=120, IS | −1,96 | 0,00000 | −0,37 | 0,033 |
| razón muerta D1, IS | −3,13 | 0,00000 | −1,24 | 0,002 |
| razón muerta D1, OOS | −3,26 | 0,00000 | −1,44 | 0,003 |
| razón muerta D2, IS | −2,75 | 0,00000 | −0,99 | 0,005 |
| razón muerta D3, IS | −1,47 | 0,00001 | +0,17 | 0,122 |
| razón muerta D3, OOS | −1,95 | 0,00002 | −0,07 | 0,105 |

**Ninguno llega ni cerca de 0,95.** El mejor de todo este informe es el
time-stop de 48 horas corridas con tarifa Black en el out-of-sample, Sharpe
0,44 y DSR **0,241** — y es la celda cuyo compañero de in-sample está en el
percentil 34 del nulo. Después de descontar que se probaron 132 cosas, sigue
siendo una moneda cargada en contra. En Gold el DSR es cero con cuatro
decimales en las 34 corridas, que es lo que corresponde a Sharpes de −1,5 a
−3,3.

Nota de coherencia: el DSR de `base` baja un poco contra `INFORME-NULO.md`
(0,142 → 0,106 en Black IS) sólo porque N subió de 100 a 132 y σ(SR) de Black
subió de 0,0233 a 0,0257 al entrar variantes más dispersas. Ninguna conclusión
depende de eso.

---

## 6. Lo que no está modelado en este informe (y para qué lado tira)

| Aproximación | Efecto |
|---|---|
| El cierre por time-stop se ejecuta al **cierre de la barra horaria**, sin spread ni tick | **Optimista**: una orden a mercado real sale contra el bid |
| El time-stop se evalúa DESPUÉS de stop / TP / target / trailing en la misma barra | Conservador: no inventa salidas que la barra no permitía; si la barra tocó una salida real, gana la real |
| Los nulos corren sobre el set de trades del base, sin re-simular la cartera | A propósito: si no, el nulo mezclaría el efecto de liberar la silla antes, que se reporta aparte en el bloque B |
| El nulo sortea el momento de corte uniforme **en barras**, no en tiempo corrido | Irrelevante para el nulo 2 (mismos trades); en el nulo 1 favorece levemente cortes tempranos en trades con gaps largos |
| El bloque D corre el motor completo barra a barra, con la misma barra parcial que el generador de señales | Sin lookahead: la barra `i` usa sólo información hasta el cierre de `i` |
| D3 ignora la condición de R:R | Declarado: el R:R post-fill está contaminado por el propio fill (el target es "la resistencia arriba del spot") |
| Todo lo de `INFORME.md` §7 (earnings, libro de puntas, CCL diario, granularidad horaria) | Igual que en el informe principal |

---

## 7. Veredicto

**¿Los trades que tardan más rinden peor?** No. Rinden **mejor** en crudo
(Spearman +0,43 IS y +0,46 OOS sobre el bruto del nocional, p < 0,0001), y eso
es un artefacto: los stops son cortos por construcción y los targets son largos
por construcción. Controlado por camino de salida el efecto se cae a +0,20 (IS,
p = 0,033) y −0,03 (OOS, p = 0,75), **con el signo cambiado entre ventanas**. El
punto específico del paper —cerrar rápido predice bien en ganadores Y en
perdedores— no se verifica en ninguno de los dos grupos: cuatro celdas, cuatro
signos distintos, tres p > 0,15.

**¿El time-stop por reloj selecciona o sólo recorta exposición?** Ninguna de las
dos. **No selecciona**: ninguna de las 26 celdas llega a p < 0,05 contra ninguno
de los dos nulos, y el mejor p (0,114, H = 48 corrido, OOS) tiene 0,664 en la
otra ventana. **Y tampoco recorta exposición**: el conteo de trades *sube* en 23
de las 26 celdas (y en las seis variantes de razón muerta), porque cerrar antes
libera la silla del tope de 5 posiciones y entran operaciones que el base no
tomaba. Lo que la regla hace es **rotar más**.

Peor todavía: contra el nulo de trades al azar, el time-stop real queda por
**debajo** de la mediana en las 26 celdas que cortan algo, y bajo el
percentil 5 en doce de ellas. **Cortar justo los trades más largos sale peor
que cortar trades al azar**, porque los trades más largos son, en este sistema,
los mejores: el decil 10 de duración rinde +5,96% bruto sobre nocional en el IS
y +2,65% en el OOS, contra −2,40% y −0,30% del decil 1.

Y el barrido **no es monótono en ninguna de las cuatro combinaciones** reloj ×
ventana. Eso lo distingue del filtro de volatilidad, que al menos era un dial
honesto: acá no hay ni dirección.

**¿Y la versión con mecanismo, la fiel al paper?** Tampoco. Y de paso dejó el
hallazgo más interesante de todo el informe: **la señal de este bot está muerta
en el instante en que la orden se llena.** El motor define la entrada como el
techo de la zona de soporte más cercana *debajo del spot*, y el fill ocurre
justo cuando el precio baja a ese techo; en la barra siguiente esa zona ya no
está debajo del spot y el motor re-deriva otra. Por eso la lectura literal (D1)
cierra 110 de 111 trades en la barra siguiente al fill, con percentil 0,5 contra
el nulo. La versión anclada al nivel original sin la condición de R:R (D3) es la
única defendible, y mejora el IS 0,11 puntos y empeora el OOS 0,09, con
percentiles 67 y 27 contra el nulo: la mediana.

**La frase directa, que es lo que hay que retener: el time-stop no selecciona ni
recorta — destruye. Y el daño es de precio, no de comisión** (el P&L incremental
es casi idéntico en Gold y en Black, porque el time-stop no agrega una vuelta:
cambia el precio de la salida que de todos modos iba a haber). Con tarifa Gold y
con tarifa Black, cortar por reloj le saca al sistema exactamente los trades que
lo sostienen.

**Lo que no cambia:** la palanca sigue siendo la tarifa. Van tres hipótesis
testeadas esta semana —el filtro de volatilidad, la recompra del TP parcial y
ahora el time-stop— y las tres terminan en el mismo lugar: no hay una regla que
arregle un sistema cuyo edge bruto es 0,36% del nocional contra una vuelta de
1,12%. La única mejora reproducible de todo el estudio sigue siendo bajar el
costo de la vuelta.

---

*Generado offline el 17/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `timestop.js` (reusa `engine.js`; el chequeo de arranque
reproduce el `38/base` de `INFORME.md` con Δ = 0 y el replayer de trades
reproduce la cartera en 205/205). Semilla 20260917, 5.000 sorteos por celda,
reproducibilidad verificada con dos corridas idénticas. Detalle completo en
`results-timestop.json` y `run-timestop.log`. Convenciones, aproximaciones y
anti-lookahead en `README.md`, `INFORME.md`, `INFORME-RECOMPRA.md` e
`INFORME-NULO.md`.*
