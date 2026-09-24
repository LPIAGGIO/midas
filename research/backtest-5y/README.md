# backtest-5y — el motor del bot, corrido sobre la historia

Port del motor de señales de `workers/niveles-auto/worker.js` a un simulador
histórico offline, sobre las series de `data/` (ver `INVENTARIO.md`).

Todo corre local. **No toca el VPS, ni Supabase, ni ninguna tabla viva.**
No se commiteó nada.

```
node simulate.js                  # corrida completa → results.json + run.log
node simulate.js --resenales      # fuerza regenerar signals.json (el cache)
node simulate.js --coincidencia   # sólo el chequeo del port contra lo real
```

Los scripts de esta carpeta son **ESM** (el `package.json` de la raíz de Midas
tiene `"type": "module"`): usan `import`, no `require`. Si alguno se escribe en
CommonJS, `node` lo rechaza.

**Cuidado con `--sinDSR` y con cortar una corrida a mano:** cada script
sobreescribe su `results-*.json` al terminar, así que una corrida parcial deja el
archivo mutilado y rompe a los anexos que lo leen (`fino.js` lee
`results-barrido.json` para el N del DSR). Si pasa, se arregla volviendo a correr
el script completo — la huella FNV-1a del informe tiene que volver a dar igual.

Tarda ~15 s la primera vez (genera las 56.000 señales y las cachea en
`signals.json`, 14 MB) y ~4 s con el cache puesto.

## Archivos

