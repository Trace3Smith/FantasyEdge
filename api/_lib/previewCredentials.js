import { previewCredentialKeys, PREVIEW_CREDENTIAL_SCRIPT } from './previewCredentialLifecycle.js';
import { Redis } from '@upstash/redis';
import { randomUUID } from 'node:crypto';
import { previewConfig } from './previewIsolation.js';
import { encryptCredentials, decryptCredentials, CREDENTIAL_TTL_SECONDS } from './espnCredentials.js';
import { HttpError } from './auth.js';
// Fixed reason codes only: never return configuration values, user IDs or Redis errors.
const fail = reason => new HttpError(503, 'Isolated preview credential storage is not configured', {
  error: 'Isolated preview credential storage is not configured', reason,
});
// Writer stays private and exposes no generic Redis interface. ACL must restrict it to this namespace.
export function createPreviewCredentials(makeClient = options => new Redis(options)) {
  async function storage(userId) {
    const c = previewConfig();
    if (!c) throw fail('preview_configuration_invalid');
    if (!/^user_[a-zA-Z0-9]+$/.test(userId || '')) throw fail('preview_user_id_invalid');
    const reader = makeClient({ url:c.url, token:c.readToken });
    let marker;
    try { marker = await reader.get('fe:preview:project'); }
    catch { throw fail('preview_redis_read_failed'); }
    if (marker == null) throw fail('preview_database_marker_missing');
    if (marker !== c.project) throw fail('preview_database_marker_mismatch');
    const [key, revisionKey] = previewCredentialKeys(userId);
    return { c, reader, key, revisionKey };
  }
  const conflict = () => new HttpError(409, 'ESPN connection changed; retry the operation', { error:'connection_changed' });
  const revision = async ({reader,revisionKey}) => {
    try { return String(await reader.get(revisionKey) ?? 0); }
    catch { throw fail('preview_credential_read_failed'); }
  };
  async function transition(state, op, expected, encrypted = null) {
    let result;
    try {
      result = await makeClient({url:state.c.url,token:state.c.credentialToken}).eval(
        PREVIEW_CREDENTIAL_SCRIPT, [state.key,state.revisionKey],
        [op,String(expected),JSON.stringify(encrypted),String(CREDENTIAL_TTL_SECONDS)]);
    } catch { throw fail('preview_credential_write_failed'); }
    if (result === null || result === false) throw conflict();
    return String(result);
  }
  return {
    async begin(userId) { return revision(await storage(userId)); },
    async read(userId) {
      const state = await storage(userId);
      const before = await revision(state);
      let envelope;
      try { envelope = await state.reader.get(state.key); }
      catch { throw fail('preview_credential_read_failed'); }
      // Read-only token uses GET only. Detect a concurrent transition rather than
      // combining an old envelope with a new revision or inferring disconnection.
      if (before !== await revision(state)) throw conflict();
      if (envelope && envelope.version !== 1) throw fail('preview_credential_format_invalid');
      const creds = decryptCredentials(userId,envelope);
      return creds ? {...creds,lifecycleRevision:before} : null;
    },
    async save(userId,credentials,expectedRevision) {
      const state = await storage(userId);
      // HTTP caller passes the revision captured before provider validation.
      const expected = expectedRevision ?? await revision(state);
      const value = {espn_s2:credentials.espn_s2,swid:credentials.swid,
        savedAt:new Date().toISOString(),connectionId:randomUUID()};
      const encrypted = encryptCredentials(userId,value);
      return transition(state,'connect',expected,encrypted);
    },
    async disconnect(userId) {
      return transition(await storage(userId),'disconnect','');
    },
  };
}
export const previewCredentials = createPreviewCredentials();
