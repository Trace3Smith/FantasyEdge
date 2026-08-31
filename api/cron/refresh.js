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
import { enrichRolling } from '../_lib/enrichRolling.js';
import { enrichRollingEspn } from '../_lib/enrichRollingEspn.js';
import { buildBvp } from '../_lib/enrichBvp.js';
import { buildNhlMatchup } from '../_lib/nhlMatchup.js';
import { buildNbaMatchup } from '../_lib/nbaMatchup.js';
import { buildNflDvp } from '../_lib/nflDvp.js';
import { enrichNflProjections } from '../_lib/fantasyProjections.js';
import { enrichNflAdp } from '../_lib/fantasyAdp.js';
import { enrichNflContext } from '../_lib/enrichNflContext.js';
import { enrichNflBlend } from '../_lib/nflBlend.js';
import { enrichNflConsistency } from '../_lib/enrichNflConsistency.js';
import { buildNflPickem } from '../_lib/nflPickem.js';
import { buildCfbBowl } from '../_lib/cfbBowl.js';
import { buildCfbWeek } from '../_lib/cfbWeek.js';
import { buildMarchMadness } from '../_lib/marchMadness.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY, NFL_PICKEM_KEY, CFB_BOWL_KEY, CFB_WEEK_KEY, MM_KEY, BVP_KEY, NHL_MATCHUP_KEY, NBA_MATCHUP_KEY, WNBA_MATCHUP_KEY, NFL_DVP_KEY, DATASET_VERSION } from '../_lib/kv.js';

// Per-league day-of matchup keys for the basketball leagues (built in the secondary loop below).
const HOOPS_MATCHUP_KEY = { nba: NBA_MATCHUP_KEY, wnba: WNBA_MATCHUP_KEY };

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

// With fluid compute Hobby allows 300s, not the 60s this previously assumed — that was
// the pre-fluid ceiling. This 300 is only legal WITH fluid (without it the build fails
// on a Hobby ceiling of 60), and fluid's default lives in a dashboard toggle that nothing
// in the repo can see — so vercel.json pins `"fluid": true`, which outranks the dashboard.
// Change one and the other has to follow.
//
// Take the full 300: this is a once-daily job billed on active CPU, and it spends nearly
// all its wall time waiting on I/O, so a higher ceiling buys headroom without buying
// compute.
//
// The work is bounded by its own batching rather than by this timeout: enrichProspects
// generates synopses FIRST_SYNOPSIS_BATCH at a time so the backlog drains over several
// runs. With 5x the budget that batch size is now the thing to raise if the backlog
// ever builds up again — not this number.
export const maxDuration = 300;