| Archivo | Qué es |
|---|---|
| `engine.js` | El motor portado. Copia funcional de las primitivas del worker (pivotes, zonas, score, patrones, divergencias, POC, perfil de volumen, ATR, régimen) más `analyzeKit()` (el kit entrada/stop/target) y `gatePasa()` (el filtro de entrada del bot). |
| `simulate.js` | Genera el flujo de señales barra por barra, aplica gates, simula la cartera con las reglas de ejecución del worker y calcula métricas, walk-forward, barrido de robustez y DSR. |
| `signals.json` | Cache del flujo CRUDO de señales (55.937). Se regenera solo. |
| `results.json` | Todo el detalle: cada corrida, sus trades, la curva de equity diaria, los cortes y el DSR. |
| `run.log` | La salida de consola de la última corrida. |
| `INFORME.md` | El informe. |
| `recompra.js` | Anexo: ¿conviene recomprar la mitad que vende el TP parcial? Reusa `engine.js` y el cache `signals.json`; su caso base reproduce exacto el `38/base` de `simulate.js`. `--solo-is` corre sólo el in-sample. |
| `results-recompra.json` · `run-recompra.log` | Detalle y consola de ese anexo. |
| `INFORME-RECOMPRA.md` | El informe del anexo. |
| `nulo.js` | Anexo: ¿el filtro de régimen selecciona o sólo recorta exposición? Dos modelos nulos (trades al azar / bloques de calendario al azar, 5.000 sorteos, **semilla 20260917**), test de expectancy pasa-vs-bloquea, auditoría de lookahead en las etiquetas de régimen y fase del apagado. Reusa `engine.js` y el cache `signals.json`; su chequeo de arranque reproduce las 20 celdas de `INFORME.md` §3 con Δ = 0. `--draws=N` cambia la cantidad de sorteos. |
| `results-nulo.json` · `run-nulo.log` | Detalle y consola de ese anexo. |
| `INFORME-NULO.md` | El informe del anexo. **Corrige la §3 y la §8 de `INFORME.md`.** |
| `timestop.js` | Anexo: ¿conviene un time-stop DESPUÉS del fill? (hipótesis de Locke & Mann, JFE 2005). P&L por duración controlado por camino de salida, barrido de H con dos relojes (barras de mercado y horas corridas), los mismos dos nulos (**semilla 20260917**, 5.000 sorteos) y la versión con mecanismo ("salir cuando el motor ya no generaría la señal"). Reusa `engine.js` y el cache `signals.json`; el chequeo de arranque reproduce el `38/base` con Δ = 0 y el replayer de trades reproduce la cartera en 205/205. `--draws=N` cambia los sorteos, `--sinD` saltea el bloque D (el caro). |
| `results-timestop.json` · `run-timestop.log` | Detalle y consola de ese anexo. |
| `INFORME-TIMESTOP.md` | El informe del anexo. **Corrige la duración reportada en la §1 de `INFORME.md`** (estaba en horas corridas, no de mercado). |
| `barrido.js` | Anexo: ¿el barrido de un soporte se distingue del quiebre EN EL MOMENTO DE ENTRAR? Penetración post-entrada normalizada por ATR14 y test de bimodalidad, el test primario pre-registrado ("la zona aguanta" vs "la zona cedió", evaluado en la barra del fill), cinco features point-in-time de lista cerrada, el nulo de descarte aleatorio (**semilla 20260917**, 5.000 sorteos) y el recálculo del 79% de `INFORME-TIMESTOP.md` con cuatro tolerancias de "misma zona". Reusa `engine.js` y el cache `signals.json`; el chequeo de arranque reproduce el `38/base` con Δ = 0, el replayer 205/205 trades, la equity reconstruida 730/730 ruedas y la zona de la señal 205/205. `--draws=N` cambia los sorteos, `--sinDSR` saltea la reconstrucción del N. |
| `results-barrido.json` · `run-barrido.log` | Detalle y consola de ese anexo. |
| `INFORME-BARRIDO.md` | El informe del anexo. **Corrige el 79% de `INFORME-TIMESTOP.md` §4** (depende de la tolerancia: 79,2% con ±0,5%, 37,1% con ±2%) y confirma que la señal muere igual (202/205) con cualquier tolerancia. |
| `bajar1m.js` | Baja velas de **1 minuto** (Yahoo, `range=7d&interval=1m`) de los tickers con fill en la última semana → `data-1m/`. Sólo para el control fino del anexo siguiente. |
| `fino.js` | Anexo: ¿la variable de `INFORME-BARRIDO.md` (la barra del fill cerró arriba o abajo del nivel) se vuelve ACCIONABLE con granularidad fina? Reconstruye la variable a 5 minutos, barre el horizonte de decisión H ∈ {5,10,15,20,30,45,60}, corre el nulo de soltar al azar (**semilla 20260917**, 5.000 sorteos, dos versiones: momento al azar y mismo H) y repite todo a 1 minuto sobre la última semana. **No usa `engine.js` ni `signals.json`**: la muestra son las 157 señales llenadas del libro paper/sombra (`research/backtest-reglas/paper_trades_export.json`) sobre barras de 5m de `research/backtest-reglas/data`. `--draws=N` cambia los sorteos, `--sin1m` saltea el bloque D. |
| `results-fino.json` · `run-fino.log` | Detalle y consola de ese anexo. |
| `INFORME-FINO.md` | El informe del anexo. **Estudio de factibilidad, no medición.** La variable se determina en la 1ª barra de 5m (mediana 5'), la señal cruda se replica (p ≤ 0,003 desde los 10'), pero ejecutarla no le gana al nulo en ningún horizonte (percentil máximo 59,3) y entre el 52% y el 93% del delta aparente es la bonificación intradiaria de la comisión, no el precio. **Deja constancia de que H = 60 NO reproduce el resultado negativo de `INFORME-BARRIDO.md` §5** y de por qué. |
| `cocos.js` | Anexo: el mismo estudio con la tarifa de **Cocos** como cuarta columna (`FEE_COCOS = 0.0005 * IVA` = 0,0605% por punta, 0,121% ida y vuelta, tomada literal de `workers/niveles-auto/worker.js`). Re-corre el caso base de los 38 y de los 50, la descomposición CCL vs papel, y las cinco hipótesis muertas del proyecto (recompra, time-stop, zona cedida, filtro de volatilidad, score ≥ 9), cada una con su modelo nulo (**semilla 20260917**, 5.000 sorteos). Reusa `engine.js` y el cache `signals.json`; el chequeo de arranque compara 84 métricas de gold/platinum/black contra `results.json` y **aborta si hay un solo descuadre**. `--draws=N` cambia los sorteos, `--sinDSR` saltea la reconstrucción del N (la cara: incluye las 6 corridas de "razón muerta"). |
| `results-cocos.json` · `run-cocos.log` | Detalle y consola de ese anexo. |
| `INFORME-COCOS.md` | El informe del anexo. **Da vuelta el signo de `INFORME.md`**: con Cocos el caso base pasa a +0,26%/mes (IS) y +0,32%/mes (OOS), y los 50 a +0,88% y +0,74%. De las cinco hipótesis, sólo la recompra a mitad de camino al stop revive a medias (no le gana al nulo en el IS); el time-stop, la zona cedida y el filtro de volatilidad siguen muertos. **En el in-sample todo el resultado positivo es el arrastre del CCL, no el papel.** No alcanza para el piso de 3% mensual: ni con costo cero, el techo es +0,48%/mes. |
| `agresividad.js` | Anexo: ¿se llega al 3% mensual entrando más agresivo y más grande? Barrido de agresividad de entrada (nivel exacto · límite +0,25% / +0,50% / +1,00% · a mercado al cierre de la barra de la señal y a la apertura de la siguiente), las dos convenciones de stop/target (fijos al nivel o móviles con la entrada), barrido de tamaño (20% a 60% por posición × 3/5/8/10 posiciones) con exposición bruta y apalancamiento requerido medidos, grilla combinada, walk-forward estricto con tres modelos nulos (**semilla 20260917**, 5.000 sorteos), barrido de spread calibrado contra `cedear_fv_log` y el control de buy & hold que faltaba en todo el proyecto. Reusa `engine.js` y el cache `signals.json`; el chequeo de arranque compara 56 métricas de las cuatro tarifas contra `results.json` y `results-cocos.json` y **aborta si hay un solo descuadre**. `--draws=N` cambia los sorteos, `--sinNulo` saltea el bloque E.2. |
| `results-agresividad.json` · `run-agresividad.log` | Detalle y consola de ese anexo. |
| `INFORME-AGRESIVIDAD.md` | El informe del anexo. **Agrega un costo que ningún informe anterior tenía: el spread del CEDEAR (0,25% medido, el doble de la comisión de Cocos), que baja el caso base de +0,26%/+0,32% a +0,12%/+0,16%.** El nivel de entrada está 4,4% por debajo del spot, así que subir el límite 1% sólo mueve el llenado de 21% a 29%; el único escalón que llena de verdad es entrar a mercado, y ahí los trades que NUNCA bajaron al nivel rinden +1,75% bruto contra −1,05% de los que sí (p < 0,0001 en las dos ventanas). La celda elegida en el IS aguanta el OOS (+2,23% → +2,44%) pero no llega a 3%, no le gana al nulo de selección en el IS y su exceso sobre estar comprado a la misma exposición es cero. Llegar a 3% pide 2-3x de apalancamiento y drawdowns de 17-22%. |

