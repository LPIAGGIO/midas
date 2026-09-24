# Informe · ¿la variable se vuelve accionable con granularidad fina?

**La primera línea, sin vueltas: no. A 5 minutos la variable se determina
rapidísimo —mediana de 5 minutos, o sea la PRIMERA barra posterior al fill, y en
el 74,5% de los trades ya no vuelve a cambiar de signo en toda la hora— y el
corte crudo separa igual de bien que a nivel horario (expectancy Gold +$718
contra −$31.165 a los 30', p < 0,0001; y a los 10' ya es p = 0,0022). Pero
soltar la posición con esa información NO produce nada: contra el nulo de soltar
la misma cantidad al azar en un momento al azar, el mejor H (30 minutos) cae en
el **percentil 55,2 de Gold (p = 0,45) y 46,6 de Black (p = 0,53)** —la mediana
del nulo, el mismo lugar donde murió el filtro de volatilidad en
`INFORME-NULO.md`— y ningún H llega al percentil 60. Y hay algo peor, que es el
hallazgo verdadero de este anexo: **el delta positivo que muestra el barrido de
H no es precio, es el calendario de la comisión.** Descompuesto a los 5
minutos, de los +$156.675 de mejora en Gold, +$144.257 son comisión ahorrada
(soltar el mismo día hace que la segunda pata sea bonificada, 0,0605% en vez de
0,6655%) y sólo +$12.419 son el papel. Neutralizada esa ventaja de calendario,
el delta se da vuelta a **−0,024% a los 5', −0,006% a los 10' y −0,008% a los
15'** en Gold. El control de 1 minuto (n = 111, una semana) no mejora la curva
por debajo de los 5 minutos: es no monótono y cambia de signo entre horizontes
contiguos (+0,111% a 1', +0,020% a 3', +0,095% a 5', +0,135% a 10'), lo que con
12 a 28 posiciones soltadas es ruido. **Y hay que decirlo con todas las letras:
H = 60 NO reproduce el resultado negativo conocido** (da +0,150% en Gold contra
el −1,24%/−1,20% de `INFORME-BARRIDO.md` §5): reproduce el *veredicto* —no hay
mejora atribuible a la señal— pero no el *nivel*, y las razones están en §5. El
DSR pasa de N = 160 a **N = 172** y el mejor del proyecto baja de 0,911 a
**0,9075**, sobre la misma cartera que no se puede armar. **Conclusión de
factibilidad: no justifica pagar por datos de mejor granularidad.**

Todo corrió local sobre `../backtest-reglas/data` (5m) y `data-1m` (1m, bajadas
por `bajar1m.js`). No se tocó el VPS ni Supabase. No se commiteó nada.

**Semilla del generador aleatorio: `20260917`** (mulberry32, `fino.js`), la
misma de `INFORME-NULO.md`, `INFORME-TIMESTOP.md` e `INFORME-BARRIDO.md`. 5.000
sorteos por celda. Reproducibilidad verificada: dos corridas seguidas dan la
misma huella FNV-1a sobre los 1.192 números del informe (`b26f498b`).

---

## 1. Limitaciones · esto va PRIMERO porque condiciona todo lo demás

Esto es un **estudio de factibilidad**. Contesta si vale la pena conseguir datos
finos de verdad, **no** si la regla funciona. Nada de lo que sigue es una
recomendación de operación.

