// CFB Bowl Games / Playoff Pick'em — reuses the shared football Pick'em pipeline
// (api/_lib/pickem.js) with college-football config. Same win-probability-from-spread
// model, injuries, and weather as NFL Pick'em; the CFB-specific parts are: query the
// POSTSEASON slate (seasontype=3 = bowls + College Football Playoff, not the weekly regular
// season), drop FCS-division games, surface each game's bowl/playoff name, and resolve
// weather via a bowl-venue coordinate table (bowls are neutral sites, not team stadiums).
// See docs/brackets-data-research.md.
import { buildPickem, winProbFromSpread } from './pickem.js';
import { CFB_VENUES } from './cfbVenues.js';

export { winProbFromSpread };

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const SB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const INJ = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/injuries';

// The bowl "season" year: bowls run late Dec (year N) into early Jan (year N+1) and ESPN
// keys them under season year N. So Jul–Dec → this year's upcoming bowls; Jan–Jun → the
// bowls that just finished (last year's season). Before a season's bowls exist (e.g. mid-
// summer), the postseason slate is simply empty — the feed then reports "no bowls yet".
export function currentBowlSeason(now = new Date()) {
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}

// FCS games ride the same postseason feed (FCS playoff) but aren't bowls/CFP — their note
// headline contains "FCS". Everything else (FBS bowls + the College Football Playoff) is kept.
function isFcs(comp) {
  return (comp.notes || []).some((n) => /\bFCS\b/i.test(n.headline || ''));
}
// Bowl slots exist on the schedule (name/venue/date) months before teams are assigned — ESPN
// lists them as "TBD vs TBD" until the regular season ends. Drop those so the feed only shows
// REAL matchups: before ~mid-December it's simply empty (the UI says "check back in December"),
// then fills in as bowls are set. A real competitor has a team abbreviation and isn't "TBD".
function hasRealTeams(comp) {
  const cs = comp.competitors || [];
  if (cs.length < 2) return false;
  return cs.every((t) => t.team?.abbreviation && !/^tbd$/i.test(t.team.displayName || ''));
}
// The bowl/playoff name, straight from ESPN's event note headline (e.g. "Rose Bowl Game",
// "College Football Playoff First Round Game"). Null when ESPN provides no note.
function bowlNameOf(comp) {
  const h = (comp.notes || []).map((n) => n.headline).find(Boolean);
  return h || null;
}

