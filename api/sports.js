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
import { buildNflPickem } from './_lib/nflPickem.js';
import { buildCfbBowl } from './_lib/cfbBowl.js';
import { buildCfbWeek } from './_lib/cfbWeek.js';
import { TEAM_REPORT_VERSION } from './_lib/teamReport.js';
import { topUpWeather, FEED_CONTENT_VERSION } from './_lib/pickem.js';
import { getBoxScore } from './_lib/boxScore.js';
import { buildMarchMadness } from './_lib/marchMadness.js';
import { requirePremium, sendError } from './_lib/auth.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY, NFL_PICKEM_KEY, CFB_BOWL_KEY, CFB_WEEK_KEY, MM_KEY, BVP_KEY, NFL_DVP_KEY, DATASET_VERSION } from './_lib/kv.js';

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
  pga: { key: PGA_DATASET_KEY, build: () => buildPgaDataset(), version: DATASET_VERSION },
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

  // March Madness bracket optimizer (Brackets & Bowls) — PREMIUM, unlike the free Pick'em
  // feeds below. Rides this same function (?feed=march-madness) to preserve the function
  // budget. Re-verifies the Clerk session + plan server-side (the UI lock is cosmetic), then
  // serves the daily-cached bracket with a cold-start inline build so a fresh field self-heals
  // on the first request after Selection Sunday — no waiting for the next daily cron.
  if (req.query.feed === 'march-madness') {
    try {
      await requirePremium(req);
    } catch (err) {
      return sendError(res, err);
    }
    try {
      let feed = await redis.get(MM_KEY);
      // A complete ('set') bracket is cached until the daily cron rebuilds it. A cold miss, or a
      // not-yet-'set' feed (off-season 'none' or a mid-reveal 'incomplete') older than 30 min,
      // rebuilds inline — so a freshly-announced field self-heals within the half-hour of the
      // first request, without re-fetching ESPN on every hit during the empty months.
      const ageMs = feed?.builtAt ? Date.now() - Date.parse(feed.builtAt) : Infinity;
      const stale = !feed || !Array.isArray(feed.regions) || (feed.field !== 'set' && ageMs > 30 * 60 * 1000);
      if (stale) {
        feed = await buildMarchMadness();
        await redis.set(MM_KEY, feed);
      }
      return res.json(feed);
    } catch (err) {
      return res.status(500).json({ error: err.message, field: 'none', regions: [] });
    }
  }

  // NFL defense-vs-position (DvP), read-only. Free public data like the Pick'em feeds below, but
  // deliberately NOT built inline the way they are: buildNflDvp is the heaviest builder in the
  // codebase (~1 scoreboard call per week + ~1 game summary per completed game, ~272 a season,
  // behind a 45s soft budget), so letting an unauthenticated request trigger a rebuild would turn a
  // public URL into a rebuild lever. The daily cron owns the build; this only serves what it stored.
  //
  // A missing key is a REAL answer (out of season, or never built), so it returns the same empty
  // shape buildNflDvp itself returns rather than an error.
  //
  // Reading this as a health check — the signal is the LATER of `builtAt` and `reusedAt`, not
  // builtAt alone. buildNflDvp's weekly freshness guard returns `{...prev, reusedAt: now}` on a day
  // the NFL week hasn't advanced, and the cron stores that, so in season builtAt legitimately sits
  // still for up to a week while reusedAt moves. The cron writes the key only after a successful
  // build (a throw skips its redis.set and leaves the previous payload), so NEITHER timestamp
  // advancing across days means the DvP step is failing even though the rest of the refresh
  // succeeded. `rated: false` with `counts.games: 0` is the normal preseason state, not a fault —
  // DvP has nothing to aggregate until real games complete. `npm run check:dvp` applies this rule.
  if (req.query.feed === 'nfl-dvp') {
    try {
      const dvp = await redis.get(NFL_DVP_KEY);
      return res.json(dvp || { season: null, week: null, builtAt: null, rated: false, teams: {}, counts: { games: 0, teams: 0 } });
    } catch (err) {
      return res.status(500).json({ error: err.message, rated: false, teams: {} });
    }
  }

  // Box score for one completed game (?feed=boxscore&sport=nfl|cfb&id=<espn event id>). Rides this
  // same function like the feeds below — no dedicated endpoint. The game ids come straight off the
  // Pick'em cards, which have carried them since the results split, so nothing extra is fetched to
  // find them.
  //
  // Unlike the DvP endpoint above, an inline build here is safe to expose: it is one upstream call
  // for one game, the result is immutable and cached forever, and the id is bounded to digits so
  // the URL can't be pointed at anything else.
  if (req.query.feed === 'boxscore') {
    const LEAGUES = { nfl: 'football/nfl', cfb: 'football/college-football' };
    const leaguePath = LEAGUES[req.query.sport];
    const id = String(req.query.id || '');
    if (!leaguePath || !/^\d{1,12}$/.test(id)) {
      return res.status(400).json({ error: 'boxscore needs sport=nfl|cfb and a numeric id', teams: [] });
    }
    try {
      return res.json(await getBoxScore(leaguePath, id));
    } catch (err) {
      return res.status(502).json({ error: err.message, teams: [] });
    }
  }

  // Brackets & Bowls feeds ride this same function (dispatch on ?feed=) to stay within the
  // serverless-function budget — no dedicated endpoint. NFL Pick'em is a free, read-only
  // feed of public data (like the rankings), served from the daily-cached KV payload with a
  // cold-start inline build so it self-heals before the first cron run.
  const PICKEM_FEEDS = {
    'nfl-pickem': { key: NFL_PICKEM_KEY, build: buildNflPickem },
    'cfb-bowl': { key: CFB_BOWL_KEY, build: buildCfbBowl },
    'cfb-week': { key: CFB_WEEK_KEY, build: buildCfbWeek },
  };
  if (PICKEM_FEEDS[req.query.feed]) {
    const { key, build } = PICKEM_FEEDS[req.query.feed];
    try {
      let feed = await redis.get(key);
      // A payload cached before team reports existed has no `teamReports` KEY at all, and one
      // built against an older report SHAPE carries an older `v` — either rebuilds once so the
      // page never meets a payload it can't read. Presence and version are tested, not
      // truthiness: a build whose report step failed stores an explicit null, and treating THAT
      // as stale would rebuild the whole feed — scoreboard, injuries and weather — on every
      // single request.
      const reports = feed?.teamReports;
      const staleReports = !feed || !('teamReports' in feed)
        || (reports != null && reports.v !== TEAM_REPORT_VERSION);
      // Forecasts predating the timestamp+url fields can be neither aged on the card nor topped
      // up, and those fields are purely ADDITIVE — so nothing else here would notice, and the
      // feature would stay invisible until the next daily cron. Rebuilding once on the first
      // request after deploy is the same self-heal the version check above does. It cannot loop:
      // every forecast a build produces carries both fields.
      const staleWeather = (feed?.games || []).some((g) => g.weather && !g.weather.fetchedAt);
      // Derived-content version. Presence checks like the two above only work while a change ADDS a
      // field; they cannot see a change that alters VALUES in a field already there, or which games
      // land on the slate at all. Both have shipped invisibly before. A payload built before
      // versioning carries none, so it rebuilds once.
      const staleImpact = feed?.contentV !== FEED_CONTENT_VERSION;
      let built = false;
      if (!feed || !Array.isArray(feed.games) || staleReports || staleWeather || staleImpact) {
        feed = await build();
        await redis.set(key, feed);
        built = true;
      }

      // Weather top-up. The daily cron is the only scheduled writer and Hobby won't run one more
      // often, so a forecast is otherwise up to ~24h old — including through the final hours
      // before kickoff, which is exactly when it firms up. Re-read only the games about to be
      // played, only when their forecast has gone stale, and only once per interval across all
      // requests (the top-up holds a cooldown). A build we just did is already fresh, so it skips.
      if (!built) {
        const { feed: toppedUp, changed } = await topUpWeather(feed, key);
        feed = toppedUp;
        if (changed) await redis.set(key, feed);
      }
      return res.json(feed);
    } catch (err) {
      return res.status(500).json({ error: err.message, games: [] });
    }
  }

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
    //
    // An EMPTY players array counts as stale. It is never a real answer — every wired sport
    // has players — so it means a past build stored a failure. Without this an empty dataset
    // is served forever: `!dataset.players` is false for [], so it never rebuilds itself out.
    const stale = !dataset || !dataset.players || !dataset.players.length
      || (cfg.version != null && dataset.version !== cfg.version)
      || (cfg.needsValue && !dataset.players.some((p) => !p.searchOnly && typeof p.zTotal === 'number'));
    if (stale) {
      dataset = await cfg.build();
      if (cfg.version != null) dataset.version = cfg.version;
      await redis.set(cfg.key, dataset);
    }

    const players = sport === 'pga' ? filterLivByField(dataset.players) : dataset.players;

    // Batter-vs-pitcher lines for today's probable-pitcher matchups (MLB only). Its own key,
    // built day-of by the autopilot cron, so it may be absent (off-season, before the first
    // build, or a day with no games) — the client treats it as optional and keys by player id.
    // Stale-day guard: only serve it if built for today, so yesterday's matchups never show.
    let bvp = null;
    if (sport === 'mlb') {
      const b = await redis.get(BVP_KEY);
      if (b && b.date === new Date().toISOString().slice(0, 10)) bvp = b;
    }

    return res.json({
      players,
      sport,
      builtAt: dataset.builtAt,
      // ADP-specific freshness (NFL only; null elsewhere). This is the scrape/fetch time,
      // which can lag dataset.builtAt on a graceful-degrade day — so it's the honest
      // "ADP last updated" signal for the draft board.
      adpBuiltAt: dataset.counts?.adp?.builtAt ?? null,
      // Real bounds of the rolling windows (MLB only; null elsewhere), so the UI can label
      // from what was actually measured. Teams don't play in lockstep, so an "L15" window
      // spans a RANGE of team games — the client must not hardcode "15".
      rollingWindows: dataset.counts?.rollingWindows ?? null,
      // Today's BvP matchups keyed by batter id (MLB only, null otherwise/off-day):
      // { date, builtAt, batters: { [id]: { oppSp, line } } }. Display shows any history.
      bvp,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, players: [] });
  }
}
