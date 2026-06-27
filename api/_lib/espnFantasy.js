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
  let s = String(raw || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return '';
  if (!s.startsWith('{')) s = '{' + s;
  if (!s.endsWith('}')) s = s + '}';
  return s;
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
  return c && c.espn_s2 && c.swid ? c : null;
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
  return {
    present: true,
    s2Len: String(creds.espn_s2 || '').length,
    swid: maskSwid(creds.swid),
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

// --- low-level fetch -------------------------------------------------------------------------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cookieHeader(creds) {
  return `espn_s2=${creds.espn_s2}; SWID=${creds.swid}`;
}

// GET an ESPN JSON endpoint with the user's cookies. Throws EspnAuthError on 401/403
// (bad/expired cookies) so callers can prompt a reconnect; other non-2xx → generic Error.
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
  if (!res.ok) throw new Error(`ESPN HTTP ${res.status} for ${url}`);
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

// The fan API scopes its `preferences` list by query params (e.g. recentDays /
// displayNow can hide in-season leagues the user hasn't touched lately). We try a
// few param variants and merge, so a baseball league missing from one shows up in
// another. Listed broad→narrow.
const FAN_PARAM_VARIANTS = [
  'context=fantasy&useCookies=true', // minimal: most likely to return everything
  'featureFlags=expandAthlete&context=fantasy&useCookies=true&displayEvents=true&displayNow=true&recentDays=30',
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
    const url = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(creds.swid)}?${params}`;
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
    const pl = en.playerPoolEntry?.player || en.player || {};
    const slotId = en.lineupSlotId;
    return {
      name: pl.fullName || 'Unknown',
      pos: posOf(pl.defaultPositionId),
      proTeam: teamOf(pl.proTeamId),
      slot: slotOf(slotId),
      slotId,
      starter: !BENCH_SLOTS.has(slotId),
      injury: INJURY_LABEL[pl.injuryStatus] || '',
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

// Fetch one league and pull the authoritative league name + the user's team + roster.
export async function fetchLeagueRoster(creds, { leagueId, seasonId, teamId }) {
  const url = `${V3_BASE}/${seasonId}/segments/0/leagues/${leagueId}`
    + `?view=mTeam&view=mRoster&view=mSettings`;
  const data = await espnGet(url, creds);
  const teams = Array.isArray(data?.teams) ? data.teams : [];
  const team = teams.find((t) => t.id === teamId) || null;
  const name = (t) => `${t.location || ''} ${t.nickname || ''}`.trim() || t.name || t.abbrev || `Team ${t.id}`;
  return {
    leagueId,
    season: seasonId,
    leagueName: data?.settings?.name || `League ${leagueId}`,
    teamCount: teams.length,
    scoringType: data?.settings?.scoringSettings?.scoringType || null,
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
  return { count: discovered.length, truncated: discovered.length > leagues.length, leagues: results, diag };
}
