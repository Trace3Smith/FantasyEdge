// Starts a mock draft. Free users get one per UTC day on basic (fixed) settings;
// premium users get unlimited mocks and may tweak settings. Returns the league setup
// the frontend uses to simulate the snake draft (AI opponents pick client-side).
import { getEntitlement, consumeMockQuota, getMockUsage, sendError, FREE_MAX_ROUND } from '../_lib/auth.js';
import { DEFAULT_SETTINGS, isRoto, resolveStarters } from '../_lib/draft.js';

// Sports whose mock draft we can start (a roto sport, or the NFL points flow).
const SUPPORTED = new Set(['nfl', 'nba', 'wnba', 'mlb', 'nhl']);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, premium } = await getEntitlement(req);

    // Which sport's draft to start. NBA/WNBA/MLB/NHL are category (roto) leagues; everything
    // else is the points-based NFL flow. Unknown sports fall back to NFL.
    const reqSport = req.body?.sport;
    const sport = SUPPORTED.has(reqSport) ? reqSport : 'nfl';
    const roto = isRoto(sport);

    let settings = { ...DEFAULT_SETTINGS, sport };
    if (roto) {
      // Roto defaults: category scoring, a shorter draft, and the sport's own starting lineup
      // (the slot detail lives in each sport's scoring module). The client reads
      // `scoring`/`rounds` for the draft mechanics.
      settings.scoring = sport === 'nba' || sport === 'wnba' ? '9cat' : 'roto';
      settings.rounds = 13;
      settings.starters = null; // NFL-specific; roto roster slots come from the scoring module
    }
    const o = req.body?.settings || {};

    // League size is a basic setting everyone may pick (8/10/12/14-team).
    if ([8, 10, 12, 14].includes(Number(o.teams))) settings.teams = Number(o.teams);

    // NFL league settings (scoring / roster layout / rounds) are available to EVERY tier — the
    // ranking + draft engine is settings-aware for any league shape (nflReplacementDepths,
    // minRosterFrom, leagueDemandFrom), so a free user can draft for their real league. Roto sports
    // have no PPR/Standard toggle, and their rounds override stays Premium-only.
    if (!roto) {
      if (o.scoring === 'standard' || o.scoring === 'ppr' || o.scoring === 'half') settings.scoring = o.scoring;
      // Custom NFL roster layout: position counts + bench drive the draft; rounds = starters + bench.
      const cs = resolveStarters(o.starters);
      if (cs) {
        settings.starters = cs;
        const startCount = Object.values(cs).reduce((a, b) => a + b, 0);
        settings.rounds = Math.max(startCount, Math.min(20, Number(o.rounds) || startCount + 6));
      } else if (Number.isInteger(o.rounds) && o.rounds >= 10 && o.rounds <= 20) {
        settings.rounds = o.rounds;
      }
    } else if (premium && Number.isInteger(o.rounds) && o.rounds >= 10 && o.rounds <= 20) {
      settings.rounds = o.rounds; // roto rounds override remains Premium
    }
    // Free tier: still enforce the daily mock-draft quota (unlimited mocks stay Premium).
    if (!premium) await consumeMockQuota(userId);

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
