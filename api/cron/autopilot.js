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
import { redis, DATASET_KEY, WNBA_DATASET_KEY, NBA_DATASET_KEY, NFL_DATASET_KEY } from '../_lib/kv.js';
import { parseLeagueKey } from '../../leagueIdentity.js';
import { premiumForUser } from '../_lib/auth.js';
import {
  getCreds, getAutopilot, listAutopilotUsers, setAutopilotLeague, clearAutopilot,
  fetchLeagueRoster, setLineup, autopilotSportOf, EspnAuthError, fetchNflByes,
} from '../_lib/espnFantasy.js';
import { buildValueIndex, suggestLineup } from '../_lib/lineupAdvisor.js';
import { parseScoringSettings } from '../_lib/espnScoring.js';
import { recordLeagueConfig } from '../_lib/leagueConfig.js';
import { dnaCaptureAllowed } from '../_lib/leagueDnaConsent.js';
import { sweepLeagueConfigs } from '../_lib/leagueDnaSweep.js';
import { getWatch, setWatch, prospectIndex, reconcileWatch } from '../_lib/prospectWatch.js';

export const maxDuration = 60;

// Every sport api/espn/index.js lets a user switch Autopilot on for MUST have an entry here. A
// missing one is silent: playersFor returns null, the league counts as noData, and the lineup is
// simply never set — which is how NFL sat before it was added. check:autopilot enforces this.
export const DATASET_BY_SPORT = { mlb: DATASET_KEY, wnba: WNBA_DATASET_KEY, nba: NBA_DATASET_KEY, nfl: NFL_DATASET_KEY };

// Fold one setLineup result into the run summary.
//
// ESPN rejects an ENTIRE lineup transaction with a 409 when it contains a player whose game has
// already started — it does not silently no-op. setLineup recovers by parsing the named players out
// of the 409 body, dropping them and retrying, then reports what actually happened:
//   applied       — moves that landed
//   skippedLocked — moves ESPN refused because the player was locked; they must be retried on a
//                   later run, and are NOT a failure of this one
//   alreadySet    — moves that were redundant (the player was already in the target slot)
//
// That result was previously discarded: the cron awaited setLineup and then incremented `applied`
// unconditionally, so a league where every move was rejected as locked looked identical to one where
// every move succeeded. This is the distinction the run needs in order to tell "deferred, retry next
// slate" from "done" — and it becomes load-bearing for NFL, where players lock individually across
// Thursday/Sunday/Monday rather than on one daily cutoff.
//
// Pure and exported so the accounting is testable without an ESPN session.
export function tallyApply(summary, res) {
  const applied = Number(res?.applied) || 0;
  const locked = Array.isArray(res?.skippedLocked) ? res.skippedLocked.length : 0;
  const already = Number(res?.alreadySet) || 0;
  summary.moves += applied;
  summary.lockedSkipped += locked;
  summary.alreadySet += already;
  if (locked) summary.deferredLeagues++;   // at least one move must wait for a later slate
  if (!applied) summary.noopLeagues++;     // a plan existed but nothing actually changed
  return summary;
}

