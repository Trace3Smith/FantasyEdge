// Pending candidates are never active credentials. Only the authenticated HTTP
// confirmation path may validate and consume one through lifecycle CAS.
import { decryptActive, encryptCredentials, CREDENTIAL_TTL_SECONDS } from './espnCredentials.js';
import { transitionLifecycle, lifecycleConflict } from './espnLifecycle.js';
export async function pendingCandidate(redis, userId, now = Date.now()) {
  const candidate = await redis.get(`bootstrap:creds:${userId}`);
  if (!candidate) return null;
  if (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= now) return null;
  const creds = decryptActive(userId, candidate.envelope, now);
  if (!creds || creds.connectionId !== candidate.connectionId || Date.parse(creds.expiresAt) !== candidate.expiresAt) throw lifecycleConflict();
  return { candidate, creds };
}
export async function commitConfirmation(redis, userId, pending, revision) {
  const creds = {...pending.creds, savedAt: new Date().toISOString()};
  const envelope = encryptCredentials(userId, creds);
  await transitionLifecycle(redis, userId, 'confirm', revision,
    {envelope, connectionId: creds.connectionId, consent: null}, CREDENTIAL_TTL_SECONDS, JSON.stringify(pending.candidate));
}
