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
