// NFL Pick'em — the first Brackets & Bowls section. A thin wrapper over the shared football
// Pick'em pipeline (api/_lib/pickem.js); this file only supplies NFL-specific config: the
// scoreboard/injuries endpoints and the stadium coordinates for weather. See pickem.js for
// the win-probability-from-spread derivation, injuries, and weather logic.
import { buildPickem, winProbFromSpread } from './pickem.js';

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

// Build the current/upcoming NFL week (pass `week` to target a specific one).
export function buildNflPickem({ week } = {}) {
  return buildPickem({
    scoreboardUrl: week ? `${SB}?week=${encodeURIComponent(week)}` : SB,
    injuriesUrl: INJ,
    coordsFor: (comp, home) => STADIUMS[home.team.abbreviation] || null,
  });
}
