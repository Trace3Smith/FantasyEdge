// Shared Redis (Upstash) client + dataset key, used by the refresh cron and the
// request handler. Vercel's Marketplace Redis integration injects the connection
// env vars; we accept both the KV_* names (Vercel's compatibility prefix) and the
// UPSTASH_* names so either integration setup works.
import { Redis } from '@upstash/redis';

export const DATASET_KEY = 'dataset:mlb';
export const NBA_DATASET_KEY = 'dataset:nba';
export const WNBA_DATASET_KEY = 'dataset:wnba';
export const NHL_DATASET_KEY = 'dataset:nhl';
export const NFL_DATASET_KEY = 'dataset:nfl';
export const PGA_DATASET_KEY = 'dataset:pga';
// Build-schema version for the ESPN sports (nba/wnba/nhl/nfl). Bump this whenever
// a builder's output changes shape or logic: the request handler treats a cached
// dataset whose version doesn't match as a miss and rebuilds it on the next
// request, so a deploy self-heals immediately instead of waiting for the cron.
// MLB is intentionally exempt (its cold-start build skips prospect enrichment, so
// we don't want a version bump to drop Phase 2 data between cron runs).
export const DATASET_VERSION = 11;
// Persistent Phase 2 state, survives the daily dataset rebuild:
//   PROSPECT_STATE_KEY — per-player prospect record (milb lines, synopsis cache,
//     event-detection snapshot) + the last good FanGraphs board for graceful degrade.
//   XWALK_KEY — cached FanGraphs playerId -> MLBAM id crosswalk (Chadwick-derived).
export const PROSPECT_STATE_KEY = 'prospects:mlb';
export const XWALK_KEY = 'xwalk:fg_mlbam';
// Consensus NFL projections from Sleeper (season-long), refreshed by the daily cron and
// merged onto the NFL dataset. Persisted separately so a failed pull degrades to the
// last good projections instead of dropping them.
export const PROJECTIONS_KEY = 'projections:nfl';
// NFL consensus ADP (PPR + Standard + native Half-PPR) from the Fantasy Football
// Calculator free API, refreshed by the daily cron and merged onto the NFL dataset.
// Drives realistic mock-draft opponents and the falling-value boost in the
// recommendation engine. Persisted separately for graceful degrade.
export const ADP_KEY = 'adp:nfl';
// Distilled team statistics for ONE COMPLETED season of one league, keyed by team id:
// { teams: { [id]: { abbr, gamesPlayed, offense, defense } }, count, rated }. Built from ESPN's
// statistics/byteam leaderboard (see teamReport.js) and cached WITHOUT expiry on purpose — a
// finished season's numbers never change again, so this is fetched once per league per season
// and then read for free for the rest of the year. Only ever written for a season strictly
// before the current one; the in-progress season moves weekly and is always fetched live.
export const byteamKey = (leaguePath, season) => `byteam:${leaguePath}:${season}`;

// NWS gridpoint lookup for one coordinate: api.weather.gov/points/{lat},{lon} resolves a
// coordinate to the hourly-forecast URL for its grid cell, and that mapping is a property of the
// coordinate, not of the weather — the same point returns the same URL every time. Caching it
// halves the calls a forecast costs (two round-trips become one) and makes a serve-time refresh
// cheap enough to run on a request. Given a long TTL rather than none: NWS does occasionally
// re-grid a forecast office, and a stale URL would quietly stop resolving.
export const nwsGridKey = (lat, lon) => `nws:grid:${lat},${lon}`;
export const NWS_GRID_TTL = 90 * 24 * 3600; // 90 days

// Single-flight guard for the serve-time weather top-up, one per Pick'em feed. Held for the
// length of the top-up interval so a burst of concurrent requests refreshes once, not once each,
// and a public URL can never be used to drive repeated upstream fetches.
export const wxCooldownKey = (feedKey) => `wx:cooldown:${feedKey}`;

// One completed game's trimmed box score, keyed by league and ESPN event id. Written without
// expiry on purpose: a finished game's stat line never changes again, so this is fetched once per
// game ever and read for free thereafter. Only FINAL games are stored — see boxScore.js.
export const boxScoreKey = (leaguePath, id) => `box:${leaguePath}:${id}`;

