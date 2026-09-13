import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import { previewConfig } from './previewIsolation.js';
import { encryptCredentials, decryptCredentials, CREDENTIAL_TTL_SECONDS } from './espnCredentials.js';
import { HttpError } from './auth.js';
const fail = () => new HttpError(503, 'Isolated preview credential storage is not configured');
// Writer stays private and exposes no generic Redis interface. ACL must restrict it to this namespace.
export function createPreviewCredentials(makeClient = options => new Redis(options)) {
  async function storage(userId) {
    const c = previewConfig();
    if (!c || !/^user_[a-zA-Z0-9]+$/.test(userId || '')) throw fail();
    const reader = makeClient({ url:c.url, token:c.readToken });
    if (await reader.get('fe:preview:project') !== c.project) throw fail();
    return { c, reader, key:`preview:espn:creds:${userId}` };
  }
  return {
    async read(userId) {
      const {reader,key} = await storage(userId);
      const envelope = await reader.get(key);
      // Never import legacy plaintext into isolated preview.
      if (envelope && envelope.version !== 1) throw fail();
      return decryptCredentials(userId,envelope);
    },
    async save(userId,credentials) {
      const {c,key} = await storage(userId);
      const value = {espn_s2:credentials.espn_s2,swid:credentials.swid,
        savedAt:new Date().toISOString(),connectionId:randomUUID()};
      const encrypted = encryptCredentials(userId,value);
      await makeClient({url:c.url,token:c.credentialToken}).set(key,encrypted,{ex:CREDENTIAL_TTL_SECONDS});
    },
    async disconnect(userId) {
      const {c,key} = await storage(userId);
      await makeClient({url:c.url,token:c.credentialToken}).del(key);
    },
  };
}
export const previewCredentials = createPreviewCredentials();
