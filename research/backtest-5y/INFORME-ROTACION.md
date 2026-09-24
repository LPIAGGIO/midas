# Informe · el nulo de rotación, el 79% y el poder del test que no lo tenía

**La primera línea, sin vueltas: las tres críticas del tercero son correctas y
ninguna de las tres nos deja bien parados, pero sólo una cambia una conclusión
publicada.** (1) El nulo de bloques que publicamos no era plenamente
intercambiable — sorteaba las posiciones de arranque de cada bloque de forma
independiente y por eso rompía el acoplamiento entre la duración de un bloque y
el estado del mercado. Reemplazado por la rotación circular con p **exacto por
enumeración**, los 17 gates se mueven poco —mediana de la diferencia absoluta de
p = 0,018— y **ninguno llega a p < 0,05**: la conclusión de `INFORME-NULO.md` se
sostiene entera, pero se sostenía con un nulo mal construido. (2) El 79% de re-derivación de zona **no
es plano** contra el rango intrabarra: crece de 56% a 76% (±0,5%) y de 17% a
54% (±2%) del quintil más angosto al más ancho, con Spearman ρ = 0,29 y
p = 0,00004 en la tolerancia de ±2%. Por el criterio que él mismo fijó, eso es
**artefacto de granularidad**, y contradice en parte lo que dijimos en
`INFORME-BARRIDO.md` §6 punto 2. (3) El test de pasa-contra-bloquea **no tiene
poder**: su aritmética está bien al cuarto dígito, la potencia formal es 19,1%
en el IS y **6,4% en el OOS** — a un pelo del 5% que da tirar una moneda— y para
80% de potencia harían falta 6,7× y 63,8× más operaciones. **No es corroboración
independiente de nada: es no informativo en las dos direcciones.**

Todo corrió local sobre `data/` y el cache `signals.json`. No se tocó el VPS ni
Supabase. No se commiteó nada. Motor, gate y reglas de ejecución idénticos a
`INFORME.md`.

**Semilla `20260917`** (mulberry32, `rotacion.js`), la misma de todos los
anexos. El nulo nuevo **no usa la semilla**: enumera. La semilla se usa
únicamente para reproducir el nulo viejo. Huella de reproducibilidad: 156
números, FNV-1a **`5e15b12b`**.

---

## 0. De dónde sale esto

El método del nulo de bloques de `INFORME-NULO.md` §1 ("Null 2") se publicó en
un foro. El usuario **`mazda_miata`** respondió con dos aportes concretos y una
corrección de lectura. Los tres se implementaron acá tal como los planteó. **La
crítica es de él; los números y los errores de este informe son nuestros.**

### Los tres chequeos de arranque, todos obligatorios

| Chequeo | Resultado |
|---|---|
| Las 20 celdas de `INFORME.md` §3 (mensual y n, Gold) | **Δ = 0,0e+0 en las 20**, Δn = 0 en las 20 |
| El umbral de volatilidad (mediana IS por señal) | 0,1281 = el de `results.json` |
| El régimen del worker recalculado contra el cache | **55.934 / 55.934 señales** |
| **El nulo de BLOQUES publicado, reproducido celda por celda** | **17/17 celdas, máxima \|Δp\| = 0,00e+0** |
| La zona reconstruida en la barra de la señal reproduce el nivel de entrada | **205 / 205 trades** |
| La tasa de re-derivación reproduce la tabla de `INFORME-BARRIDO.md` §6 | **12 / 12 celdas** (4 tolerancias × IS/OOS/POOL) |

El cuarto es el que habilita todo lo demás: **el nulo viejo reproduce bit a bit**
—percentil y p idénticos al noveno decimal en los 17 gates— así que lo que
cambia abajo es el método y no una diferencia de implementación. Para lograrlo
`rotacion.js` consume el PRNG en el mismo orden que `nulo.js`, incluidos los
5.000 sorteos del nulo 1 que acá no se usan pero adelantan el generador.

---

## 1. La crítica, y por qué tiene razón

El nulo 2 de `INFORME-NULO.md` tomaba los `m` bloques apagados del filtro real,
conservaba sus `m` duraciones exactas, y después **sorteaba las posiciones de
arranque de forma independiente** (composición uniforme por barras y estrellas,
con al menos una rueda de separación).

Eso conserva el multiconjunto de duraciones, sí. Lo que **no** conserva es que
un bloque de 69 ruedas y uno de 2 ruedas ocurren en condiciones de mercado
distintas. Al reubicarlos independientemente, el nulo permite que el bloque
largo caiga donde el mercado estaba tranquilo y el corto donde estaba roto, que
es una configuración que el proceso real no puede producir. **El sorteo no es
intercambiable con el dato**: rompe el acoplamiento duración ↔ estado.

La solución que propone es limpia: **tomar la serie indicadora completa de
encendido/apagado como un objeto rígido y rotarla módulo T**.

```
mask_j[t] = mask[(t + j) mod T]        j = 0 … T−1
```

