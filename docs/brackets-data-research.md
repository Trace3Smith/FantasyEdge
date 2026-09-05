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

### The crossover, per team (2026-09-04)

Early-season teams sit on the last completed season's ranks, and cross to the current season on
their **own** schedule rather than the league's. Two gates, both required:

1. the team has played `MIN_GP` (4) games — its own numbers aren't noise; and
2. at least 75% of the league has too — the population a rank is drawn from is real.

Gate 2 counts teams that have **played**, not teams *listed*. ESPN populates the leaderboard from
the schedule release: on 2026-09-04 the CFB leaderboard already carried **138 teams, nearly all
with zero games**. Ranking a team with one game against 137 that have produced nothing is worse
than using last year. Both gates clear around Week 5, which is roughly when season ranks start
meaning anything anyway.

**Mixed matchups.** Ranks only compare inside one population, so a 2026 offense rank must never be
set against a 2025 defense rank. Both seasons are retained per team (~400 bytes each), and a
matchup is drawn on the newest season **both** teams have — so a crossed-over team facing one that
hasn't is still compared on 2025, and the line says so. The two sides of a card always agree.

A season is stored for a team only if its ranks are worth reading (real stats both sides, and for
the in-progress season the crossover rule satisfied). That storage rule is what makes the shared
-basis lookup safe: a season nobody should be ranked on is never in the map to be picked.

**Labels.** A prior-season profile reads *"2025 season stats — last year's roster, not enough 2026
games yet to rank."* The matchup gets its own wording, because it can sit a year back for a
different reason — the opponent's sample, not yours.

**The roster-turnover hedge.** Last year's ranks can't see a new coordinator or heavy turnover.
Rather than trying to model that, a team on a prior-season basis also shows *"2026 so far: 1-0,
42.0 scored, 26.0 allowed per game"* — derived from the form rows already in the payload, so it
costs **nothing**, and it puts what a team has actually done this year beside the stale ranks.

**Caching.** A completed season never changes, so the prior-season leaderboard is stored in Redis
under `byteam:{league}:{season}` **without expiry** — fetched once per league per season, then
free. It is *not* a second live feed. Only the in-progress season is fetched on each build, and an
empty response is never cached (that would pin a transient ESPN failure in place permanently).
`teamReports.v` versions the payload shape so `api/sports.js` rebuilds a stale-shaped cached feed
once on deploy.

## Addendum (2026-09-04) — CFB stadium coordinates, so the weekly feed gets weather

`api/_lib/cfbVenues.js`, generated by `node scripts/gen-cfb-venues.mjs` and committed as reviewed
data. 172 FBS venues (13 domed). The CFB Week feed previously passed `coordsFor: () => null` and
showed no weather at all; it now matches NFL Pick'em and the bowls.

