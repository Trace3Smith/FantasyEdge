// Daily refresh cron (scheduled in vercel.json). Rebuilds the combined MLB
// dataset from the MLB Stats API and writes it to Redis so request handlers
// serve from cache with zero upstream calls.
//
// Protected by CRON_SECRET: Vercel Cron sends `Authorization: Bearer <secret>`
// when the CRON_SECRET env var is set, so unauthenticated calls are rejected.
import { buildDataset } from '../_lib/buildDataset.js';
import { redis, DATASET_KEY } from '../_lib/kv.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dataset = await buildDataset({ season: new Date().getFullYear() });
    await redis.set(DATASET_KEY, dataset);
    return res.status(200).json({ ok: true, builtAt: dataset.builtAt, counts: dataset.counts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
