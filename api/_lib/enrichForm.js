// Recent-form HOT/COLD badges. Replaces the old rank-based fire/trending/slump
// tags (which were cosmetic, not real). A player is HOT/COLD when his recent
// games beat/trail his own season average; otherwise no badge.
//
// Gating (the user's rules):
//   • Only when the sport is ACTIVELY being played — detected from the data: a
//     sport's regular season is in progress when the league leader's games played
//     is below a full season. Offseason datasets carry the last completed season
//     at full game count, so this naturally suppresses badges out of season.
//   • Only when the player has a meaningful sample (min games per sport).
//
// Cost control: game logs are per-player fetches, so we only enrich the top
// TOP_N ranked players of each in-season sport, in the daily cron (not on the
// cold-start request path). Failure-tolerant per player and overall.

import { getJson } from './espn.js';

const FORM = {
  mlb:  { minGames: 15, full: 162, recent: 7, src: 'mlb' },
  nba:  { minGames: 10, full: 82,  recent: 5, src: 'espn', path: 'basketball/nba' },
  wnba: { minGames: 10, full: 44,  recent: 5, src: 'espn', path: 'basketball/wnba' },
  nhl:  { minGames: 10, full: 82,  recent: 5, src: 'espn', path: 'hockey/nhl' },
  nfl:  { minGames: 4,  full: 17,  recent: 3, src: 'espn', path: 'football/nfl' },
};
const TOP_N = 75;
const HOT = 1.20;  // recent avg >= 120% of season avg
const COLD = 0.80; // recent avg <= 80% of season avg

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };

// ---- per-game fantasy value from a stat line (per sport) --------------------
function gameValueEspn(sport, pos, v) {
  if (sport === 'nba' || sport === 'wnba')
    return v('points') + 1.2 * v('totalRebounds') + 1.5 * v('assists') + 3 * v('steals') + 3 * v('blocks') - v('turnovers');
  if (sport === 'nhl') {
    if (pos === 'G') return 2 * v('wins') + 0.2 * v('saves') + 3 * v('shutouts') - 1.5 * v('goalsAgainst');
    return 3 * v('goals') + 2 * v('assists') + 0.4 * v('shotsTotal') + 0.5 * (v('powerPlayGoals') + v('powerPlayAssists')) + v('plusMinus');
  }
  if (sport === 'nfl')
    return v('passingYards') * 0.04 + v('passingTouchdowns') * 4 - v('interceptions') * 2
      + v('rushingYards') * 0.1 + v('rushingTouchdowns') * 6
      + v('receptions') + v('receivingYards') * 0.1 + v('receivingTouchdowns') * 6 - v('fumblesLost') * 2;
  return 0;
}

// ESPN per-athlete game log -> [{date, value}] for the CURRENT regular season.
async function espnGames(path, id, sport, pos) {
  const gl = await getJson(`https://site.web.api.espn.com/apis/common/v3/sports/${path}/athletes/${id}/gamelog`);
  const names = gl.names || [];
  const idx = new Map(names.map((n, i) => [n, i]));
  const events = gl.events || {};
  // ESPN lists the current season first; take the first Regular Season block.
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const games = [];
  for (const cat of st.categories || []) {
    for (const ev of cat.events || []) {
      const v = (name) => num(ev.stats?.[idx.get(name)]);
      const d = events[ev.eventId]?.gameDate;
      games.push({ date: d ? new Date(d).getTime() : 0, value: gameValueEspn(sport, pos, v) });
    }
  }
  return games;
}

// MLB Stats API game log -> [{date, value}]. Hitters and pitchers score differently.
const ipToOuts = (ip) => { const [w, f] = String(ip ?? '0').split('.'); return (parseInt(w) || 0) * 3 + (parseInt(f) || 0); };
function gameValueMlb(pos, s) {
  if (pos === 'SP' || pos === 'RP') {
    return ipToOuts(s.inningsPitched) + 2 * num(s.strikeOuts) - 2 * num(s.earnedRuns) - num(s.hits) - num(s.baseOnBalls);
  }
  const tb = num(s.hits) + num(s.doubles) + 2 * num(s.triples) + 3 * num(s.homeRuns);
  return tb + num(s.runs) + num(s.rbi) + num(s.baseOnBalls) + num(s.stolenBases);
}
async function mlbGames(id, pos, season) {
  const group = pos === 'SP' || pos === 'RP' ? 'pitching' : 'hitting';
  const j = await getJson(`https://statsapi.mlb.com/api/v1/people/${id}/stats?stats=gameLog&season=${season}&group=${group}&gameType=R`);
  const splits = j.stats?.[0]?.splits || [];
  return splits.map((sp) => ({ date: sp.date ? new Date(sp.date).getTime() : 0, value: gameValueMlb(pos, sp.stat || {}) }));
}

// Small batched-parallel helper (cap concurrent fetches).
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

// Mutates dataset.players: sets tag 'hot'|'cold' (+ trend/trendVal) on the top
// players whose recent form diverges from their season average; leaves the rest
// with no badge. No-op (and no fetches) when the sport is out of season.
export async function enrichForm(dataset, { sport, season }) {
  const cfg = FORM[sport];
  if (!cfg || !Array.isArray(dataset.players)) return;
  const maxGames = sport === 'mlb' ? dataset.counts?.teamGames : dataset.counts?.maxGames;
  // Offseason / regular season complete -> no badges at all.
  if (maxGames == null || maxGames >= cfg.full) {
    dataset.counts = { ...dataset.counts, formActive: false };
    return;
  }

  const top = dataset.players
    .filter((p) => !p.searchOnly && p.rank != null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, TOP_N);

  let hot = 0, cold = 0;
  await mapLimit(top, 8, async (p) => {
    try {
      const games = cfg.src === 'mlb'
        ? await mlbGames(p.id, p.pos, season)
        : await espnGames(cfg.path, p.id, sport, p.pos);
      if (games.length < cfg.minGames) return; // sample too small
      games.sort((a, b) => b.date - a.date); // newest first
      const recent = games.slice(0, cfg.recent);
      const seasonAvg = games.reduce((a, g) => a + g.value, 0) / games.length;
      const recentAvg = recent.reduce((a, g) => a + g.value, 0) / recent.length;
      if (seasonAvg <= 0) return; // avoid noise on near-zero producers
      const ratio = recentAvg / seasonAvg;
      if (ratio >= HOT) { p.tag = 'hot'; p.trend = 'up'; p.trendVal = '+' + Math.round((ratio - 1) * 100) + '%'; hot++; }
      else if (ratio <= COLD) { p.tag = 'cold'; p.trend = 'down'; p.trendVal = '-' + Math.round((1 - ratio) * 100) + '%'; cold++; }
    } catch {
      /* per-player failure is non-fatal */
    }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: top.length };
}
