// NBA/WNBA day-of opponent matchup — the BvP analog for basketball, shared by both leagues (parameterized
// by sport, like enrichRollingEspn). For each team playing today, records the OPPONENT'S defense + pace: a
// player scores against the opponent's defense, and a faster opponent means more possessions for both sides.
//
// SOURCE: ESPN only (stats.nba.com times out from serverless). ESPN's team-stats feed doesn't name `pace`
// or `defensiveRating`, so both are DERIVED from fields it does provide (verified realistic vs 2025 data):
//   • opponent points allowed/game = avgPoints − avgPointsDifferential   (defensive-strength proxy)
//   • pace (possessions/game)      = avgFGA + 0.44·avgFTA − avgOREB + avgTOV
// Schedule from the ESPN scoreboard. Both feeds are keyless, fast (~0.18s), and agree with the dataset on
// team abbrevs (verified 30/30 for NBA), so the matchup is keyed by abbrev to match p.team.
//
// DATA ONLY (+ a lean): records ranks + a favorable/tough/neutral lean; the synopsis def phrases it. Applies
// to ALL players (no position exclusion — everyone benefits from a weak defense / fast pace). Seasonal like
// BvP/NHL: empty out of season / on off-days → the synopsis falls back to season value + form. The caller
// keeps the last good payload if a build throws.

import { getJson } from './espn.js';

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const BYTEAM = (sport) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/${sport}/statistics/byteam`;
const SCOREBOARD = (sport) => `https://site.web.api.espn.com/apis/site/v2/sports/basketball/${sport}/scoreboard`;
const MIN_GP = 5; // below this many games, team ranks are too noisy for a favorable/tough lean

const iso = (d) => d.toISOString().slice(0, 10);
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// Classify from the OPPONENT's defensive rank (1 = stingiest, allows fewest points). Opponent in the
// leakiest third → favorable; stingiest third → tough; else neutral. `rated` false early-season → neutral.
export function leanFor(oppDefRank, n, rated) {
  if (!rated || !oppDefRank || !n) return 'neutral';
  const tri = Math.max(1, Math.round(n / 3));
  if (oppDefRank >= n - tri + 1) return 'favorable'; // opponent allows a lot of points (weak defense)
  if (oppDefRank <= tri) return 'tough';             // opponent is a stingy defense
  return 'neutral';
}

// Per-team {oppPtsAllowed, pace, gp} + ranks from the ESPN byteam payload. ESPN uses parallel
// values/ranks arrays defined by a top-level label schema (like the gamelog `names` pattern); resolve each
// label to (category, index) then read the matching per-team category. defRank asc by points allowed
// (1 = best defense); paceRank desc by pace (1 = fastest).
async function fetchTeamStats(sport, season, seasontype) {
  const j = await getJson(`${BYTEAM(sport)}?region=us&lang=en&season=${season}&seasontype=${seasontype}`);
  const lab = new Map();
  for (const c of j.categories || []) {
    (c.names || []).forEach((n, i) => { if (!lab.has(n)) lab.set(n, { cat: c.name, idx: i, len: c.names.length }); });
  }
  const get = (team, label) => {
    const m = lab.get(label); if (!m) return null;
    for (const c of team.categories || []) {
      const vals = c.values || [];
      if (c.name === m.cat && vals.length === m.len) return vals[m.idx];
    }
    return null;
  };
  const rows = [];
  for (const t of j.teams || []) {
    const ab = t.team?.abbreviation; if (!ab) continue;
    const ap = get(t, 'avgPoints'), apd = get(t, 'avgPointsDifferential');
    const fga = get(t, 'avgFieldGoalsAttempted'), fta = get(t, 'avgFreeThrowsAttempted');
    const oreb = get(t, 'avgOffensiveRebounds'), tov = get(t, 'avgTurnovers');
    if ([ap, apd, fga, fta, oreb, tov].some((v) => v == null)) continue;
    rows.push({
      abbrev: ab, gp: get(t, 'gamesPlayed') || 0,
      oppPtsAllowed: r1(ap - apd),
      pace: r1(fga + 0.44 * fta - oreb + tov),
    });
  }
  if (!rows.length) return { map: new Map(), n: 0, minGp: 0 };
  const defRank = new Map(), paceRank = new Map();
  [...rows].sort((a, b) => a.oppPtsAllowed - b.oppPtsAllowed).forEach((t, i) => defRank.set(t.abbrev, i + 1));
  [...rows].sort((a, b) => b.pace - a.pace).forEach((t, i) => paceRank.set(t.abbrev, i + 1));
  const map = new Map();
  for (const t of rows) map.set(t.abbrev, { ...t, defRank: defRank.get(t.abbrev), paceRank: paceRank.get(t.abbrev) });
  return { map, n: rows.length, minGp: Math.min(...rows.map((t) => t.gp || 0)) };
}

