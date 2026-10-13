// Basketball (NBA + WNBA) data assembly for FantasyEdge — the analog of
// buildDataset.js. Both leagues share this module; only the ESPN league slug
// differs.
//
// Source: ESPN's public "byathlete" season-statistics endpoint (free, no key, no
// special headers — chosen over stats.nba.com, which commonly IP-blocks
// datacenter egress, and balldontlie, which now requires a key). One paginated
// call set returns every qualified player's per-game season averages. Stats are
// read BY NAME via an index map, so the two leagues' differing column orders are
// handled transparently.
//
// Ranking: standard 9-category roto z-score (PTS, REB, AST, STL, BLK, 3PM, plus
// turnovers as a negative and FG%/FT% as volume-weighted rate impacts), summed
// into one value. Mirrors the MLB pipeline's record shape so the same frontend
// renders both. Output: { builtAt, sport, players, counts }.

import { fetchByAthlete, buildIndex, makeReader, priorSeasonParam } from './espn.js';
import { fetchInjuries, applyInjuries } from './espnInjuries.js';

// Manual display-name overrides, keyed by ESPN athlete id (globally unique across
// NBA + WNBA). ESPN occasionally changes a player's displayName to a new legal name
// (e.g. a married name) while fantasy users still know and search them by the prior
// one. We keep ESPN as the source of truth for every stat and only reshape the shown
// name — folding both names into one "Current (Former)" string. The frontend search
// matches the whole display string, so either term finds the player, no search-side
// plumbing needed. Example: Megan Gustafson (Iowa) now plays as Megan DiLeo (Portland).
const NAME_OVERRIDES = {
  '3934218': 'Megan DiLeo (Gustafson)',
};

// z-score pool gate. Like the MLB PA gate, it adapts to how far the season has
// progressed (40% of the leader's games played) so it's right early- AND full-
// season; MIN_MINUTES additionally drops deep-bench players from the rate pool.
const GAMES_FRAC = 0.4;
const GAMES_FLOOR = 5;
const MIN_MINUTES = 10;

// Below this many games for the season leader, the current season is too young to rank on (opening
// week: a 3-game sample would replace a full season of evidence). The build then ranks on the
// PRIOR full season instead and says so in counts.basis — the board a preseason drafter needs.
const MIN_SEASON_GAMES = 10;

// Shrinkage prior for short-sample (draft-eligible, sub-gate) players, as a fraction of the games
// gate — never below GAMES_PRIOR, so a short sample is always regressed at least as hard as a
// ranked player. The first cut used the whole gate (~33 games at season's end), which buried every
// star who missed time: on real 2025-26 data Anthony Davis (20 GP) sat at #74 and Jayson Tatum
// (16 GP) at #88 of an 8-cat board, picks no real room would let them reach. 0.4 (~13 games) puts
// them at #48 and #56 — still a real availability discount against the same line over a full
// season — while short-sample players with ordinary lines stay where their production puts them
// (Morant #89, Sabonis #101, Trae Young #112) and end-of-bench names stay outside the top 130.
// Lower is not better: at the GAMES_PRIOR floor (0.25) a 5-game sample starts ranking in the 50s.
const LOW_SAMPLE_PRIOR_FRAC = 0.4;
const lowSamplePrior = (gamesGate) => Math.max(GAMES_PRIOR, Math.round(gamesGate * LOW_SAMPLE_PRIOR_FRAC));

// Category-strength pills (drives the star count, like the MLB cats).
function buildNbaCats(n) {
  const cats = [];
  if (n.pts >= 20) cats.push('PTS');
  if (n.reb >= 8) cats.push('REB');
  if (n.ast >= 5) cats.push('AST');
  if (n.stl >= 1.3) cats.push('STL');
  if (n.blk >= 1.2) cats.push('BLK');
  if (n.tpm >= 2.5) cats.push('3PM');
  if (n.fgPct >= 0.5 && n.fga >= 8) cats.push('FG%');
  if (n.ftPct >= 0.85 && n.fta >= 2) cats.push('FT%');
  if (n.to > 0 && n.to <= 1.5) cats.push('TO');
  return cats;
}

// Most games any athlete has played in a byathlete payload (the season's progress).
function maxGamesOf(athletes, val) {
  let m = 0;
  for (const a of athletes || []) m = Math.max(m, val(a, 'general', 'gamesPlayed') || 0);
  return m;
}

