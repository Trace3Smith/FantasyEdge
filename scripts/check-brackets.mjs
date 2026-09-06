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
import { currentSeasonRankable, TEAM_REPORT_VERSION } from '../api/_lib/teamReport.js';
import { CFB_VENUES } from '../api/_lib/cfbVenues.js';
import { staleWeatherGames } from '../api/_lib/pickem.js';
import { groupInjuries, INJURY_IMPACT_VERSION } from '../api/_lib/injuryGroups.js';

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

// The generated stadium table (scripts/gen-cfb-venues.mjs). Structural only — a regeneration that
// wrote a null island, a swapped lat/lon, or an eastern-hemisphere longitude fails here.
// Which games the serve-time top-up picks up. This is the whole decision — the rest is one fetch
// per selected game — and it has to be tight in both directions: too eager turns a public URL into
// repeated upstream traffic, too shy and the forecast on a card about to kick off stays a day old.
function checkTopUp() {
  console.log('\n[synthetic] WEATHER TOP-UP SELECTION');
  const now = Date.parse('2026-09-05T12:00:00Z');
  const at = (h) => new Date(now + h * 3600000).toISOString();
  const wx = (minsAgo) => ({ tempF: 70, condition: 'Clear', fetchedAt: new Date(now - minsAgo * 60000).toISOString(), url: 'https://api.weather.gov/gridpoints/X/1,2/forecast/hourly' });
  const game = (id, kickInH, weather, state = 'pre') => ({ id, date: at(kickInH), state, weather });

  const picked = (games) => staleWeatherGames({ games }, now).map((g) => g.id);

  ok(picked([game('a', 3, wx(45))]).includes('a'), 'a game 3h out with a 45m-old forecast is refreshed');
  ok(!picked([game('b', 3, wx(5))]).length, 'a game 3h out with a 5m-old forecast is left alone');
  ok(!picked([game('c', 48, wx(600))]).length, 'a game two days out is not refreshed, however stale');
  ok(!picked([game('d', 3, wx(600), 'post')]).length, 'a finished game is never refreshed');
  ok(!picked([game('e', 3, null)]).length, 'a game with no forecast (dome/unknown venue) is skipped');
  ok(!picked([game('f', 3, { tempF: 70, fetchedAt: at(-10) })]).length,
    'a forecast with no url (payload built before the top-up) is skipped, not crashed on');
  ok(picked([game('g', 3, { tempF: 70, url: 'https://api.weather.gov/x' })]).includes('g'),
    'a forecast with no timestamp is treated as stale');
  ok(picked([game('h', 1, wx(31)), game('i', 1, wx(29))]).join() === 'h',
    'the staleness threshold is honoured exactly (31m refreshed, 29m not)');
  ok(picked([game('j', -1, wx(600))]).includes('j'), 'a game already under way is still refreshed');
  ok(!staleWeatherGames({}, now).length && !staleWeatherGames(null, now).length,
    'an empty or missing feed selects nothing');
}

