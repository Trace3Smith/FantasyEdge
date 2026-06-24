// Starts a mock draft. Free users get one per UTC day on basic (fixed) settings;
// premium users get unlimited mocks and may tweak settings. Returns the league setup
// the frontend uses to simulate the snake draft (AI opponents pick client-side).
import { getEntitlement, consumeMockQuota, getMockUsage, sendError, FREE_MAX_ROUND } from '../_lib/auth.js';
import { DEFAULT_SETTINGS } from '../_lib/draft.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, premium } = await getEntitlement(req);

    // Which sport's draft to start. NBA/WNBA are 9-cat (roto); everything else is the
    // points-based NFL flow. Unknown sports fall back to NFL.
    const reqSport = req.body?.sport;
    const sport = reqSport === 'nba' || reqSport === 'wnba' ? reqSport : 'nfl';
    const isNba = sport === 'nba' || sport === 'wnba';

    let settings = { ...DEFAULT_SETTINGS, sport };
    if (isNba) {
      // NBA defaults: 9-cat scoring, a shorter draft, and the basketball starting lineup
      // (PG/SG/SF/PF/C/G/F/UTIL). The lineup detail lives in nbaScoring.js; the client reads
      // `scoring`/`rounds` for the draft mechanics.
      settings.scoring = '9cat';
      settings.rounds = 13;
      settings.starters = null; // NFL-specific; NBA roster slots come from nbaScoring.js
    }
    const o = req.body?.settings || {};

    // League size is a basic setting everyone may pick (8/10/12/14-team).
    if ([8, 10, 12, 14].includes(Number(o.teams))) settings.teams = Number(o.teams);

    if (premium) {
      // Premium may also override scoring/rounds (Phase 2 will load saved settings). The
      // points-format override is NFL-only — NBA has no PPR/Standard toggle.
      if (!isNba && (o.scoring === 'standard' || o.scoring === 'ppr' || o.scoring === 'half')) settings.scoring = o.scoring;
      if (Number.isInteger(o.rounds) && o.rounds >= 10 && o.rounds <= 20) settings.rounds = o.rounds;
    } else {
      // Free tier: enforce the daily quota (settings otherwise stay basic).
      await consumeMockQuota(userId);
    }

    const usage = await getMockUsage(userId);
    // Honor a chosen draft position (any tier — it's pure draft mechanics); fall back
    // to a random slot when none/invalid is sent.
    const wanted = Number(req.body?.position);
    const userSlot = Number.isInteger(wanted) && wanted >= 1 && wanted <= settings.teams
      ? wanted
      : 1 + Math.floor(Math.random() * settings.teams);

    return res.json({
      premium,
      settings,
      userSlot,
      sport,
      freeMaxRound: premium ? null : FREE_MAX_ROUND,
      usage: premium ? null : usage,
    });
  } catch (err) {
    return sendError(res, err);
  }
}
