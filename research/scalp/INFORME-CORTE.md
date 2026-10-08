# Grilla del scalp: cortar, vender al cierre u holdear (01/10/2026)

Pregunta de LP: "si baja mucho por algún día negro, lo que hay que hacer es
quedarse holdeando esos papeles hasta que recupere". Medición con
`grilla5y.py` (simulación por camino de precios) sobre las velas de
`research/backtest-5y/data`: diario 5 años, horario ~3 años, 291 papeles.
Grilla 1% / +0,7% (MU) y 1,5% / +1% (SNDK), 5 lotes de USD 460 (capital máximo
USD 2.300), comisión 0,0605% por punta. Resultados en dólares.

## MU, diario 5 años (17/09/2021 a 17/09/2026)

| Corte desde el ancla | Total USD | Vueltas | Cortes | Peor abierto | Días cargado | Racha máx. cargado |
|---|---:|---:|---:|---:|---:|---:|
| 5% | −6.912 | 2.809 | 212 | −66 | 4% | 3 d |
| 10% | −4.643 | 2.239 | 73 | −183 | 28% | 10 d |
| 15% | −2.977 | 1.877 | 37 | −294 | 40% | 27 d |
| 20% | −433 | 1.491 | 18 | −411 | 54% | 50 d |
| 30% | +1.538 | 1.085 | 6 | −627 | 66% | 59 d |
| sin corte | +2.895 | 560 | 0 | −1.310 | 84% | 509 d |

- Vender todo al cierre de cada día: −7.800 (diario), −4.598 (horario).
- Comprar y mantener MU con los mismos USD 2.300: +27.873 (MU ×13).
- Sin corte, por año: 2021 +362, 2022 +81, 2023 **0 vueltas** (atrapado), 2024 +741, 2025 +581, 2026 +1.538.
- En pesos (precio × CCL, resultado llevado a USD): sin corte +1.471; con corte 5% −7.327. El CCL no cambia el orden.

SNDK (desde 02/2025): mismo patrón. Corte 5% −2.373, sin corte +2.401 (diario); −1.778 y +3.664 (horario).

## Universo: 291 papeles, 5 años, misma grilla

| Variante | Mediana | Promedio | Peor | Positivos |
|---|---:|---:|---:|---:|
| Vende al cierre | −3.852 | −6.134 | −47.290 | 0 / 291 |
| Arrastra, corte 5% | −2.840 | −4.592 | −29.346 | 2 / 291 |
| Arrastra, corte 15% | −1.325 | −2.842 | −30.154 | 55 / 291 |
| Sin corte | +521 | +428 | −2.142 | 197 / 291 |

Sin corte, la pérdida máxima es el capital de la grilla (los papeles que se
hundieron: SNAP, UPST, GLOB, PYPL, NKE pierden 75% a 93% de los USD 2.300 y
quedan cargados más de 1.200 días).

## Sesgo de la resolución (mismas 43 ruedas ago-sep 2026)

| Vela | Vende al cierre | Arrastra corte 5% | Sin corte |
|---|---:|---:|---:|
| 5 min | −80 | −44 | +424 |
| 1 hora | −240 | −162 | +305 |
| 1 día | −290 | −219 | +313 |

Las velas gruesas subestiman (unos USD 4 por rueda en las variantes que rotan
mucho, 25% en "sin corte"). Los totales a 5 años de las variantes con corte
están sesgados hacia abajo; el ORDEN entre variantes se mantiene en todas las
resoluciones. Con velas de 5 minutos restringidas a 10:35–16:45, "vende al
cierre" da +127 en 43 ruedas; con la rueda completa, −80: el resultado de esa
variante es indistinguible de cero.

MU en 5 años: de noche (cierre→apertura) +504%, de día (apertura→cierre) +117%.
Vender al cierre regala la mayor parte del retorno.

## Veredicto

