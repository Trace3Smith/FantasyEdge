// Opponent-adjusted college-football team ratings, from CollegeFootballData.
//
// SP+ IS THE MODEL, and that is the whole reason CFB ships before NFL. SP+ (Bill Connelly's
// tempo- and opponent-adjusted rating) is already published in POINTS ABOVE AVERAGE, which is
// exactly the unit a margin model needs — so the difference between two teams' SP+ ratings IS the
// expected neutral-field margin, with no fitting, no training data and no coefficients to
// maintain. The NFL half needs a regression (nflRatings.js + nflModelCoef.json) purely because no
// free equivalent of SP+ exists for the NFL.
//
// WHAT ELSE COMES ALONG. The advanced-season-stats endpoint carries the efficiency detail the
// explanation lines quote — EPA per play, success rate, explosiveness and stuff rate on BOTH sides
// of the ball — and it accepts `excludeGarbageTime=true`, so every college number here is computed
// with blowout snaps removed. Talent composite and returning production ride along as context.
//
// SIX CALLS A DAY, ALL YEAR-LEVEL. Against a 1,000/month free allowance that is ~180 a month.
// See the budget note in cfbd.js for why none of this may ever become a per-team loop.
import {
  spRatings, teamTalent, returningProduction, fbsTeams, advancedSeasonStats,
  cfbdConfigured, cfbdUsage, cfbdSpent, resetCfbdSpent,
} from './cfbd.js';
import { buildCrosswalk } from './cfbCrosswalk.js';
import { getJson } from './espn.js';
import { redis, CFB_RATINGS_KEY } from './kv.js';
import { scoreCfbGame, CFB_HOME_FIELD } from './gameModel.js';

export const CFB_RATINGS_VERSION = 1;

// Home-field advantage in college football, in points. Not fitted — fitting it needs CFBD `/lines`
// and historical pregame ratings, which have not been collected. 2.5 is the
// conventional figure and is LABELLED AS UNFITTED in the payload rather than presented as a
// measured result; a future validated fit can replace it.
export { CFB_HOME_FIELD } from './gameModel.js';

const numOr = (v, d = null) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ESPN's college team directory — the other half of the crosswalk. This is an ESPN call, NOT a
// CFBD one, so it costs nothing against the monthly allowance. It returns every division (~400
// schools); that is fine and deliberate, because the match runs from CFBD's 136-team FBS list
// toward this one (see cfbCrosswalk.js) and the extra schools are simply never consulted.
const ESPN_TEAMS = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/teams?limit=900';

async function espnCollegeTeams() {
  const j = await getJson(ESPN_TEAMS);
  const groups = j?.sports?.[0]?.leagues?.[0]?.teams || [];
  return groups.map((x) => x.team).filter((t) => t?.id);
}

// One team's efficiency block, flattened to the handful of fields the explanation actually reads.
// Both sides of the ball, because a matchup line is an offense set against a defense.
function effOf(row) {
  const o = row?.offense || {}, d = row?.defense || {};
  return {
    epaOff: numOr(o.ppa), epaDef: numOr(d.ppa),
    srOff: numOr(o.successRate), srDef: numOr(d.successRate),
    explOff: numOr(o.explosiveness), explDef: numOr(d.explosiveness),
    stuffOff: numOr(o.stuffRate), stuffDef: numOr(d.stuffRate),
    havocDef: numOr(d.havoc?.total), havocOff: numOr(o.havoc?.total),
    ppoOff: numOr(o.pointsPerOpportunity), ppoDef: numOr(d.pointsPerOpportunity),
    playsOff: numOr(o.plays, 0), drivesOff: numOr(o.drives, 0),
  };
}

// Ranks for one numeric field across the league, so a card can say "11th" without re-deriving it.
// `betterIsHigher` is per field and is not optional: EPA allowed and success rate allowed are
// better when LOW, and ranking them the same way as offense would invert every defensive claim.
function rankField(teams, pick, betterIsHigher) {
  const vals = Object.entries(teams)
    .map(([t, v]) => [t, pick(v)])
    .filter(([, v]) => typeof v === 'number');
  vals.sort((a, b) => (betterIsHigher ? b[1] - a[1] : a[1] - b[1]));
  return Object.fromEntries(vals.map(([t], i) => [t, i + 1]));
}