const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
const pct = (v) => (v == null ? '—' : '.' + Math.round(v * 1000)); // 0.465 -> ".465"

// Per-game counting cats z-scored with a small-sample dampener (below); FG%/FT%
// use a volume-weighted marginal impact so high-usage efficient players outscore
// low-volume percentage merchants (and which is itself sample-aware via attempts).
const COUNTING_CATS = ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'to'];

// Internal scoring key -> exposed per-category z key. The two rate cats are scored as
// volume-weighted marginal impacts (impFG/impFT) but surface under their category names
// so the draft engine and UI can read a clean { ...counting, fgPct, ftPct } z block.
const Z_KEY = { impFG: 'fgPct', impFT: 'ftPct' };

// Shrinkage prior, in games of league-average play. A player's per-game rate is
// regressed toward the league mean as if he'd also played GAMES_PRIOR league-
// average games, so an outlier early-season rate (e.g. 3.0 STL over 15 games)
// is pulled toward the mean and can't dominate the z-score. The pull fades as
// games accumulate, vanishing to a negligible nudge by a full season.
const GAMES_PRIOR = 8;

// Standard 9-cat z-score. Counting cats are regressed-then-z-scored; turnovers
// subtract; FG%/FT% are volume-weighted marginal impacts. Sets rec.score in place.
//
// `extra` players are scored against the SAME pool norms (league means, SDs, FG/FT baselines) without
// joining the pool — so adding them can't move anyone else's value. Used for short-sample players
// (e.g. a star who missed most of last season): their regressed rates already shrink toward the
// league mean, which is the right discount for a small sample.
function scoreNba(pool, extra = [], extraPrior = GAMES_PRIOR) {
  if (!pool.length) return;
  // Short-sample extras are regressed harder than the pool (extraPrior = lowSamplePrior(gamesGate),
  // ~13 games at season's end vs 8): a player who missed most of the season carries real
  // availability risk, so his value is pulled toward the league average rather than trusted at face
  // value. Pool players keep GAMES_PRIOR exactly.
  const extraSet = new Set(extra);
  const priorOf = (p) => (extraSet.has(p) ? extraPrior : GAMES_PRIOR);
  const sum = (f) => pool.reduce((a, p) => a + f(p._n), 0);
  const lgFG = sum((n) => n.fgm) / (sum((n) => n.fga) || 1);
  const lgFT = sum((n) => n.ftm) / (sum((n) => n.fta) || 1);
  for (const p of [...pool, ...extra]) {
    const n = p._n;
    // Shooting impacts aren't rate-regressed for the pool (unchanged); extras get the same
    // games-share discount as their counting cats so a short hot streak can't carry FG%/FT%.
    const w = extraSet.has(p) ? n.g / (n.g + extraPrior) : 1;
    n.impFG = (n.fgPct - lgFG) * n.fga * w; // makes above expectation, weighted by volume
    n.impFT = (n.ftPct - lgFT) * n.fta * w;
  }
  // Games-weighted league per-game mean for each counting cat (the shrink target).
  const totalG = sum((n) => n.g) || 1;
  const lgRate = {};
  for (const k of COUNTING_CATS) lgRate[k] = sum((n) => n[k] * n.g) / totalG;
  // Regressed per-game value used for ranking (display stats stay the real rates).
  const valOf = (n, k, prior = GAMES_PRIOR) => {
    if (k === 'impFG' || k === 'impFT') return n[k];
    return (n[k] * n.g + lgRate[k] * prior) / (n.g + prior);
  };

  // sign: +1 helps, -1 hurts (turnovers)
  const keys = [
    ['pts', 1], ['reb', 1], ['ast', 1], ['stl', 1], ['blk', 1],
    ['tpm', 1], ['to', -1], ['impFG', 1], ['impFT', 1],
  ];
  const norm = {};
  for (const [k] of keys) {
    const xs = pool.map((p) => valOf(p._n, k));
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    norm[k] = { m, sd };
  }
  for (const p of [...pool, ...extra]) {
    // Per-category z (sign already folded in, so turnovers contribute negatively). Stored
    // under category names via Z_KEY; the sum is the 9-cat ranking value (zTotal).
    const z = {};
    for (const [k, sign] of keys) {
      z[Z_KEY[k] || k] = (sign * (valOf(p._n, k, priorOf(p)) - norm[k].m)) / norm[k].sd;
    }
    p._z = z;
    p.score = Object.values(z).reduce((a, b) => a + b, 0);
  }
}