Preserva por construcción el multiconjunto **completo** de duraciones, el orden
de los bloques y los huecos entre ellos, porque **nunca se corta la serie**. Lo
único que se destruye es la alineación entre calendario y retornos, que es
exactamente el nulo que se busca. Y no puede colar el modelo de régimen de
vuelta porque no usa modelo: el calendario es dato.

### 1.1 El artefacto de costura, y qué se eligió

Al leer la serie rotada de forma **lineal**, el bloque que queda a caballo del
punto de corte se parte en dos: 36 bloques pueden verse como 37. Él da dos
salidas; se eligió la **segunda**:

- **(a)** descartar del estadístico el bloque que cruza la costura — rompe la
  conservación del total de días apagados, que es justo lo que había que
  verificar;
- **(b) rotar sólo por los `j` cuya costura NO cae dentro de un tramo apagado.**
  Formalmente: `j` es admisible ⟺ NO (`mask[(j−1+T) mod T]` apagado **y**
  `mask[j]` apagado). Con esa restricción la lectura lineal y la circular
  coinciden, y el multiconjunto se conserva **exacto**.

**Verificación, corrida en las T rotaciones de los 17 gates:** el total de días
apagados se preserva en **T/T** rotaciones (trivial: rotar es una biyección) y
el multiconjunto **circular** de duraciones en **T/T**. El multiconjunto
**lineal** coincide con el circular en **todas** las rotaciones admisibles de
los 17 gates.

**El dato incómodo que apareció de paso:** en **3 de los 17 gates la propia
serie real cruza la costura** —empieza y termina apagada—, así que la lectura
lineal publicada tenía **un bloque de más**:

| Gate | Bloques (lectura lineal, la publicada) | Bloques (circular, la correcta) |
|---|---:|---:|
| control: sin régimen + SPY<EMA200 · IS | 7 | **6** (el bloque más largo, de 336 ruedas, se lee partido en dos) |
| control: sin régimen + SPY<EMA200 · OOS | 4 | **3** |
| control: sin régimen + vol20 alta · OOS | 12 | **11** |

Son los tres controles, no los gates recomendados. El filtro de volatilidad
—`base + vol20 baja`— tiene 10 bloques en las dos lecturas, así que el número
publicado de `INFORME-NULO.md` §1 ("10 bloques que suman 200 de 424 ruedas")
está bien.

### 1.2 El p pasa a ser exacto, y más barato

Hay sólo T rotaciones distintas, así que **no hay nada que sortear**: se
enumeran todas y el p de permutación es **exacto**, no Monte Carlo. Con la
convención de los informes previos —`p = (#{nulo ≥ real} + 1) / (B + 1)`— y con
`B` = las rotaciones admisibles distintas de la identidad, la identidad aporta
el "+1" del numerador y del denominador, de modo que la fórmula publicada **es**
el p exacto sin cambiarle una coma.

Costo: de **85.000 simulaciones** (17 celdas × 5.000) a **6.264** (9 celdas del
IS × 424 + 8 del OOS × 306). Medido en la misma máquina: la corrida entera con
rotación —los tres chequeos de arranque, los 17 gates, la celda de Cocos, el
test del 79% y el cálculo de poder— tarda **12,4 s**; agregarle la reproducción
del nulo viejo la lleva a **245 s**. O sea que el 95% del costo del anexo es
reproducir el método que se está reemplazando.

**El precio que se paga, y hay que decirlo:** el p mínimo alcanzable es
`1/(B+1)`, y `B` cae con la cantidad de ruedas apagadas (cada rueda apagada
extra que no arranca bloque quita una rotación admisible). Para los 15 gates que
no son el control `SPY<EMA200`, `B` está entre 118 y 387, o sea p mínimo entre
0,0084 y 0,0026 — alcanza de sobra. Pero para `control: SPY<EMA200 / OOS`, que apaga 300 de 306
ruedas, quedan **10 rotaciones admisibles y el p mínimo es 0,10**: ese test
**no puede rechazar nada ni aunque el efecto fuera enorme.** El nulo viejo lo
disimulaba con 5.000 sorteos que en realidad exploraban muy pocas
configuraciones distintas.

---

## 2. Los 17 gates con el nulo nuevo · p EXACTO contra el p publicado

Tarifa **Gold**, ventanas IS (2023-10 → 2025-06) y OOS (2025-07 → 2026-09).
"pub" = nulo de bloques, 5.000 sorteos, `INFORME-NULO.md` §2. "rot" = rotación
circular, enumeración exacta sobre las rotaciones admisibles.

