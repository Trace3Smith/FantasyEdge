#!/usr/bin/env node
// Capture REAL ESPN league settings payloads, one per sport, so the League DNA adapter can be pinned
// to what ESPN actually sends instead of what we assumed it sends.
//
// Every other check:* script is offline. This one is the opposite and the only one that touches the
// network: it needs a live ESPN session, so it is never part of `npm test` and never runs in CI.
//
// Why it exists: espnLeagueConfig.js was verified against exactly one real payload — Superstars League
// AL (MLB, 18491). Every NFL assertion in check-league-config.mjs is a hand-written object carrying
// only name/size/scoringSettings, and NBA/WNBA/NHL have never had a config built for them at all. The
// draftSettings / acquisitionSettings / tradeSettings mapping — the -1 → null rules, the epoch-ms
// timestamps — is unverified outside baseball. #99 (nflForm reading ESPN's baseball game for an NFL
// league) is what an untested per-sport assumption looks like in production.
//
// Usage:
//   ESPN_S2='AEB...' SWID='{...}' node scripts/capture-league-settings.mjs
//   ESPN_S2='AEB...' SWID='{...}' node scripts/capture-league-settings.mjs nfl wnba
//   ... --out ./somewhere        write the raw payloads elsewhere (default tmp/league-settings/)
//   ... --list                   just show what leagues the account holds, fetch nothing
//
// Cookies come from the environment, never argv: an argument lands in shell history and in `ps`.
// They are used to read settings and nothing else — no writes, no roster reads, no Redis.
//
// Output per league:
//   • tmp/league-settings/<sport>-<leagueId>-<season>.json   the verbatim mSettings response
//   • tmp/league-settings/<sport>-<leagueId>-<season>.fixture.json   just the blocks the adapter
//     reads, ready to paste into check-league-config.mjs beside `superstars`
//   • a printed summary: the mapped config, and whether validateLeagueConfig accepts it
//
// Exit: 0 every selected league mapped and validated · 1 one or more did not · 2 setup problem
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  discoverFanLeagues, fetchLeagueSettings, normalizeS2, normalizeSwid, isValidSwid, EspnAuthError,
} from '../api/_lib/espnFantasy.js';
import { espnLeagueConfig } from '../api/_lib/espnLeagueConfig.js';
import { validateLeagueConfig, SPORTS as DNA_SPORTS } from '../api/_lib/leagueConfig.js';

// The five draft-and-roster games ESPN runs. Deliberately NOT leagueConfig.js's SPORTS: NHL is held
// out of capture there precisely because it is unverified, and this script is how it stops being
// unverified. Gating capture on the set that capture is gated by would be circular.
const CAPTURABLE = ['nfl', 'mlb', 'nba', 'wnba', 'nhl'];

// Hand-rolled, so a sport name is never confused with a flag's value.
const argv = process.argv.slice(2);
let listOnly = false;
let outArg = 'tmp/league-settings';
const wanted = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--list') listOnly = true;
  else if (a === '--out') outArg = argv[++i] ?? outArg;
  else if (a.startsWith('--')) { console.error(`\n  \u2716 unknown flag ${a}\n`); process.exit(2); }
  else wanted.push(a);
}
const outDir = resolve(outArg);

const die = (msg) => { console.error(`\n  ✖ ${msg}\n`); process.exit(2); };
for (const sp of wanted) if (!CAPTURABLE.includes(sp)) die(`unknown sport "${sp}" — one of: ${CAPTURABLE.join(', ')}`);
const sports = wanted.length ? wanted : CAPTURABLE;

// --- session ------------------------------------------------------------------------------------
const espn_s2 = normalizeS2(process.env.ESPN_S2 || '');
const swid = normalizeSwid(process.env.SWID || '');
if (!espn_s2) die('ESPN_S2 is not set. Copy it from fantasy.espn.com the same way the connect panel describes.');
if (!isValidSwid(swid)) die(`SWID is missing or malformed (want {XXXXXXXX-...}). Got: ${swid ? 'a value that did not parse' : 'nothing'}`);
const creds = { espn_s2, swid };

// --- what the account actually holds --------------------------------------------------------------
// One fan call covers every ESPN game at once, so this is also the honest answer to "which sports can
// we even verify?" A sport with no league here cannot be pinned to a real payload, and should stay
// unverified rather than be assumed to work.
console.log(`\nDiscovering leagues for ${swid.slice(0, 10)}…\n`);
let leagues;
try {
  ({ leagues } = await discoverFanLeagues(creds, 'all'));
} catch (err) {
  if (err instanceof EspnAuthError) die('ESPN rejected the cookies (expired session). Log in to fantasy.espn.com again and re-copy both.');
  die(`discovery failed: ${err.message || err}`);
}

const bySport = new Map(CAPTURABLE.map((s) => [s, []]));
for (const lg of leagues) bySport.get(lg.sport)?.push(lg);

