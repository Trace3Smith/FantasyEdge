// Offline fit + out-of-sample evaluation for the COLLEGE margin model.
//
//   node scripts/fit-cfb-model.mjs            # fit, evaluate, print the report
//   node scripts/fit-cfb-model.mjs --write    # …and write api/_lib/cfbModelCoef.json
//
// WHY THIS DOES NOT BACKTEST SP+, WHICH IS WHAT WE ACTUALLY SHIP.
//
// `/ratings/sp` takes a year and no week, and `TeamSP` carries no week or date field — so a request
// for 2023 returns ONE rating per team: the finished, end-of-season figure. Grading Week 6 of 2023
// with it would hand the model the season's outcome and report a number production could never
// reproduce. That is the single largest trap in this exercise and it is silent: the backtest would
// simply look excellent.
//
// Production is NOT affected by this. SP+ for an in-progress season is a live rating, so the cron
// querying year=2026 in Week 6 gets Week 6's SP+ — genuinely pregame for Week 7. What we lose is
// only the ability to check SP+ RETROSPECTIVELY.
//
// So this script validates the STRUCTURE instead, using the one college rating that is pregame by
// construction: `homePregameElo` / `awayPregameElo`, which CFBD stamps onto every game in `/games`
// as the rating each team carried BEFORE kickoff. Verified 100% populated for FBS-vs-FBS games back
// to 2016 (every gap is an FCS opponent, which is excluded here anyway).
//
// What that buys, and what it does not:
//   IT ANSWERS  — is a rating-difference-plus-home-field model competitive with the college betting
//                 market, and is the college market softer than the NFL's? That is the thin-market
//                 thesis from docs/game-model-scoping.md, and it is the reason to build this at all.
//   IT DOES NOT — validate SP+ itself. Elo is a different rating. A good result here licenses the
//                 APPROACH, not the shipped numbers, and the college display gates stay shut until
//                 SP+ is validated prospectively (snapshot it weekly and grade it forward).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { games, gameLines, spRatings } from '../api/_lib/cfbd.js';
import { olsSolve } from '../api/_lib/ridge.js';
import { normCdf } from '../api/_lib/pickem.js';

const CACHE = new URL('../.cache/cfbd/', import.meta.url);
const FIRST = 2016, LAST = 2025, TEST_FROM = 2019;

// Every CFBD response is cached to disk. The free tier is 1,000 calls a MONTH, and a script meant
// to be re-run while tuning must not spend two calls a season every time it runs.
async function cached(name, fetcher) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const f = new URL(name, CACHE);
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  const j = await fetcher();
  writeFileSync(f, JSON.stringify(j));
  return j;
}

// Power-conference membership, for the thin-market split. The whole reason to look at college is
// that lines on a Sun Belt game are softer than lines on an SEC game; if that is true it shows up
// as a difference between these two groups and nowhere else.
const P5 = new Set(['ACC', 'Big Ten', 'Big 12', 'SEC', 'Pac-12', 'FBS Independents']);