| Gate | Ventana | pctil pub | **p pub** | pctil rot | **p EXACTO** | Δp | B |
|---|---|---:|---:|---:|---:|---:|---:|
| base + vol20 baja | IS | 59,1% | 0,4095 | 56,7% | **0,4359** | +0,026 | 233 |
| base + vol20 baja | OOS | 47,0% | 0,5301 | 55,5% | **0,4476** | −0,083 | 209 |
| base + SPY>EMA200 | IS | 19,4% | 0,8064 | 14,9% | **0,8557** | +0,049 | 387 |
| base + SPY>EMA200 | OOS | *no filtra nada* | — | *no filtra nada* | — | — | — |
| base + SPY>EMA50 | IS | 34,9% | 0,6513 | 28,6% | **0,7151** | +0,064 | 343 |
| base + SPY>EMA50 | OOS | 20,5% | 0,7948 | 19,3% | **0,8073** | +0,012 | 274 |
| base (worker) | IS | 67,7% | 0,3231 | 66,1% | **0,3414** | +0,018 | 330 |
| base (worker) | OOS | 42,8% | 0,5721 | 44,6% | **0,5560** | −0,016 | 249 |
| sin régimen + vol20 baja | IS | 50,9% | 0,4909 | 51,1% | **0,4915** | +0,001 | 233 |
| sin régimen + vol20 baja | OOS | 41,1% | 0,5891 | 50,7% | **0,4952** | −0,094 | 209 |
| sin régimen + SPY>EMA200 | IS | 17,8% | 0,8224 | 16,0% | **0,8402** | +0,018 | 387 |
| sin régimen + SPY>EMA200 | OOS | 5,3% | 0,9468 | 5,3% | **0,9472** | +0,000 | 302 |
| sin régimen + SPY>EMA50 | IS | 68,7% | 0,3129 | 67,9% | **0,3227** | +0,010 | 343 |
| sin régimen + SPY>EMA50 | OOS | 29,1% | 0,7089 | 31,4% | **0,6873** | −0,022 | 274 |
| *control*: SPY<EMA200 | IS | 77,9% | 0,2216 | 79,2% | **0,2245** | +0,003 | 48 |
| *control*: SPY<EMA200 | OOS | 63,9% | 0,3615 | 55,6% | **0,5000** | +0,139 | **9** |
| *control*: vol20 alta | IS | 52,6% | 0,4743 | 52,6% | **0,4762** | +0,002 | 209 |
| *control*: vol20 alta | OOS | 44,8% | 0,5523 | 45,8% | **0,5462** | −0,006 | 118 |

**Ninguno de los 17 gates evaluables llega a p < 0,05 con el nulo de rotación.**
El más chico de toda la tabla es el control "operar sólo con SPY bajo su EMA200"
en el IS, p = 0,2245 — que sigue siendo la regla *opuesta* a la del bot. En
Black el mínimo es ese mismo control con **p = 0,1020** (publicado: 0,1406).
Tampoco cruza.

**Cuánto se movió.** La mediana de |Δp| es **0,018** y el máximo es 0,139, y ese
máximo está en la celda con 9 rotaciones admisibles, donde el p exacto no puede
ser más fino que 0,10. Sacando esa celda, el máximo es 0,094. **Ningún gate
cambia de lado de ningún umbral.**

**El desvío del nulo, que era el argumento.** La lógica de la crítica sugería
que el nulo viejo estaba mal calibrado. Medido: el desvío de la distribución de
rotación es en mediana **0,958×** el del nulo de bloques (rango 0,856 a 1,052).
O sea que el nulo correcto es apenas **4% más angosto**, no más ancho. La
crítica es válida en el mecanismo y **casi irrelevante en la magnitud**, y eso
es un resultado, no una defensa: el nulo viejo estaba mal construido y daba
prácticamente lo mismo porque el estadístico —el mensual de una cartera con el
40% de las ruedas apagadas— es demasiado grueso para distinguir una colocación
de bloques de otra.

### 2.1 La celda de `INFORME-COCOS.md` §D.4

Es la **única** celda de un informe posterior que se evaluó contra el nulo de
bloques (verificado por búsqueda de `colocarBloques` en todos los scripts de la
carpeta: sólo aparece en `nulo.js` y `cocos.js`; `timestop.js`, `barrido.js`, `fino.js`,
`agresividad.js` y `parcial.js` usan nulos de otra familia —trades al azar,
descarte aleatorio, punto de disparo al azar— que esta crítica no toca).

| Filtro de volatilidad · tarifa **Cocos** | Mensual real | pctil pub | p pub | pctil rot | **p EXACTO** |
|---|---:|---:|---:|---:|---:|
| IS | +0,36% | 80,7% | 0,1932 | 83,3% | **0,1709** |
| OOS | +0,12% | 34,0% | 0,6605 | 40,7% | **0,5952** |

Mismo veredicto: el filtro de volatilidad no le gana al azar con la tarifa de
Cocos tampoco, y en el OOS sigue por debajo de la mediana del nulo.

### 2.2 Robustez de la elección de la costura

Se corrieron también las **T rotaciones sin filtrar** (opción implícita: dejar
que el bloque se parta). Las diferencias contra la versión admisible están en el
tercer decimal del p en 15 de 17 gates. Las dos excepciones son los controles
donde casi toda la serie está apagada: `SPY<EMA200 / OOS` pasa de p = 0,5000
(admisibles) a **0,0948** (todas), y `SPY<EMA200 / IS` de 0,2245 a 0,2028. **En
esos dos casos la elección de la costura importa**, y importa para el lado que
haría parecer significativo al control opuesto. Es otra razón para haber elegido
la opción (b): la (a) fabricaría un p chico a partir de bloques partidos.

