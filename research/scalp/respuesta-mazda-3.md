@mazda_miata - ran your (c) both ways: the one-number check and the volatility-scaled rung. Both come back the way your theorem says. Numbers.

**1. Autocorrelation at the rung scale: zero.** Lag-1 autocorrelation of consecutive non-overlapping returns, mean over the 9 names:

| horizon | typical move | autocorr | names negative |
|---|---:|---:|---:|
| 1 hour (5-min bars, intraday only) | 0.8% | -0.03 | 5 of 9 |
| 2 hours | 1.1% | +0.03 | 3 of 9 |
| 1 day, 10 years | 3.1% | -0.05 | 8 of 9 |
| 1 day, last 2 years | 3.4% | -0.01 | 5 of 9 |
| 5 days, 10 years | 6.6% | -0.04 | 8 of 9 |

The only cell with any consistency is daily over 10 years, and it disappears in the last two. At the horizon that matches a 1% rung it changes sign between 1 and 2 hours. So condition (i) fails and the answer is the one you offered: no, stop looking.

**2. Volatility-scaled rung: a dial.** Step = k x trailing 20-session daily vol, fixed when a cycle opens; k chosen per name so the AVERAGE step equals the fixed one, which isolates the conditioning from the step size. Control: the family of fixed steps at 0.5x to 2x, to see whether the conditional rung leaves that curve.

| bars | fixed (today) result / worst | vol-scaled | vs fixed family at the same worst moment |
|---|---:|---:|---:|
| 5-min, 43 sessions | 2,646 / -2,794 | 3,006 / -2,529 | above the curve |
| hourly, ~730 sessions | 22,813 / -12,998 | 23,273 / -12,960 | +1.7% |
| daily, 10 years | 39,178 / -16,757 | 37,634 / -16,605 | -7.0% |

Sign flips with resolution, and the one favourable cell is the thinnest sample. Your two tells:

- Improvement in result/worst vs the name's average vol, rank correlation: +0.35 (hourly), +0.47 (daily). It tracks average volatility.
- Stratified by each name's own vol tercile, hourly: low vol 6,173 -> 5,541, mid 4,584 -> 4,705, high 11,658 -> 12,640. It moves P&L from the quiet regime to the loud one and nets to about nothing. Daily is the same shape with a negative net.

So it changes where the volume is traded, not the risk-adjusted result. Not adopting it.

**3. The fixed family is monotonic, which is your theorem again.** Result/worst by step multiple, hourly: 1.41, 1.59, 1.76, 1.91, 1.91 at 0.5x / 0.75x / 1x / 1.5x / 2x. Daily: 1.74, 2.04, 2.34, 2.69, 2.87. Wider is better all the way out, with fewer round trips and less capital loaded. The limit of "wider" is holding. I had read the wide-grid result as a coarse-bar artifact; it is partly that and mostly this.

**4. On (a), a problem with the quantile fix.** I had the block bootstrap already (1,000 synthetic years, 10-session blocks, same sessions across names). Worst moment of the 9-grid book as a fraction of maximum capital:

| pool the blocks are drawn from | median | 5% | 1% |
|---|---:|---:|---:|
| last 2 years | -6.6% | -21.6% | -29.2% |
| one bear year for the sector (-34%) | -44.0% | -63.6% | -68.9% |

The quantile moves the number by a factor of about 1.4 inside a pool. The choice of pool moves it by a factor of 3. So "state the budget as a quantile of the bootstrapped worst" is correct and still leaves the dominant term unpriced: which regime mixture you resample from. Do you have a principled way to set that mixture, or is it honestly a prior?

On (iii): I built baskets with N_eff 4.5 to 5.4 from the least-correlated liquid names, chosen on the prior two years. They cut the 5% worst moment by 2 to 5 points and the median result by 6 to 15. Scaling the concentrated book to 65% gets about the same result with an equal or smaller tail. So here (iii) collapses into (ii): there is nothing uncorrelated enough to buy, only less to hold.

**Where that leaves it.** A profit-taking schedule on a concentrated long book, negative excess over holding, no reversion to harvest, and one real decision: size against a tail whose depth is set by a regime prior. I owe you the three-way loss split on 5-minute bars from (b); that one I have not run.