const rows = [];
for (let y = FIRST; y <= LAST; y++) {
  const gs = await cached(`games_${y}.json`, () => games(y));
  const ls = await cached(`lines_${y}.json`, () => gameLines(y));
  const lineBy = new Map();
  for (const r of ls) {
    // Consensus first; it is present on ~96% of games and is the closest thing to "the market".
    const l = (r.lines || []).find((x) => x.provider === 'consensus') || (r.lines || [])[0];
    if (l && typeof l.spread === 'number') lineBy.set(r.id, l.spread);
  }
  for (const g of gs) {
    if (!g.completed) continue;
    if (g.homeClassification !== 'fbs' || g.awayClassification !== 'fbs') continue;
    if (!Number.isFinite(g.homePregameElo) || !Number.isFinite(g.awayPregameElo)) continue;
    if (!Number.isFinite(g.homePoints) || !Number.isFinite(g.awayPoints)) continue;
    const margin = g.homePoints - g.awayPoints;
    if (margin === 0) continue; // college has no ties since 1996, but guard anyway
    const raw = lineBy.get(g.id);
    rows.push({
      season: y, week: g.week,
      eloDiff: g.homePregameElo - g.awayPregameElo,
      margin,
      // CFBD states a spread from the HOME team's perspective with NEGATIVE meaning home is
      // favoured ("Michigan State -45" arrives as -45 with MSU at home) — the OPPOSITE of
      // nflverse's spread_line. Negating here puts it on the same footing as the NFL script, where
      // positive means the home team is expected to win by that much. The sign is asserted against
      // real results below rather than trusted from a sample of one.
      marketMargin: typeof raw === 'number' ? -raw : null,
      neutral: g.neutralSite === true,
      p5: P5.has(g.homeConference) && P5.has(g.awayConference),
      g5: !P5.has(g.homeConference) && !P5.has(g.awayConference),
    });
  }
}

// --- sign check, before anything is fitted ---------------------------------
// If the negation above were backwards, every number in this report would be confidently wrong and
// nothing else here would notice. A correct market margin correlates POSITIVELY with the actual
// one; a flipped one correlates about as strongly in the negative direction.
{
  const m = rows.filter((r) => r.marketMargin != null);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const xs = m.map((r) => r.marketMargin), ys = m.map((r) => r.margin);
  const mx = mean(xs), my = mean(ys);
  const cov = mean(m.map((_, i) => (xs[i] - mx) * (ys[i] - my)));
  const sx = Math.sqrt(mean(xs.map((x) => (x - mx) ** 2)));
  const sy = Math.sqrt(mean(ys.map((y) => (y - my) ** 2)));
  const r = cov / (sx * sy);
  console.log(`spread sign check: corr(market margin, actual margin) = ${r.toFixed(3)}`);
  if (r < 0.3) {
    console.error('ABORT: the spread sign convention is wrong — every downstream number would be inverted.');
    process.exit(1);
  }
  const favHit = m.filter((r2) => (r2.marketMargin > 0) === (r2.margin > 0)).length / m.length;
  console.log(`               market favourite wins ${(favHit * 100).toFixed(1)}% straight up\n`);
}

console.log(`FBS-vs-FBS games with pregame Elo: ${rows.length} (${FIRST}-${LAST})`);
console.log(`  …of which carry a market line:   ${rows.filter((r) => r.marketMargin != null).length}\n`);

// --- the model -------------------------------------------------------------
// predicted_home_margin = b0 + b1 * (eloHome - eloAway)
// b0 is home-field advantage in points; b1 converts Elo into points and should land near 1/25,
// the conventional Elo-per-point scaling.
const fit = (train) => olsSolve({
  rows: train.map((r) => [1, r.eloDiff, r.neutral ? 1 : 0]),
  y: train.map((r) => r.margin),
});
const predict = (b, r) => b[0] + b[1] * r.eloDiff + b[2] * (r.neutral ? 1 : 0);

// Residual spread, used to turn a margin into a probability. Estimated from TRAINING residuals
// rather than borrowed from the NFL's 13.5 — college margins are far more variable, and reusing
// the NFL constant would make every college probability overconfident.
const sdOf = (resid) => Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / resid.length);
const wp = (m, sd) => Math.max(0.03, Math.min(0.97, normCdf(m / sd)));