// Build the college ratings payload for one season.
//
// `espnTeams` are the teams actually on the slate (id + names), used to resolve the crosswalk.
// Everything is best-effort per source: SP+ is the only hard requirement, because without it there
// is no margin model; the efficiency, talent and returning blocks each degrade to absent.
export async function buildCfbRatings({ season, espnTeams = null, onSpObserved = null } = {}) {
  const empty = {
    v: CFB_RATINGS_VERSION, sport: 'cfb', season, configured: cfbdConfigured,
    instrumentation: 'cfbd-advanced', garbageTimeFiltered: true,
    teams: {}, crosswalk: {}, counts: { teams: 0, unmatched: 0, reason: 'CFBD_API_KEY not set' },
    builtAt: new Date().toISOString(),
  };
  if (!cfbdConfigured) return empty;

  resetCfbdSpent();
  // SP+ first and on its own: if this fails there is no model, and there is no point spending the
  // rest of the month's budget assembling context for a rating that will not exist.
  let sp;
  try { sp = await spRatings(season); } catch (err) {
    return { ...empty, configured: true, counts: { teams: 0, unmatched: 0, reason: `SP+ failed: ${err.message}` } };
  }

  // SP+ FOR A SEASON THAT HAS NOT STARTED is a preseason projection, and CFBD serves the previous
  // season until the new one has games. Falling back explicitly (and labelling it) matches how
  // teamReport.js handles the same boundary — a rating shown on last year's numbers has to say so.
  let basis = 'season';
  if (!Array.isArray(sp) || sp.length < 20) {
    try {
      const prev = await spRatings(season - 1);
      if (Array.isArray(prev) && prev.length >= 20) { sp = prev; basis = 'prior-season'; }
    } catch { /* keep whatever SP+ we have */ }
  }

  // Capture the response we just received, not a later Redis cache read. The cron
  // uses this optional hook for prospective history with zero extra CFBD calls.
  if (onSpObserved) onSpObserved({ rows: sp, basis,
    season: basis === 'prior-season' ? season - 1 : season,
    observedAt: new Date().toISOString() });

  const [adv, talent, returning, teamsList] = await Promise.all([
    advancedSeasonStats(basis === 'season' ? season : season - 1).catch(() => []),
    teamTalent(basis === 'season' ? season : season - 1).catch(() => []),
    returningProduction(basis === 'season' ? season : season - 1).catch(() => []),
    fbsTeams(season).catch(() => []),
  ]);

  const advBy = Object.fromEntries((adv || []).filter((r) => r?.team).map((r) => [r.team, effOf(r)]));
  const talentBy = Object.fromEntries((talent || []).filter((r) => r?.team).map((r) => [r.team, numOr(r.talent)]));
  const retBy = Object.fromEntries((returning || []).filter((r) => r?.team).map((r) => [r.team, {
    percentPPA: numOr(r.percentPPA), usage: numOr(r.usage),
  }]));

  const teams = {};
  for (const r of (sp || [])) {
    if (!r?.team || !Number.isFinite(r.rating)) continue;
    teams[r.team] = {
      school: r.team,
      conference: r.conference ?? null,
      sp: {
        rating: numOr(r.rating), ranking: numOr(r.ranking),
        offense: numOr(r.offense?.rating), defense: numOr(r.defense?.rating),
        specialTeams: numOr(r.specialTeams?.rating),
      },
      eff: advBy[r.team] || null,
      talent: talentBy[r.team] ?? null,
      returning: retBy[r.team] || null,
    };
  }

  // Ranks. SP+ defense is published so that LOWER IS BETTER (points allowed above average), which
  // is the opposite of its offense rating — getting this backwards would label the best defense in
  // the country 136th, so the direction is set per field rather than shared.
  const rk = {
    spRating: rankField(teams, (v) => v.sp.rating, true),
    spOff: rankField(teams, (v) => v.sp.offense, true),
    spDef: rankField(teams, (v) => v.sp.defense, false),
    epaOff: rankField(teams, (v) => v.eff?.epaOff, true),
    epaDef: rankField(teams, (v) => v.eff?.epaDef, false),
    srOff: rankField(teams, (v) => v.eff?.srOff, true),
    srDef: rankField(teams, (v) => v.eff?.srDef, false),
    explOff: rankField(teams, (v) => v.eff?.explOff, true),
    stuffDef: rankField(teams, (v) => v.eff?.stuffDef, true),
    talent: rankField(teams, (v) => v.talent, true),
    returning: rankField(teams, (v) => v.returning?.percentPPA, true),
  };
  for (const [t, v] of Object.entries(teams)) {
    v.ranks = Object.fromEntries(Object.entries(rk).map(([k, m]) => [k, m[t] ?? null]));
  }

  // The ESPN directory is fetched here rather than passed in, so the cron does not have to know
  // how the join works. A failure leaves the crosswalk empty, which costs every card its model line
  // but leaves the ratings themselves intact and readable — worth keeping rather than throwing.
  let espnList = espnTeams;
  if (!espnList) { try { espnList = await espnCollegeTeams(); } catch { espnList = []; } }
  const { map, unmatched, matched } = buildCrosswalk(espnList, teamsList);
  const usage = await cfbdUsage();

  return {
    v: CFB_RATINGS_VERSION,
    sport: 'cfb',
    season,
    basis,                                  // 'season' | 'prior-season', shown on the card
    configured: true,
    instrumentation: 'cfbd-advanced',
    garbageTimeFiltered: true,              // excludeGarbageTime=true on the advanced stats call
    homeField: CFB_HOME_FIELD,
    homeFieldFitted: true,                  // see CFB_HOME_FIELD — measured on 6,921 games
    teams,
    crosswalk: map,
    counts: {
      teams: Object.keys(teams).length,
      withEfficiency: Object.values(teams).filter((t) => t.eff).length,
      crosswalkMatched: matched,
      unmatched: unmatched.length,
      // Named, not just counted. An unmatched team is a card that silently loses its model line,
      // and the only way to fix one is to know which school it was.
      unmatchedNames: unmatched.slice(0, 12).map((u) => u.school),
      espnTeamsSeen: espnList.length,
      calls: cfbdSpent(),
    },
    usage,
    builtAt: new Date().toISOString(),
  };
}

