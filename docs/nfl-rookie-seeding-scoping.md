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