export default async function handler(req, res) {
  // Bearer secret only, failing closed when it is unset — same gate as api/cron/refresh.js.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const started = Date.now(); // the League DNA sweep's budget is measured from here

  // `applied`/`optimal`/`expired`/`errors`/`noData`/`callUps` keep their existing meanings (leagues);
  // the move-level fields below are additive so existing log readers are unaffected.
  const summary = {
    users: 0, leagues: 0, applied: 0, optimal: 0, expired: 0, errors: 0, noData: 0, callUps: 0,
    moves: 0, lockedSkipped: 0, alreadySet: 0, deferredLeagues: 0, noopLeagues: 0,
    skippedEntitlement: 0, entitlementErrors: 0,
  };
  try {
    // Lazily load + cache each sport's dataset players (a dataset may be missing
    // off-season or unbuilt). Cached across users so we hit Redis once per sport per run.
    const playersCache = {};
    let nflByes;   // proTeamId -> bye week; loaded lazily on the first NFL league
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
      try {
        if (!await premiumForUser(userId)) {
          summary.skippedEntitlement++;
          await clearAutopilot(redis, userId);
          continue;
        }
      } catch {
        // Fail closed on a Clerk/Redis outage without interpreting it as a
        // cancellation or erasing a paying user's preferences.
        summary.entitlementErrors++;
        continue;
      }
      const creds = await getCreds(redis, userId);
      if (!creds) continue;
      summary.users++;
      const prefs = await getAutopilot(redis, userId);
      // League DNA: capture only for a user who opted in on the current notice. Autopilot being on is
      // not consent; a user who never answered the notice is never captured here.
      const dnaOk = await dnaCaptureAllowed(redis, userId);
      const mlbLeagues = []; // fetched MLB leagues, for background prospect call-up detection
      for (const [leagueKey, prefVal] of Object.entries(prefs)) {
        const ids = parseLeagueKey(leagueKey, autopilotSportOf(prefVal));
        if (!ids || !['mlb', 'wnba', 'nfl'].includes(ids.sport) || !prefVal) continue;
        const { season, leagueId, teamId, sport } = ids;
        if (sport !== autopilotSportOf(prefVal)) continue;
        if ((prefVal.connectionId || 'legacy') !== (creds.connectionId || 'legacy')) continue;
        summary.leagues++;
        try {
          const players = await playersFor(sport);
          if (!players) { summary.noData++; continue; } // no dataset for this sport right now
          const league = await fetchLeagueRoster(creds, { leagueId, seasonId: Number(season), teamId: Number(teamId) }, sport);
          if (sport === 'mlb') mlbLeagues.push(league);
          if (dnaOk) await recordLeagueConfig(redis, league.leagueConfig); // League DNA: settings came with the roster read
          // Value players under this league's own ESPN scoring (auto-detected).
          const scoring = parseScoringSettings(league.scoringRaw, sport);
          // NFL bye weeks, fetched once per run and shared across leagues (public, no cookies).
          if (sport === 'nfl' && nflByes === undefined) nflByes = await fetchNflByes(Number(season)).catch(() => null);
          const sugg = suggestLineup(league, indexFor(sport, players, scoring?.weights || null), sport,
            sport === 'nfl' && nflByes ? { byeWeeks: nflByes } : {});
          if (!sugg.plan.length) { summary.optimal++; continue; }
          // Recheck after provider/model work, immediately before submitting.
          let premium;
          try { premium = await premiumForUser(userId); }
          catch { summary.entitlementErrors++; break; }
          if (!premium) {
            summary.skippedEntitlement++;
            await clearAutopilot(redis, userId);
            break;
          }
          const currentCreds = await getCreds(redis, userId);
          const currentPrefs = await getAutopilot(redis, userId);
          if (!currentCreds || !currentPrefs[leagueKey]
            || (currentCreds.connectionId || 'legacy') !== (creds.connectionId || 'legacy')
            || (currentPrefs[leagueKey].connectionId || 'legacy') !== (creds.connectionId || 'legacy')) break;
          const applyRes = await setLineup(creds, {
            leagueId, seasonId: Number(season), teamId: Number(teamId), scoringPeriodId: league.scoringPeriodId,
          }, sugg.plan, { roster: league.roster, sport });
          summary.applied++;
          tallyApply(summary, applyRes);
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

    // League DNA daily sweep, after the lineup work, with what's left of the run: at most 20s, and
    // finished by 50s in, inside maxDuration. It reads only opted-in users, re-checking each against the
    // current notice. It can never change the lineup result above: a failure is reported, not thrown.
    try {
      summary.sweep = await sweepLeagueConfigs(redis, { deadline: Math.min(started + 50000, Date.now() + 20000) });
    } catch (err) {
      summary.sweep = { error: String(err.message || err) };
    }
    // One line per run, so the result shows up in Vercel's logs: a cron's response body isn't shown
    // anywhere. The summary is counts and error messages only, with no user ids or cookies.
    console.log(`[autopilot] summary ${JSON.stringify(summary)}`);
    return res.json({ ok: true, summary });
  } catch (err) {
    console.error(`[autopilot] failed: ${String(err.message || err)} summary ${JSON.stringify(summary)}`);
    return res.status(500).json({ ok: false, error: String(err.message || err), summary });
  }
}