| `parcial.js` | Anexo: ¿dónde va el **TP parcial** ahora que la entrada es a mercado? Barre el punto de disparo (sin parcial · 25% / 40% / 50% / 60% / 75% del camino al target · breakeven +0,5% / +1% / +2%) × la fracción vendida (25% / 50% / 75%), con y sin la **guarda de breakeven** (que el parcial nunca se ejecute en pérdida) y con y sin el spread de 0,25%, sobre la configuración congelada que eligió `INFORME-AGRESIVIDAD` (mercado a la apertura siguiente, stop/target móviles, 30% por posición, sin apalancar). Mide caminos de salida por trade, el efecto sobre la cola derecha, walk-forward estricto y cuatro modelos nulos (**semilla 20260917**, 5.000 sorteos), incluido el nulo propio de la pregunta: el parcial puesto en un punto al azar del camino. Reusa `engine.js` y el cache `signals.json`; el chequeo de arranque compara 80 métricas contra `results.json`, `results-cocos.json` y `results-agresividad.json` y **aborta si hay un solo descuadre**. `--draws=N` cambia los sorteos, `--sinNulo` saltea el bloque F. |
| `results-parcial.json` · `run-parcial.log` | Detalle y consola de ese anexo. |
| `INFORME-PARCIAL.md` | El informe del anexo. **La guarda del breakeven es redundante** (0 trades en 200 celdas: el disparo más agresivo cae en +0,68% y el breakeven está en +0,12%, porque el gate exige R:R ≥ 2). **El parámetro que corre hoy —mitad de la posición al 50% del camino— queda 14º de 25 en el in-sample**: la ganadora es apagar el parcial (+2,81% IS → +2,69% OOS contra +2,23% / +2,44%, con menos drawdown). Vender menos es mejor en 15 de 16 comparaciones y vender más tarde es mejor en casi todas. El parcial baja la varianza y recorta la cola derecha, pero **no compra drawdown**. La mejora no le gana al nulo del punto al azar en el IS (p = 0,075) y el bootstrap incluye el cero en las dos ventanas. **Con el spread de 0,25%, las 25 configuraciones dan exceso negativo contra SPY en pesos a la misma exposición.** |

