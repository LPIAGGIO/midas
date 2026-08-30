# Glosario metodológico BYMA — fórmulas de renta fija

Transcripto del PDF oficial de BYMA Educa que pasó LP (30/08/2026, "Glosario
metodológico", export Power BI de 6 páginas). Son las convenciones exactas del
mercado local. **Para qué sirve acá**: (1) calcular TIR/duration/sensibilidad
nativamente para los bonos que IOL no cubre — T30J7 devuelve "not found" en
`get_fixed_income_analytics` y TXMJ9 tampoco tiene analytics; (2) es la
especificación del Simulador de bonos del backlog (ranking + tabla de
sensibilidad); (3) ADTV como chequeo de liquidez para el bot.

## Valuación

**Precio teórico** — valor presente de los flujos a una tasa `y`:

    P(y) = Σ_{t=1..n}  CF_t / (1+y)^τ_t

La fracción de año depende de la convención: 30/360, ACT/365 o ACT/ACT.

**YTM** — la TIR que iguala el precio sucio con el valor presente:

    Precio_sucio = Σ  CF_t / (1+YTM)^τ_t        (se resuelve numéricamente)

**Precio sucio** = precio de cierre (con intereses corridos). Cuando aplica, se
convierte por la referencia FX definida.

**Intereses corridos**:

    IC = Cupon_periodo × (τ_devengado / τ_periodo)

**Precio limpio** = precio sucio − intereses corridos. Útil para comparar
instrumentos con distintas fechas de cupón.

**Valor técnico** = capital residual ajustado + intereses corridos ajustados.
En bonos CER o DL se aplica el factor de ajuste vigente a la fecha de
liquidación.

**Paridad** = (precio sucio / valor técnico) × 100. Mayor a 100 = premio;
menor = descuento.

**Current yield** = cupón anual / precio sucio. No incorpora amortizaciones ni
ganancias/pérdidas de capital.

## Riesgo de tasa

**Duration Macaulay** (años):

    D_Mac = Σ τ_t·PV(CF_t) / Σ PV(CF_t)        con PV(CF_t) = CF_t/(1+YTM)^τ_t

**Duration modificada**:  D_Mod = D_Mac / (1+YTM)

**En días**:  DM_dias = D_Mod × Base  (360 o 365)

**Convexity**:

    CX = [ Σ  CF_t·τ_t·(τ_t+1) / (1+YTM)^(τ_t+2) ] / Precio_sucio

**Sensibilidad lineal**:   ΔP ≈ −Precio_sucio × D_Mod × Δy
(para +100 bps, Δy = 0.0100)

**Sensibilidad con convexity** (mejor para shocks grandes):

    ΔP ≈ −P_sucio·D_Mod·Δy + ½·P_sucio·CX·(Δy)²

**WAL** — vida promedio ponderada por amortizaciones:

    WAL = Σ τ_t·Amort_t / Σ Amort_t            (no depende de la YTM)

## Tasas

**TNA** = rendimiento_periodo × 360/días — anualización lineal, no capitaliza.
**TEA** = (1 + rendimiento_periodo)^(1/τ) − 1 — con capitalización compuesta.
**TEM** = (1 + TEA)^(1/12) − 1.
**Convención de días**: τ_t = días(liquidación, flujo_t) / Base, con Base
30/360, ACT/365 o ACT/ACT.

## Ajustes (CER / dollar-linked / capitalizables)

**Factor CER** — OJO al lag contractual ℓ:

    FA_CER,t = CER_{t−ℓ} / CER_base

El capital técnico NO incorpora CER; el ajuste se aplica sobre intereses cash y
amortizaciones. Aplica a TXMJ9 (dual CER/TAMAR).

**Factor dollar-linked** — análogo con A3500:  FA_DL,t = A3500_{t−ℓ} / A3500_base

**Flujo técnico vs ajustado**:

    FlujoTotal_t = (InteresCash_t + AmortTecnica_t) × FA_t
    (si el bono no ajusta capital, FA_t = 1)

**Capitalización de intereses** — la parte del interés bruto que se suma al
capital residual técnico (BONCAPs como T30J7):

    Cap_t = InteresBruto_t × p_t^cap
    (el porcentaje puede variar por tramo según metadata)

## Liquidez

**ADTV** — promedio móvil del volumen efectivo, por especie, incluye la rueda
actual:

    ADTV_n = (1/n) Σ_{i=0..n−1} VolumenEfectivo_{t−i}

## Qué NO hace falta implementar

TNA/TEA/TEM, paridad y current yield ya existen en Midas o vienen de IOL
(`get_fixed_income_analytics`). Lo valioso es el bloque de riesgo de tasa +
ajustes, que es lo que falta para los bonos en pesos y para el Simulador.
