# ESPN live-draft spike — test plan

**Date:** 2026-07-26 · **Status:** ready to run (needs a live ESPN draft + a member cookie). Gates
roadmap items **#1 + #2** (ESPN live linking + scoring). Background: `draft-linking-research.md` → ESPN
section. Roadmap: `draft-mode-roadmap.md` → #1.

## The one question

Does ESPN's `mDraftDetail` REST view expose draft picks **incrementally, mid-draft** — or only **after
the draft closes**?

The live draft room is socket-based; the concern (from the `espn-api` parser, which early-returns when
`draftDetail.drafted` is false) is that `?view=mDraftDetail` may stay empty / `drafted:false` until the
draft finishes. If picks appear incrementally, a REST poll can power a live linker. If not, it can't.

## Why it decides the feature

| Outcome | Meaning | Next step |
|---|---|---|
| **PASS** — `picks[]` grows during the draft | REST polling works | ~half-day build: `draftPicks` case in `api/espn` + `kona_player_info` id crosswalk + a ~10s frontend poll. **No new function** (stays 11/12). Ship #1+#2 together. |
| **FAIL** — picks stay empty / `drafted:false` until close | REST view is post-draft only | ESPN would need its **WebSocket draft protocol** — a much bigger lift. Likely **skip ESPN live linking**; Sleeper stays the only live provider. |

## Prerequisites

- A **live ESPN NFL draft** you're a member of, observed start-to-finish. Two ways to get one:
  - **(A, recommended — controllable, any time):** create a **throwaway ESPN fantasy league** (free),
    invite a second account or fill with autopick teams, and **run its draft yourself** ("Draft Now" /
    schedule it a few minutes out). Full control over timing; no waiting for August.
  - **(B):** your real league's actual draft in August. Real conditions, but one shot at a scheduled
    time — run the harness alongside it.
- The **`espn_s2` + `SWID` cookies** for an account that is a **member of that league** (non-members get
  `401`). Same cookies Team Manager stores — grab them from the browser (DevTools → Application →
  Cookies on `fantasy.espn.com`), or reuse a connected account's.
- The **league id** (in the league URL) and **season year** (e.g. 2026).

## The harness (throwaway — run standalone with node)

Server-side node so the ESPN cookie actually attaches (the browser won't send ESPN's cross-site cookie).
Polls every 10s, logs the signals we care about + the raw `draftDetail` (minus the picks array) once, to
a file. Uses the same endpoint/cookie shape as `espnGet` in `api/_lib/espnFantasy.js`.

