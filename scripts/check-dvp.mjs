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
console.log(`EMPTY BUT CURRENT — written ${fmtAge(age)} ago with no completed games to aggregate.`);
console.log(`Normal out of season and before Week 1 finishes; a fault only once real games are in the books.`);
process.exit(0);
