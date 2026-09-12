#!/usr/bin/env node
// Offline checks for the League DNA config layer: the platform-neutral schema (leagueConfig.js) and
// the ESPN adapter (espnLeagueConfig.js). No ESPN session or Redis needed — a Map stands in for Redis.
//
// The MLB fixture is the real settings payload from Superstars League AL (league 18491, 2026), so the
// timestamp and -1 → null assertions pin what ESPN actually sent, not what we assumed it sends.
//
// Usage:  npm run check:league-config      Exit: 0 clean · 1 a check failed
import { readFileSync } from 'node:fs';
import {
  leagueConfigKey, validateLeagueConfig, saveLeagueConfig, getLeagueConfig, recordLeagueConfig, isoFromMs, LEAGUE_CONFIG_VERSION, SPORTS,
} from '../api/_lib/leagueConfig.js';
import { espnLeagueConfig, espnScoringFormat, espnPpr } from '../api/_lib/espnLeagueConfig.js';
import { discoverFanLeagues, fetchLeagueRoster, fetchAllLeagueConfigs } from '../api/_lib/espnFantasy.js';

let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); };

// Real payload (settings blocks verbatim); name/size/scoringType are the league's own.
const superstars = {
  settings: {
    name: 'Superstars League AL',
    size: 12,
    scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [] },
    draftSettings: {
      keeperOrderType: 'TRADITIONAL', leagueSubType: 'NONE',
      availableDate: 1774306800000, date: 1774310400000,
      isTradingEnabled: true, keeperCount: 0, keeperCountFuture: 0,
      orderType: 'MANUAL', pickOrder: [9, 5, 10, 13, 7, 4, 12, 1, 6, 3, 2, 11],
      timePerSelection: 60, type: 'SNAKE',
    },
    acquisitionSettings: {
      acquisitionBudget: 0, acquisitionLimit: -1,
      acquisitionType: 'WAIVERS_TRADITIONAL',
      isUsingAcquisitionBudget: false, waiverHours: 24,
      waiverOrderReset: false, waiverProcessDays: [],
      waiverProcessHour: 3,
    },
    tradeSettings: {
      allowOutOfUniverse: false, deadlineDate: 1788192000000,
      max: -1, revisionHours: 24, vetoVotesRequired: 4,
    },
  },
};
const FETCHED = '2026-09-11T12:00:00.000Z';
const mlb = espnLeagueConfig(superstars, { sport: 'mlb', leagueId: 18491, season: 2026, fetchedAt: FETCHED });

console.log('offline — Redis key');
{
  check('sport is in the key', leagueConfigKey(mlb) === 'league:espn:mlb:18491:2026:config', leagueConfigKey(mlb));
  // The reason sport is in the key: the same ESPN league id in two games is two different leagues.
  check('same id, different sport → different key',
    leagueConfigKey({ ...mlb, sport: 'nfl' }) !== leagueConfigKey(mlb));
}

console.log('\noffline — timestamps (real Superstars payload)');
{
  check('draft date is ISO', mlb.draft.date === '2026-03-24T00:00:00.000Z', mlb.draft.date);
  check('draft room opens an hour earlier', mlb.draft.roomOpensAt === '2026-03-23T23:00:00.000Z', mlb.draft.roomOpensAt);
  check('trade deadline is ISO, not a week', mlb.trade.deadline === '2026-08-31T16:00:00.000Z', mlb.trade.deadline);
  // "Not set" must never become 1970-01-01.
  check('0, negative, null and junk are null', [0, -1, null, undefined, 'x', NaN].every((v) => isoFromMs(v) === null));
  const noDeadline = espnLeagueConfig({ settings: { tradeSettings: { deadlineDate: 0 } } },
    { sport: 'mlb', leagueId: '1', season: 2026, fetchedAt: FETCHED });
  check('a missing trade deadline stays null', noDeadline.trade.deadline === null && noDeadline.draft.date === null);
}

