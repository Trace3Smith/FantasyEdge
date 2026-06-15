// Request handler for the rankings/search data. Serves the combined dataset
// from Redis (written by the daily api/cron/refresh job) so requests make zero
// upstream MLB calls. On a cache miss — first deploy before the cron has run, or
// an evicted key — it builds the dataset inline once, backfills the cache, and
// serves it, so the endpoint self-heals.
import { buildDataset } from './_lib/buildDataset.js';
import { buildNbaDataset, buildWnbaDataset } from './_lib/buildNbaDataset.js';
import { buildNhlDataset } from './_lib/buildNhlDataset.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY } from './_lib/kv.js';

// Per-sport dataset wiring: which KV key holds it and how to (re)build it on a
// cold-start cache miss. Add a sport here + a frontend tab to light it up.
const SPORTS = {
  mlb: { key: DATASET_KEY, build: () => buildDataset({ season: new Date().getFullYear() }) },
  nba: { key: NBA_DATASET_KEY, build: () => buildNbaDataset() },
  wnba: { key: WNBA_DATASET_KEY, build: () => buildWnbaDataset() },
  nhl: { key: NHL_DATASET_KEY, build: () => buildNhlDataset() },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const sport = req.query.sport || 'mlb';
  const cfg = SPORTS[sport];

  // Unknown sport (no dataset wired): return empty rather than erroring.
  if (!cfg) {
    return res.json({ players: [], sport });
  }

  try {
    let dataset = await redis.get(cfg.key);

    if (!dataset || !dataset.players) {
      // Cold start: build once and backfill the cache for the next request.
      dataset = await cfg.build();
      await redis.set(cfg.key, dataset);
    }

    return res.json({
      players: dataset.players,
      sport,
      builtAt: dataset.builtAt,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, players: [] });
  }
}