| `placebo.js` | Anexo: **el test placebo**. ¿El motor y el simulador encuentran edge donde por construcción no hay nada? Corre la cañería COMPLETA (motor → gate del worker → cartera → tarifa de Cocos) sobre **400 universos sintéticos** de los 38 limpios: random walk gaussiano con la misma volatilidad y drift, bootstrap de los retornos horarios reales, bootstrap de bloques de 5 barras, y un cuarto control propio con los retornos centrados (drift 0), 100 universos cada uno, **semilla 20260917**, en `worker_threads`. Cada uno con el **CCL real y con el CCL aleatorizado sin deriva** (sorteo pareado). Agrega tres variantes de diagnóstico del simulador (orden intrabarra de stop/target, fill al cierre en vez de al toque, stop que paga el gap de apertura) y un control de construcción `ident`. **NO reusa `signals.json`: lo regenera desde `engine.js` y aborta si el flujo no coincide señal por señal** (huella FNV-1a) o si el caso base de Cocos no reproduce +0,2603% / +0,3236%. `--univ=N` cambia los universos, `--hilos=N` los hilos, `--soloChequeo` corre sólo el chequeo de arranque. |
| `results-placebo.json` · `run-placebo.log` | Detalle y consola de ese anexo. |
| `INFORME-PLACEBO.md` | El informe del anexo. **El motor NO fabrica señal** (sobre series sin información entrega −0,02%/−0,05% mensual, que es el costo; el residuo es el término de Jensen) **pero el edge medido no sobrevive**: el caso base cae en el percentil 58 (IS) y 62 (OOS) del bootstrap de retornos reales, p = 0,43 y 0,39, y en 42 de cada 100 universos de ruido el motor sacó más plata que con los datos de verdad. Con el CCL sin deriva el in-sample real se va a −0,17%/mes y cae al percentil 17. **Corrige el nivel absoluto de todo el proyecto**: el stop se ejecutaba siempre en el nivel exacto aunque la barra abriera por debajo, y cobrar ese gap cuesta 0,33 pp/mes (IS) y 0,29 pp/mes (OOS). |

| `rotacion.js` | Anexo: **la revisión de un tercero** (usuario `mazda_miata`, sobre el método publicado en el foro). Reemplaza el nulo de bloques de `nulo.js` por el **nulo de ROTACIÓN CIRCULAR** —la serie indicadora de encendido/apagado se toma como objeto rígido y se rota módulo T, `estado[(t+j) mod T]`—, que preserva el multiconjunto de duraciones, el orden de los bloques y los huecos, y cuyo p es **EXACTO por enumeración de las T rotaciones**, no Monte Carlo. El artefacto de costura se resuelve restringiendo las rotaciones a las que no parten ningún bloque (verificado: días apagados y multiconjunto de duraciones conservados en las T rotaciones de los 17 gates). Corre además el test de granularidad del 79% (tasa de re-derivación contra el rango intrabarra en unidades del ancho de la zona, tres definiciones de ancho × cuatro tolerancias, Spearman + logit) y el **poder estadístico formal** del test de pasa-vs-bloquea. Reusa `engine.js` y el cache `signals.json`; el chequeo de arranque reproduce las 20 celdas de `INFORME.md` §3 con Δ = 0, **el nulo de bloques publicado en 17/17 celdas con Δp = 0** (consume el PRNG en el mismo orden que `nulo.js`), la zona de la señal en 205/205 trades y la tabla del 79% de `INFORME-BARRIDO.md` §6 en 12/12 celdas. `--draws=N` cambia los sorteos del nulo VIEJO, `--sinViejo` saltea su reproducción (el bloque caro). |
| `results-rotacion.json` · `run-rotacion.log` | Detalle y consola de ese anexo. |
| `INFORME-ROTACION.md` | El informe del anexo. **El nulo de bloques no era plenamente intercambiable y se reemplaza por rotación circular, pero ninguna conclusión cambia**: los 17 gates siguen sin llegar a p < 0,05 (filtro de volatilidad 0,4359 IS y 0,4476 OOS contra 0,4095 y 0,5301 publicados; mediana de la diferencia absoluta de p = 0,012; el desvío del nulo nuevo es 0,958× el del viejo). **Corrige el §6 de `INFORME-BARRIDO.md`**: la tasa de re-derivación NO es plana contra el rango intrabarra —crece en las 12 celdas, de 17,1% a 53,7% con ±2% (ρ = 0,29, p = 0,00004)—, o sea que buena parte del 79% SÍ es artefacto de granularidad, aunque queda un piso de 51-57% (±0,5%) que la granularidad no explica. **Y anula uno de los cuatro apoyos del §8 de `INFORME-NULO.md`**: el test de pasa-vs-bloquea tiene 19,1% de potencia en el IS y 6,4% en el OOS (el piso es 5%) y necesitaría 744 y 5.999 trades para llegar al 80%: no es corroboración independiente, es no informativo en las dos direcciones. No agrega configuraciones al N del DSR, que queda en 372. |

