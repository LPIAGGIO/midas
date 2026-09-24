# Informe · ¿conviene recomprar la mitad que vende el TP parcial?

**La primera línea, sin vueltas: no. Y no por la razón que uno esperaba. El
retroceso al nivel de entrada sí es selección adversa —cuando el precio vuelve,
la probabilidad de terminar en stop pasa de 14% a 38%— pero no tanta como para
matar la recompra: la mitad recomprada tiene un edge bruto de 0,65% del
nocional sobre las dos ventanas juntas. El problema es el de siempre: la vuelta
completa cuesta 1,04% en Gold. La recompra no es una regla nueva, es una vuelta
más de la misma calesita, y hereda exactamente la misma aritmética. En Gold
resta (−$88.659 sobre 35 meses), en Platinum queda en cero (−$5.977) y en Black
suma una miseria (+$76.707, o 0,03 puntos mensuales). Y el saldo liberado
tampoco tiene uso alternativo: en las dos ventanas, la restricción que corta
las señales es el tope de 5 posiciones, no la caja. Cero señales saltadas por
falta de plata, en 899 señales.**

Todo corrió local sobre `data/` y el cache `signals.json` que ya generó
`simulate.js`. No se tocó el VPS ni Supabase. Motor y reglas de ejecución
idénticos al informe principal: el caso base de este informe reproduce
número por número el `38/base` de `INFORME.md` (−0,83%/mes IS, −0,95%/mes OOS
en Gold, 111 y 94 trades).

---

## 0. Qué se preguntó y cómo se contestó

Cuando el TP parcial vende la mitad al 50% del camino al target, quedan dos
opciones para esa plata:

- **recomprar**: dejar una orden límite por la misma cantidad más abajo,
  vigente hasta que el trade se cierre. Si se llena, la posición vuelve a
  tamaño completo y sale toda junta por donde el motor ya decide;
- **dejarla libre** para otra operación.

El trabajo va en tres bloques, en este orden, y los tres se definieron mirando
**sólo el in-sample**. El out-of-sample se corrió una sola vez, sin retocar
nada.

---

## 1. Bloque A · ¿el retroceso a la entrada anticipa recuperación o stop?

Para cada trade que alcanzó el TP parcial (43 en IS, 44 en OOS) se caminaron
las barras horarias desde el instante del TP hasta la salida final, anotando si
el precio volvió a tocar el nivel de entrada original y cuánto tardó.

| | IS | OOS |
|---|---:|---:|
| Trades con TP parcial | 43 | 44 |
| Volvieron al nivel de **entrada** | 17 (39,5%) | 15 (34,1%) |
| Llegaron al nivel **entrada-stop** (mitad de camino al stop) | 14 (32,6%) | 9 (20,5%) |
| ...de los que volvieron, murieron en la **misma barra** del retroceso | 6 | 8 |
| Mediana hasta el retroceso | 18 h corridas / 4 barras | 66 h / 7 barras |
| Percentil 90 | 216 h | 125 h |

### La tabla cruzada (volvió × desenlace)

Cada celda: **n / P&L Gold promedio por trade**.

**IS (43 trades con TP parcial)**

| Volvió a la entrada | target | trailing | stop | total |
|---|---:|---:|---:|---:|
| **sí** | 5 / +$106.160 | 5 / +$6.341 | 7 / −$18.449 | 17 / +$25.492 |
| **no** | 24 / +$39.678 | 2 / +$5.740 | 0 / — | 26 / +$37.068 |

**OOS (44 trades con TP parcial)**

| Volvió a la entrada | target | trailing | stop | total |
|---|---:|---:|---:|---:|
| **sí** | 5 / +$26.270 | 5 / +$15.451 | 5 / −$23.431 | 15 / +$6.097 |
| **no** | 28 / +$35.176 | 1 / +$29.934 | 0 / — | 29 / +$34.995 |

### Cómo hay que leer esa tabla (el detalle que la arruina a medias)

