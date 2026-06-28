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
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY } from '../_lib/kv.js';
import {
  normalizeS2, normalizeSwid, isValidSwid, saveCreds, getCreds, deleteCreds,
  fetchFanLeagues, fetchLeaguesWithRosters, fetchLeagueRoster, fetchLeagueByOwner, fetchLeagueAllTeams, fetchFreeAgents, setLineup,
  getAutopilot, setAutopilotLeague, leagueKeyOf,
  getManualLeagues, addManualLeague, removeManualLeague,
  maskSwid, credsShape, EspnAuthError,
} from '../_lib/espnFantasy.js';
import { buildMlbValueIndex, suggestLineup } from '../_lib/lineupAdvisor.js';
import { normName } from '../_lib/golf.js';

// connect/leagues make several ESPN calls; trade actions also call Claude (10-20s).
// Raise above the 10s Hobby default (Hobby caps at 60s).
export const maxDuration = 60;

// Sport → cached ranked-player dataset (for trade value grounding).
const DATASET_BY_SPORT = { mlb: DATASET_KEY, nba: NBA_DATASET_KEY, wnba: WNBA_DATASET_KEY, nhl: NHL_DATASET_KEY, nfl: NFL_DATASET_KEY };
const TRADE_SPORTS = new Set(['mlb', 'wnba', 'nfl', 'nba', 'nhl']);