console.log('\noffline — the rest of the Superstars mapping');
{
  check('identity fields', mlb.platform === 'espn' && mlb.sport === 'mlb' && mlb.leagueId === '18491' && mlb.season === 2026);
  check('name and team count', mlb.name === 'Superstars League AL' && mlb.teamCount === 12);
  check('snake draft, manual order', mlb.draft.type === 'snake' && mlb.draft.orderType === 'manual');
  check('pick order kept in order, as string ids',
    mlb.draft.pickOrder.join(',') === '9,5,10,13,7,4,12,1,6,3,2,11' && mlb.draft.pickOrder.every((x) => typeof x === 'string'));
  check('60s per pick, no keepers', mlb.draft.secondsPerPick === 60 && mlb.draft.keeperCount === 0);
  check('traditional waivers, not FAAB', mlb.acquisition.system === 'waivers' && mlb.acquisition.budget === null);
  check('-1 acquisition limit is unlimited (null)', mlb.acquisition.limit === null);
  check('waiver timing kept as given', mlb.acquisition.waiverHours === 24 && mlb.acquisition.processHour === 3
    && Array.isArray(mlb.acquisition.processDays) && mlb.acquisition.processDays.length === 0);
  check('-1 trade max is unlimited (null)', mlb.trade.limit === null);
  check('trade review and veto', mlb.trade.reviewHours === 24 && mlb.trade.vetoVotesRequired === 4);
  check('the adapter output validates', validateLeagueConfig(mlb).length === 0, validateLeagueConfig(mlb).join('; '));
}

console.log('\noffline — scoring format and the NFL-only ppr field');
{
  check('H2H_POINTS → h2h_points', mlb.scoring.format === 'h2h_points' && mlb.scoring.formatRaw === 'H2H_POINTS');
  check('MLB carries no ppr (null, not 0)', mlb.scoring.ppr === null);
  check('roto', espnScoringFormat('ROTO') === 'roto');
  check('most-categories is not read as categories', espnScoringFormat('H2H_MOST_CATEGORIES') === 'h2h_most_categories');
  check('categories, either spelling', espnScoringFormat('H2H_CATEGORY') === 'h2h_categories' && espnScoringFormat('H2H_CATEGORIES') === 'h2h_categories');
  check('non-H2H points is season points', espnScoringFormat('TOTAL_POINTS') === 'season_points');
  check('unknown or empty is null, not guessed', espnScoringFormat('SOMETHING_NEW') === null && espnScoringFormat('') === null);

  const nfl = (items) => ({ scoringType: 'H2H_POINTS', scoringItems: items });
  check('full PPR', espnPpr(nfl([{ statId: 53, points: 1 }]), 'nfl') === 1);
  check('half PPR', espnPpr(nfl([{ statId: 53, points: 0.5 }]), 'nfl') === 0.5);
  check('quarter PPR kept exact, not bucketed', espnPpr(nfl([{ statId: 53, points: 0.25 }]), 'nfl') === 0.25);
  check('no receptions item is standard (0)', espnPpr(nfl([{ statId: 3, points: 0.04 }]), 'nfl') === 0);
  check('no scoring items at all is unknown (null)', espnPpr({ scoringType: 'H2H_POINTS' }, 'nfl') === null);
  check('ppr is null for every non-NFL sport', ['mlb', 'nba', 'wnba', 'nhl'].every((sp) => espnPpr(nfl([{ statId: 53, points: 1 }]), sp) === null));

  const ffl = espnLeagueConfig({ settings: { size: 10, scoringSettings: nfl([{ statId: 53, points: 0.5 }]) } },
    { sport: 'nfl', leagueId: '555', season: 2026, fetchedAt: FETCHED });
  check('an NFL config carries its ppr and validates', ffl.scoring.ppr === 0.5 && validateLeagueConfig(ffl).length === 0,
    validateLeagueConfig(ffl).join('; '));
}

