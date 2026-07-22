# Draft-linking research — live in-progress draft APIs

**Date:** 2026-07-09 (updated 2026-07-22) · **Status:** Sleeper shipped; ESPN auth-reuse **confirmed against our code**, live-data spike still deferred to ~August; Yahoo held.

Research done before writing any provider-linking code, per the Draft Mode guardrail
("don't assume ESPN/Yahoo work like the roster cookies — report findings first"). This
documents whether each provider exposes **live, in-progress** draft picks and what auth
that needs, so we don't re-derive it later.

## Summary

| Provider | Live picks mid-draft? | Auth | Player identity in picks | Verdict |
|----------|----------------------|------|--------------------------|---------|
| **Sleeper** | Yes (public feed) | None (public) | name + pos + team metadata | **Shipped** — client-side poll |
| **ESPN** | **Unverified** (likely post-draft only) | **Reuses Team Manager's stored cookie** — no new auth, no new function | numeric `playerId` only | Auth solved; spike the live-data question, ~August |
| **Yahoo** | Yes, mid-draft | **New OAuth 2.0** (3-legged) | numeric player id | Deferred (heaviest lift) |

## Sleeper — shipped (client-side, no new serverless function)

- `GET https://api.sleeper.app/v1/draft/<draft_id>` and `GET /draft/<draft_id>/picks` are
  **public, no auth**. Responses send `Access-Control-Allow-Origin: *` (verified) → callable
  directly from the browser, no proxy needed.
- Draft object: `status`, `type` (snake/linear/auction), `settings.{teams,rounds}`,
  `metadata.scoring_type`, `draft_order`, `slot_to_roster_id`, `sport`, `season`.
- Pick object: `player_id`, `pick_no`, `round`, `draft_slot`, `picked_by`, `roster_id`,
  and **`metadata.{first_name,last_name,position,team}`** — enough to match to our board by
  normalized name (+ DST by team) with no id crosswalk.
- Rate limit: "stay under ~1000 calls/min or risk an IP block." A 5–10s poll is ~6–12
  calls/min — trivially safe. We poll every ~6s while the draft is active.
- Supported here: NFL + NBA (the sports Sleeper drafts and our board covers).

## ESPN — auth-compatible but mechanism-risky; live spike required

- Endpoint: `…/apis/v3/games/ffl/seasons/<yr>/segments/0/leagues/<id>?view=mDraftDetail`
  on `lm-api-reads.fantasy.espn.com` — the **same `espn_s2`/`SWID` cookies** we already
  store for roster reads. No new auth type.

### Auth reuse — CONFIRMED against our code (2026-07-22)

Verified in `api/espn/index.js` + `api/_lib/espnFantasy.js`: the draft view rides the exact
same authenticated session Team Manager already uses, so **every hard piece already exists** —
we reuse the stored cookie, don't re-prompt the user, and add **no new Vercel function**.

| Piece a live ESPN draft linker needs | Already built (for Team Manager) |
|--------------------------------------|----------------------------------|
| Cookie capture + one-time connect | `connect` action |
| Cookie storage, per Clerk `userId` | Redis via `getCreds(redis, userId)` |
| Authenticated ESPN GET client | `espnGet(url, creds)` — sets `Cookie:` server-side |
| Read domain | `lm-api-reads.fantasy.espn.com/.../segments/0/leagues/{id}?view=…` (same `v3Read`) |
| Numeric `playerId` → player crosswalk | `view=kona_player_info` (already used for free agents) |

- **Wiring:** `api/espn/index.js` is a single function that routes on `req.body.action`
  (`status`/`connect`/`leagues`/`apply`/…). A live linker is one more case, e.g.
  `case 'draftPicks'` — fetch `?view=mDraftDetail` via `espnGet` with the user's `getCreds`,
  map ids through `kona_player_info`, return picks. **Stays at 11/12 functions.**
- **BUT it is NOT client-side like Sleeper.** ESPN's cookie can only be sent server-side
  (the browser won't attach ESPN's cross-site cookies, and `Cookie` is a forbidden `fetch`
  header). So an ESPN poll is **browser → our `/api/espn` function → ESPN**, every ~10s per
  active drafter — real per-poll invocation cost during drafts, unlike Sleeper's free
  browser-direct model. No new function, but not zero-cost either.
