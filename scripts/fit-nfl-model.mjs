// Offline fit + out-of-sample evaluation for the NFL margin model.
//
//   node scripts/fit-nfl-model.mjs            # fit, evaluate, print the report
//   node scripts/fit-nfl-model.mjs --write    # …and write api/_lib/nflModelCoef.json
//
// THE CRON NEVER TRAINS. This script is the only thing that fits anything; it emits a handful of
// coefficients as JSON which the request path reads and scores against. That keeps the daily
// rebuild to arithmetic, and it means the numbers shipped to users were produced by a run whose
// evaluation is printed below and reviewable in git.
//
// LEAK-FREE BY CONSTRUCTION. Predicting week W of season N may only ever see season N weeks
// 1..W-1, blended with season N-1's finished ratings — the same blend the live feed will use in
// that same week. Ratings are therefore recomputed from scratch for every (season, week) rather
// than fitted once on everything, which is slower and is the entire point: a model evaluated on
// data it was fitted on will report a number that production can never reproduce.
//
// The baseline it is measured against is the betting market, via the same
// `Phi(spread / 13.5)` the cards already ship. See docs/game-model-scoping.md for why that bar is
// as high as it is (Brier 0.2112 over 2016-2025, and calibrated at every confidence level).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parseCsv, rawRates, adjustEpa, blendSeasons } from '../api/_lib/nflRatings.js';
import { olsSolve } from '../api/_lib/ridge.js';
import { winProbFromSpread, normCdf } from '../api/_lib/pickem.js';

const CACHE = new URL('../.cache/nflverse/', import.meta.url);
const FIRST = 2016, LAST = 2025, TEST_FROM = 2019;