**La columna del stop está forzada por construcción.** El stop está siempre
por debajo de la entrada, así que para morir en el stop el precio *tiene* que
haber cruzado el nivel de entrada. Por eso la fila "no" tiene cero stops en las
dos ventanas: no es un hallazgo, es una identidad. Lo mismo, en parte, con el
trailing: el primer escalón del trailing queda exactamente en la entrada.

Lo que sí informa es la **composición dentro de la fila "sí"**, y ahí el
resultado es claro:

| Sobre los 87 trades con TP parcial (IS+OOS) | P(target) | P(trailing) | P(stop) |
|---|---:|---:|---:|
| Incondicional | 71,3% | 14,9% | 13,8% |
| **Condicional a que volvió a la entrada** (n=32) | 31,3% | 31,3% | **37,5%** |
| Condicional a que NO volvió (n=55) | 94,5% | 5,5% | 0% |

**El retroceso al nivel de entrada casi triplica la probabilidad de stop (de
14% a 38%) y baja la de target de 71% a 31%.** Es selección adversa medida, y
no es chica. Pero tampoco es letal: dos de cada tres veces que el precio vuelve
a la entrada, el trade termina arriba (target o trailing). La pregunta pasa a
ser aritmética: ¿el 31% de targets paga el 38% de stops, después de comisión?

Un dato más, para dimensionar el problema de modelado: **de los 32 retrocesos,
14 ocurrieron en la misma barra horaria que mató al trade** (6 en IS, 8 en
OOS). Con granularidad de 60 minutos no hay forma de saber si el límite se
llenó antes de que saltara el stop. Se adoptó el supuesto pesimista y
realista —para llegar al stop el precio tuvo que cruzar el límite de recompra,
así que **se llena y muere**— y se reporta aparte la variante optimista donde
gana el stop.

---

## 2. Bloque B · la regla de recompra, walk-forward estricto

Dos niveles de recompra, sin elegir el mejor:

- **`rc-entrada`**: la recompra queda en el nivel de entrada original;
- **`rc-entrada-stop`**: a mitad de camino entre la entrada y el stop.

La orden vive desde la barra siguiente al TP parcial (mismo anti-lookahead que
las entradas) hasta que el trade se cierra. La recompra paga comisión de
entrada completa y su venta paga comisión de salida, con la bonificación
intradiaria cuando recompra y venta caen el mismo día — por eso la vuelta
efectiva medida da 1,09% en Gold y no el 1,33% nominal de dos patas plenas.
Mientras la orden está viva reserva la caja correspondiente (no se puede usar
para otra cosa).

### IS · 2023-10-19 → 2025-06-30 (20,4 meses, 111 trades)

| | base | rc-entrada | rc-entrada-stop |
|---|---:|---:|---:|
| Recompras disparadas | 0 | **17** | **14** |
| Salidas de la mitad recomprada | — | 5 tgt / 5 trail / 7 stop | 4 tgt / 3 trail / 7 stop |
| Bruto de la recompra (% del nocional) | — | **+0,170%** | **+0,825%** |
| Mensual Gold | −0,83% | −0,91% | −0,84% |
| Mensual Platinum | −0,39% | −0,44% | −0,38% |
| Mensual Black | +0,04% | +0,03% | +0,08% |
| Win rate | 31,5% | 31,5% | 31,5% |
| Payoff | 1,33 | 1,30 | 1,33 |
| Sharpe Gold | −1,48 | −1,51 | −1,46 |
| Max DD Gold | 19,2% | 20,6% | 20,0% |
| **P&L incremental de la recompra · Gold** | — | **−$111.264** | **−$17.316** |
| **...Platinum** | — | **−$64.408** | **+$17.325** |
| **...Black** | — | **−$17.551** | **+$51.965** |

### OOS · 2025-07-01 → 2026-09-17 (14,6 meses, 94 trades)