### 2.3 Lo que cambia y lo que no en `INFORME-NULO.md`

**Cambia el método, no el veredicto.** Las afirmaciones 1, 2 y 4 del §8 de ese
informe quedan en pie con estos reemplazos de número (la 3 —el test de
expectancy— **se cae por falta de poder**, pero eso no es asunto de este bloque
sino del §4 de este informe):

- "contra el nulo de bloques cae en el percentil 59 del IS (p = 0,41) y en el 47
  del OOS (p = 0,53)" → **percentil 56,7 (p exacto 0,4359) y 55,5 (p exacto
  0,4476)**. En el OOS el filtro queda ahora *apenas por encima* de la mediana en
  vez de apenas por debajo: sigue siendo la mitad de la distribución.
- "En Black, en el 32 y el 36 del OOS" → **43,5 en el OOS con Black**. La frase
  "apagar en fechas al azar hubiera salido mejor" **hay que suavizarla**: con el
  nulo correcto el filtro queda en la mitad, no debajo de la mitad. El punto de
  fondo —no selecciona— no se toca.
- "ni uno solo de los 17 gates evaluables llega a p < 0,05" → **se confirma, con
  p exacto**.
- El régimen propio del worker: percentil 68 IS / 43 OOS → **66,1 y 44,6**.

---

## 3. El 79% contra el rango intrabarra · artefacto o propiedad

`INFORME-BARRIDO.md` §6 dejó el 79% partido en dos afirmaciones:
**(1)** el número exagera y es en buena parte selección entre zonas vecinas
(baja a 37,1% con tolerancia ±2%); **(2)** *"la muerte de la señal NO es
artefacto: es una propiedad del motor"*. La segunda se apoyaba en que D1 corta
202 de 205 trades con cualquier tolerancia, que es un argumento indirecto.

El test que propone el tercero es directo y no necesita datos de tick: **si es
granularidad, la tasa de desacuerdo tiene que escalar con el rango intrabarra
medido en unidades del ancho de la zona.** Plana → propiedad. Creciente →
artefacto.

### 3.1 Qué se usa como "ancho de la zona"

El motor agrupa pivotes en zonas con `clusterZones(pivs, ZONE_TOL)` y
`ZONE_TOL = 0,006`. Una zona es `{lo, hi, avg, touches, …}` donde `lo` y `hi`
son el mínimo y el máximo de los pivotes agrupados, y la entrada del bot es
`buyZone.hi`. De ahí salen dos nociones razonables de "ancho", y se corren **las
dos** (más su combinación):

| Id | Definición | n | Nota |
|---|---|---:|---|
| **r1** | **amplitud del clúster** = `zona.hi − zona.lo` | **92** | **113 de 205 zonas tienen un solo pivote y ancho EXACTAMENTE 0**: el ratio no existe ahí. Amplitud mediana de las que sí: 0,357% del nivel. Hay un caso con ancho ~1e−5 relativo que manda el ratio a 165.568; los tests son de rango o sobre el log, así que no lo distorsiona, pero queda dicho. |
| **r2** | **banda de agrupamiento** = `ZONE_TOL × nivel` = 0,6% del nivel de entrada | **205** | Es la tolerancia con la que el motor decide si un pivote pertenece a la zona, o sea el espesor que el motor le atribuye a una zona aunque tenga un pivote solo. Definida siempre. |
| **r3** | **efectivo** = `max(r1, r2)` | **205** | La zona real nunca es más angosta que la banda de agrupamiento. Definida siempre. |

El numerador es siempre el mismo: `high − low` de **la barra horaria del fill**.
Su distribución, como porcentaje del nivel: p10 = 0,85%, mediana = **2,14%**,
p90 = 5,17%. Contra una banda de 0,6%, el ratio típico es **3,6**.

La variable dependiente es la del §6: **el motor re-deriva otro nivel en la
barra inmediatamente posterior al fill**, con las cuatro tolerancias de "misma
zona". Se usa la versión sobre los 205 trades (no la de "primer disparo de D1"),
que es la que `INFORME-BARRIDO.md` reporta como 68,8% / 68,8% / 57,6% / 31,7%
y que este script **reproduce en 12/12 celdas**.

### 3.2 La tabla por quintil

**Ancho = r2 (banda de agrupamiento, 0,6% del nivel) · n = 205 · 41 por celda**

| Quintil | n | ratio mediano | re-deriva ±0,25% | ±0,50% | ±1,00% | ±2,00% |
|---|---:|---:|---:|---:|---:|---:|
| 1 (barra más angosta) | 41 | 1,41 | 56,1% | **56,1%** | 36,6% | **17,1%** |
| 2 | 41 | 2,53 | 65,9% | 65,9% | 53,7% | 14,6% |
| 3 | 41 | 3,56 | 78,0% | 78,0% | 63,4% | 34,1% |
| 4 | 41 | 5,27 | 68,3% | 68,3% | 63,4% | 39,0% |
| 5 (barra más ancha) | 41 | 8,64 | 75,6% | **75,6%** | 70,7% | **53,7%** |
| **Global** | 205 | 3,56 | 68,8% | 68,8% | 57,6% | 31,7% |