// Coordinates + dome flag for the FBS bowl / CFP venues, keyed by ESPN venue id (stable across
// seasons). Hand-entered and hand-verified, so these take precedence over the generated FBS table
// (cfbVenues.js) — which now backs this one up, and is what covers a CFP first-round game played
// at a campus stadium rather than a bowl site. Domes skip weather (ESPN's indoor flag is also
// authoritative). A venue in neither table resolves to null, so weather is simply omitted there
// (graceful). NWS is US-only, so any international site (e.g. a Dublin game) also yields no
// weather.
const BOWL_VENUES = {
  '4013': { lat: 28.5390, lon: -81.4029, dome: false }, // Camping World Stadium, Orlando
  '3493': { dome: true },                                // Caesars Superdome, New Orleans
  '3886': { lat: 27.9759, lon: -82.5033, dome: false },  // Raymond James Stadium, Tampa
  '3948': { lat: 25.9580, lon: -80.2389, dome: false },  // Hard Rock Stadium, Miami Gardens
  '5348': { dome: true },                                // Mercedes-Benz Stadium, Atlanta
  '5455': { dome: true },                                // Ford Center at The Star, Frisco
  '1056': { lat: 34.1613, lon: -118.1676, dome: false }, // Rose Bowl, Pasadena
  '3604': { dome: true },                                // Alamodome, San Antonio
  '3616': { lat: 32.7096, lon: -97.3685, dome: false },  // Amon G. Carter Stadium, Fort Worth
  '3619': { lat: 32.1547, lon: -111.0770, dome: false }, // Casino Del Sol Stadium, Tucson
  '3626': { lat: 44.0582, lon: -123.0681, dome: false }, // Autzen Stadium, Eugene
  '3628': { lat: 35.2258, lon: -80.8528, dome: false },  // Bank of America Stadium, Charlotte
  '3653': { lat: 43.6027, lon: -116.1962, dome: false }, // Albertsons Stadium, Boise
  '3654': { lat: 33.7930, lon: -79.0113, dome: false },  // Brooks Stadium, Conway SC
  '3687': { dome: true },                                // AT&T Stadium, Arlington
  '3689': { lat: 32.3657, lon: -86.2971, dome: false },  // Cramton Bowl, Montgomery
  '3712': { lat: 30.3239, lon: -81.6373, dome: false },  // EverBank Stadium, Jacksonville
  '3715': { lat: 26.3712, lon: -80.1010, dome: false },  // FAU/Flagler CU Stadium, Boca Raton
  '3727': { dome: true },                                // Ford Field, Detroit
  '3735': { lat: 32.8386, lon: -96.7840, dome: false },  // Gerald J. Ford Stadium, Dallas
  '3766': { lat: 32.4740, lon: -93.7669, dome: false },  // Independence Stadium, Shreveport
  '3795': { lat: 30.6100, lon: -96.3400, dome: false },  // Kyle Field, College Station
  '3805': { lat: 35.1210, lon: -89.9430, dome: false },  // Simmons Bank Liberty Stadium, Memphis
  '3810': { lat: 36.1665, lon: -86.7713, dome: false },  // Nissan Stadium, Nashville
  '3835': { lat: 35.2059, lon: -97.4422, dome: false },  // Gaylord Family Memorial Stadium, Norman
  '3852': { lat: 38.9843, lon: -76.5080, dome: false },  // Navy-Marine Corps Stadium, Annapolis
  '3891': { dome: true },                                // NRG Stadium, Houston
  '3946': { lat: 31.7686, lon: -106.5054, dome: false }, // Sun Bowl, El Paso
  '3970': { dome: true },                                // State Farm Stadium, Glendale
  '3971': { lat: 35.0669, lon: -106.6287, dome: false }, // University Stadium, Albuquerque
  '3974': { lat: 34.3617, lon: -89.5342, dome: false },  // Vaught-Hemingway Stadium, Oxford
  '4102': { lat: 40.8296, lon: -73.9262, dome: false },  // Yankee Stadium, Bronx
  '4245': { lat: 42.3467, lon: -71.0972, dome: false },  // Fenway Park, Boston
  '4251': { dome: true },                                // Chase Field, Phoenix
  '6501': { dome: true },                                // Allegiant Stadium, Las Vegas
  '6526': { lat: 30.6870, lon: -88.1839, dome: false },  // Hancock Whitney Stadium, Mobile
  '7065': { lat: 33.9535, lon: -118.3392, dome: false }, // SoFi Stadium, Inglewood (open sides)
  '7220': { lat: 21.2983, lon: -157.8163, dome: false }, // Ching Complex, Honolulu
  '7221': { lat: 33.5265, lon: -86.8094, dome: false },  // Protective Stadium, Birmingham
  '7311': { lat: 32.7834, lon: -117.1191, dome: false }, // Snapdragon Stadium, San Diego
};

// Build the current bowl-season postseason slate (bowls + CFP). Pass `season` to target a
// specific year (e.g. testing against a completed season).
export function buildCfbBowl({ season } = {}) {
  const yr = season ?? currentBowlSeason();
  return buildPickem({
    leaguePath: 'football/college-football',
    scoreboardUrl: `${SB}?seasontype=3&dates=${yr}&limit=200`,
    injuriesUrl: INJ,
    includeEvent: (comp) => !isFcs(comp) && hasRealTeams(comp),
    nameOf: bowlNameOf,
    coordsFor: (comp) => BOWL_VENUES[String(comp.venue?.id)] || CFB_VENUES[String(comp.venue?.id)] || null,
  });
}