console.log('\noffline — every sport, pinned to a real ESPN payload');
{
  // One captured mSettings response per sport, in scripts/fixtures/league-settings/ (see the README
  // there). These exist so no sport is ever assumed to map the way its neighbours do — the assumption
  // behind #99, where nflForm read ESPN's baseball game for an NFL league.
  //
  // Expected values below are what the capture actually returned, not what the schema permits. If a
  // league's settings are changed on ESPN, the right fix is to re-capture and update BOTH, not to
  // loosen the assertion.
  const raw = (f) => JSON.parse(readFileSync(new URL(`./fixtures/league-settings/${f}.json`, import.meta.url)));
  const REAL = [
    { f: 'nfl-1437029-2026', sport: 'nfl', leagueId: '1437029', season: 2026,
      name: 'Florida Georgia Line', teams: 10, format: 'h2h_points', formatRaw: 'H2H_POINTS', ppr: 1,
      draftAt: '2026-09-06T23:30:00.000Z', order: 'draft_start', perPick: 90, deadline: null, veto: 4 },
    { f: 'mlb-18363-2026', sport: 'mlb', leagueId: '18363', season: 2026,
      name: 'Superstars League- NL', teams: 12, format: 'roto', formatRaw: 'ROTO', ppr: null,
      draftAt: '2026-03-25T00:00:00.000Z', order: 'manual', perPick: 60, deadline: '2026-08-31T16:00:00.000Z', veto: 4 },
    { f: 'nba-117597-2027', sport: 'nba', leagueId: '117597', season: 2027,
      name: 'Superstars League', teams: 12, format: 'roto', formatRaw: 'ROTO', ppr: null,
      draftAt: '2026-10-15T01:00:00.000Z', order: 'manual', perPick: 60, deadline: '2027-03-08T17:00:00.000Z', veto: 3 },
    { f: 'wnba-649986145-2026', sport: 'wnba', leagueId: '649986145', season: 2026,
      name: 'Welcome to the W', teams: 8, format: 'h2h_points', formatRaw: 'H2H_POINTS', ppr: null,
      draftAt: '2026-05-05T00:30:00.000Z', order: 'draft_start', perPick: 60, deadline: '2026-08-03T16:00:00.000Z', veto: 3 },
    { f: 'nhl-28525-2027', sport: 'nhl', leagueId: '28525', season: 2027,
      name: 'Superstars League', teams: 12, format: 'roto', formatRaw: 'ROTO', ppr: null,
      draftAt: '2026-09-25T01:00:00.000Z', order: 'manual', perPick: 60, deadline: '2027-02-26T17:00:00.000Z', veto: 3 },
  ];

  check('every sport League DNA records has a real payload behind it',
    REAL.length === SPORTS.size && REAL.every((r) => SPORTS.has(r.sport)),
    `fixtures ${REAL.map((r) => r.sport).sort().join(',')} vs SPORTS ${[...SPORTS].sort().join(',')}`);

  for (const r of REAL) {
    const cfg = espnLeagueConfig(raw(r.f), { sport: r.sport, leagueId: r.leagueId, season: r.season, fetchedAt: FETCHED });
    const errs = validateLeagueConfig(cfg);
    const d = cfg.draft, a = cfg.acquisition, t = cfg.trade;
    check(`${r.sport}: validates`, errs.length === 0, errs.join('; '));
    check(`${r.sport}: name and team count`, cfg.name === r.name && cfg.teamCount === r.teams,
      `${cfg.name} / ${cfg.teamCount}`);
    check(`${r.sport}: scoring ${r.format}`, cfg.scoring.format === r.format && cfg.scoring.formatRaw === r.formatRaw,
      `${cfg.scoring.format} (${cfg.scoring.formatRaw})`);
    check(`${r.sport}: ppr ${r.ppr}`, cfg.scoring.ppr === r.ppr, String(cfg.scoring.ppr));
    check(`${r.sport}: draft ${r.order} at ${r.draftAt}`,
      d.type === 'snake' && d.orderType === r.order && d.date === r.draftAt && d.secondsPerPick === r.perPick,
      `${d.type}/${d.orderType}/${d.date}/${d.secondsPerPick}`);
    check(`${r.sport}: trade deadline ${r.deadline}`, t.deadline === r.deadline && t.vetoVotesRequired === r.veto,
      `${t.deadline} veto ${t.vetoVotesRequired}`);
    check(`${r.sport}: -1 limits read as unlimited`, a.limit === null && t.limit === null,
      `acq ${a.limit} trade ${t.limit}`);
    check(`${r.sport}: traditional waivers, no FAAB budget`, a.system === 'waivers' && a.budget === null,
      `${a.system} budget ${a.budget}`);
  }

  // The single most valuable thing these payloads proved. ESPN ships a non-zero acquisitionBudget on
  // leagues that do not use FAAB at all — four of these five carry 100 next to
  // isUsingAcquisitionBudget: false. Reading acquisitionBudget directly, as an adapter reasonably
  // might, would invent a $100 FAAB league four times over. The budget FLAG is what decides.
  const stale = REAL.filter((r) => raw(r.f).settings.acquisitionSettings.acquisitionBudget > 0);
  check('a budget ESPN sends but the league does not use never becomes FAAB',
    stale.length === 4 && stale.every((r) => {
      const a = espnLeagueConfig(raw(r.f), { sport: r.sport, leagueId: r.leagueId, season: r.season, fetchedAt: FETCHED }).acquisition;
      return a.system === 'waivers' && a.budget === null;
    }), `${stale.length} leagues carry an unused budget`);

  // NFL omits tradeSettings.deadlineDate entirely rather than sending 0 — the key is simply absent.
  // null therefore means "ESPN did not say", not "there is no deadline", and nothing downstream may
  // read it as the latter.
  const nflRaw = raw('nfl-1437029-2026').settings.tradeSettings;
  check('an absent NFL trade deadline is null, not a date',
    !('deadlineDate' in nflRaw) && espnLeagueConfig(raw('nfl-1437029-2026'),
      { sport: 'nfl', leagueId: '1437029', season: 2026, fetchedAt: FETCHED }).trade.deadline === null);

  // Cheap standing guard on the promise the v2 consent notice makes. view=mSettings carried no member
  // names or ids at capture time; anything captured from the draft or transaction views will not be
  // clean this way and must be scrubbed before it is committed beside these.
  const ident = /"(displayName|firstName|lastName|memberId|owners|userProfileId|email)"|\{[0-9A-F]{8}-[0-9A-F]{4}-/i;
  const dirty = REAL.filter((r) => ident.test(readFileSync(new URL(`./fixtures/league-settings/${r.f}.json`, import.meta.url), 'utf8')));
  check('no committed payload carries a member name, member id or SWID', dirty.length === 0,
    dirty.map((r) => r.f).join(', '));
}

console.log('\noffline — acquisition system');
{
  const acq = (a) => espnLeagueConfig({ settings: { acquisitionSettings: a } },
    { sport: 'nfl', leagueId: '1', season: 2026, fetchedAt: FETCHED }).acquisition;
  const faab = acq({ acquisitionType: 'WAIVERS_TRADITIONAL', isUsingAcquisitionBudget: true, acquisitionBudget: 100 });
  check('the budget flag wins over a WAIVERS_ type', faab.system === 'faab' && faab.budget === 100);
  check('an unrecognised type is null, typeRaw kept', acq({ acquisitionType: 'NEW_THING' }).system === null
    && acq({ acquisitionType: 'NEW_THING' }).typeRaw === 'NEW_THING');
}

console.log('\noffline — validation');
{
  const bad = (patch) => validateLeagueConfig({ ...mlb, ...patch });
  check('ppr on a non-NFL sport is rejected', bad({ scoring: { ...mlb.scoring, ppr: 1 } }).length > 0);
  check('a week number as a deadline is rejected', bad({ trade: { ...mlb.trade, deadline: 21 } }).length > 0);
  check('an unknown format is rejected', bad({ scoring: { ...mlb.scoring, format: 'H2H_POINTS' } }).length > 0);
  check('a numeric leagueId is rejected', bad({ leagueId: 18491 }).length > 0);
  check('a stale schemaVersion is rejected', bad({ schemaVersion: LEAGUE_CONFIG_VERSION - 1 }).length > 0);
}

console.log('\noffline — Redis round trip (in-memory stand-in)');
{
  const store = new Map();
  const fake = { set: async (k, v) => { store.set(k, structuredClone(v)); }, get: async (k) => store.get(k) ?? null };
  await saveLeagueConfig(fake, mlb);
  check('saved under the config key', store.has('league:espn:mlb:18491:2026:config'));
  const back = await getLeagueConfig(fake, { platform: 'espn', sport: 'mlb', leagueId: '18491', season: 2026 });
  check('reads back identical', JSON.stringify(back) === JSON.stringify(mlb));
  check('the NFL key for the same id is a miss', await getLeagueConfig(fake, { platform: 'espn', sport: 'nfl', leagueId: '18491', season: 2026 }) === null);
  store.set(leagueConfigKey(mlb), { ...mlb, schemaVersion: 0 });
  check('an old-version record reads as a miss', await getLeagueConfig(fake, mlb) === null);
  let threw = false;
  try { await saveLeagueConfig(fake, { ...mlb, scoring: { ...mlb.scoring, ppr: 1 } }); } catch { threw = true; }
  check('an invalid config is never written', threw);
}

console.log('\noffline — recording: League DNA sports only, never golf');
{
  const store = new Map();
  const fake = { set: async (k, v) => { store.set(k, structuredClone(v)); }, get: async (k) => store.get(k) ?? null };
  const warn = console.warn; console.warn = () => {}; // the invalid case warns by design
  check('a valid MLB config is recorded', await recordLeagueConfig(fake, mlb) === true && store.has(leagueConfigKey(mlb)));
  for (const sp of ['golf', 'pga']) {
    const g = { ...mlb, sport: sp };
    check(`a ${sp} config is never recorded`, await recordLeagueConfig(fake, g) === false && !store.has(leagueConfigKey(g)));
  }
  const broken = { ...mlb, leagueId: '777', trade: { ...mlb.trade, deadline: 21 } };
  check('an invalid config is skipped, not thrown', await recordLeagueConfig(fake, broken) === false && !store.has(leagueConfigKey(broken)));
  check('a missing config is skipped', await recordLeagueConfig(fake, null) === false && await recordLeagueConfig(fake, undefined) === false);
  console.warn = warn;
}

console.log('\noffline — ESPN wiring (fetch stubbed, no network)');
{
  const creds = { espn_s2: 'x', swid: '{00000000-0000-0000-0000-000000000000}' };
  const entry = (abbrev, groupId, entryId, groupName) =>
    ({ type: { type: 'x' }, metaData: { entry: { abbrev, seasonId: 2026, entryId, groups: [{ groupId, groupName }] } } });
  const fan = { preferences: [
    entry('FLB', 18491, 3, 'Superstars League AL'),
    entry('FFL', 555, 7, 'Sunday League'),
    entry('FHL', 777, 4, 'Ice League'),
    entry('PGA', 999, 1, "Golf Pick'em"), // anything outside the five sports
    entry('', 888, 2, 'Unlabelled'),
  ] };
  const nflSettings = { settings: { name: 'Sunday League', size: 10,
    scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [{ statId: 53, points: 0.5 }] } } };
  const mlbLeague = { ...superstars, teams: [{ id: 3, location: 'Team', nickname: 'Three', roster: { entries: [] } }] };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    const body = u.includes('fan.api') ? fan : u.includes('/games/ffl/') ? nflSettings : mlbLeague;
    return { ok: true, status: 200, json: async () => structuredClone(body), text: async () => '' };
  };
  try {
    const { leagues } = await discoverFanLeagues(creds, 'all');
    check('all-sport discovery tags each league with its sport',
      leagues.length === 3 && leagues.some((l) => l.sport === 'mlb' && l.leagueId === '18491')
        && leagues.some((l) => l.sport === 'nfl' && l.leagueId === '555')
        && leagues.some((l) => l.sport === 'nhl' && l.leagueId === '777'),
      JSON.stringify(leagues.map((l) => [l.sport, l.leagueId])));
    check('...and drops anything outside the five sports, unlabelled entries included',
      !leagues.some((l) => ['999', '888'].includes(l.leagueId)));
    // Single-sport mode keeps its old behaviour: an unlabelled entry is tolerated, other games are not.
    const mlbOnly = (await discoverFanLeagues(creds, 'mlb')).leagues.map((l) => l.leagueId).sort().join(',');
    check('single-sport discovery is unchanged', mlbOnly === '18491,888', mlbOnly);

    const configs = await fetchAllLeagueConfigs(creds);
    check('connect-time capture builds a valid config per league',
      configs.length === 3 && configs.every((c) => validateLeagueConfig(c).length === 0));
    check("...each read from its own sport's ESPN game, settings only",
      configs.find((c) => c.sport === 'nfl')?.scoring.ppr === 0.5
        && seen.some((u) => u.endsWith('/games/ffl/seasons/2026/segments/0/leagues/555?view=mSettings')));
    check('...and none for golf', !configs.some((c) => c.leagueId === '999') && !seen.some((u) => u.includes('/leagues/999')));
    check('...including the NHL league, from the hockey game',
      configs.some((c) => c.sport === 'nhl' && c.leagueId === '777')
        && seen.some((u) => u.endsWith('/games/fhl/seasons/2026/segments/0/leagues/777?view=mSettings')));

    const lg = await fetchLeagueRoster(creds, { leagueId: '18491', seasonId: 2026, teamId: 3 }, 'mlb');
    check('a roster fetch carries its league config',
      lg.leagueConfig?.sport === 'mlb' && lg.leagueConfig.trade.deadline === '2026-08-31T16:00:00.000Z'
        && validateLeagueConfig(lg.leagueConfig).length === 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