// The injury grouping rules. All pure, so the whole rule set is exercised without a network call.
function checkInjuryGroups() {
  console.log('\n[synthetic] INJURY POSITION GROUPS');
  const p = (name, pos, status) => ({ name, pos, status });
  const labels = (rows, starter) => groupInjuries(rows, starter).map((l) => l.label);

  // Rollup: distinct line positions must count as ONE unit. This is the whole feature.
  ok(labels([p('A', 'C', 'Out'), p('B', 'G', 'Out'), p('C', 'OT', 'Out')])[0] === '3 OL out',
    'C + G + OT roll up into one OL line');
  ok(labels([p('A', 'CB', 'Questionable'), p('B', 'S', 'Questionable')])[0] === '2 DB questionable',
    'CB + S roll up into the secondary');
  ok(labels([p('A', 'DE', 'Out'), p('B', 'DT', 'Questionable')])[0] === '2 DL out or questionable',
    'mixed statuses are phrased as "out or questionable"');

  // The noise floor.
  ok(!labels([p('A', 'C', 'Out')]).length, 'a single lineman does not fire');
  ok(!labels([p('A', 'PK', 'Questionable'), p('B', 'P', 'Out'), p('C', 'LS', 'Out')]).length,
    'specialists never fire — a questionable kicker is not a story');
  ok(!labels([p('A', 'C', 'Injured Reserve'), p('B', 'G', 'Injured Reserve')]).length,
    'an all-IR group does not fire — long-term absence is already priced in');
  ok(labels([p('A', 'C', 'Out'), p('B', 'G', 'Injured Reserve'), p('C', 'OT', 'Out')])[0] === '2 OL out',
    'IR players are excluded from the count, not counted as out');

  // Starter lines: one named player, fired only when the caller could identify them confidently.
  const qb = [p('Starter Guy', 'QB', 'Questionable')];
  ok(!labels(qb).length, 'a starter injury with no starter information stays silent');
  ok(!labels(qb, { QB: 'Someone Else' }).length, 'an injured BACKUP never fires');
  ok(labels(qb, { QB: 'Starter Guy' })[0] === 'Starting QB Starter Guy questionable',
    'an injured starter fires alone, and is named');
  ok(labels(qb, 'Starter Guy')[0]?.startsWith('Starting QB'), 'a bare string is accepted as the QB shorthand');
  ok(!labels([p('Starter Guy', 'QB', 'Injured Reserve')], { QB: 'Starter Guy' }).length,
    'a starter on IR does not fire (already priced in)');
  // The pass rusher: inferred from production rather than projection, and its unit is resolved
  // from the injured player's own position, because a team's sack leader is as often a linebacker
  // as a lineman (league-wide: 14 DE, 14 LB, 4 DT).
  ok(labels([p('Edge Guy', 'DE', 'Out')], { PASSRUSH: 'Edge Guy' })[0] === 'Top pass rusher Edge Guy out',
    'a top pass rusher fires on its own, at DE');
  ok(labels([p('Edge Guy', 'LB', 'Out')], { PASSRUSH: 'Edge Guy' })[0] === 'Top pass rusher Edge Guy out',
    '...and at LB, since sack leaders are as often linebackers');
  ok(!labels([p('Edge Guy', 'DE', 'Out')]).length, 'a defensive injury with no leader information stays silent');
  ok(!labels([p('Someone Else', 'DE', 'Out')], { PASSRUSH: 'Edge Guy' }).length, 'a non-leader rusher never fires');
  ok(!labels([p('Edge Guy', 'WR', 'Out')], { PASSRUSH: 'Edge Guy' }).length,
    'a name collision at an unrelated position cannot fire the rusher line');
  // The auto group must fold the right unit: a DE folds DL, the same player at LB folds LB.
  const foldDl = groupInjuries([p('Edge Guy', 'DE', 'Out'), p('Other', 'DT', 'Out')], { PASSRUSH: 'Edge Guy' });
  ok(foldDl.length === 1 && foldDl[0].label === 'Top pass rusher Edge Guy out (2 DL affected)',
    'a DE sack leader folds the DL group');
  const foldLb = groupInjuries([p('Edge Guy', 'LB', 'Out'), p('Other', 'LB', 'Out')], { PASSRUSH: 'Edge Guy' });
  ok(foldLb.length === 1 && foldLb[0].label === 'Top pass rusher Edge Guy out (2 LB affected)',
    'the same leader at LB folds the LB group instead');

  // Extended to the skill positions, same gate, same shape.
  for (const [pos, unit] of [['RB', 'RB'], ['WR', 'WR'], ['TE', 'TE']]) {
    const rows = [p('Star Player', pos, 'Out')];
    ok(labels(rows, { [pos]: 'Star Player' })[0] === `Starting ${unit} Star Player out`,
      `a starting ${pos} fires on its own`);
    ok(!labels(rows).length, `an injured ${pos} with no starter information stays silent`);
    ok(!labels(rows, { [pos]: 'Different Player' }).length, `a backup ${pos} never fires`);
  }
  // Name matching has to survive two feeds writing the same player differently.
  ok(labels([p("Ja'Marr Chase", 'WR', 'Out')], { WR: 'JaMarr Chase' }).length === 1,
    'punctuation differences still match the starter');
  ok(labels([p('Marvin Harrison Jr.', 'WR', 'Out')], { WR: 'Marvin Harrison' }).length === 1,
    'a name suffix still matches the starter');

  // Folding: a starter line must absorb its own unit's count rather than repeating it.
  const folded = groupInjuries([p('Star RB', 'RB', 'Out'), p('Backup RB', 'RB', 'Questionable')], { RB: 'Star RB' });
  ok(folded.length === 1, 'a starter line and its own group line are not both shown');
  ok(folded[0].label === 'Starting RB Star RB out (2 RB affected)', 'the group count folds into the starter line');
  ok(folded[0].players.length === 2 && folded[0].count === 2,
    'and the folded line carries every affected player, with count and players agreeing');
  const unfolded = groupInjuries([p('Backup A', 'RB', 'Out'), p('Backup B', 'RB', 'Out')], { RB: 'Star RB' });
  ok(unfolded[0].label === '2 RB out', 'a group with no injured starter still reports as a group');

  // Priority and cap.
  const mixed = groupInjuries([p('Star QB', 'QB', 'Out'), p('Star RB', 'RB', 'Out'), p('A', 'C', 'Out'),
    p('B', 'G', 'Out'), p('C', 'DE', 'Out'), p('D', 'DT', 'Out'), p('E', 'CB', 'Out'), p('F', 'S', 'Out')],
    { QB: 'Star QB', RB: 'Star RB' });
  ok(mixed[0].label.startsWith('Starting QB'), 'the QB line always leads');
  ok(mixed[1].label.startsWith('Starting RB'), 'other starters follow the QB, ahead of any group');
  ok(mixed.length <= 4, `lines are capped so a card stays glanceable (${mixed.length})`);
  ok(mixed.every((l) => l.impact && l.label), 'every line carries both a label and a consequence');
  ok(!labels([]).length && !labels(null).length, 'empty or missing injuries produce nothing');
}

