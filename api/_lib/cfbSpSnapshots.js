// Prospective observations only. No provider client: the cron supplies its existing
// SP+ response and slate. A weekly record is immutable, never backfilled from history.
export const SP_SNAPSHOT_VERSION = 1;
export const spSnapshotKey = ({ season, seasonType, week }) =>
  `ratings:cfb:sp:snapshot:v${SP_SNAPSHOT_VERSION}:${season}:${seasonType}:${week}`;

export function makeSpSnapshot({ observation, ratings, feed, now = Date.now() }) {
  const season = feed?.season, seasonType = feed?.seasonType, week = feed?.week;
  if (!Number.isInteger(season) || season < 2000 || ![2, 3].includes(seasonType)
    || !Number.isInteger(week) || week < 1 || week > 30) return null;
  const observed = Date.parse(observation?.observedAt);
  // Never re-label a cached/prior-season response as this week's observation.
  if (!observation || observation.basis !== 'season' || observation.season !== season
    || ratings?.basis !== 'season' || ratings.season !== season
    || !Number.isFinite(observed) || observed > now || now - observed > 6 * 3600000) return null;
  const rows = observation.rows;
  if (!Array.isArray(rows) || rows.filter(r => r?.team && Number.isFinite(r.rating)).length < 20
    || rows.some(r => r?.year != null && Number(r.year) !== season)
    || !Object.keys(ratings.teams || {}).length || !Object.keys(ratings.crosswalk || {}).length) return null;
  const games = (feed.games || []).filter(g => g.state === 'pre' && Date.parse(g.date) > now
    && g.id != null && g.home?.id != null && g.away?.id != null).map(g => ({
    id: String(g.id), kickoffAt: g.date, homeEspnId: String(g.home.id), awayEspnId: String(g.away.id),
    neutralSite: g.neutralSite === true,
    // Keep the observed market convention explicit; don't invert it like nflverse.
    homeSpread: Number.isFinite(g.odds?.spread) ? g.odds.spread : null,
  }));
  if (!games.length) return null; // no claim of pregame evidence for a finished slate
  return {
    schemaVersion: SP_SNAPSHOT_VERSION, season, seasonType, week,
    source: 'cfbd:/ratings/sp', sourceSeason: observation.season,
    observedAt: observation.observedAt, recordedAt: new Date(now).toISOString(),
    sourcePublishedAt: null, // CFBD response has no reliable publication/week timestamp
    rawSp: structuredClone(rows),
    ratings: { version: ratings.v, builtAt: ratings.builtAt, homeField: ratings.homeField,
      teams: structuredClone(ratings.teams), crosswalk: structuredClone(ratings.crosswalk) },
    games, spreadConvention: 'home handicap: negative means home favored',
    validation: { kind: 'prospective-observation', qualifiedPregameOnly: true,
      showWinProb: false, showDisagreement: false },
  };
}

export async function recordSpSnapshot(redis, input) {
  const snapshot = makeSpSnapshot(input);
  if (!snapshot) return { status: 'skipped', reason: 'no_fresh_current_pregame_observation' };
  const key = spSnapshotKey(snapshot);
  // Redis SET NX is atomic across overlapping daily cron runs. No TTL: history
  // must survive the season. A later, more-informed SP+ response never replaces it.
  const stored = await redis.set(key, snapshot, { nx: true });
  return { status: stored ? 'stored' : 'already_exists', key,
    ...(stored ? { games: snapshot.games.length, observedAt: snapshot.observedAt } : {}) };
}
