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
  normalizeS2, normalizeSwid, saveCreds, getCreds, deleteCreds,
  fetchFanLeagues, fetchLeaguesWithRosters, maskSwid, credsShape, EspnAuthError,
} from '../_lib/espnFantasy.js';
import { attachSuggestions } from '../_lib/lineupAdvisor.js';

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

  // Annotate each league with start/sit suggestions from our MLB valuations.
  // Best-effort: read the cached dataset directly (no rebuild) so a cold/missing
  // dataset degrades to "no suggestions" rather than blocking the roster view.
  try {
    const ds = await redis.get(DATASET_KEY);
    const players = (ds?.players || []).filter((p) => !p.searchOnly);
    if (players.length) attachSuggestions(result, players);
  } catch { /* suggestions are optional */ }

  // Surface (non-sensitive) cred shape for debugging "connected but no leagues".
  if (result.diag) result.diag.creds = credsShape(creds);
  return res.json(result);
}
