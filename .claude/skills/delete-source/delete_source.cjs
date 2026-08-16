#!/usr/bin/env node
/**
 * Delete a source from a NotebookLM notebook by matching its title text.
 * There is no MCP tool for this, so we drive the UI with patchright against a
 * COPY of the authenticated chrome_profile (avoids fighting the MCP server for
 * the profile lock; the delete still hits the real notebook server-side).
 *
 * Usage:
 *   node delete_source.cjs "<title-substring>" [notebookUrl]
 *
 * Safety: if the substring matches 0 or >1 sources, it ABORTS without deleting
 * (prints the matches) so you can never remove the wrong one. Matching is
 * case-insensitive substring on the source's aria-label / visible title.
 * Exit codes: 0 = deleted, 2 = nothing matched, 3 = ambiguous, 1 = error.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

const TARGET = process.argv[2];
const NB = process.argv[3] || 'https://notebooklm.google.com/notebook/9de47de9-4cde-4069-a69e-2e429bda2d20';
if (!TARGET || !TARGET.trim()) {
  console.error('ERROR: provide a title substring, e.g. node delete_source.cjs "SELFTEST"');
  process.exit(1);
}

// Resolve patchright from whichever npx cache the notebooklm-mcp install lives in.
function resolvePatchright() {
  const base = path.join(os.homedir(), '.npm/_npx');
  try {
    for (const hash of fs.readdirSync(base)) {
      const p = path.join(base, hash, 'node_modules/patchright');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return 'patchright'; // last resort: normal resolution
}
const { chromium } = require(resolvePatchright());

const SRC = path.join(os.homedir(), '.local/share/notebooklm-mcp/chrome_profile');
const COPY = path.join(os.tmpdir(), `nblm_del_${process.pid}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(SRC)) { console.error('ERROR: chrome_profile not found — is NotebookLM authenticated?'); process.exit(1); }
  execSync(`rm -rf "${COPY}" && cp -r "${SRC}" "${COPY}"`, { stdio: 'ignore' });

  const ctx = await chromium.launchPersistentContext(COPY, {
    headless: true, viewport: { width: 1400, height: 900 },
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--no-first-run'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let code = 1;
  try {
    await page.goto(NB, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);

    const listTitles = () => page.evaluate(() =>
      Array.from(document.querySelectorAll('.single-source-container')).map(c => {
        const b = c.querySelector('[aria-label]');
        return (b?.getAttribute('aria-label') || c.textContent || '').replace(/\s+/g, ' ').trim();
      }));

    const before = await listTitles();
    console.log('sources before:', JSON.stringify(before, null, 2));
    const t = TARGET.toLowerCase();
    const matches = before.filter(x => x.toLowerCase().includes(t));
    if (matches.length === 0) { console.log(`NOTHING MATCHED "${TARGET}".`); code = 2; return; }
    if (matches.length > 1) { console.log(`AMBIGUOUS — "${TARGET}" matches ${matches.length}:`, JSON.stringify(matches)); code = 3; return; }
    console.log('deleting:', JSON.stringify(matches[0]));

    const container = page.locator('.single-source-container', { hasText: TARGET }).first();
    await container.scrollIntoViewIfNeeded().catch(()=>{});
    await container.hover().catch(()=>{});
    await sleep(500);

    // per-source options (⋮) button
    const moreSelectors = [
      'button:has(mat-icon:text-is("more_vert"))',
      'button[aria-label*="more" i]',
      'button.mat-mdc-menu-trigger',
      'button[aria-label*="option" i]',
    ];
    let opened = false;
    for (const s of moreSelectors) {
      const btn = container.locator(s).first();
      if (await btn.count() && await btn.isVisible({ timeout: 800 }).catch(()=>false)) { await btn.click({ force: true }); opened = true; break; }
    }
    if (!opened) throw new Error('could not find the per-source options (⋮) button');
    await sleep(1200);

    // "Remove source" / "Delete" menu item
    const itemSelectors = [
      'button[role="menuitem"]:has-text("Remove")',
      'button[role="menuitem"]:has-text("Delete")',
      '[role="menuitem"]:has-text("Remove")',
      '[role="menuitem"]:has-text("Delete")',
      'button:has(mat-icon:text-is("delete"))',
    ];
    let clicked = false;
    for (const s of itemSelectors) {
      const mi = page.locator(s).first();
      if (await mi.count() && await mi.isVisible({ timeout: 800 }).catch(()=>false)) { await mi.click(); clicked = true; break; }
    }
    if (!clicked) throw new Error('could not find the Delete/Remove menu item');
    await sleep(1200);

    // confirm dialog (if any)
    const confirmSelectors = [
      '.mat-mdc-dialog-container button:has-text("Delete")',
      '.mat-mdc-dialog-container button:has-text("Remove")',
      '.mat-mdc-dialog-container button:has-text("Confirm")',
      '.mat-mdc-dialog-container button.mdc-button--unelevated',
    ];
    for (const s of confirmSelectors) {
      const c = page.locator(s).first();
      if (await c.count() && await c.isVisible({ timeout: 1000 }).catch(()=>false)) { await c.click().catch(()=>{}); break; }
    }
    await sleep(2500);

    const after = await listTitles();
    console.log('sources after:', JSON.stringify(after, null, 2));
    const still = after.some(x => x.toLowerCase().includes(t));
    if (still) { console.log('RESULT: FAILED — source still present'); code = 1; }
    else { console.log('RESULT: SUCCESS — source deleted'); code = 0; }
  } catch (e) {
    console.error('DELETE ERROR:', e.message);
    code = 1;
  } finally {
    await ctx.close();
    execSync(`rm -rf "${COPY}"`, { stdio: 'ignore' });
    process.exit(code);
  }
})();
