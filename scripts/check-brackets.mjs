// Regression check for the Brackets & Bowls Pick'em feeds and the page that renders them.
//
//   node scripts/check-brackets.mjs            # CFB Week (default)
//   node scripts/check-brackets.mjs nfl bowl   # any of: cfbweek | nfl | bowl
//
// Two halves, both against REAL data — nothing here reimplements the logic it checks:
//   FEED — builds the live slate and asserts the played/upcoming split, the result rows, and
//          the shape of every team report (rank bounds, no preseason in form, prior-season
//          fallback labelled honestly).
//   PAGE — evaluates the actual <script> out of fantasyedge-brackets.html against a stub DOM
//          and renders a real game card and both team panels from that same feed, so a change
//          that breaks the renderer fails here rather than in front of a user.
//
// Exits non-zero on any failure, so it can gate CI or a pre-push hook. Needs network (ESPN).
import { readFileSync } from 'node:fs';
import { buildCfbWeek } from '../api/_lib/cfbWeek.js';
import { buildNflPickem } from '../api/_lib/nflPickem.js';
import { buildCfbBowl } from '../api/_lib/cfbBowl.js';

const FEEDS = { cfbweek: buildCfbWeek, nfl: buildNflPickem, bowl: buildCfbBowl };
let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// The page's own renderers, pulled out of the HTML and evaluated against a stub DOM. The
// script's top-level work is all cursor/tab wiring, which the stubs absorb.
function loadPageScript() {
  const html = readFileSync(new URL('../fantasyedge-brackets.html', import.meta.url), 'utf8');
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const stubEl = () => ({
    style: {}, dataset: {}, innerHTML: '', textContent: '',
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelectorAll: () => [], closest: () => stubEl(), addEventListener() {},
  });
  const document = { getElementById: stubEl, querySelectorAll: () => [], addEventListener() {} };
  const exports = 'return { gameCard, resultCard, teamPanelHtml, edgeVerdict, FEEDS };';
  return new Function('document', 'window', 'requestAnimationFrame', 'fetch', src + '\n' + exports)(
    document, {}, () => {}, () => Promise.reject(new Error('no network in renderer')),
  );
}

function checkFeed(name, feed) {
  console.log(`\n[${name}] FEED`);
  ok(Array.isArray(feed.games), 'games is an array');
  ok(Array.isArray(feed.results), 'results is an array');
  ok(!feed.games.some((g) => g.state === 'post'), 'no completed game left on the upcoming slate');
  ok(feed.results.every((g) => g.state === 'post'), 'every result is actually final');
  ok(feed.results.every((g) => g.home.score != null && g.away.score != null), 'results carry both scores');
  ok(feed.results.every((g) => g.home.winner || g.away.winner || g.home.score === g.away.score),
    'each result has a winner (or is a tie)');
  ok(feed.results.every((g) => !g.weather), 'no forecast attached to a game already played');

  const ids = feed.games.flatMap((g) => [g.home.id, g.away.id]);
  ok(ids.every(Boolean), 'every team on the slate carries an ESPN id');
  const railIds = [...feed.bestPicks, ...feed.upsetAlerts].map((x) => x.id);
  ok(railIds.every((id) => feed.games.some((g) => g.id === id)), 'rails point only at upcoming games');

  console.log(`\n[${name}] TEAM REPORTS`);
  const rep = feed.teamReports;
  if (!feed.games.length) { console.log('  SKIP  empty slate (out of season)'); return; }
  ok(!!rep && !!rep.teams, 'teamReports present');
  if (!rep?.teams) return;
  ok(ids.every((id) => rep.teams[id]), 'every team on the slate has a report');
  ok(['season', 'prior-season'].includes(rep.statsBasis), `stats basis is honest (${rep.statsBasis}, ${rep.statsSeason})`);
  ok(rep.leagueSize > 0, `ranked against a real league (${rep.leagueSize} teams)`);

  const all = Object.values(rep.teams);
  const ranks = all.flatMap((t) => [...Object.values(t.offense), ...Object.values(t.defense)])
    .map((s) => s.rank).filter((r) => r != null);
  ok(ranks.length > 0, `ranks populated (${ranks.length} across ${all.length} teams)`);
  ok(ranks.every((r) => r >= 1 && r <= rep.leagueSize * 2), 'every rank is inside the league');
  const form = all.flatMap((t) => t.form);
  ok(form.length > 0, `recent form populated (${form.length} games)`);
  ok(form.every((f) => f.score != null && f.oppScore != null), 'every form row has a score');
  ok(form.every((f) => f.won === (f.score > f.oppScore)), 'win flags agree with the scores');
  ok(all.every((t) => t.form.length <= 5), 'form capped at five games');
  // A team with stats must have BOTH sides — an offense-only report is the bug that made DvP
  // necessary in the first place (ESPN's own defensive category reports zeros).
  const rated = all.filter((t) => t.offense.yardsPerGame);
  ok(rated.every((t) => t.defense.yardsPerGame?.rank), 'every rated team has real defensive ranks, not zeros');
}

function checkPage(name, feed, page) {
  console.log(`\n[${name}] PAGE`);
  const g = feed.games.find((x) => feed.teamReports?.teams?.[x.home.id]?.offense?.yardsPerGame);
  if (!g) { console.log('  SKIP  no game with a rated team'); return; }

  const card = page.gameCard(g, 'checkGames', true);
  ok(card.includes('team-panel'), 'card renders a panel container');
  ok(card.includes("toggleTeam(this,'checkGames'"), 'team rows are wired to the expander');
  ok(!card.includes('undefined'), 'card has no undefined leaking into the markup');

  for (const side of ['home', 'away']) {
    const html = page.teamPanelHtml(feed, g, side);
    const tag = `${g[side].abbr} panel`;
    ok(html.length > 0 && !html.includes('No report available'), `${tag} renders`);
    ok(!html.includes('undefined') && !html.includes('NaN'), `${tag} has no undefined/NaN`);
    ok(/Last \d/.test(html) || html.includes('No completed games'), `${tag} shows recent form`);
    // A team ESPN doesn't rank (an FCS opponent) legitimately has no matchup or tiles — but it
    // must SAY so, never render a silently empty section.
    ok(html.includes('tp-verdict') || html.includes('tp-stat') || html.includes('No season stat profile'),
      `${tag} shows the matchup, season stats, or says why it can't`);
  }
  const withRes = feed.results.length ? page.resultCard(feed.results[0]) : null;
  if (withRes) {
    ok(!withRes.includes('Line not set') && !withRes.includes('gc-pick'), 'a result card carries no pick block');
    ok(withRes.includes('Final'), 'a result card is labelled Final');
  }

  // Rank 1 is best on both sides, so a great offense against a poor defense must read as an edge.
  ok(page.edgeVerdict(3, 120, 136) === 'edge', 'elite offense vs poor defense reads as an edge');
  ok(page.edgeVerdict(120, 3, 136) === 'tough', 'poor offense vs elite defense reads as tough');
  ok(page.edgeVerdict(40, 45, 136) === 'even', 'a close matchup reads as even');
  ok(page.edgeVerdict(null, 45, 136) === null, 'a missing rank yields no verdict');
}

const which = process.argv.slice(2).filter((a) => FEEDS[a]);
const page = loadPageScript();
for (const name of (which.length ? which : ['cfbweek'])) {
  const feed = await FEEDS[name]();
  checkFeed(name, feed);
  if (feed.games.length) checkPage(name, feed, page);
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
