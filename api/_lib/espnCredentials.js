// Versioned authenticated encryption. No credential values in errors or diagnostics.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { HttpError } from './httpError.js';
export const CREDENTIAL_TTL_SECONDS = 90 * 24 * 60 * 60;
function keyFrom(raw) {
  if (!raw) return null;
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw.trim()) {
    throw new HttpError(503, 'ESPN credential encryption is not configured correctly');
  }
  return key;
}
export function encryptCredentials(userId, credentials, now = Date.now(), expiry = now + CREDENTIAL_TTL_SECONDS * 1000) {
  if (!Number.isFinite(expiry) || expiry <= now) throw new HttpError(503, 'Invalid credential expiry');
  const key = keyFrom(process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY);
  if (!key) throw new HttpError(503, 'ESPN credential encryption is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`fantasyedge:espn:credentials:v1:${userId}`));
  const expiresAt = new Date(expiry).toISOString();
  const data = Buffer.concat([cipher.update(JSON.stringify({ ...credentials, expiresAt }), 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function decryptCredentials(userId, envelope, now = Date.now()) {
  if (!envelope) return null;
  if (envelope.version == null && envelope.espn_s2 && envelope.swid) {
    // Operator bootstrap/codec compatibility only; runtime calls decryptActive first.
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

export function decryptActive(userId, envelope, now = Date.now()) {
  if (!envelope) return null;
  if (envelope.version !== 1) throw new HttpError(503, 'Invalid epoch credential');
  const c = decryptCredentials(userId, envelope, now);
  if (c && (typeof c.espn_s2 !== 'string' || !c.espn_s2 || typeof c.swid !== 'string' || !c.swid || typeof c.connectionId !== 'string' || !c.connectionId || c.storageEpoch !== 'e1')) throw new HttpError(503, 'Invalid epoch generation');
  return c;
}
