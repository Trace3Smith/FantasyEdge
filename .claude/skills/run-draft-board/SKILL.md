---
name: run-draft-board
description: Boot the REAL FantasyEdge draft board (fantasyedge-draft.html) in a browser and screenshot it, to verify a draft/board/K-DST change actually renders in the running app. Drives the real page + real JS modules via patchright, stubbing Clerk auth and serving an enriched /api/sports fixture. Use when asked to run/see the draft board, verify a board or Draft-Coach UI change, or eyeball K/DST enrichment (labels, best-available badge, late-window gating) in the real app instead of a harness.
---

# Run the FantasyEdge draft board

Launches the real `fantasyedge-draft.html`, walks the offline-draft flow to the board,
and screenshots it — so a board/K-DST/Coach UI change can be verified in the actual app.

## Why a driver (read this before "just use vercel dev")

Three hard constraints make a naive `vercel dev` run fail; the driver handles all three:
1. **Auth.** The board requires a signed-in Clerk *premium* user. An automated browser has
   none, so the driver stubs `window.FE` (premium + signed-in) and fires the `fe-auth-ready`
   event the page waits for.
2. **No enriched backend.** The K/DST enrichment lives only on this feature branch and is
   deployed nowhere — production `/api/sports` returns K/DST with **no** `kdst` field. So the
   driver serves a fixture (`fixtures/nfl-sports.json`) that carries the enrichment. Real
   players/projections/ADP from prod, enrichment injected (until the branch ships).
3. **`vercel dev` env.** Its functions 500 without the pulled prod env (KV/Stripe keys), and
   `.env.local` isn't reliably loaded into functions — flaky. The driver sidesteps functions
   entirely: a tiny static server serves the real HTML + `/*.js` modules, and patchright
   fulfils every `/api/*` call. The frontend code you're verifying runs for real.

## Run it

```bash
node .claude/skills/run-draft-board/run-board.cjs            # screenshot -> draft-board.png (filter: dst)
node .claude/skills/run-draft-board/run-board.cjs --filter=  # no search filter (top-60 skill board)
node .claude/skills/run-draft-board/run-board.cjs --filter=k --out=/tmp/k.png
node .claude/skills/run-draft-board/run-board.cjs --headed   # watch it drive (needs a display/WSLg)
```

Then **Read the screenshot** and check the rows. The driver also prints the top rows as
JSON (`pos`, `nm`, `extra` = the kdst label / proj line, `badge` = the ★ hint text).

Requirements: patchright must be installed (the notebooklm MCP pulled its Chromium into
`~/.cache/ms-playwright`; the driver resolves patchright from `~/.npm/_npx/*`). No Vercel
login, KV, or network needed at run time.

## Refresh the fixture

The fixture is real prod data snapshotted. Rebuild it (e.g. after ADP/projection updates,
or once the branch deploys and prod serves real `kdst`):

```bash
node .claude/skills/run-draft-board/refresh-fixture.cjs
```

It keeps prod's `kdst` if present, else injects plausible enrichment. Trimmed to top-90
skill + all K/DST (~170 KB) to stay light.

## What this DOES and does NOT verify

- ✅ The real board renders: player rows, meta, K/DST enrichment **labels** (v1-v3), and the
  offline flow (path chooser → setup → Start → board).
- ✅ Late-window **gating** (v4): the default run is Round 1, so the "★ best K/DST" badge is
  correctly ABSENT. That's the gate working — not a bug.
- ⚠️ To see the **★ best** badge you must be in the late window (round ≥ rounds-2). The
  offline flow starts at Round 1 and reaching round 14 needs ~150 manual picks, so the badge
  itself is covered by the unit tests + the standalone harness rather than this boot. If you
  need it on screen, temporarily lower `rounds` in the fixture flow or drive picks.
- ⚠️ The Draft **Coach** shows "couldn't pull a recommendation" — `/api/draft/advise` is
  mocked empty. Expected; this skill verifies the board, not the analyst.
- ⚠️ Until the branch deploys, K/DST `kdst` values in the fixture are **synthetic** (real
  players, plausible ranks). Labels/format are real; the exact ranks are illustrative.

## Extending

- Other sports: the flow is NFL-specific (`?sport=nfl`, offline path). Add a fixture +
  `?sport=` for nba/mlb/nhl if needed.
- Mock mode: append `&mode=mock` and adapt the flow (mock-start POST is mocked by the
  catch-all; the AI auto-draft loop differs from offline).
- Route order matters: Playwright matches routes **last-registered-first**, so the broad
  `**/api/**` catch-all is registered BEFORE the specific `**/api/sports**` — do not reorder,
  or `/api/sports` gets shadowed and the board renders empty.