// Cosmetic trend/own/tag from rank — identical formula to the MLB decorate.
function decorate(rec, i) {
  rec.rank = i + 1;
  rec.emoji = '🏀';
  rec.trend = 'flat';   // real HOT/COLD form is applied later by enrichForm (cron)
  rec.trendVal = '';
  rec.own = Math.max(10, 99 - i * 2);
  rec.tag = null;       // no rank-based badges; HOT/COLD come from recent form
}

// Prior full-season per-game line for the Mock Draft sidebar, keyed by athlete id. Additive and
// failure-tolerant: any error (or an out-of-range prior year) yields an empty map, so players just
// show no prior-year line rather than failing the build.
async function fetchPrevYearBasketball(sport, priorSeasonParam) {
  const out = new Map();
  if (!Number.isFinite(priorSeasonParam)) return out;
  try {
    const { athletes, categories, season } = await fetchByAthlete({
      sportPath: `basketball/${sport}`, sort: 'offensive.avgPoints:desc', season: priorSeasonParam, tolerant: true,
    });
    const val = makeReader(buildIndex(categories));
    for (const a of athletes) {
      const at = a.athlete || {};
      if (at.id == null) continue;
      const g = val(a, 'general', 'gamesPlayed');
      const num = (c, k) => { const v = val(a, c, k); return v == null ? '—' : (+v).toFixed(1); };
      out.set(String(at.id), {
        season,
        headline: g != null ? `${g} GP` : '',
        line: [
          { cat: 'PTS', val: num('offensive', 'avgPoints') },
          { cat: 'REB', val: num('general', 'avgRebounds') },
          { cat: 'AST', val: num('offensive', 'avgAssists') },
          { cat: '3PM', val: num('offensive', 'avgThreePointFieldGoalsMade') },
          { cat: 'STL', val: num('defensive', 'avgSteals') },
          { cat: 'BLK', val: num('defensive', 'avgBlocks') },
        ],
      });
    }
  } catch { /* prior season unavailable — no-op */ }
  return out;
}