1. El corte es lo que hace perder a la grilla: cuanto más lejos, mejor, en MU,
   en SNDK y en 291 papeles. LP tenía razón en ese punto.
2. Sin corte la grilla deja de ser scalping: 84% de los días está cargada entera
   y el resultado depende de que el papel recupere. Es una posición direccional
   acotada con ventas escalonadas, que rinde mucho menos que comprar y mantener
   el mismo papel cuando sube, y pierde todo el capital de la grilla cuando no.
3. La protección que queda no es el corte sino el tamaño: el máximo de papeles.

## "Hay que ver buenos papeles" (objeción de LP, misma noche)

`buenos.py` y `semis2000.py`, con 10 años de velas diarias (`d10/`).

- Los cuatro que hoy son malos eran de los mejores el 17/09/2021, por
  rendimiento de los 3 años previos entre 263 papeles: SNAP puesto 3 (+690%),
  GLOB 6 (+454%), PYPL 27 (+219%), NKE 74 (+89%); los cuatro sobre su media de
  200 ruedas. MU estaba en el puesto 91 y DEBAJO de su media de 200.
- Elegir "los que mejor venían" fue lo peor: el quinto superior tuvo 50% de
  grillas positivas y 19% perdió más de la mitad del capital; los otros cuatro
  quintos, 73% a 78% positivas y 0% a 5% de ruina.
- Filtro "abrir ciclos solo sobre la media de 200": no cambia nada (la grilla
  ya está cargada cuando el papel se da vuelta).
- Semis 2021-2026: 15 de 15 positivos sin corte (mediana +1.679 sobre 2.300).
  Semis 2016-2021: 8 de 8 positivos.
- Semis desde el techo de 2000, a 10 años: 7 de 8 negativos (MU −1.496 con el
  papel −82%, 2.417 días cargada; solo NVDA positivo). Desde 2007 a 5 años: 5
  de 8 negativos (MU −1.171).

Conclusión: sin corte, la grilla gana cuando el sector sube y pierde casi todo
el capital de la grilla cuando el sector entra en un ciclo malo. No hay un
filtro medido que separe "buen papel" por adelantado; la apuesta es al ciclo
del sector y el único límite real es el máximo de papeles.

## Dos cuentas desfasadas (02/10/2026)

El 02/10 la cuenta 3893 arrancó a las 12:24, cerca del mínimo, y a la hora
estaba +$20.800 contra −$15.400 de la 72404 (misma grilla, mismos papeles).
LP pidió medir si conviene desfasarlas. `desfasaje.py`, 9 papeles, sin corte
con refuerzo de 50%; A = configuración actual, B = segunda cuenta.

| Variante de B | 5 min, 43 ruedas (A+B) | Horario, 730 ruedas | Diario, 1.255 ruedas | Peor momento combinado (5m / h / d) |
|---|---:|---:|---:|---|
| igual a A (hoy) | +5.293 | +45.626 | +39.051 | −5.589 / −25.997 / −32.683 |
| abre tras caer medio escalón | +5.248 | +44.341 | +35.925 | −5.073 / −25.711 / −32.507 |
| abre tras caer un escalón | +4.400 | +40.900 | +35.849 | −4.266 / −25.433 / −32.399 |
| espera el triple antes de perseguir | +5.380 | +43.629 | +37.311 | −5.319 / −25.704 / −31.957 |
| grilla 1,5 veces más ancha | +5.211 | +46.618 | +41.264 | −5.162 / −25.446 / −32.115 |
| grilla 0,7 veces más angosta | +5.432 | +44.078 | +35.848 | −5.954 / −26.229 / −32.991 |

Veredicto: desfasar casi no cambia nada. Las dos cuentas terminan cargadas a
la vez entre 55% y 80% del tiempo con cualquier variante, porque el desfasaje
se pierde cuando el papel cae de corrido (que es cuando importa). Lo del 02/10
fue el horario de entrada, no una ventaja repetible. La única variante que
mejora un poco en las dos muestras largas es B con grilla 1,5 veces más ancha
(+2% a +6% de resultado, 2% menos de peor momento), dentro del ruido y a favor
del sesgo conocido de las velas gruesas hacia grillas anchas.

