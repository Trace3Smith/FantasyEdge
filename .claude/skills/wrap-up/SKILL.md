---
name: wrap-up
description: End-of-session wrap-up for FantasyEdge. Summarizes what changed this session (features built, bugs fixed, decisions made, files touched) and appends it as a dated source into the "FantasyEdge Memory" NotebookLM notebook via the notebooklm MCP, so future sessions can recall it. Use when the user says "wrap up", "/wrap-up", "save this session", or is ending a work session.
---

# FantasyEdge session wrap-up

Persist what happened this session into the project's long-term memory (the **FantasyEdge Memory** NotebookLM notebook), so a future session can query it with `ask_question`.

Inspired by pjmattingly/Claude-persistent-memory, but native: no Colab, no browser extension — the `notebooklm` MCP does the ingestion directly.

## Preconditions (check first)

1. Confirm the notebooklm MCP is authenticated: call `get_health`. Expect `authenticated: true`.
   - If `false`, the saved auth likely expired (there is a 24h freshness check). Do NOT silently skip — tell the user, and offer to regenerate `state.json` from the persistent profile (see the `notebooklm-auth-workaround` memory). Only continue once `authenticated: true`.
2. Target notebook: id **`fantasy-football-research`** (immutable id; display name "FantasyEdge Memory"). It is normally the active default, but always pass `notebook_id` explicitly so the wrap-up can never land in the wrong notebook.

## Gather the session facts

Build the summary from THIS conversation plus git, in this order:

1. From the conversation: what the user asked for, what was built/changed, bugs fixed, decisions made and their rationale, and anything left open / TODO.
2. From git, for concrete grounding (run these, don't guess):
   - `git -C /home/trace3smith/FantasyEdge branch --show-current`
   - `git -C /home/trace3smith/FantasyEdge log --oneline -15`
   - `git -C /home/trace3smith/FantasyEdge status --short`
   - `git -C /home/trace3smith/FantasyEdge diff --stat` (and `--stat --cached`) to list files touched this session.
3. Prefer specifics (file names, function names, commit subjects) over vague phrasing — this is a memory others (and future-you) will search.

## Compose the summary

Plain text (NotebookLM indexes text well; no need for heavy markdown). Use today's real date. Template:

```
FantasyEdge Session — <YYYY-MM-DD>
Branch: <branch>

Summary:
<2–4 sentence overview of the session's goal and outcome>

Features / changes:
- <change> (<file(s)>)

Bugs fixed:
- <bug> — root cause: <cause>; fix: <fix> (<file(s)>)

Decisions:
- <decision> — why: <rationale>

Open / next:
- <anything unfinished or deferred>

Commits this session:
- <hash> <subject>
```

Omit any section that has nothing real in it. Keep it truthful — if the session was exploratory or nothing shipped, say so plainly.

## Persist it

1. Show the composed summary to the user and get a quick confirm (or let them edit) before writing — this is an outward-facing append.
2. Try `add_source`:
   - `type: "text"`
   - `notebook_id: "fantasy-football-research"`
   - `title: "FantasyEdge Session — <YYYY-MM-DD>"`
   - `content:` the summary text
3. Verify it landed: `add_source` returns `sourceCountBefore`/`sourceCountAfter` — confirm the count went up and report it.

### Robustness / known failure mode
Always ALSO write the composed summary to a local file `.claude/wrap-up-<YYYY-MM-DD>.txt` before/around calling add_source, so nothing is lost if the tool fails.

History: notebooklm-mcp v2.0.0 shipped with a broken add_source — it errored `Could not open the "Add source" dialog` because its overlay selector `[role="dialog"]` (used with `.first()`) matched a hidden emoji-keyboard element that NotebookLM mounts before the real modal. Fixed 2026-08-16 by patching `dist/notebooklm/selectors.js` to scope the overlay to `.mat-mdc-dialog-container` (see the `notebooklm-auth-workaround` memory for details + backup path).

This patch lives in the npx cache (`~/.npm/_npx/*/node_modules/notebooklm-mcp`). If a future `npx notebooklm-mcp@latest` re-extracts a fresh copy, the patch is lost and add_source will break again with that same error — re-apply the same one-line selector change (or restore the `.bak` backup). If add_source ever fails, fall back to the manual paste: open `https://notebook.google.com/notebook/9de47de9-4cde-4069-a69e-2e429bda2d20?addSource=true` → "Copied text" → paste the local file → Insert.

## Notes

- Free-tier notebook cap is 50 sources. If near the cap, tell the user; consider consolidating older daily notes rather than adding endlessly.
- This skill only writes to NotebookLM. It does NOT commit code or push git — leave that to the user unless they ask.
