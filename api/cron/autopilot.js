// Daily Lineup Autopilot cron (scheduled in vercel.json). For every user who has
// opted IN on at least one league, re-fetch that league's roster, compute the
// optimal legal lineup from our MLB valuations, and apply it to ESPN. Opt-in only —
// nothing runs for a league unless the user flipped its Autopilot toggle on.
//
// Defensive by design: a single league failing never aborts the run, and if a
// user's cookies have died we disable their autopilot (so we stop hammering a
// broken account) until they reconnect. Protected by CRON_SECRET like the refresh cron.
import { redis, DATASET_KEY } from '../_lib/kv.js';
import {
  getCreds, getAutopilot, listAutopilotUsers, setAutopilotLeague,
  fetchLeagueRoster, setLineup, EspnAuthError,
} from '../_lib/espnFantasy.js';
import { buildMlbValueIndex, suggestLineup } from '../_lib/lineupAdvisor.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const summary = { users: 0, leagues: 0, applied: 0, optimal: 0, expired: 0, errors: 0 };
  try {
    const ds = await redis.get(DATASET_KEY);
    const players = (ds?.players || []).filter((p) => !p.searchOnly);
    if (!players.length) return res.json({ ok: false, reason: 'no_dataset', summary });
    const idx = buildMlbValueIndex(players);

    const users = await listAutopilotUsers(redis);
    for (const userId of users) {
      const creds = await getCreds(redis, userId);
      if (!creds) continue;
      summary.users++;
      const prefs = await getAutopilot(redis, userId);
      for (const leagueKey of Object.keys(prefs)) {
        const [season, leagueId, teamId] = leagueKey.split(':');
        summary.leagues++;
        try {
          const league = await fetchLeagueRoster(creds, { leagueId, seasonId: Number(season), teamId: Number(teamId) });
          const sugg = suggestLineup(league, idx);
          if (!sugg.plan.length) { summary.optimal++; continue; }
          await setLineup(creds, {
            leagueId, seasonId: Number(season), teamId: Number(teamId), scoringPeriodId: league.scoringPeriodId,
          }, sugg.plan, { roster: league.roster });
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
    }
    return res.json({ ok: true, summary });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message || err), summary });
  }
}
