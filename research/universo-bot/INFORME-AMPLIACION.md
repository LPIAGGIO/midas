# Ampliar el universo del bot y ejecutar por ranking

**24/09/2026.** Pedido de LP: ampliar el universo a todos los CEDEARs argentinos,
re-medir, y ejecutar por ranking — ordenar los candidatos de mejor a peor, entrar
hasta quedarse sin capital, y cuando cierre una posicion tomar el siguiente.

## Veredicto

**No ampliar.** Medido fuera de muestra, pasar de 48 a 297 papeles empeora el
sistema. **El ranking, con cualquier criterio, no cambia nada.**

| Universo | Tier | n | Mensual | Sharpe |
|---|---|---|---|---|
| 38 papeles (OOS) | gold | 94 | −1,24% | −2,19 |
| 38 papeles (OOS) | cocos | 94 | **+0,03%** | 0,09 |
| 297 papeles (OOS) | gold | 187 | −3,80% | −4,51 |
| 297 papeles (OOS) | cocos | 187 | **−1,24%** | −1,57 |

Ventanas: IS 2023-10-19 → 2025-06-30, OOS 2025-07-01 → 2026-09-17.

La causa es mecanica: mas papeles significa mas señales (2.716 contra 371), la
cartera se llena antes, y se llena con señales de calidad promedio mas baja. El
universo de 48 esta **curado** — LP eligio esos papeles mirando cuales venian
andando. El panel entero no lo esta.

Eso tambien quiere decir que el universo viejo carga sesgo de seleccion: su
buy-and-hold OOS da +75,1% promedio contra +51,0% del panel entero. El bot viejo
no es mejor por elegir mejor; juega en una cancha mas favorable.

## El bug que casi me hace concluir al reves

La primera medicion daba **+4,14% mensual** para el universo ampliado, es decir
"ampliar da vuelta el sistema". Era falso.

Lo que lo delato fue el control: correr el ranking **al azar** con distintas
semillas. Los resultados salieron **bimodales** — dos semillas en ≈+4,2% y cinco
en ≈−3,6%, sin nada en el medio:

```
+4.57%   -3.93%   -3.97%   -3.11%   -2.96%   -4.24%   +3.80%
```

Una distribucion de dos picos solo puede significar que un unico trade decide
todo. Y era exactamente asi: **BNY el 22/09/2025 aportaba $7.202.417 sobre un
capital de $7.000.000** — 171% del total de la corrida. Sin el, la corrida pierde
$2.980.074. Las dos semillas positivas son las que agarraron ese trade.

Un swing con stop no hace +103% del capital. La causa:

```
BNY serie DIARIA:   ~$108     Bank of New York Mellon
BNY serie HORARIA:  ~$10,10   otro instrumento
```

**Yahoo devuelve dos instrumentos distintos para el mismo ticker segun el
intervalo.** Empalmo las series cuando BK se renombro a BNY. El motor arma los
soportes con la diaria y ejecuta con la horaria: compraba a 10 algo con target en
108.

### Regla nueva

Al sumar cualquier ticker al backtest o al bot, **cruzar el cierre diario contra
el horario del mismo dia**. Diferencia media mayor al 5% = serie corrupta.

Barrido sobre los 284 papeles: solo BNY estaba mal. Un ticker de 284 alcanzaba
para invertir la conclusion del estudio entero. Los archivos quedaron en
`research/backtest-5y/data/_corruptos/`.

## El ranking

### Lo que estaba mal

```js
// worker.js:1446   recorre en el orden de la lista
for (const tk of BOT_TICKERS) { ... }
// worker.js:1839   y el que llega tarde se pierde sin registro
if (nPos >= MAX_POS_REAL) { log("descartada"); return; }
```

El cupo se lo llevaba el que apareciera primero en `BOT_TICKERS`: orden
alfabetico, no calidad. Y el descartado no quedaba anotado en ningun lado.

Esto importa mas de lo que parece. Los rechazos por falta de cupo pasan de 13
sobre 371 señales (universo 38) a **1.971 sobre 2.716** (universo 297). Y de los
3.530 candidatos que pasan el gate en la ventana OOS, **2.867 (81%) aparecen en
barras donde compiten con otros**. El reparto del cupo no es un detalle.

### Lo que se probo como criterio