export default async function handler(req, res) {
  // Auth: the Bearer secret is the ONLY gate. Vercel sends `Authorization: Bearer <CRON_SECRET>`
  // automatically on every scheduled invocation once CRON_SECRET is set, so the scheduler needs
  // nothing else. Matches api/cron/autopilot.js and Vercel's documented pattern.
  //
  // `x-vercel-cron` is deliberately NOT accepted. It is a plain, client-settable header, and this
  // endpoint used to take it as a fallback so the dashboard "Run" button worked without the secret
  // — which meant anyone who knew the URL could kick off a 300s, six-sport rebuild at will with a
  // single header. That convenience is not worth leaving a mutating endpoint open; trigger manually
  // with the Bearer secret instead.
  //
  // Fail CLOSED when CRON_SECRET is unset: an unconfigured secret must not silently open the
  // endpoint. A 401 is a visible, debuggable misconfiguration; an open rebuild endpoint is not.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
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
    // Rolling last-15 / last-30 team-game splits, with each player's games vs his team's
    // as the playing-time signal. Five league-wide requests, no per-player fetches.
    // Additive + failure-tolerant, and a no-op out of season.
    try {
      await enrichRolling(dataset, { season });
    } catch (err) {
      dataset.counts = { ...dataset.counts, rollingError: err.message };
    }
    await redis.set(DATASET_KEY, dataset);

    // Batter-vs-pitcher lines for today's probable-pitcher matchups. Stored under its own
    // key (not on the dataset), so it's built AFTER the dataset write above and can't delay
    // it. Lives here rather than the autopilot cron so populating this display feature never
    // rides the job that applies real lineup changes to users' ESPN accounts. 11:00 UTC is
    // early enough: probable starters are posted the night before (a day's slate is ~94%
    // named by the prior evening), so the 2-hour-earlier slot costs no coverage. Additive +
    // failure-tolerant: on error the last good BvP payload stays in KV rather than dropping.
    let bvp;
    try {
      const b = await buildBvp(dataset.players);
      await redis.set(BVP_KEY, b);
      bvp = b.counts;
    } catch (err) {
      bvp = { error: String(err.message || err) };
    }

    const secondary = {};
    for (const s of SECONDARY) {
      try {
        const built = await s.build();
        try {
          await enrichForm(built, { sport: s.sport, season });
        } catch (err) {
          built.counts = { ...built.counts, formError: err.message };
        }
        // Rolling last-N team-game splits for the basketball/hockey boards (NBA L15/L30,
        // WNBA L10/L20, NHL L15/L30). Per-player gamelog fetches over the top-150, no-op out
        // of season. Additive + failure-tolerant. NFL is excluded on purpose — at one game a
        // week a 15/30-game window is nearly a whole season, so it gets a per-game log
        // (client-side on click) instead of a rolling window.
        if (s.sport === 'nba' || s.sport === 'wnba' || s.sport === 'nhl') {
          try {
            await enrichRollingEspn(built, { sport: s.sport });
          } catch (err) {
            built.counts = { ...built.counts, rollingError: err.message };
          }
        }
        // NHL: day-of opponent-defense matchup (the BvP analog), stored under its own key from the free
        // NHL schedule + team-defense feeds. Empty out of season. Additive + failure-tolerant — only
        // overwrite on a successful build so a bad day keeps the last good payload.
        if (s.sport === 'nhl') {
          try {
            const m = await buildNhlMatchup({});
            await redis.set(NHL_MATCHUP_KEY, m);
            built.counts = { ...built.counts, nhlMatchup: m.counts };
          } catch (err) {
            built.counts = { ...built.counts, nhlMatchupError: err.message };
          }
        }
        // NBA/WNBA: day-of opponent pace + defense matchup (the BvP analog for basketball), stored per
        // league under its own key from free ESPN feeds. Empty out of season. Additive + failure-tolerant.
        if (s.sport === 'nba' || s.sport === 'wnba') {
          try {
            const m = await buildNbaMatchup({ sport: s.sport });
            await redis.set(HOOPS_MATCHUP_KEY[s.sport], m);
            built.counts = { ...built.counts, hoopsMatchup: m.counts };
          } catch (err) {
            built.counts = { ...built.counts, hoopsMatchupError: err.message };
          }
        }
        // NFL: Sleeper consensus projections (draft cards + Coach) feeding the blended-value
        // ranking below. Additive + failure-tolerant — falls back to the last good pull in KV.
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
          // Phase 2 opportunity context: target share + pace → a capped tilt on each skill player.
          // Runs BEFORE the blend (which applies the tilt to the in-season pace leg). Additive +
          // failure-tolerant — an error just leaves players without p.opportunity.
          try {
            enrichNflContext(built);
          } catch (err) {
            built.counts = { ...built.counts, contextError: err.message };
          }
          // Blended-value ranking: reweight fpPpr/fpStd = projection + last-year + current pace by
          // season progress (needs projections above). Also applies the Phase 2 opportunity tilt to
          // the in-season pace leg. Additive + failure-tolerant.
          try {
            enrichNflBlend(built);
          } catch (err) {
            built.counts = { ...built.counts, blendError: err.message };
          }
          // Weekly consistency (P25/P50) + ceiling (P90) from per-game points — year-round (offseason =
          // last completed season). Per-player game-log fetches, soft-budgeted; additive + fail-tolerant.
          try {
            await enrichNflConsistency(built);
          } catch (err) {
            built.counts = { ...built.counts, consistencyError: err.message };
          }
          // Defense-vs-position (DvP): the heaviest matchup builder — derived by aggregating game box scores
          // (ESPN has no ready-made pass/rush yards-allowed splits). Stored under its own key. A weekly
          // freshness guard (pass the cached payload as prev) skips the ~272-fetch rebuild on days the NFL
          // week hasn't advanced. Empty out of season. Additive + failure-tolerant.
          try {
            const prev = await redis.get(NFL_DVP_KEY);
            const dvp = await buildNflDvp({ prev });
            await redis.set(NFL_DVP_KEY, dvp);
            built.counts = { ...built.counts, nflDvp: dvp.counts, dvpReused: !!dvp.reusedAt };
          } catch (err) {
            built.counts = { ...built.counts, nflDvpError: err.message };
          }
        }
        built.version = DATASET_VERSION; // keep cache in sync with the handler's check
        await redis.set(s.key, built);
        secondary[s.sport] = built.counts;
      } catch (err) {
        secondary[s.sport] = { error: err.message };
      }
    }

    // NFL Pick'em weekly feed (Brackets & Bowls) — free ESPN + NWS sources, no key. Additive
    // and failure-tolerant: a failed build leaves the last good feed in KV rather than
    // dropping it, and never blocks the dataset writes above.
    let pickem;
    try {
      const feed = await buildNflPickem();
      await redis.set(NFL_PICKEM_KEY, feed);
      pickem = { week: feed.week, games: feed.games.length, upsets: feed.upsetAlerts.length };
    } catch (err) {
      pickem = { error: err.message };
    }

    // CFB Bowl / Playoff feed — same pipeline, postseason slate. Empty out of bowl season
    // (matchups are set in December). Additive + failure-tolerant like the NFL feed.
    let cfbBowl;
    try {
      const feed = await buildCfbBowl();
      await redis.set(CFB_BOWL_KEY, feed);
      cfbBowl = { season: feed.season, games: feed.games.length, upsets: feed.upsetAlerts.length };
    } catch (err) {
      cfbBowl = { error: err.message };
    }

    // CFB Week feed — the current regular-season week's Top-25 games (weekly counterpart to the
    // bowl feed). Empty before the season's first poll (~mid-August). Additive + failure-tolerant.
    let cfbWeek;
    try {
      const feed = await buildCfbWeek();
      await redis.set(CFB_WEEK_KEY, feed);
      cfbWeek = { week: feed.week, games: feed.games.length, upsets: feed.upsetAlerts.length };
    } catch (err) {
      cfbWeek = { error: err.message };
    }

    // March Madness bracket (premium) — full men's tournament model, free ESPN sources. Empty
    // out of season (the field only exists ~3 weeks each March). Additive + failure-tolerant:
    // a failed build leaves the last good bracket in KV rather than dropping it.
    let marchMadness;
    try {
      const feed = await buildMarchMadness();
      await redis.set(MM_KEY, feed);
      marchMadness = { field: feed.field, season: feed.season, regions: feed.regions.length, upsets: feed.upsetAlerts.length };
    } catch (err) {
      marchMadness = { error: err.message };
    }

    return res.status(200).json({
      ok: true,
      builtAt: dataset.builtAt,
      counts: dataset.counts,
      bvp,
      pickem,
      cfbBowl,
      cfbWeek,
      marchMadness,
      ...secondary,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
