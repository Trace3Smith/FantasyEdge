# Brackets & Bowls — data-sourcing spike (research only, no build)

**Date:** 2026-07-10 · **Status:** scoping. No UI, no endpoints. Sequencing input for NFL
Pickem (Sept), CFB Bowl (Dec), March Madness (March).

## Headline

**One provider covers almost everything, for free, that we already use: ESPN's public
(undocumented) API.** It serves win probability, betting **odds/lines**, and injuries across
NFL, NBA, WNBA, MLB, **and** men's/women's college basketball + college football — no API
key, no cost. FantasyEdge already calls these exact hosts (`sports.core.api.espn.com` in
`buildNflDataset.js`, `site.api.espn.com` in `golf.js`). Two gaps need a second (also free)
source or a static table: **weather** and **March Madness historical seed data**. **No paid
odds API is required** — ESPN's odds endpoint returns the betting lines the "upset alert /
best value" signals are derived from.

## Coverage matrix

| Need | Source | Key? | Cost | Notes |
|------|--------|------|------|-------|
| Win probability (all sports) | ESPN `…/events/{id}/competitions/{id}/probabilities` | No | Free | ESPN's own live model, play-by-play WP |
| Betting odds / lines (upset & value signals) | ESPN `…/competitions/{id}/odds` + `scoreboard` | No | Free | Spread / moneyline / total from books; moneyline → implied prob |
| Injuries | ESPN `…/teams/{id}/injuries` | No | Free | Per-team injury list |
| Rest days / back-to-backs (NBA/WNBA) | ESPN team `…/schedule` | No | Free | Derived: date arithmetic between consecutive games — not a special feed |
| Weather (CFB/NFL/MLB, outdoor) | **NWS `api.weather.gov`** | No | Free | US-only; needs a `User-Agent` header; ~5k req/hr. Open-Meteo is a no-key fallback |
| March Madness historical seed performance | **Static table (compile once)** | — | Free | See its own section — not a live API |

### ESPN endpoint patterns (public, no key)
- Base A (rich objects): `https://sports.core.api.espn.com/v2/sports/{sport}/leagues/{league}/...`
- Base B (scoreboard/summary): `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/...`
- Win prob (NFL ex.): `…/leagues/nfl/events/{gameId}/competitions/{gameId}/probabilities?limit=200`
- Odds: `…/competitions/{gameId}/odds` · Injuries: `…/leagues/nfl/teams/{teamId}/injuries`
- Leagues we need are all present: `football/nfl`, `football/college-football`,
  `basketball/nba`, `basketball/wnba`, `basketball/mens-college-basketball`, `baseball/mlb`.
- Caveat: undocumented/community-mapped; ESPN can change shapes without notice. Same risk
  profile we already accept for the golf + NFL-stats builds, so not a new category of risk.

## Answers to the five research questions

**1) Single provider or stitching?** Mostly single: **ESPN** for win prob + odds + injuries +
schedules across every planned sport. **Stitch in one more free source for weather** (NWS).
That's it — 2 providers total, both free/no-key. A paid odds API (The Odds API et al.) is
**not needed**; ESPN's odds endpoint already carries the lines.

**2) Cost structure — any recurring cost?** **No recurring cost.** ESPN (free/no-key) + NWS
(free/no-key) cover it. This matters because nothing in FantasyEdge currently has a recurring
API cost, and this spike keeps it that way. (For reference, if we ever wanted a *second*
odds opinion beyond ESPN: The Odds API free tier is ~500 credits/mo ≈ ~16 real calls/day —
too thin to rely on, and its paid tiers start ~$99/mo. Recommendation: don't take it on.)

**3) Rate limits & cadence — fits the daily cron?**
- **Pre-game data (fits cleanly):** injuries, weather forecast, rest/B2B, opening/current
  lines, and pre-game win-prob baselines are a once-daily pull → fits the existing cron
  pattern. ESPN has no published hard limit at our volume; NWS allows ~5k req/hr. Both fine.
