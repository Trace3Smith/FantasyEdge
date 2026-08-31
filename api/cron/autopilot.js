// Daily Lineup Autopilot cron (scheduled in vercel.json). For every user who has
// opted IN on at least one league, re-fetch that league's roster, compute the optimal
// legal lineup from our valuations for that league's sport, and apply it to ESPN.
// Opt-in only — nothing runs for a league unless the user flipped its Autopilot toggle
// on. Each pref records its sport (MLB roto z / WNBA H2H Points); legacy prefs default
// to MLB.
//
// Defensive by design: a single league failing never aborts the run, and if a
// user's cookies have died we disable their autopilot (so we stop hammering a
// broken account) until they reconnect. Protected by CRON_SECRET like the refresh cron.
import { redis, DATASET_KEY, WNBA_DATASET_KEY } from '../_lib/kv.js';
import {
  getCreds, getAutopilot, listAutopilotUsers, setAutopilotLeague,
  fetchLeagueRoster, setLineup, autopilotSportOf, EspnAuthError,
} from '../_lib/espnFantasy.js';
import { buildValueIndex, suggestLineup } from '../_lib/lineupAdvisor.js';
import { parseScoringSettings } from '../_lib/espnScoring.js';
import { getWatch, setWatch, prospectIndex, reconcileWatch } from '../_lib/prospectWatch.js';

export const maxDuration = 60;

const DATASET_BY_SPORT = { mlb: DATASET_KEY, wnba: WNBA_DATASET_KEY };

export default async function handler(req, res) {
  // Bearer secret only, failing closed when it is unset — same gate as api/cron/refresh.js.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const summary = { users: 0, leagues: 0, applied: 0, optimal: 0, expired: 0, errors: 0, noData: 0, callUps: 0 };
  try {
    // Lazily load + cache each sport's dataset players (a dataset may be missing
    // off-season or unbuilt). Cached across users so we hit Redis once per sport per run.
    const playersCache = {};
    async function playersFor(sport) {
      if (sport in playersCache) return playersCache[sport];
      const key = DATASET_BY_SPORT[sport];
      let players = null;
      if (key) {
        const ds = await redis.get(key);
        const p = (ds?.players || []).filter((x) => !x.searchOnly);
        if (p.length) players = p;
      }
      playersCache[sport] = players;
      return players;
    }
    // Value index per (sport, scoring-weights) — leagues on the same scoring share one.
    const idxCache = new Map();
    function indexFor(sport, players, weights) {
      const sig = `${sport}|${weights ? JSON.stringify(weights) : 'default'}`;
      if (!idxCache.has(sig)) idxCache.set(sig, buildValueIndex(players, sport, weights));
      return idxCache.get(sig);
    }
    // MLB prospect index from the FULL dataset (incl. searchOnly prospect records that
    // playersFor filters out) — for background call-up detection. Loaded once per run.
    let mlbProspectIdx;
    async function prospectIdx() {
      if (mlbProspectIdx === undefined) {
        const ds = await redis.get(DATASET_BY_SPORT.mlb);
        mlbProspectIdx = ds?.players?.length ? prospectIndex(ds.players) : null;
      }
      return mlbProspectIdx;
    }

    const users = await listAutopilotUsers(redis);
    for (const userId of users) {
      const creds = await getCreds(redis, userId);
      if (!creds) continue;
      summary.users++;
      const prefs = await getAutopilot(redis, userId);
      const mlbLeagues = []; // fetched MLB leagues, for background prospect call-up detection
      for (const [leagueKey, prefVal] of Object.entries(prefs)) {
        const [season, leagueId, teamId] = leagueKey.split(':');
        const sport = autopilotSportOf(prefVal);
        summary.leagues++;
        try {
          const players = await playersFor(sport);
          if (!players) { summary.noData++; continue; } // no dataset for this sport right now
          const league = await fetchLeagueRoster(creds, { leagueId, seasonId: Number(season), teamId: Number(teamId) }, sport);
          if (sport === 'mlb') mlbLeagues.push(league);
          // Value players under this league's own ESPN scoring (auto-detected).
          const scoring = parseScoringSettings(league.scoringRaw, sport);
          const sugg = suggestLineup(league, indexFor(sport, players, scoring?.weights || null), sport);
          if (!sugg.plan.length) { summary.optimal++; continue; }
          await setLineup(creds, {
            leagueId, seasonId: Number(season), teamId: Number(teamId), scoringPeriodId: league.scoringPeriodId,
          }, sugg.plan, { roster: league.roster, sport });
          summary.applied++;
        } catch (err) {
          if (err instanceof EspnAuthError) {
            summary.expired++;
            await setAutopilotLeague(redis, userId, leagueKey, false).catch(() => {});
          } else {
            summary.errors++;
          }
        }
      }
      // Background prospect call-up detection (detection + persistence only — never an
      // unattended roster transaction). Surfaces as a card alert next time the user visits.
      if (mlbLeagues.length) {
        try {
          const idx = await prospectIdx();
          if (idx) {
            const watch = await getWatch(redis, userId);
            const { watch: next, byLeague } = reconcileWatch({ watch, leagues: mlbLeagues, idx });
            await setWatch(redis, userId, next);
            summary.callUps += Object.values(byLeague).reduce((n, b) => n + b.callUps.length, 0);
          }
        } catch { /* monitoring is best-effort */ }
      }
    }
    return res.json({ ok: true, summary });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err), summary });
  }
}