// --- walk-forward ----------------------------------------------------------
console.log('WALK-FORWARD (train on every prior season, test on the named one)\n');
console.log('season    n    model_Brier  mkt_Brier   model_MAE  mkt_MAE   model_acc  mkt_acc');
const pooled = [];
let coef = null, modelSd = null, marketSd = null;
for (let s = TEST_FROM; s <= LAST; s++) {
  const train = rows.filter((r) => r.season < s);
  const test = rows.filter((r) => r.season === s && r.marketMargin != null);
  if (train.length < 500 || !test.length) continue;
  const b = fit(train);
  const mSd = sdOf(train.map((r) => r.margin - predict(b, r)));
  const trainMkt = train.filter((r) => r.marketMargin != null);
  const kSd = sdOf(trainMkt.map((r) => r.margin - r.marketMargin));
  coef = b; modelSd = mSd; marketSd = kSd;

  let bm = 0, bk = 0, am = 0, ak = 0, hm = 0, hk = 0;
  for (const r of test) {
    const pm = predict(b, r), hw = r.margin > 0;
    const pM = wp(pm, mSd), pK = wp(r.marketMargin, kSd);
    bm += (pM - (hw ? 1 : 0)) ** 2; bk += (pK - (hw ? 1 : 0)) ** 2;
    am += Math.abs(pm - r.margin); ak += Math.abs(r.marketMargin - r.margin);
    if ((pM > 0.5) === hw) hm++; if ((pK > 0.5) === hw) hk++;
    pooled.push({ ...r, pm, pM, pK });
  }
  const n = test.length;
  console.log(`${s}    ${String(n).padStart(4)}     ${(bm / n).toFixed(4)}     ${(bk / n).toFixed(4)}`
    + `     ${(am / n).toFixed(2)}    ${(ak / n).toFixed(2)}     ${(hm / n * 100).toFixed(1)}%    ${(hk / n * 100).toFixed(1)}%`);
}

const agg = (sel) => {
  if (!sel.length) return null;
  const n = sel.length;
  const bm = sel.reduce((s, r) => s + (r.pM - (r.margin > 0 ? 1 : 0)) ** 2, 0) / n;
  const bk = sel.reduce((s, r) => s + (r.pK - (r.margin > 0 ? 1 : 0)) ** 2, 0) / n;
  const am = sel.reduce((s, r) => s + Math.abs(r.pm - r.margin), 0) / n;
  const ak = sel.reduce((s, r) => s + Math.abs(r.marketMargin - r.margin), 0) / n;
  const hm = sel.filter((r) => (r.pM > 0.5) === (r.margin > 0)).length / n;
  const hk = sel.filter((r) => (r.pK > 0.5) === (r.margin > 0)).length / n;
  return { n, bm, bk, am, ak, hm, hk };
};

const P = agg(pooled);
console.log(`\nPOOLED OUT-OF-SAMPLE  (${P.n} games, ${TEST_FROM}-${LAST})`);
console.log(`  model   Brier ${P.bm.toFixed(4)}   MAE ${P.am.toFixed(2)}   acc ${(P.hm * 100).toFixed(1)}%`);
console.log(`  market  Brier ${P.bk.toFixed(4)}   MAE ${P.ak.toFixed(2)}   acc ${(P.hk * 100).toFixed(1)}%`);
console.log(`  delta   Brier ${(P.bm - P.bk >= 0 ? '+' : '')}${(P.bm - P.bk).toFixed(4)}  (positive = model is WORSE)`);
console.log(`  residual SD: model ${modelSd.toFixed(2)} pts, market ${marketSd.toFixed(2)} pts`);

// --- the thin-market thesis ------------------------------------------------
// The scoping doc's second-ranked opportunity: if an edge exists anywhere in college it is on
// Group-of-Five games, where the market is thinner. This is the test of that claim.
console.log('\nTHIN-MARKET SPLIT  (is the market softer where fewer people are betting?)');
console.log('  segment            n     model_Brier  mkt_Brier    gap');
for (const [label, sel] of [
  ['Power 5 both sides', pooled.filter((r) => r.p5)],
  ['Group of 5 both   ', pooled.filter((r) => r.g5)],
  ['Mixed / other     ', pooled.filter((r) => !r.p5 && !r.g5)],
]) {
  const a = agg(sel);
  if (!a) continue;
  console.log(`  ${label} ${String(a.n).padStart(5)}      ${a.bm.toFixed(4)}     ${a.bk.toFixed(4)}   ${(a.bm - a.bk >= 0 ? '+' : '')}${(a.bm - a.bk).toFixed(4)}`);
}