| | base | rc-entrada | rc-entrada-stop |
|---|---:|---:|---:|
| Recompras disparadas | 0 | **15** | **9** |
| Salidas de la mitad recomprada | — | 5 tgt / 5 trail / 5 stop | 4 tgt / 5 stop |
| Bruto de la recompra (% del nocional) | — | **+1,194%** | **+1,775%** |
| Mensual Gold | −0,95% | −0,92% | −0,90% |
| Mensual Platinum | −0,44% | −0,38% | −0,37% |
| Mensual Black | +0,07% | +0,16% | +0,16% |
| Win rate | 39,4% | 37,2% | 39,4% |
| Payoff | 0,88 | 1,01 | 0,92 |
| Sharpe Gold | −1,78 | −1,62 | −1,64 |
| Max DD Gold | 17,7% | 17,7% | 17,2% |
| **P&L incremental de la recompra · Gold** | — | **+$22.605** | **+$42.912** |
| **...Platinum** | — | **+$58.431** | **+$66.326** |
| **...Black** | — | **+$94.258** | **+$89.740** |

El P&L incremental está aislado: es la suma del P&L de las patas de recompra,
con su propia comisión de entrada y de salida. Coincide al peso con la
diferencia de P&L total contra el base, porque la reserva de caja de la orden
límite no desplazó ni una sola operación (ver bloque C).

### Las dos ventanas juntas, que es lo que importa

| P&L incremental de la recompra, 35 meses | Gold | Platinum | Black |
|---|---:|---:|---:|
| `rc-entrada` (32 recompras) | **−$88.659** | −$5.977 | +$76.707 |
| `rc-entrada-stop` (23 recompras) | +$25.596 | +$83.651 | +$141.705 |

Y la descomposición que explica todo, igual que en el informe principal:

| | IS | OOS | Juntas |
|---|---:|---:|---:|
| Bruto de la mitad recomprada (% del nocional, nivel entrada) | +0,170% | +1,194% | **+0,645%** |
| Costo de la vuelta de la recompra, Gold | 1,091% | 0,978% | 1,039% |
| Costo de la vuelta de la recompra, Platinum | 0,703% | 0,636% | 0,672% |
| Costo de la vuelta de la recompra, Black | 0,315% | 0,293% | 0,305% |

**La recompra tiene edge bruto positivo en las dos ventanas.** No es cero: el
retroceso a la entrada es adverso, pero la mitad comprada ahí gana, en bruto,
0,17% en el IS y 1,19% en el OOS. El problema es que ese edge se compara contra
exactamente los mismos números que el sistema entero: Gold se lo come, Platinum
empata, Black lo deja pasar. **La recompra no cambia la naturaleza del
negocio, lo multiplica.**

### Lo frágil

1. **El signo se da vuelta entre ventanas en Gold.** `rc-entrada` da
   −$111.264 en el IS y +$22.605 en el OOS. Con 17 y 15 recompras, eso es
   ruido, no una regla.
2. **El resultado depende del supuesto intrabarra más que del efecto medido.**
   La variante optimista (si la barra toca el stop y el límite, gana el stop y
   la recompra no se llena) da, en OOS Gold, +$98.639 en vez de +$22.605. La
   incertidumbre de modelado es cuatro veces el efecto.

| Sensibilidad al orden dentro de la barra · P&L incremental Gold | IS | OOS |
|---|---:|---:|
| `rc-entrada`, la recompra se llena y después salta el stop (principal) | −$111.264 | +$22.605 |
| `rc-entrada`, gana el stop y la recompra no se llena (optimista) | −$70.821 | +$98.639 |
| `rc-entrada-stop`, se llena y después el stop (principal) | −$17.316 | +$42.912 |
| `rc-entrada-stop`, gana el stop (optimista) | +$25.264 | +$75.558 |

3. **La frecuencia es ridícula.** 32 recompras en 35 meses: una cada cinco
   semanas. Aun si el efecto fuera real y del tamaño del mejor caso, mueve
   0,09 puntos mensuales sobre un base de −0,95%.