| Limitación | Qué significa |
|---|---|
| **Una sola ventana de régimen** | Los fills van del **11/08/2026 al 16/09/2026**: 36 días corridos, ~26 ruedas. No son 60 días de trades; 60 días es la cobertura de las *barras*. Un solo régimen, sin ciclo. |
| **No hay walk-forward posible** | Partir 30/30 por fecha de fill (corte 14/09, n = 78 / 79) no es un out-of-sample: la segunda mitad se mira igual, con los mismos parámetros y en el mismo régimen. Está reportado en §4 y hay que tratarlo como **indicativo**, nada más. |
| **La muestra NO es la del backtest de 5 años** | Son señales del **libro paper/sombra** del bot: 148 de los 157 trades son `shadow`, o sea señales SIN el filtro de entrada (score ≥ 7, R:R ≥ 2, régimen). Sólo 6 son `paper` y 3 `real`. **El bot no hubiera tomado la mayoría de estos trades.** Los del backtest que caen en la ventana son ~13 y no alcanzan para nada. |
| **El modo es AISLADO** | Cada trade se replica solo, sin cartera: no hay tope de 5 posiciones, no hay capital compartido, soltar una posición no libera la silla para otra. `INFORME-BARRIDO.md` §5, en cambio, mide el corte re-simulando la cartera entera. Es una de las tres razones por las que H = 60 no reproduce (§5). |
| **Precio de referencia y precio de entrada no son lo mismo** | La variable compara el precio contra el **nivel** (`entry_limit`). El P&L usa el precio al que se llenó de verdad (`entry_price`), que en la mediana coincide con el nivel pero en 14 de los 176 llenados difiere más de 0,1% por gap. El delta no se ve afectado: base y regla comparten el mismo precio de entrada. |
| **40 de 157 trades siguen abiertos al final de la serie** | Se marcan a mercado en la última barra (`fin_datos`). Base y regla comparten la convención, pero el 25% de la muestra tiene un desenlace que todavía no ocurrió. |
| **La ventana de decisión tiene que caber en la sesión** | Se exigen 60 minutos de mercado en la MISMA rueda después del fill. Eso saca 19 trades de los 176 llenados: los que se llenaron cerca del cierre, donde "esperar" significaría cruzar la noche, que es otra cosa. |
| **El replay no es el bot** | El motivo de salida del replay coincide con el que registró el libro en **109/120** (90,8%) de los cerrados, en línea con el 126/132 (95%) de `research/backtest-reglas/INFORME.md`. El resto diverge por el feed de 60 s contra cierres de vela. |
| **Yahoo, no el libro de puntas** | Las barras de 5m y 1m son del subyacente en NYSE, no del CEDEAR local. Sin spread, sin tick, sin profundidad. Soltar al cierre de la barra se ejecuta al cierre exacto: **optimista**. |
| **La serie de 1 minuto son 7 días** | `range=7d&interval=1m` da ~2.602 barras por ticker, del 10/09 al 18/09. La submuestra utilizable son 111 trades y sólo una semana. Se reporta el n y no se concluye de más. |

---

## 2. La muestra · cuántos quedan y por qué

| | |
|---|---:|
| Registros del libro (`paper_trades_export.json`) | 286 |
| — sin fill (cancelled/pending: la límite venció sin tocar) | −110 |
| — kit inválido (stop ≥ entrada o target ≤ entrada) | −0 |
| — sin barras de 5m para el símbolo | −0 |
| — **sin 60 minutos de sesión después del fill** | **−19** |
| — cantidad < 1 | −0 |
| **USABLES** | **157** |

- **Modo:** 148 `shadow` · 6 `paper` · 3 `real`.
- **Símbolos:** 46.
- **Ventana de fills:** 11/08/2026 13:47 → 16/09/2026 18:49.
- **Barras de 5m:** 52 símbolos, 243.189 barras, 23/06/2026 → 16/09/2026.
- **Nocional total:** $274.468.428 (mediana ~$1,75 M por trade, el mismo orden
  que los $1,4 M de `INFORME-BARRIDO.md` §5).
- **Motivos de salida del replay base:** target 75 · stop 39 · trailing 3 ·
  fin de datos 40.

Chequeos que corren solos, los dos limpios:

| Chequeo | Resultado |
|---|---|
| Motivo de salida del replay 5m contra el que registró el libro | **109/120** (90,8%) |
| Las soltadas que no llegaron a ejecutarse (el trade ya había salido) reproducen exacto el P&L base | **185/185** |

---

## 3. Bloque A · la variable reconstruida a 5 minutos

La variable es la de `INFORME-BARRIDO.md` §3 en su versión fina: **al minuto H
del fill, ¿el cierre de la barra de 5m está arriba o abajo del nivel de
entrada?** Se evalúa en el primer cierre de barra en o después de `fill + H`, así
que el lag real es H a H+5 minutos, nunca menos.

### Tiempo hasta determinación

Definido como el primer H de la grilla a partir del cual el veredicto **ya no
cambia** hasta el minuto 60.

