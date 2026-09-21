// Operator-only raw Redis access. NEVER import this module in application runtime.
import { randomUUID } from 'node:crypto';
import { CONTROL, epochKey } from '../../api/_lib/storageEpoch.js';
import { encryptCredentials, decryptCredentials, decryptActive } from '../../api/_lib/espnCredentials.js';
export const PENDING_MS = 24 * 60 * 60 * 1000;
const manifest = epochKey('bootstrap:manifest'), completed = epochKey('bootstrap:completed');
const userKey = user => { if (!/^[A-Za-z0-9_-]{1,200}$/.test(user)) throw Error('Invalid identity'); return user; };
const checkedControl = `
local raw = redis.call('GET', KEYS[1])
if not raw then return redis.error_reply('BOOTSTRAP_STATE') end
local c = cjson.decode(raw)
if c.schema ~= 1 or c.epoch ~= 'e1' or c.runId ~= ARGV[1] then return redis.error_reply('BOOTSTRAP_STATE') end
`;
const preparing = checkedControl + `if c.phase ~= 'preparing' then return redis.error_reply('BOOTSTRAP_CLOSED') end\n`;
export async function beginBootstrap(raw, runId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw Error('Invalid run');
  // No runtime can write before control exists. Refuse accidental epoch reuse.
  if (!await raw.eval('return redis.call("EXISTS",KEYS[1])',[CONTROL],[])) {
    let cursor='0';
    do {
      const [next,keys]=await raw.eval('return redis.call("SCAN",ARGV[1],"MATCH","fe:e1:*","COUNT",100)',[],[cursor]);
      if(keys.length) throw Error('Epoch is not empty');
      cursor=String(next);
    } while(cursor!=='0');
  }
  return raw.eval(`
local old = redis.call('GET', KEYS[1])
if old then
 local c=cjson.decode(old)
 if c.runId == ARGV[1] and c.phase == 'preparing' and c.epoch == 'e1' and c.schema == 1 then return 0 end
 return redis.error_reply('BOOTSTRAP_STATE')
end
redis.call('SET', KEYS[1], cjson.encode({schema=1,epoch='e1',phase='preparing',runId=ARGV[1],manifestClosed=false}))
return 1`, [CONTROL], [runId]);
}
// Enumeration is filtered but traverses the Redis keyspace. Legacy values never leave
// the in-memory operator. Every source read rechecks preparing inside the same script.
export async function captureManifest(raw, runId) {
  let cursor = '0';
  do {
    const [next, keys] = await raw.eval(preparing + `
if c.manifestClosed then return {'0',{}} end
return redis.call('SCAN', ARGV[2], 'MATCH', 'espn:creds:*', 'COUNT', 100)`, [CONTROL], [runId, cursor]);
    cursor = String(next);
    for (const key of keys) {
      const user = userKey(key.slice('espn:creds:'.length));
      await raw.eval(preparing + `
if c.manifestClosed then return redis.error_reply('MANIFEST_CLOSED') end
return redis.call('SADD', KEYS[2], ARGV[2])`, [CONTROL, manifest], [runId, user]);
    }
  } while (cursor !== '0');
  await raw.eval(preparing + `c.manifestClosed=true; redis.call('SET',KEYS[1],cjson.encode(c)); return 1`, [CONTROL], [runId]);
}
export async function bootstrapUser(raw, runId, user, { beforeCommit } = {}) {
  userKey(user);
  const dest = [CONTROL, manifest, completed, epochKey(`bootstrap:user:${user}`), epochKey(`bootstrap:creds:${user}`), epochKey(`espn:lifecycle:${user}`), epochKey(`espn:generation:${user}`), epochKey(`espn:creds:${user}`)];
  const snapshot = await raw.eval(preparing + `
if not c.manifestClosed or redis.call('SISMEMBER',KEYS[2],ARGV[2]) ~= 1 then return redis.error_reply('MANIFEST_STATE') end
if redis.call('EXISTS',KEYS[3]) == 1 then return {'done'} end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local kind=redis.call('TYPE',KEYS[4]).ok
if kind == 'none' then return {'absent'} end
if kind ~= 'string' then return {'invalid'} end
return {'record', redis.call('GET',KEYS[4]), redis.call('PTTL',KEYS[4]), tostring(now)}`, [CONTROL, manifest, dest[3], `espn:creds:${user}`], [runId, user]);
  if (snapshot[0] === 'done') return 'unchanged';
  let candidate = null, disposition = snapshot[0];
  if (snapshot[0] === 'record') {
    const capturedAt = Number(snapshot[3]);
    try {
      const original = typeof snapshot[1] === 'string' ? JSON.parse(snapshot[1]) : snapshot[1];
      const value = decryptCredentials(user, original, capturedAt);
      if (!value) disposition = 'expired';
      else if (typeof value.espn_s2 !== 'string' || !value.espn_s2.trim() || value.espn_s2.length > 65536 || typeof value.swid !== 'string' || !/^\{[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\}$/i.test(value.swid)) disposition = 'invalid';
      else {
        let expiry = capturedAt + PENDING_MS;
        if (Number(snapshot[2]) >= 0) expiry = Math.min(expiry, capturedAt + Number(snapshot[2]));
        if (original.version === 1) expiry = Math.min(expiry, Date.parse(value.expiresAt));
        if (expiry <= capturedAt) disposition = 'expired';
        else {
          const connectionId = randomUUID();
          const envelope = encryptCredentials(user, {espn_s2:value.espn_s2, swid:value.swid, connectionId, storageEpoch:'e1'}, capturedAt, expiry);
          candidate = {envelope, connectionId, expiresAt:expiry}; disposition = 'pending';
        }
      }
    } catch { disposition = 'invalid'; }
  }
  // Validate key even for malformed/empty inventories. A bad key must not silently
  // turn the entire cohort into invalid candidates.
  decryptCredentials('preflight', encryptCredentials('preflight', {espn_s2:'synthetic',swid:'synthetic'}));
  if (beforeCommit) await beforeCommit();
  const payload = candidate ? JSON.stringify(candidate) : '';
  const result = await raw.eval(preparing + `
if not c.manifestClosed or redis.call('SISMEMBER',KEYS[2],ARGV[2]) ~= 1 then return redis.error_reply('MANIFEST_STATE') end
for i=2,#KEYS do
 local kind=redis.call('TYPE',KEYS[i]).ok
 local wanted=(i==2 or i==3) and 'set' or 'string'
 if kind ~= 'none' and kind ~= wanted then return redis.error_reply('BOOTSTRAP_TYPE') end
end
if redis.call('EXISTS',KEYS[4]) == 1 then return 0 end
for i=5,#KEYS do if redis.call('EXISTS',KEYS[i]) == 1 then return redis.error_reply('DESTINATION_EXISTS') end end
local pending=nil
if ARGV[4] ~= '' then pending=cjson.decode(ARGV[4]); if pending.envelope.version ~= 1 then return redis.error_reply('BOOTSTRAP_FORMAT') end end
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if pending and pending.expiresAt <= now then pending=nil end
if pending then
 redis.call('SET',KEYS[5],ARGV[4],'PXAT',pending.expiresAt)
 redis.call('SET',KEYS[7],pending.connectionId)
end
redis.call('SET',KEYS[6],'1')
redis.call('SET',KEYS[4],cjson.encode({runId=ARGV[1],disposition=pending and 'pending' or ARGV[3]}))
redis.call('SADD',KEYS[3],ARGV[2]); return 1`, dest, [runId, user, disposition === 'pending' ? 'expired' : disposition, payload]);
  return result ? disposition : 'unchanged';
}
export async function importManifest(raw, runId) {
  const users = await raw.eval(preparing + `if not c.manifestClosed then return redis.error_reply('MANIFEST_OPEN') end; return redis.call('SMEMBERS',KEYS[2])`, [CONTROL, manifest], [runId]);
  const counts = {pending:0, invalid:0, expired:0, absent:0, unchanged:0};
  for (const user of users) counts[await bootstrapUser(raw, runId, user)]++;
  return counts;
}
export async function sealBootstrap(raw, runId) {
  return raw.eval(checkedControl + `
if c.phase == 'sealed' then return 0 end
if c.phase ~= 'preparing' or not c.manifestClosed then return redis.error_reply('BOOTSTRAP_STATE') end
if redis.call('SCARD',KEYS[2]) ~= redis.call('SCARD',KEYS[3]) then return redis.error_reply('BOOTSTRAP_INCOMPLETE') end
c.phase='sealed';redis.call('SET',KEYS[1],cjson.encode(c));return 1`, [CONTROL, manifest, completed], [runId]);
}
export async function verifyBootstrap(raw, runId) {
  const users = await raw.eval(checkedControl + `if c.phase ~= 'sealed' then return redis.error_reply('BOOTSTRAP_STATE') end; return redis.call('SMEMBERS',KEYS[2])`, [CONTROL, manifest], [runId]);
  let pending = 0;
  for (const user of users) {
    const row = await raw.eval(checkedControl + `
if c.phase ~= 'sealed' then return redis.error_reply('BOOTSTRAP_STATE') end
return {redis.call('GET',KEYS[2]) or '',redis.call('GET',KEYS[3]) or '',redis.call('GET',KEYS[4]) or '',redis.call('GET',KEYS[5]) or ''}`, [CONTROL,epochKey(`bootstrap:user:${user}`),epochKey(`bootstrap:creds:${user}`),epochKey(`espn:lifecycle:${user}`),epochKey(`espn:creds:${user}`)], [runId]);
    const marker=typeof row[0]==='string'?JSON.parse(row[0]):row[0];
    if (marker.runId!==runId || String(row[2])!=='1' || row[3]) throw Error('Invalid bootstrap');
    if (row[1]) {
      const candidate=typeof row[1]==='string'?JSON.parse(row[1]):row[1];
      const c=decryptActive(user,candidate.envelope);
      if (c && (c.connectionId!==candidate.connectionId || Date.parse(c.expiresAt)!==candidate.expiresAt)) throw Error('Invalid candidate');
      pending++;
    }
  }
  return {complete:users.length,pending};
}
export async function activateBootstrap(raw, runId) {
  await verifyBootstrap(raw, runId);
  return raw.eval(checkedControl + `
if c.phase ~= 'sealed' then return redis.error_reply('BOOTSTRAP_STATE') end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000
c.quotaNotBefore=(math.floor(now/86400000)+1)*86400000
c.phase='active';redis.call('SET',KEYS[1],cjson.encode(c));return 1`, [CONTROL], [runId]);
}