El único patrón que aguanta las dos ventanas: **el nivel más profundo
(entrada-stop) le gana al nivel de entrada en 5 de las 6 celdas tier × ventana**.
Tiene sentido mecánico —comprar más abajo mejora el precio y filtra los
retrocesos superficiales, que son los que menos aportan— pero con 23 fills no
alcanza para llamarlo hallazgo.

---

## 3. Bloque C · ¿el saldo liberado tiene uso alternativo?

Esta era la otra mitad de la pregunta, y la respuesta es la más limpia de todo
el informe.

| | IS | OOS |
|---|---:|---:|
| Señales del gate | 528 | 371 |
| Skips por tope de posiciones (`posMax`) | 30 | 13 |
| ...**de esos, con al menos una posición con TP parcial ya ejecutado** | **15** | **12** |
| Skips por falta de caja | **0** | **0** |
| Órdenes cuyo tamaño recortó la restricción de caja | **0** | **0** |
| Caja ociosa en el momento del skip | $700.000 a $1.400.000 | $700.000 a $1.400.000 |

La mitad de los skips por tope de posiciones en el IS, y 12 de 13 en el OOS,
ocurrieron con la caja liberada ahí, quieta. Pero **la señal se rechaza antes
de llegar al chequeo de caja**: la restricción que muerde es `MAX_POS = 5`,
contada por posición, no por plata. Una posición a la que el TP parcial le
sacó la mitad sigue ocupando una silla entera.

O sea: **el saldo liberado no tiene ningún uso alternativo bajo las reglas
actuales.** No hay que elegir entre recomprar y usarlo para otra cosa, porque
"otra cosa" no existe. La plata se queda quieta en las dos ramas.

### ¿Y si se cambiara el tope para que sí tuviera uso?

Si el tope contara medias sillas y esas señales se pudieran tomar, valen:

| | IS | OOS |
|---|---:|---:|
| Señales recuperables | 15 | 12 |
| Fill rate de las órdenes colocadas | 28,5% (111/389) | 32,2% (94/292) |
| Trades extra esperados | 4,3 | 3,9 |
| Expectancy del motor por trade, Gold | −$10.657 | −$10.250 |
| **P&L estimado, Gold** | **−$45.614** | **−$39.596** |
| **P&L estimado, Black** | **+$2.326** | **+$2.921** |

**El uso alternativo del saldo liberado vale −$85.210 en Gold y +$5.247 en
Black sobre 35 meses.** Es decir: nada, y en Gold es plata perdida. Esto no
sorprende — son trades del mismo motor, con la misma expectancy negativa. Abrir
más sillas para un sistema que pierde por trade es abrir más sangría.

---

## 4. Deflated Sharpe Ratio · el N actualizado

`INFORME.md` contaba 76 configuraciones. Este informe agrega **8**: 2 niveles
de recompra × 2 órdenes de llenado intrabarra × 2 ventanas. **N = 84.**

De paso se corrigió un detalle del cálculo anterior: `results.json` guardaba
del barrido de robustez sólo el Sharpe de Gold, así que σ(SR) de Black había
quedado calculado sobre menos variantes. Las 50 celdas del barrido se volvieron
a correr acá (coinciden 50/50 con `results.json`, al noveno decimal) para
recuperar también su SR diario en Black. σ(SR) queda en 0,03864 (Gold) y
0,02318 (Black).

| Corrida | Sharpe Gold | DSR Gold | Sharpe Black | DSR Black |
|---|---:|---:|---:|---:|
| base, IS | −1,48 | 0,00005 | +0,11 | 0,151 |
| `rc-entrada`, IS | −1,51 | 0,00004 | +0,09 | 0,143 |
| `rc-entrada-stop`, IS | −1,46 | 0,00006 | +0,17 | 0,170 |
| base, OOS | −1,78 | 0,00013 | +0,17 | 0,206 |
| `rc-entrada`, OOS | −1,62 | 0,00027 | +0,33 | **0,259** |
| `rc-entrada-stop`, OOS | −1,64 | 0,00023 | +0,33 | **0,260** |
| *sensibilidad*: `rc-entrada` optimista, OOS | −1,51 | 0,00044 | +0,42 | 0,292 |
| *sensibilidad*: `rc-entrada-stop` optimista, OOS | −1,59 | 0,00028 | +0,37 | 0,275 |

