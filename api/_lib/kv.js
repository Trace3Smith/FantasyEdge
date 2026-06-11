// Shared Redis (Upstash) client + dataset key, used by the refresh cron and the
// request handler. Vercel's Marketplace Redis integration injects the connection
// env vars; we accept both the KV_* names (Vercel's compatibility prefix) and the
// UPSTASH_* names so either integration setup works.
import { Redis } from '@upstash/redis';

export const DATASET_KEY = 'dataset:mlb';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