// Downloads are cached on disk. This script is meant to be re-run while tuning, and re-pulling
// eleven seasons from GitHub on every run is rude to nflverse and slow for us.
async function cached(name, url) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const f = new URL(name, CACHE);
  if (existsSync(f)) return readFileSync(f);
  const r = await fetch(url, { headers: { 'User-Agent': 'FantasyEdge/1.0 (model fit)' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(f, buf);
  return buf;
}

const statsUrl = (s) => `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${s}.csv.gz`;
const TEAM_ALIAS = { SD: 'LAC', OAK: 'LV', STL: 'LAR', LA: 'LAR', WAS: 'WSH', JAC: 'JAX' };
const norm = (t) => TEAM_ALIAS[t] || t;

async function loadSeason(s) {
  const buf = await cached(`stats_${s}.csv.gz`, statsUrl(s));
  return parseCsv(gunzipSync(buf).toString('utf8')).filter((x) => x.season_type === 'REG');
}

async function loadGames() {
  const buf = await cached('games.csv', 'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv');
  return parseCsv(buf.toString('utf8'));
}

// ---------------------------------------------------------------------------

const seasons = {};
for (let s = FIRST - 1; s <= LAST; s++) seasons[s] = await loadSeason(s);
const allGames = (await loadGames()).filter((g) => {
  const s = Number(g.season);
  return s >= FIRST && s <= LAST && g.game_type === 'REG' && g.result !== '' && g.result !== 'NA';
});

// Finished ratings for a whole season — the prior-season half of every blend.
const finalAdj = {};
for (const s of Object.keys(seasons)) finalAdj[s] = adjustEpa(rawRates(seasons[s]).lines);

// Ratings as they would have stood before a given week, exactly as the live feed will build them.
const ratingCache = new Map();
function ratingsBefore(season, week) {
  const key = `${season}:${week}`;
  if (ratingCache.has(key)) return ratingCache.get(key);
  const rates = rawRates(seasons[season], { throughWeek: week - 1 });
  const adj = adjustEpa(rates.lines);
  const games = Object.fromEntries(Object.entries(rates.teams).map(([t, v]) => [t, v.games]));
  const blended = blendSeasons({ ...adj, games }, finalAdj[season - 1] || null);
  ratingCache.set(key, blended);
  return blended;
}

// Every game as a feature row: the rating gap the model sees, the market's line, and the result.
const rows = [];
for (const g of allGames) {
  const season = Number(g.season), week = Number(g.week);
  const home = norm(g.home_team), away = norm(g.away_team);
  const R = ratingsBefore(season, week);
  const h = R[home], a = R[away];
  if (!h || !a) continue;
  const spread = g.spread_line === '' || g.spread_line === 'NA' ? null : Number(g.spread_line);
  rows.push({
    season, week, home, away,
    netDiff: h.net - a.net,
    offDiff: h.off - a.off,
    defDiff: h.def - a.def,
    margin: Number(g.result),          // home margin, positive = home won
    spread,                            // home spread, positive = home favoured
  });
}

console.log(`games with ratings on both sides: ${rows.length} (${FIRST}-${LAST})\n`);

// --- the fit --------------------------------------------------------------
// predicted_home_margin = b0 + b1 * (net_home - net_away)
// b0 absorbs home-field advantage; b1 converts EPA/play into points and should land near the
// number of plays in a game, because a point of EPA per play over ~63 plays IS ~63 points.
function fit(train) {
  const X = train.map((r) => [1, r.netDiff]);
  const y = train.map((r) => r.margin);
  return olsSolve({ rows: X, y });
}
const predict = (b, r) => b[0] + b[1] * r.netDiff;

// --- scoring --------------------------------------------------------------
// The margin-to-probability conversion is the one already shipping in pickem.js, deliberately:
// reusing it means the model's win % and the market's win % are on the same scale and any
// difference between them is a difference of opinion, not of arithmetic.
const MARGIN_SD = 13.5;
const winProb = (m) => Math.max(0.03, Math.min(0.97, normCdf(m / MARGIN_SD)));

function evaluate(test, b) {
  let brier = 0, mBrier = 0, mae = 0, mMae = 0, hit = 0, mHit = 0, n = 0, nM = 0;
  const buckets = new Map();
  for (const r of test) {
    const pm = predict(b, r);
    const p = winProb(pm);
    const hw = r.margin > 0;
    if (r.margin === 0) continue;
    brier += (p - (hw ? 1 : 0)) ** 2;
    mae += Math.abs(pm - r.margin);
    if ((p > 0.5) === hw) hit++;
    n++;
    // calibration on the favourite's side, so buckets read 50-100%
    const pf = Math.max(p, 1 - p);
    const k = Math.min(Math.floor(pf * 10) / 10, 0.9);
    const arr = buckets.get(k) || []; arr.push(hw === (p > 0.5)); buckets.set(k, arr);
    if (r.spread != null) {
      // winProbFromSpread returns the FAVOURITE's probability and takes a magnitude; spread_line is
      // the HOME spread with positive = home favoured, so the home-side read flips with the sign.
      const mph = r.spread > 0 ? winProbFromSpread(r.spread) : 1 - winProbFromSpread(-r.spread);
      mBrier += (mph - (hw ? 1 : 0)) ** 2;
      mMae += Math.abs(r.spread - r.margin);
      if ((mph > 0.5) === hw) mHit++;
      nM++;
    }
  }
  return {
    n, brier: brier / n, mae: mae / n, acc: hit / n,
    nM, mBrier: nM ? mBrier / nM : null, mMae: nM ? mMae / nM : null, mAcc: nM ? mHit / nM : null,
    buckets,
  };
}

// --- walk-forward ---------------------------------------------------------
console.log('WALK-FORWARD (train on every prior season, test on the named one)\n');
console.log('season   n    model_Brier  mkt_Brier    model_MAE  mkt_MAE   model_acc  mkt_acc');
const pooled = [];
let coef = null;
for (let s = TEST_FROM; s <= LAST; s++) {
  const train = rows.filter((r) => r.season < s);
  const test = rows.filter((r) => r.season === s);
  if (!train.length || !test.length) continue;
  const b = fit(train);
  coef = b; // the last fit (trained on everything before LAST) is what ships
  const e = evaluate(test, b);
  pooled.push(...test.map((r) => ({ ...r, pm: predict(b, r) })));
  console.log(
    `${s}   ${String(e.n).padStart(3)}      ${e.brier.toFixed(4)}     ${e.mBrier.toFixed(4)}`
    + `      ${e.mae.toFixed(2)}    ${e.mMae.toFixed(2)}      ${(e.acc * 100).toFixed(1)}%    ${(e.mAcc * 100).toFixed(1)}%`,
  );
}

// Pooled metrics are accumulated from the per-season predictions ACTUALLY MADE above, never from
// a refit over the whole range — a refit would quietly put every test game back in its own
// training set, which is the exact leak this script exists to avoid. from the per-season predictions actually made (not a refit).
let pb = 0, pm2 = 0, pmae = 0, pmmae = 0, ph = 0, pmh = 0, pn = 0;
const pbuck = new Map();
for (const r of pooled) {
  if (r.margin === 0) continue;
  const p = winProb(r.pm), hw = r.margin > 0;
  pb += (p - (hw ? 1 : 0)) ** 2; pmae += Math.abs(r.pm - r.margin); if ((p > 0.5) === hw) ph++;
  const pf = Math.max(p, 1 - p); const k = Math.min(Math.floor(pf * 10) / 10, 0.9);
  const arr = pbuck.get(k) || []; arr.push(hw === (p > 0.5)); pbuck.set(k, arr);
  if (r.spread != null) {
    const mph = r.spread > 0 ? winProbFromSpread(r.spread) : 1 - winProbFromSpread(-r.spread);
    pm2 += (mph - (hw ? 1 : 0)) ** 2; pmmae += Math.abs(r.spread - r.margin); if ((mph > 0.5) === hw) pmh++;
  }
  pn++;
}
console.log(`\nPOOLED OUT-OF-SAMPLE  (${pn} games, ${TEST_FROM}-${LAST})`);
console.log(`  model   Brier ${(pb / pn).toFixed(4)}   MAE ${(pmae / pn).toFixed(2)}   acc ${(ph / pn * 100).toFixed(1)}%`);
console.log(`  market  Brier ${(pm2 / pn).toFixed(4)}   MAE ${(pmmae / pn).toFixed(2)}   acc ${(pmh / pn * 100).toFixed(1)}%`);
console.log(`  delta   Brier ${((pb - pm2) / pn >= 0 ? '+' : '')}${((pb / pn) - (pm2 / pn)).toFixed(4)}  (positive = model is WORSE)`);

console.log('\nMODEL CALIBRATION (favourite\'s side, out of sample)');
console.log('  predicted      n     actual');
for (const k of [...pbuck.keys()].sort()) {
  const v = pbuck.get(k);
  console.log(`  ${(k * 100).toFixed(0)}-${(k * 100 + 10).toFixed(0)}%   ${String(v.length).padStart(4)}     ${(v.filter(Boolean).length / v.length * 100).toFixed(1)}%`);
}

// --- disagreement: does the model's dissent carry signal? -----------------
// The §6 gate from the scoping doc. Bucket games by how far the model's line sits from the
// market's, and ask whether the side the model prefers actually wins more often than the market
// implied. If it does not, the disagreement flag does not ship.
console.log('\nDISAGREEMENT SIGNAL (model line vs market line)');
console.log('  gap        n     model side wins   market implied');
const gaps = [[0, 3], [3, 6], [6, 10], [10, 99]];
const disagree = [];
for (const [lo, hi] of gaps) {
  const sel = pooled.filter((r) => r.spread != null && r.margin !== 0
    && Math.abs(r.pm - r.spread) >= lo && Math.abs(r.pm - r.spread) < hi);
  if (!sel.length) continue;
  let wins = 0, implied = 0;
  for (const r of sel) {
    const modelHome = r.pm > r.spread;           // model likes home more than the market does
    const hw = r.margin > 0;
    wins += (modelHome === hw) ? 1 : 0;
    const mph = r.spread > 0 ? winProbFromSpread(r.spread) : 1 - winProbFromSpread(-r.spread);
    implied += modelHome ? mph : 1 - mph;
  }
  disagree.push({ lo, hi: hi === 99 ? null : hi, n: sel.length, modelSideWinRate: wins / sel.length, marketImplied: implied / sel.length });
  console.log(`  ${lo}-${hi === 99 ? '+' : hi} pts  ${String(sel.length).padStart(4)}      ${(wins / sel.length * 100).toFixed(1)}%            ${(implied / sel.length * 100).toFixed(1)}%`);
}

// THE GATES, evaluated rather than asserted. Both of these decide what the feed is allowed to
// render, so they are written into the coefficient file and re-checked by scripts/check-model.mjs
// — a future refit that changes the answer changes the product, and should have to say so.
const winProbGate = (pb / pn) < (pm2 / pn);
const disagreeGate = disagree.filter((d) => d.n >= 100).every((d) => d.modelSideWinRate > d.marketImplied);
console.log(`\nGATES`);
console.log(`  model win % may be shown as a headline number : ${winProbGate ? 'PASS' : 'FAIL'}`
  + `  (needs out-of-sample Brier < ${(pm2 / pn).toFixed(4)}, got ${(pb / pn).toFixed(4)})`);
console.log(`  model-vs-market disagreement may be surfaced  : ${disagreeGate ? 'PASS' : 'FAIL'}`
  + `  (needs the model's side to beat the market's implied rate in every bucket)`);

console.log(`\nCOEFFICIENTS (trained ${FIRST}-${LAST - 1}):  intercept ${coef[0].toFixed(4)}  netDiff ${coef[1].toFixed(4)}`);

if (process.argv.includes('--write')) {
  const out = {
    sport: 'nfl',
    fittedAt: new Date().toISOString(),
    trainedThrough: LAST - 1,
    trainSeasons: [FIRST, LAST - 1],
    marginSd: MARGIN_SD,
    features: ['intercept', 'netDiff'],
    coef: { intercept: coef[0], netDiff: coef[1] },
    outOfSample: {
      seasons: [TEST_FROM, LAST],
      games: pn,
      modelBrier: pb / pn, marketBrier: pm2 / pn,
      modelMae: pmae / pn, marketMae: pmmae / pn,
      modelAcc: ph / pn, marketAcc: pmh / pn,
      calibration: [...pbuck.keys()].sort().map((k) => ({
        lo: k, n: pbuck.get(k).length,
        actual: pbuck.get(k).filter(Boolean).length / pbuck.get(k).length,
      })),
      disagreement: disagree,
    },
    // What the feed is ALLOWED to render, decided by the evaluation above rather than by taste.
    // gameModel.js reads these; it does not re-derive them.
    gates: {
      showWinProb: winProbGate,
      showDisagreement: disagreeGate,
      note: winProbGate ? 'model beat the market out of sample'
        : 'model did not beat the market out of sample; margin ships as EXPLANATION only',
    },
  };
  const p = new URL('../api/_lib/nflModelCoef.json', import.meta.url);
  writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nwrote ${p.pathname}`);
}
