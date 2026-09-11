#!/usr/bin/env node
// Reports NFL defense-vs-position (DvP) build health from the public feed, so "is DvP still
// failing?" is one command instead of a 300s authenticated cron trigger or a trawl through
// Vercel logs. Read-only, no secret, no upstream cost — it just reads what the daily cron stored.
//
// FRESHNESS IS max(builtAt, reusedAt), not builtAt alone. DvP ranks only move as games complete,
// so buildNflDvp has a weekly freshness guard: on a day the NFL week hasn't advanced it returns
// `{...prev, reusedAt: now}` and the cron stores THAT — preserving the original builtAt while
// reusedAt carries the write time. In season, builtAt legitimately sits still for up to a week.
// What actually indicates failure is neither timestamp advancing, because the cron writes the key
// only after buildNflDvp returns (a throw skips its redis.set and leaves the old payload).
//
// Usage:  npm run check:dvp            (production)
//         DVP_URL=<url> npm run check:dvp
// Exit:   0 = healthy, or legitimately empty and still being written
//         1 = stale (the cron's DvP step is not writing)
//         2 = could not read the feed
const URL = process.env.DVP_URL || 'https://fantasy-edge-nine.vercel.app/api/sports?feed=nfl-dvp';
const STALE_DAYS = 3; // the cron runs daily; 3 days of no write is a real signal, not a blip

