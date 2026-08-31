# NFL rookie / projection-only player seeding — scoping

**Date:** 2026-07-30 · **Status:** scoped, approved to build (Item 1). Follows the NFL
blended-value rebuild (Sleeper projections + `nflBlend.js`).

## Problem

The NFL player universe is built from ESPN's `byathlete` (last completed season), so anyone
with **no prior ESPN footprint — every true rookie — is absent** and can't receive a projection
or a rank, even though Sleeper projects them. A projection-aware draft board that silently omits
the incoming rookie class is a glaring hole.

## Data (verified)

Sleeper projection rows carry what we need to seed safely:

- `player_id` at the **row** level (e.g. `9221`) — stable, unique → synthetic id `sleeper-<id>`.
- `player.years_exp` — **`0` = rookie** (precise rookie signal; no guessing).
- `team`, `position`, `first/last_name`, and full projected pts (ppr/std/half) + stat line.
- `espn_id` is null in this feed → **no id crosswalk**; matching stays name-based (already works,
  615 matched).

## Approach

In the NFL enrich phase, **after `enrichNflProjections` matches existing players**, collect the
**unmatched** Sleeper rows and seed synthetic records for the qualifying ones. The existing
`enrichNflBlend` + client-side VORP then treat them like any other player (blend collapses to the
projection, since they have no current/prior legs).

### Qualification / dedup (the real risk — deliberately conservative)

- Seed only rows that are **`years_exp === 0`** (guaranteed absent from ESPN's prior-season data)
  **and** unmatched by `keyFor` **and** projected ≥ ~50 PPR (skip camp bodies).
- **Do not** seed non-rookie unmatched rows — those are usually name-mismatches of existing vets
  and would create duplicates. (A later, separate pass with fuzzier matching could reconcile them.)
- Guard: skip if a same `keyFor(pos,name)` already exists in the dataset (belt-and-suspenders).

### Synthetic record shape

`id: 'sleeper-<player_id>'`, name/team/pos from Sleeper, `fpPpr/fpStd` from the projection,
`statLabels` = the position's standard NFL columns, `s1–s6` from the projected line (`s6` = proj
FPTS), `games: 0`, no `prevYear`, `proj` attached, `cats: []`, `hasStats: true`,
`searchOnly: false`. `enrichNflBlend` then yields `blend = projection` (no current/prior legs) —
correct for a rookie on a preseason board — and re-ranks them into the board.

### Compatibility to verify before shipping

Draft board/engine, mock-draft pick recording, roster keys, and Coach all key players by `id`.
A `'sleeper-'`-prefixed id is new — confirm nothing assumes numeric/ESPN ids. Low risk, must check.

## Runs / caveats

- Cron enrich only (like the blend); cold-start serves without rookies until the cron runs.
- If `enrichNflBlend` is skipped (failure-tolerant), seeded players may lack a `rank` and simply
  not render — a clean degradation, no error.

## Out of scope

- Sleeper→ESPN id crosswalk.
- Reconciling non-rookie name mismatches (the fuzzy pass).

## Effort

Medium — concentrated in the projection enrich + a dedup guard + the column mapping; the blend and
ranking need no changes.

## Status — built & verified (2026-07-30)

Shipped in `9ff4c73` (with the projection-season fix). Live: **34 rookies seeded**, all ranked, no
duplicate ids. Also verified the `'sleeper-<id>'` compatibility risk flagged above — **no changes
needed:**

- **Client draft path** (`fantasyedge-draft.html`), full trace: player ids are used only as opaque
  keys — `state.drafted` (Set `.has`/`.add`), `byId` (Map `.get`), and `picks`/`roster` store `id`
  verbatim. A scan for numeric-id assumptions (`parseInt`/`Number`/arithmetic on ids) across the
  draft path found none; the only `Number(...)` calls are on draft settings (pick/round/teams/
  position), never ids. Select → ➕/Draft → record/roster/exclude all route through the id as a
  string.
- **Server engine** (`api/_lib/draft.js`, `advise.js`): `recommend()` filters
  `available = players.filter(p => !new Set(drafted).has(p.id))` — opaque keys again — and `advise`
  loads its pool via `loadPlayers(sport)` (the same cached dataset that now holds the seeded
  rookies), so client and server share the ids.
- **Runtime test:** drafted Fernando Mendoza (`sleeper-13269`) through the real engine; it executed
  cleanly and correctly excluded him from the available candidates afterward.

Method: code-trace + direct runtime exercise of the engine (the decisive test for id-safety), not a
browser click-through.

## Revision — seeding widened beyond rookies (2026-08-30)

**Trigger:** a live offline draft surfaced three players other teams drafted that never appeared in
Draft Mode's Available Players list — Jonathon Brooks, Matthew Golden, Xavier Restrepo.

**What the investigation found.** The premise above — "anyone with no prior ESPN footprint is a true
rookie" — is wrong. ESPN's `byathlete` is not a complete universe of players-with-stats; it is a
partial roster snapshot. Measured against all 32 current 53-man rosters, it covers **450 of 683
(66%) rostered fantasy-skill players**. Two distinct classes of non-rookie fall out of it:

