// NHL data assembly for FantasyEdge — same ESPN byathlete source as the
// basketball builders, but structurally like MLB: two groups with different stat
// sets ranked on separate scales. Skaters (F/D) score on a 9-category roto
// z-score; goalies (G) score on their own goalie categories. Output shape matches
// the other sports so the same frontend renders it.
//
// NOTE on categories: ESPN's NHL feed does NOT expose hits or blocks, so the
// skater 9-cat uses what ESPN provides — goals, assists, +/-, PIM, power-play
// points, shots, faceoff wins, game-winning goals, and shooting impact (goals
// above expectation given shot volume). Goalies use W, GAA (inverted), SV%
// (volume-weighted), shutouts, and saves.

import { fetchByAthlete, buildIndex, makeReader } from './espn.js';

// Adaptive games gates (fraction of the group leader's games played), like the
// MLB PA gate — correct early- and full-season. Goalies play fewer games.
const SKATER_GAMES_FRAC = 0.35;
const SKATER_GAMES_FLOOR = 3;
const GOALIE_GAMES_FRAC = 0.25;
const GOALIE_GAMES_FLOOR = 2;

// Detailed ESPN position -> coarse F/D/G (the position-filter buttons).
function coarsePos(abbr) {
  if (abbr === 'G') return 'G';
  if (abbr === 'D') return 'D';
  return 'F'; // C / LW / RW / F
}

const fmt = (v, d = 0) => (v == null ? '—' : v.toFixed(d));
const pct = (v) => (v == null ? '—' : '.' + String(Math.round(v * 1000)).padStart(3, '0')); // .908

