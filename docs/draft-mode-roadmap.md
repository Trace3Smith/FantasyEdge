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

### Coach recommendation & grading refinements

Non-LLM engine tuning in `api/_lib/draft.js` (recommendations + mock AI opponents) and the client-side
pick-grade badges in `fantasyedge-draft.html`. All value logic stays on the shared board value function;
each change was offline-verified against synthetic drafts.

- **VONA same-position drop-off feeds pick urgency** (`dc8d123`) — the NFL recommender now measures the
  value cliff between the best available player at a position and the next one (on raw board value,
  which equals the VORP gap since the shared replacement level cancels in a same-position difference)
  and folds it into `needFactor` as extra urgency to grab a position before its tier breaks. Normalized
  by the UI's steal/reach magnitude (15), capped at 1.5×, and dampened to 0.4× strength once the
  starting slot is filled so it can't reignite depth-hoarding at a position we're already set at.
- **Justified picks are no longer badged as a "reach"** (`8c65a22`) — a pick below the best-available
  board value keeps its exact value delta but is graded fair-value (not "reach") when it (a) fills an
  open starting slot, (b) is the Coach's own suggested player, or (c) came at or after the player's ADP.
  (a)/(b) apply to the user's picks only — the Coach tracks the user's roster + suggestion, not
  opponents' — while the ADP check applies to any pick. Open-need excludes FLEX/UTIL, matching the
  engine's server-side need model.
- **Tighter 3rd-QB cap in single-QB leagues** (`2ffcbd1`) — a 3rd QB's desire drops from 0.10 to 0.05,
  so only a real value outlier now clears the shortlist. Scoped to `starters.QB === 1`; superflex/2-QB
  leagues keep the looser curve, and the 2nd-QB backup and 4th+ tail are unchanged.
- **VONA scarcity clause trimmed to just the numbers** (`844b0bf`) — the deterministic clause the user
  always sees on a scarcity-swing pick now states only the startable-count tradeoff ("Only N startable
  QB left vs. M RB.") and drops the "so QB is drying up faster — worth prioritizing over `<name>`"
  reasoning tail. The analyst already gets the same facts via the SCARCITY TRADEOFF prompt note and owns
  the "why," so the reasoning isn't stated twice in slightly different words.
- **TE cap: extra TEs evaluated as flex bodies, not a soft-capped position** (`629db26`, `8457d55`) — in
  a standard single-TE league only the lone starter is an "auto" TE; every TE beyond it competes for the
  FLEX that RB/WR also fill. The 2nd TE keeps a **low baseline desire (0.15)** so it stays normal bench
  insurance that naturally falls to later rounds — not suppressed or hard-gated — with an override that
  **spikes** its desire to the RB/WR depth curve when the best available TE currently out-values the best
  flex-eligible RB/WR (`recommendNfl` now exposes `bestVorp` per position as the shared flex comparator;
  `max(baseline, override)` so the flex spike can only raise, never suppress). Stops the Coach
  over-drafting a 3rd TE ahead of thin WR/RB bench depth (seen in a live mock). Scoped to
  `starters.TE === 1`; TE-premium / 2-TE-starter leagues keep the looser soft-cap curve.

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

### 6. VORP hides deep-position ADP value from the Coach — follow-up (unscheduled)

- Surfaced while fixing the flex-worthy-TE2 chat bug. The Coach's shortlist is VORP-gated, so a strong
  player at a **deep** position can sit **below replacement** and never appear as an alternative even
  when he's a genuine ADP/points value. Concrete case: **Mike Evans** — proj **222**, ADP value, yet
  **VORP −8.8** in a deep WR pool (WR replacement ≈ 183), so he was invisible to the chat while a
  lower-proj RB was recommended.
- This is **by-design VORP behavior** (a 174-pt WR really is replacement-level when WR is that deep), so
  it's not strictly a bug — but it means the Coach can't weigh "raw points / ADP value at a deep
  position" the way a human drafter does. Options to consider: surface a small "best-by-ADP-value" slate
  alongside the VORP shortlist, or let the chat see a few sub-replacement high-proj names flagged as
  "deep-position value, low VORP." **Not fixing now** — logged for a deliberate design pass.

## Sequence & dependencies

1. **Run the ESPN `mDraftDetail` spike — no longer strictly August-gated.** The test plan
   (`espn-draft-spike-plan.md`) runs against a **self-created throwaway ESPN league** whose draft you
   run yourself, so the gate can be answered **any time** — not only when real NFL drafts ramp. If it
   passes, ship **#1 + #2 together** (one new surface, no new function), ideally landed before August
   drafts, when live linking actually pays off.
2. **Later / if demand:** **#3 + #4** (Yahoo linking + scoring) — the OAuth build that likely spends
   the last function slot.
3. **Only if non-standard roto leagues matter:** **#5** (roto category-awareness).

## Budget note

At **11/12 Vercel functions**. ESPN work (#1/#2) needs **none** (new action in the existing
`api/espn` function). Yahoo (#3/#4) likely needs the **last slot** — weigh that before spending it
elsewhere.
