// ESPN fantasy account integration (Premium) — a single serverless function that
// dispatches on `action` so the four ESPN operations share one deployment slot
// (the Hobby plan caps a deployment at 12 functions). All actions are POST and
// premium-gated; the user's espn_s2 + SWID cookies are stored server-side in Redis
// keyed by the Clerk user id and are never returned to the client. See
// api/_lib/espnFantasy.js for the security notes.
//
//   action: 'status'     -> { connected, swid (masked), savedAt }
//   action: 'connect'    -> verify cookies vs ESPN, persist; { connected, swid, leagueCount }
//   action: 'disconnect' -> delete stored cookies; { connected: false }
//   action: 'leagues'    -> { leagues: [...] } with rosters
import { requirePremium, sendError, HttpError } from '../_lib/auth.js';
import { redis, DATASET_KEY } from '../_lib/kv.js';
import {
  normalizeS2, normalizeSwid, isValidSwid, saveCreds, getCreds, deleteCreds,
  fetchFanLeagues, fetchLeaguesWithRosters, fetchLeagueRoster, fetchLeagueByOwner, setLineup,
  getAutopilot, setAutopilotLeague, leagueKeyOf,
  getManualLeagues, addManualLeague, removeManualLeague,
  maskSwid, credsShape, EspnAuthError,
} from '../_lib/espnFantasy.js';
import { attachSuggestions, buildMlbValueIndex, suggestLineup } from '../_lib/lineupAdvisor.js';

// connect + leagues make several ESPN network calls; raise above the 10s Hobby default.
export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { userId } = await requirePremium(req);
    const action = req.body?.action;

    switch (action) {
      case 'status':     return await status(res, userId);
      case 'connect':    return await connect(req, res, userId);
      case 'disconnect': return await disconnect(res, userId);
      case 'leagues':    return await leagues(res, userId);
      case 'apply':      return await applyLineup(req, res, userId);
      case 'autopilot':  return await autopilotPref(req, res, userId);
      case 'addLeague':  return await addLeague(req, res, userId);
      case 'removeLeague': return await removeLeague(req, res, userId);
      default:
        return res.status(400).json({ error: 'unknown_action' });
    }
  } catch (err) {
    return sendError(res, err);
  }
}

// Whether the user has an ESPN account connected. Returns only a boolean (+ masked
// SWID and save time for display) — never the raw cookies.
async function status(res, userId) {
  const creds = await getCreds(redis, userId);
  return res.json({
    connected: !!creds,
    swid: creds ? maskSwid(creds.swid) : null,
    savedAt: creds?.savedAt || null,
  });
}

// Connect an ESPN account: verify the pasted cookies against ESPN BEFORE persisting,
// so we never store dead credentials.
async function connect(req, res, userId) {
  const espn_s2 = normalizeS2(req.body?.espn_s2);
  const swid = normalizeSwid(req.body?.swid);
  if (!espn_s2 || !swid || swid === '{}') {
    throw new HttpError(400, 'Missing cookies', { error: 'missing_cookies' });
  }
  // The SWID must be a real GUID — a value from the wrong cookie would pass ESPN's
  // lenient fan path but break the lineup write. Reject it up front.
  if (!isValidSwid(swid)) {
    throw new HttpError(400, 'That SWID is not in the expected format', { error: 'bad_swid' });
  }

  const creds = { espn_s2, swid };
  let leaguesFound;
  try {
    leaguesFound = await fetchFanLeagues(creds);
  } catch (err) {
    if (err instanceof EspnAuthError) {
      throw new HttpError(401, 'ESPN rejected those cookies', { error: 'espn_auth' });
    }
    throw err;
  }

  await saveCreds(redis, userId, creds);
  return res.json({ connected: true, swid: maskSwid(swid), leagueCount: leaguesFound.length });
}

// Disconnect — delete the user's stored cookies from Redis.
async function disconnect(res, userId) {
  await deleteCreds(redis, userId);
  return res.json({ connected: false });
}

// Pull the user's ESPN fantasy-baseball leagues and current rosters.
async function leagues(res, userId) {
  const creds = await getCreds(redis, userId);
  if (!creds) {
    throw new HttpError(409, 'No ESPN account connected', { error: 'not_connected' });
  }

  let result;
  try {
    result = await fetchLeaguesWithRosters(creds);
  } catch (err) {
    if (err instanceof EspnAuthError) {
      // Cookies expired/revoked since they were saved — tell the UI to reconnect.
      throw new HttpError(409, 'ESPN cookies expired', { error: 'espn_auth', reconnect: true });
    }
    throw err;
  }

  // Merge in any manually-added leagues (fan-discovery fallback), deduped against
  // what discovery already found. Best-effort per league.
  try {
    const manual = await getManualLeagues(redis, userId);
    const have = new Set((result.leagues || []).filter((l) => l.teamId != null).map(leagueKeyOf));
    for (const m of manual) {
      try {
        const lg = await fetchLeagueByOwner(creds, { leagueId: m.leagueId, seasonId: Number(m.season) });
        lg.manual = true;
        if (!have.has(leagueKeyOf(lg))) { result.leagues = result.leagues || []; result.leagues.push(lg); have.add(leagueKeyOf(lg)); }
      } catch { /* skip a manual league that fails to load */ }
    }
  } catch { /* manual merge is optional */ }

  // Annotate each league with start/sit suggestions from our MLB valuations.
  // Best-effort: read the cached dataset directly (no rebuild) so a cold/missing
  // dataset degrades to "no suggestions" rather than blocking the roster view.
  try {
    const ds = await redis.get(DATASET_KEY);
    const players = (ds?.players || []).filter((p) => !p.searchOnly);
    if (players.length) attachSuggestions(result, players);
  } catch { /* suggestions are optional */ }

  // Mark which leagues have autopilot enabled so the UI renders the toggle state.
  try {
    const prefs = await getAutopilot(redis, userId);
    for (const lg of (result.leagues || [])) {
      if (lg && lg.team) lg.autopilot = !!prefs[leagueKeyOf(lg)];
    }
  } catch { /* toggle state is optional */ }

  // Surface (non-sensitive) cred shape for debugging "connected but no leagues".
  if (result.diag) result.diag.creds = credsShape(creds);
  return res.json(result);
}