**Ninguna llega ni cerca de 0,95.** La mejor de todo este informe —recompra en
Black en el out-of-sample, Sharpe 0,33— tiene un DSR de 0,26: después de
descontar que probamos 84 cosas, es tres veces más probable que ese Sharpe sea
cero a que sea positivo. En Gold el DSR es cero con cuatro decimales en las
seis corridas, que es lo que corresponde a Sharpes de −1,4 a −1,8.

---

## 5. Lo que no está modelado en la recompra (y para qué lado tira)

| Aproximación | Efecto |
|---|---|
| El límite de recompra se llena en el nivel exacto, sin spread ni tick | **Optimista** |
| La confirmación anti-fantasma de 150 s del worker no se simula | **Optimista** (algún fill de mecha no sería real) |
| Orden dentro de la barra: la recompra se llena y después salta el stop | **Pesimista**, y es el supuesto principal; la variante contraria está reportada |
| La orden de recompra reserva caja mientras vive | Irrelevante acá: la caja nunca fue la restricción (bloque C) |
| Una segunda orden viva por posición en IOL, con su propia lógica de cancelación | No modelado: es complejidad operativa real que el backtest no cobra |
| Todo lo del informe principal (earnings, libro de puntas, CCL diario, etc.) | Igual que en `INFORME.md` §7 |

---

## 6. Veredicto

**¿El retroceso al nivel de entrada es selección adversa?** Sí, y medida: la
probabilidad de terminar en stop pasa de 13,8% a 37,5%, y la de target cae de
71,3% a 31,3%. Pero no alcanza para dar vuelta el signo — la mitad recomprada
tiene edge bruto positivo en las dos ventanas (+0,17% IS, +1,19% OOS del
nocional).

**¿Conviene recomprar?** Depende sólo de una cosa, la misma de siempre:

- **En Gold, no.** El edge bruto combinado de la recompra es 0,645% del
  nocional contra una vuelta de 1,039%. Sobre 35 meses la recompra en el nivel
  de entrada resta $88.659. Poner una orden más es pagar una comisión más.
- **En Platinum, da exactamente igual.** −$5.977 en 35 meses. Es cero.
- **En Black, suma una miseria.** +$76.707 en el nivel de entrada, +$141.705 en
  el nivel entrada-stop, o sea entre 0,03 y 0,06 puntos mensuales, con DSR de
  0,26 y n=32. No es una recomendación, es un empate con signo.

**¿Y dejar el saldo libre para otra operación?** Tampoco, porque no existe esa
otra operación: en 899 señales de las dos ventanas, **cero** fueron rechazadas
por falta de caja, y **cero** órdenes vieron su tamaño recortado por la caja.
Los 43 skips por tope de posiciones son por el contador de 5 sillas, que la
mitad vendida no libera. El saldo liberado es plata ociosa en las dos ramas de
la decisión.

**La recomendación directa, en una línea:** no recomprar. No porque el
retroceso sea una trampa —es sólo medio trampa—, sino porque con tarifa Gold
cada vuelta extra cuesta más de lo que el retroceso paga, y el saldo liberado
no tiene adónde ir de todos modos. Si algún día LP llega a Black, la recompra
vuelve a estar sobre la mesa, y ahí el nivel a probar es el de **mitad de
camino al stop**, no el de entrada: es el único que no cambia de signo entre
ventanas en Platinum y Black. Mientras tanto, la palanca sigue siendo la misma
que dijo el informe principal: la tarifa, no las reglas.

---

*Generado offline el 17/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `recompra.js` (reusa `engine.js`; el caso base
reproduce exacto el `38/base` de `simulate.js`). Detalle completo en
`results-recompra.json` y `run-recompra.log`. Convenciones, aproximaciones y
anti-lookahead en `README.md` e `INFORME.md`.*