- **LIVE in-game win-probability updates (the real constraint):** **Vercel Hobby crons run
  once per day only** — they cannot poll every few minutes during games. Options:
  (a) **Client-side polling of ESPN** during games — the exact pattern we already ship for
  Sleeper draft tracking (public JSON, permissive CORS, no key); zero server cost, no new
  function. **Recommended** if live WP is wanted. (b) Accept pre-game/periodic snapshots
  only. (c) Upgrade to Vercel Pro (crons to the minute) — a recurring platform cost.
- **Cron-count note (corrected):** Vercel raised the cron limit to **100 per project on all
  plans (Jan 2026)**. So the old "2 crons max" assumption is outdated — cron *count* is no
  longer a constraint; only the **once-per-day frequency** on Hobby is.

**4) Function-budget impact (currently 11/12).**
- Daily fetch can follow the **`api/sports.js` pattern** (dispatch on a query param, cache
  the built payload in Vercel KV, cold-start inline build). Two viable shapes:
  - **Extend an existing function** (e.g. add a games/brackets branch to `api/sports.js`) →
    stays at **11/12**, no new function. Cleanest for budget.
  - **One new `api/games.js` (or `api/brackets.js`)** → **12/12**, uses the last slot. Fine
    for a single build, but it spends the final function — so if all three seasonal builds
    plus anything else land, we'd hit the cap and need consolidation.
  - The daily build can piggyback on the **existing `refresh` cron** (add a step) rather than
    a new cron, though a new cron is now cheap too (100/project).
- **Recommendation:** serve brackets/games data through an **extension of `api/sports.js`
  (or a shared `api/data.js`)** to preserve the last slot; add live WP (if wanted) purely
  **client-side** so it costs no function at all. Flagging now, per the ask: a dedicated new
  function is **avoidable** — we do not need to spend the 12th slot on this.

**5) March Madness bracket optimizer — same source or separate/harder?** **Separate, but
EASIER on the data side, harder on the logic side.**
- The seed-vs-performance history (e.g. 12-seeds beat 5-seeds ~35% since 1985; 11 vs 6 ≈
  39%; round-by-round advancement rates by seed) is a **small, static, well-documented
  table** — compile it **once** into a constant (16 seeds × round). It is **not** a live API
  and needs no ongoing feed. So "seed history" is the trivial part.
- ESPN supplies the *live* tournament layer for free: the bracket/field, seeds, matchups, and
  per-game win prob + odds — same endpoints as above (`mens-college-basketball`).
- The genuinely hard part is **optimizer logic, not data**: a good bracket optimizer maximizes
  expected pool score (round-weighted points, pick-popularity/leverage, correlated
  advancement), which is a modeling problem on top of the static table + live odds — not a
  sourcing problem. Budget the March build's effort there, not on data.

## Recommended sequencing (feasibility-based)

1. **NFL Pickem (Sept):** lowest risk, highest reuse. Pure ESPN — win prob + odds + injuries
   for `football/nfl`; weather via NWS for outdoor stadiums. All free/no-key, fits daily cron
   for pre-game; optional client-side live WP. Build this first to prove the ESPN games-data
   pipeline end to end.
2. **CFB Bowl (Dec):** same pipeline, swap league to `football/college-football` (+ NWS
   weather). Bowls are discrete, pre-scheduled, mostly one-off games → even simpler than the
   NFL weekly slate. Reuses everything from #1.
3. **March Madness (March):** reuses the ESPN live layer, **adds** the static seed-history
   table, and requires the **new bracket-optimizer logic**. Sequence last — its long pole is
   modeling, not data, so it benefits from the pipeline being proven by #1 and #2.

## Addendum (2026-09-03) — team reports, and the endpoint that gives us defense

