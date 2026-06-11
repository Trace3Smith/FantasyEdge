// Request handler for the rankings/search data. Serves the combined dataset
// from Redis (written by the daily api/cron/refresh job) so requests make zero
// upstream MLB calls. On a cache miss — first deploy before the cron has run, or
// an evicted key — it builds the dataset inline once, backfills the cache, and
// serves it, so the endpoint self-heals.
import { buildDataset } from './_lib/buildDataset.js';
import { redis, DATASET_KEY } from './_lib/kv.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const sport = req.query.sport || 'mlb';

  // Only MLB is backed by the dataset today; other sports return empty.
  if (sport !== 'mlb') {
    return res.json({ players: [], sport });
  }

  try {
    let dataset = await redis.get(DATASET_KEY);

    if (!dataset || !dataset.players) {
      // Cold start: build once and backfill the cache for the next request.
      dataset = await buildDataset({ season: new Date().getFullYear() });
      await redis.set(DATASET_KEY, dataset);
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
