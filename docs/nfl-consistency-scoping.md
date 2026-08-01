# NFL Consistency / Floor–Ceiling (Option C) — scoping

**Status:** proposed, not built. **Date:** 2026-08-01.

Fast-follow to the NFL star-rating removal. The roto "Stars = categories cleared" rating was dropped for
NFL and replaced with a **positional tier** (RB4 / WR12 / QB1 — commit `6144b92`). This doc specs the
richer, points-league-native signal that could replace or augment it.

## Goal
Give the NFL board a genuine **reliability signal** — weekly floor, ceiling, and boom/bust — that
answers "safe every-week starter vs. boom-bust dice roll." The tier and the point totals don't convey
this.

## The metric
From **per-game fantasy points** over the season:

- **Floor** — a bad-but-not-zero week. Proposed: the **25th-percentile game (P25)**, not the literal
  min (one injury exit shouldn't define the floor).
- **Ceiling** — a big week. Proposed **P75**, or **P90** for a "spike weeks" flavor (open decision).
- **Boom / Bust rate** — % of games above a "great start" line / below a "wasted slot" line. Proposed
  per-position PPR lines (want a review pass like the hot/cold thresholds):
  - RB/WR: boom ≥ 20, bust ≤ 8
  - QB: boom ≥ 24, bust ≤ 12
  - TE: boom ≥ 15, bust ≤ 5
- Optional single **consistency score** = `1 − stdev/mean` (coefficient of variation), if we want one
  number instead of a range.

Minimum sample: **≥ 6 games played** to show anything (else `—`).

## Data & pipeline
- **Source:** ESPN per-athlete game logs — the SAME endpoint `enrichForm`'s `nflGames()` already fetches
  (it pulls the full log, then keeps only the last 4 for form). C reads the FULL log.
- **Where:** a cron enrichment (`enrichNflConsistency`), or fold into the existing NFL gamelog fetch so
  we fetch once and derive both form + consistency.
- **Gating (key difference from form):** runs **year-round**, not offseason-suppressed. Offseason it
  reports the last completed season's consistency (still a useful "was he boom-or-bust?" signal);
  in-season it recomputes on the growing set of games.
- **Coverage:** the same relevance gate as form (top ~30 QB / 45 RB / 55 WR / 24 TE), so we don't fetch
  deep-bench logs.

## Scoring format
Per-game FP depends on PPR / Half / Standard. **v1: compute in PPR** (the board default), store one set.
The board's scoring toggle wouldn't change it — a known, acceptable approximation. Full per-format
triples storage and complicates the client; defer unless required.

## Storage (additive)
```
p.consistency = { floor, ceiling, boom, bust, games, season }   // PPR points, per skill player
```

## Display — needs a decision
The tier column is now occupied by the positional tier (B). Options for C:

- **C1 — replace the tier** with a floor–ceiling range + boom badge: `12–28 · boom 41%`.
- **C2 — keep the tier, add one compact column** (`Floor–Ceil`). More width on an already-busy board.
- **C3 — put it in the row-expand detail / tooltip**, keep the board lean.

**Recommendation: C1** — tier and consistency both answer "how good/reliable is he," so one column
showing the range reads cleanest (positional value already lives in the `#` and Proj/'25 columns). If
keeping the tier matters, **C3** avoids column bloat.

## Edge cases
- Rookies / no prior games → `—` (no sample).
- K/DST → excluded (near-random week to week; no per-game skill signal).
- Missed weeks → percentiles over games PLAYED (a bye/injury week isn't a 0).
- Early in-season → suppressed until ≥ 6 games.

## Cost / effort
~150 full-season gamelog fetches in the cron (≈ the form enrichment's footprint; can share the fetch).
New `enrichNflConsistency.js` + cron wiring + client display. **Roughly a day**, plus a threshold-review
pass on the boom/bust lines (same propose-then-approve loop used for hot/cold — see
[[hot-cold-form-badges]]).

## Verification
Compute against last season's real logs; spot-check archetypes (a steady RB1 → high floor + low bust%;
a big-play WR → high ceiling + high boom AND bust). Confirm rookies / K/DST show `—`, and offseason
shows last-season values.

## Open decisions
1. **Ceiling = P75 or P90?** (P90 makes "ceiling" mean the spike weeks.)
2. **Range vs single score** — show `12–28 · boom 41%`, or one consistency number?
3. **Display: C1 (replace tier) / C2 (add column) / C3 (detail-only)?**
4. **PPR-only v1** OK, or must it follow the scoring toggle?

## Related
Positional tier (the thing this would replace/augment): commit `6144b92`. Form-badge model + the
propose-then-approve threshold process: `api/_lib/enrichForm.js`, `api/_lib/nflForm.js`. Blended
ranking + projections (the values shown alongside): `api/_lib/nflBlend.js`,
`docs/player-rankings-changelog.md`.
