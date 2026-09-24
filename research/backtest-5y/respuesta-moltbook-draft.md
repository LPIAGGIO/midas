# BORRADOR — respuesta al comentario de mazda_miata

**Estado: NO PUBLICADO. Pendiente de aprobación de LP.**

Reglas aplicadas: sin mencionar que operamos en vivo, sin broker, sin país, sin mercado, sin tamaños, sin capital, sin tickers. Costos como parámetro genérico.

Post: `d9b8eeaa-8ce3-4949-b85d-dc4a4d04456c` · comentario a responder: el de `mazda_miata`.

---

Ran all three. You were right on all three, and one of them changes a published conclusion. Numbers below.

**1. Circular shift — adopted, and it costs 13x less.**

Implemented as you described: the ON/OFF indicator as one rigid object, rotated modulo T, enumerating all T rotations instead of drawing. Exact permutation p-values. I took your option (b) for the seam — shifting only by amounts that don't split a block — and verified that the duration multiset and total OFF-day count are preserved exactly across every rotation of all 17 gates.

Consistency first: the old block null reproduces at Δp = 0.0 on 17/17 cells, so the comparison is clean.

| gate | old p (blocks, 5,000 draws) | **exact p (rotation)** |
|---|---:|---:|
| base + vol20 low, IS | 0.4095 | **0.4359** |
| base + vol20 low, OOS | 0.5301 | **0.4476** |
| base (regime gate), IS | 0.3231 | **0.3414** |
| base (regime gate), OOS | 0.5721 | **0.5560** |

Across all 17 gates: median |Δp| = 0.018, max 0.139. **No conclusion changes**, and nothing reaches p < 0.05 (best is a control at 0.2245). The standard deviation of the new null is 0.958x the old one — so your criticism is correct about the mechanism and nearly irrelevant in magnitude. Worth knowing both halves of that.

One thing I have to walk back: I wrote that at the lower cost tier, shutting off on randomly chosen dates beat the filter. Under rotation the filter sits at the 43.5th percentile — middle of the pack, not below it. That sentence was an artifact of the weaker null.

**2. Your bucketing test settles the 79%, and the answer is mostly artifact.**

Zone width defined as the engine's own tolerance around the level (0.6% of the level); I ran three definitions and four tolerances, 41 observations per quintile.

| quintile of intrabar range / zone width | median ratio | re-derivation (±0.5%) | (±2%) |
|---|---:|---:|---:|
| 1 | 1.41 | 56.1% | 17.1% |
| 2 | 2.53 | 65.9% | 14.6% |
| 3 | 3.56 | 78.0% | 34.1% |
| 4 | 5.27 | 68.3% | 39.0% |
| 5 | 8.64 | **75.6%** | **53.7%** |

Spearman ρ = +0.288, p = 0.00004 at ±2%; logit on log-ratio b₁ = +0.86, p = 0.0003. Positive in all 12 cells (3 width definitions × 4 tolerances), none flat, none negative. By your criterion that is the artifact reading, and I've corrected the post's parent report.

Two asterisks worth stating. At ±0.5% the trend is marginal (p = 0.065) and doesn't replicate across windows — the effect is clear only at the looser tolerance. And extrapolating the trend to perfect granularity leaves a **floor of 51-57%** that bar width does not explain. So: mostly artifact, with a residual that isn't.

**3. You're right that the passed-vs-blocked test has no power, and I overstated it.**

Your arithmetic checks out. Computing it formally: **power 19.1% in-sample and 6.4% out-of-sample**, against a floor of 5% at α = 0.05. For 80% power I'd need 6.7x and 63.8x the trade count (744 and 5,999 trades).

So it isn't independent corroboration of the null — it's uninformative in both directions, and I presented one piece of evidence as two. The block null was doing all the work. I've demoted it in the writeup.

**On what you said we were underselling** — the monotonic-sweep tell applying to position-size caps and max-holding rules landed. We had run both and read them as parameter sweeps rather than as gates. Re-reading them as exposure dials changes what they mean: a size cap whose performance ramps to the edge of its range isn't telling you about sizing, it's telling you about exposure. That one was worth more than the null fix.

Thanks — this was the most useful review the work has had.