async function buildBasketballDataset(sport) {
  let { athletes, categories, season } = await fetchByAthlete({
    sportPath: `basketball/${sport}`,
    sort: 'offensive.avgPoints:desc',
  });
  // Opening-week guard: too few games into the new season → rank on the prior full season.
  let basis = 'season';
  const leaderGames = maxGamesOf(athletes, makeReader(buildIndex(categories)));
  if (leaderGames < MIN_SEASON_GAMES) {
    const priorParam = priorSeasonParam(season);
    if (Number.isFinite(priorParam)) {
      try {
        const prior = await fetchByAthlete({ sportPath: `basketball/${sport}`, sort: 'offensive.avgPoints:desc', season: priorParam });
        if (maxGamesOf(prior.athletes, makeReader(buildIndex(prior.categories))) >= MIN_SEASON_GAMES) {
          ({ athletes, categories, season } = prior);
          basis = 'prior-season';
        }
      } catch { /* prior season unavailable — keep the young current season */ }
    }
  }
  const idx = buildIndex(categories);
  const val = makeReader(idx);
  // Prior full season (e.g. NBA "2025-26" -> param 2025 = "2024-25"; WNBA "2026" -> 2025), fetched once
  // and matched by athlete id below. Additive; failure-tolerant.
  const prevMap = await fetchPrevYearBasketball(sport, priorSeasonParam(season));

  const records = [];
  for (const a of athletes) {
    const at = a.athlete || {};
    if (at.id == null) continue;
    const fgPctRaw = val(a, 'offensive', 'fieldGoalPct'); // 0-100
    const ftPctRaw = val(a, 'offensive', 'freeThrowPct');
    const n = {
      g: val(a, 'general', 'gamesPlayed') || 0,
      min: val(a, 'general', 'avgMinutes') || 0,
      pts: val(a, 'offensive', 'avgPoints') || 0,
      reb: val(a, 'general', 'avgRebounds') || 0,
      ast: val(a, 'offensive', 'avgAssists') || 0,
      stl: val(a, 'defensive', 'avgSteals') || 0,
      blk: val(a, 'defensive', 'avgBlocks') || 0,
      to: val(a, 'offensive', 'avgTurnovers') || 0,
      tpm: val(a, 'offensive', 'avgThreePointFieldGoalsMade') || 0,
      fgm: val(a, 'offensive', 'avgFieldGoalsMade') || 0,
      fga: val(a, 'offensive', 'avgFieldGoalsAttempted') || 0,
      ftm: val(a, 'offensive', 'avgFreeThrowsMade') || 0,
      fta: val(a, 'offensive', 'avgFreeThrowsAttempted') || 0,
      fgPct: fgPctRaw == null ? 0 : fgPctRaw / 100,
      ftPct: ftPctRaw == null ? 0 : ftPctRaw / 100,
    };
    const rec = {
      id: at.id,
      name: NAME_OVERRIDES[String(at.id)] || at.displayName || `${at.firstName || ''} ${at.lastName || ''}`.trim() || 'Unknown',
      team: at.teamShortName || at.teamName || '—',
      league: null, // NBA has no AL/NL; the league toggle is hidden for non-MLB
      pos: at.position?.abbreviation || '—',
      hasStats: true,
      games: n.g, // season games played — surfaces as the GP column
      s1: fmt(n.pts), s2: fmt(n.reb), s3: fmt(n.ast),
      s4: fmt(n.tpm), s5: fmt(n.stl), s6: fmt(n.blk),
      statLabels: ['PTS', 'REB', 'AST', '3PM', 'STL', 'BLK'],
      cats: buildNbaCats(n),
      _n: n,
    };
    records.push(rec);
  }

  const maxG = records.reduce((m, r) => Math.max(m, r._n.g), 0);
  const gamesGate = Math.max(GAMES_FLOOR, Math.round(GAMES_FRAC * maxG));
  const qualifies = (r) => r._n.g >= gamesGate && r._n.min >= MIN_MINUTES;
  const ranked = records.filter(qualifies);
  const subThreshold = records.filter((r) => !qualifies(r));
  // Short-sample but real: enough games to be a player (GAMES_FLOOR) at rotation minutes. Scored for
  // the draft board against the ranked pool's norms; still kept OUT of the rankings table.
  const lowSample = subThreshold.filter((r) => r._n.g >= GAMES_FLOOR && r._n.min >= MIN_MINUTES);

  scoreNba(ranked, lowSample, lowSamplePrior(gamesGate));
  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach(decorate);

  for (const r of subThreshold) {
    r.searchOnly = true; // kept for search, out of the ranked table (small sample)
    r.emoji = '🏀';
  }
  for (const r of lowSample) {
    r.draftEligible = true; // …but on the draft board, flagged so the Coach can call out the risk
    r.lowSample = true;
  }

  // Expose the per-game stat object and (for ranked players) the per-category z block +
  // 9-cat total, so the category draft engine and UI can read real value without
  // recomputing. Additive — the rankings tab ignores these. Sub-threshold (search-only)
  // players were never scored, so they carry stats but no z. Rounded to keep the payload small.
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const players = [...ranked, ...subThreshold];
  // ESPN injury designations (shared with the NFL/NHL boards). Additive and failure-tolerant.
  const injFix = applyInjuries(players, await fetchInjuries(sport === 'wnba' ? 'basketball/wnba' : 'basketball/nba'));
  for (const r of players) {
    r.n = r._n; // per-game category stats { pts, reb, ast, stl, blk, tpm, to, fgPct, ftPct, ... }
    const pv = prevMap.get(String(r.id));
    if (pv) r.prevYear = pv; // prior full-season line for the Mock Draft sidebar
    if (r._z) {
      const z = {};
      for (const k in r._z) z[k] = r3(r._z[k]);
      r.z = z;
      r.zTotal = r3(r.score);
    } else {
      r.z = null;
      r.zTotal = null;
    }
    delete r.score;
    delete r._n;
    delete r._z;
  }

  return {
    builtAt: new Date().toISOString(),
    sport,
    players,
    counts: {
      season,
      athletes: athletes.length,
      basis, // 'season' | 'prior-season' (opening-week guard)
      ranked: ranked.length,
      subThreshold: subThreshold.length,
      draftEligibleLowSample: lowSample.length,
      gamesGate,
      maxGames: maxG,
      total: players.length,
      injuries: injFix,
    },
  };
}

export const buildNbaDataset = () => buildBasketballDataset('nba');
export const buildWnbaDataset = () => buildBasketballDataset('wnba');