## Qué se portó, tal cual está hoy

Constantes tomadas del worker sin tocar (config "NUEVA", congelada el
16/09/2026): `LB=5`, `ZONE_TOL=0,6%`, `BOT_RISK=1,5%`, `MAX_POS_PCT=0,20`,
`MAX_POS=5`, `MAX_ENTRADAS_DIA=5`, `BOT_VENTANA_H=48`,
`TP_PARCIAL_FRAC_CAMINO=0,5`, trailing desde +2R, comisión IOL por perfil +
IVA + derechos, bonificación intradiaria en la segunda pata. **OJO con
`TP_PARCIAL_FRAC_CAMINO` (medido el 18/09 en `INFORME-PARCIAL.md`): ese 0,5 se
congeló cuando la entrada era una límite en el soporte; con la entrada a mercado
del `INFORME-AGRESIVIDAD` queda 14º de 25 en el in-sample y cuesta entre 0,25 y
0,58 puntos mensuales contra apagarlo.**

Cadena de decisión replicada: pivotes diario(1y, lb=5) + horario(60m, 1mes,
lb=5) → zonas de ±0,6% → score 1-10 (toques, volumen del pivote, confluencia
EMA 21/50/200, confluencia de temporalidad) → ajustes por patrón de velas,
divergencia RSI, POC, respaldo de volumen, estructura y contra-tendencia →
entrada = techo de la zona de soporte más cercana debajo del spot, stop =
0,7% bajo el piso de la zona de abajo (o 1×ATR), target = piso de la zona de
resistencia más cercana arriba → R:R → filtro (score ≥ 7, R:R ≥ 2, sin
contra-tendencia, régimen risk_on o mixto con score ≥ 8 y R:R ≥ 2,5 a mitad
de riesgo).

Ejecución replicada: orden límite que vive 48 h, fill cuando el papel toca el
nivel, TP parcial de la mitad al 50% del camino, trailing desde +2R que nunca
baja, stop, target, comisión por punta con bonificación intradiaria.

## Qué se aproximó, y por qué

Esto es lo que hay que tener en la cabeza al leer cualquier número:

1. **Granularidad horaria.** El worker mira el precio cada 60 segundos; acá la
   unidad mínima es la barra de 60 minutos. De ahí salen tres aproximaciones:
   - El **spot** de la evaluación es el cierre de la barra horaria, no el
     último precio de data912. Esto solo mueve la elección de zona cuando el
     precio está pegado a un nivel (ver §"coincidencia" del informe).
   - La **confirmación anti-fantasma de 150 s** (entradas) no se simula: si la
     barra tocó el límite, la orden se llena al límite.
   - La **confirmación de salida de 10 minutos** tampoco es observable. El
     caso base sale por toque intrabarra (pesimista, ignora la confirmación);
     se reporta aparte la variante "salida confirmada al cierre de la barra"
     (optimista, equivale a confirmar 60 minutos). La verdad está en el medio.
2. **Barra parcial de la rueda en curso.** La ventana diaria de 1 año se arma
   con ruedas completas más una barra parcial del día armada con las horarias
   ya cerradas. Los pivotes diarios se confirman sólo sobre las completas: un
   pivote diario puede aparecer un día más tarde que en el worker.
3. **Sin libro de puntas.** El worker vende los stops contra el bid y redondea
   al tick del instrumento. Acá no hay spread ni tick: la salida por stop se
   ejecuta en el nivel exacto. Eso hace el backtest **optimista** en los stops.
   **Medido desde `placebo.js` (19/09/2026): el stop se llena en el nivel
   exacto incluso cuando la barra ABRIÓ por debajo, o sea que el backtest nunca
   paga un gap.** Ejecutando el stop en la apertura cuando la barra abrió
   debajo del nivel, el caso base de Cocos pasa de +0,26%/+0,32% mensual a
   **−0,07%/+0,03%**. Son 0,33 y 0,29 puntos mensuales, que van **encima** del
   descuento por spread del punto siguiente.
   **Medido desde `agresividad.js` (18/09/2026):** la horquilla media de los
   CEDEARs del universo es **0,25%** (`cedear_fv_log`, 209 papeles, 71 días).
   Cobrando media horquilla por punta que cruza, el caso base de Cocos pasa de
   +0,26%/+0,32% mensual a **+0,12%/+0,16%**. Todos los números de los informes
   anteriores a `INFORME-AGRESIVIDAD.md` hay que leerlos con ese descuento.