## Hora de arranque (02/10/2026)

LP: "¿y si una cuenta arranca 2 horas después?". `horario.py`: la cuenta no
opera (ni compra ni vende) antes de la hora indicada; lo arrastrado sigue.

| Arranque | 5 min, 43 ruedas | Horario, 730 ruedas | Vueltas (horario) | Suma de peores (horario) |
|---|---:|---:|---:|---:|
| 10:35 (actual) | +2.646 | +25.111 | 5.543 | −12.914 |
| 11:35 | +3.188 | +29.290 | 4.911 | −12.535 |
| 12:35 | +3.602 | +27.900 | 4.167 | −12.590 |
| 13:35 | +3.472 | +28.507 | 3.681 | −12.596 |
| 14:35 | +3.183 | +28.412 | 3.234 | −12.534 |

Arrancar 11:35 mejora en 9 de 9 papeles (horario) y 7 de 9 (5 min), y en los
cuatro años de la muestra horaria (2023 +2.103→+2.468, 2024 +6.543→+7.564,
2025 +7.626→+9.051, 2026 +11.501→+12.789). Más tarde que 11:35 no suma de
forma consistente. La mejora no viene de desfasar una cuenta contra la otra
sino de NO operar la primera hora: menos vueltas, pero mejores (la grilla
compra caídas de la apertura que suelen seguir). Aplica a las dos cuentas.
Reserva: mismo sesgo de dirección que favorece a las grillas anchas.

## Regla del lateral (02/10/2026)

LP: "comprar medio lote al precio si pasan 2 hs y no pasa nada". `lateral.py`,
9 papeles, sin corte, refuerzo 50%. El extra se vende a su costo + ganancia.

| Variante | 5 min: resultado | peor | sobre capital máx. | Horario: resultado | peor | sobre capital máx. |
|---|---:|---:|---:|---:|---:|---:|
| sin regla | +2.646 | −2.794 | 8,7% | +22.813 | −12.998 | 74,4% |
| medio lote a las 2 h (hasta 4) | +3.240 | −3.244 | 8,2% | +30.214 | −16.379 | 70,7% |
| medio lote a la 1 h | +3.704 | −3.532 | 9,0% | +35.256 | −17.102 | 82,4% |
| medio lote a las 4 h | +2.854 | −2.871 | 8,4% | +26.111 | −14.620 | 64,7% |
| lote entero a las 2 h | +3.905 | −3.695 | 8,0% | +37.215 | −19.590 | 67,7% |
| medio lote a las 2 h, hasta 2 | +3.002 | −3.125 | 8,5% | +27.409 | −14.985 | 74,7% |

Mejora el resultado en 8 de 9 papeles (5 min) y 9 de 9 (horario): +22% y +32%.
Pero usa 30% a 40% más capital y el peor momento es 16% a 26% más profundo:
el rendimiento sobre el capital máximo queda igual (8,2% vs 8,7%; 70,7% vs
74,4%). No es una ventaja nueva: es más plata trabajando, con una mejora chica
en resultado por unidad de peor momento (5% a 17%). La variante de 1 hora es
la única que mejora también sobre el capital máximo en las dos muestras.
Mi pronóstico previo ("va a dar parecido a la grilla angosta") fue errado en
términos absolutos.

## Canasta balanceada y Monte Carlo (04/10/2026)

LP: "cuando bajan los semis, ¿qué sube? ¿cuál es el opuesto? armamos algo
balanceado y simulamos todos los escenarios estilo Monte Carlo de los últimos 2
años". `balance.py` (salida completa en `balance-salida.txt`). Diario, USD, 100
CEDEARs líquidos; canastas elegidas con la correlación de los 2 años ANTERIORES;
1.000 años sintéticos de 250 ruedas con bloques de 10 ruedas, las mismas para
todos los papeles; grilla sin corte con refuerzo 50% (sin regla del lateral).