Built as the expandable team panel on every Pick'em card (`api/_lib/teamReport.js`): recent
form, a season profile, and the offense-vs-defense rank comparison that explains *why* a
matchup tilts. This merged two separately-scoped items — "click a team to see recent games and
stats" and the "why behind the stats" matchup context — because they are the same question
asked from two directions, and a rank only means something next to the rank it faces.

**The finding that made it cheap.** ESPN's per-team `statistics` endpoint is offense-only: its
`defensive` category reports `yardsAllowed` and `pointsAllowed` as a flat **0** for every team.
That is why `nflDvp.js` derives NFL pass/rush defense by aggregating ~272 game summaries a
season — and why doing the same for 136 FBS teams looked unaffordable.

The `statistics/byteam` leaderboard does not have that hole:

```
https://site.web.api.espn.com/apis/common/v3/sports/{league}/statistics/byteam?season={yr}&seasontype=2
```

Every team's categories arrive **doubled** — `Own Passing` / `Opponent Passing`, `Own Rushing` /
`Opponent Rushing`, and so on. The Opponent split *is* the defense (what the team allowed), and
each stat already carries its national rank. One call returns the whole league, both sides of
the ball, pre-ranked. Confirmed on both `football/nfl` (32 teams) and
`football/college-football` (136).

**Rank direction.** Rank 1 is good for the team in both splits, for opposite reasons: on an Own
split it is the most produced, on an Opponent split the fewest allowed. Verified on 2025 FBS —
Ohio State allowed 129.7 pass yds/g at opponent-rank 1, Stanford 288.9 at 136. So an offense
rank and a defense rank are directly comparable, which is what the panel's verdict rests on.

**Two traps, both hit in testing:**
- A league that has not kicked off returns a wholly **empty body** (`{}` — no teams, no
  categories, and *not* an error), so "zero teams" has to trigger the prior-season fallback the
  same as "too few teams have played". Ranks computed off the 16 CFB teams who had played in
  Week 1 would have been worse than useless.
- NFL team schedules include **preseason** games as completed results. They are excluded from
  recent form (`seasonType.type < 2`); starters barely play in them.

**Cost:** one league-wide stats call plus one schedule call per team on the slate, on the daily
cron — ~1s and +40KB of payload for a 24-game CFB week. No new function; it rides the existing
`?feed=` dispatch. `npm run check:brackets` exercises the feeds and the page's real renderers.

## Bottom line for the build decision
- **No recurring cost, no paid API, no new auth.** ESPN (free) + NWS (free) cover all four
  sections' data. Only *weather* needs the second source; only *March Madness history* needs
  a static table.
- **Function budget survivable:** serve via the existing `api/sports.js` pattern to stay at
  11/12; keep any live in-game win-prob **client-side** (proven Sleeper pattern) so it costs
  no function. A dedicated new function is avoidable.
- **The one true limitation:** live win-probability *during* games can't be server-polled on
  Vercel Hobby (once-daily crons) — do it client-side or accept pre-game snapshots.

## Sources
- ESPN hidden API (endpoints, win prob / odds / injuries) — https://gist.github.com/akeaswaran/b48b02f1c94f873c6655e7129910fc3b · https://github.com/pseudo-r/Public-ESPN-API · https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c
- NWS weather API (free, no key) — https://weather-gov.github.io/api/general-faqs · Open-Meteo (no-key fallback) — https://open-meteo.com/
- The Odds API pricing (why we skip it) — https://oddspapi.io/blog/the-odds-api-free-tier-limits/
- Vercel cron limits (Hobby once/day; 100/project since Jan 2026) — https://vercel.com/docs/cron-jobs/usage-and-pricing · https://vercel.com/changelog/cron-jobs-now-support-100-per-project-on-every-plan
- March Madness seed history — https://en.wikipedia.org/wiki/NCAA_Division_I_men's_basketball_tournament_upsets · https://www.boydsbets.com/bracket-tips-by-seed/