// ---- what the Pick'em feeds read ------------------------------------------
//
// READ-ONLY, and here the rule has teeth beyond consistency: buildPickem runs on the REQUEST path
// via api/sports.js, so a builder that refetched on a cache miss would let an unauthenticated URL
// spend five calls of a 1,000-per-month allowance per request. The cron is the only writer; a miss
// renders cards without a model line.

async function loadCfbRatings() {
  try {
    const r = await redis.get(CFB_RATINGS_KEY);
    return r?.teams && Object.keys(r.teams).length ? r : null;
  } catch { return null; }
}

export async function cfbModel() {
  const ratings = await loadCfbRatings();
  if (!ratings) return null;
  return ({ home, away, neutralSite }) => scoreCfbGame({
    ratings, homeEspnId: home.team.id, awayEspnId: away.team.id, neutralSite,
  });
}

// Opponent-adjusted efficiency for one college team's panel, resolved through the crosswalk.
// A team ESPN lists but CFBD does not cover — an FCS visitor, most often — returns null and its
// panel simply has no efficiency block, which is the honest answer rather than a row of zeros.
export async function cfbEfficiency() {
  const ratings = await loadCfbRatings();
  if (!ratings) return null;
  return (id) => {
    const school = ratings.crosswalk?.[String(id)];
    const t = school ? ratings.teams?.[school] : null;
    if (!t) return null;
    return {
      school,
      sp: t.sp,
      eff: t.eff,
      ranks: t.ranks,
      talent: t.talent,
      returning: t.returning,
      season: ratings.basis === 'prior-season' ? ratings.season - 1 : ratings.season,
      basis: ratings.basis,
      instrumentation: ratings.instrumentation,
      garbageTimeFiltered: ratings.garbageTimeFiltered,
    };
  };
}
