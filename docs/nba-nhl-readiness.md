# NBA and NHL Team Manager / My Edge readiness

Audit date: 2026-09-12. **Neither sport is enabled for recommendations, dry-run apply, real writes or
Autopilot.** UI tabs remain off. This is a staged rollout plan, not a declaration of production readiness.

## Evidence and its limits

Read `api/_lib/espnFantasy.js`, `espnScoring.js`, `lineupAdvisor.js`, `espnLeagueConfig.js`, root
`nbaScoring.js` / `nhlScoring.js`, `fantasyedge-autopilot.html`, and `api/espn/index.js`.
Actual captured settings are `scripts/fixtures/league-settings/nba-117597-2027.json` and
`nhl-28525-2027.json`. Both are **ROTO**, not points fixtures. The fixture README documents capture and
scrubbing. They omit rosterSettings, player entries, ownership and transaction responses. Their season
is ESPN's 2027 season identifier, not a reason to substitute calendar-year 2026 on requests.

ESPN's current [lineup help](https://support.espn.com/hc/en-us/articles/360000958652-Setting-Your-Lineup)
confirms player-team scheduled game time as a lineup move boundary and enforcement of eligible slots.
That does not verify this app's unofficial transaction payload or every league's acquisition/IR locks.
No authenticated live roster capture, dry-run against a real NBA/NHL team or live transaction was performed
in this task. Those behaviors remain **Unknown from repository** where noted below. Avoid interpreting a
settings-only fixture or synthetic test as live provider validation.

## Readiness matrix

“Partial” means code exists but lacks evidence or has a known gap. “Blocked” means do not expose that
operation. “Settings verified” applies only to the captured league and normalized config contract.

| Area | NBA evidence / current state | NHL evidence / current state | Required gate |
|---|---|---|---|
| ESPN discovery | Partial: fan FBA → nba and game fba; all-sport discovery exists | Partial: FHL → nhl and game fhl | Verify current and upcoming seasons, multiple teams, co-owners, private/no-league accounts and fan omissions |
| Roster parsing | Shared basketball parser available; no committed real roster fixture | Generic parser runs, but absent bench mapping misclassifies reserve entries as starters | Sanitize and pin actual rosterSettings + mRoster responses before UI rollout |
| Player identity | ESPN roster id retained; valuation joins normalized name | IDs retained, normalized-name joins; positions unmapped | Measure match coverage and collisions; preserve provider ID, two names must not imply one player |
| Professional team identity | proTeamId retained, display abbreviation map empty | Same, map empty | Capture verified provider team registry; never infer a guessed table |
| Eligible slots | Known code mapping 0 PG,1 SG,2 SF,3 PF,4 C,5 G,6 F,7 SG/SF,8 G/F,9 PF/C,10 F/C,11 UTIL,12 BE,13 IR | C/LW/RW/D/G and flex/bench slots not mapped | Cross-check each used slot against real eligibleSlots and lineupSlotCounts; preserve unknown IDs |
| Scoring settings | Real ROTO fixture + neutral LeagueConfig adapter verified | Real ROTO fixture + adapter verified | Keep actual scoringItems, reverse direction, weights and format; do not replace with defaults |
| Points leagues | Hoops stat map and weighted n-stats available, but only subset covered; no real points fixture here | No NHL stat map in espnScoring, no NHL lineup value-index branch | Capture actual points leagues; verify every scored statistic or mark unsupported |
| Category leagues | **Blocked recommendations:** parser returns weights:null, lineup engine uses hoops points, not category objective | **Blocked:** parser has no NHL recognized categories, fallback would use MLB index/config | Reuse existing nbaScoring/nhlScoring category values through a shared validated adapter; never create a My Edge scoring formula |
| Injuries | Common injury labels parsed, penalty table present | Generic labels parsed; no sport-specific recommendation config | Verify provider statuses and unknown handling; Q/DTD is uncertainty, not confirmed unavailable |
| IR / IL / IR+ | Code assumes IR 13 with heuristic detection; eligibility and effective-date behavior unverified | No verified reserve-slot or eligibility behavior | Capture real league rules; IR+ existence and semantics are Unknown from repository, do not import Yahoo rules |
| Optimization | Existing NBA config/assignment engine, points only; disabled via policy | No NHL engine; generic fallback is unsafe | Verify scoring format, eligibility, active slot counts, schedule and reserve constraints |
| Bench/start | Internal NBA threshold 5 fp/game and waiver threshold 6, not exposed | No safe recommendation path | Test playing-today vs idle player, identity coverage and required slots before enablement |
| Lock behavior | Reads lineupLocked/rosterLocked; code lacks verified NBA daily slate participation and league lock modes | Same generic flags, goalie timing absent | Real daily/weekly settings and before/after lock fixtures; unknown lock is unknown, not “unlocked” |
| Waivers | Generic free-agent read and shared optimizer hooks; valuation/availability incomplete for NBA formats | Generic read endpoint possible; mapping/role/valuation not ready | Validate roster limits, acquisition limits, FAAB vs budget-not-in-use, waiver date and starter improvement |
| Coach context | Existing ranked dataset, Coach and trade context usable as building blocks; no My Edge action context yet | Same, limited category/role coverage | Pass verified evidence + settings, not invented availability or team needs |
| Trade Center | API TRADE_SPORTS includes NBA; current category analysis is dataset-based proxy | Includes NHL; current category list not confirmed to match each ESPN league | Treat as research/partial; use actual scoring coverage and label proxy standings, avoid unconditional offers |
| My Edge | Candidate for staged read-only display after roster verification | Config/connection status only until roster semantics corrected | Surface per-league limitations; never label an unassessed league All Clear |
| Dry-run transaction | Generic apply path exists but NBA is excluded from ENGINE_SPORTS | Excluded; no legal slot/value basis | Offline sport fixtures first; then read-only dry-run validated against authorized real team |
| User-approved writes | **Blocked** | **Blocked** | Explicit approval for a real validation transaction, scrubbed request/response, roster re-read confirmation, lock failure cases |
| Autopilot | **Blocked** despite NBA dataset being in cron dataset map | **Blocked**, no dataset mapping for cron | Strong manual-write validation plus entitlement, connection, ownership, permission and lock tests |