console.log('\nMODEL CALIBRATION (favourite\'s side, out of sample)');
const buck = new Map();
for (const r of pooled) {
  const pf = Math.max(r.pM, 1 - r.pM);
  const k = Math.min(Math.floor(pf * 10) / 10, 0.9);
  (buck.get(k) || buck.set(k, []).get(k)).push((r.margin > 0) === (r.pM > 0.5));
}
console.log('  predicted      n     actual');
const calibration = [];
for (const k of [...buck.keys()].sort()) {
  const v = buck.get(k);
  const actual = v.filter(Boolean).length / v.length;
  calibration.push({ lo: k, n: v.length, actual });
  console.log(`  ${(k * 100).toFixed(0)}-${(k * 100 + 10).toFixed(0)}%   ${String(v.length).padStart(5)}     ${(actual * 100).toFixed(1)}%`);
}

console.log('\nDISAGREEMENT SIGNAL (model line vs market line)');
console.log('  gap         n     model side wins   market implied');
const disagree = [];
for (const [lo, hi] of [[0, 3], [3, 6], [6, 10], [10, 99]]) {
  const sel = pooled.filter((r) => Math.abs(r.pm - r.marketMargin) >= lo && Math.abs(r.pm - r.marketMargin) < hi);
  if (!sel.length) continue;
  let wins = 0, implied = 0;
  for (const r of sel) {
    const modelHome = r.pm > r.marketMargin;
    wins += (modelHome === (r.margin > 0)) ? 1 : 0;
    implied += modelHome ? r.pK : 1 - r.pK;
  }
  disagree.push({ lo, hi: hi === 99 ? null : hi, n: sel.length, modelSideWinRate: wins / sel.length, marketImplied: implied / sel.length });
  console.log(`  ${lo}-${hi === 99 ? '+' : hi} pts  ${String(sel.length).padStart(5)}      ${(wins / sel.length * 100).toFixed(1)}%            ${(implied / sel.length * 100).toFixed(1)}%`);
}

const winProbGate = P.bm < P.bk;
const disagreeGate = disagree.filter((d) => d.n >= 100).every((d) => d.modelSideWinRate > d.marketImplied);
console.log('\nGATES (for the ELO structure — SP+ itself is still unvalidated)');
console.log(`  college win % may be shown      : ${winProbGate ? 'PASS' : 'FAIL'}  (needs Brier < ${P.bk.toFixed(4)}, got ${P.bm.toFixed(4)})`);
console.log(`  college disagreement may be shown: ${disagreeGate ? 'PASS' : 'FAIL'}`);
console.log(`\nCOEFFICIENTS: intercept ${coef[0].toFixed(4)}  eloDiff ${coef[1].toFixed(5)}  neutralAdj ${coef[2].toFixed(4)}`);
console.log(`  (${(1 / coef[1]).toFixed(1)} Elo points per point of margin)`);

