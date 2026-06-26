// Whether the signed-in premium user has an ESPN account connected. Returns only a
// boolean (+ a masked SWID and the save time for display) — never the raw cookies.
import { requirePremium, sendError } from '../_lib/auth.js';
import { redis } from '../_lib/kv.js';
import { getCreds, maskSwid } from '../_lib/espnFantasy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { userId } = await requirePremium(req);
    const creds = await getCreds(redis, userId);
    return res.json({
      connected: !!creds,
      swid: creds ? maskSwid(creds.swid) : null,
      savedAt: creds?.savedAt || null,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