- **ToS/rate posture is unchanged from today:** we'd read the user's OWN league with the
  user's OWN stored cookie — identical to the roster reads Team Manager already does. A ~10s
  poll is trivial volume; the standing risk is ESPN changing/blocking, same as now.
- Response shape (confirmed from the `espn-api` library parser; a live JSON sample was not
  obtainable — ESPN now `401`s virtually all leagues to non-members, including the old
  public example league):
  ```
  data.draftDetail = {
    drafted:    <bool>,     // draft has produced results
    inProgress: <bool>,     // present in ESPN's schema (see caveat below)
    picks: [ {
      playerId:          <number>,  // ESPN player id — NUMERIC ONLY, no name/pos/team
      teamId:            <number>,
      roundId:           <number>,
      roundPickNumber:   <number>,
      overallPickNumber: <number>,
      bidAmount:         <number>,  // auction
      keeper:            <bool>,
      nominatingTeamId:  <number>,
      memberId:          "<GUID>",
      autoDraftTypeId:   <number>
    }, … ]
  }
  ```
- **Two differences from Sleeper that a future ESPN linker must handle:**
  1. Picks carry only a **numeric `playerId`** — no name/pos/team metadata. Needs an
     ESPN-playerId → our-pool map first (buildable from the `kona_player_info` view, which
     `api/_lib/espnFantasy.js` already uses for free agents), not a drop-in name match.
  2. **No per-pick timestamps** — live-state detection would rely on `picks[]` length plus
     the `drafted`/`inProgress` flags.
- **Open question the live spike must answer:** the `espn-api` parser **early-returns when
  `draftDetail.drafted` is false**, hinting ESPN's REST view may only expose picks *after*
  the draft closes (the live draft room is socket-based), not incrementally like Sleeper.
  The spike must falsify: *does `picks[]` grow mid-draft (does `inProgress` flip to `true`
  with partial picks), or stay empty/`drafted:false` until close?* If post-draft-only,
  `mDraftDetail` polling can't power a live linker → ESPN would need the socket path (a much
  bigger lift).
- **Spike plan (deferred to ~August, when a real ESPN draft/mock exists + user cookies):** a
  throwaway harness that polls `?view=mDraftDetail` every ~10s and logs `picks.length`, the
  `drafted`/`inProgress` flags, and any per-pick ordering fields over the course of a live
  draft. Not built yet — nothing to test against until NFL drafts ramp in August.

## Yahoo — works mid-draft, but wholly new auth stack

- Yahoo's `draft_results` **does** return picks-so-far during a live draft (excludes only the
  player currently being nominated in auctions).
- Requires **OAuth 2.0 (3-legged)** — completely different from the cookie approach: a
  registered Yahoo app (client id/secret), a redirect/consent flow, and server-side token
  storage + refresh. Plus a Yahoo-player-id → our-pool crosswalk.
- Lowest priority given the new-infrastructure cost.

## Decision

Ship **Sleeper** now (public, client-side, no new function — stays at 11/12). **ESPN**: auth is
**solved and confirmed** (reuses Team Manager's stored cookie, adds only a `draftPicks` case to
the existing function — no new auth, no new function, no re-prompt). The **only** thing gating it
is the live-data question — does `mDraftDetail` populate picks mid-draft or only at close — which
needs a live spike once a real ESPN draft exists (~August). If the spike passes, it's roughly a
half-day feature; if it's post-draft-only, the REST path can't power a live linker (socket path =
much bigger, likely not worth it). **Yahoo** deferred — wholly separate OAuth 2.0 stack, likely a
new function (→ 12/12, our last slot), for the smallest slice of users; ESPN + Sleeper cover the
dominant platforms. Build neither today; run the ESPN spike first in August.

## Sources

- Sleeper API docs — https://docs.sleeper.com/
- ESPN `mDraftDetail` (ffscrapr) — https://ffscrapr.ffverse.com/articles/espn_getendpoint.html
- ESPN draft parsing (espn-api library) — https://github.com/cwendt94/espn-api
- Yahoo Fantasy API guide — https://developer.yahoo.com/fantasysports/guide/
- Yahoo `draft_results` (wrapper docs) — https://yahoo-fantasy-api.readthedocs.io/en/latest/yahoo_fantasy_api.html
