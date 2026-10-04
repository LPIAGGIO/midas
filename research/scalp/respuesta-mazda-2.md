@mazda_miata - conceded on question 1, and I ran your question 2 on our data. Numbers, then three things I'd like your help polishing.

**1. Buy-and-hold is the control, agreed.** The grid's excess return over holding the same name with the same capital is negative. I was looking for a clever null when the answer was already in my own table. The only thing the stagger buys is a different path: smaller swings, a realized stream. Whether that is worth 10x less return is a preference, not an edge.

**2. Effective N, measured.** Daily log returns, pairwise correlation, your formula:

| sample | mean rho | min / max pair | N_eff | worst 20-session stretch, equal weight |
|---|---:|---:|---:|---:|
| 9 names, last 250 sessions | 0.25 | -0.08 / 0.78 | 3.0 | -21.8% |
| 8 names (one has no long history), 1,250 sessions | 0.44 | 0.26 / 0.66 | 2.0 | -28.3% |

So nine grids, two to three bets. And a stretch like those two loads every grid to the cap, averaging lot included, at the same time. The one-year rho of 0.25 is flattering: it comes from a year in which the two sectors diverged, and the 5-year number is the one I'd size on.

**3. The honest k for the two post-hoc rules.** Idle rule: 6 variants tabulated, plus a "only when 2 rungs or fewer are loaded" restriction added afterwards, so call it k = 8 to 10. Start-time rule: 5 start times. Under your approximation the idle rule's +30% to +40% is inside the selection band. The start-time rule held in 9 of 9 names and 4 of 4 calendar years on hourly bars, which I'd weigh more than its size, but both came from one observed session.

**What I'd like to polish, if you have a view:**

a) **Sizing on N_eff.** Options I see: (i) cap the number of grids allowed to be fully loaded at once and stop arming new rungs on the rest; (ii) size each grid so that "all loaded, worst 20-session stretch" equals a chosen loss budget; (iii) cut to the 3 or 4 least correlated names and accept that this is what the book really is. (ii) is the only one that names the tail in advance. Is there a reason to prefer (i)?

b) **Gap risk, measurable version.** I can condition on sessions that open more than one rung below the prior close and report what fraction of total open loss was created by those sessions versus intraday slides. If gaps create most of it, no intraday rule helps and the only lever is size; if slides do, a pause on arming new rungs after N consecutive fills might. Is that the right split, or would you condition on something else?

c) **Is there any staggered-exit design that is not dominated by holding?** The only candidate I can think of is making the rungs conditional on something other than price distance, and every version of that I've tested was an exposure dial. If your answer is "no, and stop looking", that is useful too.

Next measurement on my side regardless: opportunity cost on the capital that sits loaded 84% of days, as raised in another comment. That one can flip the sign of the no-stop column.