**No hay opuesto.** Los 79 días en que SMH cayó 2% o más: MU −5,1%, SNDK −5,2%,
AMD −4,6%. Lo más "contrario" entre los líquidos: KO +0,6% (sube 70% de esos
días, correlación −0,24), VZ +0,7%, PEP +0,4%, MCD +0,3%. El oro NO es opuesto:
GLD correlación +0,22 y −0,4% esos días; las mineras (GDX, NEM, KGC) −1,1% a
−1,5%. Brasil (EWZ) +0,38. Lo único con correlación negativa de verdad son los
ETF inversos (QQQD −0,68, AMDD −0,76, VXX −0,66), que perdieron 40% a 91% en los
2 años: no sirven para una grilla que holdea.

| Canasta | N efectivo | MC 2 años: mediana anual | año malo (5%) | peor momento (5%) | Estrés 2022: mediana | peor (1%) |
|---|---:|---:|---:|---:|---:|---:|
| actual (9 de hoy) | 2,5 | +22,6% | −3,9% | −21,6% | −40,0% | −68,9% |
| 5 semis + KO PEP VZ UNH | 4,5 | +16,2% | −5,9% | −19,8% | −25,8% | −52,6% |
| MU NVDA META GOOGL + UNH PBR VZ PFE BBD | 4,7 | +7,4% | −8,4% | −16,5% | −24,5% | −51,8% |
| MU + 8 opuestos | 5,4 | +9,7% | −9,1% | −19,0% | −25,3% | −49,8% |

(% sobre el capital máximo de la canasta. Estrés = años armados con las ruedas
de 2022, SMH −34%.)

- Balancear baja el peor momento poco (2 a 5 puntos) y el resultado mucho (6 a
  15 puntos) en los últimos 2 años; en un 2022 ahorra unos 15 puntos, pero
  todas las canastas pierden en 96% a 99% de los años.
- Los defensivos no suben cuando caen los semis: quedan en cero (KO +2%, PEP
  +2% en 2022). Diluyen, no compensan. Y la grilla no rota en papeles quietos.
- Riesgo de papel suelto: UNH era de los menos atados a los semis en la ventana
  de selección y la grilla pierde 19% mediano con él (72% de años negativos).
- Achicar la canasta actual al 65% da casi lo mismo que "5 semis + 4
  defensivos": +14,6% / estrés −25,8% / peor momento −13,9%.
- Control de azar (300 canastas de 9 al azar): la actual le gana al 100% en
  resultado y al 73% en peor momento. El "edge" de la actual es que son los
  papeles que más subieron en la muestra.

Reservas: en dólares (el CCL es un factor común que no se balancea); velas
diarias; liquidez de un solo día; el Monte Carlo solo reordena lo que pasó en
la ventana (2 años alcistas para semis), por eso se agregó el estrés con 2022;
la ventana de selección pisa 3 meses de 2022.

## Defensivos con disparador (04/10/2026)

LP: "si viene un cisne negro y se hacen mierda los semis, mantener los malos
holdeando y empezar a operar defensivos hasta que recuperen". `defensivos.py`
(salida en `defensivos-salida.txt`). Historia real 10/2018 a 10/2026, diario,
USD. Disparador: SMH X% abajo de su máximo de un año; se apaga al volver a −5%.
Plata nueva en 5 grillas (sin corte, refuerzo 50%), valuadas al apagar.

| Disparador | Episodios | Tiempo prendido | Defensivos de manual (KO PEP MCD WMT JNJ) | Menos atados a SMH (elegidos ese día) | Semis nuevos al precio caído |
|---|---:|---:|---:|---:|---:|
| −10% | 15 | 48% | −1,6% anual, peor −22,5% | −5,8% anual, peor −32,3% | +6,8% anual, peor −43,2% |
| −15% | 7 | 40% | −1,0% anual, peor −19,5% | −7,3% anual, peor −29,5% | +9,2% anual, peor −41,4% |
| −20% | 5 | 35% | −2,4% anual, peor −19,5% | −11,6% anual, peor −31,0% | +10,8% anual, peor −40,7% |

