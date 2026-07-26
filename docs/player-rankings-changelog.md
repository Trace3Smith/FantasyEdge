# Player Rankings — shipped changelog

**Date:** 2026-07-26 · **Status:** all items below shipped to production and verified live (data checks
+ a full in-browser pass over the UI). Commit hashes in parentheses.

A record of the Player Rankings build-out. Grouped by area, not strictly chronological. Draft Mode has
its own map in [`draft-mode-roadmap.md`](./draft-mode-roadmap.md); the few ranking-engine changes that
also touch the draft board are flagged under **Ranking engine** below.

## Hot / Cold form model

The badge was reworked from an opaque OPS-ratio into a transparent, per-category model.

- **League-baseline per-category HOT/COLD + badge reason text** (`153ab53`) — first cut: elite/weak
  percentile tiers per category, with a `formReason` line rendered on the badge (e.g. `.367 AVG, 6 HR`).
- **Hitter window → last-15 appearances with an inactivity guard** (`bed35f2`) — the player's own last
  15 games, resetting the window at any >14-day gap (IL/demotion) so stale pre-absence games don't
  count; ≥6 post-return appearances required to badge.
- **Fixed 5-category absolute-threshold model** (`cc520fc`) — final hitter model: AVG (.300/.220),
  OBP (.350/.290), HR (5+, hot-only), RBI (11/3), R (11/3). Needs 2+ categories on one side and
  strictly more than the other; no league comparison, no consistency guard. `enrichRolling` also began
  carrying `obp`/`hd`. (Pitchers kept the league-percentile ERA/QS/K9/WHIP model.)
- **Full-roster coverage** (`915ce12`) — form now evaluates every active-roster player (~600–780, via
  30 roster calls) instead of the top-75, with a concurrency cap and a 90s soft time-budget so it can
  never dominate the shared 300s cron. Cross-referencing active rosters also excludes IL/optioned
  players from getting stale badges.

## Per-game logs

Expandable per-game logs across every sport, client-side (no server cost).

- **L15/L30 window toggle on the game log** (`3e10845`) — MLB + NFL, sticky per sport.
- **WNBA game log** (`0e50710`) — L10/L20, shares the ESPN gamelog path.
- **NBA + NHL game logs** (`08df553`).
- **PGA recent tournament finishes** (`a2874e7`, `da0aeb2`) — name-keyed results, DP World Tour + LIV
  merged with tour tags (STATUS_FINAL filter for postponed/empty events).
- **MLB game log → per-category box score** (`24d9631`) — AB/H/HR/R/RBI/SB/BB (hitters) and
  IP/ER/K/W/SV/HD/QS (pitchers), with QS (6+ IP & ≤3 ER) computed client-side.

## Rolling windows

- **Rolling windows = the team's last N GAMES, not a date range** (`ac43147`) — each team's own last-N
  by count (denominator exactly N), preserving the missed-games playing-time signal.

## Board structure & UI

- **Sport-nav reorder** (`0bcd198`) — NFL, NBA, WNBA, MLB, NHL, PGA.
- **MLB Hitters / Pitchers tabs** (`b001de0`) — replaced the mixed ALL view, retiring the polymorphic
  `s1–s6` columns; per-type position sub-filters; per-type ranking (1..N within each pool).
- **NHL Skaters / Goalies tabs + generic type-tab system** (`edcb74f`) — same fix for NHL's
  skater/goalie column split; the MLB tab code was generalized into one `TYPE_TABS` config driving both.
- **Season / L15 / L30 board toggle + clickable column sort** (`19ccc41`) — the window re-sources every
  cell from the existing rolling data (no fetch); ESPN-style header-click sort, window-aware, keeping
  each player's fantasy rank in the `#` column. `enrichRolling` gained `obp`/`hd` so windowed columns
  match the season set.
- **"Back to Rankings" button** (`421ce08`) — a visible control to clear a column sort (replacing the
  undiscoverable click-the-`#` reset).
- **Clickable Hot / Cold strip counters** (`4bba232`) — click to filter the board to hot or cold
  players; composes with tabs, window toggle, and sort.
- **Star rating = number of roto category tags** (`811e9e5`) — replaced an opaque bucket (whose 5-star
  tier was mathematically unreachable for MLB) with 1 star per category tag, capped at 5 with a "+"
  for a player carrying all their sport's categories.
- **"Combine categories" tool** (`2dc0f6e`) — a checkbox per sortable header; 2+ checked re-ranks by the
  summed season z-score of just those cats (reusing `p.z`), for finding waiver targets across multiple
  category weaknesses. Coexists with the window toggle (stays season-value), sort, tabs, and the
  Hot/Cold filter.

## Ranking engine (shared with the draft board)

These changed `buildDataset`, so they also affect the shared dataset the draft board consumes.

- **Pitchers rank by multi-category z-sum, not strikeouts alone** (`ee40ee8`) — pitchers now sort by
  their total standardized roto value (W/SV/K + innings-weighted ERA/WHIP), the same machinery hitters
  use. (Reorders the *rankings* board; draft *values* already used `zTotal`, so they're unchanged.)
- **Pitcher innings gate + bullpen-role exemption** (`340b1de`) — 0.2 IP per team game to make the
  ranked board (analog of the hitter PA gate), with a saves+holds ≥ 5 exemption so real closers aren't
  hidden. Tiny-sample arms drop to search-only, which also trims them from the draft pool.
- **Two-way players get an independent Pitchers-pool entry** (`4d5c4ee`) — Ohtani now ranks in both the
  Hitters and Pitchers pools (same MLB id, `twoWay`-tagged clone). `draft.js` and the Coach skip the
  clone so he's drafted once; `enrichRolling` became a multimap so both entries keep their rolling data.

## Removed

- **Trending Players** (`7b97504`) — redundant with the Rankings hot/cold logic.
