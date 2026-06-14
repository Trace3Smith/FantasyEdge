// Daily refresh cron (scheduled in vercel.json). Rebuilds the combined MLB
// dataset from the MLB Stats API and writes it to Redis so request handlers
// serve from cache with zero upstream calls.
//
// Protected by CRON_SECRET: Vercel Cron sends `Authorization: Bearer <secret>`
// when the CRON_SECRET env var is set, so unauthenticated calls are rejected.
import { buildDataset } from '../_lib/buildDataset.js';
import { buildNbaDataset } from '../_lib/buildNbaDataset.js';
import { enrichProspects } from '../_lib/enrichProspects.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY } from '../_lib/kv.js';

// Vercel Hobby caps a function at 60s (and defaults to 10s if unset), so we ask
// for the full 60. The Phase 2 enrichment stays within that budget by generating
// synopses in small per-run batches (see FIRST_SYNOPSIS_BATCH in enrichProspects):
// the ~234-prospect backlog drains over several daily runs rather than in one.
export const maxDuration = 60;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const season = new Date().getFullYear();
    const dataset = await buildDataset({ season });
    // Phase 2: bolt on prospect MiLB stats + AI synopsis (hitters). Additive and
    // failure-tolerant — if it throws, we still serve the Phase 1 dataset.
    try {
      await enrichProspects(dataset, { season }, redis);
    } catch (err) {
      dataset.counts = { ...dataset.counts, prospectsError: err.message };
    }
    await redis.set(DATASET_KEY, dataset);

    // NBA dataset — independent of MLB; a failure here must not drop the MLB
    // write above. Built fresh each run from ESPN (no prospects/enrichment).
    let nbaCounts = null;
    try {
      const nba = await buildNbaDataset();
      await redis.set(NBA_DATASET_KEY, nba);
      nbaCounts = nba.counts;
    } catch (err) {
      nbaCounts = { error: err.message };
    }

    return res.status(200).json({
      ok: true,
      builtAt: dataset.builtAt,
      counts: dataset.counts,
      nba: nbaCounts,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