**ESPN has no coordinates.** A venue record carries a name, city/state, an `indoor` flag and a
**ZIP** — no lat/lon, which is what NWS needs. The zip is the usable key: ESPN's are usually
campus-specific (94305 = Stanford, 73019 = Oklahoma's campus, 90037 = the Coliseum), so a zip
centroid normally lands a couple of km from the stadium, well inside NWS's ~2.5km grid.

**Every row is validated against the API that will consume it.** A geocoder returning a plausible
wrong answer is the real risk, so each coordinate is round-tripped through NWS `/points`: it must
resolve to a gridpoint, and the state NWS reports back must match ESPN's. Anything failing is
reported and left out rather than written unchecked. This caught a genuine ESPN data error — East
Carolina's stadium in Greenville, NC is recorded with zip **37604, which is Johnson City,
Tennessee**, ~250 miles away. The generator offers two candidates (zip centroid, then city
geocode) precisely so validation has something to fall through to.

**Precision, stated honestly.** Not every zip is geographic. Fenway Park is recorded under 02297, a
unique/PO-box zip whose centroid sits ~15km east. Cross-checked against the independently
hand-built `BOWL_VENUES`, dome flags agree on all 12 shared venues, 26 of 30 coordinates agree
within 8km, worst ~16km. That is several grid cells but does not move a temperature, wind speed or
chance of rain enough to change a card, so it's accepted rather than chased. `BOWL_VENUES` still
takes precedence where it has a hand-verified coordinate; the generated table now backs it up,
which is what covers a CFP first-round game at a campus stadium.

**Two things a single-season walk gets wrong**, both fixed:
- `groups=80` (FBS) is required. Without it the scoreboard returns a handful of featured games —
  15 in a week that actually had 51 — silently producing a table full of holes.
- One season isn't enough. Neutral-site games are played at NFL stadiums, and Wisconsin vs Notre
  Dame at **Lambeau Field** had no FBS game there in 2025, so a 2025-only table left that card
  with no forecast. The generator walks three seasons including the current one, which also picks
  up venues that are only scheduled so far.

**NWS coverage is not "USA only".** It forecasts the territories too, and college football plays in
San Juan and Honolulu — ESPN reports those in its `country` field rather than as a state, so they
have to be allow-listed or real venues get dropped. Dublin, London and Nassau are genuinely
outside coverage and are skipped on purpose.

**A latent NFL bug surfaced alongside this.** `nflPickem.js` resolves coordinates by HOME TEAM,
which is wrong at a neutral site: the league plays in London, Munich, São Paulo and Melbourne, and
the home-team lookup would forecast their home city's weather for a game on the other side of the
world. It stayed invisible because those games happened to involve dome teams, so the dome check
swallowed the wrong lookup. Neutral-site NFL games now get no forecast, which is the honest answer
— NWS is US-only.

Games also now carry `venue.id` in the payload, so weather coverage is checkable without
re-deriving the venue. `npm run check:brackets` asserts the table's structure (no null island, no
sign-flipped longitudes, coordinates inside NWS coverage) and that every in-window outdoor game at
a resolvable venue actually has a forecast.

## Addendum (2026-09-04) — forecast freshness on a once-a-day cron

The daily cron (`0 11 * * *`) is the only scheduled writer and the feed key carries **no TTL**, so
a forecast was up to ~24h old on the page and, measured against a real slate, **5–14h old at
kickoff** (median 12h). Temperature survives that; precipitation probability is what moves. The
plan is **Hobby** (verified, not assumed), which caps cron *frequency* at once a day — cron
*count* is no longer a limit, but a second, more frequent cron isn't available. So freshness has
to come from the request path.

**Serve-time top-up** (`topUpWeather` in pickem.js, called from api/sports.js). On serve, any game
kicking off within **24h** whose forecast is older than **30 minutes** is re-read. Deliberately
narrow:
- only games inside that window, so it is a handful of fetches, never the slate;
- only the second NWS call — the gridpoint is cached, see below;
- once per interval across ALL requests, via a `SET NX PX` cooldown taken *before* fetching, so a
  burst of concurrent requests refreshes once rather than once each and a public URL can't be used
  to drive repeated upstream traffic;
- a 4s hard budget, because this runs on somebody's request;
- skipped entirely on a cold-start build, which is already fresh.

A failure leaves the previous forecast in place — which is what it was going to show anyway.

**Gridpoint cache.** `api.weather.gov/points/{lat},{lon}` resolves a coordinate to its grid cell's
hourly-forecast URL, and that mapping belongs to the coordinate, not the weather. Cached under
`nws:grid:{lat},{lon}` (90-day TTL rather than none — NWS does occasionally re-grid an office),
which halves what a forecast costs and is what makes the top-up cheap enough to run on a request.

**A trap this introduced, and the fix.** That cache is consulted **once per game**, and the Upstash
client retries internally: one command against an unconfigured or unreachable Redis costs **~4.3
seconds** before it throws. A full slate serialised that into ~95s and blew a local build straight
past a 120s timeout — in production it would have eaten the cron budget on any Redis blip, for a
path that previously touched Redis zero times. So the cache is skipped when Redis isn't configured
(`redisConfigured`), and **one failure disables it for the rest of the process**: a build pays that
penalty once, not once per game. Forecasts keep working throughout, at the cost they had before the
cache existed.

**The card now states its own age** — `🌦 72°F Clear · forecast 11h old`. A weather line with no age
reads as equally authoritative at two hours and at twenty, which was the more misleading half of
the problem. Omitted rather than guessed for a payload built before forecasts were timestamped.

`weather` now carries `fetchedAt` and the NWS `url` it can be refreshed from. Both are additive —
an older cached payload simply shows no age and isn't topped up until the next cron.

## Addendum (2026-09-05) — grouped injury impact, and a feed that was never wired up

