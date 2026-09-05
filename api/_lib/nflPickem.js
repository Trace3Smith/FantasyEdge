// NFL Pick'em — the first Brackets & Bowls section. A thin wrapper over the shared football
// Pick'em pipeline (api/_lib/pickem.js); this file only supplies NFL-specific config: the
// scoreboard/injuries endpoints and the stadium coordinates for weather. See pickem.js for
// the win-probability-from-spread derivation, injuries, and weather logic.
import { buildPickem, winProbFromSpread } from './pickem.js';
import { redis, NFL_DATASET_KEY } from './kv.js';

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

// Starting quarterbacks, for the single-QB injury rule in injuryGroups.js.
//
// ESPN publishes no starter flag on the injury feed, and its depth-chart endpoint would cost a
// call per team. But the NFL dataset this app already builds and caches carries a fantasy
// projection per player, and the team's top projected QB IS the starter — checked against the real
// depth charts it gets Penix over Tua, Daniels over Mariota, Ward over Trubisky, Lamar over
// Huntley, Mahomes over Fields. So this costs ONE cached read per build and no upstream calls.
//
// A MARGIN IS REQUIRED, because a projection leader is a correlate of the starter, not the starter
// itself, and the gap is the confidence signal. Cleveland came back Watson 102.1 vs Sanders 97.1 —
// a genuine open competition, where naming either as "the starter" would be inventing a fact. Below
// the margin the team is simply omitted and the QB rule stays silent for it.
const QB_MARGIN_RATIO = 1.25; // top QB must lead the next by 25%…
const QB_MARGIN_ABS = 40;     // …and by a real number of points, so two low projections can't qualify

export async function startingQbs() {
  let dataset;
  try { dataset = await redis.get(NFL_DATASET_KEY); } catch { return {}; }
  const qbs = (dataset?.players || []).filter((p) => p.pos === 'QB' && !p.searchOnly && p.team);
  const byTeam = {};
  for (const p of qbs) (byTeam[p.team] = byTeam[p.team] || []).push(p);

  const out = {};
  for (const [team, list] of Object.entries(byTeam)) {
    const ranked = list
      .map((p) => ({ name: p.name, pts: p.proj?.fpts })
      ).filter((p) => typeof p.pts === 'number' && p.name)
      .sort((a, b) => b.pts - a.pts);
    if (!ranked.length) continue;
    const [first, second] = ranked;
    // A lone QB on the roster is unambiguous; otherwise require a clear gap over the next man.
    if (!second || (first.pts >= second.pts * QB_MARGIN_RATIO && first.pts - second.pts >= QB_MARGIN_ABS)) {
      out[team] = first.name;
    }
  }
  return out;
}

// Build the current/upcoming NFL week (pass `week` to target a specific one).
export function buildNflPickem({ week } = {}) {
  return buildPickem({
    leaguePath: 'football/nfl',
    startingQbs,
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
