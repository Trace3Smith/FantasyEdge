// Versioned authenticated encryption. No credential values in errors or diagnostics.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './auth.js';
export const CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;
function keyFrom(raw) {
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw.trim()) {
    throw new HttpError(503, 'ESPN credential encryption is not configured correctly');
  }
  return key;
}
export function encryptCredentials(userId, credentials, now = Date.now()) {
  const key = keyFrom(process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY);
  if (!key) throw new HttpError(503, 'ESPN credential encryption is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`fantasyedge:espn:credentials:v1:${userId}`));
  const expiresAt = new Date(now + CREDENTIAL_TTL_SECONDS * 1000).toISOString();
  const data = Buffer.concat([cipher.update(JSON.stringify({ ...credentials, expiresAt }), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function decryptCredentials(userId, envelope, now = Date.now()) {
  if (!envelope) return null;
  if (envelope.version == null && envelope.espn_s2 && envelope.swid) {
    // Compatibility window: legacy data stays readable until explicitly migrated.
    // Do not write on read: a concurrent disconnect must never be resurrected.
    return envelope;
  }
  if (envelope.version !== 1) throw new HttpError(503, 'Unsupported ESPN credential storage version');
  const keys = [process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY, process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY]
    .filter(Boolean).map(keyFrom);
  for (const key of keys) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'), { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`fantasyedge:espn:credentials:v1:${userId}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      const creds = JSON.parse(plain.toString('utf8'));
      if (!creds.espn_s2 || !creds.swid || !Number.isFinite(Date.parse(creds.expiresAt))) break;
      return Date.parse(creds.expiresAt) > now ? creds : null;
    } catch { /* try only the explicitly configured previous key */ }
  }
  throw new HttpError(503, 'ESPN credentials could not be decrypted; check encryption configuration');
}

// Compare-and-set prevents an offline migration from overwriting a reconnect or
// recreating credentials deleted while it was working. No provider calls.
export async function migrateLegacyCredentials(redis, userId, existing) {
  if (!existing?.espn_s2 || !existing?.swid || existing.version != null) return false;
  const envelope = encryptCredentials(userId, existing);
  const changed = await redis.eval(`
    if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
    redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
    return 1
  `, [`espn:creds:${userId}`], [JSON.stringify(existing), JSON.stringify(envelope), CREDENTIAL_TTL_SECONDS]);
  return Number(changed) === 1;
}
