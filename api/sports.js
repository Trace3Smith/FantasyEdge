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
  // MLB has no build-version (its cold-start build skips prospect enrichment), so it rebuilds
  // on a missing roto value (zTotal) — needed by the draft board — rather than a version bump.
  mlb: { key: DATASET_KEY, build: () => buildDataset({ season: new Date().getFullYear() }), needsValue: true },
  nba: { key: NBA_DATASET_KEY, build: () => buildNbaDataset(), version: DATASET_VERSION },
  wnba: { key: WNBA_DATASET_KEY, build: () => buildWnbaDataset(), version: DATASET_VERSION },
  nhl: { key: NHL_DATASET_KEY, build: () => buildNhlDataset(), version: DATASET_VERSION },
  nfl: { key: NFL_DATASET_KEY, build: () => buildNflDataset(), version: DATASET_VERSION },
  pga: { key: PGA_DATASET_KEY, build: () => buildPgaDataset(), version: DATASET_VERSION, premium: true },
};

// LIV Golf players don't play PGA Tour events, so they carry no strokes-gained data
// and clutter the weekly DFS board — but at the majors they're in the field with
// everyone else. Instead of a manual switch, let the live ESPN tournament field
// decide: a LIV player shows only when they actually appear in the current event's
// field (p.inField, set in buildPgaDataset from the ESPN scoreboard). Non-LIV players
// are never filtered. Serve-time off the cached dataset; the field refreshes with the
// daily rebuild. Kept players are renumbered 1..N so there are no rank gaps where
// filtered LIV names were.
function filterLivByField(players) {
  return players
    .filter((p) => p.team !== 'LIV' || p.inField)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

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

    // Rebuild on a cold start (missing/evicted key), a stale build version, or — for MLB — a
    // dataset that predates the draft-board roto value (no ranked player carries zTotal yet).
    const stale = !dataset || !dataset.players
      || (cfg.version != null && dataset.version !== cfg.version)
      || (cfg.needsValue && !dataset.players.some((p) => !p.searchOnly && typeof p.zTotal === 'number'));
    if (stale) {
      dataset = await cfg.build();
      if (cfg.version != null) dataset.version = cfg.version;
      await redis.set(cfg.key, dataset);
    }

    const players = sport === 'pga' ? filterLivByField(dataset.players) : dataset.players;

    return res.json({
      players,
      sport,
      builtAt: dataset.builtAt,
      // ADP-specific freshness (NFL only; null elsewhere). This is the scrape/fetch time,
      // which can lag dataset.builtAt on a graceful-degrade day — so it's the honest
      // "ADP last updated" signal for the draft board.
      adpBuiltAt: dataset.counts?.adp?.builtAt ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, players: [] });
  }
}
