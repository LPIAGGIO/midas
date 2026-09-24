# Informe · ¿se llega al 3% mensual entrando más agresivo y más grande?

**La primera línea, sin vueltas: no, y el motivo no es el que suponía la
hipótesis. Entrar más arriba del nivel casi no sirve para llenar más órdenes,
porque el nivel está en promedio 4,4% por debajo del precio: subir el límite un
1% sube la tasa de llenado de 21% a 29% y el edge bruto por operación se cae de
0,360% a 0,135% en el in-sample. El único escalón que llena de verdad es entrar
a mercado (llenado 55-62%), pero eso ya no es "entrar más agresivo en la misma
señal": es otra estrategia, comprar al precio de pantalla. Y la que gana no es
la paciencia: los trades que NUNCA tocaron el nivel rinden +1,75% bruto por
operación y los que sí lo tocaron rinden −1,05%. La premisa del bot está dada
vuelta. Aun así, la mejor celda del in-sample sin apalancamiento —a mercado, 30%
por posición— da 2,23%/mes en el IS y 2,44%/mes en el OOS con drawdowns de 12,7%
y 9,7%, y no llega al 3%. Para llegar hay que apalancarse 2 a 3 veces (y ahí el
drawdown se va a 17-22% y el funding se come un punto por mes) o aceptar un
spread de cero. Con el spread real de los CEDEARs medido en `cedear_fv_log`
—0,25%— la celda elegida baja a 1,26%/mes (IS) y 1,24%/mes (OOS). Y el control
que faltaba en todo el proyecto la deja sin nada: contra estar simplemente
comprado a la misma exposición media, el exceso de la celda elegida es −0,11
puntos en el IS y +0,11 en el OOS, o sea cero. SPY en pesos, sin operar, dio
3,98%/mes en el IS y 4,11%/mes en el OOS.**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS.
Lo único que se consultó en Supabase fue `cedear_fv_log`, de sólo lectura, para
calibrar el spread. Motor, gate y reglas de salida idénticos a `INFORME.md` /
`INFORME-COCOS.md`: lo único que cambia es **cómo se ejecuta la entrada** y
**cuánto se compra**.

---

## 0. Chequeo de consistencia (esto va antes que nada)

La consigna era parar si la celda base no reproducía `INFORME-COCOS`:

| | IS | OOS |
|---|---:|---:|
| Señales emitidas por el gate | 528 | 371 |
| Trades | 111 | 94 |
| Órdenes expiradas a las 48 h | 278 | 197 |
| Mensual Gold | −0,83% | −0,95% |
| Mensual Black | +0,04% | +0,07% |
| **Mensual Cocos** | **+0,26%** | **+0,32%** |
| Max drawdown Cocos | 4,8% | 5,7% |

**56 comparaciones (trades, mensual, P&L total, win rate, payoff, Sharpe y max
drawdown × 4 tarifas × 2 ventanas), 0 descuadres.** El script aborta solo si
aparece uno. Los 528/111/278 del in-sample son exactamente los que motivaron
esta pregunta.

Huella de reproducibilidad: **4.221 números, FNV-1a `78a82c49`**, verificada
corriendo dos veces con la misma semilla (20260917).

---

## 1. El dato que reordena la pregunta: el nivel está 4,4% abajo

Antes de cualquier barrido hay que mirar una sola cifra, que no estaba medida en
ningún informe anterior: **cuánto hay entre el precio del momento de la señal y
el nivel donde el bot pone la orden**. El motor define la entrada como el techo
de la zona de soporte más cercana *por debajo* del spot (`z.hi < spot × 0,999`),
y esa zona vive donde hay pivotes, no donde uno quiera.

La distancia media entre el fill a mercado y el nivel de la orden —que es
exactamente esa brecha— es de **4,4% en el in-sample y 3,8% en el
out-of-sample** (según cuál de las cuatro variantes de mercado se mire, entre
4,11% y 4,44% en el IS y entre 3,76% y 3,88% en el OOS).

Eso explica de un saque dos cosas:

1. **Por qué se llena sólo el 21%.** Para que la orden se ejecute, el papel
   tiene que caer 4,4% en 48 horas. No es que el bot sea tímido: es que pide
   mucho.
2. **Por qué subir el límite 0,25%, 0,50% o 1% casi no cambia nada.** Un
   escalón de 1% sobre una brecha de 4,4% es moverse menos de un cuarto del
   camino. La tasa de llenado sube de 21,0% a 28,6% y ahí se queda.

La escalera que pedía la consigna existe, pero está mal espaciada para este
motor: entre "límite 1% arriba" y "a mercado" hay un abismo de 3,4 puntos de
precio, y ningún punto intermedio interesante.

---

## 2. Bloque A · el barrido de agresividad, llenado y edge lado a lado

Tamaño base (20% por posición, 5 posiciones), sin spread, tarifa Cocos. El
**producto** es `ops/mes × tamaño medio × edge neto por operación`, y reproduce
el retorno mensual al último decimal en las 24 celdas: es la aritmética de la
consigna, verificada.

### 2.1 Con stop y target FIJOS al nivel

| variante | vn | señales | fills | **llenado** | ops/mes | premio | **bruto/op** | neto/op | tam | producto = mensual | win | payoff | Sharpe | maxDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nivel exacto | IS | 528 | 111 | **21,0%** | 5,4 | 0,00% | **0,360%** | 0,239% | 20,0% | **+0,26%** | 38,7% | 1,86 | 0,51 | 4,8% |
| nivel exacto | OOS | 371 | 94 | **25,3%** | 6,5 | 0,00% | **0,372%** | 0,251% | 20,0% | **+0,32%** | 43,6% | 1,57 | 0,65 | 5,7% |
| límite +0,25% | IS | 528 | 120 | 22,7% | 5,9 | 0,24% | 0,159% | 0,038% | 20,0% | +0,05% | 36,7% | 1,77 | 0,11 | 7,1% |
| límite +0,25% | OOS | 371 | 102 | 27,5% | 7,0 | 0,24% | 0,433% | 0,312% | 20,0% | +0,44% | 46,1% | 1,48 | 0,82 | 4,1% |
| límite +0,50% | IS | 528 | 130 | 24,6% | 6,4 | 0,47% | 0,328% | 0,206% | 20,0% | +0,26% | 40,8% | 1,66 | 0,47 | 7,3% |
| límite +0,50% | OOS | 371 | 111 | 29,9% | 7,6 | 0,46% | 0,420% | 0,298% | 20,0% | +0,45% | 46,8% | 1,42 | 0,85 | 3,6% |
| límite +1,00% | IS | 528 | 151 | 28,6% | 7,4 | 0,84% | 0,135% | 0,014% | 20,0% | +0,02% | 41,7% | 1,41 | 0,07 | 10,1% |
| límite +1,00% | OOS | 371 | 124 | 33,4% | 8,5 | 0,85% | 0,345% | 0,224% | 20,0% | +0,38% | 47,6% | 1,29 | 0,66 | 3,8% |
| mercado, cierre de la señal | IS | 528 | 328 | **62,1%** | 16,1 | 4,39% | 0,720% | 0,599% | 18,4% | **+1,78%** | 63,7% | 0,85 | 1,62 | 8,4% |
| mercado, cierre de la señal | OOS | 371 | 247 | **66,6%** | 17,0 | 3,77% | 0,410% | 0,289% | 18,9% | **+0,93%** | 63,6% | 0,71 | 1,18 | 10,8% |
| **mercado, apertura siguiente** | IS | 528 | 324 | **61,4%** | 15,9 | 4,44% | 0,731% | 0,610% | 18,4% | **+1,78%** | 63,9% | 0,85 | 1,65 | 8,6% |
| **mercado, apertura siguiente** | OOS | 371 | 244 | **65,8%** | 16,8 | 3,76% | 0,398% | 0,276% | 18,9% | **+0,88%** | 63,5% | 0,70 | 1,10 | 11,3% |

