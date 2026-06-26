// Pull the premium user's ESPN fantasy-football leagues and current rosters, using
// their stored cookies. Foundation for the lineup-suggestion + autopilot features.
import { requirePremium, sendError, HttpError } from '../_lib/auth.js';
import { redis } from '../_lib/kv.js';
import { getCreds, fetchLeaguesWithRosters, EspnAuthError } from '../_lib/espnFantasy.js';

// Several v3 league fetches over the network; raise above the 10s Hobby default.
export const maxDuration = 30;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { userId } = await requirePremium(req);

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

    return res.json(result);
  } catch (err) {
    return sendError(res, err);
  }
}