4. **Sin volumen intradiario del CEDEAR.** El volumen que puntúa los pivotes
   horarios es el del subyacente en NYSE, no el del CEDEAR local.
5. **Sin earnings.** El worker bloquea entradas si el papel reporta en ≤ 3
   días. No hay serie histórica de fechas de earnings, así que ese bloqueo no
   está: el backtest opera algunas señales que el bot real hubiera descartado.
6. **Sin alertas de TradingView ni cola manual.** El worker analiza lo que LP
   encola y lo que el bot encola solo; acá se evalúan los 50 papeles en cada
   barra horaria, que es el caso "el bot mira todo".
7. **Conversión a pesos con `conv = 1` y cantidad fraccionaria.** No tenemos
   el ratio de CEDEAR de los 50 papeles, así que el nocional se mide como
   `USD × CCL` y la cantidad puede ser fraccionaria. Con ratios reales
   (unidades de $10k-$300k) el redondeo a entero es de segundo orden frente al
   tope del 20% por posición, que es el que manda el tamaño en todos los
   trades. El CCL entra por día de rueda (la serie de argentinadatos viene por
   día corrido y arrastra el último valor — ver INVENTARIO §3).
8. **Un solo libro.** No se modela el libro sombra ni el desplazo por cercanía
   (regla del 13/09): cuando no entra por capital, la señal se descarta.

## Anti-lookahead (lo que se cuidó a propósito)

- La señal emitida en la barra `i` recién puede llenarse en la barra `i+1`
  (`created = ts + 1 ms`). Si no, el mínimo de la propia barra que generó la
  señal la estaría llenando.
- La ventana diaria usa ruedas con fecha **estrictamente anterior** a la rueda
  en curso.
- Los features de régimen (SPY sobre EMA200/EMA50, volatilidad 20d) se leen
  **con un día de rezago**: el dato de la rueda D recién se conoce al cierre.
- El umbral de "volatilidad alta/baja" es la **mediana del in-sample**, fija;
  no se recalcula en el out-of-sample. **OJO (corregido el 17/09 en
  `INFORME-NULO.md` §4.2): eso alcanza para el OOS pero no para el IS — esa
  mediana se calcula con todo el in-sample y se aplica también a la primera
  rueda del in-sample, o sea que hay lookahead dentro del IS. Vale hasta 0,43
  puntos mensuales. Las versiones point-in-time están en `nulo.js`.**
- El walk-forward es estricto: todo se eligió mirando IS (2023-10 → 2025-06) y
  el OOS (2025-07 → 2026-09) se corrió una sola vez, sin retocar nada.

## Chequeos que corren solos

- **Self-check del motor**: 40 barras al azar comparando el camino rápido
  (cacheado) contra el camino lento y literal (`analyzeAsOf`). Tiene que dar
  40/40; si baja, el cache está mintiendo.
- **Coincidencia del port**: los niveles que el motor produce contra los que el
  worker emitió de verdad en los últimos 60 días (`nivel_track_export.json` y
  `paper_trades_export.json` de `research/backtest-reglas/`).

## Convenciones heredadas de research/backtest-reglas

Comisión IOL por punta = comisión del perfil × IVA + derechos de mercado ×
IVA: **Gold 0,6655%**, **Platinum 0,4235%**, **Black 0,1815%**. Segunda pata
bonificada (compra y venta el mismo día): sólo derechos, 0,0605%. Capital
$7.000.000. Las tres tarifas se calculan en paralelo sobre los mismos trades.

Desde `cocos.js` hay una cuarta: **Cocos 0,0605% por punta**
(`FEE_COCOS = 0.0005 * IVA` del worker — el broker no cobra comisión, se pagan
sólo derechos de mercado más IVA), **0,121% de ida y vuelta**, sin bonificación
intradiaria que modelar porque las dos patas cuestan igual. No incluye caución:
el backtest no se apalanca nunca. `simulate.js` y los anexos anteriores siguen
corriendo con las tres de IOL; la cuarta vive sólo en `cocos.js`.