Primera hipotesis: ordenar por **holgura del stop** (cuantos ATR hay entre la
compra y el stop). Tenia mecanismo — sobre el backtest, 36 de 61 trades mueren en
el stop (−$1.707.305) contra 16 que llegan al target (+$1.231.700), y con stops a
0,60 sigmas la probabilidad teorica de stop por ruido es 55%, o sea que la causa
de muerte es el ruido y no la tesis. Tambien descartaba el score: por corte da
34% / 31% / 71% / 33% de win rate (score >=7 / >=8 / >=9 / =10), sin monotonia y
con n de 7 y 3 en los dos ultimos — no predice.

Resultado del A/B sobre datos limpios (universo 297, OOS):

| Criterio | OOS gold | OOS cocos | n | win |
|---|---|---|---|---|
| Orden de llegada | −3,80% | −1,24% | 187 | 30,5% |
| Por holgura del stop | −3,71% | −1,51% | 155 | 26,5% |
| Por R:R | −3,42% | −0,91% | 181 | 28,2% |

Decimas de diferencia, todas negativas. **Ningun criterio rescata nada.**

## Estado del codigo

Nada de esto se deployo. Todo esta en local.

**`workers/niveles-auto/worker.js`** (backup `worker.js.bak-ranking`) — el ciclo
junta todos los candidatos del barrido y ejecuta despues, en bloque, en vez de
ejecutar al vuelo dentro del loop de analisis. Piezas: `CANDIDATOS_REAL`,
`ejecutarPorRanking()`, `paperSignal` devolviendo `true` solo si dejo la orden
colocada, dedup por ticker, y el ranking completo en el aviso de Telegram.

- `IOL_BOT_RANKING` (default **`llegada`**): con ese valor la decision es
  identica a la de hoy. Los criterios `holgura`, `rr` y `score` estan
  implementados pero apagados, porque ninguno sobrevivio la medicion.
- `BOT_QUEUE_LIMIT` (default 60): `main()` leia la cola con `.limit(20)`. Con 280
  papeles el barrido tardaba 15 minutos y, peor, el ranking terminaba comparando
  20 vecinos de tanda en vez del universo. Ahora el ranking **espera a que la
  cola se vacie**, con tope de seguridad de 20 minutos.
- **No hay cola persistida, a proposito.** Cuando se libera un lugar, la pasada
  siguiente re-evalua todo y entra el mejor candidato *vigente*. Una cola
  guardada mandaria la orden con niveles de hace horas.

Con `llegada` el cambio es inocuo: misma decision que hoy, pero con el ranking
visible en el aviso y sin candidatos que se pierdan en silencio.

**`research/universo-bot/`** — `panel.cjs` (el panel BYMA tiene 1.015 CEDEARs y
es casi todo humo: mediana de 32 nominales de volumen), `universo2.cjs` (filtro
spread ≤0,60% + subyacente en Yahoo + volatilidad anual 20-80%),
`IOL_BOT_TICKERS.txt` (**279 papeles**, 1.173 caracteres, entra en una env).

Sacados a mano por ser veneno para una logica de soportes: **VXX** (contango
estructural), **SPXL** (3x), **QQQD** y **AMDD** (inversos). En esos, un
"soporte" es un artefacto del decay, no un nivel con compradores. Los otros 19
ETFs (GLD, SLV, GDX, EWZ, SMH, ARKK) son long sin palanca y quedan.

**`research/backtest-5y/ranking-hoy.js`** — corre el motor sobre todo el universo
a precio de hoy. El 24/09, de 268 papeles con zona valida, **pasaban el gate 4**:

```
 #  papel  holgura  sigmas  R:R  score   compra    stop   target
 1  NU     0.63 ATR   1.05  2.3   7/10    13,58   13,24    14,38
 2  TEN    0.59 ATR   1.26  3.5   8/10    43,80   42,53    48,24
 3  ARKK   0.58 ATR   0.66  3.7   8/10    85,81   84,45    90,78
 4  ARM    0.23 ATR   0.28  4.4   7/10   252,92  249,53   267,69
```

## Lo que queda en pie

El cuello de botella del bot **no es el universo**. Con 268 papeles evaluados
pasan 4; con 48 pasan 1 o 2. Ampliar multiplica por seis los candidatos y empeora
el resultado.

Lo que sigue apareciendo en cada medicion es el stop. De los 4 candidatos de hoy,
el mejor tiene el stop a 1,26 sigmas y el peor a 0,28 — este ultimo con **78% de
probabilidad de que el ruido lo saque en un solo dia**. Mientras el stop siga
donde esta, ningun cambio de universo ni de orden de ejecucion mueve la aguja.
Eso ya lo sabiamos por el test de ATR; esta corrida lo vuelve a confirmar por
otro camino.