console.log('  on this account:');
for (const sp of CAPTURABLE) {
  const found = bySport.get(sp);
  const mark = found.length ? '✅' : '—';
  const detail = found.length ? found.map((l) => `${l.leagueName || '(unnamed)'} [${l.leagueId}/${l.seasonId}]`).join(', ') : 'no league — cannot verify this sport';
  console.log(`   ${mark} ${sp.padEnd(5)} ${detail}`);
}
if (listOnly) { console.log(''); process.exit(0); }

// --- capture ---------------------------------------------------------------------------------------
// Only the blocks espnLeagueConfig.js reads. A committed fixture should carry what the adapter is
// asserted against and nothing more — ESPN's full response is kept beside it, out of git, for when a
// mapping question needs the parts we didn't think mattered.
const fixtureOf = (data) => ({
  settings: {
    name: data?.settings?.name,
    size: data?.settings?.size,
    scoringSettings: data?.settings?.scoringSettings,
    draftSettings: data?.settings?.draftSettings,
    acquisitionSettings: data?.settings?.acquisitionSettings,
    tradeSettings: data?.settings?.tradeSettings,
  },
});

await mkdir(outDir, { recursive: true });
let failed = 0;
let captured = 0;

for (const sport of sports) {
  const found = bySport.get(sport);
  if (!found.length) { console.log(`\n${sport} — skipped, no league on this account`); continue; }
  // One league per sport is enough to pin the mapping; a second would mostly re-assert the same shape.
  const lg = found[0];
  console.log(`\n${sport} — ${lg.leagueName || '(unnamed)'} (league ${lg.leagueId}, season ${lg.seasonId})`);

  let data;
  try {
    data = await fetchLeagueSettings(creds, { leagueId: lg.leagueId, seasonId: lg.seasonId }, sport);
  } catch (err) {
    if (err instanceof EspnAuthError) die('cookies expired mid-run. Re-copy both and start again.');
    failed++;
    console.log(`   ❌ settings fetch failed — ${err.message || err}`);
    continue;
  }
  captured++;

  const stem = `${sport}-${lg.leagueId}-${lg.seasonId}`;
  await writeFile(`${outDir}/${stem}.json`, JSON.stringify(data, null, 2));
  await writeFile(`${outDir}/${stem}.fixture.json`, JSON.stringify(fixtureOf(data), null, 2));
  console.log(`   ↳ ${outDir}/${stem}.json  (+ .fixture.json)`);

  // The part that matters: does the adapter survive contact with this sport?
  //
  // Every sport is in DNA_SPORTS today, but one can be taken out while its mapping is in doubt. Such a
  // sport would fail validation on its name alone, which says nothing about whether the mapping is any
  // good — and that is the one question a capture run for it is asking. So validate the rest under a
  // sport that IS allowed, and report the exclusion on its own line rather than as a failure. Getting
  // this wrong would print a red ❌ for a sport behaving exactly as designed.
  const heldOut = !DNA_SPORTS.has(sport);
  const cfg = espnLeagueConfig(data, { sport, leagueId: lg.leagueId, season: lg.seasonId });
  const errs = validateLeagueConfig(heldOut ? { ...cfg, sport: 'mlb' } : cfg);
  const s = cfg.scoring, a = cfg.acquisition, d = cfg.draft, t = cfg.trade;
  console.log(`      scoring      ${s.format ?? 'null'}  (raw ${s.formatRaw ?? 'none'})${sport === 'nfl' ? `  ppr ${s.ppr}` : ''}`);
  console.log(`      draft        ${d.type ?? 'null'}  ${d.date ?? 'no date'}  order ${d.orderType ?? 'null'}  ${d.secondsPerPick ?? '?'}s/pick`);
  console.log(`      acquisition  ${a.system ?? 'null'}  (raw ${a.typeRaw ?? 'none'})  budget ${a.budget}  limit ${a.limit}`);
  console.log(`      trade        deadline ${t.deadline ?? 'null'}  limit ${t.limit}  veto ${t.vetoVotesRequired}`);
  if (errs.length) { failed++; console.log(`   ❌ validateLeagueConfig rejected it — ${errs.join('; ')}`); }
  else if (s.format === null) { failed++; console.log(`   ❌ scoring format did not map (formatRaw "${s.formatRaw}") — recordLeagueConfig would store a null format`); }
  else if (heldOut) console.log(`   ℹ️  maps cleanly, but ${sport} is not in League DNA's SPORTS — nothing is recorded in production until it is added back in leagueConfig.js. This run is the evidence for doing that.`);
  else console.log('   ✅ maps and validates');
}

// An unmapped format is the failure to expect first: NBA/NHL/WNBA leagues are category and roto far
// more often than MLB head-to-head points is, espnScoringFormat returns null rather than guessing,
// and recordLeagueConfig swallows the rejection — so this would be silent in production.
console.log(`\n${failed ? '❌' : '✅'} captured ${captured} league${captured === 1 ? '' : 's'}, ${failed} problem${failed === 1 ? '' : 's'}`);
console.log(`   raw payloads in ${outDir} (gitignored) — paste a .fixture.json into scripts/check-league-config.mjs to pin it\n`);
process.exit(failed ? 1 : 0);