// NFL Pick'em weekly feed (Brackets & Bowls) — games + market-implied picks, injuries, and
// outdoor weather, built daily by the refresh cron from free ESPN + NWS sources and served
// via api/sports.js (?feed=nfl-pickem). Cached so requests make zero upstream calls.
export const NFL_PICKEM_KEY = 'pickem:nfl';
// CFB Bowl / Playoff Pick'em feed (Brackets & Bowls) — postseason bowl + CFP slate with
// market-implied picks, injuries, and weather, built daily from the same free ESPN + NWS
// sources as NFL and served via api/sports.js (?feed=cfb-bowl). Empty out of bowl season.
export const CFB_BOWL_KEY = 'pickem:cfb';
// CFB Week Pick'em feed (Brackets & Bowls) — the current regular-season week's Top-25 (ranked)
// college-football games, built from the same ESPN scoreboard pipeline as NFL Pick'em and served
// via api/sports.js (?feed=cfb-week). Empty before the poll drops (~mid-August) and out of season.
export const CFB_WEEK_KEY = 'pickem:cfbweek';
// March Madness bracket optimizer feed (Brackets & Bowls, premium) — the full men's tournament
// bracket with per-game model picks, round-by-round advancement probabilities, national title
// odds, and a recommended optimal fill. Built daily from free ESPN sources (scoreboard field +
// BPI) and served via api/sports.js (?feed=march-madness), premium-gated. Empty out of season
// (the field only exists ~3 weeks each March).
export const MM_KEY = 'bracket:mm';
// Batter-vs-pitcher career lines, keyed by batter id, for the day's probable-pitcher
// matchups. Built day-of by the autopilot cron (probable starters aren't named until the
// morning), stored separately from the MLB dataset so it never read-modify-writes the key
// the refresh cron owns. Served via api/sports.js for display; read in-run by the start-sit
// logic. Shape: { date, builtAt, batters: { [id]: { oppSp:{id,name}, line:{ab,h,hr,rbi,avg,ops} } } }.
export const BVP_KEY = 'bvp:mlb';
// NHL day-of opponent-defense matchup (the BvP analog for hockey), keyed by team abbrev. Built by the
// daily refresh cron from free NHL APIs (schedule + team-defense ranks), stored separately from the NHL
// dataset. Empty out of season / on off-days. Shape: { date, builtAt, rated, teams: { [abbrev]: { opp,
// isHome, oppGaRank, oppPkRank, lean, reason } } }. Starting-goalie confirmation is deferred (the free
// API doesn't reliably expose pre-game starters) — this carries opponent-defense context only.
export const NHL_MATCHUP_KEY = 'matchup:nhl';
// NBA/WNBA day-of opponent matchup (the BvP analog for basketball), keyed by team abbrev. Built by the
// daily refresh cron from free ESPN feeds (schedule + derived opponent points-allowed & pace ranks),
// stored per league separately from the datasets. Empty out of season / on off-days. Shape mirrors the
// NHL key: { date, sport, builtAt, rated, teams: { [abbrev]: { opp, isHome, oppDefRank, oppPaceRank,
// lean, reason } } }.
export const NBA_MATCHUP_KEY = 'matchup:nba';
export const WNBA_MATCHUP_KEY = 'matchup:wnba';
// NFL defense-vs-position (DvP), keyed by team abbrev = the DvP of the opponent that team faces THIS WEEK.
// DERIVED by aggregating game box scores (ESPN exposes no ready-made pass/rush yards-allowed splits), so
// it's the heaviest matchup builder; the cron rebuilds it ~weekly (a freshness guard skips daily rebuilds).
// Empty out of season. Shape: { season, week, builtAt, rated, teams: { [abbrev]: { opp, isHome,
// oppPassYdsAllowed, oppPassDRank, oppRushYdsAllowed, oppRushDRank, n } }, dvp: {…ranks table…} }.
export const NFL_DVP_KEY = 'matchup:nfl-dvp';
// Player-synopsis cache (Phase 0). One record per (sport, player): { fp, text, generatedAt, model }.
// Generated on demand and invalidated by a signal FINGERPRINT, so a player's report regenerates only
// when the inputs that matter (rank tier, form, projection, matchup, …) actually change — keeping
// Anthropic spend proportional to change, not to roster size. Keyed per player, separate from the
// daily datasets so it survives the rebuild and never read-modify-writes a dataset key.
export const synopsisKey = (sport, id) => `synopsis:${sport}:${id}`;

// Whether Redis is actually wired up. Worth knowing before calling it on a hot path: the client
// RETRIES internally, so a command with no credentials (local dev) or against an unreachable
// server costs ~4.3 SECONDS before it throws. Anything that would issue one call per item — the
// per-venue gridpoint cache, say — has to check this first, or a Redis outage turns a build that
// took eight seconds into one that takes two minutes and blows the cron budget.
export const redisConfigured = Boolean(
  (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL)
  && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN),
);

export const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