// z-score a set of {key, sign} columns over a pool and sum into rec.score.
function zScore(pool, keys) {
  if (!pool.length) return;
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

function skaterCats(n, gp) {
  const pg = (x) => (gp > 0 ? x / gp : 0);
  const cats = [];
  if (pg(n.g) >= 0.4) cats.push('G');
  if (pg(n.a) >= 0.55) cats.push('A');
  if (pg(n.g + n.a) >= 1.0) cats.push('PTS');
  if (pg(n.sog) >= 3) cats.push('SOG');
  if (pg(n.ppp) >= 0.4) cats.push('PPP');
  if (pg(n.fow) >= 8) cats.push('FOW');
  if (n.plusMinus >= 8) cats.push('+/-');
  return cats;
}

function goalieCats(n) {
  const cats = [];
  if (n.gp > 0 && n.w / n.gp >= 0.5) cats.push('W');
  if (n.svpct >= 0.915) cats.push('SV%');
  if (n.gaa > 0 && n.gaa <= 2.6) cats.push('GAA');
  if (n.so >= 2) cats.push('SO');
  return cats;
}

// Cosmetic trend/own/tag from rank — identical formula to MLB/NBA decorate.
function decorate(rec, i) {
  rec.rank = i + 1;
  rec.emoji = '🏒';
  rec.trend = 'flat';   // real HOT/COLD form is applied later by enrichForm (cron)
  rec.trendVal = '';
  rec.own = Math.max(10, 99 - i * 2);
  rec.tag = null;       // no rank-based badges; HOT/COLD come from recent form
}

export async function buildNhlDataset() {
  const { athletes, categories, season } = await fetchByAthlete({
    sportPath: 'hockey/nhl',
    sort: 'offensive.points:desc',
  });
  const idx = buildIndex(categories);
  const val = makeReader(idx);

  const skaters = [];
  const goalies = [];
  for (const a of athletes) {
    const at = a.athlete || {};
    if (at.id == null) continue;
    const pos = coarsePos(at.position?.abbreviation || '');
    const base = {
      id: at.id,
      name: at.displayName || `${at.firstName || ''} ${at.lastName || ''}`.trim() || 'Unknown',
      team: at.teamShortName || at.teamName || '—',
      league: null,
      pos,
      hasStats: true,
    };

    if (pos === 'G') {
      const gp = val(a, 'general', 'games') || 0;
      const sv = val(a, 'defensive', 'saves') || 0;
      const sa = val(a, 'defensive', 'shotsAgainst') || 0;
      const n = {
        gp,
        w: val(a, 'general', 'wins') || 0,
        gaa: val(a, 'defensive', 'avgGoalsAgainst') || 0,
        svpct: val(a, 'defensive', 'savePct') || 0,
        so: val(a, 'defensive', 'shutouts') || 0,
        sv,
        sa,
      };
      goalies.push({
        ...base,
        s1: fmt(n.w), s2: n.gaa ? n.gaa.toFixed(2) : '—', s3: pct(n.svpct),
        s4: fmt(n.so), s5: fmt(n.sv), s6: fmt(n.sa),
        statLabels: ['W', 'GAA', 'SV%', 'SO', 'SV', 'SA'],
        cats: goalieCats(n),
        _n: n,
      });
    } else {
      const gp = val(a, 'general', 'games') || 0;
      const g = val(a, 'offensive', 'goals') || 0;
      const a_ = val(a, 'offensive', 'assists') || 0;
      const ppp = (val(a, 'offensive', 'powerPlayGoals') || 0) + (val(a, 'offensive', 'powerPlayAssists') || 0);
      const n = {
        gp,
        g,
        a: a_,
        plusMinus: val(a, 'general', 'plusMinus') || 0,
        pim: val(a, 'penalties', 'penaltyMinutes') || 0,
        ppp,
        sog: val(a, 'offensive', 'shotsTotal') || 0,
        fow: val(a, 'offensive', 'faceoffsWon') || 0,
        gwg: val(a, 'offensive', 'gameWinningGoals') || 0,
        shootImp: 0, // filled after league shooting rate is known
      };
      skaters.push({
        ...base,
        s1: fmt(g), s2: fmt(a_), s3: fmt(g + a_), s4: fmt(n.plusMinus), s5: fmt(n.sog), s6: fmt(ppp),
        statLabels: ['G', 'A', 'PTS', '+/-', 'SOG', 'PPP'],
        cats: skaterCats(n, gp),
        _n: n,
      });
    }
  }

  // --- Skaters: gate, then 9-cat z-score -----------------------------------
  const maxSk = skaters.reduce((m, r) => Math.max(m, r._n.gp), 0);
  const skGate = Math.max(SKATER_GAMES_FLOOR, Math.round(SKATER_GAMES_FRAC * maxSk));
  const rankedSk = skaters.filter((r) => r._n.gp >= skGate);
  const subSk = skaters.filter((r) => r._n.gp < skGate);
  // Shooting impact: goals above what league shooting % predicts for their shots.
  const lgShoot = rankedSk.reduce((a, r) => a + r._n.g, 0) / (rankedSk.reduce((a, r) => a + r._n.sog, 0) || 1);
  for (const r of rankedSk) r._n.shootImp = r._n.g - lgShoot * r._n.sog;
  zScore(rankedSk, [
    ['g', 1], ['a', 1], ['plusMinus', 1], ['pim', 1], ['ppp', 1],
    ['sog', 1], ['fow', 1], ['gwg', 1], ['shootImp', 1],
  ]);
  rankedSk.sort((a, b) => b.score - a.score);
  rankedSk.forEach(decorate);

  // --- Goalies: gate, then goalie z-score ----------------------------------
  const maxG = goalies.reduce((m, r) => Math.max(m, r._n.gp), 0);
  const gGate = Math.max(GOALIE_GAMES_FLOOR, Math.round(GOALIE_GAMES_FRAC * maxG));
  const rankedG = goalies.filter((r) => r._n.gp >= gGate);
  const subG = goalies.filter((r) => r._n.gp < gGate);
  const lgSV = rankedG.reduce((a, r) => a + r._n.sv, 0) / (rankedG.reduce((a, r) => a + r._n.sa, 0) || 1);
  for (const r of rankedG) r._n.svImp = (r._n.svpct - lgSV) * r._n.sa;
  zScore(rankedG, [
    ['w', 1], ['gaa', -1], ['svImp', 1], ['so', 1], ['sv', 1],
  ]);
  rankedG.sort((a, b) => b.score - a.score);
  rankedG.forEach(decorate);

  const subThreshold = [...subSk, ...subG];
  for (const r of subThreshold) {
    r.searchOnly = true;
    r.emoji = '🏒';
  }

  const players = [...rankedSk, ...rankedG, ...subThreshold];
  for (const r of players) {
    delete r.score;
    delete r._n;
  }

  return {
    builtAt: new Date().toISOString(),
    sport: 'nhl',
    players,
    counts: {
      season,
      athletes: athletes.length,
      skaters: rankedSk.length,
      goalies: rankedG.length,
      subThreshold: subThreshold.length,
      skaterGate: skGate,
      goalieGate: gGate,
      maxGames: Math.max(maxSk, maxG), // drives enrichForm's in-season check
      total: players.length,
    },
  };
}