- Los defensivos de manual dan cero o algo negativo en los episodios: +2,8% en
  todo 2022 (14 meses), −19,5% de peor momento en marzo 2020 (cayó todo junto).
- Elegir "los menos atados a los semis" con datos elige oro, mineras, MRNA, UNH:
  no son defensivos y pierden más.
- Siempre prendidos (reeligiendo cada año): −1,7% anual, peor −50,5%.
- La misma plata en grillas nuevas de semis, ancladas al precio ya caído, rinde
  más (+7% a +11% anual) pero perdió 17% en 2022 y llegó a −41%.
- Dato de hoy: con el disparador de −10% o −15% estamos DENTRO de un episodio
  desde julio 2026 (SMH no volvió a 5% de su máximo). En este episodio los
  defensivos perdieron 4% a 7% y los semis nuevos ganaron 9%.

Veredicto: operar defensivos durante la caída no recupera nada. La plata nueva
en una crisis rinde más en caución, o en los mismos semis más abajo si se
tolera el riesgo de un 2022.

## Reversión a la escala del escalón y escalón por volatilidad (04/10/2026)

Preguntas de `mazda_miata` (moltbook). `atr.py` (salida en `atr-salida.txt`);
`grilla5y.py` acepta ahora `dinamico` (paso por fecha, fijo dentro del ciclo).

- **Reversión:** autocorrelación de retornos consecutivos, promedio de los 9
  papeles: −0,03 a 1 hora (movimiento típico 0,8%), +0,03 a 2 horas, −0,05
  diaria en 10 años, −0,01 diaria en los últimos 2. Cero práctico: no hay
  rebote que la grilla coseche; es holdear con toma de ganancias.
- **Escalón = k × volatilidad de 20 ruedas** (mismo paso medio que el fijo):
  5 min +14% de resultado, horario +2%, diario −4%; contra la familia de pasos
  fijos al mismo peor momento: +1,7% horario, −7% diario. La mejora por papel
  sigue a la volatilidad media del papel (rangos +0,35 / +0,47) y por régimen
  solo corre resultado del régimen quieto al movido. Es una perilla: NO se adopta.
- **Familia de pasos fijos, resultado / peor momento:** horario 1,41 · 1,59 ·
  1,76 · 1,91 · 1,91 a 0,5x · 0,75x · 1x · 1,5x · 2x; diario 1,74 · 2,04 ·
  2,34 · 2,69 · 2,87. Más ancho es mejor siempre, con menos vueltas y menos
  capital cargado. En 5 minutos (43 ruedas) el resultado es plano (2.565 a
  2.964) y el peor momento mejora con el ancho (−3.267 a −1.873).

## La rueda del 05/10/2026: qué pasó, qué hubiera sido mejor y la recompra

Primera rueda con las dos cuentas completas, lateral, refuerzo habilitado y la
3893 con escalón 1,5x y compras desde las 12:00. Día bajista para los semis
(INTC −3,7%, MU −2,2%, SNDK −2,0% en pesos). `hoy.py`, `gap.py`,
`hoy_bajar.py`, `estado_apertura.js`; salidas en `hoy-salida.txt` y
`gap-salida.txt`.

**Resultado real del día (realizado + cambio del latente contra el viernes):**
72404 −272.988 · 3893 −198.092 · diferencia 74.896 a favor de la 3893. (El
"neto" del pulso, −430k y −266k, incluye el latente que ya venía del viernes:
−157k y −68k.) Por papel, la 3893 quedó mejor en MU (+35.000), SNDK (+16.000),
INTC (+12.600) y AMD (+12.400), y algo peor en NVDA, MSFT y META.