// name → value (zTotal for roto sports, score/points for NFL). Best-effort; missing
// dataset → empty map (Claude then reasons without our ratings).
async function valueIndexFor(sport) {
  const key = DATASET_BY_SPORT[sport] || DATASET_KEY;
  const idx = new Map();
  try {
    const ds = await redis.get(key);
    for (const p of (ds?.players || [])) {
      if (p.searchOnly) continue;
      const v = typeof p.zTotal === 'number' ? p.zTotal : (typeof p.score === 'number' ? p.score : null);
      if (v == null || !p.name) continue;
      const k = normName(p.name);
      const prev = idx.get(k);
      if (prev == null || v > prev) idx.set(k, v);
    }
  } catch { /* no dataset — degrade to no ratings */ }
  return idx;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { userId } = await requirePremium(req);
    const action = req.body?.action;

    switch (action) {
      case 'status':     return await status(res, userId);
      case 'connect':    return await connect(req, res, userId);
      case 'disconnect': return await disconnect(res, userId);
      case 'leagues':    return await leagues(req, res, userId);
      case 'apply':      return await applyLineup(req, res, userId);
      case 'autopilot':  return await autopilotPref(req, res, userId);
      case 'addLeague':  return await addLeague(req, res, userId);
      case 'removeLeague': return await removeLeague(req, res, userId);
      case 'tradeScan':  return await tradeScan(req, res, userId);
      case 'tradeAdvise': return await tradeAdvise(req, res, userId);
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
async function leagues(req, res, userId) {
  const creds = await getCreds(redis, userId);
  if (!creds) {
    throw new HttpError(409, 'No ESPN account connected', { error: 'not_connected' });
  }
  // Discover any of the 5 sports (Team Manager only sends in-season ones; Trade Center
  // may request any). The full suggestion/autopilot engine still runs for MLB only.
  const sport = TRADE_SPORTS.has(req.body?.sport) ? req.body.sport : 'mlb';

  let result;
  try {
    result = await fetchLeaguesWithRosters(creds, { sport });
  } catch (err) {
    if (err instanceof EspnAuthError) {
      // Cookies expired/revoked since they were saved — tell the UI to reconnect.
      throw new HttpError(409, 'ESPN cookies expired', { error: 'espn_auth', reconnect: true });
    }
    throw err;
  }
  result.sport = sport;

  // MLB gets the full engine: manual-league fallback, start/sit + IL + waiver
  // suggestions, and the autopilot toggle state. Other in-season sports (WNBA) show
  // leagues + rosters only for now — the suggestion engine is MLB-specific.
  if (sport === 'mlb') {
    // Merge manually-added leagues (fan-discovery fallback), deduped.
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

    try {
      const ds = await redis.get(DATASET_KEY);
      const players = (ds?.players || []).filter((p) => !p.searchOnly);
      if (players.length) {
        const idx = buildMlbValueIndex(players);
        await Promise.all((result.leagues || []).map(async (lg) => {
          if (!lg || !lg.team || !Array.isArray(lg.roster) || !lg.roster.length) return;
          let freeAgents = [];
          try {
            freeAgents = await fetchFreeAgents(creds, { leagueId: lg.leagueId, seasonId: lg.season, limit: 40 });
          } catch { /* waiver data is optional */ }
          lg.suggestions = suggestLineup(lg, idx, 'mlb', { freeAgents });
        }));
      }
    } catch { /* suggestions are optional */ }

    try {
      const prefs = await getAutopilot(redis, userId);
      for (const lg of (result.leagues || [])) {
        if (lg && lg.team) lg.autopilot = !!prefs[leagueKeyOf(lg)];
      }
    } catch { /* toggle state is optional */ }
  }

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

// ===== Trade Center =========================================================================
const SPORT_LABEL = { mlb: 'MLB', wnba: 'WNBA', nfl: 'NFL', nba: 'NBA', nhl: 'NHL' };
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const TRADE_MODEL = 'claude-opus-4-8';

// One Claude call. Returns the assistant text, or throws HttpError on config/upstream issues.
async function askClaude(system, messages, maxTokens = 1500) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new HttpError(503, 'AI is unavailable right now', { error: 'ai_unavailable' });
  const r = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: TRADE_MODEL, max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) {
    console.error('[trade] anthropic', r.status, await r.text().catch(() => ''));
    throw new HttpError(502, 'The trade analyst had trouble — try again', { error: 'ai_error' });
  }
  const j = await r.json();
  return (j?.content?.find((b) => b.type === 'text')?.text || '').trim();
}

// Pull the full league + attach our value rating to each player; build the grounding
// text Claude sees (your team first, then every opponent). Returns { ctx, info }.
async function buildTradeContext(creds, { sport, leagueId, season }) {
  let league;
  try {
    league = await fetchLeagueAllTeams(creds, { leagueId: String(leagueId), seasonId: Number(season) }, sport);
  } catch (err) {
    if (err instanceof EspnAuthError) throw new HttpError(409, 'ESPN cookies expired', { error: 'espn_auth', reconnect: true });
    throw new HttpError(502, 'Could not load that league from ESPN', { error: 'league_failed', detail: String(err.message || err) });
  }
  const idx = await valueIndexFor(sport);
  const val = (name) => { const v = idx.get(normName(name)); return v == null ? '' : ` val ${Math.round(v * 10) / 10}`; };
  const rosterLines = (roster) => (roster || []).slice(0, 30)
    .map((p) => `  - ${p.name}${p.pos ? ' (' + p.pos + ')' : ''}${p.injury ? ' [' + p.injury + ']' : ''}${val(p.name)}`).join('\n');

  const me = league.teams.find((t) => t.id === league.userTeamId) || league.teams.find((t) => t.mine);
  const others = league.teams.filter((t) => t !== me);
  const parts = [
    `LEAGUE: "${league.leagueName}" — ${league.teamCount}-team ${league.scoringType || ''} ${SPORT_LABEL[sport] || sport} league.`,
    'Value rating = our model\'s player value (higher = better; same scale within this sport). Blank = depth/unranked.',
    `\nYOUR TEAM: ${me ? me.name : 'You'}${me && me.record ? ' (' + me.record + ')' : ''}\n${me ? rosterLines(me.roster) : ''}`,
    '\nOTHER TEAMS:',
  ];
  for (const t of others) parts.push(`[${t.name}${t.record ? ' ' + t.record : ''}]\n${rosterLines(t.roster)}`);
  // Bound the prompt (a 12-team league fits comfortably; clamp pathological cases).
  const ctx = parts.join('\n').slice(0, 14000);
  return { ctx, info: { leagueName: league.leagueName, teamCount: league.teamCount, scoringType: league.scoringType, myTeam: me ? me.name : null } };
}

// Best-effort JSON extraction from a model reply (handles ```json fences / stray prose).
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const s = body.indexOf('{'); const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch { return null; }
}

