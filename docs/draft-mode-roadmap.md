# Draft Mode — consolidated roadmap

**Date:** 2026-07-22 · **Status:** Sleeper fully shipped (linking + scoring auto-detect + manual
fallback). Everything else is unbuilt and tracked below.

A single index of what's done and what's left in Draft Mode, so the sequence and dependencies are in
one place. Detailed findings live in the two research docs this links to — this file is the map, not
the territory.

- Provider linking (live draft picks) — `draft-linking-research.md`
- Coach scoring-awareness — `coach-scoring-scoping.md`
- Shared valuation engine (also drives the draft board) — `player-rankings-changelog.md`

## Shipped

- **Sleeper live draft linking** — public/CORS, client-side poll, no serverless function.
- **Sleeper NFL scoring auto-detect** — reads `metadata.scoring_type` → `settings.scoring`,
  end-to-end into the Coach's advice + board valuation.
- **Manual (offline) NFL scoring** — the PPR/Half/Standard toggle in `fantasyedge-draft.html`.
- **Shared valuation-engine changes that reach the draft pool** — from the Player Rankings run
  (`player-rankings-changelog.md`). The pitcher **innings gate** now trims tiny-sample arms out of the
  shared `buildDataset` pool the draft board draws from, and **two-way players** (Ohtani) carry a
  `twoWay` guard so they stay a single draftable player. (The pitcher z-sum reorders the *rankings*
  board only; draft *values* use `zTotal`, which is unchanged.)

## Remaining roadmap

### 1. ESPN live draft linking — spike-gated (~August)

- **Auth: solved.** Reuses Team Manager's stored `espn_s2`/`SWID` cookie; only a new `draftPicks`
  case in the existing `api/espn` function — **no new auth, no new Vercel function** (stays 11/12).
- **Blocked on one cheap test:** does ESPN's `mDraftDetail` REST view populate picks *mid-draft*, or
  only *after* the draft closes? Needs a live spike against a real in-progress ESPN draft — hence
  August. **If it passes** → ~half-day feature (reuse `espnGet`/`getCreds` + `kona_player_info` id
  crosswalk + a frontend poll). **If post-draft-only** → would need ESPN's WebSocket draft protocol =
  much bigger, likely skip.
- Unlike Sleeper, ESPN polling routes **through our backend** (cookie is server-side only) — real
  per-poll invocation cost during drafts.
- **Runnable test plan for the spike:** `espn-draft-spike-plan.md` (harness + pass/fail criteria + the
  follow-on build if it passes).
- Detail: `draft-linking-research.md` → ESPN section + "Auth reuse — CONFIRMED".

### 2. ESPN scoring detection — rides with #1 (~August)

- Detect NFL PPR/Half/Standard from the ESPN league (`statId 53` logic already exists in
  `espnFantasy.js`).
- Deferred to build **with** ESPN linking: same cookie, same new Draft Mode entry point (an
  "import from your ESPN league" picker), and it needs the `api/espn` `leagues` action extended to
  NFL (`ffl` — today it's scoped to the in-season engine sports MLB/WNBA). Building it standalone
  would mean an ESPN picker built twice.
- Detail: `coach-scoring-scoping.md` → Phase 1 (ESPN).

### 3. Yahoo live draft linking — deferred, heaviest lift

- Yahoo's API returns live `draft_results` mid-draft, **but** needs a wholly new **OAuth 2.0
  (3-legged)** stack: registered Yahoo app, redirect/consent handler (**likely a new Vercel function
  → 12/12, the last slot**), token storage + refresh, plus a Yahoo-id → board crosswalk.
- Lowest priority — ESPN + Sleeper cover the dominant platforms; Yahoo is the long tail.
- Detail: `draft-linking-research.md` → Yahoo section.

### 4. Yahoo scoring detection — free with #3

- League `stat_categories` / `stat_modifiers` / `roster_positions` come on the same OAuth API as
  `draft_results` — **zero incremental auth** once Yahoo linking lands.
- Detail: `coach-scoring-scoping.md` → Per-connection (Yahoo).

### 5. Phase 2 — roto category-aware Coach (NBA/MLB/NHL) — held until demand

- The roto value model + prompts are **hardcoded to one standard category set** today. Scoring-aware
  advice for non-standard roto leagues means re-architecting the value model to accept a category
  set/weights and building the prompt category lists dynamically.
- Detection is already free (ESPN `scoringItems`, Sleeper `scoring_settings`); **consumption is the
  real work.** Only pays off for non-standard roto leagues.
- Detail: `coach-scoring-scoping.md` → Phase 2.

## Sequence & dependencies

1. **August:** run the ESPN `mDraftDetail` spike → if it passes, ship **#1 + #2 together** (ESPN
   linking + scoring, one new surface, no new function).
2. **Later / if demand:** **#3 + #4** (Yahoo linking + scoring) — the OAuth build that likely spends
   the last function slot.
3. **Only if non-standard roto leagues matter:** **#5** (roto category-awareness).

## Budget note

At **11/12 Vercel functions**. ESPN work (#1/#2) needs **none** (new action in the existing
`api/espn` function). Yahoo (#3/#4) likely needs the **last slot** — weigh that before spending it
elsewhere.