**Qué explica la diferencia (simulación de la rueda, velas de 1 minuto en
pesos, desde el estado real de apertura; el simulador da −302k y −214k contra
−273k y −198k reales):**

| Estado de apertura | 10:35 · 1x | 12:00 · 1x | 10:35 · 1,5x | 12:00 · 1,5x |
|---|---:|---:|---:|---:|
| el de la 72404 ($17,0M cargados) | −302.135 | −288.945 | −302.983 | −306.245 |
| el de la 3893 ($11,1M cargados) | −196.259 | −188.503 | −197.812 | −214.397 |

- La diferencia entre cuentas es casi toda el punto de partida: la 72404 abrió
  con más lotes de INTC, MU y SNDK. Con la MISMA configuración las separan
  106.000.
- Comprar desde las 12:00 ayudó poco (8.000 a 13.000). El escalón ancho no
  ayudó hoy (igual a las 10:35; 26.000 peor a las 12:00, por menos ventas en un
  día de rango angosto).
- Lo mejor hoy hubiera sido no comprar nada (−375.000 las dos cuentas, contra
  −450.000 a −523.000 de las 32 variantes): en un día que cae, toda compra
  suma pérdida. Entre variantes la dispersión es 15%: ruido de un día.
- El lateral costó entre 5.000 y 30.000 según la variante (compra más en un
  día que siguió bajando).

**Demorar la VENTA cuando abre con salto (idea de LP): no suma.** Después de un
salto para arriba, a los 30 minutos el precio está +0,14% / −0,32% / +0,03%
(saltos de 0,5-1% / 1-2% / más de 2%; 141 casos en 5 minutos) y sube 42% a 52%
de las veces. En horario, 2.126 casos: primera hora entre 0,00% y +0,11%.

**Demorar la RECOMPRA tras una venta en el salto de apertura** (no reabrir por
encima del objetivo de esa venta durante la primera hora; caso MSFT, que vendió
a $28.320 y recompró a $28.300 a los 21 minutos): hoy hubiera mejorado 17.000
a 19.000 con compras desde las 10:35. En las muestras largas es neutro: +1,1%
en 5 minutos (38 veces que actuó), −1,5% en horario (280 veces); mejora en 6
de 9 papeles en las dos. No hay evidencia para adoptarla. La regla más amplia
ya medida (no operar la primera hora) daba +17% a +20%.

**Incidentes del día:** informe de posiciones de Cocos vacío hasta ~10:00
(parche de espera de tenencia); refuerzo que no se habilitaba con un escalón a
medias; tick de BYMA por banda de precio (META ≥ $50.000: 664 rechazos,
corregido 12:47 y freno a los 5 rechazos del mercado). Lateral: 40 lotes extra.
Refuerzos: ninguno.

## Vender al cierre lo que está en ganancia (06/10/2026)

LP: "cerrar a las 16:45 todo lo que está positivo en el día y quedarnos solo
con lo rojo; al otro día arrancar de nuevo con los limpios". `grilla5y.py`
con `cierre_ganadores='papel'|'lote'`. 9 papeles, sin corte, refuerzo 50%.

| Muestra | Como hoy | Vende el papel en ganancia | Vende los lotes en ganancia | Vende todo |
|---|---:|---:|---:|---:|
| 5 min, 43 ruedas | 2.646 | 2.682 (+1%) | 2.625 (−1%) | −135 |
| Horario, 3 años | 22.813 | 22.056 (−3%) | 21.790 (−4%) | −28.158 |
| Diario, 10 años | 39.178 | 37.309 (−5%) | 41.607 (+6%) | −100.138 |

Peor momento igual en todas. Veredicto: neutro (ruido de ±5% con signo
cambiante), no protege nada; lo que se vende al cierre deja de cobrar la suba
de la noche siguiente tantas veces como evita la baja. Vender todo al cierre
sigue siendo la peor variante. No se adopta.

