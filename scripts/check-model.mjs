// Regression check for the game model (docs/game-model-scoping.md).
//
//   node scripts/check-model.mjs
//
// This is the thing that keeps the model honest after launch. The model exists to EXPLAIN a game,
// not to out-predict the betting market — it does not, by a measured 0.0149 of Brier score — so
// the checks below are mostly about making sure it never starts claiming otherwise:
//
//   GATES   — the win-probability and disagreement flags must match what the backtest actually
//             found. A refit that flips one flips the product, and has to do so deliberately.
//   MATH    — the ridge solver recovers known coefficients; the opponent adjustment reproduces a
//             season whose answer we already know.
//   JOIN    — the ESPN<->CFBD crosswalk still separates the two Miamis and still reports misses.
//   SHAPE   — a scored game carries a margin, ranked component gaps, and an honest instrumentation
//             label saying whether garbage time was filtered.
//
// Exits non-zero on any failure. Needs network for the ratings section (nflverse, no key).
import { readFileSync } from 'node:fs';
import { ridgeSolve, olsSolve } from '../api/_lib/ridge.js';
import { buildNflRatings, rawRates, adjustEpa, parseCsv } from '../api/_lib/nflRatings.js';
import { buildCrosswalk, normalizeName } from '../api/_lib/cfbCrosswalk.js';
import { scoreNflGame, scoreCfbGame, winProbFromMargin } from '../api/_lib/gameModel.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const COEF = JSON.parse(readFileSync(new URL('../api/_lib/nflModelCoef.json', import.meta.url), 'utf8'));
const CFB = JSON.parse(readFileSync(new URL('../api/_lib/cfbModelCoef.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
console.log('\n[coefficients] THE GATES');

const oos = COEF.outOfSample;
ok(oos.games >= 1000, `backtested on a real sample (${oos.games} games, ${oos.seasons[0]}-${oos.seasons[1]})`);
ok(COEF.gates.showWinProb === (oos.modelBrier < oos.marketBrier),
  `showWinProb agrees with the backtest (model ${oos.modelBrier.toFixed(4)} vs market ${oos.marketBrier.toFixed(4)})`);
// The load-bearing assertion. If a future refit genuinely beats the market this flips, and the
// person flipping it should have to change this line and say why in the commit.
ok(COEF.gates.showWinProb === false,
  'model win % is NOT shown as a headline number (it loses to the market out of sample)');
ok(COEF.gates.showDisagreement === false,
  'model-vs-market disagreement is NOT surfaced (its preferred side underperformed the market read)');
const big = oos.disagreement.filter((d) => d.n >= 100);
ok(big.length > 0 && big.every((d) => typeof d.modelSideWinRate === 'number'),
  `disagreement buckets recorded for the next refit (${big.length} with n>=100)`);
ok(oos.modelMae > 0 && oos.marketMae > 0 && oos.marketMae < oos.modelMae,
  `margin MAE recorded and honest (model ${oos.modelMae.toFixed(2)} vs market ${oos.marketMae.toFixed(2)})`);

// Calibration is the one thing the model IS allowed to claim: it should be roughly right about its
// own uncertainty even while being less informed than the market. Buckets with a real sample must
// land within 8 points of the line they predict.
console.log('\n[coefficients] SELF-CALIBRATION');
for (const b of oos.calibration) {
  if (b.n < 100) continue;
  const mid = b.lo * 100 + 5;
  const err = Math.abs(b.actual * 100 - mid);
  ok(err <= 8, `${(b.lo * 100).toFixed(0)}-${(b.lo * 100 + 10).toFixed(0)}% bucket lands at ${(b.actual * 100).toFixed(1)}% (n=${b.n}, off by ${err.toFixed(1)})`);
}

// ---------------------------------------------------------------------------
console.log('\n[synthetic] SOLVER');
{
  const rows = [[1, 0, 0], [1, 1, 0], [1, 0, 1], [1, 1, 1], [1, 2, 1], [1, 3, 2]];
  const y = rows.map((r) => 3 + 2 * r[1] - 1 * r[2]);
  const b = olsSolve({ rows, y });
  ok(Math.abs(b[0] - 3) < 1e-6 && Math.abs(b[1] - 2) < 1e-6 && Math.abs(b[2] + 1) < 1e-6,
    'least squares recovers known coefficients exactly');
}
{
  // The rank-deficient shape the opponent adjustment actually has: off_i - def_j with no anchor.
  // Plain least squares has no unique answer here; ridge must still return something finite and
  // centred rather than diverging.
  const rows = [[1, 1, 0, 0, -1], [1, 0, 1, -1, 0], [1, 1, 0, -1, 0], [1, 0, 1, 0, -1]];
  const y = [0.2, -0.1, 0.15, -0.05];
  const b = ridgeSolve({ rows, y, lambda: 1, penalize: [false, true, true, true, true] });
  ok(b.every(Number.isFinite), 'ridge returns a finite solution on a rank-deficient design');
  const teamSum = b[1] + b[2] + b[3] + b[4];
  ok(Math.abs(teamSum) < 0.5, `ridge centres the team terms rather than drifting (sum ${teamSum.toFixed(3)})`);
}
{
  const text = 'a,b,c\n1,"x,y",3\n4,"he said ""hi""",6\n';
  const rows = parseCsv(text);
  ok(rows.length === 2 && rows[0].b === 'x,y' && rows[1].b === 'he said "hi"',
    'CSV parser survives quoted commas and escaped quotes (fg_made_list breaks a naive split)');
}

// ---------------------------------------------------------------------------
console.log('\n[synthetic] CROSSWALK');
{
  ok(normalizeName("Hawai'i") === 'hawaii', "diacritics and apostrophes normalise (Hawai'i)");
  ok(normalizeName('San José St') === normalizeName('San Jose State'), 'trailing St expands to State');
  ok(normalizeName('Texas A&M') === 'texas a and m', 'ampersand normalises consistently');
  const cfbd = [
    { school: 'Miami', alternateNames: ['Miami (FL)'] },
    { school: 'Miami (OH)', alternateNames: ['Miami-Ohio'] },
    { school: 'Appalachian State', alternateNames: ['App State'] },
    { school: 'Ghost Tech', alternateNames: [] },
  ];
  const espn = [
    { id: '2390', location: 'Miami', displayName: 'Miami Hurricanes' },
    { id: '193', location: 'Miami (OH)', displayName: 'Miami (OH) RedHawks' },
    { id: '2026', location: 'App State', displayName: 'App State Mountaineers' },
    { id: '2711', location: 'Villanova', displayName: 'Villanova Wildcats' }, // FCS noise
  ];
  const { map, unmatched } = buildCrosswalk(espn, cfbd);
  ok(map['2390'] === 'Miami' && map['193'] === 'Miami (OH)', 'the two Miamis resolve separately');
  ok(map['2026'] === 'Appalachian State', 'ESPN "App State" resolves to CFBD "Appalachian State"');
  ok(!Object.values(map).includes('Ghost Tech'), 'a CFBD school with no ESPN team is not force-matched');
  ok(unmatched.length === 1 && unmatched[0].school === 'Ghost Tech',
    'unmatched reports the CFBD school by name, and ignores FCS teams ESPN lists');
}

// ---------------------------------------------------------------------------
console.log('\n[live] NFL RATINGS (nflverse, no key)');
let ratings;
try {
  ratings = await buildNflRatings({ season: 2024 });
} catch (err) {
  ok(false, `ratings build threw: ${err.message}`);
}
if (ratings) {
  const teams = Object.entries(ratings.teams);
  ok(teams.length === 32, `all 32 teams rated (${teams.length})`);
  ok(ratings.instrumentation === 'team-week' && ratings.garbageTimeFiltered === false,
    'NFL instrumentation is labelled honestly (team-week, garbage time NOT filtered)');
  const ranks = teams.map(([, v]) => v.netRank).sort((a, b) => a - b);
  ok(ranks[0] === 1 && ranks[31] === 32 && new Set(ranks).size === 32, 'net ranks are a clean 1..32');

  // The sign convention is load-bearing: positive must mean GOOD on both sides, or every defensive
  // claim on every card inverts. 2024 is a known season — Baltimore had the best offense in the
  // league and Carolina the worst defense by a distance.
  const bestOff = teams.slice().sort((a, b) => b[1].off - a[1].off)[0][0];
  const worstDef = Object.entries(ratings.raw).sort((a, b) => b[1].defense.epaPerPlay - a[1].defense.epaPerPlay)[0][0];
  ok(bestOff === 'BAL', `2024 best offense resolves to Baltimore (got ${bestOff})`);
  ok(worstDef === 'CAR', `2024 worst raw EPA allowed resolves to Carolina (got ${worstDef})`);

  // Ratings are centred by the ridge penalty, so the league should sit near zero on both sides.
  const meanNet = teams.reduce((s, [, v]) => s + v.net, 0) / teams.length;
  ok(Math.abs(meanNet) < 0.02, `league mean net rating is ~0 (${meanNet.toFixed(4)})`);

  console.log('\n[live] SCORING + EXPLANATION');
  const s = scoreNflGame({ ratings, homeAbbr: 'BAL', awayAbbr: 'CLE' });
  ok(s && typeof s.margin === 'number', 'a scored game carries a numeric margin');
  ok(s.margin > 0 && s.favorite === 'BAL', `the better team is favoured (BAL by ${s.margin})`);
  ok(s.showWinProb === false, 'the scored game respects the win-probability gate');
  ok(Array.isArray(s.gaps) && s.gaps.length >= 1, `component gaps are present (${s.gaps?.length})`);
  ok(s.gaps.every((g) => typeof g.home === 'number' && typeof g.away === 'number'
    && (g.homeRank === null || Number.isFinite(g.homeRank))),
    'every gap states both measured values, not just a conclusion');
  ok(s.garbageTimeFiltered === false, 'the scored game carries the NFL garbage-time caveat');

  // Neutral site must drop home-field advantage — the league plays in London and São Paulo.
  const home = scoreNflGame({ ratings, homeAbbr: 'BAL', awayAbbr: 'CLE', neutralSite: false });
  const neut = scoreNflGame({ ratings, homeAbbr: 'BAL', awayAbbr: 'CLE', neutralSite: true });
  ok(Math.abs((home.margin - neut.margin) - COEF.coef.intercept) < 0.11,
    `neutral site removes exactly the fitted home-field edge (${(home.margin - neut.margin).toFixed(1)} pts)`);

  ok(scoreNflGame({ ratings, homeAbbr: 'BAL', awayAbbr: 'NOPE' }) === null,
    'an unrated team yields no model line rather than a fabricated one');

  // The probability conversion is shared with the market pick, so both sides of a card are on one
  // scale. A symmetric margin must give symmetric probabilities.
  ok(Math.abs(winProbFromMargin(7) + winProbFromMargin(-7) - 1) < 1e-9,
    'margin-to-probability is symmetric about zero');
}

console.log('\n[synthetic] COLLEGE SCORING');
{
  const ratings = { season: 2026, basis: 'prior-season', homeField: 2.5,
    crosswalk: { 1: 'Home', 2: 'Away' }, teams: {
      Home: { school: 'Home', sp: { rating: 10 }, eff: { epaOff: 0.3, epaDef: 0.1 } },
      Away: { school: 'Away', sp: { rating: 5 }, eff: { epaOff: 0.2, epaDef: 0.4 } },
    } };
  const g = scoreCfbGame({ ratings, homeEspnId: 1, awayEspnId: 2 });
  ok(g.margin === 7.5 && g.season === 2025 && !g.showWinProb && !g.showDisagreement,
    'college margin uses SP+ and labels prior-season data with closed display gates');
  const away = g.gaps.find(x => x.side === 'away');
  ok(away.home === 0.1 && away.away === 0.2, 'away-offense matchup retains home and away ownership');
  ok(scoreCfbGame({ ratings, homeEspnId: 1, awayEspnId: 2, neutralSite: true }).margin === 5,
    'neutral college game removes home field');
}
{
  const r = await buildNflRatings({ season: 2026, fetchImpl: async year => {
    if (year === 2026) throw new Error('nflverse stats_team HTTP 404 for 2026');
    return [{ team: 'AAA', opponent_team: 'BBB', week: 1, attempts: 30, carries: 20, passing_epa: 5 },
      { team: 'BBB', opponent_team: 'AAA', week: 1, attempts: 30, carries: 20, passing_epa: -5 }];
  } });
  ok(Object.keys(r.teams).length === 2 && r.teams.AAA.weight === 0,
    'missing preseason asset falls back to prior season with zero current weight');
}

// ---------------------------------------------------------------------------
console.log('\n[coefficients] COLLEGE BACKTEST');
{
  const o = CFB.outOfSample;
  ok(o.games >= 3000, `college backtested on a real sample (${o.games} games, ${o.seasons[0]}-${o.seasons[1]})`);
  ok(CFB.basis === 'pregame-elo', 'college backtest uses pregame Elo, which is leak-free by construction');
  // The trap this whole script exists to keep shut. /ratings/sp has no week parameter and TeamSP
  // has no week field, so a historical SP+ request returns the FINISHED season — grading an
  // October game with it would hand the model the season's outcome. If a future edit ever points
  // this backtest at SP+, this assertion is what should stop it.
  ok(/end-of-season/.test(CFB.doesNotValidate || ''),
    'the record states plainly that SP+ itself is NOT what was validated');
  ok(CFB.gates.showWinProb === (o.modelBrier < o.marketBrier),
    `college showWinProb agrees with its backtest (model ${o.modelBrier.toFixed(4)} vs market ${o.marketBrier.toFixed(4)})`);
  ok(CFB.gates.showWinProb === false && CFB.gates.showDisagreement === false,
    'both college display gates are shut');

  // The thin-market thesis, recorded so it cannot quietly come back as an assumption. Scoping
  // ranked Group-of-Five games as the most likely place to find an edge; the backtest found the
  // model trails the market by MORE there than on Power 5 games, not less.
  const p5 = o.segments.p5, g5 = o.segments.g5;
  ok(p5 && g5 && p5.n > 500 && g5.n > 500, `segment samples are usable (P5 ${p5?.n}, G5 ${g5?.n})`);
  ok((g5.bm - g5.bk) > (p5.bm - p5.bk),
    `thin-market thesis is recorded as DISPROVED (G5 gap +${(g5.bm - g5.bk).toFixed(4)} vs P5 +${(p5.bm - p5.bk).toFixed(4)})`);

  for (const b of o.calibration) {
    if (b.n < 200) continue;
    const mid = b.lo * 100 + 5, err = Math.abs(b.actual * 100 - mid);
    ok(err <= 8, `college ${(b.lo * 100).toFixed(0)}-${(b.lo * 100 + 10).toFixed(0)}% bucket lands at ${(b.actual * 100).toFixed(1)}% (n=${b.n})`);
  }

  // College margins are genuinely more variable than NFL ones; borrowing the NFL's 13.5 would make
  // every college probability overconfident. The fitted residual SD must reflect that.
  ok(CFB.marginSd > 14, `college residual SD is fitted, not borrowed from the NFL (${CFB.marginSd.toFixed(1)} pts vs NFL 13.5)`);
}

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nAll model checks passed.\n');
process.exit(failures ? 1 : 0);
