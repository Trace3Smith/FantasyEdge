// Platform-neutral league configuration — the settings half of the League DNA event timeline.
//
// Every platform adapter (ESPN today: espnLeagueConfig.js) translates its own payload into ONE
// shape, so everything downstream reads a league's rules without knowing where they came from.
// The shape is built around dated events: the draft and the trade deadline are stored as ISO
// timestamps, not week numbers, because a week number means nothing until it is paired with a
// schedule — and schedules differ by sport, by platform, and by league.
//
//   {
//     schemaVersion, platform, sport, leagueId, season, name, teamCount, fetchedAt,
//     scoring:     { format, formatRaw, ppr },
//     draft:       { type, date, roomOpensAt, orderType, pickOrder, secondsPerPick, keeperCount },
//     acquisition: { system, typeRaw, budget, limit, waiverHours, processHour, processDays },
//     trade:       { deadline, reviewHours, vetoVotesRequired, limit },
//   }
//
// Conventions, so adapters agree:
//   • null means UNKNOWN or NOT APPLICABLE, never a guessed default. A missing trade deadline is
//     null, not "end of season"; an unmapped format is null with formatRaw kept for inspection.
//   • An unlimited count (ESPN sends -1) is also null — `limit: null` reads as "no limit".
//   • Ids (leagueId, pickOrder team ids) are strings: Yahoo team keys aren't numbers.
//   • `ppr` is NFL-only. Every other sport stores null, so "not applicable" is never confused with
//     standard scoring (0).

// Bump when the shape changes. getLeagueConfig treats a stored record at another version as a
// miss, so the caller refetches from the platform instead of reading a stale shape.
export const LEAGUE_CONFIG_VERSION = 1;

export const PLATFORMS = new Set(['espn', 'yahoo', 'sleeper']);
// The sports League DNA learns from: the draft-and-roster games. Golf is deliberately absent and must
// stay that way. Its pick'em/tournament format has no draft or roster construction for the model to
// learn from, so no golf league is ever validated or recorded, whichever path tries. This gates only
// the config write; golf works normally everywhere else in the app.
export const SPORTS = new Set(['nfl', 'mlb', 'nba', 'wnba', 'nhl']);
export const SCORING_FORMATS = new Set([
  'h2h_points', 'h2h_categories', 'h2h_most_categories', 'roto', 'season_points',
]);
export const ACQUISITION_SYSTEMS = new Set(['faab', 'waivers', 'free_agency']);

// One record per league per season. Sport sits in the key because a league id is only unique
// within a platform's game: ESPN's football and baseball games number their leagues
// independently, so `league:espn:18491:2026` could name two unrelated leagues.
export const leagueConfigKey = ({ platform, sport, leagueId, season }) =>
  `league:${platform}:${sport}:${leagueId}:${season}:config`;

// Epoch milliseconds → ISO string, or null for anything that isn't a real moment. Platforms
// use 0 / negative / absent for "not set", and none of those may become 1970-01-01.
export function isoFromMs(ms) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n) || n <= 0) return null;
  return new Date(n).toISOString();
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const isIsoOrNull = (v) => v === null || (typeof v === 'string' && ISO_RE.test(v));
const isIntOrNull = (v) => v === null || Number.isInteger(v);

// Structural check. Returns a list of problems (empty = valid) rather than throwing, so a caller
// can log exactly what an adapter got wrong.
export function validateLeagueConfig(cfg) {
  const errs = [];
  if (!cfg || typeof cfg !== 'object') return ['config is not an object'];
  if (cfg.schemaVersion !== LEAGUE_CONFIG_VERSION) errs.push(`schemaVersion ${cfg.schemaVersion} != ${LEAGUE_CONFIG_VERSION}`);
  if (!PLATFORMS.has(cfg.platform)) errs.push(`unknown platform ${cfg.platform}`);
  if (!SPORTS.has(cfg.sport)) errs.push(`unknown sport ${cfg.sport}`);
  if (typeof cfg.leagueId !== 'string' || !cfg.leagueId) errs.push('leagueId must be a non-empty string');
  if (!Number.isInteger(cfg.season)) errs.push('season must be an integer');
  if (!isIsoOrNull(cfg.fetchedAt) || cfg.fetchedAt === null) errs.push('fetchedAt must be an ISO timestamp');
  if (!isIntOrNull(cfg.teamCount)) errs.push('teamCount must be an integer or null');

  const s = cfg.scoring || {};
  if (s.format !== null && !SCORING_FORMATS.has(s.format)) errs.push(`unknown scoring.format ${s.format}`);
  if (cfg.sport === 'nfl') {
    if (s.ppr !== null && !(typeof s.ppr === 'number' && Number.isFinite(s.ppr))) errs.push('scoring.ppr must be a number or null');
  } else if (s.ppr !== null) {
    errs.push(`scoring.ppr is NFL-only; got ${s.ppr} for ${cfg.sport}`);
  }

  const d = cfg.draft || {};
  if (!isIsoOrNull(d.date)) errs.push('draft.date must be ISO or null');
  if (!isIsoOrNull(d.roomOpensAt)) errs.push('draft.roomOpensAt must be ISO or null');
  if (!Array.isArray(d.pickOrder) || d.pickOrder.some((id) => typeof id !== 'string')) errs.push('draft.pickOrder must be an array of string ids');

  const a = cfg.acquisition || {};
  if (a.system !== null && !ACQUISITION_SYSTEMS.has(a.system)) errs.push(`unknown acquisition.system ${a.system}`);

  const t = cfg.trade || {};
  if (!isIsoOrNull(t.deadline)) errs.push('trade.deadline must be ISO or null');
  return errs;
}

// Redis I/O takes the client as an argument (as espnFantasy.js does), so this module never opens
// a connection on import and the checks run offline.
export async function saveLeagueConfig(redis, cfg) {
  const errs = validateLeagueConfig(cfg);
  if (errs.length) throw new Error(`invalid league config: ${errs.join('; ')}`);
  await redis.set(leagueConfigKey(cfg), cfg);
  return cfg;
}

// Returns the stored config, or null on a miss — including a record written at another schema
// version, which the caller should refetch and overwrite.
export async function getLeagueConfig(redis, ids) {
  const cfg = await redis.get(leagueConfigKey(ids));
  if (!cfg || cfg.schemaVersion !== LEAGUE_CONFIG_VERSION) return null;
  return cfg;
}

// Best-effort write for the request and cron paths, which record a config because they happened to
// fetch the league for something else. Never throws: saving league settings must not break the page
// or the lineup run that carried them. Anything outside SPORTS (golf) is refused before validation
// runs. An invalid config is logged, so an adapter bug still shows up, and skipped. Returns whether
// it was written.
export async function recordLeagueConfig(redis, cfg) {
  if (!cfg || !SPORTS.has(cfg.sport)) return false;
  try {
    await saveLeagueConfig(redis, cfg);
    return true;
  } catch (err) {
    console.warn(`[leagueConfig] not recorded ${cfg.platform}:${cfg.sport}:${cfg.leagueId}: ${err.message || err}`);
    return false;
  }
}