// TRADE SCANNER — propose 2-3 mutually-beneficial trades for one league.
async function tradeScan(req, res, userId) {
  const creds = await getCreds(redis, userId);
  if (!creds) throw new HttpError(409, 'No ESPN account connected', { error: 'not_connected' });
  const sport = TRADE_SPORTS.has(req.body?.sport) ? req.body.sport : 'mlb';
  const { leagueId, season } = req.body || {};
  if (!leagueId || !season) throw new HttpError(400, 'Missing league', { error: 'missing_league' });

  const { ctx, info } = await buildTradeContext(creds, { sport, leagueId, season });
  const system = `You are FantasyEdge's Trade Scanner for ${SPORT_LABEL[sport] || sport} fantasy. Using the rosters and our value ratings below, find 2-3 REALISTIC trades that genuinely improve BOTH the user's team and a partner team. A good trade sends from the user's surplus (a position of depth) to fill a partner's need, and returns a player who fills the user's need from that partner's surplus. Only propose trades that are roughly fair and that the other manager would plausibly consider — no fleecing.

Return STRICT JSON only (no prose, no markdown fences): {"proposals":[{"partnerTeam": "<team name>", "youGet": ["<player>", ...], "youGive": ["<player>", ...], "rationale": "<one or two sentences: why it helps both sides>", "fairness": <integer 0-100, 50 = perfectly even, higher = better for the user>}]}. If no sensible trade exists, return {"proposals":[]}.

${ctx}`;
  const text = await askClaude(system, [{ role: 'user', content: 'Scan my league and propose the best trades for my team.' }], 1500);
  const parsed = extractJson(text);
  const proposals = Array.isArray(parsed?.proposals) ? parsed.proposals.slice(0, 4) : [];
  return res.json({ proposals, info, raw: proposals.length ? undefined : text });
}

// TRADE EVALUATOR / COUNTER GENERATOR / WALK-AWAY — one grounded chat. The system
// prompt makes Claude evaluate an offer, generate ranked counters, and call out
// lowballs / circular negotiations and suggest better partners.
async function tradeAdvise(req, res, userId) {
  const creds = await getCreds(redis, userId);
  if (!creds) throw new HttpError(409, 'No ESPN account connected', { error: 'not_connected' });
  const sport = TRADE_SPORTS.has(req.body?.sport) ? req.body.sport : 'mlb';
  const { leagueId, season } = req.body || {};
  if (!leagueId || !season) throw new HttpError(400, 'Missing league', { error: 'missing_league' });

  const messages = sanitizeChat(req.body?.messages);
  if (!messages.length) throw new HttpError(400, 'Describe the trade first', { error: 'empty' });

  const { ctx } = await buildTradeContext(creds, { sport, leagueId, season });
  const system = `You are FantasyEdge's Trade Negotiation Advisor for ${SPORT_LABEL[sport] || sport} fantasy. You already know the user's roster and every other team's roster (with our value ratings) — never ask them to list their team. Be decisive and concise.

When the user pastes/describes an INCOMING OFFER: open with a one-word verdict — ACCEPT, REJECT, or COUNTER — then 1-2 sentences why, grounded in value + roster fit.
COUNTERS: if it's close, propose a fair counter. If they want options, give 2-3 counter variations RANKED by how likely the other manager accepts (most likely first), each one line.
WALK AWAY: if they describe back-and-forth going in circles, or the other side lowballing, say so plainly and tell them to move on — then name 1-2 better trade partners in this league and a quick angle for each.
Don't invent this week's injuries/news beyond what's given; reason from value, role, and roster fit. No markdown headers — just talk.

${ctx}`;
  const reply = await askClaude(system, messages, 1200);
  if (!reply) throw new HttpError(502, 'The analyst came up empty — rephrase', { error: 'ai_empty' });
  return res.json({ reply });
}

// Keep valid user/assistant turns, clamp length/count, start on a user turn.
function sanitizeChat(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const m of raw) {
    const role = m && (m.role === 'user' || m.role === 'assistant') ? m.role : null;
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    if (role && content) out.push({ role, content: content.slice(0, 4000) });
  }
  const trimmed = out.slice(-16);
  while (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
  return trimmed;
}