```js
// espn-spike.mjs — run: ESPN_S2='...' SWID='{...}' LEAGUE_ID=123 SEASON=2026 node espn-spike.mjs
import { appendFileSync, writeFileSync } from 'node:fs';
const { ESPN_S2, SWID, LEAGUE_ID, SEASON = new Date().getFullYear() } = process.env;
if (!ESPN_S2 || !SWID || !LEAGUE_ID) { console.error('set ESPN_S2, SWID, LEAGUE_ID (and SEASON)'); process.exit(1); }
const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=mDraftDetail`;
const cookie = `espn_s2=${ESPN_S2}; SWID=${SWID}`; // raw braces on SWID, as espnGet uses
const LOG = `espn-spike-${LEAGUE_ID}-${Date.now()}.log`;
let sampled = false;
async function poll() {
  const t = new Date().toISOString();
  try {
    const res = await fetch(url, { headers: { Cookie: cookie, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) { appendFileSync(LOG, `${t} AUTH ${res.status} — cookie not a member / expired\n`); return; }
    if (!res.ok) { appendFileSync(LOG, `${t} HTTP ${res.status}\n`); return; }
    const data = await res.json();
    const d = data.draftDetail || {};
    const picks = d.picks || [];
    const last = picks[picks.length - 1] || {};
    const line = `${t} picks=${picks.length} drafted=${d.drafted} inProgress=${d.inProgress} lastOverall=${last.overallPickNumber ?? '-'} lastPlayerId=${last.playerId ?? '-'}`;
    console.log(line); appendFileSync(LOG, line + '\n');
    if (!sampled && (picks.length || d.drafted != null)) { // capture the real shape once (was never obtained before)
      sampled = true;
      writeFileSync(`espn-spike-shape-${LEAGUE_ID}.json`, JSON.stringify({ draftDetailKeys: Object.keys(d), samplePick: picks[0] || null, drafted: d.drafted, inProgress: d.inProgress }, null, 2));
    }
  } catch (e) { appendFileSync(LOG, `${t} ERR ${e.message}\n`); }
}
poll();
const iv = setInterval(poll, 10_000);
process.on('SIGINT', () => { clearInterval(iv); console.log('\nlog:', LOG); process.exit(0); });
```

## Procedure

1. **Start the harness BEFORE the draft opens** (so we capture the `drafted:false` / empty baseline).
   Confirm the first lines log without a `401` (proves the cookie is valid + a member).
2. **Run the draft.** Let it proceed through several picks (≥ a full round). Watch the console.
3. **Watch for the transition** — the whole test is whether `picks=` climbs *while the draft is open*:
   - Does `picks` go `0 → 1 → 2 → …` as picks are made, or stay `0`?
   - Does `inProgress` flip to `true` (and when — at open, or never)?
   - Does `drafted` stay `false` throughout and only flip `true` at close?
4. **Let the draft finish**, keep polling ~1 min past close, then `Ctrl-C`. Note the final state.
5. Keep the `.log` and the `-shape-*.json` sample.

## Pass / fail criteria

- **PASS:** `picks.length` **increases during the draft** (mid-draft rows with `drafted:false` or
  `inProgress:true` and a partial `picks[]`). REST polling can drive a live linker.
- **FAIL:** `picks` stays **empty (or `drafted:false` with no picks) until the draft closes**, then jumps
  to the full set. REST view is post-draft only.
- **AUTH-BLOCKED (inconclusive):** persistent `401/403` → the cookie isn't a member or expired; refresh
  it and re-run. Not a real result.

## Record this

| Time (rel. to draft) | picks | drafted | inProgress | notes |
|---|---|---|---|---|
| pre-open | | | | baseline |
| after pick 1 | | | | **the key row** |
| mid round 1 | | | | |
| after last pick | | | | |
| +1 min post-close | | | | |

Also confirm from the `-shape-*.json`: the pick object really carries `playerId` (numeric), `teamId`,
`overallPickNumber`, `roundId`, `roundPickNumber` (validates the assumed shape for the crosswalk work).

## If PASS — the follow-on build (so it's ready)

1. `api/espn/index.js`: add `case 'draftPicks'` → `getCreds(redis, userId)` → `espnGet(<mDraftDetail
   url>, creds)` → return `draftDetail.picks`.
2. ESPN-`playerId` → our-board crosswalk from the `kona_player_info` view (`espnFantasy.js` already uses
   it for free agents) — pre-fetch/cache the league's player map once per draft.
3. Frontend: an "import from your ESPN league" entry point (shared with #2 scoring detection) + a ~10s
   poll of `draftPicks`, feeding the same pick stream Sleeper uses.
4. #2 scoring: extend the `api/espn` `leagues` action to NFL (`ffl`) and read PPR/Half/Standard
   (`statId 53` logic already in `espnFantasy.js`).

## Notes

- **Cost:** an ESPN poll is browser → our `/api/espn` → ESPN (cookie is server-side only), ~every 10s per
  active drafter. Real per-poll invocation cost during drafts, unlike Sleeper's free browser-direct
  model. No new function, but not zero-cost.
- **ToS/rate:** reading the user's OWN league with their OWN cookie — identical to today's roster reads.
  A ~10s poll is trivial volume; standing risk is ESPN changing/blocking, same as now.
- **Throwaway:** the harness is disposable (delete after). Nothing here ships; it only answers the gate.
