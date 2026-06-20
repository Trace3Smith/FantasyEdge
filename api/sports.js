// Request handler for the rankings/search data. Serves the combined dataset
// from Redis (written by the daily api/cron/refresh job) so requests make zero
// upstream MLB calls. On a cache miss — first deploy before the cron has run, or
// an evicted key — it builds the dataset inline once, backfills the cache, and
// serves it, so the endpoint self-heals.
import { buildDataset } from './_lib/buildDataset.js';
import { buildNbaDataset, buildWnbaDataset } from './_lib/buildNbaDataset.js';
import { buildNhlDataset } from './_lib/buildNhlDataset.js';
import { buildNflDataset } from './_lib/buildNflDataset.js';
import { buildPgaDataset } from './_lib/buildPgaDataset.js';
import { requirePremium, sendError } from './_lib/auth.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY, DATASET_VERSION } from './_lib/kv.js';

// Per-sport dataset wiring: which KV key holds it and how to (re)build it on a
// cold-start cache miss. Add a sport here + a frontend tab to light it up. A
// `version` makes the cache version-aware: a cached dataset whose version doesn't
// match is treated as a miss and rebuilt, so a deploy self-heals on the next
// request. MLB has no version (existence check only — preserves cron enrichment).
const SPORTS = {
  mlb: { key: DATASET_KEY, build: () => buildDataset({ season: new Date().getFullYear() }) },
  nba: { key: NBA_DATASET_KEY, build: () => buildNbaDataset(), version: DATASET_VERSION },
  wnba: { key: WNBA_DATASET_KEY, build: () => buildWnbaDataset(), version: DATASET_VERSION },
  nhl: { key: NHL_DATASET_KEY, build: () => buildNhlDataset(), version: DATASET_VERSION },
  nfl: { key: NFL_DATASET_KEY, build: () => buildNflDataset(), version: DATASET_VERSION },
  pga: { key: PGA_DATASET_KEY, build: () => buildPgaDataset(), version: DATASET_VERSION, premium: true },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const sport = req.query.sport || 'mlb';
  const cfg = SPORTS[sport];

  // Unknown sport (no dataset wired): return empty rather than erroring.
  if (!cfg) {
    return res.json({ players: [], sport });
  }

  // Premium-gated sports re-verify the Clerk session + plan server-side — the UI
  // lock is cosmetic; this is the trust boundary. Anonymous/free requests get 401/403
  // before any data is built or served.
  if (cfg.premium) {
    try {
      await requirePremium(req);
    } catch (err) {
      return sendError(res, err);
    }
  }

  try {
    let dataset = await redis.get(cfg.key);

    // Rebuild on a cold start (missing/evicted key) or a stale build version.
    const stale = !dataset || !dataset.players || (cfg.version != null && dataset.version !== cfg.version);
    if (stale) {
      dataset = await cfg.build();
      if (cfg.version != null) dataset.version = cfg.version;
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