// --- home-field advantage, measured on SP+ ITSELF ---------------------------
//
// The Elo fit above reports a home-field intercept, but transplanting it into an SP+ model would be
// borrowing a coefficient from a model we do not ship. So this fits it directly on SP+:
//
//     margin = hfa + slope * (SP+home - SP+away) + neutralAdj * isNeutral
//
// USING END-OF-SEASON SP+ HERE IS DELIBERATE AND, FOR THIS ONE QUESTION, LEGITIMATE. Everywhere
// else in this file that would be a fatal leak. But home-field advantage is identified by the
// ASYMMETRY between playing at home and away, and the end-of-season leak contaminates both teams in
// a game symmetrically — it inflates how well `slope` fits, and leaves `hfa` alone. So `slope` and
// the goodness of fit below are NOT evidence of predictive skill and must never be quoted as such;
// only `hfa` and `neutralAdj` are taken from this, and only those are written out.
const spByYear = {};
for (let y = FIRST; y <= LAST; y++) {
  const sp = await cached(`sp_${y}.json`, () => spRatings(y));
  spByYear[y] = new Map(sp.filter((r) => r?.team && typeof r.rating === 'number').map((r) => [r.team, r.rating]));
}
const spRows = [];
for (let y = FIRST; y <= LAST; y++) {
  const gs = await cached(`games_${y}.json`, () => games(y));
  const m = spByYear[y];
  for (const g of gs) {
    if (!g.completed || g.homeClassification !== 'fbs' || g.awayClassification !== 'fbs') continue;
    const h = m.get(g.homeTeam), a = m.get(g.awayTeam);
    if (!Number.isFinite(h) || !Number.isFinite(a)) continue;
    if (!Number.isFinite(g.homePoints) || !Number.isFinite(g.awayPoints)) continue;
    spRows.push({ d: h - a, margin: g.homePoints - g.awayPoints, neutral: g.neutralSite === true });
  }
}
const spFit = olsSolve({
  rows: spRows.map((r) => [1, r.d, r.neutral ? 1 : 0]),
  y: spRows.map((r) => r.margin),
});
const trueNeutral = spRows.filter((r) => r.neutral);
const atHome = spRows.filter((r) => !r.neutral);
console.log(`\nHOME FIELD, FITTED ON SP+ ITSELF  (${spRows.length} games; ${atHome.length} hosted, ${trueNeutral.length} neutral)`);
console.log(`  home-field advantage : ${spFit[0].toFixed(3)} pts`);
console.log(`  neutral-site adjust  : ${spFit[2].toFixed(3)} pts  -> effective ${(spFit[0] + spFit[2]).toFixed(3)} at a neutral site`);
console.log(`  SP+ slope            : ${spFit[1].toFixed(3)}  (leak-inflated; NOT a skill estimate)`);
// Raw sanity check, no model at all: what is the plain average home margin?
const rawHome = atHome.reduce((s, r) => s + r.margin, 0) / atHome.length;
const rawNeut = trueNeutral.length ? trueNeutral.reduce((s, r) => s + r.margin, 0) / trueNeutral.length : null;
console.log(`  (unmodelled average home margin ${rawHome.toFixed(2)}; nominal-home margin at neutral sites ${rawNeut === null ? 'n/a' : rawNeut.toFixed(2)})`);

if (process.argv.includes('--write')) {
  const out = {
    sport: 'cfb', basis: 'pregame-elo', fittedAt: new Date().toISOString(),
    trainSeasons: [FIRST, LAST - 1], marginSd: modelSd, marketSd,
    coef: { intercept: coef[0], eloDiff: coef[1], neutral: coef[2] },
    outOfSample: {
      seasons: [TEST_FROM, LAST], games: P.n,
      modelBrier: P.bm, marketBrier: P.bk, modelMae: P.am, marketMae: P.ak,
      modelAcc: P.hm, marketAcc: P.hk, calibration, disagreement: disagree,
      segments: {
        p5: agg(pooled.filter((r) => r.p5)), g5: agg(pooled.filter((r) => r.g5)),
      },
    },
    gates: { showWinProb: winProbGate, showDisagreement: disagreeGate },
    // Fitted on SP+ directly (see above), which is why these — and only these — are safe to put
    // into the shipped model. `spSlope` is recorded for completeness and is leak-inflated.
    homeField: { pts: spFit[0], neutralAdj: spFit[2], spSlope: spFit[1], games: spRows.length, fittedOn: 'sp+' },
    // The load-bearing caveat, carried in the artefact so it cannot be lost in a summary.
    validates: 'the rating-difference structure, using pregame Elo',
    doesNotValidate: 'SP+, which is what the feed actually ships; /ratings/sp is end-of-season only',
  };
  writeFileSync(new URL('../api/_lib/cfbModelCoef.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('\nwrote api/_lib/cfbModelCoef.json');
}
