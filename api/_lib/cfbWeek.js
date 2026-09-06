// CFB Week Pick'em — the current regular-season week's college-football games, as the weekly
// counterpart to the postseason Bowl feed (cfbBowl.js). Reuses the shared football Pick'em pipeline
// (api/_lib/pickem.js): same market-implied pick + win% (from the DraftKings line), Market % per
// side, injuries, and upset flags as NFL Pick'em.
//
// FULL FBS, not just the ranked slate. This used to keep only games involving a Top-25 team,
// because the default scoreboard returns every division and ~99 games was too many to build. It is
// now the whole FBS field (`groups=80`, ESPN's FBS group) — a Southern Miss vs North Texas game is
// a real pick'em game whether or not either side is ranked. Top 25 and per-conference are FILTERS
// the page applies over this one payload, not separate builds, so the cost below is paid once.
//
// What that costs, measured on an 86-game week: ~12s to build (it was 51s until the weather fetch
// was made concurrent — that was the blocker), 252KB of payload, and 172 team reports. Games where
// an FBS side hosts an FCS opponent are kept, since they are real games; the FCS side simply has no
// entry in ESPN's FBS stat leaderboard and its panel says so.
//
// Ranked status is ESPN's per-competitor `curatedRank.current` (1-25 ranked; 99 = unranked), which
// now rides along on each team so the page can offer the Top-25 view.
//
// Weather comes from the generated FBS stadium table (cfbVenues.js) — ESPN publishes no
// coordinates, so it is built by `node scripts/gen-cfb-venues.mjs` from venue zip codes and
// committed. Injuries reuse the CFB injuries endpoint.
import { buildPickem, winProbFromSpread } from './pickem.js';
import { CFB_VENUES } from './cfbVenues.js';

export { winProbFromSpread };

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const SB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const INJ = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/injuries';

// ESPN's FBS conference ids, for the page's per-conference filter. Stable across seasons; sourced
// from the college-football standings endpoint, which groups the FBS field into exactly these.
export const CFB_CONFERENCES = {
  1: 'ACC', 4: 'Big 12', 5: 'Big Ten', 8: 'SEC', 9: 'Pac-12', 12: 'CUSA',
  15: 'MAC', 17: 'Mountain West', 18: 'FBS Independents', 37: 'Sun Belt', 151: 'American',
};

// groups=80 is the FBS group, and limit is required with it: without `groups` the scoreboard
// answers with a featured subset (25 games in a week that actually had 99), which would look like a
// working feed and quietly be missing three quarters of the slate.
const FBS = 'groups=80&limit=400';

// Build the current/upcoming CFB week's full FBS slate (pass `week` to target a specific one).
export function buildCfbWeek({ week } = {}) {
  return buildPickem({
    leaguePath: 'football/college-football',
    scoreboardUrl: week ? `${SB}?${FBS}&week=${encodeURIComponent(week)}` : `${SB}?${FBS}`,
    injuriesUrl: INJ,
    // A venue missing from the table (a new build, a rare off-campus site, anywhere outside the
    // US) resolves to null and simply gets no weather — the same graceful degrade as the bowls.
    coordsFor: (comp) => CFB_VENUES[String(comp.venue?.id)] || null,
  });
}
