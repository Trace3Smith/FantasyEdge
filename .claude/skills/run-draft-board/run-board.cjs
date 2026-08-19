#!/usr/bin/env node
/**
 * Run the REAL FantasyEdge draft board and screenshot it.
 *
 * Why a driver (not just `vercel dev`): the board needs (a) Clerk auth — an automated
 * browser has no signed-in premium user, and (b) kdst-enriched /api/sports data, which
 * lives only on this feature branch and is deployed NOWHERE, so no live backend serves
 * it. This driver therefore serves the real page + real JS modules from a static server,
 * stubs window.FE (premium + signed-in), and fulfils /api/sports from a fixture that
 * carries the enrichment. Everything the change touches — renderAvailable, kdstLine,
 * kdstScore, the best-available badge + late-window gate — runs for real.
 *
 * Usage:  node run-board.cjs [--filter=dst] [--out=/path/board.png] [--headed] [--late]
 *   --filter   text typed into the board search (default "dst" so K/DST rows show)
 *   --out      screenshot path (default scratchpad/draft-board.png next to this file)
 *   --headed   show the browser (default headless)
 *   --late     drive to the late K/DST window so the "★ best" badge appears. Configures a
 *              short draft (min roster -> rounds=6, smallest league) and drafts the top
 *              player until round >= rounds-2, exercising the REAL round-based lateForKD gate.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execSync } = require('child_process');

const REPO = path.resolve(__dirname, '../../..');           // .claude/skills/run-draft-board -> repo root
const FIXTURE = path.join(__dirname, 'fixtures/nfl-sports.json');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d; };
const FILTER = arg('filter', 'dst');
const OUT = arg('out', path.join(__dirname, 'draft-board.png'));
const HEADED = process.argv.includes('--headed');
const LATE = process.argv.includes('--late');

function resolvePatchright() {
  const base = path.join(os.homedir(), '.npm/_npx');
  try { for (const h of fs.readdirSync(base)) { const p = path.join(base, h, 'node_modules/patchright'); if (fs.existsSync(p)) return p; } } catch {}
  return 'patchright';
}
const { chromium } = require(resolvePatchright());

const CT = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// Minimal static server for the repo (serves the real HTML + /*.js modules). /api and /auth.js are
// intercepted by patchright before they reach here.
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const file = path.join(REPO, p);
      if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nf'); }
      res.writeHead(200, { 'content-type': CT[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const AUTH_STUB = `
window.FE = {
  isSignedIn: () => true,
  isPremium: () => true,
  getToken: () => Promise.resolve('dev-token'),
  apiPost: async (url, body) => { const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    let data = {}; try { data = await r.json(); } catch {} return { ok: r.ok, status: r.status, data }; },
  openSignIn(){}, openSignUp(){}, openPricing(){},
};
try { document.body && document.body.classList.add('is-premium'); } catch {}
`;

(async () => {
  const fixture = fs.readFileSync(FIXTURE, 'utf-8');
  const srv = await serve();
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: !HEADED, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(AUTH_STUB);
  const page = await ctx.newPage();

  // Intercept auth + all API before they hit the static server. NOTE: Playwright matches routes
  // last-registered-FIRST, so the broad catch-all must be registered BEFORE the specific ones, or it
  // shadows them (silently returning {} for /api/sports -> an empty board).
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/draft/advise**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [], board: null, runs: null }) }));
  await page.route('**/api/sports**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: fixture }));
  await page.route('**/auth.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '/* stubbed by run-board.cjs */' }));

  const log = [];
  page.on('console', (m) => { if (m.type() === 'error') log.push('PAGE ERROR: ' + m.text()); });
  page.on('pageerror', (e) => log.push('PAGE EXCEPTION: ' + e.message));

  console.log('opening the real draft board (offline mode)...');
  await page.goto(`${base}/fantasyedge-draft.html?sport=nfl`, { waitUntil: 'domcontentloaded' });
  // auth.js was stubbed, so fire the ready event the page listens for.
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('fe-auth-ready')));

  // Offline path chooser -> pick the manual board.
  await page.locator('#pathOffline').click({ timeout: 8000 }).catch(() => {});

  // --late: shrink the draft on the setup screen so the late K/DST window is a few picks in.
  // rounds = QB+RB+WR+TE+FLEX+K+DST+bench; min starters (K/DST fixed at 1) + 0 bench => rounds 6,
  // so the late window is round >= 4. Also pick the smallest league size to minimise picks.
  if (LATE) {
    // Shrink the roster so rounds is small (min starters + 0 bench; K/DST fixed at 1 => rounds 6) and pick
    // the smallest league, so the late window is only a few picks in. Fill via the number inputs' events.
    for (const [sel, val] of [['#rsQB','1'],['#rsRB','1'],['#rsWR','1'],['#rsTE','1'],['#rsFLEX','0'],['#rsBench','0']]) {
      await page.locator(sel).fill(val).catch(() => {});
    }
    const sizes = await page.$$eval('#teamsSel option', (os) => os.map((o) => Number(o.value)).filter((n) => n >= 2));
    if (sizes.length) await page.selectOption('#teamsSel', String(Math.min(...sizes))).catch(() => {});
    const rb = await page.locator('#rsBench').inputValue().catch(() => '?');
    console.log('roster shrink: rsBench=', rb, '| league size=', sizes.length ? Math.min(...sizes) : '?');
  }

  await page.locator('#startBtn').click({ timeout: 8000 });

  // Board renders after startOffline + loadPool (mock /api/sports).
  await page.locator('#availList .cand').first().waitFor({ state: 'visible', timeout: 15000 });

  if (LATE) {
    // Draft the top overall player (skill first) repeatedly until the "★ best" badge appears on a
    // K/DST row — the real round-based lateForKD gate flipping true. Agnostic to the exact rounds/teams
    // math: we watch for the badge itself. DST filter kept on so the best-DST row is visible to render it.
    const roundNow = async () => { const t = (await page.locator('#clock').textContent().catch(() => '')) || ''; const m = t.match(/Round\s*(\d+)/i); return m ? Number(m[1]) : 1; };
    const hasBadge = async () => (await page.locator('#availList .cand-sug.kdst-best').count()) > 0;
    let guard = 0, found = false;
    while (guard++ < 220) {
      await page.fill('#availSearch', 'dst').catch(() => {});
      if (await hasBadge()) { found = true; break; }
      await page.fill('#availSearch', '').catch(() => {});           // clear so the top pick is a skill player
      const add = page.locator('#availList .cand .cand-add').first();
      if (!(await add.count())) break;                                // board exhausted
      await add.click().catch(() => {});
      await page.waitForTimeout(60);
    }
    console.log('★ badge appeared:', found, '| after', guard, 'picks | round', await roundNow());
  }

  if (FILTER) { await page.fill('#availSearch', FILTER); await page.waitForTimeout(400); }

  // The best-by-kdstScore K/DST isn't necessarily top of the rank-ordered board, so report the badged
  // row explicitly and scroll it into view for the screenshot.
  const badged = await page.$$eval('#availList .cand', (els) => els
    .filter((e) => e.querySelector('.cand-sug.kdst-best'))
    .map((e) => ({ pos: e.querySelector('.pos')?.textContent, nm: e.querySelector('.nm')?.textContent.trim(),
      extra: (e.querySelector('.proj')?.textContent || '').trim(), badge: e.querySelector('.cand-sug.kdst-best')?.textContent.trim() })));
  if (badged.length) { console.log('★ badged rows:'); badged.forEach((r) => console.log('  ', JSON.stringify(r)));
    await page.locator('#availList .cand:has(.cand-sug.kdst-best)').first().scrollIntoViewIfNeeded().catch(() => {}); }
  else {
    const rows = await page.$$eval('#availList .cand', (els) => els.slice(0, 6).map((e) => ({
      pos: e.querySelector('.pos')?.textContent, nm: e.querySelector('.nm')?.textContent.trim(),
      extra: (e.querySelector('.proj')?.textContent || '').trim() })));
    console.log('board rows (filter="' + FILTER + '", no badge — expected outside the late window):');
    rows.forEach((r) => console.log('  ', JSON.stringify(r)));
  }

  await page.screenshot({ path: OUT });
  console.log('screenshot:', OUT);
  if (log.length) { console.log('--- page errors ---'); log.slice(0, 10).forEach((l) => console.log('  ' + l)); }

  await browser.close();
  srv.close();
})().catch((e) => { console.error('RUN FAILED:', e.message); process.exit(1); });
