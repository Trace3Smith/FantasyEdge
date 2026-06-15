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
// Persistent Phase 2 state, survives the daily dataset rebuild:
//   PROSPECT_STATE_KEY — per-player prospect record (milb lines, synopsis cache,
//     event-detection snapshot) + the last good FanGraphs board for graceful degrade.
//   XWALK_KEY — cached FanGraphs playerId -> MLBAM id crosswalk (Chadwick-derived).
export const PROSPECT_STATE_KEY = 'prospects:mlb';
export const XWALK_KEY = 'xwalk:fg_mlbam';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
