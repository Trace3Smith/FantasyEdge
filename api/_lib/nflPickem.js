// NFL Pick'em — the first Brackets & Bowls section. A thin wrapper over the shared football
// Pick'em pipeline (api/_lib/pickem.js); this file only supplies NFL-specific config: the
// scoreboard/injuries endpoints and the stadium coordinates for weather. See pickem.js for
// the win-probability-from-spread derivation, injuries, and weather logic.
import { buildPickem, winProbFromSpread } from './pickem.js';
import { redis, NFL_DATASET_KEY } from './kv.js';
import { getJson } from './espn.js';

export { winProbFromSpread };

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const SB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const INJ = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

// Static stadium coordinates + dome flag for weather, keyed by home team abbrev (stable).
// The ESPN venue indoor flag is the authoritative dome override at build time.
const STADIUMS = {
  ARI: { lat: 33.5277, lon: -112.2626, dome: true }, ATL: { lat: 33.7554, lon: -84.4008, dome: true },
  BAL: { lat: 39.2780, lon: -76.6227, dome: false }, BUF: { lat: 42.7738, lon: -78.7870, dome: false },
  CAR: { lat: 35.2258, lon: -80.8528, dome: false }, CHI: { lat: 41.8623, lon: -87.6167, dome: false },
  CIN: { lat: 39.0954, lon: -84.5160, dome: false }, CLE: { lat: 41.5061, lon: -81.6995, dome: false },
  DAL: { lat: 32.7473, lon: -97.0945, dome: true }, DEN: { lat: 39.7439, lon: -105.0201, dome: false },
  DET: { lat: 42.3400, lon: -83.0456, dome: true }, GB: { lat: 44.5013, lon: -88.0622, dome: false },
  HOU: { lat: 29.6847, lon: -95.4107, dome: true }, IND: { lat: 39.7601, lon: -86.1639, dome: true },
  JAX: { lat: 30.3239, lon: -81.6373, dome: false }, KC: { lat: 39.0489, lon: -94.4839, dome: false },
  LV: { lat: 36.0909, lon: -115.1833, dome: true }, LAC: { lat: 33.9535, lon: -118.3392, dome: true },
  LAR: { lat: 33.9535, lon: -118.3392, dome: true }, MIA: { lat: 25.9580, lon: -80.2389, dome: false },
  MIN: { lat: 44.9736, lon: -93.2575, dome: true }, NE: { lat: 42.0909, lon: -71.2643, dome: false },
  NO: { lat: 29.9509, lon: -90.0812, dome: true }, NYG: { lat: 40.8135, lon: -74.0745, dome: false },
  NYJ: { lat: 40.8135, lon: -74.0745, dome: false }, PHI: { lat: 39.9008, lon: -75.1675, dome: false },
  PIT: { lat: 40.4468, lon: -80.0158, dome: false }, SEA: { lat: 47.5952, lon: -122.3316, dome: false },
  SF: { lat: 37.4030, lon: -121.9700, dome: false }, TB: { lat: 27.9759, lon: -82.5033, dome: false },
  TEN: { lat: 36.1665, lon: -86.7713, dome: false }, WSH: { lat: 38.9078, lon: -76.8645, dome: false },
};

// Starting skill players, for the starter injury lines in injuryGroups.js.
//
// ESPN publishes no starter flag on the injury feed, and its depth-chart endpoint would cost a call
// per team. But the NFL dataset this app already builds and caches carries a fantasy projection per
// player, and the team's top projected player at a position IS the starter — checked against real
// depth charts it gets Penix over Tua, Daniels over Mariota, Ward over Trubisky, Lamar over
// Huntley, Mahomes over Fields. So this costs ONE cached read per build and no upstream calls.
//
// A MARGIN IS REQUIRED, because a projection leader is a correlate of the starter, not the starter
// itself, and the size of the gap is the confidence signal. How often that gate passes varies by
// position, and it should: the top player's median lead over the second is 21.3x at QB, 3.25x at
// TE, 2.51x at RB and just 1.36x at WR. So 31/32 teams resolve a quarterback but only about
// two-thirds resolve a receiver — correctly, because Chicago genuinely reads Burden 209.0 vs
// Odunze 207.9 and Washington's backfield reads White 128.1 vs Croskey-Merritt 127.9. Naming a
// starter there would be inventing a fact, so those teams are simply omitted and the line stays
// silent for them. Loosening the gate to raise coverage would trade a true signal for a confident
// guess, which is the one thing this must not do.
const QB_MARGIN_RATIO = 1.25; // top player must lead the next by 25%…
const QB_MARGIN_ABS = 40;     // …and by a real number of points, so two low projections can't qualify
const STARTER_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// The dataset carries a stray team key or two from upstream — one Washington receiver arrives as
// WAS while the other eighteen are WSH, which would leave him out of the pool his team is ranked
// on and stand him up as a one-man team of his own. Normalising first is what makes the dataset
// resolve to exactly 32 teams.
const TEAM_ALIAS = { WAS: 'WSH', JAC: 'JAX', LA: 'LAR', SD: 'LAC', OAK: 'LV', STL: 'LAR' };
const normTeam = (t) => TEAM_ALIAS[t] || t;

