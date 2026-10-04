We measured a ladder grid on volatile large caps. Every stop we tested lost money, removing the stop made it profitable, and I don't trust the reason. Plan below; please attack it.

## The grid

Long only, one instrument per grid. Buy one lot at the touch; if price falls one step (0.7% to 1.5% depending on the name's volatility) buy another, up to 5 lots. Each lot has its own resting sell at cost + 0.5% to 1.0%. When a lot sells, the grid re-arms that rung. Cost assumption: 0.06% per side.

## What the measurements said

Path simulation on 5 years of daily bars, about 3 years of hourly bars and 43 sessions of 5-minute bars. 291 names for the stop question, 9 names for the rule variants.

**1. The stop is what loses.** One representative name, 5 years, grid capital 2,300 units:

| stop from anchor | total | round trips | stops hit | days fully loaded |
|---|---:|---:|---:|---:|
| 5% | -6,912 | 2,809 | 212 | 4% |
| 10% | -4,643 | 2,239 | 73 | 28% |
| 20% | -433 | 1,491 | 18 | 54% |
| none | +2,895 | 560 | 0 | 84% |

Across 291 names: flat at every close, 0 positive. 5% stop, 2 positive. No stop, 197 positive, median +521 on 2,300. The sweep is monotonic to the edge of the range. By the rule from my previous post that is the signature of an exposure dial, not of a signal, and I think that is exactly what it is: the stop realizes the loss, the no-stop grid waits for the name to come back.

**2. Without the stop it is not scalping.** The grid sits fully loaded 84% of days. Longest loaded stretch: 509 days. One calendar year had zero round trips. Buy-and-hold of the same name with the same capital made about 10x more. The grid is a capped long position with staggered exits. Realized P&L is positive by construction; everything bad lives in the open position, so we report realized + open and nothing else.

**3. You cannot pick the survivors in advance.** The names that later lost 75% to 93% of grid capital were in the top quintile by trailing 3-year return at the start and above their 200-day average. Top quintile by trailing return: 50% of grids positive, 19% lost more than half the grid. Other four quintiles: 73% to 78% positive, 0% to 5% ruin. A "start cycles only above the 200-day average" filter changed nothing, because the grid is already loaded when the name turns. One sector went 15 of 15 positive in the last 5 years and 7 of 8 negative over the 10 years after its 2000 peak.

**4. Variants on top.**

- Flat at the close: worse in every sample. For the representative name, close-to-open returned +504% over the 5 years and open-to-close +117%.
- Averaging lot: when all 5 rungs are full and price reaches twice the grid depth, buy 50% of the position and exit everything at average cost + target. About +25% to +30% result for 1.5x capital.
- Two accounts running the same grid with offsets (delayed entry, wider or tighter steps): no benefit. Both end up loaded at the same time 55% to 80% of the time, because the offset disappears exactly when the name falls in a straight line.
- Starting the session one hour late (no orders in the first hour): +17% to +20% result with fewer round trips, 9 of 9 names on hourly bars, all four calendar years. Later than that adds nothing consistent.
- Idle rule: after 60 minutes with no fills and at most 2 rungs loaded, buy half a lot at the market, own exit at cost + target. +30% to +40% result, 20% to 25% deeper worst moment, and more capital in use. Return on peak capital improves only slightly. It is mostly more money at work, not a new edge.

**5. Bar granularity biases the levels, not the ordering.** Same 43 sessions on 5-minute, hourly and daily bars: no-stop +424, +305, +313. Coarse bars understate high-turnover variants by about 25%. The ranking between variants held at all three resolutions.

## The plan

Nine volatile large caps, one grid each, no stop, the averaging lot, the idle rule, carry overnight. The only risk control left is size: maximum lots per name and the number of names. The portfolio would sit near maximum exposure 75% to 82% of the time.

## What I'd like attacked

1. **Is there any test that separates "the grid has an edge" from "the grid is long beta with a profit-taking schedule, in a sample where these names went up"?** My candidate null: same exposure path, exits at random times. I have not found a construction that keeps the exposure path fixed without also fixing the exits.
2. **Nine names from two neighbouring sectors is closer to one bet than to nine.** How would you size this? Cap on simultaneous loaded grids, a portfolio-level exposure stop, or accept it and cut names?
3. **The idle rule and the first-hour rule were each measured after watching a single session.** Hourly bars cover 730 sessions, but the hypotheses came from the data. How much would you haircut them?
4. **What kills this that I haven't listed?** A multi-year sector drawdown is the obvious one. I'm looking for the non-obvious ones.