function checkVenueTable() {
  console.log('\n[venues] CFB STADIUM TABLE');
  const rows = Object.entries(CFB_VENUES);
  ok(rows.length > 120, `covers the FBS field (${rows.length} venues)`);
  const outdoor = rows.filter(([, v]) => !v.dome);
  ok(rows.every(([, v]) => v.dome === true || (Number.isFinite(v.lat) && Number.isFinite(v.lon))),
    'every venue is either domed or has real coordinates');
  // US and its NWS-covered territories: American Samoa is the southern extreme, Alaska the north,
  // Guam the far west (positive longitude), Puerto Rico the far east.
  ok(outdoor.every(([, v]) => v.lat >= -15 && v.lat <= 72), 'every latitude is inside NWS coverage');
  ok(outdoor.every(([, v]) => (v.lon >= -180 && v.lon <= -64) || v.lon >= 144),
    'every longitude is inside NWS coverage (no sign flips)');
  ok(outdoor.every(([, v]) => v.lat !== 0 && v.lon !== 0), 'no null-island coordinates');
  ok(rows.every(([id]) => /^\d+$/.test(id)), 'every key is an ESPN venue id');
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
  ok(feed.games.every((g) => g.venue.id === null || /^\d+$/.test(g.venue.id)), 'games carry an ESPN venue id');
  ok(feed.injuryImpactV === INJURY_IMPACT_VERSION,
    `feed is stamped with the derived-content version (v${feed.injuryImpactV})`);
  // Impact lines must never contradict the card: a line claiming N players needs N players behind
  // it, and must never rest on Injured Reserve, which is what makes it read as this week's news.
  const impacts = feed.games.flatMap((g) => [...(g.injuryImpact?.home || []), ...(g.injuryImpact?.away || [])]);
  const injRows = feed.games.reduce((n, g) => n + g.injuries.home.length + g.injuries.away.length, 0);
  console.log(`  INFO  ${injRows} injury rows, ${impacts.length} impact lines across ${feed.games.length} games`);
  // The keying regression. fetchInjuries once keyed on a field ESPN's payload does not have, so the
  // map came back empty and no injury ever reached a card — silently, because an empty injury list
  // is indistinguishable from a healthy team. The NFL endpoint carries hundreds of rows year-round,
  // preseason included, so "some card has an injury" is a safe assertion and is the one that fails
  // loudly if the key breaks again.
  if (name === 'nfl') ok(injRows > 0, `NFL cards carry injuries (${injRows} rows) — the map is actually keyed correctly`);
  ok(impacts.every((l) => l.players.length === l.count), 'every impact line is backed by the players it counts');
  // The contradiction that shipped: a card named McCaffrey in a starter line while the list beneath
  // it showed three other players, because the line counted the whole squad and the list was a
  // capped, arbitrary subset. Anyone a line names must be findable in the injuries it ships.
  const missing = feed.games.flatMap((g) => ['home', 'away'].flatMap((s) => {
    const have = new Set((g.injuries?.[s] || []).map((r) => r.name));
    return (g.injuryImpact?.[s] || []).flatMap((l) => l.players.map((p) => p.name)).filter((n) => !have.has(n));
  }));
  ok(!missing.length, `every player named in a line is in the shipped injury list${missing.length ? ` (missing: ${missing.slice(0, 3).join(', ')})` : ''}`);
  ok(impacts.every((l) => l.group === 'STARTER' || l.count >= 2), 'only a named starter fires on a single player');
  ok(impacts.every((l) => l.group !== 'STARTER' || /^(Starting (QB|RB|WR|TE)|Top pass rusher) \S/.test(l.label)),
    'every key-player line names the player it is about');
  ok(impacts.every((l) => !l.players.some((x) => /reserve/i.test(x.status))), 'no impact line rests on Injured Reserve');
  ok(impacts.every((l) => !l.players.some((x) => ['PK', 'K', 'P', 'LS'].includes(x.pos))), 'no specialist appears in an impact line');

  // Weather. NWS only forecasts ~7 days out, so only games inside that window are expected to
  // carry one. This leans on a live third-party service, so a total absence is reported as an
  // outage rather than failed — but if NWS is answering at all, coverage has to be complete,
  // which is what catches a venue table that stopped being wired in.
  // A forecast is only expected where a coordinate can actually be resolved: a CFB venue in the
  // generated table, or an NFL game at the home team's own stadium (that table is keyed by team,
  // so a neutral site has no coordinate by design). Anywhere else — an international game, a venue
  // not in the table — no forecast is the correct outcome, not a failure.
  const resolvable = (g) => CFB_VENUES[g.venue.id] || (name === 'nfl' && !g.neutralSite);
  const wx = feed.games.filter((g) => !g.venue.indoor && resolvable(g)
    && Date.parse(g.date) - Date.now() < 7 * 86400000);
  const got = wx.filter((g) => g.weather);
  if (!wx.length) console.log('  SKIP  no outdoor games inside the NWS forecast window');
  else if (!got.length) console.log(`  INFO  no forecasts at all on ${wx.length} outdoor games — NWS looks unavailable`);
  else {
    ok(got.length === wx.length,
      `every in-window outdoor game has a forecast (${got.length}/${wx.length})`);
    ok(got.every((g) => g.weather.tempF == null || (g.weather.tempF > -60 && g.weather.tempF < 140)),
      'forecast temperatures are physically plausible');
    // Both are what the top-up and the age label read; without them the card can't state its own
    // age and a stale forecast can never be refreshed.
    ok(got.every((g) => Number.isFinite(Date.parse(g.weather.fetchedAt))), 'every forecast is timestamped');
    ok(got.every((g) => /^https:\/\/api\.weather\.gov\//.test(g.weather.url || '')),
      'every forecast keeps the NWS url it can be refreshed from');
  }

  const ids = feed.games.flatMap((g) => [g.home.id, g.away.id]);
  ok(ids.every(Boolean), 'every team on the slate carries an ESPN id');
  const railIds = [...feed.bestPicks, ...feed.upsetAlerts].map((x) => x.id);
  ok(railIds.every((id) => feed.games.some((g) => g.id === id)), 'rails point only at upcoming games');

  console.log(`\n[${name}] TEAM REPORTS`);
  const rep = feed.teamReports;
  if (!feed.games.length) { console.log('  SKIP  empty slate (out of season)'); return; }
  ok(!!rep && !!rep.teams, 'teamReports present');
  if (!rep?.teams) return;
  ok(rep.v === TEAM_REPORT_VERSION, `payload is at the current shape version (v${rep.v})`);
  ok(ids.every((id) => rep.teams[id]), 'every team on the slate has a report');
  ok(rep.priorSeason === rep.season - 1, `prior season is the one before (${rep.priorSeason} < ${rep.season})`);
  // ESPN answers a request for a season it has no data for with the PREVIOUS season's numbers and
  // no error. Before the NFL's Week 1 that meant 32 teams at 17 games each under the current
  // season's year — which passes every sample gate and labels last year's stats as this year's. A
  // team can only be read on the current season if the league genuinely has games in it.
  ok(rep.ratedCounts[rep.season] === 0 || (rep.leagueSizes[rep.season] || 0) > 0,
    'a rated current season is one the league actually has data for');
  const curTeams = all => all.filter((t) => t.basisSeason === rep.season).length;
  ok(!Object.values(rep.teams).some((t) => t.basisSeason === rep.season) || rep.ratedCounts[rep.season] > 0,
    'no team is read on the current season while zero teams are rated in it');

  const all = Object.values(rep.teams);
  const mix = all.reduce((m, t) => { m[t.basis] = (m[t.basis]||0)+1; return m; }, {});
  console.log(`  INFO  basis mix ${JSON.stringify(mix)} · rated ${JSON.stringify(rep.ratedCounts)}`);
  ok(all.every((t) => ['season', 'prior-season', 'none'].includes(t.basis)), 'every team carries a known basis');
  // Each team is placed on its own basis, and that basis must be a season it actually HAS.
  ok(all.every((t) => t.basis === 'none' ? !t.basisSeason : !!t.seasons[t.basisSeason]),
    'each team\'s basis names a season it has stats for');
  // The crossover has to be reproducible from the team's own numbers, not incidental: a stored
  // current season means the rule passed, and its absence means the rule failed.
  const rankable = (t) => currentSeasonRankable({
    gamesPlayed: t.gamesPlayed,
    ratedSize: rep.ratedCounts[rep.season] || 0,
    fullFieldSize: rep.leagueSizes[rep.priorSeason] || 0,
  });
  ok(all.every((t) => !t.seasons[rep.season] || rankable(t)),
    'no team is ranked on a current season the crossover rule rejects');
  ok(all.every((t) => t.basis !== 'prior-season' || !rankable(t) || !t.seasons[rep.season]),
    'no team is stranded on last year once it and the league have enough games');
  ok(all.every((t) => t.basis !== 'season' || t.basisSeason === rep.season),
    'a season basis names the current season');

  const ranks = all.flatMap((t) => Object.entries(t.seasons).flatMap(([yr, sn]) =>
    [...Object.values(sn.offense), ...Object.values(sn.defense)].map((s) => [Number(yr), s.rank])))
    .filter(([, r]) => r != null);
  ok(ranks.length > 0, `ranks populated (${ranks.length} across ${all.length} teams)`);
  ok(ranks.every(([yr, r]) => r >= 1 && r <= (rep.leagueSizes[yr] || 0) * 2), 'every rank is inside its own league');
  const form = all.flatMap((t) => t.form);
  ok(form.length > 0, `recent form populated (${form.length} games)`);
  ok(form.every((f) => f.score != null && f.oppScore != null), 'every form row has a score');
  ok(form.every((f) => f.won === (f.score > f.oppScore)), 'win flags agree with the scores');
  ok(all.every((t) => t.form.length <= 5), 'form capped at five games');
  // A team with stats must have BOTH sides — an offense-only report is the bug that made DvP
  // necessary in the first place (ESPN's own defensive category reports zeros).
  const sides = all.flatMap((t) => Object.values(t.seasons));
  ok(sides.length > 0 && sides.every((sn) => sn.offense.yardsPerGame && sn.defense.yardsPerGame?.rank),
    'every stat season carries real defensive ranks, not zeros');
}

function checkPage(name, feed, page) {
  console.log(`\n[${name}] PAGE`);
  const g = feed.games.find((x) => {
    const h = feed.teamReports?.teams?.[x.home.id], a = feed.teamReports?.teams?.[x.away.id];
    return h?.basisSeason && a?.basisSeason;
  });
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
    // The whole point of the labelling: a rank from a season that isn't the current one must
    // never appear without the year and the reason attached to it.
    const rep2 = feed.teamReports, t = rep2.teams[g[side].id];
    if (t.basisSeason && t.basisSeason !== rep2.season) {
      ok(html.includes(`${t.basisSeason} season stats`) && html.includes("last year's roster"),
        `${tag} labels last year's numbers as last year's`);
      ok(html.includes(`${rep2.season} so far`) || !t.form.some((f) => f.season === rep2.season),
        `${tag} hedges a stale basis with this season's actual results`);
    }
  }
  // A matchup must never set one season's rank against another's.
  const rep3 = feed.teamReports;
  for (const gm of feed.games) {
    const h = rep3.teams[gm.home.id], a = rep3.teams[gm.away.id];
    if (!h?.basisSeason || !a?.basisSeason) continue;
    const shared = Object.keys(h.seasons).filter((y) => a.seasons[y]).map(Number).sort((x, y) => y - x)[0];
    if (shared == null) continue;
    const panel = page.teamPanelHtml(feed, gm, 'home');
    if (!panel.includes('tp-verdict')) continue;
    ok(panel.includes(`The matchup <span class="tp-basis">${shared} season`),
      `${gm.shortName}: matchup compares both teams on ${shared}`);
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

// The crossover only happens around Week 5, so live data in the opening weeks can never exercise
// it. This builds the mid-season state by hand and drives the real renderer through it: one team
// across the threshold, one still behind, which is the case that has to stay honest — their ranks
// come from different populations and must NOT be compared.
function checkCrossover(page) {
  console.log('\n[synthetic] MID-SEASON CROSSOVER');
  const stat = (v, r) => ({ value: v, rank: r });
  const side = (o) => ({ yardsPerGame: stat(250, o), rushYardsPerGame: stat(150, o),
    pointsPerGame: stat(28, o), totalYardsPerGame: stat(400, o), yardsPerCarry: stat(4.5, o) });
  const seasonEntry = (gp, r) => ({ gamesPlayed: gp, offense: side(r), defense: side(r) });
  const feed = {
    teamReports: {
      v: TEAM_REPORT_VERSION, season: 2026, priorSeason: 2025,
      leagueSizes: { 2026: 136, 2025: 136 }, ratedCounts: { 2026: 120, 2025: 136 },
      teams: {
        // Crossed over: five games in, read on 2026.
        '1': { form: [{ date: '2026-10-01T00:00Z', season: 2026, opp: 'XYZ', oppRank: null, home: true, score: 31, oppScore: 17, won: true }],
          gamesPlayed: 5, basis: 'season', basisSeason: 2026,
          seasons: { 2026: seasonEntry(5, 4), 2025: seasonEntry(12, 60) } },
        // Behind the threshold (byes): still read on 2025, and has 2026 results to hedge with.
        '2': { form: [{ date: '2026-10-01T00:00Z', season: 2026, opp: 'ABC', oppRank: null, home: false, score: 10, oppScore: 24, won: false }],
          gamesPlayed: 3, basis: 'prior-season', basisSeason: 2025,
          seasons: { 2025: seasonEntry(12, 90) } },
      },
    },
    games: [],
  };
  const g = { id: 'g1', shortName: 'A @ B', date: '2026-10-08T00:00Z',
    home: { id: '1', abbr: 'AAA', name: 'Team A', logo: null }, away: { id: '2', abbr: 'BBB', name: 'Team B', logo: null } };
  feed.games.push(g);

  const crossed = page.teamPanelHtml(feed, g, 'home');
  ok(crossed.includes('2026 season'), 'a crossed-over team is read on the current season');
  ok(!crossed.includes("last year's roster"), 'a crossed-over team carries no stale-data caveat');
  ok(!crossed.includes('2026 so far'), 'a crossed-over team needs no hedge line');

  const behind = page.teamPanelHtml(feed, g, 'away');
  ok(behind.includes('2025 season stats') && behind.includes("last year's roster"),
    'a team behind the threshold is labelled as last year, with the caveat');
  ok(behind.includes('2026 so far') && behind.includes('0-1'),
    "a stale basis is hedged with this season's actual results");

  // Both panels describe the same game, so both must state the SAME shared basis — the older one.
  ok(crossed.includes('The matchup <span class="tp-basis">2025 season'),
    'a mixed matchup drops to the season both teams share (2025), not the crossed team\'s 2026');
  ok(behind.includes('The matchup <span class="tp-basis">2025 season'), 'both sides agree on the shared basis');
  // Scope this to the matchup block: the season tiles below it legitimately show 2026 ranks.
  const block = crossed.slice(crossed.indexOf('The matchup'), crossed.lastIndexOf('<div class="tp-hd">2026 season'));
  ok(block.includes('#60') && block.includes('#90') && !block.includes('#4'),
    'the matchup uses the shared season\'s ranks, never mixing 2026 against 2025');
  ok(block.includes('both teams have enough games'), 'and says why it sat a year back');

  // Once both cross, the matchup should move to the current season on its own.
  feed.teamReports.teams['2'] = { ...feed.teamReports.teams['2'], gamesPlayed: 5, basis: 'season',
    basisSeason: 2026, seasons: { 2026: seasonEntry(5, 90), 2025: seasonEntry(12, 90) } };
  const both = page.teamPanelHtml(feed, g, 'home');
  ok(both.includes('The matchup <span class="tp-basis">2026 season'),
    'once both teams cross, the matchup switches to the current season automatically');
  ok(!both.includes("last year's roster"), 'and the stale-data caveat disappears');
}

const which = process.argv.slice(2).filter((a) => FEEDS[a]);
const page = loadPageScript();
for (const name of (which.length ? which : ['cfbweek'])) {
  const feed = await FEEDS[name]();
  checkFeed(name, feed);
  if (feed.games.length) checkPage(name, feed, page);
}
checkVenueTable();
checkInjuryGroups();
checkTopUp();
checkCrossover(page);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
