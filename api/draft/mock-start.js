// Starts a mock draft. Free users get one per UTC day on basic (fixed) settings;
// premium users get unlimited mocks and may tweak settings. Returns the league setup
// the frontend uses to simulate the snake draft (AI opponents pick client-side).
import { getEntitlement, consumeMockQuota, getMockUsage, sendError, FREE_MAX_ROUND } from '../_lib/auth.js';
import { DEFAULT_SETTINGS } from '../_lib/draft.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, premium } = await getEntitlement(req);

    let settings = { ...DEFAULT_SETTINGS };
    if (premium) {
      // Premium may override scoring/teams/rounds (Phase 2 will load saved settings).
      const o = req.body?.settings || {};
      if (o.scoring === 'standard' || o.scoring === 'ppr') settings.scoring = o.scoring;
      if (Number.isInteger(o.teams) && o.teams >= 8 && o.teams <= 16) settings.teams = o.teams;
      if (Number.isInteger(o.rounds) && o.rounds >= 10 && o.rounds <= 20) settings.rounds = o.rounds;
    } else {
      // Free tier: enforce the daily quota and lock to basic settings.
      await consumeMockQuota(userId);
    }

    const usage = await getMockUsage(userId);
    const userSlot = 1 + Math.floor(Math.random() * settings.teams); // user's snake position

    return res.json({
      premium,
      settings,
      userSlot,
      sport: 'nfl',
      freeMaxRound: premium ? null : FREE_MAX_ROUND,
      usage: premium ? null : usage,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
