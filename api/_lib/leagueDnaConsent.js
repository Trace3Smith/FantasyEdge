// League DNA consent: whether a user has seen the League DNA notice, and what they chose.
//
// Every capture path checks this before recording a league config: the capture at linking, the
// leagues fetch, the Autopilot cron, and the daily sweep to come. With no choice recorded on the
// current notice version, NOTHING is captured for that user, so consent never depends on which page
// they happened to open.
//
//   espn:dna:ack:{userId} = { version, include, via: 'connect' | 'notice' | 'settings', at }
//   espn:dna:users        = set of users whose current choice is to include (the sweep's list)
//
// A user who opts out keeps a record, so they aren't asked again, but isn't in the set. Configs are
// league-level settings, so a league is still captured once any one of its members has opted in.

// Bump whenever the notice text changes what is collected (and bump the copy in
// fantasyedge-autopilot.html with it). Every choice stored at an older version stops counting: those
// users drop out of capture and see the new notice.
export const DNA_NOTICE_VERSION = 1;

const ackKey = (userId) => `espn:dna:ack:${userId}`;
export const DNA_USERS = 'espn:dna:users';
const VIA = new Set(['connect', 'notice', 'settings']);

export const isCurrent = (rec) => !!rec && rec.version === DNA_NOTICE_VERSION;
export const captureAllowedBy = (rec) => isCurrent(rec) && rec.include === true;

export async function getDnaConsent(redis, userId) {
  return (await redis.get(ackKey(userId))) || null;
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
export async function recordDnaChoice(redis, userId, { version, include, via }) {
  if (version !== DNA_NOTICE_VERSION || typeof include !== 'boolean' || !VIA.has(via)) return null;
  const rec = { version, include, via, at: new Date().toISOString() };
  await redis.set(ackKey(userId), rec);
  if (include) await redis.sadd(DNA_USERS, userId);
  else await redis.srem(DNA_USERS, userId);
  return rec;
}

// Disconnect: forget the choice and leave the sweep list, so a re-link shows the notice again. Configs
// already saved are left alone: they carry no user id, so there is nothing to tie back to this account.
export async function clearDnaConsent(redis, userId) {
  await redis.del(ackKey(userId));
  await redis.srem(DNA_USERS, userId);
}
