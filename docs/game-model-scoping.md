# Game-prediction model (CFB + NFL Pick'em) — data scoping

**Status:** v1 implemented locally (2026-09-12), pending deployment. The original scoping findings follow.

Implementation: NFL opponent-adjusted EPA ratings and CFB SP+ feed predicted margins and measured factors into Pick’em cards and team reports. Market picks remain unchanged. NFL walk-forward evaluation over 1,865 games gives Brier 0.2260 versus market 0.2111; both model probability and disagreement displays remain disabled. CFB has not been backtested and both gates remain disabled there too. Its raw efficiency is garbage-time-filtered but is **not** opponent-adjusted; SP+ is adjusted. NFL team-week efficiency includes garbage time.

The daily cron is the only ratings writer. Set server-only `CFBD_API_KEY` to enable college ratings; without it CFB cards retain their existing market presentation. Normal CFB builds use six year-level calls (including team directory and usage), seven on prior-season fallback, plus bounded retries. No new serverless endpoints. A failed build preserves cached ratings; a cache miss omits the enhancement.

Validation: `npm run check:model`, `npm run check:brackets`, and `npm run fit:nfl-model` (offline when `.cache/nflverse` is populated). `--write` explicitly regenerates the coefficient JSON. Eight-game NFL blending is an assumption evaluated in the backtest, not a tuned parameter. CFB validation requires historical pregame ratings; end-of-season SP+ must not be used to predict earlier games.

The goal is an *explanation* of why a game leans one way, not a better number than the
market. The finding below is that the second thing is essentially impossible and the
first one is cheap — so the whole proposal is built around that asymmetry.

---

## 1. The baseline, measured

`pickem.js` derives its pick from the spread: `winProb = Φ(spread / 13.5)`. Measured over
**2,751 NFL games with a line and a decisive result (2016–2025)**, from nflverse
`schedules/games.csv`:

| Predictor | Brier | Straight-up |
| --- | --- | --- |
| **Φ(spread/13.5) — what we ship** | **0.2112** | **66.4%** |
| Φ(spread/12.5) | 0.2107 | 66.4% |
| De-vigged moneyline (market's own best estimate) | 0.2106 | 66.6% |
| Always pick home (55.0%) | 0.2475 | 55.0% |
| Coin flip | 0.2500 | 50.0% |

And it is already **well calibrated**:

| Predicted (favorite) | n | Actual |
| --- | --- | --- |
| 50–60% | 1024 | 55.2% |
| 60–70% | 1088 | 67.8% |
| 70–80% | 449 | 78.6% |
| 80–90% | 179 | 89.9% |
| 90–100% | 11 | 81.8% |

**Read this carefully.** The gap between our crude normal-CDF approximation and the
market's own de-vigged moneyline is **0.0006 Brier**. Our σ=13.5 shortcut already
captures effectively all the information in the betting market. When the card says 70%,
it hits 78.6% — if anything slightly *under*-confident in the middle, not miscalibrated.

There is no meaningful accuracy left to win. Any model that replaces this number will
almost certainly make it worse.

### The "no line yet" opportunity is not real

The hypothesis that we could add value on early-week games before lines are set does not
survive contact with the live feed. Checked against production today:

- **CFB Week 2, 2026:** 80 games, **1** without a line (Alabama State @ Troy, an FCS visitor)
- **NFL Week 1, 2026:** 14 games, **0** without a line

ESPN populates odds for essentially the entire slate, including body-bag games, well
before our 11:00 UTC cron runs. There is no window to exploit.

---

## 2. CollegeFootballData — confirmed available

Auth: `Authorization: Bearer <key>`, free registration at collegefootballdata.com/key.
Unauthenticated calls 401. Spec is public at `api.collegefootballdata.com/api-docs.json`
(v5.27.1, 84 endpoints) — no key needed to read it, which is how the below was verified.

**Cost tiers** (shared CFB+CBB monthly call pool):

| Tier | Calls/mo | Price |
| --- | --- | --- |
| Free | 1,000 | $0 |
| Academic (.edu) | 3,000 | $0 |
| Tier 1 | 5,000 | $1/mo |
| Tier 2 | 30,000 | $5/mo |
| Tier 3+ | 75,000+ | $10/mo+ |

**1,000/month is the binding constraint and it is enough** — see the call budget in §5.

### The metric checklist, per team

All of the following come from `/stats/season/advanced` (and its per-game twin
`/stats/game/advanced`), which returns **both an `offense` and a `defense` block** per team:

| Metric | Available | Where |
| --- | --- | --- |
| EPA per play (off/def) | ✅ free | `offense.ppa` / `defense.ppa` |
| Success rate (off/def) | ✅ free | `offense.successRate` / `defense.successRate` |
| Explosive play rate | ✅ free | `offense.explosiveness` (+ `passingPlays`/`rushingPlays` splits) |
| Stuff rate | ✅ free | `offense.stuffRate` / `defense.stuffRate` |
| Pressure/sack rate | ⚠️ proxy only | `havoc.total`, `havoc.frontSeven`, `havoc.db` — havoc ≠ true pressure rate (that's PFF, paid). Sacks available in `/stats/season`. |
| Points per drive | ⚠️ derive | `pointsPerOpportunity` (per scoring opportunity) + `offense.drives` are given; points-per-drive is a division away. Full drive data at `/drives`. |
| Yards per play differential | ⚠️ derive | `lineYards`, `secondLevelYards`, `openFieldYards` given; plain YPP from `/stats/season` ÷ plays |
| **Garbage-time filter** | ✅ free | **`excludeGarbageTime=true` is a real query param** on `/stats/season/advanced`, `/stats/game/advanced`, `/ppa/teams` |
| **Opponent-adjusted versions** | ✅ see below | |
| Recruiting talent composite | ✅ free | `/talent` → 247Sports composite, one call for all teams |
| Returning production | ✅ free | `/player/returning` → `percentPPA`, `usage`, and passing/rushing/receiving splits |

**Opponent adjustment — three independent options, all free:**

1. `/ratings/sp` → **SP+** (Bill Connelly): `rating`, `ranking`, `offense`, `defense`,
   `specialTeams`, `sos`, `secondOrderWins`. Already in points-above-average units.
2. `/wepa/team/season` → `AdjustedTeamMetrics`: `epa`/`epaAllowed`,
   `successRate`/`successRateAllowed`, `explosiveness`/`explosivenessAllowed`,
   `rushing`/`rushingAllowed`. **⚠️ Caveat:** the API exposes a
   `UserFeatureAccess.adjustedMetrics` boolean, which strongly implies this endpoint is
   tier-gated. The endpoint description does not say so, and I could not test it without
   a key. **Verify with one call to `/info` on day one.** SP+ is the fallback and is not flagged.
3. `/ratings/srs`, `/ratings/elo`, `/ratings/fpi` → three more adjusted ratings, free.

**Also there, and useful:** `/lines` (historical betting lines — *required* for
backtesting against the market), `/games` (carries `homePregameElo` and
`excitementIndex`), `/metrics/wp/pregame` (CFBD's own pregame win probability — a free
second opinion to benchmark against).

**Only endpoint explicitly marked "Requires Patreon":** `/games/weather` — which we don't
need, we already have NWS.

### Integration cost: the team-name join

`CFBD.Team` carries `id, school, mascot, abbreviation, alternateNames, conference` —
**no ESPN id**. The Pick'em feed is keyed on ESPN team ids throughout. So this needs a
~136-row FBS crosswalk (ESPN displayName ↔ CFBD school), built once and cached. There is
precedent in `api/_lib/crosswalk.js` (FanGraphs↔MLBAM). Budget real time for this; name
joins in college football are where this kind of project actually dies (`Miami (OH)`,
`Texas A&M`, `App State`/`Appalachian State`, `Ole Miss`/`Mississippi`).

---

## 3. nflfastR / nflverse — confirmed available

**No API and no key.** It is R/Python packages plus **public GitHub release assets**,
which is better for us: plain HTTPS, no auth, no rate limit, fetchable straight from a
Vercel function. Repo: `nflverse/nflverse-data`, one release tag per dataset.

Verified live (2026-09-12): `play_by_play_2026` assets were rebuilt **2026-09-11**, so it
updates in-season, daily.

### The important finding: v1 does not need play-by-play

`stats_team_week_<year>.csv.gz` is **76 KB gzipped** (138 columns, one row per team per
game) versus **19 MB gzipped / 98 MB raw** for full play-by-play. It carries
`passing_epa`, `rushing_epa`, `attempts`, `carries`, `sacks_suffered`, yards, `passing_20/40`,
`rushing_20/40`, `def_sacks`, `def_qb_hits` — offense only, as totals.

**The defensive split comes free from a self-join.** Every row carries `opponent_team`, and
a team's defensive EPA *is* the EPA its opponents produced against it. I ran this on 2024:

```
TM    offEPA/p  defEPA/p     net  YPPdiff  expl%
BAL      0.209    -0.047   0.256     1.35    8.1
DET      0.163    -0.030   0.193     0.43    6.8
PHI      0.101    -0.084   0.185     0.84    6.6
BUF      0.176    -0.000   0.177     0.07    6.7
...
CAR     -0.046     0.157  -0.203    -0.79    5.6
```

Baltimore's league-best offense, Denver/Philadelphia elite defenses, Carolina's
historically bad 2024 defense at +0.157 — the leaderboard matches reality. **One 76 KB
file per season gives off/def EPA per play, yards-per-play differential, and explosive
rate for all 32 teams.**

### NFL metric checklist

| Metric | From `stats_team` (76 KB) | Needs play-by-play (19 MB) |
| --- | --- | --- |
| EPA per play (off/def) | ✅ derive (totals ÷ plays, opponent join) | — |
| Yards per play differential | ✅ derive | — |
| Explosive play rate | ✅ derive (`passing_20/40`, `rushing_20/40`) | — |
| Sack rate | ✅ `def_sacks`, `sacks_suffered` | — |
| QB-hit rate (pressure proxy) | ✅ `def_qb_hits` | true pressure = PFF, paid, unavailable |
| **Success rate** | ❌ | ✅ `success` column |
| **Stuff rate** | ❌ | ✅ derive from `yards_gained`/`rush` |
| **Points per drive** | ❌ | ✅ `fixed_drive` |
| **Garbage-time filter** | ❌ **not possible** | ✅ `vegas_wp` / `wp` / `score_differential` |
| Opponent-adjusted | ❌ none published — **must compute ourselves** | — |

PBP confirmed to carry all of: `epa, success, wp, vegas_wp, wpa, qb_epa, fixed_drive,
series_success, sack, qb_hit, air_yards, cpoe, xpass, pass_oe, down, ydstogo, posteam,
defteam` (372 columns).

**The asymmetry to accept in v1:** CFB gets garbage-time-filtered, opponent-adjusted
metrics for free from CFBD. NFL gets neither without either ingesting play-by-play or
building our own adjustment. That is a real quality gap between the two sports and the
cards should not pretend otherwise.

**There is no free opponent-adjusted NFL rating** equivalent to SP+. DVOA is FTN/paid,
PFF is paid, ESPN FPI is not published in a usable free form. Opponent adjustment for
NFL is ours to compute (a ridge regression on the off/def EPA matrix — cheap, ~32×32).

---

## 4. v1 scope — the cheapest thing that is honest

### Model: predict *margin*, not win probability

Do **not** build a win-probability classifier. Build a **point-margin model**, because:

1. Its output is in the same units as the spread, so "our model: Georgia −9.5 / market:
   Georgia −6.5" is a sentence a user understands — that *is* the explanation product.
2. Win probability falls out of the Φ(margin/13.5) we already ship, so it drops into the
   existing card with no new concept and no new UI vocabulary.
3. It is validatable twice over — MAE/RMSE on margin *and* Brier on the derived probability.

**CFB v1 — near-zero cost, no training:**
`predicted_margin = (SP+_home − SP+_away) + home_field(≈2.0)`. SP+ is already an
opponent-adjusted rating in points-above-average, purpose-built for exactly this. One API
call. The explanation writes itself from the components CFBD already returns — offense
SP+, defense SP+, special teams, plus talent and returning production as context lines.
Ship this before fitting anything.

**NFL v1 — one small fit:**
No SP+ equivalent, so: ridge regression on opponent-adjusted off/def EPA-per-play
differential + home field, fit on 2016–2025, target = actual margin. Feature count in the
single digits. **Fit offline in `scripts/`, commit the coefficients as JSON.** The cron
must never train — it only scores.

Elo is the reasonable alternative and is genuinely simpler, but it throws away the
component detail (offense vs defense, rush vs pass) that the whole feature exists to
surface. A margin model keeps the decomposition. Rejected for that reason, not for accuracy.

### What ships on the card

The model number goes **next to** the market number, never replacing it. The pick stays
market-derived — it is better calibrated than anything we will build, and §1 proves it.
What is new:

- **"Why this leans"** — the 2–3 largest component gaps, named. *"Georgia's defense
  allows 0.08 EPA/play (11th); Auburn's offense is at −0.02 (78th). Georgia is +14 in
  returning production."*
- **Model-vs-market disagreement** as the genuinely new signal: when our independent
  read differs from the line by >X points, that is worth surfacing, and it is a far more
  defensible upset flag than the current `winProb < 0.58` heuristic.

### Explicit non-goals for v1

No player-level modeling, no injury-adjusted ratings, no in-game/live win probability, no
"beat the spread" claim anywhere in the copy, and **no replacement of the market pick**.

---

## 5. Infrastructure fit

**The hard constraint: we are at 12/12 Vercel Hobby serverless functions.** Confirmed by
count. `api/sports.js` already dispatches Pick'em, DvP, box scores and March Madness on
`?feed=` specifically to preserve this budget, and the code comments say so. **This
feature adds zero new functions** — it rides `?feed=` like everything else, or better,
rides the existing Pick'em payload.

**Fetching:** rides the existing daily cron (`/api/cron/refresh`, 11:00 UTC,
`maxDuration = 300`, fluid). A new `buildRatings()` step, written to new KV keys
(`ratings:cfb`, `ratings:nfl`) *before* the Pick'em builds so the feeds can read it,
following the `NFL_DVP_KEY` pattern exactly. Both `pickemSummary()` and the
`check:brackets` script extend naturally.

**Call budget per cron run:**

| Source | Calls | Notes |
| --- | --- | --- |
| CFBD `/ratings/sp` | 1 | whole league, year-level |
| CFBD `/stats/season/advanced` | 1 | whole league, `excludeGarbageTime=true` |
| CFBD `/talent` | 1 | whole league |
| CFBD `/player/returning` | 1 | whole league |
| CFBD `/info` | 1 | usage guard — log `remainingCalls` in the cron summary |
| nflverse `stats_team_week` | 1 | 76 KB, plain HTTPS, no key |
| **Total** | **~5 CFBD + 1 HTTP** | |

**~150 CFBD calls/month against a 1,000 free allowance.** Comfortable. Every endpoint is
year-level, so *never* loop per team — that is the only way to blow this budget, and it
is how it would get blown (136 teams × 30 days = 4,080 calls). Historical backfill for
training is ~10 calls/season × 10 seasons = ~100 calls, one-time. If backfill turns out
to need play-level data, Tier 2 at **$5/mo for 30k calls** is the cheap escape hatch.

**Added cron cost:** ~6 HTTP calls plus a 76 KB CSV parse ≈ 2–5s against a 300s budget.
Negligible. Both ratings builds must be independently `try/catch`ed and additive, exactly
like the existing enrichment steps — a CFBD outage must leave the Pick'em cards intact.

**Caching:** a completed season's ratings never change → cache without expiry, same
bargain as `byteamKey` and `boxScoreKey`. Bump `FEED_CONTENT_VERSION` when model output
reaches the card, per the convention already documented in `pickem.js`.

**New env var:** `CFBD_API_KEY`. Nothing else.

---

## 6. Evaluation — the gate before any of this reaches a user

Backtesting is genuinely easy here and there is no excuse for skipping it: CFBD `/lines`
and nflverse `games.csv` both carry historical spreads, so every past game has a market
baseline attached.

**Protocol:** walk-forward. Train on seasons ≤ N−1, test on season N, roll forward.
Never evaluate in-sample. Report per season, not pooled — a single good year means nothing.

**Metrics:**
1. **Brier score**, against the measured baselines: **0.2112 (NFL market)**, coin flip
   0.2500, always-home 0.2475. CFB baseline to be measured the same way once `/lines` is pulled.
2. **Reliability curve** — the ten-bucket table in §1. This is the real gate: *when it
   says 70%, does it hit 70%?*
3. **Margin MAE/RMSE** vs. the closing spread's own MAE (the spread is the number to beat;
   it will not be beaten, and that is the expected result).
4. **Calibration slope/intercept**, so over- vs under-confidence is a number rather than
   a squint at a chart.

**Ship gates:**
- Model win probability may **not** be shown as a headline number unless its Brier beats
  0.2112 out of sample. It will not. Plan for it not to.
- The decomposition ("why this leans") ships regardless — it is descriptive, and every
  component is a measured value we can point at, not a prediction.
- Model-vs-market disagreement ships only if backtesting shows the disagreement carries
  real signal — i.e. bucket historical games by disagreement size and check whether
  underdogs actually cover/win more in the high-disagreement buckets. **If it doesn't,
  drop it and keep the explanation.**

A `scripts/check-model.mjs` in the `npm run check:*` family, asserting the calibration
table stays inside tolerance, is how this stays honest after launch.

---

## 7. Honest assessment: where the value actually is

**It is not in the number.** §1 settles that: our spread conversion is 0.0006 Brier off
the market's own estimate and is well calibrated across every bucket. A free-data model
will not beat a market that has professional money and injury news priced in minutes
before kickoff.

**Ranked by what's actually worth building:**

1. **Explanation — the real product, and the reason to do this.** Today a card says
   "Georgia 72%" and the user has to take it on faith. With this data it says *why*: whose
   defense is better and by how much, who returns production, who is more explosive. That
   is a genuine feature, it needs no accuracy edge, and every number in it is measured
   rather than predicted. Note this also upgrades the *existing* team-report panel, which
   today shows raw yards-per-game ranks — opponent-adjusted efficiency is strictly better
   and the panel is already built.
2. **Unranked / thin-market CFB — the one place an edge is plausible.** 80 games on this
   week's slate, only 20 involving a ranked team. Lines on Sun Belt and MAC games are
   softer than NFL lines, and CFBD's opponent-adjusted metrics genuinely cover those teams.
   If an edge exists anywhere, it is here. Test it before claiming it.
3. **A better upset flag.** The current rule is `winProb < 0.58` — that just means "the
   line is close", which the user can already see. Model-vs-market disagreement is an
   actually independent signal. Subject to the §6 gate.
4. **Early-week games — dead, do not pursue.** Measured today: 1 of 80 CFB games and 0 of
   14 NFL games lack a line at build time.

**Recommendation:** build it for the explanation, gate the number behind calibration, and
keep the market pick as the pick. Start with CFB — SP+ makes it one API call with no
training, and CFB is where a thin market makes an edge at least plausible.
