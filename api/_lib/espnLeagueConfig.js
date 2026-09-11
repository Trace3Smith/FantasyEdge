// ESPN adapter for leagueConfig.js: v3 league payload (view=mSettings) → platform-neutral config.
//
// Pure — no network, no Redis. Pass it the JSON fetchLeagueSettings() returns (or any v3 league
// response that includes `settings`). Field meanings below are pinned to a real payload, Superstars
// League AL (MLB, league 18491, 2026), and scripts/check-league-config.mjs asserts against it:
//
//   draftSettings.date           1774310400000  → draft.date        2026-03-24T00:00:00.000Z
//   draftSettings.availableDate  1774306800000  → draft.roomOpensAt (one hour earlier)
//   tradeSettings.deadlineDate   1788192000000  → trade.deadline    2026-08-31T16:00:00.000Z
//   acquisitionLimit / max       -1             → null (unlimited)
//
// ESPN keeps `date` on a draft that has already happened, so a completed draft still has a date.

import { LEAGUE_CONFIG_VERSION, isoFromMs } from './leagueConfig.js';

// ESPN scoringType → normalized format. Matched by pattern, the same way espnScoring.js's
// scoringLabel reads it, rather than by an exact-string table: the only value confirmed from a real
// league is H2H_POINTS, and a pattern survives spelling variants (H2H_CATEGORY vs H2H_CATEGORIES).
// MOST is tested before CATEGOR because "H2H_MOST_CATEGORIES" contains both.
export function espnScoringFormat(typeRaw) {
  const t = String(typeRaw || '').toUpperCase();
  if (!t) return null;
  if (t.includes('ROTO')) return 'roto';
  if (t.includes('MOST')) return 'h2h_most_categories';
  if (t.includes('CATEGOR')) return t.startsWith('H2H') ? 'h2h_categories' : null;
  if (t.includes('POINT')) return t.startsWith('H2H') ? 'h2h_points' : 'season_points';
  return null;
}

// Points per reception, from scoringItems statId 53 (the same id lineupAdvisor's nflScoringOf and
// fetchLeagueAllTeams read). Stored as the number, not a 'ppr'/'half'/'standard' label, so a 0.25
// league isn't rounded into a bucket; nflScoringOf still turns it into a label. NFL with no receptions
// item is standard (0). Every other sport is null — not applicable.
export function espnPpr(scoringSettings, sport) {
  if (sport !== 'nfl') return null;
  const items = Array.isArray(scoringSettings?.scoringItems) ? scoringSettings.scoringItems : null;
  if (!items) return null; // no scoring items at all: unknown, not standard
  const rec = items.find((it) => it.statId === 53);
  return rec && typeof rec.points === 'number' ? rec.points : 0;
}

// ESPN's "unlimited" is -1; anything else that isn't a non-negative integer is unknown.
const countOrNull = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lower = (v) => (typeof v === 'string' && v ? v.toLowerCase() : null);

// Budget flag first: a FAAB league still reports a WAIVERS_* acquisitionType. Only the WAIVERS_
// prefix is confirmed from real data (WAIVERS_TRADITIONAL); anything else stays null with typeRaw
// kept, rather than being guessed into free agency.
function acquisitionSystem(acq) {
  if (acq.isUsingAcquisitionBudget === true) return 'faab';
  if (String(acq.acquisitionType || '').toUpperCase().startsWith('WAIVERS')) return 'waivers';
  return null;
}

export function espnLeagueConfig(data, { sport, leagueId, season, fetchedAt = new Date().toISOString() }) {
  const s = data?.settings || {};
  const draft = s.draftSettings || {};
  const acq = s.acquisitionSettings || {};
  const trade = s.tradeSettings || {};
  const teams = Array.isArray(data?.teams) ? data.teams : null;

  return {
    schemaVersion: LEAGUE_CONFIG_VERSION,
    platform: 'espn',
    sport,
    leagueId: String(leagueId),
    season: Number(season),
    name: s.name || null,
    teamCount: countOrNull(s.size) ?? (teams ? teams.length : null),
    fetchedAt,
    scoring: {
      format: espnScoringFormat(s.scoringSettings?.scoringType),
      formatRaw: s.scoringSettings?.scoringType || null,
      ppr: espnPpr(s.scoringSettings, sport),
    },
    draft: {
      type: lower(draft.type), // 'snake' | 'auction' | … as ESPN names it
      date: isoFromMs(draft.date),
      roomOpensAt: isoFromMs(draft.availableDate),
      orderType: lower(draft.orderType),
      pickOrder: Array.isArray(draft.pickOrder) ? draft.pickOrder.map(String) : [],
      secondsPerPick: countOrNull(draft.timePerSelection),
      keeperCount: countOrNull(draft.keeperCount),
    },
    acquisition: {
      system: acquisitionSystem(acq),
      typeRaw: acq.acquisitionType || null,
      budget: acq.isUsingAcquisitionBudget ? numOrNull(acq.acquisitionBudget) : null,
      limit: countOrNull(acq.acquisitionLimit),
      waiverHours: countOrNull(acq.waiverHours),
      // Hour of day ESPN processes waivers. The timezone isn't stated in the payload, so this is
      // stored as ESPN gives it and not converted to a timestamp.
      processHour: countOrNull(acq.waiverProcessHour),
      processDays: Array.isArray(acq.waiverProcessDays) ? acq.waiverProcessDays.slice() : [],
    },
    trade: {
      deadline: isoFromMs(trade.deadlineDate),
      reviewHours: countOrNull(trade.revisionHours),
      vetoVotesRequired: countOrNull(trade.vetoVotesRequired),
      limit: countOrNull(trade.max),
    },
  };
}
