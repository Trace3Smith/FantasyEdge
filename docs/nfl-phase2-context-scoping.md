# NFL Phase 2 — team-context opportunity modifiers — scoping

**Date:** 2026-07-30 · **Status:** scoped, deferred (build after rookie seeding / when the season
nears). Follows the NFL blended-value rebuild.

## Goal

Layer **target share** and **pace** as *opportunity* signals — clearly labeled as opportunity, not
predictive precision — that nudge the ranking, without pretending to be PFF-grade analysis. Strictly
free ESPN data.

## Data (verified, free)

- **Team targets:** `receiving.receivingTargets` (ESPN team-statistics endpoint).
- **Player targets:** read at build (`n.tgt`) but currently stored only for WR (the `Tgt` column) —
  Phase 2 stores `n.tgt` on all pass-catchers.
- **Pace:** `passing.totalOffensivePlays` ÷ `gamesPlayed` (team stats), vs a league average.
- Source: one team-stats call per team (32) — piggyback the per-team fetch `buildDsts` already does,
  or a small dedicated `enrichNflContext` step.

## The critical honesty caveat (drives the design)

Target share and pace are **current-stat-season** figures. In the **offseason** they are *last
season's* usage — stale and actively misleading for players who changed teams (the exact players
you'd want context on), while Sleeper's projection **already prices in** expected new-team usage. So:

- **In-season:** target share / pace reflect the real current situation → apply as a modifier on the
  **current-pace leg** of the blend.
- **Preseason / offseason:** show them as **context/display only** ("2025 usage"), **not** tilting
  the value — the projection already accounts for expected roles. (Mirrors how `nflBlend` keys off
  `inSeason`.)

## Modifier mechanics (modest + capped)

- `targetShare = playerTargets / teamTargets`; `paceIndex = teamPlays-per-game ÷ leagueAvg`.
- Build a small **opportunity index** per skill player (target share vs positional baseline for
  pass-catchers; pace for all skill), converted to a **capped ± tilt (≤ ~8%)** on the in-season
  current-pace component — a nudge, never a rewrite. QBs largely exempt from target share.
- Surface it as an explicit **"Opportunity"** label (e.g. "28% target share · fast pace") so it reads
  as context, not a projection.

## Positions

Target share → WR / TE / RB; pace → all skill. QB effectively pace-only.

## Out of scope (paid / not-free — flagged, not faked)

O-line grades (PFF), defense-vs-position SOS, snap share.

## Effort

Medium — new team-stats fetch + store player targets + the capped-modifier math + a display label +
the in-season/offseason gating.

## Sequencing

Do **rookie seeding first** (self-contained, fills an obvious hole). Phase 2 is only meaningfully
active in-season, so there's no urgency before the season starts.