**Ancho = r3 (efectivo) · n = 205**

| Quintil | n | ratio mediano | ±0,25% | ±0,50% | ±1,00% | ±2,00% |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 41 | 1,39 | 61,0% | 61,0% | 41,5% | 17,1% |
| 2 | 41 | 2,47 | 58,5% | 58,5% | 46,3% | 14,6% |
| 3 | 41 | 3,35 | 75,6% | 75,6% | 63,4% | 34,1% |
| 4 | 41 | 5,22 | 73,2% | 73,2% | 65,9% | 39,0% |
| 5 | 41 | 8,59 | 75,6% | 75,6% | 70,7% | 53,7% |

**Ancho = r1 (amplitud del clúster) · n = 92 · sólo zonas de 2+ pivotes**

| Quintil | n | ratio mediano | ±0,25% | ±0,50% | ±1,00% | ±2,00% |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 18 | 2,02 | 44,4% | 44,4% | 38,9% | 16,7% |
| 2 | 18 | 3,72 | 50,0% | 50,0% | 50,0% | 16,7% |
| 3 | 19 | 6,74 | 84,2% | 84,2% | 78,9% | 26,3% |
| 4 | 18 | 13,62 | 77,8% | 77,8% | 66,7% | 44,4% |
| 5 | 19 | 36,87 | 89,5% | 89,5% | 73,7% | 47,4% |

### 3.3 El test de tendencia

Spearman del ratio contra el indicador de re-derivación (0/1), y regresión
logística del indicador contra **log(ratio)**, con su Wald. Ninguna de las dos
usa el agrupamiento por quintil: los quintiles son sólo para leer la forma.

| Ancho | Tolerancia | ρ Spearman | p | b₁ logit (log ratio) | z | p | ρ IS (p) | ρ OOS (p) |
|---|---|---:|---:|---:|---:|---:|---|---|
| **r2** | ±0,25% / ±0,50% | **+0,1286** | 0,0646 | +0,406 | 1,84 | 0,0660 | 0,106 (0,266) | 0,156 (0,130) |
| **r2** | ±1,00% | **+0,2223** | **0,0012** | +0,615 | 2,87 | **0,0041** | 0,224 (0,017) | 0,184 (0,072) |
| **r2** | ±2,00% | **+0,2875** | **0,00004** | +0,860 | 3,63 | **0,0003** | 0,319 (0,0004) | 0,254 (0,012) |
| **r3** | ±0,25% / ±0,50% | +0,1368 | 0,0491 | +0,428 | 1,95 | 0,0511 | 0,106 (0,266) | 0,174 (0,089) |
| **r3** | ±1,00% | +0,2307 | 0,0007 | +0,629 | 2,95 | 0,0032 | 0,228 (0,015) | 0,198 (0,053) |
| **r3** | ±2,00% | +0,2969 | 0,00003 | +0,885 | 3,74 | 0,0002 | 0,325 (0,0003) | 0,265 (0,008) |
| **r1** | ±0,25% / ±0,50% | **+0,3603** | **0,0002** | +0,728 | 2,88 | 0,0039 | **0,620 (<0,0001)** | 0,159 (0,242) |
| **r1** | ±1,00% | +0,2474 | 0,0154 | +0,407 | 2,04 | 0,0415 | 0,361 (0,022) | 0,151 (0,265) |
| **r1** | ±2,00% | +0,2998 | 0,0029 | +0,501 | 2,50 | 0,0124 | 0,341 (0,032) | 0,237 (0,076) |

**La tendencia es positiva en las 12 celdas** —9 distintas, porque ±0,25% y
±0,5% producen exactamente la misma partición en los 205 trades— **con las tres
definiciones de ancho y las cuatro tolerancias. No hay una sola celda plana ni
una sola negativa.**

### 3.4 El veredicto, con sus tres asteriscos

**Por el criterio que fijó el tercero, esto es artefacto de granularidad.** La
tasa de re-derivación escala con el rango intrabarra medido en anchos de zona,
y escala fuerte: con tolerancia ±2% va de 17,1% a 53,7% entre quintiles
extremos. Eso **corrige el punto 2 de `INFORME-BARRIDO.md` §6**, que decía que
la muerte de la señal era propiedad del motor y no artefacto. La parte
atribuible a la re-derivación de zona **sí depende de la granularidad de la
barra**, y depende mucho.

Los tres asteriscos, sin maquillar:

1. **En la tolerancia publicada (±0,5%) la tendencia es marginal**: ρ = 0,129,
   p = 0,065 con la definición de ancho que cubre los 205 trades, y ninguna de
   las dos ventanas la muestra por separado (IS p = 0,27, OOS p = 0,13). La
   evidencia es fuerte donde el número publicado era **más chico** (±1% y ±2%,
   donde sí replica en las dos ventanas) y débil donde era 79%. La lectura
   honesta es que el 79% no se explica del todo por granularidad; el 31,7% de
   ±2% sí se explica en buena medida.
