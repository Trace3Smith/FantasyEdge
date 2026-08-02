// NHL day-of opponent-defense matchup — the NHL analog of MLB's BvP (enrichBvp.js). For each team
// playing today, records the OPPONENT'S defensive quality (a skater's scoring matchup): opponent
// goals-against rank + penalty-kill rank, and a favorable/tough/neutral lean. Free via the NHL APIs
// (no key): schedule from api-web score/{date}, team defense from the stats REST team/summary feed.
//
// DATA ONLY (+ a lean classification): it records ranks and a lean; the synopsis def decides how to
// phrase it. Skaters only — a goalie's matchup is the opponent OFFENSE and hinges on whether he's the
// confirmed starter, which the free API does NOT reliably expose pre-game, so that piece is DEFERRED
// (verify once games resume 2026-10-06). Team-level: every skater on a team shares the same opponent.
//
// Seasonal, like BvP: in the offseason / on an off-day there are no games, so it returns an empty
// payload and the synopsis falls back to season value + form. Failure-tolerant: the caller keeps the
// last good payload if a build throws.

import { getJson } from './espn.js'; // generic JSON GET (same helper enrichBvp uses for statsapi)

const SCORE = 'https://api-web.nhle.com/v1/score';
const TEAM_SUMMARY = 'https://api.nhle.com/stats/rest/en/team/summary';
const MIN_GP = 10; // below this many games, team ranks are too noisy for a favorable/tough lean

const iso = (d) => d.toISOString().slice(0, 10);
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

// Classify a scoring matchup from the OPPONENT's defensive ranks (1 = stingiest defense / best PK).
// Opponent among the leakiest third → favorable; among the stingiest third → tough; else neutral.
// `rated` is false early in the season (too few games) → always neutral, no strong call. Pure/testable.
export function leanFor(oppGaRank, n, rated) {
  if (!rated || !oppGaRank || !n) return 'neutral';
  const tri = Math.max(1, Math.round(n / 3));
  if (oppGaRank >= n - tri + 1) return 'favorable'; // opponent allows a lot of goals
  if (oppGaRank <= tri) return 'tough';             // opponent is an elite defense
  return 'neutral';
}

// Fetch season team-defense and compute ranks. Returns { map: teamId -> {name,gp,gaPerGame,gaRank,
// pkPct,pkRank,ppPct}, n, minGp }. gaRank asc by GA/game (1 = fewest allowed = best); pkRank desc by
// PK% (1 = best kill). Season aggregates are available year-round (last completed season in the offseason).
async function fetchTeamDefense(seasonId) {
  const url = `${TEAM_SUMMARY}?cayenneExp=${encodeURIComponent(`seasonId=${seasonId} and gameTypeId=2`)}`;
  const j = await getJson(url);
  const rows = j.data || [];
  if (!rows.length) return { map: new Map(), n: 0, minGp: 0 };
  const gaRank = new Map(), pkRank = new Map();
  [...rows].sort((a, b) => a.goalsAgainstPerGame - b.goalsAgainstPerGame).forEach((t, i) => gaRank.set(t.teamId, i + 1));
  [...rows].sort((a, b) => b.penaltyKillPct - a.penaltyKillPct).forEach((t, i) => pkRank.set(t.teamId, i + 1));
  const map = new Map();
  for (const t of rows) {
    map.set(t.teamId, {
      name: t.teamFullName, gp: t.gamesPlayed || 0,
      gaPerGame: r2(t.goalsAgainstPerGame), gaRank: gaRank.get(t.teamId),
      pkPct: r1((t.penaltyKillPct || 0) * 100), pkRank: pkRank.get(t.teamId),
      ppPct: r1((t.powerPlayPct || 0) * 100),
    });
  }
  return { map, n: rows.length, minGp: Math.min(...rows.map((t) => t.gamesPlayed || 0)) };
}

// One side's matchup entry, keyed by the skating team's abbrev, holding the OPPONENT's defense.
function sideEntry(self, opp, isHome, def, n, rated) {
  const od = def.map.get(opp.id);
  if (!od) return null;
  const lean = leanFor(od.gaRank, n, rated);
  const tri = Math.max(1, Math.round(n / 3));
  const pkWeak = rated && od.pkRank >= n - tri + 1; // opponent has a bottom-tier penalty kill
  const oppName = opp.name?.default || opp.abbrev;
  let reason;
  if (lean === 'favorable') {
    reason = `Favorable matchup — ${oppName} allow the ${ord(n - od.gaRank + 1)}-most goals per game (${od.gaPerGame}/gm)`
      + (pkWeak ? `, with a bottom-tier penalty kill (power-play upside).` : `.`);
  } else if (lean === 'tough') {
    reason = `Tough matchup — ${oppName} are an elite defense, ${ord(od.gaRank)}-fewest goals allowed per game (${od.gaPerGame}/gm).`;
  } else {
    reason = `Faces ${oppName} (${ord(od.gaRank)} in goals against`
      + (pkWeak ? `, weak penalty kill).` : `).`);
  }
  return {
    opp: { abbrev: opp.abbrev, name: oppName }, isHome,
    oppGaPerGame: od.gaPerGame, oppGaRank: od.gaRank, oppPkPct: od.pkPct, oppPkRank: od.pkRank,
    lean, reason,
  };
}

// Build today's NHL matchup payload. Pure of storage: returns the payload; the caller stores it. An
// explicit `date` (and optional `seasonId`) makes the whole join testable against a past in-season day.
export async function buildNhlMatchup({ date = iso(new Date()), seasonId } = {}) {
  const now = new Date().toISOString();
  const sched = await getJson(`${SCORE}/${date}`);
  const games = (sched.games || []).filter((g) => g.gameType === 2 || g.gameType === 3); // regular + playoffs
  if (!games.length) return { date, builtAt: now, rated: false, teams: {}, counts: { games: 0, teams: 0 } };

  const season = seasonId || games[0].season; // the games carry their season (e.g. 20242025)
  const def = await fetchTeamDefense(season);
  const rated = def.n > 0 && def.minGp >= MIN_GP;

  const teams = {};
  for (const g of games) {
    const a = g.awayTeam, h = g.homeTeam;
    if (!a?.abbrev || !h?.abbrev) continue;
    const ae = sideEntry(a, h, false, def, def.n, rated); if (ae) teams[a.abbrev] = ae; // away skaters face home D
    const he = sideEntry(h, a, true, def, def.n, rated);  if (he) teams[h.abbrev] = he;  // home skaters face away D
  }
  const leans = Object.values(teams).reduce((m, t) => (m[t.lean] = (m[t.lean] || 0) + 1, m), {});
  return { date, builtAt: now, seasonId: season, rated, teams, counts: { games: games.length, teams: Object.keys(teams).length, leans } };
}