// The team's most disruptive pass rusher, by last season's sack total. Answers the case the
// offensive method can't: a rotational rusher who isn't RB1/WR1-equivalent on any depth chart but
// is the reason the pass rush works.
//
// ONE REQUEST. The leaderboard is sortable and every team's sack leader appears within the top ~91,
// so 150 rows covers the league — espn.js's fetchByAthlete would page all 32 pages (1580 athletes)
// to tell us the same thing, so this fetches the one page it needs instead.
const SACKS_URL = (season) => 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl'
  + `/statistics/byathlete?season=${season}&seasontype=2&limit=150&sort=defensive.sacks%3Adesc`;
// The gate asks "is he so much better that losing him changes the pass rush?", not "is he the
// best?". Detroit reads Hutchinson 14.5 vs 11 and abstains — losing him hurts, but a team whose
// second rusher has 11 sacks does not lose its pressure. Seattle reads 7 vs 7 and abstains outright.
// 16 of 32 teams resolve; the floor stops a weak team's 3-sack "leader" being called disruptive.
const SACK_MARGIN_RATIO = 1.5;
const SACK_MARGIN_ABS = 2;
const SACK_FLOOR = 4;

export async function topPassRushers(season) {
  let j;
  try { j = await getJson(SACKS_URL(season)); } catch { return {}; }
  const glossary = {};
  for (const c of (j.categories || [])) glossary[c.name] = c.names || [];
  const si = (glossary.defensive || []).indexOf('sacks');
  if (si < 0) return {};

  const byTeam = {};
  for (const a of (j.athletes || [])) {
    const team = a.athlete?.teamShortName;
    const name = a.athlete?.displayName;
    const sacks = (a.categories || []).find((c) => c.name === 'defensive')?.values?.[si];
    if (!team || !name || typeof sacks !== 'number') continue;
    (byTeam[normTeam(team)] = byTeam[normTeam(team)] || []).push({ name, sacks });
  }

  const out = {};
  for (const [team, list] of Object.entries(byTeam)) {
    const [first, second] = list.slice().sort((a, b) => b.sacks - a.sacks);
    if (!first || first.sacks < SACK_FLOOR) continue;
    if (!second || (first.sacks >= second.sacks * SACK_MARGIN_RATIO && first.sacks - second.sacks >= SACK_MARGIN_ABS)) {
      out[team] = first.name;
    }
  }
  return out;
}

export async function startingSkillPlayers() {
  let dataset;
  try { dataset = await redis.get(NFL_DATASET_KEY); } catch { return {}; }
  const players = (dataset?.players || []).filter(
    (p) => !p.searchOnly && p.team && STARTER_POSITIONS.includes(p.pos) && typeof p.proj?.fpts === 'number',
  );

  const pools = {}; // team -> pos -> players
  for (const p of players) {
    const t = normTeam(p.team);
    ((pools[t] = pools[t] || {})[p.pos] = pools[t][p.pos] || []).push(p);
  }

  const out = {};
  for (const [team, byPos] of Object.entries(pools)) {
    for (const [pos, list] of Object.entries(byPos)) {
      const ranked = list.slice().sort((a, b) => b.proj.fpts - a.proj.fpts);
      const [first, second] = ranked;
      if (!first?.name) continue;
      // A lone player at the position is unambiguous; otherwise require a clear gap over the next.
      if (!second || (first.proj.fpts >= second.proj.fpts * QB_MARGIN_RATIO
        && first.proj.fpts - second.proj.fpts >= QB_MARGIN_ABS)) {
        (out[team] = out[team] || {})[pos] = first.name;
      }
    }
  }
  return out;
}

// Every inferred key player for the slate, merged into the one map injuryGroups.js reads.
// Both halves are independently best-effort: a failure in either leaves the other's lines intact.
export async function keyPlayers(season) {
  const [skill, rushers] = await Promise.all([
    startingSkillPlayers().catch(() => ({})),
    topPassRushers(season).catch(() => ({})),
  ]);
  const out = { ...skill };
  for (const [team, name] of Object.entries(rushers)) out[team] = { ...(out[team] || {}), PASSRUSH: name };
  return out;
}

// Build the current/upcoming NFL week (pass `week` to target a specific one).
export function buildNflPickem({ week } = {}) {
  return buildPickem({
    leaguePath: 'football/nfl',
    // Sacks are a season total, so early in a year the current season has nothing to rank — the
    // last completed one is what carries signal, exactly as the team reports fall back.
    starters: () => keyPlayers(new Date().getFullYear() - 1),
    scoreboardUrl: week ? `${SB}?week=${encodeURIComponent(week)}` : SB,
    injuriesUrl: INJ,
    // Keyed by HOME TEAM, which is only the right answer when the game is at their stadium. At a
    // neutral site it is not: the league plays in London, Munich, São Paulo and Melbourne, and
    // looking up the home team there would forecast their home city's weather for a game on the
    // other side of the world. Those get no forecast instead, which is the honest answer anyway —
    // NWS is US-only. This stayed invisible until now because the international games happened to
    // involve teams whose home stadium is a dome, so the dome check swallowed the wrong lookup.
    coordsFor: (comp, home) => (comp.neutralSite === true ? null : STADIUMS[home.team.abbreviation] || null),
  });
}
