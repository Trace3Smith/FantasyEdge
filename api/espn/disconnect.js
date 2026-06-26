// Disconnect the user's ESPN account — deletes their stored cookies from Redis.
import { requirePremium, sendError } from '../_lib/auth.js';
import { redis } from '../_lib/kv.js';
import { deleteCreds } from '../_lib/espnFantasy.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { userId } = await requirePremium(req);
    await deleteCreds(redis, userId);
    return res.json({ connected: false });
  } catch (err) {
    return sendError(res, err);
  }
}