// One side's matchup entry, keyed by the scoring team's abbrev, holding the OPPONENT's defense + pace.
function sideEntry(opp, isHome, stats, n, rated) {
  const od = stats.map.get(opp.abbrev);
  if (!od) return null;
  const lean = leanFor(od.defRank, n, rated);
  const tri = Math.max(1, Math.round(n / 3));
  const fast = rated && od.paceRank <= tri;              // opponent among the fastest third
  const slow = rated && od.paceRank >= n - tri + 1;      // opponent among the slowest third
  const oppName = opp.name || opp.abbrev;
  let reason;
  if (lean === 'favorable') {
    reason = `Favorable matchup — ${oppName} allow the ${ord(n - od.defRank + 1)}-most points per game (${od.oppPtsAllowed}/gm)`
      + (fast ? `, at a top-${tri} pace (more possessions).` : `.`);
  } else if (lean === 'tough') {
    reason = `Tough matchup — ${oppName} are a stingy defense, ${ord(od.defRank)}-fewest points allowed (${od.oppPtsAllowed}/gm)`
      + (slow ? `, at a bottom-tier pace.` : `.`);
  } else {
    reason = `Faces ${oppName} (${ord(od.defRank)} in points allowed`
      + (fast ? `, fast pace).` : slow ? `, slow pace).` : `).`);
  }
  return {
    opp: { abbrev: opp.abbrev, name: oppName }, isHome,
    oppPtsAllowed: od.oppPtsAllowed, oppDefRank: od.defRank, pace: od.pace, oppPaceRank: od.paceRank, lean, reason,
  };
}

// Build today's basketball matchup payload for a league. An explicit date/season makes the whole join
// testable against a past in-season day.
export async function buildNbaMatchup({ sport = 'nba', date = iso(new Date()), season, seasontype = 2 } = {}) {
  const now = new Date().toISOString();
  const sb = await getJson(`${SCOREBOARD(sport)}?dates=${date.replace(/-/g, '')}`);
  const games = [];
  let sYear = season;
  for (const e of sb.events || []) {
    const type = e.season?.type ?? 2;
    if (type !== 2 && type !== 3) continue; // regular + playoffs only
    const comp = e.competitions?.[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === 'home'), away = cs.find((c) => c.homeAway === 'away');
    if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
    sYear = sYear || e.season?.year;
    const mk = (c) => ({ abbrev: c.team.abbreviation, name: c.team.shortDisplayName || c.team.name || c.team.abbreviation });
    games.push({ home: mk(home), away: mk(away) });
  }
  if (!games.length) return { date, sport, builtAt: now, rated: false, teams: {}, counts: { games: 0, teams: 0 } };

  const stats = await fetchTeamStats(sport, sYear || new Date().getFullYear(), seasontype);
  const rated = stats.n > 0 && stats.minGp >= MIN_GP;
  const teams = {};
  for (const g of games) {
    const a = sideEntry(g.home, false, stats, stats.n, rated); if (a) teams[g.away.abbrev] = a; // away scores vs home D
    const h = sideEntry(g.away, true, stats, stats.n, rated);  if (h) teams[g.home.abbrev] = h;  // home scores vs away D
  }
  const leans = Object.values(teams).reduce((m, t) => (m[t.lean] = (m[t.lean] || 0) + 1, m), {});
  return { date, sport, builtAt: now, season: sYear, rated, teams, counts: { games: games.length, teams: Object.keys(teams).length, leans } };
}
