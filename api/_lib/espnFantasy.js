// ESPN fantasy-baseball integration helpers (Autopilot feature, step 1).
//
// Talks to ESPN's unofficial fantasy API using a user's own browser cookies
// (espn_s2 + SWID), which they paste once and we store in Redis keyed by their
// Clerk user id. Two ESPN surfaces are used:
//   • the "fan" API  — enumerates every fantasy team the SWID owns, so we can
//     discover the user's league + team ids without them typing anything.
//   • the v3 league API — the authoritative league/team/roster data per league.
//
// SECURITY: the cookies are bearer-equivalent secrets. They live ONLY in Redis
// (server-side) and are never returned to the browser — status checks expose a
// connected boolean and a masked SWID at most. Every caller is premium-gated.

import { normName } from './golf.js';

const credsKey = (userId) => `espn:creds:${userId}`;

// A thrown EspnAuthError means ESPN rejected the cookies (expired/invalid) — the
// endpoints turn it into a "reconnect" signal for the UI rather than a 500.
export class EspnAuthError extends Error {
  constructor(message = 'ESPN rejected the saved cookies') {
    super(message);
    this.name = 'EspnAuthError';
  }
}

// --- credential storage (Redis, per Clerk user) ----------------------------------------------
// SWID is the GUID-in-braces cookie; normalize so a paste with/without braces or
// surrounding quotes/whitespace all land in the canonical `{...}` form ESPN expects.
export function normalizeSwid(raw) {
  // Strip surrounding quotes/whitespace AND any existing braces, then re-wrap in
  // exactly one pair. This canonicalizes every variant — "{GUID}", "GUID", "GUID}",
  // "{GUID", '"{GUID}"', "{{GUID}}" — to the single "{GUID}" form ESPN's write API
  // (memberId) validates strictly. The old version only added a brace when one was
  // entirely absent, so a half-braced paste could persist and 400 the lineup write.
  const inner = String(raw || '').trim().replace(/^["']+|["']+$/g, '').trim().replace(/[{}]/g, '');
  return inner ? `{${inner}}` : '';
}

// A valid SWID is a GUID in braces: {8-4-4-4-12 hex}. ESPN's `SWID` cookie is
// exactly this. Reject anything else (e.g. a value grabbed from the wrong cookie)
// before it's saved — a malformed SWID passes the lenient fan path but 400s the
// strict lineup-write memberId. Expects the normalized (braced) form.
const SWID_RE = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i;
export function isValidSwid(swid) {
  return SWID_RE.test(String(swid || ''));
}

// espn_s2 is a long URL-encoded token; just trim surrounding whitespace/quotes.
export function normalizeS2(raw) {
  return String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
}

export async function saveCreds(redis, userId, { espn_s2, swid }) {
  const creds = { espn_s2: normalizeS2(espn_s2), swid: normalizeSwid(swid), savedAt: new Date().toISOString() };
  await redis.set(credsKey(userId), creds);
  return creds;
}

export async function getCreds(redis, userId) {
  const c = await redis.get(credsKey(userId));
  if (!(c && c.espn_s2 && c.swid)) return null;
  // Re-normalize the SWID on read so a previously-saved malformed value (e.g. a
  // missing brace) is healed transparently for both the fan path and the write
  // memberId — no reconnect required.
  return { ...c, swid: normalizeSwid(c.swid) };
}

export async function deleteCreds(redis, userId) {
  await redis.del(credsKey(userId));
}

// Mask the SWID for display ("{ABCD…WXYZ}") so the UI can confirm WHICH account is
// linked without exposing the full identifier.
export function maskSwid(swid) {
  const s = String(swid || '');
  const inner = s.replace(/[{}]/g, '');
  if (inner.length <= 8) return s;
  return `{${inner.slice(0, 4)}…${inner.slice(-4)}}`;
}

// Non-sensitive summary of what's stored for a user — confirms creds were actually
// retrieved and are well-formed (a healthy espn_s2 is a long ~250-400 char token).
// Never includes the raw cookie value; safe to surface to the client for debugging.
export function credsShape(creds) {
  if (!creds) return { present: false };
  const swid = String(creds.swid || '');
  return {
    present: true,
    s2Len: String(creds.espn_s2 || '').length,
    swid: maskSwid(creds.swid),
    // True brace state (maskSwid fabricates braces, so it can't reveal this).
    swidLen: swid.length,
    swidBraces: `${swid.startsWith('{') ? 'open✓' : 'open✗'} ${swid.endsWith('}') ? 'close✓' : 'close✗'}`,
    savedAt: creds.savedAt || null,
  };
}

// --- ESPN id → label maps --------------------------------------------------------------------
// ESPN baseball (flb) uses one id scheme for both a player's default position
// (player.defaultPositionId) and the lineup slot they occupy (entry.lineupSlotId).
const SLOT_BY_ID = {
  0: 'C', 1: '1B', 2: '2B', 3: '3B', 4: 'SS', 5: 'OF', 6: '2B/SS', 7: '1B/3B',
  8: 'LF', 9: 'CF', 10: 'RF', 11: 'DH', 12: 'UTIL', 13: 'P', 14: 'SP', 15: 'RP',
  16: 'BE', 17: 'IL', 18: 'P', 19: 'IF',
};
// A player's default (eligible) position shares the same id scheme.
const POSITION_BY_ID = SLOT_BY_ID;
// Slots that are NOT in the active lineup (bench / injured list).
const BENCH_SLOTS = new Set([16, 17]);
// Display order for active lineup slots (everything else, e.g. bench, sorts after).
const SLOT_ORDER = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 5, 11, 12, 14, 15, 13, 18, 19];
// MLB pro-team ids → abbreviations (proTeamId).
const PROTEAM_BY_ID = {
  0: 'FA', 1: 'BAL', 2: 'BOS', 3: 'LAA', 4: 'CHW', 5: 'CLE', 6: 'DET', 7: 'KC',
  8: 'MIL', 9: 'MIN', 10: 'NYY', 11: 'OAK', 12: 'SEA', 13: 'TEX', 14: 'TOR',
  15: 'ATL', 16: 'CHC', 17: 'CIN', 18: 'HOU', 19: 'LAD', 20: 'WSH', 21: 'NYM',
  22: 'PHI', 23: 'PIT', 24: 'STL', 25: 'SD', 26: 'SF', 27: 'COL', 28: 'MIA',
  29: 'ARI', 30: 'TB',
};
const INJURY_LABEL = {
  ACTIVE: '', NORMAL: '', QUESTIONABLE: 'Q', DOUBTFUL: 'D', OUT: 'O',
  DAY_TO_DAY: 'DTD', SUSPENSION: 'SUSP',
  SEVEN_DAY_DL: 'IL', TEN_DAY_DL: 'IL', FIFTEEN_DAY_DL: 'IL', SIXTY_DAY_DL: '60-IL',
};

const posOf = (id) => POSITION_BY_ID[id] || 'UTIL';
const slotOf = (id) => SLOT_BY_ID[id] ?? String(id);
const teamOf = (id) => PROTEAM_BY_ID[id] || '';

// Exposed for the lineup advisor: human label for a slot id, and whether a slot
// is an active (startable) lineup spot rather than bench/IL.
export const slotLabel = (id) => slotOf(id);
export const isActiveSlot = (id) => !BENCH_SLOTS.has(Number(id));

// --- low-level fetch -------------------------------------------------------------------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cookieHeader(creds) {
  return `espn_s2=${creds.espn_s2}; SWID=${creds.swid}`;
}