| | Minutos desde el fill |
|---|---:|
| p25 | **5** |
| **Mediana** | **5** |
| p75 | **10** |
| p90 | **42** |
| Media | 13,2 |
| Determinado ya en la 1ª barra (5') | **117/157 = 74,5%** |
| Sin ningún cambio de signo en los 60' | 117/157 |
| Cambios de signo promedio en la hora | 0,54 |

**La variable se determina en la primera barra de 5 minutos en tres de cada
cuatro trades.** No hace falta esperar la hora: el precio se pone de un lado del
nivel y se queda. La cola del p90 (42') es el cuarto restante, donde el precio
oscila alrededor del nivel —que es justamente donde el veredicto es menos
informativo, porque el papel está pegado a él.

### Concordancia del veredicto a los H' con el del minuto 60

| H | 5' | 10' | 15' | 20' | 25' | 30' | 35' | 40' | 45' | 50' | 55' | 60' |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| vs minuto 60 | 82,8% | 86,0% | 86,0% | 85,4% | 87,3% | 86,0% | 90,4% | 94,3% | 91,1% | 94,9% | 96,8% | 100% |
| vs cierre de la HORA DE RELOJ | 86,6% | 92,4% | 92,4% | 93,0% | 93,6% | 91,1% | 93,0% | 91,7% | 93,6% | 92,4% | 89,2% | 88,5% |

A los 5 minutos ya se sabe el 83-87% de lo que se va a saber a los 60. El resto
de la hora agrega 13-17 puntos de certeza a cambio de 55 minutos de exposición.

### Un detalle de medición que hay que decir antes de seguir

`INFORME-BARRIDO.md` mide la variable **al cierre de la barra horaria que
contiene el fill**, no a los 60 minutos del fill. Como el fill cae en cualquier
punto de esa hora, el lag real de aquel informe es:

| | p25 | Mediana | p75 |
|---|---:|---:|---:|
| Lag del veredicto "cierre de la hora de reloj" | 14' | **23'** | 37' |

O sea: el informe anterior no llegaba 60 minutos tarde en promedio, **llegaba 23**.
Eso reduce bastante el margen que este anexo podía ganar, y está medido acá por
primera vez. Se reporta la variante "cierre de la hora de reloj" aparte, en §5,
porque es la única comparable de verdad contra el informe anterior.

### Reparto arriba/abajo

| H | 5' | 10' | 15' | 20' | 30' | 45' | 60' |
|---|---:|---:|---:|---:|---:|---:|---:|
| Arriba del nivel | 136 | 127 | 121 | 120 | 117 | 121 | 119 |
| Abajo del nivel | 21 | 30 | 36 | 37 | 40 | 36 | 38 |

Al minuto 5 sólo 21 de 157 están abajo; a los 30 se estabiliza en ~40. La
proporción final (76% arriba) es mucho más alta que el 37% (IS) y 31% (OOS) del
informe anterior — otra señal de que la muestra no es la misma.

---

## 4. Bloque B · el barrido de horizontes

La regla: **a los H minutos del fill, si el precio está abajo del nivel, se
suelta lo que quede de la posición al cierre de esa barra**; si está arriba, se
sigue con la gestión normal (TP parcial al 50% del camino, trailing desde +2R,
stop/target con confirmación de 10 minutos). Retorno del conjunto = P&L neto
sobre el nocional de entrada; expectancy = P&L neto por trade.

### Base · no hacer nada · n = 157

| Tarifa | Total | Retorno del conjunto | Expectancy | Win |
|---|---:|---:|---:|---:|
| Gold | −$1.162.607 | **−0,424%** | −$7.405 | 49,0% |
| Platinum | −$200.782 | −0,073% | −$1.279 | 54,8% |
| Black | +$761.043 | +0,277% | +$4.847 | 61,1% |

### El barrido

| H | Soltados | Gold ret | Gold exp | Gold win | **Δ Gold** | **Δ Plat** | Black ret | Black exp | Black win | **Δ Black** |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 21 | −0,367% | −$6.407 | 46,5% | **+0,057%** | +0,036% | +0,292% | +$5.110 | 56,7% | **+0,015%** |
| 10 | 29 | −0,321% | −$5.615 | 43,9% | **+0,102%** | +0,080% | +0,336% | +$5.867 | 53,5% | **+0,058%** |
| 15 | 35 | −0,304% | −$5.320 | 43,3% | **+0,119%** | +0,092% | +0,343% | +$5.993 | 51,6% | **+0,066%** |
| 20 | 36 | −0,343% | −$5.995 | 41,4% | **+0,081%** | +0,051% | +0,298% | +$5.211 | 50,3% | **+0,021%** |
| 30 | 39 | −0,262% | −$4.585 | 42,0% | **+0,161%** | +0,128% | +0,372% | +$6.495 | 51,6% | **+0,094%** |
| 45 | 35 | −0,304% | −$5.313 | 43,3% | **+0,120%** | +0,085% | +0,328% | +$5.737 | 52,9% | **+0,051%** |
| 60 | 37 | −0,274% | −$4.785 | 44,6% | **+0,150%** | +0,116% | +0,359% | +$6.277 | 53,5% | **+0,082%** |

Todos los H dan delta positivo, en las tres tarifas. **No es monótono en H**
(el mejor es 30, con 20 peor que 15 y 45 peor que 30), lo que ya es una señal de
que lo que se está moviendo no es el horizonte. Y el win rate **baja** en todos
los H respecto del base: se están cortando posiciones que hubieran terminado
ganando. Lo que sube es el promedio, no la proporción de aciertos.

### El corte GRATIS · la señal, separada del costo

Es el corte no implementable de `INFORME-BARRIDO.md` §5: en vez de soltar,
directamente no tener los que quedaron abajo. Sirve para ver si la señal existe
antes de cobrarle la ejecución.

| H | n arriba / abajo | Gold exp arriba | Gold exp abajo | Win arriba / abajo | p (Welch) |
|---:|---:|---:|---:|---:|---:|
| 5 | 136 / 21 | −$4.717 | −$24.814 | 53% / 24% | 0,0616 |
| 10 | 127 / 30 | −$2.220 | −$29.357 | 54% / 27% | **0,0022** |
| 15 | 121 / 36 | −$1.188 | −$28.302 | 56% / 25% | **0,0006** |
| 20 | 120 / 37 | −$1.695 | −$25.923 | 54% / 32% | **0,0030** |
| 30 | 117 / 40 | +$718 | −$31.165 | 56% / 28% | **0,0000** |
| 45 | 121 / 36 | −$211 | −$31.587 | 55% / 28% | **0,0003** |
| 60 | 119 / 38 | +$879 | −$33.348 | 58% / 21% | **0,0000** |

**La señal cruda está, y está fuerte, desde los 10 minutos.** Esto replica
—sobre otra muestra y otra granularidad— el hallazgo del informe anterior: la
suerte del trade se decide temprano y el signo del precio contra el nivel lo
dice. A los 5 minutos todavía no llega a p < 0,05 (0,0616), con sólo 21 trades
del lado de abajo. Del 10 en adelante, p ≤ 0,003 en toda la grilla.

### La partición 30/30 · INDICATIVO, no es walk-forward

Corte por fecha de fill el 14/09/2026 (n = 78 / 79).

| H | 1ª mitad: base → regla (Δ) | 2ª mitad: base → regla (Δ) |
|---:|---|---|
| 5 | −0,300% → −0,240% (+0,060%) | −0,543% → −0,488% (+0,055%) |
| 10 | −0,300% → −0,163% (+0,137%) | −0,543% → −0,474% (+0,069%) |
| 15 | −0,300% → −0,144% (+0,156%) | −0,543% → −0,459% (+0,084%) |
| 20 | −0,300% → −0,158% (+0,141%) | −0,543% → −0,520% (+0,022%) |
| 30 | −0,300% → −0,025% (+0,275%) | −0,543% → −0,490% (+0,052%) |
| 45 | −0,300% → −0,144% (+0,156%) | −0,543% → −0,458% (+0,085%) |
| 60 | −0,300% → −0,044% (+0,256%) | −0,543% → −0,495% (+0,047%) |

El signo aguanta en las dos mitades, pero el tamaño se parte por la mitad o por
un quinto. Con 78 y 79 trades en el mismo mes y medio, y con lo que muestra §6,
esto no prueba estabilidad: prueba que el efecto de calendario está en las dos.

---

## 5. El chequeo de consistencia · H = 60 NO reproduce, y hay que decirlo

`INFORME-BARRIDO.md` §5 midió el corte implementable así: soltar al cierre de la
barra horaria del fill lo que quedó abajo del nivel. Resultado publicado:

| | IS | OOS |
|---|---:|---:|
| Mensual Gold, implementable | **−1,24%** | **−1,20%** |
| Mensual Gold, base | −0,83% | −0,95% |
| Mensual Black, implementable | −0,59% | −0,44% |
| Mensual Black, base | +0,04% | +0,07% |

Acá, con la variante equivalente —veredicto al **cierre de la hora de reloj**,
que es exactamente lo que mide aquel informe, con lag mediano de 23':

| | |
|---|---:|
| Trades soltados | 35 |
| Gold, retorno del conjunto | −0,258% (base −0,424%) → **Δ +0,165%** |
| Black, retorno del conjunto | +0,386% (base +0,277%) → **Δ +0,109%** |

Y el H = 60 de la grilla da **+0,150% en Gold**.

**No reproduce. El signo está al revés.** Las tres razones, en orden de tamaño
probable:

1. **La muestra es otra, y es la razón principal.** 148 de 157 trades son del
   libro **sombra**, o sea señales que el filtro del bot rechaza. El grupo "abajo
   del nivel" acá tiene expectancy Gold de −$25.000 a −$33.000, contra −$18.042
   (IS) y −$22.183 (OOS) del informe anterior: el material a descartar es
   bastante peor, así que descartarlo rinde más.
2. **El modo es aislado, no de cartera.** Acá soltar una posición no libera la
   silla para que entre otra. En `INFORME-BARRIDO.md` el corte se re-simula sobre
   la cartera entera y las entradas que se habilitan al liberar el cupo entran en
   el resultado. Ése es un canal que este anexo no tiene.
3. **El costo de soltar está contado distinto, y es lo que explica el signo.**
   Ver §6: acá la pata que se suelta es intradiaria y por lo tanto **bonificada**
   (0,0605% en vez de 0,6655% en Gold), mientras que el trade base sale días
   después y paga comisión plena. Eso es un regalo de 0,605% del nocional por
   cada trade soltado, y es prácticamente todo el delta.

**Lo que SÍ reproduce es el veredicto, no el nivel.** En los dos informes la
conclusión operativa es la misma: la señal cruda separa (§4 acá, §3 allá) y
ejecutarla no produce nada por encima del azar (§7 acá, §5 allá). Lo que cambia
es que allá el corte quedaba peor que el base y acá queda igual que el nulo.

---

## 6. La descomposición · el delta no es precio, es el calendario de la comisión

Esto es lo que hay que leer dos veces. Para los trades que la regla suelta, se
separa la mejora en dos: cuánto viene del **papel** (bruto, sin comisiones) y
cuánto de la **comisión** (soltar el mismo día hace bonificada la segunda pata).

| H | Δ total Gold | de eso, Δ bruto (el papel) | de eso, Δ comisión | % del delta que es comisión |
|---:|---:|---:|---:|---:|
| 5 | +$156.675 | **+$12.419** | **+$144.257** | **92,1%** |
| 10 | +$280.981 | +$129.989 | +$150.991 | 53,7% |
| 15 | +$327.298 | +$142.992 | +$184.306 | 56,3% |
| 20 | +$221.456 | +$16.097 | +$205.359 | 92,7% |
| 30 | +$442.767 | +$212.854 | +$229.913 | 51,9% |
| 45 | +$328.488 | +$92.556 | +$235.931 | 71,8% |
| 60 | +$411.328 | +$177.791 | +$233.537 | 56,8% |

Entre el 52% y el 93% del delta es comisión ahorrada. Y si se neutraliza esa
ventaja —se le cobra a la pata soltada la comisión plena, como si no fuera del
mismo día, que es la única forma de comparar peras con peras contra un base que
sale días después:

| H | Δ Gold con bonificación | **Δ Gold SIN bonificación** | Δ Black con bonif. | **Δ Black SIN bonif.** |
|---:|---:|---:|---:|---:|
| 5 | +0,057% | **−0,024%** | +0,015% | −0,001% |
| 10 | +0,102% | **−0,006%** | +0,058% | +0,037% |
| 15 | +0,119% | **−0,008%** | +0,066% | +0,040% |
| 20 | +0,081% | **−0,053%** | +0,021% | −0,006% |
| 30 | +0,161% | **+0,026%** | +0,094% | +0,067% |
| 45 | +0,120% | **−0,012%** | +0,085% | +0,024% |
| 60 | +0,150% | **+0,017%** | +0,082% | +0,055% |

**En Gold, sacando el efecto de calendario, el delta es negativo en cinco de los
siete horizontes y no llega a +0,03% en ninguno.** En Black queda apenas
positivo, que es lo esperable: con comisión de 0,1815% por punta, el efecto de
calendario vale poco y lo que queda es el resto del ruido.

Vale la pena anotar aparte lo único útil que sale de acá, porque es real y no
tiene nada que ver con la hipótesis: **cerrar el mismo día vale 0,605% del
nocional en Gold** (0,6655% − 0,0605%). Es una palanca de tarifa, aplica a
cerrar cualquier posición el mismo día, y es del mismo orden que todo el edge
que se viene buscando en cinco informes. Vuelve a apuntar a lo de siempre: la
palanca es la tarifa.

---

## 7. Bloque C · el nulo, obligatorio

En un sistema con expectativa negativa, **soltar posiciones al azar mejora el
resultado por pura aritmética**: se trunca una tenencia que en promedio pierde.
El nulo mide exactamente eso. Para cada H, se sueltan K posiciones —la misma
cantidad que suelta la regla real— elegidas al azar, en un momento al azar
dentro de la misma ventana de 60 minutos. 5.000 sorteos, semilla 20260917, modo
aislado (las mismas piezas que mueve el corte real).

| H | K soltados | Gold real | Mediana del nulo | **Percentil Gold** | p (1 cola) | **Percentil Black** | p (1 cola) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 5 | 21 | −0,367% | −0,342% | **32,7%** | 0,6732 | 23,6% | 0,7638 |
| 10 | 29 | −0,321% | −0,307% | **40,6%** | 0,5940 | 37,7% | 0,6232 |
| 15 | 35 | −0,304% | −0,287% | **39,4%** | 0,6060 | 35,9% | 0,6414 |
| 20 | 36 | −0,343% | −0,279% | **15,9%** | 0,8408 | 12,1% | 0,8792 |
| 30 | 39 | −0,262% | −0,270% | **55,2%** | 0,4478 | 46,6% | 0,5340 |
| 45 | 35 | −0,304% | −0,287% | **39,3%** | 0,6068 | 27,8% | 0,7222 |
| 60 | 37 | −0,274% | −0,276% | **51,8%** | 0,4822 | 40,8% | 0,5924 |

El nulo secundario, que aísla la **selección** de la ventaja genérica de soltar
temprano (mismos K trades al azar, pero soltados exactamente a los H minutos):

| H | Percentil Gold | p | Percentil Black | p |
|---:|---:|---:|---:|---:|
| 5 | 21,8% | 0,7824 | 14,9% | 0,8514 |
| 10 | 40,7% | 0,5928 | 37,6% | 0,6242 |
| 15 | 41,4% | 0,5862 | 37,4% | 0,6256 |
| 20 | 19,6% | 0,8036 | 15,1% | 0,8492 |
| 30 | **59,3%** | 0,4072 | 52,1% | 0,4786 |
| 45 | 36,7% | 0,6334 | 25,0% | 0,7504 |
| 60 | 54,1% | 0,4586 | 43,3% | 0,5668 |

**Ningún H de ninguna tarifa pasa del percentil 60.** El mejor de toda la tabla
es H = 30 en Gold con el nulo de mismo H: percentil 59,3, p = 0,41. Cuatro de
los siete horizontes caen **por debajo** de la mediana del nulo, o sea que
soltar al azar hubiera salido mejor que soltar los que quedaron abajo del nivel.
La mediana del nulo ya está en −0,27% a −0,34% contra el −0,424% del base:
**soltar al azar ya mejora entre 0,08 y 0,15 puntos, que es todo lo que consigue
la regla.**

Esto es, literalmente, el mismo resultado que mató el filtro de volatilidad en
`INFORME-NULO.md` §2, en otro disfraz: lo que se está moviendo es **la perilla de
exposición**, no un detector.

---

## 8. Bloque D · control a 1 minuto · muestra chica, sin conclusiones fuertes

Barras de 1 minuto de los últimos 7 días: 48 símbolos, 122.456 barras,
10/09/2026 13:30 → 18/09/2026 17:49. Submuestra utilizable: **111 trades** de
los 157 (los que caen dentro de la cobertura y tienen 60 minutos de sesión por
delante en la serie de 1m). La confirmación de salida se mantiene en 10 minutos
de reloj, o sea 10 barras.

### Tiempo hasta determinación a 1 minuto · n = 111

| p25 | Mediana | p75 | p90 |
|---:|---:|---:|---:|
| **1'** | **1'** | 9' | 45' |

La mediana cae de 5 minutos a 1. Es lo esperado y confirma lo de §3: el precio se
pone de un lado del nivel casi inmediatamente. Pero la cola no se mueve (p90 de
42' a 45'): el cuarto de trades que oscila alrededor del nivel sigue oscilando
por más fino que se mire.

### El barrido de H a 1 minuto · base Gold −0,129%, Black +0,586%, n = 111

| H | Soltados | Gold ret | **Δ Gold** | **Δ Gold sin bonif.** | **Δ Black** | **Δ Black sin bonif.** | Δ bruto vs Δ comisión |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 13 | −0,018% | +0,111% | **+0,048%** | +0,086% | +0,073% | +$156.198 vs +$62.598 |
| 3 | 14 | −0,109% | +0,020% | **−0,052%** | −0,011% | −0,026% | −$37.608 vs +$76.417 |
| 5 | 14 | −0,034% | +0,095% | **+0,008%** | +0,066% | +0,049% | +$115.964 vs +$71.440 |
| 10 | 12 | +0,006% | +0,135% | **+0,075%** | +0,109% | +0,097% | +$202.694 vs +$63.743 |
| 15 | 21 | −0,114% | +0,015% | −0,086% | −0,034% | −0,055% | −$92.403 vs +$122.761 |
| 30 | 28 | −0,110% | +0,019% | −0,108% | −0,045% | −0,070% | −$119.534 vs +$156.499 |
| 60 | 24 | −0,104% | +0,025% | **−0,089%** | −0,033% | −0,056% | −$93.708 vs +$143.208 |

### El corte gratis a 1 minuto

| H | n arriba / abajo | Gold exp arriba | Gold exp abajo | p (Welch) |
|---:|---:|---:|---:|---:|
| 1 | 98 / 13 | +$1.749 | −$32.763 | **0,0196** |
| 3 | 97 / 14 | +$38 | −$18.443 | 0,1695 |
| 5 | 97 / 14 | +$1.967 | −$31.807 | **0,0086** |
| 10 | 99 / 12 | +$2.405 | −$41.051 | **0,0007** |
| 15 | 90 / 21 | +$1.874 | −$20.154 | **0,0405** |
| 30 | 83 / 28 | +$4.142 | −$21.368 | **0,0089** |
| 60 | 86 / 25 | +$4.182 | −$24.566 | **0,0019** |

### Lo que dice el control, y hasta dónde

**La curva de H no sigue mejorando por debajo de los 5 minutos, ni se aplana:
oscila.** El delta va +0,111% (1') → +0,020% (3') → +0,095% (5') → +0,135%
(10'). Con 12 a 14 posiciones soltadas, un cambio de signo entre horizontes
contiguos es exactamente lo que se espera del ruido. Neutralizada la bonificación
intradiaria, el H = 3 se da vuelta a −0,052% y el H = 15 a −0,086%.

La señal cruda sigue estando a 1 minuto (p = 0,0196 al primer minuto, p = 0,0007
a los 10), lo que refuerza §3: **la información existe casi desde el instante del
fill.** Pero eso ya se sabía a 5 minutos, y la pregunta de este bloque era si
bajar de 5 a 1 agregaba algo cobrable. **Con n = 111, una semana y un solo
régimen, no hay nada acá que permita decir que sí.** No se concluye más.

---

## 9. Deflated Sharpe Ratio · N de 160 a 172

`INFORME.md` contaba 76 configuraciones, `INFORME-RECOMPRA.md` 84,
`INFORME-NULO.md` 100, `INFORME-TIMESTOP.md` 132 e `INFORME-BARRIDO.md` 160.
Este informe agrega **12**: los 7 horizontes de la grilla de 5m, el veredicto
del cierre de la hora de reloj, y los 4 horizontes de la grilla de 1m.
**N = 172.**

σ(SR) se deja en la de `INFORME-BARRIDO.md` (**Gold 5,2149e−2**, **Black
3,7895e−2**). Las 12 configuraciones nuevas corren sobre **otra muestra** —60
días del libro paper, en modo aislado, sin curva de cartera— así que su Sharpe no
está en la misma base y **suman al N pero no a σ**. Está declarado como
aproximación en §10.

El re-deflactado es exacto: al cambiar sólo N cambia sólo el umbral SR₀, y el
resto del estadístico es invariante.

| Corrida (de `INFORME-BARRIDO.md`) | Sharpe Black | DSR Black N=160 | **DSR Black N=172** | DSR Gold N=160 | **DSR Gold N=172** |
|---|---:|---:|---:|---:|---:|
| **control: cerró arriba del nivel / OOS** | +2,64 | 0,9106 | **0,9075** | 0,2386 | **0,2315** |
| solo aguanta (test primario) / OOS | +2,11 | 0,7342 | 0,7281 | 0,0912 | 0,0876 |
| f5 Q1 (bajo) / OOS | +2,09 | 0,7266 | 0,7204 | 0,0691 | 0,0662 |
| control: cerró arriba del nivel / IS | +1,17 | 0,2581 | 0,2513 | 0,0037 | 0,0034 |
| f3 Q1 (bajo) / OOS | +1,04 | 0,2457 | 0,2403 | 0,0066 | 0,0062 |

**El mejor DSR del proyecto baja de 0,911 a 0,9075.** Sigue siendo el mismo
número y la misma advertencia que en `INFORME-BARRIDO.md` §7: es out-of-sample
solo, y describe una cartera que no se puede armar. Ninguna de las 12
configuraciones nuevas de este anexo es candidata a entrar en esa tabla: todas
caen en la mediana del nulo (§7) y su delta desaparece al neutralizar el
calendario de la comisión (§6).

---

## 10. Lo que no está modelado en este informe (y para qué lado tira)

| Aproximación | Efecto |
|---|---|
| Modo aislado: soltar no libera la silla para otra entrada | Deja afuera un canal entero del corte; en `INFORME-BARRIDO.md` §5 ese canal **empeora** el resultado |
| Las 12 configuraciones nuevas suman al N del DSR pero no a σ(SR) | Si entraran, σ(SR) subiría (son carteras de 157 trades sobre 26 ruedas, mucho más dispersas) y el DSR del mejor bajaría **más**: la elección es **conservadora en la dirección de no bajarlo** |
| 40 de 157 trades siguen abiertos al final de la serie y se marcan a mercado | Su desenlace todavía no ocurrió; base y regla comparten la convención, el delta no se ve afectado |
| Se sueltan al cierre exacto de la barra, sin spread ni tick ni profundidad | **Optimista** para la regla; el papel real se vende contra el bid |
| La confirmación anti-fantasma de 150 s de entrada no se simula (el fill lo da el libro) | Igual que en `research/backtest-reglas` |
| La bonificación intradiaria de la segunda pata se aplica tal cual la cobra IOL | Es real; §6 la aísla justamente porque domina el resultado |
| Barras del subyacente en NYSE, no del CEDEAR local | Igual que en `INFORME.md` §7; el CEDEAR puede no tener la misma microestructura en la primera hora |
| El 94% de la muestra es libro sombra (señales que el filtro del bot rechaza) | El bot real no tomaría estos trades; el efecto medido **no** es trasladable directo al bot |
| Una sola ventana de régimen de 36 días, sin walk-forward real | Todo el informe es indicativo por construcción |

---

## 11. Veredicto

**¿Con granularidad más fina la misma variable se vuelve accionable?** **No.**

1. **La variable se determina rapidísimo.** Mediana de **5 minutos** —la primera
   barra posterior al fill— y en el 74,5% de los trades el signo ya no vuelve a
   cambiar en toda la hora. A 1 minuto la mediana baja a 1'. El problema de este
   hallazgo nunca fue la latencia de la observación.
2. **La señal cruda existe y es fuerte.** Del minuto 10 en adelante, la
   expectancy de los que quedaron arriba contra los que quedaron abajo separa con
   p ≤ 0,003 en toda la grilla, y a los 30 y 60 minutos con p < 0,0001. Eso
   confirma, sobre otra muestra y otra granularidad, el hallazgo de
   `INFORME-BARRIDO.md` §3.
3. **Pero ejecutarla no produce nada por encima del azar.** Ningún H de ninguna
   tarifa pasa del percentil 60 contra el nulo; el mejor es 59,3 (p = 0,41) y
   cuatro de siete caen por debajo de la mediana. Soltar al azar mejora tanto
   como soltar los que quedaron abajo del nivel, porque lo que mejora es **bajar
   la exposición en un sistema con expectativa negativa**, no seleccionar.
4. **Y el delta que se ve en la tabla no es precio.** Entre el 52% y el 93% del
   delta es la comisión que se ahorra por cerrar el mismo día. Neutralizado eso,
   el delta en Gold es negativo en cinco de los siete horizontes y no llega a
   +0,03% en ninguno.
5. **H = 60 no reproduce el resultado negativo publicado.** Da +0,150% en Gold
   contra el −1,24%/−1,20% del informe anterior. Reproduce el veredicto (no hay
   mejora atribuible a la señal) pero no el nivel, por muestra (94% libro
   sombra), modo (aislado, sin cartera) y contabilidad de la comisión. **Eso
   debilita todo lo cuantitativo de este anexo** y es la razón por la que acá no
   se propone ninguna regla.
6. **El control de 1 minuto no dice que siga mejorando.** La curva oscila
   (+0,111% / +0,020% / +0,095% / +0,135%) con 12 a 14 posiciones soltadas. Es
   ruido. n = 111, una semana, un régimen.

**¿Justifica pagar por datos de mejor granularidad?** **No.** El cuello de
botella no es la resolución del dato: a 5 minutos ya se tiene el 83-87% de la
información que se tendría a 60, y a 1 minuto la mediana de determinación cae a
un minuto. El cuello de botella es que **lo que se hace con esa información
—soltar una posición— cuesta lo mismo que vale**, y lo poco que sobra no se
distingue de soltar al azar. Comprar datos de 1 minuto pagos, o tick, compraría
precisión sobre una variable que ya se observa bien y que no se puede cobrar.

**Lo único que sigue abierto es lo mismo que dejó `INFORME-BARRIDO.md` §9, y este
anexo lo refuerza:** no filtrar después de comprar, sino **cambiar el tipo de
orden** — no poner la límite en el nivel, sino esperar N minutos y comprar sólo
si el precio quedó arriba. Ahí el edge se ejecuta **una sola vez**, sin la vuelta
extra ni la dependencia del calendario de comisión, a cambio de un precio de
entrada peor. Con lo que se midió acá, ese N sería de **5 a 10 minutos**, no de
una hora: al minuto 5 ya se sabe el 83% y del 10 en adelante la separación es
p ≤ 0,003. **No se testeó en este informe** y no entra en ninguna conclusión —
pero es lo único que la evidencia de estos dos anexos señala como próximo paso, y
no necesita datos más finos que los que ya hay.

**Y la que no cambia.** El único número de este informe que vale plata de verdad
es un efecto de tarifa: cerrar el mismo día ahorra **0,605% del nocional en
Gold**. Es del mismo orden que todo el edge buscado en seis informes, y no
depende de ninguna señal. La palanca sigue siendo la tarifa.

---

*Generado offline el 18/09/2026 sobre `research/backtest-reglas/data` (5m, 52
símbolos, 243.189 barras) y `research/backtest-5y/data-1m` (1m, 48 símbolos,
122.456 barras, bajadas por `bajar1m.js`). Muestra: 157 trades llenados del libro
paper/sombra de `paper_trades_export.json`. Script: `fino.js`. Semilla 20260917,
5.000 sorteos por celda, huella de reproducibilidad FNV-1a `b26f498b` sobre 1.192
números. Detalle completo en `results-fino.json` y `run-fino.log`. Convenciones,
aproximaciones y anti-lookahead en `README.md`, `INFORME.md`, `INFORME-NULO.md`,
`INFORME-TIMESTOP.md` e `INFORME-BARRIDO.md`.*
