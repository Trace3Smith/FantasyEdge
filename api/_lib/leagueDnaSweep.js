// League DNA daily sweep: keeps opted-in users' league configs current, so capture doesn't depend on
// them happening to open each sport again. It runs inside the Autopilot cron (the deployment is at the
// 12-function cap, so it can't have its own endpoint), after the lineup work, under a time budget.
//
// Consent: it reads ONLY the opted-in list (DNA_USERS), and re-checks each user against the current
// notice version before touching their cookies. Membership of the set alone isn't trusted: after a
// notice version bump, the set still lists people whose answer no longer counts.
//
// Expired cookies are skipped quietly: counted, and nothing else. No reconnect prompt, and Autopilot is
// left alone. The sweep is background upkeep, not a reason to bother anyone.
//
// Fairness: users are visited in a stable order (sorted ids), starting just after a saved cursor. A run
// that runs out of time picks up where it stopped the next day, so every opted-in user is reached in
// turn, however long the list grows.

import { DNA_USERS, dnaCaptureAllowed } from './leagueDnaConsent.js';
import { recordLeagueConfig, leagueConfigKey } from './leagueConfig.js';
import { getCreds, fetchAllLeagueConfigs, EspnAuthError } from './espnFantasy.js';

export const SWEEP_CURSOR_KEY = 'espn:dna:sweep:cursor';

// Don't start a user with less than this left. One user is a fan call plus up to 20 settings reads, four
// at a time. A user still running at the deadline is abandoned and retried first on the next run.
export const MIN_USER_MS = 6000;

// The config key a discovered league would be stored under, so a league already recorded this run
// (shared with an earlier user) is skipped before its settings are fetched again.
const keyOfDiscovered = (lg) =>
  leagueConfigKey({ platform: 'espn', sport: lg.sport, leagueId: lg.leagueId, season: lg.seasonId });

const TIMED_OUT = Symbol('timed out');
async function within(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((r) => { timer = setTimeout(() => r(TIMED_OUT), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

// `deadline` is the absolute time (ms) the sweep must be finished by. `now` and `fetchConfigs` are
// injectable so the budget and cursor can be checked offline.
export async function sweepLeagueConfigs(redis, {
  deadline, now = Date.now, fetchConfigs = fetchAllLeagueConfigs, minUserMs = MIN_USER_MS,
} = {}) {
  const s = { opted: 0, visited: 0, recorded: 0, skippedConsent: 0, noCreds: 0, expired: 0, errors: 0, timedOut: 0, complete: false };
  const users = [...new Set(((await redis.smembers(DNA_USERS)) || []).map(String))].sort();
  s.opted = users.length;

  const prev = await redis.get(SWEEP_CURSOR_KEY).catch(() => null);
  const after = prev?.after ?? null;
  let start = after == null ? 0 : users.findIndex((u) => u > after);
  if (start < 0) start = 0; // past the end: wrap to the top
  const order = [...users.slice(start), ...users.slice(0, start)];

  const seen = new Set(); // config keys recorded this run
  let last = after;
  for (const userId of order) {
    const left = deadline - now();
    if (left < minUserMs) break;
    try {
      if (!(await dnaCaptureAllowed(redis, userId))) {
        s.skippedConsent++;
      } else {
        const creds = await getCreds(redis, userId);
        if (!creds) {
          s.noCreds++;
        } else {
          const configs = await within(fetchConfigs(creds, { skip: (lg) => seen.has(keyOfDiscovered(lg)) }), left);
          if (configs === TIMED_OUT) { s.timedOut++; break; } // cursor stays before this user: first next run
          for (const c of configs || []) {
            if (await recordLeagueConfig(redis, c)) { s.recorded++; seen.add(leagueConfigKey(c)); }
          }
        }
      }
    } catch (err) {
      if (err instanceof EspnAuthError) s.expired++; // quietly: counted, nothing else
      else s.errors++;
    }
    s.visited++;
    last = userId;
  }

  s.complete = s.visited === order.length;
  // A full pass starts the next run from the top; a partial one resumes just after the last user reached.
  await redis.set(SWEEP_CURSOR_KEY, { after: s.complete ? null : last, at: new Date(now()).toISOString() }).catch(() => {});
  return s;
}
