import { beginLifecycle, transitionLifecycle } from './espnLifecycle.js';
// League DNA consent: whether a user has seen the League DNA notice, and what they chose.
//
// Every capture path checks this before recording a league config: the capture at linking, the
// leagues fetch, the Autopilot cron, and the daily sweep. With no choice recorded on the current
// notice version, NOTHING is captured for that user, so consent never depends on which page they
// happened to open.
//
//   espn:dna:ack:{userId} = { version, include, via: 'connect' | 'notice' | 'settings', at }
//   espn:dna:users        = set of users whose current choice is to include (the sweep's list)
//
// A user who opts out keeps a record, so they aren't asked again, but isn't in the set. A league is
// still captured once any ONE of its members has opted in — what's stored describes the league, not
// the person. The v2 notice states this outright, because from v2 on it also covers an opted-out
// member's own picks and trades, reached through a leaguemate's connection.

// Bump whenever the notice text changes what is collected (and bump the copy in
// fantasyedge-autopilot.html with it). Every choice stored at an older version stops counting: those
// users drop out of capture and see the new notice.
//
// v2 widened the scope from league settings to the whole league's play: every team's draft picks,
// trades and outcomes, not only the linked user's team. Everyone who answered v1 agreed to something
// narrower, so they are all asked again. Note the sweep's counts while that plays out: DNA_USERS
// still lists the v1 opt-ins (only an explicit opt-out removes anyone), so `opted` stays as it was
// while `skippedConsent` rises to match `visited` — that is consent working, not a fault.
export const DNA_NOTICE_VERSION = 2;

const ackKey = (userId) => `espn:dna:ack:${userId}`;
export const DNA_USERS = 'espn:dna:users';
const VIA = new Set(['connect', 'notice', 'settings']);

export const isCurrent = (rec) => !!rec && rec.version === DNA_NOTICE_VERSION;
export const captureAllowedBy = (rec) => isCurrent(rec) && rec.include === true;

export async function getDnaConsent(redis, userId) {
  const rec = await redis.get(ackKey(userId));
  const gen = await redis.get(`espn:generation:${userId}`);
  return gen && rec?.connectionId === gen ? rec : null;
}

// The gate every capture path calls. Fails closed: an error reading the record means no capture.
export async function dnaCaptureAllowed(redis, userId) {
  try { return captureAllowedBy(await getDnaConsent(redis, userId)); } catch { return false; }
}

// For the client: `needed` = show the notice; `include` = their current answer (null if none yet).
export function dnaNoticeStatus(rec) {
  return { version: DNA_NOTICE_VERSION, needed: !isCurrent(rec), include: isCurrent(rec) ? rec.include : null };
}

// Record a choice. `version` is the notice version the client actually displayed. A stale or missing
// version records nothing and returns null: the user saw different text from what's current.
export function dnaChoiceRecord({ version, include, via }) {
  if (version !== DNA_NOTICE_VERSION || typeof include !== 'boolean' || !VIA.has(via)) return null;
  const rec = { version, include, via, at: new Date().toISOString() };
  return rec;
}

export async function recordDnaChoice(redis, userId, choice, revision) {
  const rec = dnaChoiceRecord(choice);
  if (!rec) return null;
  await transitionLifecycle(redis, userId, 'dna', revision ?? await beginLifecycle(redis, userId), rec);
  return rec;
}

// Disconnect: forget the choice and leave the sweep list, so a re-link shows the notice again. Configs
// already saved are left alone: they carry no user id, so there is nothing to tie back to this account.
export async function clearDnaConsent(redis, userId, revision) {
  await transitionLifecycle(redis, userId, 'dna-clear', revision ?? await beginLifecycle(redis, userId));
}
