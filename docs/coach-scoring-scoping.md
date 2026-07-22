# Scoring-aware AI Coach in Draft Mode — scoping

**Date:** 2026-07-22 (verified against Draft Mode same day) · **Status:** Phase 1 **already ships**
for the two sources that exist in Draft Mode — **Sleeper (auto-detect) + manual (toggle)**, confirmed
end-to-end in `fantasyedge-draft.html`. **ESPN is the only unbuilt source and is deferred** to ride
with the August ESPN draft-linking work (it needs a *new Draft Mode entry point*, not just wiring).
Phase 2 (roto categories) held until there's demand for non-standard leagues.

> **Verification note (2026-07-22):** review of `fantasyedge-draft.html` found NFL scoring detection
> for Sleeper and manual is already live and wired to the Coach — see "Phase 1 — current state" below.
> The remaining Phase 1 work is ESPN only, and it is larger than "wire a detected value in" because
> ESPN has zero presence in Draft Mode today.

Goal: make the Draft Mode Coach's advice reflect the league's actual scoring, with **auto-detection
as the primary path** (ESPN/Sleeper connections) and **manual entry as the fallback** (offline /
unconnected drafts). This documents what each connection exposes and — the load-bearing question —
how much of the current advice logic can actually consume a scoring profile.

## Key insight: auto-detect and manual converge; parameterization is the real gate

Auto-detected and manually-entered scoring are just two **sources** writing the same `settings`
object that `recommend()` already consumes (`settings.scoring` for NFL; `settings.teams`/`starters`
for roster shape). There is **no separate code path on the value side** — both converge on one
`settings`. So "can they feed the same logic?" is **yes**, *to the degree the logic is parameterized*
— and that splits hard by sport.

| Sport | Value model | Prompt (`api/draft/advise.js`) | Scoring-aware today? |
|-------|-------------|--------------------------------|----------------------|
| **NFL** | `recommendNfl` (`api/_lib/draft.js`) reads `settings.scoring` → `valueOf(p,'ppr'/'std')` off `fpPpr`/`fpStd` + scoring-specific ADP (`adpFor`) + replacement levels | injects `${scoring}` dynamically | ✅ **Yes — end-to-end, for PPR / Half / Standard** |
| **NBA / MLB / NHL (roto)** | `recommendRoto` uses precomputed `zTotal` / per-cat z over a **fixed** category set (baked in `buildNbaDataset` etc. + `NBA_CATS`/`MLB_CATS`/`NHL_CATS`) | categories **hardcoded literally** in each `SYSTEM_*` string | ❌ **No — one category set only** |

- **NFL is already scoring-parameterized.** A detected or manual format just sets `settings.scoring`;
  value, ADP, replacement levels and the analyst prompt all already flow from it.
- **Roto value is hardcoded.** The per-category z-scores are computed upstream in the dataset build
  against the fixed standard cats; `recommendRoto` reweights toward weak cats but cannot change *which*
  cats exist. Feeding it a different scoring profile changes nothing until the value model is
  re-architected to accept a category set.
- **One NFL limit for every source:** the model has exactly **three buckets** (PPR/Half/Standard).
  Detection can *read* exact point values (6-pt pass TD, TE premium), but we **snap to the nearest
  bucket** — surface as "detected custom scoring, using Half-PPR as closest."

## Per-connection scoring visibility

### 1. ESPN — reuse Team Manager's detection as-is

- Scoring is a **league-level** property (`view=mSettings` → `settings.scoringSettings`). There is
  **no separate draft-time scoring** in ESPN — draft scoring *is* league scoring, so Draft Mode reuses
  the exact detection Team Manager already does.
- `api/_lib/espnFantasy.js` already returns `scoringType`, raw `scoringItems`, and
  `lineupSlotCounts`, and **already derives PPR from `statId 53` (receptions):** `>=1 → full`,
  `>=0.5 → half`, else `standard`.
- A draft is tied to a league, so the same authenticated league fetch yields scoring — rides the
  existing `api/espn/index.js` function (a `draftPicks`/`draftScoring` case), **no 12th function**.
- NFL: drop-in. Roto category set: *detectable* from `scoringItems`, not *consumable* yet (Phase 2).

### 2. Sleeper — full profile, public, zero-backend

Both options are CORS-open (`Access-Control-Allow-Origin: *`, verified), same public model as the
already-live draft linking:

- The **already-linked draft object** carries `metadata.scoring_type` (`ppr` / `half_ppr` / `std`) →
  the NFL bucket with **zero extra calls**.
- `GET https://api.sleeper.app/v1/league/<league_id>` (the draft object carries `league_id`) returns
  the **complete** `scoring_settings` (verified live: `rec`, `pass_int`, `bonus_rec_yd_100`, …) plus
  `roster_positions` (e.g. `["QB","RB","RB","WR","WR","TE","FLEX","FLEX","DEF","BN",…]`). One public
  client-side call, no proxy.