- **Missed the prior season.** `…/seasons/2025/types/2/athletes/{id}/statistics` returns
  `{"error":{"message":"No stats found."}}` — Jonathon Brooks, Tank Dell, Deshaun Watson,
  MarShawn Lloyd.
- **Played, and simply aren't listed.** ESPN's own core API has a full 2025 line while the
  leaderboard has no row — Matthew Golden (14 GP, 29/361), Calvin Ridley (7 GP), Jalen McMillan
  (4 GP), Najee Harris (3 GP), Xavier Restrepo (2 GP). Micah Parsons is absent too, so this is not
  a fantasy-position or volume threshold. For scale, the same endpoint returns 2,138 rows for 2024
  vs 1,706 for 2025.

Because the seed gate required `years_exp === 0`, neither class could enter the pool by any route.
Against Fantasy Football Calculator's consensus ADP (PPR/12-team, 8,234 drafts, week of Aug 23–30),
**12 of the 220 skill players being drafted in real leagues were missing from the pool** — including
Brooks at ADP 92 (round 8) and Golden at ADP 108 (round 9).

**Change.** The gate is now: skill position, projected ≥ `SEED_FLOOR`, unmatched by `keyFor`, and
**on a team**. `years_exp` no longer gates entry (it only sets the `rookie` flag). Teamless
(free-agent) projections stay out — they can't be drafted in a real league, and seeding them would
pad the board.

**The duplicate risk this doc flagged is real, and is now handled by id, not by name.** The original
"do not seed non-rookies — they're usually name-mismatches of existing vets" concern reproduced on
the first run: ESPN lists athlete `4241372` as **"Hollywood Brown"**, Sleeper calls the same person
**"Marquise Brown"**, and `keyFor` cannot see through a nickname. Seeding him would have put one
player on the board twice. Sleeper's per-player record (`/v1/players/nfl/{id}`, ~1KB — not the ~15MB
bulk dump) carries `espn_id`, which joins directly to the ESPN athlete id the build already uses, so
a veteran candidate whose `espn_id` is already in the dataset is dropped. Rookies skip the check
(nothing to collide with), keeping it to a handful of calls per run. A lookup that *fails* blocks its
candidate rather than seeding blind — a duplicated player is a worse board bug than a missing deep
flyer, and the next cron run retries. `counts.projections` now reports `seededVets`, `dupeSkipped`,
and `unresolved`.

`espn_id` is populated sparsely, but in the shape this guard needs — over rostered skill players it
is **100% at 6+ years of experience, ~4% at 1–5, 0% for rookies**. A name that diverges between the
two sources is a long-tenured player's nickname, and those rows all carry an id.

**Also fixed (`nflBlend.js`).** `PROMOTE_FLOOR` (promote a `searchOnly` player with a real
projection onto the board) was compared against `p.fpPpr` — but by that line `p.fpPpr` has already
been overwritten with the blend, and for exactly the players the rule rescues (no actuals) the blend
collapses to `0.65 × projection`. The documented floor of 50 was really ~77. It now tests the raw
projection. Live effect: Jordan James (SF RB, ADP 153, proj 59.7 → blend 38.8) is promoted instead of
being silently withheld.

**Result** (verified by running the real enrichers against live Sleeper/ESPN/FFC data): pool
605 → 614; 8 veterans seeded, 1 blocked as a duplicate, 0 unresolved; 37 rookies unchanged; no
duplicate keys and no player dropped from the pool. The FFC consensus gap goes 12 → 4.

**Knowingly still out.** The 4 remaining consensus gaps are excluded by design, not by accident:
Dean Connors and Bub Means are teamless free agents; Kaelon Black (proj 42.3) and Najee Harris
(proj 26.3) are rostered but sit below `SEED_FLOOR`.

**Xavier Restrepo is not a special case** — worth stating plainly, since he was one of the three
players that triggered this work. He is a normal rostered Titan (ESPN athlete `4431353`, WR #87,
Active; Sleeper `12520`, TEN, Active, WR6 on the depth chart), and he runs the *same* gate as
Golden and Brooks with no name-specific handling anywhere in the pipeline. He passes the position,
id, and on-a-team checks and fails only `pts.ppr >= SEED_FLOOR` — the identical rule that excludes
Black and Harris.

What separates him from Golden and Brooks is purely the size of the projection, and it is not stale
or mismatched data: a fresh pull returns exactly one Restrepo row for 2026, projecting 2 receptions
for 22 yards — **4.8 PPR**, which ranks WR#187 of 1,364 projected WRs. Sleeper's own ADP fields in
that same row put him at `adp_ppr: 675` (effectively undrafted), and FFC does not rank him in any
of its three formats (271 / 232 / 221 players). Reaching him means dropping the floor from 50 to
under 5, which would pull in hundreds of camp bodies. He stays a search-only concern.