### 2.2 Con stop y target MÓVILES con la entrada

| variante | vn | fills | llenado | ops/mes | bruto/op | neto/op | mensual | win | payoff | Sharpe | maxDD |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| nivel exacto | IS | 111 | 21,0% | 5,4 | 0,360% | 0,239% | +0,26% | 38,7% | 1,86 | 0,51 | 4,8% |
| nivel exacto | OOS | 94 | 25,3% | 6,5 | 0,372% | 0,251% | +0,32% | 43,6% | 1,57 | 0,65 | 5,7% |
| límite +0,25% | IS | 121 | 22,9% | 5,9 | 0,147% | 0,026% | +0,03% | 38,0% | 1,66 | 0,09 | 6,8% |
| límite +0,25% | OOS | 104 | 28,0% | 7,1 | 0,317% | 0,196% | +0,28% | 46,2% | 1,36 | 0,55 | 4,7% |
| límite +0,50% | IS | 133 | 25,2% | 6,5 | 0,238% | 0,117% | +0,15% | 39,1% | 1,70 | 0,31 | 5,4% |
| límite +0,50% | OOS | 113 | 30,5% | 7,8 | 0,248% | 0,126% | +0,20% | 43,4% | 1,45 | 0,40 | 3,0% |
| límite +1,00% | IS | 156 | 29,5% | 7,7 | 0,252% | 0,131% | +0,20% | 38,5% | 1,76 | 0,38 | 7,5% |
| límite +1,00% | OOS | 128 | 34,5% | 8,8 | 0,222% | 0,101% | +0,18% | 41,4% | 1,53 | 0,33 | 7,2% |
| mercado, cierre de la señal | IS | 298 | 56,4% | 14,6 | 0,829% | 0,708% | **+2,07%** | 40,6% | 2,19 | 1,71 | 7,9% |
| mercado, cierre de la señal | OOS | 264 | 71,2% | 18,1 | 0,542% | 0,420% | **+1,52%** | 42,0% | 1,83 | 1,65 | 8,0% |
| **mercado, apertura siguiente** | IS | 292 | 55,3% | 14,3 | 0,814% | 0,693% | **+1,99%** | 40,8% | 2,15 | 1,65 | 9,9% |
| **mercado, apertura siguiente** | OOS | 265 | 71,4% | 18,2 | 0,496% | 0,374% | **+1,36%** | 41,1% | 1,85 | 1,49 | 9,5% |

### 2.3 Las dos curvas que pedía la consigna

**El llenado sube, sí, pero poquito hasta el escalón de mercado**: 21,0 → 22,7
→ 24,6 → 28,6 → 61,4% (IS). Los tres primeros escalones compran, entre los
tres, **40 trades más en 20 meses** — dos por mes.

**El edge baja, y baja feo en el in-sample**: 0,360 → 0,159 → 0,328 → 0,135%.
No es monótono, y ésa es la primera señal de que estamos mirando ruido: con
9, 19 y 40 trades de diferencia, la caída del bruto por operación oscila sin
orden. En el out-of-sample el mismo barrido **sube** primero (0,372 → 0,433 →
0,420) y después baja (0,345). Las dos ventanas dicen cosas distintas sobre el
mismo escalón.

**Respuesta directa a "¿el edge cae menos que proporcionalmente?":** en el
in-sample, no — cae mucho más que proporcionalmente (el llenado sube 36% y el
edge se cae 63% en el escalón de +1%). En el out-of-sample, cae menos que
proporcionalmente hasta +0,50% y después se da vuelta. **La única lectura
honesta de las dos ventanas juntas es que los tres escalones de límite no
producen nada distinguible del caso base**: el mensual va de +0,26% a +0,02% /
+0,44%, todo dentro del ruido de 100 trades.

Y el escalón de mercado, que sí mueve el amperímetro, hay que leerlo con lo que
viene abajo antes de festejarlo.

---

## 3. Bloque A.bis · de dónde sale el edge, y por qué da vuelta la premisa

Éste es el hallazgo del anexo. Cada trade de las variantes agresivas se puede
partir en dos: los que **igual se hubieran llenado** con el límite en el nivel
exacto (el papel bajó hasta ahí en algún momento de la vida de la posición) y
los que **sólo existen porque pagamos de más**.

Bruto por operación (% del nocional), convención móvil:

| variante | vn | tocó el nivel | n | NO tocó el nivel | n | Welch p |
|---|---|---:|---:|---:|---:|---:|
| límite +0,25% | IS | +0,047% | 117 | **+3,084%** | 4 | 0,028 |
| límite +0,25% | OOS | −0,022% | 95 | **+3,890%** | 9 | <0,0001 |
| límite +0,50% | IS | +0,023% | 123 | **+2,881%** | 10 | 0,0024 |
| límite +0,50% | OOS | −0,347% | 97 | **+3,840%** | 16 | <0,0001 |
| límite +1,00% | IS | −0,293% | 131 | **+3,106%** | 25 | <0,0001 |
| límite +1,00% | OOS | −0,581% | 104 | **+3,690%** | 24 | <0,0001 |
| mercado (apertura) | IS | −1,047% | 98 | **+1,754%** | 194 | <0,0001 |
| mercado (apertura) | OOS | −0,723% | 97 | **+1,202%** | 168 | <0,0001 |

**Las ocho celdas dicen lo mismo, en las dos ventanas, con p < 0,05: el trade
que terminó bajando al nivel es el trade malo.** El que nunca lo tocó —el que
subió desde el primer minuto— es el que paga.

