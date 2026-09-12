// Client for the CollegeFootballData API (api.collegefootballdata.com).
//
// AUTH. A bearer key, free on registration at collegefootballdata.com/key, in CFBD_API_KEY.
// Without it every call 401s, so `cfbdConfigured` is checked before anything reaches the network:
// an unset key must degrade the college half of the game model to silence, never throw a slate.
//
// THE CALL BUDGET IS THE DESIGN CONSTRAINT, not the rate limit. The free tier allows 1,000 calls
// A MONTH across a shared CFB+CBB pool — roughly 33 a day. That is plenty for what this needs and
// nowhere near enough for the obvious naive shape. EVERY ENDPOINT USED HERE IS YEAR-LEVEL: one
// call returns all ~136 FBS teams. Adding `&team=` to fetch teams one at a time would turn a
// 5-call daily build into 136 × 30 = 4,080 calls and exhaust the month in eight days. If a future
// change needs per-team data, it needs a paid tier first (Tier 2 is 30,000 calls at $5/month), not
// a loop.
//
// So this module exposes exactly the year-level reads the ratings build wants, and counts what it
// spends so the cron summary can report it. `/info` reports the key's own remaining balance, which
// is the number that actually matters — it is the only way to notice the budget draining before it
// runs out, and a silent exhaustion looks exactly like a source outage.
const BASE = 'https://api.collegefootballdata.com';
const UA = 'FantasyEdge/1.0 (game model; contact via app)';

export const cfbdConfigured = Boolean(process.env.CFBD_API_KEY);

// Calls spent in this process, for the cron summary. Reset per build by the caller.
let spent = 0;
export const cfbdSpent = () => spent;
export const resetCfbdSpent = () => { spent = 0; };

export async function cfbdGet(path, params = {}, { tries = 2 } = {}) {
  if (!cfbdConfigured) throw new Error('CFBD_API_KEY not set');
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      spent++;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.CFBD_API_KEY}`, Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(20000),
      });
      // A 401 is a configuration fault and a 429 means the monthly pool is gone — neither is
      // retryable, and retrying a 429 spends calls we no longer have. Fail immediately on both.
      if (r.status === 401) throw new Error('CFBD 401 — key rejected');
      if (r.status === 429) throw new Error('CFBD 429 — monthly call budget exhausted');
      if (!r.ok) throw new Error(`CFBD HTTP ${r.status} for ${path}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (/401|429/.test(e.message)) throw e;
      if (t < tries - 1) await new Promise((res) => setTimeout(res, 600));
    }
  }
  throw lastErr;
}

// The key's remaining monthly balance. Best-effort and deliberately cheap: one call, and a failure
// returns null rather than throwing, because knowing the budget is never worth failing a build for.
export async function cfbdUsage() {
  try {
    const j = await cfbdGet('/info');
    return {
      tier: j?.tierName ?? null,
      monthlyLimit: j?.monthlyLimit ?? null,
      remaining: j?.remainingCalls ?? null,
      used: j?.usedCalls ?? null,
      // Whether this key can read /wepa/team/season. The scoping pass found a
      // `UserFeatureAccess.adjustedMetrics` flag implying that endpoint is tier-gated, which could
      // not be tested without a key — this reports the answer rather than assuming one. SP+ is the
      // fallback and carries no such flag, which is why the ratings below are built on SP+.
      adjustedMetrics: j?.features?.adjustedMetrics ?? null,
    };
  } catch { return null; }
}

// ---- the year-level reads, one call each ----------------------------------

export const spRatings = (year) => cfbdGet('/ratings/sp', { year });
export const teamTalent = (year) => cfbdGet('/talent', { year });
export const returningProduction = (year) => cfbdGet('/player/returning', { year });
export const fbsTeams = (year) => cfbdGet('/teams/fbs', { year });
// `excludeGarbageTime` is a real CFBD parameter and is on by default here. Garbage time is the
// single largest distortion in college football efficiency numbers — a 45-point win pads the
// winner's rates against a backup defense — and CFB is the ONLY one of our two sports where
// filtering it is free. See nflRatings.js for the other side of that asymmetry.
export const advancedSeasonStats = (year, { excludeGarbageTime = true } = {}) =>
  cfbdGet('/stats/season/advanced', { year, excludeGarbageTime, classification: 'fbs' });
// Historical betting lines — the market baseline every backtest is measured against.
export const gameLines = (year, seasonType = 'regular') => cfbdGet('/lines', { year, seasonType });
export const games = (year, seasonType = 'regular') => cfbdGet('/games', { year, seasonType, classification: 'fbs' });