**Ampliación (06/10 tarde), idea completa de LP: vender lo verde al cierre y
reentrar al día siguiente en escalones más bajos.** Con `entrada_off` (la
reentrada espera una caída de un escalón, o medio, desde el precio):

| Muestra | Como hoy | Vende verde, reentra al precio | Vende verde, reentra 1 escalón abajo | Vende verde, reentra ½ escalón abajo | Como hoy, reentra 1 escalón abajo |
|---|---:|---:|---:|---:|---:|
| 5 min, 43 ruedas | 2.646 | 2.682 | 1.692 (−36%) | 2.675 | 1.754 |
| Horario, 3 años | 22.813 | 22.056 | 17.617 (−23%) | 20.476 (−10%) | 18.087 |
| Diario, 10 años | 39.178 | 37.309 | 30.088 (−23%) | 32.432 (−17%) | 33.976 |

Por año (horario): peor en 2023, 2024, 2025 y 2026. "Mejor en" 0 a 2 de 9
papeles. Lo que cuesta es la espera a comprar más abajo: en papeles que suben,
esperar la caída deja afuera ciclos enteros (20% menos de vueltas). El peor
momento mejora poco (−12.328 vs −12.998). Veredicto: no se adopta; si LP
insiste, prueba A/B en una cuenta desde el 13/10, y simulación "qué hubiera
pasado" cada día con `hoy.py` (estado inicial sin los verdes de ayer).

## "Qué hubiera pasado" con la regla de vender lo verde (rueda del 07/10/2026)

`cierre_verdes.py` (salida en `cierre-verdes-2026-10-07.txt`). Velas de 1 minuto
en pesos (Yahoo .BA; de 10:30 a 11:00 se completan con la vela en dólares
llevada a pesos), estado real de apertura de cada bot (`estado_apertura.js`),
configuración real de cada cuenta. En verde al cierre del 06/10 había solo dos
papeles por cuenta: AMZN (+3.500 en cada una) y GOOGL (+720 y +2.385); el
resto estaba en rojo o sin papeles.

| | Como corrió | (a) vende lo verde, arranca limpio al precio | (b) vende lo verde, arranca un escalón abajo |
|---|---:|---:|---:|
| 72404 | 315.393 | 319.528 (+4.135) | 273.515 (−41.878) |
| 3893 | 102.189 | 107.983 (+5.794) | 73.753 (−28.436) |
| Total | 417.582 | 427.512 (+9.930) | 347.268 (−70.313) |

Lectura: (a) casi igual (+2%); (b) pierde todo lo que AMZN y GOOGL ganaron en
el día, porque subieron de corrido y nunca bajaron un escalón para reentrar.
Es el mismo mecanismo que en las muestras largas (−23%). Reserva: el error del
simulador contra lo real en este día (3893: simulado 102k contra ~226k real)
es mayor que el efecto de la regla; un día no decide.

## 3893: compras desde las 12 salvo apertura en baja (08/10/2026, apertura_bajista.py)

Propuesta de LP: si el papel abre en baja fuerte, que la 3893 compre desde la apertura; si no, desde las 12. Escalón 3893 (x1,5), 10 papeles, USD.
- Horario 2 años (730 ruedas): A desde la apertura +36.794 · B desde las 12 +36.510 · G abre 1% abajo +37.171 (+1,8% vs B) · I toca 1% antes de las 12 +36.873. Diferencias de 1-2%: ruido.
- 5 min, 60 ruedas (16/07-08/10): A +4.732 (+13% vs B) · B +4.195 · G 1% +4.348 (+3,6%) · I 1% +4.392 (+4,7%). Por unidad de capital A también gana (167,8 vs 157,0 por 1000).
- Lectura: el retraso a las 12 no agrega nada medible; la regla condicional recupera una parte de lo que cuesta; comprar desde la apertura es igual o mejor en las dos muestras. Decisión de LP junto con el escalón después del viernes 09/10.