Esto no es un descubrimiento nuevo del proyecto, es el mismo de siempre con
otra ropa. `INFORME-BARRIDO.md` §4 ya había encontrado que "la barra del fill
cerró arriba del nivel" separaba mejor que cualquier otra variable
(p ≈ 0,0005 pooled) y `INFORME-COCOS.md` §4.3 lo confirmó con la tarifa nueva.
Acá aparece **en el momento de decidir el tipo de orden**, que es justamente el
lugar donde los dos informes anteriores decían que había que probarlo y nunca
se probó.

Pero ojo con la tentación, porque es una trampa conocida: **"el que no tocó el
nivel" no es una variable que se pueda usar para elegir**. Se sabe después. Lo
único que se puede hacer con ella es lo que hace este barrido: **comprar
siempre, a mercado, sin esperar a que baje** — que es cambiar la señal por su
opuesto. Y eso deja de ser el bot de niveles.

La mecánica es puro sentido común una vez que se ve: comprar un soporte con
paciencia significa, por construcción, **quedarse sólo con los papeles que
están cayendo**, y quedarse afuera de los que se van para arriba. Es selección
adversa por diseño. El mismo mecanismo que `INFORME-RECOMPRA.md` midió en el
retroceso al nivel de entrada (la probabilidad de terminar en stop pasaba de
13,8% a 37,5%), acá aplicado a la entrada original.

---

## 4. Bloque B · stop y target, fijos al nivel o móviles con la entrada

Criterio fijado antes de mirar el OOS: gana la convención con mayor **retorno
mensual promedio en el in-sample** sobre las cinco variantes que no son el caso
base (en el base las dos coinciden por construcción: el fill es el nivel, así
que las distancias relativas son las mismas).

| variante | vn | fijo | móvil | Δ (móvil − fijo) |
|---|---|---:|---:|---:|
| límite +0,25% | IS | +0,05% | +0,03% | −0,01 |
| límite +0,25% | OOS | +0,44% | +0,28% | −0,16 |
| límite +0,50% | IS | +0,26% | +0,15% | −0,11 |
| límite +0,50% | OOS | +0,45% | +0,20% | −0,26 |
| límite +1,00% | IS | +0,02% | +0,20% | +0,18 |
| límite +1,00% | OOS | +0,38% | +0,18% | −0,20 |
| mercado (cierre) | IS | +1,78% | +2,07% | +0,29 |
| mercado (cierre) | OOS | +0,93% | +1,52% | +0,60 |
| mercado (apertura) | IS | +1,78% | +1,99% | +0,20 |
| mercado (apertura) | OOS | +0,88% | +1,36% | +0,48 |

**Promedio del IS: fijo +0,78%, móvil +0,89% → domina MÓVIL**, y todo lo que
sigue usa esa convención. Pero el número promedio esconde la estructura, que es
la parte interesante y es la que hay que contarle a LP:

- **Con premios chicos (0,25% y 0,50%) domina FIJO**, en las dos ventanas. Tiene
  sentido: mover el stop 0,25% arriba no lo mejora, lo saca del lugar donde hay
  pivotes y compradores. El R:R apenas se degrada por pagar un cuarto de punto,
  así que conviene dejar el kit donde lo puso el motor.
- **Con entrada a mercado domina MÓVIL, y por mucho** (+0,20 a +0,60 puntos, las
  cuatro celdas). También tiene sentido: con un premio de 4,4%, dejar el stop en
  el nivel original convierte el trade en "stop de 6%, target de 1%" — win rate
  63,7% y payoff 0,85, que es juntar monedas adelante de la topadora. El stop
  móvil devuelve un R:R sano (win 40,8%, payoff 2,15).

**El corte está en el tamaño del premio, no en la convención.** La regla
defendible que sale de acá: *si se paga menos de medio punto por encima del
nivel, el kit se queda quieto; si se entra a mercado, el kit tiene que
recalcularse entero sobre el precio de entrada.* Eso también es un aviso: la
convención "móvil" con entrada a mercado ya no usa los pivotes para nada — el
stop pasa a ser un porcentaje, no un nivel.

---

## 5. Bloque A.ter · el control que faltaba · ¿alpha o beta?

Toda variante que sube la tasa de llenado sube, con ella, la **exposición
media** — la fracción del capital que está efectivamente comprada. El caso base
está comprado el 10% del tiempo-capital; la variante de mercado, el 47%. Con
una ventana en la que estar comprado pagaba muchísimo, comparar esas dos cosas
por su retorno mensual sin normalizar es hacer trampa.

El benchmark, medido sobre las mismas series y en pesos (precio USD × CCL):

| | IS (20,4 meses) | OOS (14,6 meses) |
|---|---|---|
| **SPY en pesos, comprar y no tocar** | +81,1% → **+3,98%/mes** (maxDD 26,8%, Sharpe 1,14) | +59,9% → **+4,11%/mes** (maxDD 13,6%, Sharpe 1,92) |
| Mediana de los 38 papeles | +91,3% → +4,48%/mes | +59,9% → +4,11%/mes |
| Media equiponderada de los 38 | +190,5% → +9,35%/mes | +126,6% → +8,70%/mes |
| Índice equiponderado, rebalanceo diario | +155,0% → +7,61%/mes (maxDD 25,9%, Sharpe 1,58) | +100,1% → +6,88%/mes (maxDD 12,3%, Sharpe 2,48) |

Se usa **SPY en pesos como benchmark primario** porque es el más conservador de
los tres: la media equiponderada la inflan MSTR (+1.374%) y compañía, y la
mediana queda en el medio.

Ahora la tabla que importa. "SPY·expo" es lo que hubiera dado tener esa misma
exposición media parada en SPY-en-pesos, sin operar nunca:

| variante | vn | mensual | expo media | SPY·expo | **exceso** |
|---|---|---:|---:|---:|---:|
| nivel exacto | IS | +0,26% | 0,10 | +0,41% | **−0,15%** |
| nivel exacto | OOS | +0,32% | 0,10 | +0,40% | **−0,07%** |
| límite +0,25% | IS | +0,03% | 0,12 | +0,47% | −0,43% |
| límite +0,25% | OOS | +0,28% | 0,12 | +0,48% | −0,20% |
| límite +0,50% | IS | +0,15% | 0,13 | +0,50% | −0,35% |
| límite +0,50% | OOS | +0,20% | 0,12 | +0,51% | −0,31% |
| límite +1,00% | IS | +0,20% | 0,14 | +0,56% | −0,36% |
| límite +1,00% | OOS | +0,18% | 0,14 | +0,59% | −0,41% |
| mercado (cierre) | IS | +2,07% | 0,47 | +1,86% | +0,20% |
| mercado (cierre) | OOS | +1,52% | 0,43 | +1,76% | −0,23% |
| mercado (apertura) | IS | +1,99% | 0,47 | +1,87% | +0,11% |
| mercado (apertura) | OOS | +1,36% | 0,43 | +1,76% | −0,40% |

