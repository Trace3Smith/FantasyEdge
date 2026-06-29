// Daily refresh cron (scheduled in vercel.json). Rebuilds the combined MLB
// dataset from the MLB Stats API and writes it to Redis so request handlers
// serve from cache with zero upstream calls.
//
// Protected by CRON_SECRET: Vercel Cron sends `Authorization: Bearer <secret>`
// when the CRON_SECRET env var is set, so unauthenticated calls are rejected.
import { buildDataset } from '../_lib/buildDataset.js';
import { buildNbaDataset, buildWnbaDataset } from '../_lib/buildNbaDataset.js';
import { buildNhlDataset } from '../_lib/buildNhlDataset.js';
import { buildNflDataset } from '../_lib/buildNflDataset.js';
import { buildPgaDataset } from '../_lib/buildPgaDataset.js';
import { enrichProspects } from '../_lib/enrichProspects.js';
import { enrichForm } from '../_lib/enrichForm.js';
import { enrichNflProjections } from '../_lib/fantasyProjections.js';
import { enrichNflAdp } from '../_lib/fantasyAdp.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY, DATASET_VERSION } from '../_lib/kv.js';

// Secondary sports (ESPN-sourced, no prospects/enrichment). Each is built and
// cached independently so one league's source failure can't drop another's
// write — nor the MLB write.
const SECONDARY = [
  { sport: 'nba', key: NBA_DATASET_KEY, build: buildNbaDataset },
  { sport: 'wnba', key: WNBA_DATASET_KEY, build: buildWnbaDataset },
  { sport: 'nhl', key: NHL_DATASET_KEY, build: buildNhlDataset },
  { sport: 'nfl', key: NFL_DATASET_KEY, build: buildNflDataset },
  // PGA: OWGR + ESPN golf. enrichForm is a no-op (golf has no gamelog); HOT/COLD is
  // computed inside the build from recent finishes.
  { sport: 'pga', key: PGA_DATASET_KEY, build: buildPgaDataset },
];

// Vercel Hobby caps a function at 60s (and defaults to 10s if unset), so we ask
// for the full 60. The Phase 2 enrichment stays within that budget by generating
// synopses in small per-run batches (see FIRST_SYNOPSIS_BATCH in enrichProspects):
// the ~234-prospect backlog drains over several daily runs rather than in one.
export const maxDuration = 60;

export default async function handler(req, res) {
  // Auth: the Bearer secret is the primary gate. Also accept Vercel's internal
  // cron header (set on scheduled invocations) so the dashboard "Run" button works
  // without the secret. NOTE: x-vercel-cron is a plain header (not cryptographically
  // verified), so the Bearer secret remains the real protection.
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;
  const vercelCron = req.headers['x-vercel-cron'];
  if (secret && authHeader !== `Bearer ${secret}` && !vercelCron) {
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
    // HOT/COLD recent-form badges (no-op out of season). Additive + failure-tolerant.
    try {
      await enrichForm(dataset, { sport: 'mlb', season });
    } catch (err) {
      dataset.counts = { ...dataset.counts, formError: err.message };
    }
    await redis.set(DATASET_KEY, dataset);

    const secondary = {};
    for (const s of SECONDARY) {
      try {
        const built = await s.build();
        try {
          await enrichForm(built, { sport: s.sport, season });
        } catch (err) {
          built.counts = { ...built.counts, formError: err.message };
        }
        // NFL: bolt on FantasyPros consensus projections for the draft cards.
        // Additive + failure-tolerant — falls back to the last good scrape in KV.
        if (s.sport === 'nfl') {
          try {
            await enrichNflProjections(built, redis);
          } catch (err) {
            built.counts = { ...built.counts, projError: err.message };
          }
          // ADP from the Fantasy Football Calculator free JSON API (PPR/Standard/Half).
          // Additive + failure-tolerant — falls back to the last good pull in KV.
          try {
            await enrichNflAdp(built, redis);
          } catch (err) {
            built.counts = { ...built.counts, adpError: err.message };
          }
        }
        built.version = DATASET_VERSION; // keep cache in sync with the handler's check
        await redis.set(s.key, built);
        secondary[s.sport] = built.counts;
      } catch (err) {
        secondary[s.sport] = { error: err.message };
      }
    }

    return res.status(200).json({
      ok: true,
      builtAt: dataset.builtAt,
      counts: dataset.counts,
      ...secondary,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
