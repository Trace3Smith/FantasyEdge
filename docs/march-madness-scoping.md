# March Madness Bracket Optimizer — feasibility scoping (research only, no build)

**Date:** 2026-07-12 · **Status:** scoping. No UI, no endpoints, no code. Extends the
Brackets & Bowls spike (`docs/brackets-data-research.md`) with a deep dive on the hardest
remaining piece. All ESPN endpoints below were probed live on 2026-07-12 against the 2025
tournament and confirmed working.

## Headline

**Feasible, free, and no new function.** ESPN's public API covers more than expected — it
exposes not just seeds and odds but its **own per-team round-advancement probabilities and
projected seeds**. Historical seed data needs no third-party source: it can be reconstructed
from ESPN's own scoreboard (seed + winner are on every past game) or hand-compiled once into a
static constant. The genuinely hard part is **optimizer logic, not data**. One part of the
*original premium vision* — pool-strategy leverage using national pick-popularity — has **no
clean free source** and is the only paid-data flag.

## Answers to the five research questions

### 1) Historical seed performance — free structured source? ✅ Yes, two ways
- **Reconstruct from ESPN itself (recommended).** Every past-date scoreboard game carries both
  teams' seeds (`competitor.curatedRank.current`), the final score, and a `winner` flag.
  Verified: `…/scoreboard?dates=20160318&groups=100` returns all 16 R64 games with
  `4-seed CAL 66 vs 13-seed HAW 77 W`, etc. Iterate the ~3 tournament weeks × 2011–2025 (the
  68-team First-Four era) → a complete seed-matchup + round-advancement dataset. `groups=100`
  scopes to the tournament group.
- **Or hand-compile the static table.** The seed-vs-seed upset rates (12-over-5 ≈ 35%, etc.)
  and per-seed round-advancement rates are small, well-documented, and stable. ~16 seeds ×
  6 rounds fits in one constant.
- **Recommendation:** write a one-off script (`scripts/`) that walks ESPN March dates and
  emits a committed `api/_lib/mmSeedHistory.json`. Build once, commit, no live feed. This is
  the *trivial* part of the feature.

### 2) Current-year team strength — free tournament-specific signal? ✅ Yes, richer than expected
ESPN's **BPI power-index** endpoint (verified working) is the key find:
```
https://site.web.api.espn.com/apis/fitt/v3/sports/basketball/mens-college-basketball/powerindex?season=YYYY&limit=400
```
Per team, three free stat categories:
- **`bpi`**: overall BPI rating, `bpioffense`, `bpidefense`, `bpirank`, projected wins/losses.
- **`resume`**: `sorrank` (Strength of Record), `projectedtournamentseed`, top-50 wins/losses,
  SOS ranks.
- **`tournament`**: `projectedtournamentseed`, `tournamentregion`, and **round-advancement
  probabilities** — `chancesweet16`, `chanceelite8`, `chancefinal4`, `chancechampgame`,
  `chancencaachampion`. ESPN's own simulation, updated through the tournament.

Also free: seeds + region + round via the tournament **scoreboard** (`curatedRank.current`,
`competition.notes[].headline` = `"…East Region - 1st Round"`); **AP / Coaches polls** via
`…/mens-college-basketball/rankings`; **pre-game betting odds** via the scoreboard `odds`
field for scheduled games (same source the NFL/CFB Pick'em win-prob model already consumes —
odds populate pre-game and clear post-game, which is why the historical scoreboard showed none).

- **NET rankings:** NET is an NCAA-owned metric and is **not** exposed by ESPN. Not a blocker —
  BPI + SOR are a strictly-fine (arguably better-for-modeling) substitute. Flag only if the
  product copy specifically promised "NET."
- **Verdict:** no blend with a paid source needed. BPI gives a continuous team-strength number
  for a matchup win-prob model in rounds where odds don't yet exist (teams not yet paired).

### 3) What "optimizer" means as an algorithm — scope v1 vs v2
- **v1 (ship first, mostly data-assembly):** round-by-round win/advancement probabilities per
  team, then a greedy "pick the higher-probability side each game" bracket fill, tempered by
  the seed-history upset priors from #1. Win prob per matchup from either the ESPN scoreboard
  odds (R64, teams known) or a **BPI-differential → win%** curve (later rounds, teams not yet
  set — same normal-CDF shape as `winProbFromSpread` in `pickem.js`). This is largely
  *assembling* data ESPN already computes, plus one small model. **Reuses the existing
  win-prob philosophy.**