**Doce celdas, once negativas.** Ninguna variante de entrada, en ninguna
ventana, le gana de forma estable a estar comprado en el índice a la misma
exposición. El caso base del bot —el que corre hoy— produce **menos** que
dejar el 10% del capital parado en SPY-CEDEAR y no mirar la pantalla.

Esto generaliza lo que `INFORME-COCOS.md` §3 ya había dicho con el CCL ("el
mismo carry lo consigue LP comprando el CEDEAR y no tocándolo") y lo extiende a
la parte de renta variable: **no es sólo el dólar, es el activo entero.** El bot
de niveles, tal como está, es un mecanismo caro para tener una fracción chica de
exposición a algo que subía.

La advertencia, que es grande y va con todas las letras: **el benchmark es un
solo camino realizado en un período muy particular** (devaluación del peso más
mercado americano en subida). No es una ley; es la vara correcta *para estas
dos ventanas*, que son las mismas dos ventanas en las que se mide el bot. Y
tiene su propio drawdown: 26,8% en el IS para SPY en pesos, contra 4,8% del bot.
Nadie dice que sea la misma cosa de riesgo; se dice que a igual exposición, el
bot no agrega retorno.

---

## 6. Bloque C · barrido de tamaño, exposición y apalancamiento

Agresividad base (nivel exacto), convención móvil, sin spread, **con
apalancamiento permitido** (el tope de caja se levanta hasta `cap × posiciones`
para poder medir cuánto haría falta).

**IN-SAMPLE**

| cap | pos | n | mensual | maxDD | **expo máx** | expo media | **apal. requerido** | ¿sin apalancar? | mensual neto de funding |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 20% | 3 | 88 | +0,01% | 5,4% | 0,60 | 0,08 | — | **sí** | +0,01% |
| 20% | 5 | 111 | +0,26% | 4,8% | 0,70 | 0,10 | — | **sí** | +0,26% |
| 20% | 8 | 120 | +0,40% | 4,9% | 0,70 | 0,11 | — | **sí** | +0,40% |
| 20% | 10 | 120 | +0,40% | 4,9% | 0,70 | 0,11 | — | **sí** | +0,40% |
| 30% | 5 | 111 | +0,39% | 7,0% | 1,05 | 0,15 | — | **sí** | +0,39% |
| 30% | 8 | 120 | +0,54% | 7,0% | 1,05 | 0,16 | — | **sí** | +0,54% |
| 40% | 5 | 111 | +0,51% | 9,2% | 1,40 | 0,20 | **1,40x** | no | +0,51% |
| 40% | 8 | 120 | +0,67% | 8,8% | 1,40 | 0,21 | **1,40x** | no | +0,67% |
| 50% | 5 | 111 | +0,65% | 11,2% | 1,75 | 0,25 | **1,75x** | no | +0,63% |
| 50% | 8 | 120 | +0,82% | 10,6% | 1,75 | 0,26 | **1,75x** | no | +0,80% |
| 60% | 5 | 111 | +0,78% | 13,0% | 2,07 | 0,29 | **2,07x** | no | +0,73% |
| 60% | 8 | 120 | +0,96% | 12,3% | 2,07 | 0,31 | **2,07x** | no | +0,90% |

**OUT-OF-SAMPLE** (mismo patrón, números un poco mejores)

| cap | pos | n | mensual | maxDD | expo máx | apal. req. | mensual neto de funding |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 20% | 5 | 94 | +0,32% | 5,7% | 0,70 | — | +0,32% |
| 30% | 5 | 94 | +0,49% | 8,2% | 1,05 | — | +0,48% |
| 40% | 5 | 94 | +0,62% | 10,9% | 1,40 | 1,40x | +0,61% |
| 50% | 5 | 94 | +0,83% | 12,3% | 1,75 | 1,75x | +0,80% |
| 60% | 5 | 94 | +1,11% | 12,7% | 2,10 | 2,10x | +1,05% |
| 60% | 8 | 96 | +1,16% | 12,4% | 2,17 | 2,17x | +1,10% |

Lo que hay que leer acá:

1. **El tamaño escala casi lineal, y el drawdown también.** De 20% a 60% el
   mensual se multiplica por 3 (0,26 → 0,78) y el drawdown por 2,7 (4,8 → 13,0).
   No hay nada gratis en la perilla de tamaño: es la misma curva de equity
   multiplicada.
2. **La advertencia de la consigna se confirma y es peor de lo que parecía.**
   Con 5 posiciones y 40% por posición hace falta **1,40x**; con 60%, **2,07x**
   (IS) y **2,10x** (OOS). El techo teórico sería 200% y 300%, pero la
   exposición real nunca llega ahí porque rara vez hay cinco posiciones abiertas
   al mismo tiempo: el llenado del 21% no da para tanto. **La exposición máxima
   observada es el número que hay que usar, no el teórico.**
3. **El tope de posiciones interactúa poco arriba de 5 y mucho abajo.** Bajar a
   3 posiciones destruye el resultado (de +0,26% a +0,01% en el IS): el freno
   corta justo las señales que valían. Subir de 5 a 8 mejora 0,14 puntos y de 8
   a 10 no cambia **nada** (las mismas 120 operaciones): con este llenado, el
   contador de 5 posiciones muerde poco y el de 8 no muerde nunca.
4. **El funding del apalancamiento está reportado aparte y no está cobrado en
   el P&L.** A la tasa de la caución tomadora all-in de `INFORME-COCOS.md` §6
   (0,069% por día corrido sobre la parte de la exposición que excede el
   capital), las celdas de 60% pagan 0,05-0,06 puntos mensuales acá y **más de
   un punto** en las celdas de mercado del bloque D.

---

## 7. Bloque D · la grilla combinada

Agresividad × tamaño, 5 posiciones, convención móvil, sin spread, tarifa Cocos.
`*` = llega o supera 3%/mes. `^` = necesita apalancamiento (exposición bruta
máxima observada > 105% del capital).

### 7.1 CON apalancamiento permitido

**IS** · retorno mensual (max drawdown)

| variante | 20% | 30% | 40% | 50% | 60% |
|---|---:|---:|---:|---:|---:|
| nivel exacto | 0,26 (4,8) | 0,39 (7,0) | 0,51 (9,2)^ | 0,65 (11,2)^ | 0,78 (13,0)^ |
| límite +0,25% | 0,03 (6,8) | 0,05 (9,8) | 0,05 (12,8)^ | 0,06 (15,4)^ | 0,07 (17,9)^ |
| límite +0,50% | 0,15 (5,4) | 0,23 (7,7) | 0,29 (10,2)^ | 0,40 (11,5)^ | 0,52 (12,5)^ |
| límite +1,00% | 0,20 (7,5) | 0,25 (10,8)^ | 0,28 (13,9)^ | 0,37 (16,3)^ | 0,50 (17,9)^ |
| mercado (cierre) | 2,07 (7,9) | **\*3,02** (11,5)^ | **\*3,93** (14,4)^ | **\*4,76** (15,9)^ | **\*5,34** (17,1)^ |
| mercado (apertura) | 1,99 (9,9) | 2,89 (14,2)^ | **\*3,76** (17,7)^ | **\*4,56** (19,6)^ | **\*5,06** (21,5)^ |

**OOS** · retorno mensual (max drawdown)

| variante | 20% | 30% | 40% | 50% | 60% |
|---|---:|---:|---:|---:|---:|
| nivel exacto | 0,32 (5,7) | 0,49 (8,2) | 0,62 (10,9)^ | 0,83 (12,3)^ | 1,11 (12,7)^ |
| límite +0,25% | 0,28 (4,7) | 0,47 (6,2) | 0,63 (7,6)^ | 0,86 (8,5)^ | 1,15 (8,5)^ |
| límite +0,50% | 0,20 (3,0) | 0,29 (4,4) | 0,34 (6,2)^ | 0,47 (7,8)^ | 0,65 (9,2)^ |
| límite +1,00% | 0,18 (7,2) | 0,30 (10,1)^ | 0,36 (12,9)^ | 0,50 (15,1)^ | 0,73 (16,4)^ |
| mercado (cierre) | 1,52 (8,0) | 2,07 (11,1)^ | 2,68 (13,8)^ | **\*3,34** (15,9)^ | **\*3,91** (17,9)^ |
| mercado (apertura) | 1,36 (9,5) | 1,83 (13,4)^ | 2,36 (16,7)^ | 2,92 (19,3)^ | **\*3,39** (21,6)^ |

### 7.2 SIN apalancamiento (exposición tope 100% del capital)

**IS**

| variante | 20% | 30% | 40% | 50% | 60% |
|---|---:|---:|---:|---:|---:|
| nivel exacto | 0,26 (4,8) | −0,03 (8,4) | −0,17 (10,9) | −0,18 (12,6) | −0,28 (13,8) |
| límite +0,25% | 0,03 (6,8) | −0,40 (14,3) | −0,56 (16,7) | −0,41 (15,1) | −0,63 (18,6) |
| límite +0,50% | 0,15 (5,4) | −0,31 (13,7) | −0,54 (17,4) | −0,45 (17,8) | −0,66 (21,9) |
| límite +1,00% | 0,20 (7,5) | −0,16 (14,2) | −0,30 (17,3) | −0,22 (19,7) | −0,35 (23,9) |
| mercado (cierre) | 2,07 (7,9) | **2,27** (11,5) | 1,99 (16,7) | 1,95 (17,2) | 1,97 (16,4) |
| mercado (apertura) | 1,99 (9,9) | **2,23** (12,7) | 2,10 (14,6) | 2,01 (18,0) | 1,76 (18,2) |

**OOS**

| variante | 20% | 30% | 40% | 50% | 60% |
|---|---:|---:|---:|---:|---:|
| nivel exacto | 0,32 (5,7) | 0,54 (6,9) | 0,22 (9,8) | −0,08 (12,1) | −0,32 (14,3) |
| límite +0,25% | 0,28 (4,7) | 0,57 (4,7) | 0,32 (5,6) | 0,08 (6,8) | −0,11 (8,2) |
| límite +0,50% | 0,20 (3,0) | 0,09 (4,5) | −0,27 (7,7) | −0,53 (11,0) | −0,74 (13,6) |
| límite +1,00% | 0,18 (7,2) | 0,38 (8,9) | 0,01 (10,4) | −0,50 (12,1) | −0,76 (14,9) |
| mercado (cierre) | 1,52 (8,0) | 2,50 (8,5) | 2,72 (10,0) | **\*3,05** (9,6) | 2,98 (9,9) |
| mercado (apertura) | 1,36 (9,5) | 2,44 (9,7) | 2,67 (10,2) | 2,96 (10,0) | **\*3,11** (10,1) |

### 7.3 Las celdas que llegan a 3%, y qué cuesta sostenerlas

| celda | mensual | apal. máx | apal. medio | funding | **neto de funding** | maxDD |
|---|---:|---:|---:|---:|---:|---:|
| mercado(cierre) 60% · IS | 5,34% | 2,75x | 1,22 | 1,02% | 4,31% | 17,1% |
| mercado(apertura) 60% · IS | 5,06% | 2,75x | 1,22 | 1,03% | 4,03% | 21,5% |
| mercado(cierre) 50% · IS | 4,76% | 2,45x | 1,07 | 0,73% | 4,03% | 15,9% |
| mercado(apertura) 50% · IS | 4,56% | 2,45x | 1,07 | 0,73% | 3,83% | 19,6% |
| mercado(cierre) 40% · IS | 3,93% | 2,00x | 0,89 | 0,42% | 3,51% | 14,4% |
| mercado(cierre) 60% · OOS | 3,91% | 3,00x | 1,15 | 0,89% | 3,02% | 17,9% |
| mercado(apertura) 40% · IS | 3,76% | 2,00x | 0,89 | 0,42% | 3,34% | 17,7% |
| mercado(apertura) 60% · OOS | 3,39% | 3,00x | 1,16 | 0,91% | 2,48% | 21,6% |
| mercado(cierre) 50% · OOS | 3,34% | 2,50x | 1,00 | 0,60% | 2,74% | 15,9% |
| **mercado(apertura) 60% · OOS, sin apalancar** | 3,11% | 1,00x | 0,64 | 0,00% | **3,11%** | 10,1% |
| **mercado(cierre) 50% · OOS, sin apalancar** | 3,05% | 1,00x | 0,63 | 0,00% | **3,05%** | 9,6% |
| mercado(cierre) 30% · IS | 3,02% | 1,50x | 0,68 | 0,12% | 2,89% | 11,5% |

**Doce celdas de 120 llegan a 3%. Diez necesitan apalancamiento de 1,5x a 3x, y
las dos que no lo necesitan son las dos que aparecen SÓLO en el out-of-sample**
— o sea, las dos que no se podían elegir mirando el in-sample. En el in-sample,
**ninguna celda sin apalancamiento llega a 3%**: el máximo es 2,27%.

Y hay que decir el detalle incómodo de la mitad de abajo de la grilla: **sin
apalancamiento, agrandar la posición EMPEORA casi todo.** Con el tope de caja
en 100%, poner 40% o 60% en un papel significa que el segundo o el tercero ya
no entran, así que se cambian cinco posiciones chicas por dos grandes: menos
diversificación, mismo edge, más varianza. En el caso base del IS pasa de
+0,26% a −0,28%. **El tamaño sólo paga si viene con plata prestada.**

---

## 8. Bloque E · walk-forward estricto y modelos nulos

### 8.1 La elección, hecha mirando sólo el in-sample

Criterio **pre-declarado en el código antes de correr el OOS**: la celda con
mayor mensual neto en Cocos del in-sample, entre las alcanzables sin
apalancamiento (exposición bruta máxima ≤ 105% del capital — el margen de cinco
puntos es porque un fill a mercado se ejecuta a un precio distinto del que
reservó la orden), con al menos 30 trades, desempate por menor drawdown.
Se excluye `mercado (cierre)` de las candidatas: es la versión optimista del
fill a mercado —asume ejecución instantánea al cierre de la barra que generó la
señal— y la consigna manda quedarse con la pesimista.

**Ganadora del IS: entrada a mercado en la apertura de la barra siguiente,
stop/target móviles, 30% por posición, 5 posiciones, sin apalancar.**

### 8.2 El out-of-sample, corrido una vez y sin retocar

| | IS | OOS |
|---|---:|---:|
| Trades | 294 | 261 |
| Tasa de llenado | 55,7% | 70,4% |
| Operaciones por mes | 14,4 | 17,9 |
| Tamaño medio | 26,7% | 26,7% |
| Bruto por operación | 0,700% | 0,631% |
| Neto por operación | 0,578% | 0,509% |
| **Retorno mensual** | **+2,23%** | **+2,44%** |
| Win rate | 40,1% | 41,8% |
| Payoff | 2,08 | 1,97 |
| Sharpe | 1,45 | 1,99 |
| **Max drawdown** | **12,7%** | **9,7%** |
| Exposición bruta máxima | 1,00 | 1,00 |
| Exposición bruta media | 0,59 | 0,57 |
| Benchmark SPY a la misma exposición | +2,34% | +2,33% |
| **Exceso sobre el benchmark** | **−0,11%** | **+0,11%** |
| Base de referencia (20%, nivel) | +0,26% | +0,32% |

**La celda elegida no se desploma en el out-of-sample: mejora levemente
(+2,23% → +2,44%).** Eso hay que decirlo porque es lo que pasó, y es el único
resultado de todo el proyecto donde una configuración elegida en el IS aguanta
en el OOS con esta magnitud. Pero no llega al 3% en ninguna de las dos ventanas,
y el exceso sobre estar comprado a la misma exposición es **cero con signo
cambiante**.

La celda ganadora sin restricción de apalancamiento (mercado, 60%, 2,75x) da
+5,06%/mes en el IS y **+3,39% en el OOS, que baja a +2,48% cobrando el
funding**, con drawdowns de 21,5% y 21,6% y un exceso sobre el benchmark de
+0,18 y **−1,37** puntos. Ésa sí se desinfla afuera de la muestra.

### 8.3 Los nulos (5.000 sorteos, semilla 20260917)

**Nulo 1 · selección de órdenes.** La variante elegida llena K de las N señales
emitidas. El nulo llena K señales **elegidas al azar** entre las N, a mercado, con
el mismo tamaño y la misma cartera. Contesta: ¿las que el llenado eligió son
mejores que cualquier K?

| | K / N | real | mediana del nulo | percentil | p (una cola) | p5 – p95 |
|---|---:|---:|---:|---:|---:|---|
| IS | 294 / 528 | +2,23% | +1,97% | **66,9%** | **0,331** | +0,98 a +2,88 |
| OOS | 261 / 371 | +2,44% | +1,61% | **94,7%** | **0,053** | +0,72 a +2,45 |

**En el in-sample no le gana al azar.** Elegir 294 señales al voleo y comprarlas
a mercado da lo mismo. En el out-of-sample queda al filo (p = 0,053) y no cruza.

**Nulo 2 · exposición.** ¿Le gana al caso base corrido con la misma exposición
media? Es la perilla que mató al filtro de volatilidad en `INFORME.md` §10,
ahora del lado de arriba.

| | expo media de la elegida | el base más parecido | su expo | su mensual | su maxDD | Δ |
|---|---:|---|---:|---:|---:|---:|
| IS | 0,59 | cap 116% | 0,37 | +0,91% | 19,2% | **+1,32 pp** |
| OOS | 0,57 | cap 110% | 0,36 | +2,02% | 11,8% | **+0,42 pp** |

Dos cosas. La primera: **el caso base no puede alcanzar la exposición de la
variante agresiva ni agrandando la posición hasta el 116% del capital.** Se
queda en 0,37 contra 0,59, porque no tiene con qué: con el 21% de llenado no hay
suficientes órdenes que se ejecuten. Ése es, en una línea, el argumento entero a
favor de entrar más agresivo — y es un argumento sobre exposición, no sobre
selección. La segunda: forzando esa comparación imperfecta, la ventaja de la
agresiva es de 1,32 puntos en el IS y sólo **0,42** en el OOS, y en el OOS el
base apalancado ya da +2,02%/mes.

**Nulo 3 · bootstrap de bloques** (bloques de 10 ruedas) sobre la diferencia
diaria de equity contra el caso base:

| | Δ real | IC 90% | p(Δ ≤ 0) |
|---|---:|---|---:|
| IS | +1,97 pp/mes | **−0,47 a +4,16** | 0,101 |
| OOS | +2,11 pp/mes | **−0,06 a +4,43** | 0,055 |

**El intervalo de confianza del 90% incluye el cero en las dos ventanas.** La
mejora es grande en magnitud y no distinguible de cero en significancia, que es
lo que corresponde a 294 trades muy correlacionados entre sí (hasta cinco
posiciones abiertas del mismo mercado al mismo tiempo).

---

## 9. Bloque F · el spread del CEDEAR

### 9.1 Calibración con datos reales

`cedear_fv_log` (Supabase, consulta de sólo lectura): 1.750.080 filas, 209
CEDEARs, del 09/06 al 18/09/2026, con `c_bid` y `c_ask` del CEDEAR local.
Horquilla media `(ask − bid) / mid` de los papeles del universo de 38:

| | |
|---|---|
| Los más líquidos | MU 0,158% · META 0,169% · MSFT 0,170% · NVDA 0,179% · MELI 0,180% · GOOGL 0,188% · MCD 0,191% · TSLA 0,195% · VIST 0,195% · AAPL 0,196% |
| El pelotón | UBER 0,198% · ORCL 0,218% · V 0,220% · PLTR 0,226% · IBM 0,231% · KO 0,232% · AMZN 0,232% · HPQ 0,241% · NFLX 0,246% · AMD 0,255% · AVGO 0,261% · MSTR 0,262% |
| Los caros | WMT 0,292% · ADBE 0,295% · INTC 0,310% · COIN 0,360% · VST 0,376% · XOM 0,386% · QCOM 0,431% · HUT 0,443% · MRVL 0,453% · MRNA 0,869% · JNJ 0,969% |

**Media ponderada por cantidad de observaciones ≈ 0,25%.** Ése es el caso
central; 0,10% describe sólo a los cinco más líquidos y 0,50% es el escenario
pesimista o de papel poco operado.

### 9.2 El supuesto de cómo se cobra

Se paga **media horquilla en cada punta que cruza**:

- **La salida cruza siempre.** El stop se vende contra el bid y el target contra
  lo que haya. `INFORME.md` §7 ya marcaba que no modelar esto hacía el backtest
  optimista; acá por fin está cuantificado.
- **La entrada cruza sólo si la orden es marketable**: a mercado siempre, y en
  las variantes de límite sólo cuando el límite queda por encima del último
  precio conocido (algo que con el nivel exacto no pasa nunca, porque el nivel
  está por definición debajo del spot).

Con ese supuesto, una límite pasiva en el nivel **no** paga spread de entrada
—está del lado del bid, la cruzan a uno— y entrar a mercado paga la mitad de la
horquilla entera. Es el supuesto que menos castiga a las variantes agresivas
frente al base; si fuera al revés, el resultado sería peor todavía para ellas.

### 9.3 El barrido

Retorno mensual neto en Cocos:

| | spread 0% | 0,10% | **0,25% (calibrado)** | 0,50% |
|---|---:|---:|---:|---:|
| base (nivel, 20%) · IS | +0,26% | +0,21% | **+0,12%** | −0,01% |
| base (nivel, 20%) · OOS | +0,32% | +0,26% | **+0,16%** | −0,00% |
| **elegida (mercado, 30%) · IS** | +2,23% | +1,84% | **+1,26%** | +0,29% |
| **elegida (mercado, 30%) · OOS** | +2,44% | +1,96% | **+1,24%** | +0,04% |
| mejor con apalancamiento (mercado, 60%) · IS | +5,06% | +4,24% | **+3,01%** | +0,96% |
| mejor con apalancamiento (mercado, 60%) · OOS | +3,39% | +2,36% | **+0,82%** | −1,76% |

**El spread se lleva casi la mitad de la celda elegida y, en el
out-of-sample, casi toda la celda apalancada.** Con el 0,25% calibrado sólo
queda una celda en 3%: la de 60% con 2,75x de apalancamiento en el in-sample,
que en el out-of-sample da +0,82%. El caso base en Cocos, que INFORME-COCOS
dejaba en +0,26/+0,32, pasa a **+0,12/+0,16** — la mitad del resultado
publicado era spread que no estaba modelado. A 0,50% el caso base es cero.

Esto es la confirmación numérica de lo que `INFORME-COCOS.md` §6 avisaba: *"al
sacar la comisión de broker, el costo que queda sin medir (spread del CEDEAR
local + ejecución manual) pasa a ser del mismo orden que todo lo que sí se
mide"*. Es exactamente del mismo orden: 0,25% de spread contra 0,121% de
comisión, o sea el doble.

---

## 10. Bloque G · Deflated Sharpe Ratio

`INFORME-COCOS.md` dejó el conteo en **N = 174**. Este anexo agrega **150
configuraciones genuinamente nuevas**: cada combinación distinta de (variante de
entrada × convención de stop/target × tope por posición × tope de posiciones ×
permiso de apalancamiento × ventana), deduplicada. **N = 324.** Versión
paranoica (una mirada por tarifa): **496.**

Lo que **no** entra en el N, y por qué: los 5.000 sorteos de cada nulo (son la
distribución de referencia, no candidatas), las corridas de calibración del nulo
de exposición (73 valores de `cap` barridos para igualar una exposición, no para
elegir una estrategia) y el barrido de spread (el spread es un dato del mercado,
no un grado de libertad buscado en los datos — la misma convención con la que el
proyecto no cuenta las tarifas).

σ(SR) de Cocos: **3,6559e−2** publicado (reconstruido en `INFORME-COCOS.md`
sobre 160 variantes) y **4,3712e−2** calculado sobre las 150 celdas nuevas de
este anexo. Se reporta el DSR con las dos, sin elegir: la primera es la del
proyecto, la segunda es la que corresponde a la dispersión real del barrido
nuevo y castiga más.

| Corrida | n | Sharpe | DSR con N=174 | **DSR con N=324** | con σ nuevo | paranoico (N=496) |
|---|---:|---:|---:|---:|---:|---:|
| base 20%/5 · IS | 111 | +0,51 | 0,0823 | **0,0616** | 0,0242 | 0,0505 |
| base 20%/5 · OOS | 94 | +0,65 | 0,1480 | **0,1199** | 0,0607 | 0,1037 |
| **elegida (mercado, 30%) · IS** | 294 | +1,45 | 0,4302 | **0,3675** | 0,2109 | 0,3283 |
| **elegida (mercado, 30%) · OOS** | 261 | +1,99 | 0,6802 | **0,6318** | 0,4846 | 0,5991 |
| mejor con apalancamiento (60%) · IS | 292 | +1,63 | 0,5315 | **0,4653** | 0,2872 | 0,4225 |
| mejor con apalancamiento (60%) · OOS | 265 | +1,51 | 0,4700 | **0,4184** | 0,2810 | 0,3853 |

**Ninguno llega a 0,95.** El mejor de todo el anexo es la celda elegida en el
out-of-sample, con DSR 0,632 — el DSR más alto que produjo hasta hoy una cartera
que se puede armar de verdad (el récord anterior era 0,336, los 50 papeles en
Cocos en el in-sample). Sigue estando lejos del umbral, y el castigo por
multiplicidad no es cosmético: pasar de 174 a 324 miradas le saca 5 puntos de
DSR a esa misma corrida (0,680 → 0,632), y usar el σ del barrido nuevo le saca
15 más (0,485). **Sin maquillar: después de descontar que el proyecto probó 324
cosas, la probabilidad de que ese Sharpe de 1,99 sea de verdad mayor que cero
está entre el 48% y el 63%.**

---

## 11. Lo que no está modelado (además de todo lo de `INFORME.md` §7)

| Aproximación | Efecto |
|---|---|
| El fill a mercado "al cierre de la barra de la señal" asume ejecución instantánea | **Optimista.** Por eso es la variante que se excluye de la elección y se reporta sólo como cota superior. La pesimista (apertura de la barra siguiente) es la que manda |
| Las órdenes límite se llenan AL LÍMITE aunque la barra haya abierto más abajo | **Pesimista**, y es la misma convención del caso base, así que la comparación es limpia |
| El funding del apalancamiento no está cobrado en la grilla | **Optimista en las celdas apalancadas.** Se reporta aparte, a 0,069%/día corrido: hasta 1,03 puntos mensuales en las celdas de 60% |
| El spread está modelado como media horquilla por punta que cruza, con horquilla fija | Simplificación. La horquilla real se ensancha justo cuando uno quiere salir corriendo (el stop). **Optimista** |
| No hay impacto de mercado ni profundidad | **Optimista y creciente con el tamaño.** Una posición del 60% de $7.000.000 son $4,2M en un CEDEAR que no es de los cinco líquidos; el libro no lo absorbe al precio de pantalla |
| El benchmark de buy & hold es un camino realizado, no una distribución | No prueba que "comprar y esperar" sea mejor en general; prueba que en ESTAS dos ventanas el bot no le agregó nada |
| Entrar a mercado 15-18 veces por mes en Cocos sigue siendo **manual** | **Optimista y grande**, igual que en `INFORME-COCOS.md` §6, pero peor: son tres veces más operaciones que el caso base |

---

## 12. Veredicto

**¿Se puede llegar a 3% mensual subiendo agresividad y tamaño? No de una manera
que uno pueda defender.**

1. **La agresividad de entrada, como la plantea la hipótesis, no existe.** El
   nivel está 4,4% abajo del precio: los escalones de 0,25%, 0,50% y 1% compran
   entre 9 y 40 trades más en 20 meses, mueven el llenado del 21% al 29% y
   ninguno mejora el mensual de forma consistente en las dos ventanas. **El
   cuello de botella no es el precio del límite, es la distancia al nivel.**
2. **El único escalón que llena de verdad deja de ser el bot.** Entrar a
   mercado llena el 55-70% de las señales y sube el mensual a 2,0-2,4%, pero
   paga un premio de 4,4% sobre el nivel: ya no compra soportes, compra
   pantalla. Y la evidencia de por qué funciona **da vuelta la premisa del
   motor**: los trades que nunca bajaron al nivel rinden +1,75% bruto y los que
   sí bajaron rinden −1,05%, con p < 0,0001 en las dos ventanas. Esperar el
   soporte es selección adversa.
3. **La convención del kit: móvil domina en promedio, pero el corte real es el
   tamaño del premio.** Hasta medio punto por encima del nivel conviene dejar
   stop y target donde los puso el motor; entrando a mercado hay que
   recalcularlos sobre el precio de entrada, o el trade queda con stop de 6% y
   target de 1%.
4. **El tamaño escala lineal y el drawdown también, y sin plata prestada
   empeora.** De 20% a 60% por posición el mensual se triplica y el drawdown se
   multiplica por 2,7 — pero sólo si se permite exposición arriba del 100%. Con
   el tope de caja en 100%, agrandar la posición cambia cinco apuestas chicas
   por dos grandes y el caso base pasa de +0,26% a −0,28% en el in-sample.
5. **Las celdas que llegan a 3% son 12 de 120, y 10 necesitan de 1,5x a 3x de
   apalancamiento.** Las dos que no lo necesitan aparecen sólo en el
   out-of-sample. **En el in-sample, ninguna celda sin apalancamiento llega a
   3%: el techo es 2,27%.**
6. **La celda elegida en el IS aguantó el OOS** (+2,23% → +2,44%, drawdowns de
   12,7% y 9,7%), que es más de lo que consiguió cualquier otra configuración de
   este proyecto. Pero no le gana al nulo de selección en el in-sample
   (percentil 67, p = 0,33), el bootstrap de la mejora incluye el cero en las
   dos ventanas, y su DSR con N = 324 es 0,63.
7. **Con el spread real medido —0,25%— la celda elegida baja a 1,26% y 1,24%
   mensual, y el caso base en Cocos pasa de +0,26/+0,32 a +0,12/+0,16.** La
   mitad del resultado que publicaba `INFORME-COCOS.md` era una horquilla que no
   estaba modelada.
8. **Y el control que faltaba lo deja sin nada.** Contra estar simplemente
   comprado a la misma exposición media, el exceso de la celda elegida es −0,11
   puntos en el IS y +0,11 en el OOS. Once de doce variantes dan exceso negativo.
   **SPY en pesos, comprado y no tocado, dio 3,98%/mes en el in-sample y
   4,11%/mes en el out-of-sample.** El 3% mensual que pide LP, en estas dos
   ventanas, lo daba el 75% del capital parado en un CEDEAR de índice, sin
   operar y sin bot.

**En una línea: sí se llega a 3% mensual, pero sólo con 2 a 3 veces de
apalancamiento, drawdowns de 17% a 22%, spread cero y una estrategia que ya no
es comprar soportes sino comprar a mercado — y aun así no le gana a estar
comprado y quieto. El costo de llegar a 3% por esta vía es cambiar un bot que no
agrega nada por un bot apalancado que tampoco agrega nada, con cuatro veces más
drawdown.** Si el objetivo es 3% mensual en pesos, la pregunta que abre este
anexo no es cómo hacer que el motor opere más, sino **por qué operar**: la
respuesta honesta de estas dos ventanas es que la exposición a CEDEARs, tomada y
sostenida, pagó más que cualquier forma de entrar y salir de ella. Lo que queda
por investigar, si LP quiere seguir esta línea, es la única pregunta que el
bloque A.bis deja abierta y este anexo no puede contestar: **si el papel que
sube sin volver al nivel es el que paga, ¿hay alguna forma de comprarlo que no
sea comprar todo a mercado?** Eso ya no es un problema de agresividad de
entrada: es un motor de momentum, y es otro proyecto.

---

*Generado offline el 18/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `agresividad.js` (reusa `engine.js`; la celda base
reproduce `results.json` e `INFORME-COCOS.md` en 56/56 comparaciones y el script
aborta si hay una sola). Único acceso externo: consulta de sólo lectura a
`cedear_fv_log` en Supabase para calibrar el spread. Semilla 20260917, 5.000
sorteos por nulo. Huella de reproducibilidad: 4.221 números, FNV-1a `78a82c49`,
verificada en dos corridas. Detalle completo en `results-agresividad.json` y
`run-agresividad.log`. Convenciones, aproximaciones y anti-lookahead en
`README.md` e `INFORME.md`.*
