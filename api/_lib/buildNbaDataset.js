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

import { fetchByAthlete, buildIndex, makeReader } from './espn.js';

// z-score pool gate. Like the MLB PA gate, it adapts to how far the season has
// progressed (40% of the leader's games played) so it's right early- AND full-
// season; MIN_MINUTES additionally drops deep-bench players from the rate pool.
const GAMES_FRAC = 0.4;
const GAMES_FLOOR = 5;
const MIN_MINUTES = 10;

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

const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d));
const pct = (v) => (v == null ? '—' : '.' + Math.round(v * 1000)); // 0.465 -> ".465"

// Standard 9-cat z-score. Counting cats are plain z-scores; turnovers subtract;
// FG%/FT% use a volume-weighted marginal impact so high-usage efficient players
// outscore low-volume percentage merchants. Sets rec.score in place.
function scoreNba(pool) {
  if (!pool.length) return;
  const sum = (f) => pool.reduce((a, p) => a + f(p._n), 0);
  const lgFG = sum((n) => n.fgm) / (sum((n) => n.fga) || 1);
  const lgFT = sum((n) => n.ftm) / (sum((n) => n.fta) || 1);
  for (const p of pool) {
    const n = p._n;
    n.impFG = (n.fgPct - lgFG) * n.fga; // makes above expectation, weighted by volume
    n.impFT = (n.ftPct - lgFT) * n.fta;
  }
  // sign: +1 helps, -1 hurts (turnovers)
  const keys = [
    ['pts', 1], ['reb', 1], ['ast', 1], ['stl', 1], ['blk', 1],
    ['tpm', 1], ['to', -1], ['impFG', 1], ['impFT', 1],
  ];
  const norm = {};
  for (const [k] of keys) {
    const xs = pool.map((p) => p._n[k]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    norm[k] = { m, sd };
  }
  for (const p of pool) {
    p.score = keys.reduce((a, [k, sign]) => a + (sign * (p._n[k] - norm[k].m)) / norm[k].sd, 0);
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

async function buildBasketballDataset(sport) {
  const { athletes, categories, season } = await fetchByAthlete({
    sportPath: `basketball/${sport}`,
    sort: 'offensive.avgPoints:desc',
  });
  const idx = buildIndex(categories);
  const val = makeReader(idx);

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
      name: at.displayName || `${at.firstName || ''} ${at.lastName || ''}`.trim() || 'Unknown',
      team: at.teamShortName || at.teamName || '—',
      league: null, // NBA has no AL/NL; the league toggle is hidden for non-MLB
      pos: at.position?.abbreviation || '—',
      hasStats: true,
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

  scoreNba(ranked);
  ranked.sort((a, b) => b.score - a.score);
  ranked.forEach(decorate);

  for (const r of subThreshold) {
    r.searchOnly = true; // kept for search, out of the ranked table (small sample)
    r.emoji = '🏀';
  }

  const players = [...ranked, ...subThreshold];
  for (const r of players) {
    delete r.score;
    delete r._n;
  }

  return {
    builtAt: new Date().toISOString(),
    sport,
    players,
    counts: {
      season,
      athletes: athletes.length,
      ranked: ranked.length,
      subThreshold: subThreshold.length,
      gamesGate,
      maxGames: maxG,
      total: players.length,
    },
  };
}

export const buildNbaDataset = () => buildBasketballDataset('nba');
export const buildWnbaDataset = () => buildBasketballDataset('wnba');
