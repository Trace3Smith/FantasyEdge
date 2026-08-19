---
name: delete-source
description: Delete a source from a NotebookLM notebook (e.g. "FantasyEdge Memory") by its title. The notebooklm MCP has no remove-source tool, so this drives the NotebookLM UI with patchright. Use when the user asks to delete/remove a source from the notebook, clean up a test/duplicate source, or prune old wrap-up entries.
---

# Delete a NotebookLM source

Removes a source from a NotebookLM notebook by matching its title text. There is
no MCP tool for deletion, so a bundled patchright script drives the UI against a
copy of the authenticated `chrome_profile` (the delete still applies to the real
notebook server-side). Related: [[wrap-up]] writes sources; this removes them.

## Steps

1. Identify the exact source title. If the user was vague, first list current
   sources so you (and they) can pick the right one — either ask `ask_question`
   won't help here, so instead run the delete script's dry read by passing a
   substring you expect and reading the `sources before:` list it prints, or ask
   the user to confirm the exact title string.
2. Confirm with the user which source to delete — deletion is irreversible from
   the notebook. Never guess when multiple sources look similar.
3. Run the bundled script with a **title substring** that uniquely identifies the
   target:

   ```bash
   node /home/trace3smith/FantasyEdge/.claude/skills/delete-source/delete_source.cjs "<title-substring>"
   ```

   - Optional 2nd arg: a notebook URL (`https://notebooklm.google.com/notebook/<uuid>`).
     Defaults to the FantasyEdge Memory notebook.
   - Matching is case-insensitive substring on each source's title.

4. Read the script's output and report honestly:
   - `RESULT: SUCCESS — source deleted` (exit 0): confirm to the user, show the
     `sources after:` list.
   - `NOTHING MATCHED` (exit 2): the substring matched no source — re-check the title.
   - `AMBIGUOUS` (exit 3): the substring matched multiple sources; the script
     **refused to delete** for safety. Give the user the printed list and ask for
     a more specific substring, then re-run.
   - `DELETE ERROR` / `FAILED` (exit 1): the UI flow broke — likely a NotebookLM
     selector change (the ⋮ "Remove source" menu item, or the confirm dialog).
     Inspect the live DOM with a patchright script (as was done for add_source)
     and update the selectors in `delete_source.cjs`.

## Safety notes

- The script **aborts without deleting** on 0 or >1 matches — it only ever
  removes a single, unambiguously identified source. Keep it that way.
- It filters the `.single-source-container` by `hasText`, and verifies by title
  that the source is gone afterward. Trust the printed `RESULT:` line.
- Requires NotebookLM to be authenticated (the `chrome_profile` must exist). If
  auth has lapsed, the page will show a login screen and deletion will fail —
  see the `notebooklm-auth-workaround` memory to restore auth first.
- Robustness: the script resolves `patchright` from whatever `~/.npm/_npx/*`
  cache currently holds the notebooklm-mcp install, so it survives npx cache
  churn. It does NOT need the MCP server running.
