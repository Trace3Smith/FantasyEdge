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
export const DATASET_VERSION = 8;
// Persistent Phase 2 state, survives the daily dataset rebuild:
//   PROSPECT_STATE_KEY — per-player prospect record (milb lines, synopsis cache,
//     event-detection snapshot) + the last good FanGraphs board for graceful degrade.
//   XWALK_KEY — cached FanGraphs playerId -> MLBAM id crosswalk (Chadwick-derived).
export const PROSPECT_STATE_KEY = 'prospects:mlb';
export const XWALK_KEY = 'xwalk:fg_mlbam';
// FantasyPros consensus NFL projections (raw scrape), refreshed by the daily cron and
// merged onto the NFL dataset. Persisted separately so a failed scrape degrades to the
// last good projections instead of dropping them.
export const PROJECTIONS_KEY = 'projections:nfl';
// NFL consensus ADP (PPR + Standard + native Half-PPR) from the Fantasy Football
// Calculator free API, refreshed by the daily cron and merged onto the NFL dataset.
// Drives realistic mock-draft opponents and the falling-value boost in the
// recommendation engine. Persisted separately for graceful degrade.
export const ADP_KEY = 'adp:nfl';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