2. **El ratio no es un instrumento limpio de granularidad.** Una barra con rango
   grande también es, plausiblemente, un quiebre de verdad. El diseño no separa
   mecanismo de confusión, y eso es una limitación del test, no de la
   implementación. Lo que el test descarta es la hipótesis nula —que la tasa sea
   independiente del rango—, que era exactamente lo que `INFORME-BARRIDO.md`
   estaba asumiendo sin testear.
3. **Granularidad explica parte del nivel, no todo.** Extrapolando la logística
   a `ratio = 1` (barra tan angosta como la zona, o sea el límite de
   granularidad perfecta), la tasa ajustada queda en **57,3%** con ±0,5% y
   **12,9%** con ±2% (definición r2). En el mínimo observado del ratio (0,58) da
   51,9% y 8,5%. O sea: aun con una barra horaria tan angosta como la propia zona,
   **la mitad de los trades seguiría re-derivando otro nivel a ±0,5%**. Ese piso es la
   propiedad del motor que `INFORME-BARRIDO.md` describía bien; lo que estaba
   mal era atribuirle el número entero.

**En una línea: la tasa NO es plana, crece con el rango intrabarra, y la parte
de la re-derivación que se puede achacar a la granularidad horaria es real y
grande — pero queda un piso de 51-57% (±0,5%) que la granularidad no explica.
El 79% se parte en tres, no en dos: selección entre zonas vecinas, granularidad
de la barra, y una extinción residual por construcción del motor.**

---

## 4. El poder del test de pasa-contra-bloquea

`INFORME-NULO.md` §3 presentó el test de expectancy de "lo que el filtro deja
pasar" contra "lo que bloquea" como un cuarto test independiente, y escribió:
*"No hay diferencia significativa en ninguna de las dos ventanas"* y *"la señal
es un tercio del ruido"*. El tercero invirtió los números y mostró que ese test
**no tiene poder para nada**. Su aritmética, verificada:

| | Él dijo | Recalculado acá | ¿Coincide? |
|---|---|---|---|
| IS · diferencia | 11.576 | **$11.576** | exacto |
| IS · t | 1,08 | **1,0821** | exacto |
| IS · error estándar implícito | ~10.700 | **$10.698** | sí |
| IS · efecto mínimo detectable | ~21.000 | **$20.967** | sí |
| IS · "casi el doble del observado" | ~1,8× | **1,81×** | sí |
| OOS · diferencia | 3.043 | **$3.043** | exacto |
| OOS · error estándar | ~8.694 | **$8.676** | sí (0,2% de diferencia) |
| OOS · efecto mínimo detectable | ~17.000 | **$17.005** | sí |
| OOS · "~31 veces más operaciones" | ~31× | **31,2×** | sí |

**Su aritmética está bien.** El "efecto mínimo detectable" que él calcula es
`1,96 × SE`, o sea el efecto más chico que saldría significativo — que es lo
mismo que decir que el test tiene **50% de potencia** justo ahí. El "31×" es el
multiplicador de n para que el efecto observado del OOS llegue a ese umbral.

### El poder formal del test tal como lo corrimos

α = 0,05 a dos colas, aproximación normal (la convención de los informes
previos). "Potencia" = probabilidad de rechazar la nula si el efecto verdadero
fuera exactamente el observado.

| Ventana | Métrica | n pasa/bloq | Diferencia | SE | t | p | **Potencia** | MDE al 80% | **n para 80%** |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| IS | Gold/trade | 73 / 38 | $11.576 | $10.698 | 1,08 | 0,279 | **19,1%** | $29.971 (2,59×) | **6,7× → 744 trades** |
| IS | Black/trade | 73 / 38 | $11.378 | $10.889 | 1,04 | 0,296 | 18,1% | $30.507 (2,68×) | 7,2× → 798 |
| IS | Bruto/nocional | 73 / 38 | +0,810% | 0,782% | 1,04 | 0,301 | 17,9% | 2,191% (2,71×) | 7,3× → 813 |
| OOS | Gold/trade | 57 / 37 | $3.043 | $8.676 | 0,35 | 0,726 | **6,4%** | $24.306 (7,99×) | **63,8× → 5.999 trades** |
| OOS | Black/trade | 57 / 37 | $2.685 | $8.891 | 0,30 | 0,763 | 6,1% | $24.910 (9,28×) | 86,1× → 8.093 |
| OOS | Bruto/nocional | 57 / 37 | +0,185% | 0,640% | 0,29 | 0,772 | 6,0% | 1,792% (9,66×) | 93,4× → 8.779 |

**La potencia del OOS es 6,4%.** El piso absoluto de cualquier test con α = 0,05
es 5% (que es lo que da cuando el efecto verdadero es cero). O sea que en el
out-of-sample ese test está **1,4 puntos por encima de tirar una moneda cargada
al 5%**. En el in-sample, 19,1%: rechaza una de cada cinco veces aunque el
efecto sea real y del tamaño medido.