// Apply the optimal lineup to ESPN for one league (the manual one-tap path). We
// re-fetch the roster server-side and recompute the plan (never trust a client
// plan), then POST the lineup transaction. Returns what changed.
async function applyLineup(req, res, userId) {
  const creds = await getCreds(redis, userId);
  if (!creds) throw new HttpError(409, 'No ESPN account connected', { error: 'not_connected' });

  const { leagueId, season, teamId } = req.body || {};
  if (!leagueId || !season || teamId == null) {
    throw new HttpError(400, 'Missing league', { error: 'missing_league' });
  }

  let league, players;
  try {
    [league, players] = await Promise.all([
      fetchLeagueRoster(creds, { leagueId: String(leagueId), seasonId: season, teamId }),
      redis.get(DATASET_KEY).then((ds) => (ds?.players || []).filter((p) => !p.searchOnly)),
    ]);
  } catch (err) {
    if (err instanceof EspnAuthError) throw new HttpError(409, 'ESPN cookies expired', { error: 'espn_auth', reconnect: true });
    throw err;
  }
  if (!players.length) throw new HttpError(503, 'Player values unavailable', { error: 'no_dataset' });

  const sugg = suggestLineup(league, buildMlbValueIndex(players));
  if (!sugg.plan.length) return res.json({ applied: 0, moves: [], message: 'Lineup already optimal' });

  let result;
  try {
    result = await setLineup(creds, {
      leagueId: String(leagueId), seasonId: season, teamId, scoringPeriodId: league.scoringPeriodId,
    }, sugg.plan, { roster: league.roster });
  } catch (err) {
    if (err instanceof EspnAuthError) throw new HttpError(409, 'ESPN cookies expired', { error: 'espn_auth', reconnect: true });
    throw new HttpError(502, 'ESPN rejected the lineup change', { error: 'apply_failed', detail: String(err.message || err) });
  }
  return res.json({ applied: result.applied, moves: sugg.moves, skippedLocked: result.skippedLocked || [] });
}

// Get or set the per-league autopilot preference. Body { league:{leagueId,season,
// teamId}, on } toggles; omitting `on` just returns the current prefs map.
async function autopilotPref(req, res, userId) {
  const { league, on } = req.body || {};
  if (typeof on === 'boolean') {
    if (!league || !league.leagueId || !league.season || league.teamId == null) {
      throw new HttpError(400, 'Missing league', { error: 'missing_league' });
    }
    const prefs = await setAutopilotLeague(redis, userId, leagueKeyOf(league), on);
    return res.json({ on, prefs });
  }
  return res.json({ prefs: await getAutopilot(redis, userId) });
}

// Manually add a league by id (fan-discovery fallback). Verifies the SWID owns a team
// in it BEFORE saving, so we never store a league the user isn't actually in.
async function addLeague(req, res, userId) {
  const creds = await getCreds(redis, userId);
  if (!creds) throw new HttpError(409, 'No ESPN account connected', { error: 'not_connected' });

  const leagueId = String(req.body?.leagueId || '').trim();
  const season = Number(req.body?.season) || new Date().getFullYear();
  if (!/^\d+$/.test(leagueId)) throw new HttpError(400, 'Invalid league id', { error: 'bad_league_id' });

  let lg;
  try {
    lg = await fetchLeagueByOwner(creds, { leagueId, seasonId: season });
  } catch (err) {
    if (err instanceof EspnAuthError) throw new HttpError(409, 'ESPN cookies expired', { error: 'espn_auth', reconnect: true });
    if (err.code === 'not_a_member') throw new HttpError(404, 'No team for you in that league', { error: 'not_a_member' });
    // 404 from ESPN = league not found / not visible to these cookies.
    throw new HttpError(404, 'League not found', { error: 'league_not_found', detail: String(err.message || err) });
  }

  await addManualLeague(redis, userId, { leagueId, season });
  return res.json({ added: true, league: { leagueId, season, teamName: lg.team?.name || null, leagueName: lg.leagueName } });
}

async function removeLeague(req, res, userId) {
  const leagueId = String(req.body?.leagueId || '').trim();
  const season = Number(req.body?.season) || new Date().getFullYear();
  const list = await removeManualLeague(redis, userId, { leagueId, season });
  return res.json({ removed: true, count: list.length });
}