// GET an ESPN JSON endpoint with the user's cookies. Throws EspnAuthError on 401/403
// (bad/expired cookies) so callers can prompt a reconnect; other non-2xx → generic Error.
//
// Uses fetch, which percent-encodes the SWID's `{ }` to %7B/%7D — that's the correct,
// RFC-3986-valid form the fan API expects (the same encoding Python's requests sends).
// Do NOT send literal braces: they're illegal URI chars and ESPN's Tomcat layer 400s
// them with an HTML error page.
async function espnGet(url, creds) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    res = await fetch(url, {
      headers: { Cookie: cookieHeader(creds), 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
  if (res.status === 401 || res.status === 403) throw new EspnAuthError();
  if (!res.ok) {
    // Include ESPN's response body — its 400s usually name what they rejected.
    const body = await res.text().catch(() => '');
    const snip = body ? `: ${body.replace(/\s+/g, ' ').slice(0, 200)}` : '';
    throw new Error(`ESPN HTTP ${res.status} for ${url}${snip}`);
  }
  return res.json();
}

// --- league discovery (fan API) --------------------------------------------------------------
// ESPN tags a fantasy entry's sport in a few different places depending on the
// payload version; FLB == fantasy baseball. Pull the abbreviation from whichever
// field is present, case-insensitively.
function entryAbbrev(entry, pref) {
  const raw = entry?.abbrev || entry?.gameAbbrev || entry?.gameKey
    || pref?.type?.abbrev || pref?.metaData?.abbrev || '';
  return String(raw).toUpperCase();
}

// Enumerate every fantasy-baseball team the SWID owns. Returns a light list of
// { leagueId, seasonId, teamId, leagueName } — the league/team names here are
// best-effort; the v3 roster fetch supplies the authoritative ones. Thin wrapper
// over discoverFanLeagues (which also returns a diagnostic) for callers that only
// need the list (e.g. the connect verify).
export async function fetchFanLeagues(creds) {
  const { leagues } = await discoverFanLeagues(creds);
  return leagues;
}

// `context=fantasy` is load-bearing: it routes the request to the modern fan
// service. Without it the bare path falls through to an old Tomcat backend that
// 400s. We keep the params minimal (no featureFlags/displayNow/recentDays — those
// 400 some accounts); first variant that returns entries wins.
const FAN_PARAM_VARIANTS = [
  'context=fantasy&useCookies=true',
  'context=fantasy',
];

// Same discovery as fetchFanLeagues, but also returns a non-sensitive `diag`
// describing what the fan API actually returned (preference count, sport abbrevs +
// seasons seen, why entries were skipped, any transport error). No cookies or tokens
// are included — safe to surface to the client to debug "no leagues found".
export async function discoverFanLeagues(creds) {
  const diag = { ok: false, prefCount: 0, abbrevs: [], seasons: [], types: [], entryKeys: [], responseKeys: [], skipped: { abbrev: 0, ids: 0, noEntry: 0 }, kept: 0, variants: 0, error: null };
  const out = [];
  const seen = new Set();
  const addUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

  for (const params of FAN_PARAM_VARIANTS) {
    // Raw SWID with literal { } — espnGet preserves them in the path (see its note).
    const url = `https://fan.api.espn.com/apis/v2/fans/${creds.swid}${params ? '?' + params : ''}`;
    let data;
    try {
      data = await espnGet(url, creds);
      diag.ok = true;
      diag.variants++;
    } catch (err) {
      if (err instanceof EspnAuthError) throw err;
      diag.error = err.message || 'fan API request failed';
      continue; // try the next variant
    }

    if (!diag.responseKeys.length) diag.responseKeys = Object.keys(data || {}); // 'preferences' if logged in; guest/empty otherwise
    const prefs = Array.isArray(data?.preferences) ? data.preferences : [];
    diag.prefCount = Math.max(diag.prefCount, prefs.length);

    for (const p of prefs) {
      addUnique(diag.types, p?.type?.type);
      const e = p?.metaData?.entry;
      if (!e) { diag.skipped.noEntry++; continue; }
      if (!diag.entryKeys.length) diag.entryKeys = Object.keys(e); // sample shape of first entry

      const abbrev = entryAbbrev(e, p);
      addUnique(diag.abbrevs, abbrev || '(none)');
      addUnique(diag.seasons, e.seasonId);
      // Keep baseball only (other sports share the fan API). Tolerate a missing
      // abbrev rather than dropping a league we can't classify.
      if (abbrev && abbrev !== 'FLB') { diag.skipped.abbrev++; continue; }

      const group = (Array.isArray(e.groups) && e.groups[0]) || {};
      const leagueId = String(group.groupId ?? e.groupId ?? e.leagueId ?? '');
      const teamId = e.entryId ?? e.teamId ?? group.groupManagerTeamId;
      if (!leagueId || teamId == null) { diag.skipped.ids++; continue; }

      const key = `${e.seasonId}:${leagueId}:${teamId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        leagueId,
        seasonId: e.seasonId || new Date().getFullYear(),
        teamId,
        leagueName: group.groupName || e.name || `League ${leagueId}`,
      });
    }
    if (out.length) break; // found baseball — no need to try narrower variants
  }
  diag.kept = out.length;
  return { leagues: out, diag };
}

// --- roster fetch (v3 league API) ------------------------------------------------------------
const V3_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/flb/seasons';

function parseRoster(entries = []) {
  const players = entries.map((en) => {
    const ppe = en.playerPoolEntry || {};
    const pl = ppe.player || en.player || {};
    const slotId = en.lineupSlotId;
    // A player is "locked" once their MLB game has started — ESPN rejects the WHOLE
    // lineup transaction if it includes a locked move. Read it from whichever field
    // is present (defensive). The advisor must not move these.
    const locked = ppe.lineupLocked === true || ppe.rosterLocked === true || en.lineupLocked === true;
    // eligibleSlots is the set of lineup-slot ids this player may legally fill —
    // the basis for optimal start/sit assignment (a hitter's includes UTIL, a
    // pitcher's SP/RP/P, etc.). ESPN already encodes the generic-slot rules here.
    return {
      id: pl.id ?? null,
      name: pl.fullName || 'Unknown',
      pos: posOf(pl.defaultPositionId),
      proTeam: teamOf(pl.proTeamId),
      slot: slotOf(slotId),
      slotId,
      eligibleSlots: Array.isArray(pl.eligibleSlots) ? pl.eligibleSlots : [],
      starter: !BENCH_SLOTS.has(slotId),
      injury: INJURY_LABEL[pl.injuryStatus] || '',
      injuryStatus: pl.injuryStatus || 'ACTIVE',
      locked,
    };
  });
  // Starters first (in lineup-slot order), then bench/IR.
  players.sort((a, b) => {
    if (a.starter !== b.starter) return a.starter ? -1 : 1;
    const ai = SLOT_ORDER.indexOf(a.slotId), bi = SLOT_ORDER.indexOf(b.slotId);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
  return players;
}

// Shape one league + the user's team into our result object.
function buildLeagueResult(data, team, { leagueId, seasonId }) {
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  const name = (t) => `${t.location || ''} ${t.nickname || ''}`.trim() || t.name || t.abbrev || `Team ${t.id}`;
  return {
    leagueId,
    season: seasonId,
    teamId: team ? team.id : null,
    // Current scoring period (the day, for MLB) — required by the lineup-set write.
    scoringPeriodId: data?.scoringPeriodId ?? data?.status?.latestScoringPeriod ?? null,
    leagueName: data?.settings?.name || `League ${leagueId}`,
    teamCount: teams.length,
    scoringType: data?.settings?.scoringSettings?.scoringType || null,
    // Active lineup shape: { slotId: count }. Drives optimal-assignment slot openings.
    slotCounts: data?.settings?.rosterSettings?.lineupSlotCounts || {},
    team: team
      ? {
          id: team.id,
          name: name(team),
          abbrev: team.abbrev || '',
          logo: team.logo || null,
          wins: team.record?.overall?.wins ?? null,
          losses: team.record?.overall?.losses ?? null,
          ties: team.record?.overall?.ties ?? null,
        }
      : null,
    roster: team ? parseRoster(team.roster?.entries || []) : [],
  };
}

const leagueUrl = (leagueId, seasonId) => `${V3_BASE}/${seasonId}/segments/0/leagues/${leagueId}`
  + `?view=mTeam&view=mRoster&view=mSettings`;

// Fetch one league and pull the authoritative league name + the user's team + roster.
export async function fetchLeagueRoster(creds, { leagueId, seasonId, teamId }) {
  const data = await espnGet(leagueUrl(leagueId, seasonId), creds);
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  const team = teams.find((t) => t.id === teamId) || null;
  return buildLeagueResult(data, team, { leagueId, seasonId });
}

// Manual add: fetch a league by id and find the user's team by SWID ownership (no fan
// API). Throws { code:'not_a_member' } if this SWID owns no team in the league.
export async function fetchLeagueByOwner(creds, { leagueId, seasonId }) {
  const data = await espnGet(leagueUrl(leagueId, seasonId), creds);
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  const mySwid = normalizeSwid(creds.swid).toUpperCase();
  const owns = (t) => [t.primaryOwner, ...(Array.isArray(t.owners) ? t.owners : [])]
    .filter(Boolean).some((o) => String(o).toUpperCase() === mySwid);
  const team = teams.find(owns) || null;
  if (!team) { const e = new Error('SWID owns no team in this league'); e.code = 'not_a_member'; throw e; }
  return buildLeagueResult(data, team, { leagueId, seasonId });
}

// --- lineup write (v3 transactions) ----------------------------------------------------------
const V3_WRITE_BASE = 'https://lm-api-writes.fantasy.espn.com/apis/v3/games/flb/seasons';

// POST one lineup transaction; returns { ok, status, body } without throwing on a
// non-2xx so the caller can inspect (e.g. a 409 "X is locked").
async function postLineupTxn(creds, { leagueId, seasonId, teamId, scoringPeriodId }, items) {
  const url = `${V3_WRITE_BASE}/${seasonId}/segments/0/leagues/${leagueId}/transactions/`;
  const body = {
    isLeagueManager: false,
    teamId,
    type: 'ROSTER',
    memberId: normalizeSwid(creds.swid),
    scoringPeriodId,
    executionType: 'EXECUTE',
    items: items.map((it) => ({
      playerId: it.playerId, type: 'LINEUP',
      fromLineupSlotId: it.fromLineupSlotId, toLineupSlotId: it.toLineupSlotId,
    })),
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader(creds), 'User-Agent': UA, 'Content-Type': 'application/json',
        Accept: 'application/json', 'x-fantasy-source': 'kona', 'x-fantasy-platform': 'kona-PROD',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
  const txt = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: txt };
}

// Pull the player names ESPN names as locked out of a 409 body, e.g.
// "...could not be completed, Spencer Horwitz is locked." → ["Spencer Horwitz"].
function parseLockedNames(body) {
  const out = [];
  const re = /([A-Za-z][A-Za-z.'\- ]*?)\s+is\s+locked/gi;
  let m;
  while ((m = re.exec(String(body || '')))) { const n = m[1].trim(); if (n) out.push(n); }
  return out;
}

// Apply a lineup change to ESPN: a single ROSTER transaction whose items each move
// one player from its current slot to a target slot (active slot, or 16=BE to bench).
// `items` = [{ playerId, fromLineupSlotId, toLineupSlotId }]. No-op for an empty list.
// Throws EspnAuthError on 401/403. Safety net: ESPN rejects the WHOLE transaction
// (409) if any player is locked (game started). When it names a locked player, drop
// that player's move and retry — so the rest of the optimal lineup still applies.
// Pass { roster } so names in the 409 can be mapped back to playerIds.
export async function setLineup(creds, ids, items = [], { roster = [] } = {}) {
  if (!items.length) return { applied: 0, skippedLocked: [] };
  const skippedLocked = [];
  let attempt = items.slice();

  for (let tries = 0; tries < 4 && attempt.length; tries++) {
    const r = await postLineupTxn(creds, ids, attempt);
    if (r.ok) return { applied: attempt.length, skippedLocked };
    if (r.status === 401 || r.status === 403) throw new EspnAuthError();

    if (r.status === 409 && /locked/i.test(r.body)) {
      const names = parseLockedNames(r.body);
      const lockedIds = new Set();
      for (const nm of names) {
        const p = roster.find((rp) => normName(rp.name) === normName(nm));
        if (p && p.id != null) lockedIds.add(p.id);
      }
      const next = attempt.filter((it) => !lockedIds.has(it.playerId));
      if (lockedIds.size && next.length < attempt.length) {
        skippedLocked.push(...names);
        attempt = next;
        continue; // retry without the locked player(s)
      }
    }
    throw new Error(`ESPN lineup write HTTP ${r.status}${r.body ? ': ' + r.body.slice(0, 180) : ''}`);
  }
  return { applied: attempt.length, skippedLocked };
}

// --- manually-added leagues (Redis, per Clerk user) ------------------------------------------
// Fallback when fan discovery fails: the user pastes a league id and we store it at
// espn:manualleagues:{userId} = [{ leagueId, season }].
const manualLeaguesKey = (userId) => `espn:manualleagues:${userId}`;

export async function getManualLeagues(redis, userId) {
  const list = await redis.get(manualLeaguesKey(userId));
  return Array.isArray(list) ? list : [];
}

export async function addManualLeague(redis, userId, { leagueId, season }) {
  const list = await getManualLeagues(redis, userId);
  if (!list.some((l) => String(l.leagueId) === String(leagueId) && String(l.season) === String(season))) {
    list.push({ leagueId: String(leagueId), season });
  }
  await redis.set(manualLeaguesKey(userId), list);
  return list;
}

export async function removeManualLeague(redis, userId, { leagueId, season }) {
  const list = (await getManualLeagues(redis, userId))
    .filter((l) => !(String(l.leagueId) === String(leagueId) && String(l.season) === String(season)));
  await redis.set(manualLeaguesKey(userId), list);
  return list;
}

// --- autopilot preferences (Redis, per Clerk user) -------------------------------------------
// A user's enabled leagues live at espn:autopilot:{userId} = { [leagueKey]: true }.
// A set espn:autopilot:users tracks who has ANY league enabled, so the daily cron
// only iterates opted-in users. leagueKey is "season:leagueId:teamId".
const autopilotKey = (userId) => `espn:autopilot:${userId}`;
const AUTOPILOT_USERS = 'espn:autopilot:users';
export const leagueKeyOf = (lg) => `${lg.season ?? lg.seasonId}:${lg.leagueId}:${lg.teamId}`;

export async function getAutopilot(redis, userId) {
  return (await redis.get(autopilotKey(userId))) || {};
}

export async function setAutopilotLeague(redis, userId, leagueKey, on) {
  const prefs = await getAutopilot(redis, userId);
  if (on) prefs[leagueKey] = true; else delete prefs[leagueKey];
  await redis.set(autopilotKey(userId), prefs);
  if (Object.keys(prefs).length) await redis.sadd(AUTOPILOT_USERS, userId);
  else await redis.srem(AUTOPILOT_USERS, userId);
  return prefs;
}

export async function listAutopilotUsers(redis) {
  return (await redis.smembers(AUTOPILOT_USERS)) || [];
}

// Run async fn over items with bounded concurrency (kind to ESPN + bounds latency).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Top-level: discover the user's FLB leagues, then fetch each league's roster. Caps the
// number of leagues so one user with dozens can't blow the function budget. A single
// league's fetch failing degrades to an error note on that league, not the whole call.
export async function fetchLeaguesWithRosters(creds, { maxLeagues = 12 } = {}) {
  const { leagues: discovered, diag } = await discoverFanLeagues(creds);
  const leagues = discovered.slice(0, maxLeagues);
  const results = await mapLimit(leagues, 4, async (lg) => {
    try {
      return await fetchLeagueRoster(creds, lg);
    } catch (err) {
      if (err instanceof EspnAuthError) throw err;
      return { leagueId: lg.leagueId, season: lg.seasonId, leagueName: lg.leagueName, team: null, roster: [], error: 'fetch_failed' };
    }
  });
  // Classify an empty result so the UI can react precisely: a fan call that
  // succeeds but returns ZERO entries is the signature of an expired espn_s2
  // (ESPN serves a 200 guest profile, not a 401). Entries present but none in
  // baseball means the account simply has no MLB league.
  let state = 'ok';
  if (!diag.ok) state = 'fan_error';
  else if (discovered.length === 0) state = diag.prefCount === 0 ? 'expired' : 'no_baseball';
  return { count: discovered.length, truncated: discovered.length > leagues.length, leagues: results, diag, state };
}