Para llegar a 80% de potencia con el efecto observado harían falta **744 trades
en el IS y 5.999 en el OOS**, contra los 111 y 94 que hay. A la cadencia del bot
—205 operaciones en 35 meses, o sea 5,9 por mes— serían **unos 11 años de
in-sample y unos 85 años de out-of-sample**.

### La conclusión que hay que escribir

**El test de pasa-contra-bloquea no es corroboración independiente del nulo. Es
no informativo en las dos direcciones.** No puede decir que el filtro selecciona
y tampoco puede decir que no selecciona: un efecto verdadero de $15.000 por
trade —que sería enorme: más, en valor absoluto, que la expectancy entera del
sistema— saldría **"no significativo" en el OOS el 59% de las veces** (potencia
40,9%).

Lo que hay que corregirle a `INFORME-NULO.md`:

- El §3 dice *"Veredicto del bloque B: el filtro no discrimina"*. **Hay que
  leerlo como "el bloque B no puede decir si el filtro discrimina"**, que es
  otra cosa.
- El §8 lista cuatro tests y presenta el 3 (*"la expectancy de lo que deja pasar
  no se distingue de la de lo que bloquea"*) como evidencia acumulativa. **Ese
  punto hay que bajarlo de la lista**: no aporta evidencia, aporta un p grande
  producido por falta de n.
- Lo mismo aplica, por la misma razón, a la fila `base (worker)` del §3
  (p = 0,923 IS, p = 0,192 OOS) y a todas las filas con n de dos dígitos.
- **El veredicto global del filtro de volatilidad no cambia**, porque se apoya
  en los otros tres tests —el nulo (ahora de rotación), el lookahead del umbral,
  y el barrido monótono del cuantil— y ninguno de esos depende del bloque B.
  Pero el informe pasa de tener cuatro patas a tener tres.

Un detalle que conviene dejar anotado para el futuro: los dos p "significativos"
que el §3 reportaba —`SPY>EMA200` con n = 2 y `SPY>EMA50` con n = 5 del lado
bloqueado— son el reverso del mismo problema. Con n = 2 el test tiene potencia
para nada excepto para efectos absurdos, y cuando aparece significativo es
porque el efecto medido **es** absurdo ($27.752 por trade). Ese p no es
evidencia de un filtro malo; es evidencia de que dos trades cayeron donde
cayeron.

---

## 5. Deflated Sharpe Ratio · el N NO se mueve

`INFORME-PARCIAL.md` dejó el N en **372** (paranoico 594), σ(SR) de Cocos en
2,8910e−2. **Este informe no agrega ni una configuración**, y por la misma regla
que el propio proyecto fijó en `INFORME-NULO.md` §6:

- **Las T rotaciones no entran en el N.** Son la distribución de referencia
  contra la cual se juzga una configuración, exactamente igual que los 5.000
  sorteos del nulo viejo que reemplazan. Contarlas sería castigar dos veces el
  mismo test.
- **Los cortes por quintil de ratio del §3 no entran.** No son carteras: son
  cortes descriptivos sobre los mismos 205 trades del caso base, no tienen curva
  de equity propia ni Sharpe, así que no pueden entrar en σ(SR) ni en el N.
- **El cálculo de poder del §4 no entra.** No evalúa ninguna configuración.

**El N queda en 372 (paranoico 594) y σ(SR) no se recalcula.** El cambio de nulo
tampoco afecta a ningún DSR ya publicado: el DSR se deflacta por la cantidad de
configuraciones probadas y por la dispersión de sus Sharpe, y ninguna de las dos
cosas depende de con qué nulo se juzgó cada configuración. **El mejor DSR de una
cartera armable sigue siendo 0,6212** (la celda elegida del §15, OOS).

---

## 6. Lo que no está modelado en este informe (y para qué lado tira)

| Aproximación | Efecto |
|---|---|
| El nulo de rotación conserva el calendario de fines de semana y feriados (rota sobre ruedas, no sobre días corridos) | Igual que el nulo viejo; es la convención correcta para un bot que opera ruedas |
| La rotación desalinea calendario y retornos pero **conserva la estructura interna entera de la serie indicadora** | Es el punto del método. No lo hace más conservador: el desvío medido es 0,958× el del nulo de bloques, o sea apenas más angosto. Lo que se gana es validez, no potencia |
| Para el gate del régimen del worker, el nulo sigue bajando el régimen a nivel rueda (mayoría de barras) | Sin cambios respecto de `INFORME-NULO.md` §7; sólo afecta al par base vs sin régimen |
| Los gates que apagan casi todo el calendario tienen muy pocas rotaciones admisibles | El p exacto no puede bajar de 1/(B+1); en `SPY<EMA200 / OOS` eso es 0,10. Declarado en §1.2 |
| El ratio del §3 mezcla granularidad con volatilidad de la barra | No se puede separar sin datos de tick; el test resuelve la nula, no el mecanismo |
| El ancho de zona r1 no existe en 113 de 205 trades (zonas de un pivote) | Por eso se corren r2 y r3, que cubren los 205; las tres dan el mismo signo |
| La regresión logística usa log(ratio) y Wald asintótico | Con n = 205 y tasas entre 17% y 76% la aproximación es buena; el Spearman, que no depende de la forma funcional, coincide en signo y en significancia |
| El cálculo de poder del §4 usa la aproximación normal | Con n de 37 a 73 por grupo la t daría potencias 1-2 puntos más bajas: el resultado empeora, no mejora |
| Todo lo de `INFORME.md` §7 y `README.md` (earnings, libro de puntas, spread, gap del stop, CCL diario, granularidad horaria) | Igual que en el resto del proyecto |

---

## 7. Veredicto

**Tarea A · el nulo.** El nulo de bloques que publicamos no era plenamente
intercambiable y él tiene razón: rompía el acoplamiento entre la duración de un
bloque apagado y el estado del mercado. Reemplazado por la rotación circular con
p exacto por enumeración —y con la costura resuelta restringiendo las rotaciones
admisibles, de modo que el multiconjunto de duraciones y el total de días
apagados se conservan exactamente, verificado en las T rotaciones de los 17
gates— **ninguna conclusión cambia**: los 17 gates siguen sin llegar a p < 0,05,
el mejor es el control opuesto al del bot con p = 0,2245 (Gold) y 0,1020
(Black), y la celda de Cocos pasa de p = 0,1932 a 0,1709 en el IS y de 0,6605 a
0,5952 en el OOS. La mediana de |Δp| es 0,018. **Además el nulo nuevo es 13
veces más barato y su p es exacto, así que el viejo no tiene por qué volver a
usarse.** Lo único que hay que suavizar de `INFORME-NULO.md` es la frase "apagar
en fechas al azar hubiera salido mejor" en el OOS con Black: con el nulo
correcto el filtro queda en la mitad, no debajo.

**Tarea B · el 79%.** La tasa de re-derivación **no es plana**: crece con el
rango intrabarra medido en anchos de zona, con las tres definiciones de ancho y
las cuatro tolerancias, sin una sola celda negativa (el ordenamiento por quintil
no es estrictamente monótono —el 3º y el 4º se cruzan en varias columnas— pero
el signo de la tendencia es el mismo en las 12). Con
±2% va de 17,1% a 53,7% entre quintiles extremos (ρ = 0,29, p = 0,00004, replica
en las dos ventanas). **Por el criterio pre-fijado, eso es artefacto de
granularidad, y corrige el punto 2 de `INFORME-BARRIDO.md` §6.** Con los
asteriscos: en la tolerancia publicada de ±0,5% la tendencia es marginal
(p = 0,065) y no replica por ventana, y extrapolando a granularidad perfecta
queda un piso de 51-57% que la granularidad no explica. **El 79% se parte en
tres —zona vecina, granularidad de la barra, extinción por construcción— y sólo
la tercera parte es propiedad del motor.**

**Tarea C · el poder.** Su aritmética es correcta al cuarto dígito. La potencia
formal del test de pasa-contra-bloquea es **19,1% en el in-sample y 6,4% en el
out-of-sample** —el piso de cualquier test con α = 0,05 es 5%—, y para 80% de
potencia harían falta 6,7× y 63,8× más operaciones, o sea 744 y 5.999 trades.
**Ese test no es corroboración independiente del modelo nulo: es no informativo
en las dos direcciones, y hay que sacarlo de la lista de evidencia del §8 de
`INFORME-NULO.md`.** El veredicto sobre el filtro de volatilidad no cambia
porque se apoyaba en otros tres tests, pero el informe pasa de cuatro patas a
tres.

**Lo que esto deja para la próxima vez que publiquemos un método.** Las tres
correcciones son del mismo tipo: **no testeamos el test**. El nulo se construyó
sin verificar que fuera intercambiable, el 79% se interpretó sin medir la
sensibilidad a la granularidad que el propio `README.md` declara como
aproximación número 1, y un p grande se presentó como evidencia sin calcular
poder. Ninguna de las tres cosas era cara de hacer: sin la reproducción del nulo
viejo, este informe entero corre en **12 segundos**.

---

*Generado offline el 20/09/2026 sobre `research/backtest-5y/data` y el cache
`signals.json`. Script: `rotacion.js` (reusa `engine.js`; el chequeo de arranque
reproduce las 20 celdas de `INFORME.md` §3 con Δ = 0, el nulo de bloques
publicado en 17/17 celdas con Δp = 0, la zona de la señal en 205/205 trades y la
tabla del 79% de `INFORME-BARRIDO.md` §6 en 12/12 celdas). Semilla 20260917
—usada sólo para reproducir el nulo viejo; el nulo nuevo enumera y no sortea.
Huella FNV-1a `5e15b12b` sobre 156 números. Detalle completo en
`results-rotacion.json` y `run-rotacion.log`. Método de las tareas A y B
propuesto por `mazda_miata`. Convenciones y aproximaciones en `README.md`,
`INFORME.md`, `INFORME-NULO.md` e `INFORME-BARRIDO.md`.*