## Concrete gaps that must not be mistaken for support

The hoops value index merges HOOPS_POINTS_DEFAULTS into parsed league weights. An omitted scoring stat
can inherit a default, and double-double value is estimated. FG%/FT% category handling is not represented
by the current hoops stat map. A category league is not equivalent to a generic points league. These are
confirmed reasons to withhold NBA recommendations; this task does not change valuation formulas.

The actual NHL fixture scores IDs `38,11,13,29,14,15,31,32,1,17,33,10`; ID 10 is reverse-scored.
The committed fixture provides no human stat-name registry. Do not assign labels from common hockey
categories. `nhlScoring.js` and the NHL ranking builder already distinguish skater and goalie statistics,
but that is not an ESPN fantasy scoring/slot crosswalk. Missing hits/blocks in a ranking feed cannot be
manufactured as zeros. Goalie starts, confirmed/probable status, minimum goalie appearances, negative
points exposure and ratio denominators require explicit coverage. It may sometimes be correct not to
start a goalie; absence of a recommendation is not proof that every available goalie should start.

`lineupAdvisor.js` currently falls back to MLB for an unsupported sport. Request AND cron allowlists
are therefore essential. The new shared `leagueCapabilities.js` reports NBA/NHL READ_ONLY with explicit
limitations; it does not turn on browser tabs or claim the NHL roster is correctly labeled. Supported
MLB/WNBA/NFL policy is unchanged. Future capability resolution must intersect provider/sport policy with
actual league format, parser coverage, freshness and connection health, rather than looking at sport alone.

## Stages and acceptance evidence (run separately for each sport)

1. **Connected visibility:** capture sanitized league roster/settings, players and team registry from an
   explicitly authorized account. Read only. Pin IDs/slots/reserves/owners/season and render unknown fields
   honestly. NBA first, NHL immediately after slot mapping is verified. No provider writes.
2. **Recommendations:** scoring-aware shared adapter, current scheduled games, injuries and eligibility.
   Points and categories have separate gates. Test empty slot, no game today, injured starter, duplicate
   names, unknown valuation, flex assignment and locked players. NHL adds goalie/skater separation and
   league goalie constraints. Category suggestions must preserve ratio math and scored category coverage.
3. **Dry-run:** add sport-specific fixtures for the existing LINEUP transaction shape (team/scoringPeriod,
   member/connection binding, items/from/to), confirm read-only endpoint produces a legal plan; no POST to
   writes host. Test full roster, IR activation, invalid eligibility, unknown slot and changed ownership.
4. **Manual writes:** only after explicit user authorization, controlled test league, before/after roster
   capture and scrubbed success/409 fixtures. Verify batch rejection and retry behavior for this sport.
   Keep unknown 409s fail-closed. Do not assume NFL/baseball evidence transfers to basketball or hockey.
5. **Autopilot:** sustained manually verified operation, lock and revocation races, bounded runtime and
   observability. Provider schedule coverage matters more than a daily cron that merely returns 200.
   Enable only that validated sport/format/action class; do not broaden the whole policy set by default.

`check-sport-readiness.mjs` guards the current gates and fixture limitations. It is intentionally not
called proof of NBA/NHL transaction readiness. Next needed fixtures are actual rosters/settings with
rosterSettings and a separate points league for each sport, followed by explicitly approved transaction
validation. Unknown data must block unsafe capabilities, not block useful read-only connection status.