- **v2 (the true premium "optimizer" from the original vision):** maximize **expected pool
  score**, not raw advancement probability — round-weighted points, **pick-popularity /
  leverage** (fade the over-picked favorite), and correlated advancement. This is a modeling
  problem on top of v1, and its leverage input has a data gap (see flag below).
- **Recommendation:** v1 for launch (round-by-round + greedy fill + upset priors). Gate v2's
  leverage layer as the premium differentiator *if* the pick-popularity data problem is solved.

### 4) Timing constraint — can the architecture rebuild real-time-ish? ✅ Yes, already solved by the pattern
- Bracket drops Selection Sunday (~6pm ET, mid-March); most traffic in the first 48h. The daily
  cron alone is too slow for the announcement moment.
- The **`api/sports.js` pattern already handles this**: on a KV cache miss it does a **cold-start
  inline build and backfills the cache** (self-heals). So the *first request* after Selection
  Sunday builds the fresh bracket on demand — no waiting for the next cron tick. Subsequent
  requests serve the cached payload. A short KV TTL (or a version bump keyed on the field being
  set) forces the rebuild the moment ESPN publishes the field.
- **Live in-game updates** (scores/upsets during the first-weekend windows): do it
  **client-side**, polling ESPN's scoreboard — the exact proven Sleeper-draft pattern (public
  JSON, permissive CORS, no key, zero server cost, no function). Vercel Hobby crons run once/day
  and *cannot* poll during games; this is the one true platform limit, and client-side polling
  sidesteps it.
- Optional nicety: a manual/admin refresh trigger for Selection Sunday evening so the first
  visitor doesn't eat the cold-build latency.

### 5) Function budget (11/12) — reuses `api/sports.js`? ✅ Yes, stays at 11/12
- Add a `?feed=march-madness` branch to `api/sports.js`, identical to the existing
  `nfl-pickem` / `cfb-bowl` dispatch (KV-cached payload + cold-start inline build). **No new
  function.**
- New shared lib `api/_lib/marchMadness.js` (not a function) builds the payload; static history
  lives in a committed `api/_lib/mmSeedHistory.json` (not a function).
- Daily refresh piggybacks on the existing `refresh` cron (add a step) — no new cron, though
  cron count is no longer constrained (100/project since Jan 2026).
- Live WP is client-side → **zero** function cost. The 12th slot stays free.

## The one paid-data flag (part of the original vision not free)

**National pick-popularity / ownership %** — the input that turns a probability optimizer into a
true *pool-strategy* optimizer (fade the 80%-picked champion, find leverage). This is **not**
available as a clean free API. ESPN's "Men's Tournament Challenge" shows pick distributions on
its site but exposes no supported public endpoint; scraping it is fragile and ToS-adjacent.
Options: (a) ship **v1 without leverage** (pure probability-optimal bracket — still a strong
premium feature); (b) attempt to scrape ESPN Tournament Challenge pick % (fragile, revisit at
build time); (c) a paid/managed source (not recommended — breaks the project's no-recurring-cost
rule). **Recommendation:** ship v1's probability optimizer as the premium feature; treat
pick-popularity leverage as a stretch goal, not a launch requirement.

Second, non-data flag (platform, not paid): **live per-minute in-game win probability** cannot
be server-polled on Vercel Hobby — client-side polling or pre-game snapshots only. Same limit
noted for NFL/CFB Pick'em; not new.

## Bottom line
- **Data: solved and free.** ESPN gives seeds, region/round, odds, AP polls, BPI (off/def), SOR,
  projected seeds, and round-advancement probabilities. Historical seed data reconstructs from
  ESPN's own scoreboard or a one-time static table. No paid API, no new auth, no recurring cost.
- **Budget: safe.** `?feed=march-madness` on `api/sports.js` → stays 11/12; live WP client-side.
- **Effort is in the logic, not the data.** v1 = round-by-round probabilities + greedy fill +
  upset priors (achievable, mostly assembly). The only piece of the original premium vision
  that isn't freely achievable is **pool-strategy leverage via national pick-popularity** —
  ship v1 without it.

## Verified endpoints (2026-07-12, no key, no auth)
- Tournament scoreboard (seeds/region/round/result): `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=YYYYMMDD&groups=100&limit=100`
- BPI power index (strength + round-advancement chances): `https://site.web.api.espn.com/apis/fitt/v3/sports/basketball/mens-college-basketball/powerindex?season=YYYY&limit=400`
- Rankings (AP / Coaches): `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/rankings`