Cards now say what a team's injuries MEAN — "3 OL out or questionable — could mean more pressure on
the QB and a weaker run game" — instead of only listing names. Templated per position group
(`api/_lib/injuryGroups.js`), chosen by group and severity at build time: no model call per game.

**A bug this uncovered: no NFL injury had ever reached a card.** `fetchInjuries` keyed its map on
`t.team?.abbreviation || t.abbreviation`, but ESPN shapes a team in the injuries payload as
`{ id, displayName, injuries }` — carrying neither field. Every team hit the `continue`, the map
came back empty, and the failure was invisible because an empty injury list looks exactly like a
healthy team. Confirmed against production: **0 injury rows across all 16 NFL cards**. Now keyed on
`id` (22 = Arizona), which matches the team id already on every game object: 192 rows, 52 impact
lines. `check:brackets` asserts NFL cards carry injuries so it fails loudly if the key breaks again.

**Two rules that keep the lines honest**, both from measuring the live payload:
- **IR is excluded from the trigger.** It's the largest status bucket (168 of 800 rows) and means a
  player has been gone for weeks and is priced in. Of 85 groups that would have fired on a snapshot,
  13 were entirely IR — reading as breaking news about a months-old situation. IR still shows in the
  per-player list underneath.
- **A group needs two**, and specialists (K/PK/P/LS) aren't in the position map at all, so a
  questionable kicker can never fire a line.

**The QB exception.** A single injured QB outweighs any group, but ESPN publishes no starter flag
and firing on any QB injury would be wrong most of the time: on a live snapshot 9 teams had a
notable QB injury and only **2 were starters** (Mahomes, Penix) — the rest backups and IR depth
arms. `shortComment` mentions depth in only 11 of 78 QB rows, so prose parsing won't help either.
Instead the starter is identified from the NFL dataset already cached in Redis — the team's top
projected QB, which matches the real depth chart (Penix over Tua, Daniels over Mariota, Ward over
Trubisky, Lamar over Huntley). One cached read per build, no upstream calls. A **margin is required**
(25% and 40 points): Cleveland returns Watson 102.1 vs Sanders 97.1, a real open competition, and
the rule correctly abstains rather than inventing a starter. 31 of 32 teams resolve; the QB line
fires on exactly the two genuine starters.

**Extended to RB/WR/TE (2026-09-05).** The same projection-leader method now infers a starter at
every skill position, and an injured starter fires its own named line — *"Starting RB D'Andre Swift
questionable"* — above any group count. The gate is unchanged, and how often it passes varies by
position exactly as it should: the top player's median lead over the second is **21.3x at QB, 3.25x
at TE, 2.51x at RB, 1.36x at WR**, so 31/32 teams resolve a quarterback but only 20/32 a receiver.
Chicago reads Burden 209.0 vs Odunze 207.9 and Washington's backfield White 128.1 vs
Croskey-Merritt 127.9 — naming a starter there would be inventing a fact, so those teams abstain and
fall back to the group count. Loosening the gate to raise WR coverage would trade a true signal for
a confident guess. League-wide this took starter lines from 2 (QB only) to **18**.

A starter line **absorbs its own unit's group line** rather than repeating it: *"Starting RB X out
(2 RB affected)"* instead of that line plus *"2 RB out"*. Lines are capped at 4 per team, since a
card listing six things communicates less than one listing three.

Two data problems fixed alongside it. The dataset carried **33 team keys, not 32** — one Washington
receiver arrives as `WAS` while the other eighteen are `WSH`, which both excluded him from his own
team's pool and stood him up as a one-man team that would trivially "win" its position. Team
abbreviations are normalised before ranking. And names are matched **forgivingly** across the two
feeds (punctuation and Jr./III suffixes stripped), because `Ja'Marr Chase` and `Marvin Harrison Jr.`
are exactly where the same player gets written two ways and a silent miss looks like a healthy team.

**Placement:** the impact lines sit on the CARD FACE above the names, not in the expandable panel.
The value is not having to read five names to know a unit is thin, which is a glance-level
judgement; the names stay below for anyone who wants them.

**CFB gets nothing**, and needs no gate to do so: the endpoint returns no data, so the grouping
produces no lines and the section never renders. See the addendum above for what sourcing it would
cost, and why we didn't.

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