const ageDays = (iso) => Math.max(0, (Date.now() - Date.parse(iso)) / 86400000); // clamp: a future stamp is 'now', not negative
const fmtAge = (d) => (d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(1)}d`);

// OFFLINE FIRST — no network. dvpMatchup used to pass rated=true unconditionally, so the builder's
// MIN_GP guard never reached the AI Report: after one week it would call a matchup favorable/tough.
{
  const { dvpMatchup } = await import('../api/_lib/nflDvp.js');
  let bad = 0;
  const check = (n, ok) => { if (!ok) bad++; console.log(`   ${ok ? '✅' : '❌'} ${n}`); };
  // KC's pass D is 2nd-leakiest of 32; its rush D is 2nd-stingiest.
  const entry = { opp: { abbrev: 'KC', name: 'Chiefs' }, n: 32, oppPassDRank: 31, oppPassYdsAllowed: 280, oppRushDRank: 2, oppRushYdsAllowed: 70 };
  console.log('offline — DvP matchup honours the rated flag');
  check('rated: a leaky pass D reads favorable', dvpMatchup(entry, 'pass', true).lean === 'favorable');
  check('rated: a stingy rush D reads tough', dvpMatchup(entry, 'rush', true).lean === 'tough');
  const early = dvpMatchup(entry, 'pass', false);
  check('unrated: the same matchup reads neutral', early.lean === 'neutral');
  check('...and says it is too early, not "favorable"', /too early/.test(early.reason) && !/favorable|tough/i.test(early.reason));
  check('no flag passed means unrated, never a confident call', dvpMatchup(entry, 'rush').lean === 'neutral');

  // nflMatchupFor: the one helper behind Team Manager's matchup chips and the AI Report.
  console.log('offline — matchup chips: opponent, rating, and how it degrades');
  const { nflMatchupFor, nflNextWeek, espnAbbrev } = await import('../api/_lib/nflDvp.js');
  // BUF hosts KC in week 1; KC is on bye in week 5. KC's pass D is the 2nd-leakiest of 32, its rush D 2nd-best.
  const sched = {
    byes: new Map([[12, 5], [2, 7]]),
    abbrev: new Map([[2, 'BUF'], [12, 'KC']]), idOf: new Map([['BUF', 2], ['KC', 12]]),
    games: new Map([[2, new Map([[1, { oppId: 12, isHome: true, date: 0 }]])], [12, new Map([[1, { oppId: 2, isHome: false, date: 0 }]])]]),
  };
  const table = (season, rated) => ({ season, rated, dvp: {
    KC: { passDRank: 31, passAllowed: 262.4, rushDRank: 2, rushAllowed: 81.3 },
    ...Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`T${i}`, { passDRank: 1, rushDRank: 1 }])) } });
  const mu = (o) => nflMatchupFor({ proTeamId: 2, week: 1, season: 2026, schedule: sched, ...o });
  let m = mu({ pos: 'WR', current: table(2026, true) });
  check('WR vs a bottom pass D rates favorable, from this season', m.opp === 'KC' && m.isHome && m.lean === 'favorable' && m.source === 2026 && !m.prior);
  check('RB vs a top-2 run D rates tough', mu({ pos: 'RB', current: table(2026, true) }).lean === 'tough');
  m = mu({ pos: 'WR', current: table(2026, false), prior: table(2025, true) });
  check('unrated this season falls back to last season, labelled', m.lean === 'favorable' && m.prior && m.source === 2025 && /based on 2025/.test(m.reason));
  m = mu({ pos: 'WR', current: table(2026, false), prior: null });
  check('...and with no prior: the opponent alone, no rating', m.opp === 'KC' && m.lean === null && /too early/.test(m.reason));
  check('a prior from the wrong season is not used', mu({ pos: 'WR', current: null, prior: table(2024, true) }).lean === null);
  check('this season, once rated, beats the prior', mu({ pos: 'WR', current: table(2026, true), prior: table(2025, true) }).prior === false);
  m = mu({ pos: 'K', current: table(2026, true) });
  check('K / D/ST get the opponent, never a DvP rating', m.opp === 'KC' && m.lean === null && m.group === null);
  check('a bye week says bye', nflMatchupFor({ pos: 'WR', proTeamId: 12, week: 5, schedule: sched })?.bye === true);
  check('an unknown team or a week the schedule lacks is null, not a guess',
    nflMatchupFor({ pos: 'WR', proTeamId: 99, week: 1, schedule: sched }) === null
    && nflMatchupFor({ pos: 'WR', proTeamId: 2, week: 3, schedule: sched }) === null
    && nflMatchupFor({ pos: 'WR', proTeamId: 2, week: 1, schedule: null }) === null);
  check("the dataset's WAS maps to ESPN's WSH", espnAbbrev('WAS') === 'WSH' && espnAbbrev('KC') === 'KC');
  // nflNextWeek: the AI Report's "this week", from game times, never the scoreboard's week number.
  const now = Date.UTC(2026, 8, 12), day = 86400e3;
  const s2 = { games: new Map([[2, new Map([[1, { date: now - 2 * day }], [2, { date: now + 3 * day }]])], [12, new Map([[1, { date: now + 20 * day }]])], [7, new Map([[1, { date: now - 3600e3 }]])]]) };
  check('next week is the next unfinished game', nflNextWeek(s2, 2, now) === 2);
  check('a game in progress is still this week', nflNextWeek(s2, 7, now) === 1);
  check('a next game weeks away (preseason) gives no matchup', nflNextWeek(s2, 12, now) === null);
  if (bad) { console.log(`\n${bad} offline check(s) FAILED`); process.exit(1); }
  console.log('');
}

let feed;
try {
  const res = await fetch(URL, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  feed = await res.json();
} catch (err) {
  console.error(`could not read the DvP feed: ${err.message}\n  ${URL}`);
  process.exit(2);
}

const { season, week, rated, builtAt, reusedAt, staleReason, counts = {}, teams = {} } = feed;
const written = [builtAt, reusedAt].filter(Boolean).sort().pop() || null; // the later of the two
const games = counts.games ?? 0;
const nTeams = Object.keys(teams).length;

console.log(`DvP feed  ${URL}`);
console.log(`  season ${season ?? '—'}  week ${week ?? '—'}  rated ${!!rated}`);
console.log(`  builtAt  ${builtAt ?? '—'}`);
console.log(`  reusedAt ${reusedAt ?? '—'}`);
console.log(`  games ${games}  teams rated ${counts.teamsRanked ?? nTeams}`);
if (staleReason) console.log(`  staleReason: ${staleReason}`);

if (!written) {
  console.log(`\nNEVER BUILT — the key holds no payload. Expected before the first successful cron DvP build.`);
  process.exit(1);
}
const age = ageDays(written);
console.log(`  last written ${fmtAge(age)} ago\n`);

if (age > STALE_DAYS) {
  console.log(`STALE — nothing written for ${fmtAge(age)} while the daily cron keeps running.`);
  console.log(`The DvP step is throwing and leaving the old payload in place (its redis.set is skipped`);
  console.log(`on a throw). The known cause is ESPN/Akamai rate-limiting by egress IP — DvP runs last`);
  console.log(`in the cron, after thousands of upstream calls, so it is the step that eats the 403.`);
  process.exit(1);
}
if (staleReason) {
  console.log(`DEGRADED — the payload is current but it was REUSED, not rebuilt: buildNflDvp could not`);
  console.log(`reach the scoreboard and fell back to the cached payload (the #51 fallback doing its job).`);
  console.log(`Data is still served, but DvP is not actually refreshing. Reason: ${staleReason}`);
  process.exit(1);
}
if (rated && games > 0) {
  console.log(`HEALTHY — rebuilt within ${fmtAge(age)}, ${games} games aggregated across ${counts.teamsRanked ?? nTeams} teams.`);
  process.exit(0);
}
if (games > 0) {
  // Weeks 1-4: games are in, but not every team has MIN_GP yet, so ranks exist and are unrated —
  // the synopsis reads every matchup as neutral until they are. Current and correct, not empty.
  console.log(`RATING PENDING — rebuilt within ${fmtAge(age)}, ${games} games aggregated, but not every team`);
  console.log(`has enough games for a favorable/tough call yet. Matchups read neutral until it does.`);
  process.exit(0);
}
console.log(`EMPTY BUT CURRENT — written ${fmtAge(age)} ago with no completed games to aggregate.`);
console.log(`Normal out of season and before Week 1 finishes; a fault only once real games are in the books.`);
process.exit(0);
