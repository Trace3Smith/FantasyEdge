// CFB Week Pick'em — the current regular-season week's college-football games, as the weekly
// counterpart to the postseason Bowl feed (cfbBowl.js). Reuses the shared football Pick'em pipeline
// (api/_lib/pickem.js): same market-implied pick + win% (from the DraftKings line), Market % per
// side, injuries, and upset flags as NFL Pick'em.
//
// The ESPN college-football scoreboard returns ~99 games/week across every division — far too many
// — so this feed keeps only games involving a Top-25 (AP/CFP-ranked) team, the handful that matter.
// Ranked status is ESPN's per-competitor `curatedRank.current` (1-25 ranked; 99 = unranked). Before
// the season's first poll (~mid-August) nothing is ranked, so the feed is simply empty — the UI then
// says to check back in season, exactly like the Bowl feed does out of bowl season.
//
// Weather is intentionally omitted here (FBS has 130+ home stadiums; no coordinate table like the
// NFL/bowl feeds) — a bounded follow-up if wanted. Injuries reuse the CFB injuries endpoint.
import { buildPickem, winProbFromSpread } from './pickem.js';

export { winProbFromSpread };

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const SB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const INJ = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/injuries';

// Keep a game only if at least one team is AP/CFP Top-25. ESPN marks unranked teams as rank 99.
function hasRankedTeam(comp) {
  return (comp.competitors || []).some((t) => {
    const r = t.curatedRank?.current;
    return typeof r === 'number' && r >= 1 && r <= 25;
  });
}

// Build the current/upcoming CFB week's ranked slate (pass `week` to target a specific one).
export function buildCfbWeek({ week } = {}) {
  return buildPickem({
    scoreboardUrl: week ? `${SB}?week=${encodeURIComponent(week)}` : SB,
    injuriesUrl: INJ,
    includeEvent: (comp) => hasRankedTeam(comp),
    coordsFor: () => null, // no CFB stadium coordinate table → weather omitted for this feed
  });
}
