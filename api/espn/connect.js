// Connect an ESPN fantasy account (Premium). The user pastes their browser's
// espn_s2 + SWID cookies; we verify them against ESPN (so we don't store dead
// cookies), then persist them in Redis keyed by the Clerk user id. The cookies are
// never returned to the client. See api/_lib/espnFantasy.js for the security notes.
import { requirePremium, sendError, HttpError } from '../_lib/auth.js';
import { redis } from '../_lib/kv.js';
import {
  normalizeS2, normalizeSwid, saveCreds, fetchFanLeagues, maskSwid, EspnAuthError,
} from '../_lib/espnFantasy.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { userId } = await requirePremium(req);

    const espn_s2 = normalizeS2(req.body?.espn_s2);
    const swid = normalizeSwid(req.body?.swid);
    if (!espn_s2 || !swid || swid === '{}') {
      throw new HttpError(400, 'Missing cookies', { error: 'missing_cookies' });
    }

    // Verify before persisting — a 401/403 from ESPN means the cookies are bad, so we
    // surface "reconnect" instead of saving credentials that will never work.
    const creds = { espn_s2, swid };
    let leagues;
    try {
      leagues = await fetchFanLeagues(creds);
    } catch (err) {
      if (err instanceof EspnAuthError) {
        throw new HttpError(401, 'ESPN rejected those cookies', { error: 'espn_auth' });
      }
      throw err;
    }

    await saveCreds(redis, userId, creds);
    return res.json({ connected: true, swid: maskSwid(swid), leagueCount: leagues.length });
  } catch (err) {
    return sendError(res, err);
  }
}