### 3. Yahoo — piggybacks on the future OAuth entirely

- League settings — `stat_categories`, `stat_modifiers`, `roster_positions` — are just more resources
  on the same Fantasy API behind the same 3-legged OAuth as `draft_results`.
- **Zero incremental auth** beyond the Yahoo linking already deferred (see
  `draft-linking-research.md`). When Yahoo lands, scoring detection comes with it for free.

### 4. Manual fallback — minimum inputs

- **NFL: essentially already present.** The value model consumes only the **PPR / Half / Standard**
  format, plus **teams** and **starters** — all three already in the Draft Mode UI (the scoring toggle
  exists in `fantasyedge-draft.html`). The manual toggle *is* the fallback; nothing new needed.
- **Roto: N/A until Phase 2.** To be meaningful it needs (a) scoring **type** (categories vs points),
  (b) the **category list / point values**, (c) **roster positions** — but none of it is consumable
  until the roto value model is parameterized, so there's no useful minimal manual input for roto today.

## Proposed plan (phased)

### Phase 1 — current state (verified 2026-07-22)

- **Sleeper — DONE.** `sleeperConnect`/`sleeperStart` read `d.metadata.scoring_type` →
  `SLEEPER_SCORING` (`ppr`, `half_ppr`→`half`, `std`/`standard`→`standard`) → `state.settings.scoring`,
  shown in the detected line ("· PPR"). Flows to the Coach via `advise` (`settings: state.settings`)
  and to board ADP/fpts. (`fantasyedge-draft.html:1022,1084,1104,799,897`)
- **Manual (offline) — DONE.** `#scoringSel` PPR/Half/Standard toggle → `settings.scoring`.
  (`fantasyedge-draft.html:625,929`)
- **ESPN — NOT built; deferred.** Draft Mode has *zero* ESPN presence (`grep -c espn draft.html` → 0).
  This is not "wire a detected value in": it needs a **new ESPN entry point** in Draft Mode —
  an "import from your ESPN league" picker (reusing Team Manager's stored cookie via the `api/espn`
  `leagues` action), **extending that action to NFL** (`ffl` — today it's scoped to the in-season
  engine sports MLB/WNBA), and deriving the PPR bucket from `scoringRaw` (`statId 53`, logic already
  present in `espnFantasy.js`). It **couples naturally to the deferred ESPN draft-linking** (same
  cookie, same new surface), so build the two together in August rather than a standalone ESPN picker.
- Because `recommendNfl` and the NFL prompt already consume `settings.scoring`, the value/prompt side
  needs nothing new — only the ESPN *source* is missing. **No new Vercel function** for any of it.

### Phase 2 — roto category-awareness (bigger; defer unless demand)

- Parameterize the roto value model to accept a **category set / weights** (recompute or reweight the
  z-blocks against detected cats) and make the `SYSTEM_*` prompts build their category list
  dynamically instead of stating a fixed one.
- Detection is already free (ESPN `scoringItems`, Sleeper `scoring_settings`); **consumption is the
  real work**, and it's independent of the connection source.

## Decision

**Phase 1 is effectively shipped** for the sources Draft Mode has today — Sleeper (auto-detect) and
manual (toggle) both flow into `settings.scoring` end-to-end. The **only remaining Phase 1 item is
ESPN**, and it's deferred to be built **with** the August ESPN draft-linking work (same cookie, same
new Draft Mode surface — building an ESPN picker twice is wasteful). Sleeper + manual already cover
the large majority of NFL drafters in the meantime. **Hold Phase 2** (roto) — a real value-model
project gated on parameterizing categories, not on data access, worth it only for non-standard leagues.

## Sources / code references

- Draft advice + prompts — `api/draft/advise.js` (`analyzePick`, `SYSTEM_NFL/NBA/MLB/NHL`,
  `settings.scoring` threading)
- Value model — `api/_lib/draft.js` (`recommendNfl` scoring-parameterized; `recommendRoto` fixed-cat;
  `adpFor`, `valueOf`, `DEFAULT_SETTINGS`)
- Roto category constants — `nbaScoring.js` (`NBA_CATS`/`CAT_KEYS`), `mlbScoring.js`, `nhlScoring.js`
- ESPN scoring detection — `api/_lib/espnFantasy.js` (`view=mSettings`, `scoringSettings`, `statId 53`
  PPR derivation, `lineupSlotCounts`)
- Sleeper — draft `metadata.scoring_type`; `GET /v1/league/<id>` → `scoring_settings` +
  `roster_positions` (public, CORS-open, verified)
- Draft Mode UI scoring toggle — `fantasyedge-draft.html`
- Related: `docs/draft-linking-research.md` (connection/auth findings this builds on)
