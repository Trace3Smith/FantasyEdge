// Persistent revocation tombstone. Never expire/reset this key while requests may be in flight.
import { HttpError } from './auth.js';
export const lifecycleKeys = userId => [
  `espn:lifecycle:${userId}`, `espn:creds:${userId}`, `espn:autopilot:${userId}`,
  'espn:autopilot:users', `espn:prospectwatch:${userId}`, `espn:dna:ack:${userId}`, 'espn:dna:users',
];
// Redis scripts are atomic, but runtime errors do NOT roll back prior writes. Validate
// types/JSON/revision bounds before the first mutation. All data is supplied via ARGV.
export const LIFECYCLE_SCRIPT = `
local op, expected, user = ARGV[1], ARGV[2], ARGV[3]
local revision = redis.call('GET', KEYS[1]) or '0'
if op == 'read' then return {revision, redis.call('GET', KEYS[2]) or ''} end
if op ~= 'disconnect' and revision ~= expected then return false end
local n = tonumber(revision)
if not n or n < 0 or n >= 9007199254740990 or n ~= math.floor(n) then return redis.error_reply('Invalid lifecycle revision') end
for i, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local wanted = (i == 4 or i == 7) and 'set' or 'string'
  if kind ~= 'none' and kind ~= wanted then return redis.error_reply('Invalid lifecycle storage type') end
end
local payload = cjson.decode(ARGV[4])
local watch = nil
if op == 'connect' or op == 'disconnect' then
  local raw = redis.call('GET', KEYS[5])
  if raw then
    watch = cjson.decode(raw)
    for _, entry in pairs(watch) do
      entry.previousLeague = entry.lg and entry.lg ~= '' and entry.lg or entry.previousLeague or cjson.null
      entry.lg = ''; entry.leagueName = ''
    end
    watch = cjson.encode(watch)
  end
end
local prefs = nil
if op == 'permission' then
  prefs = cjson.decode(redis.call('GET', KEYS[3]) or '{}')
  -- Remove both historical and qualified aliases of this exact sport/team identity.
  for _, key in ipairs(payload.aliases) do prefs[key] = nil end
  if payload.on then
    if redis.call('EXISTS', KEYS[2]) == 0 then return false end
    prefs[payload.key] = payload.value
  end
  prefs = cjson.encode(prefs)
elseif op ~= 'connect' and op ~= 'disconnect' and op ~= 'clear' and op ~= 'dna' and op ~= 'dna-clear' then
  return redis.error_reply('Unknown lifecycle operation')
end
-- Serialization/argument checks must also precede mutations.
local envelope, consent, includeConsent = nil, nil, false
if op == 'connect' then
  if payload.envelope.version ~= 1 or not tonumber(ARGV[5]) or tonumber(ARGV[5]) <= 0 then
    return redis.error_reply('Invalid credential commit')
  end
  envelope = cjson.encode(payload.envelope)
  if payload.consent and payload.consent ~= cjson.null then consent = cjson.encode(payload.consent) end
elseif op == 'dna' then consent = cjson.encode(payload) end
if consent then
  local choice = op == 'connect' and payload.consent or payload
  if type(choice) ~= 'table' or type(choice.include) ~= 'boolean' then return redis.error_reply('Invalid consent') end
  includeConsent = choice.include
end
redis.call('INCR', KEYS[1])
if op == 'connect' or op == 'disconnect' or op == 'clear' then
  redis.call('DEL', KEYS[3]); redis.call('SREM', KEYS[4], user)
end
if watch then redis.call('SET', KEYS[5], watch) end
if op == 'connect' then redis.call('SET', KEYS[2], envelope, 'EX', ARGV[5]) end
if op == 'disconnect' then
  redis.call('DEL', KEYS[2], KEYS[6]); redis.call('SREM', KEYS[7], user)
end
if op == 'dna-clear' then redis.call('DEL', KEYS[6]); redis.call('SREM', KEYS[7], user) end
if op == 'permission' then
  redis.call('SET', KEYS[3], prefs)
  if prefs == '{}' then redis.call('SREM', KEYS[4], user) else redis.call('SADD', KEYS[4], user) end
end
if consent then
  redis.call('SET', KEYS[6], consent)
  if includeConsent then redis.call('SADD', KEYS[7], user) else redis.call('SREM', KEYS[7], user) end
end
return redis.call('GET', KEYS[1])
`;
export function lifecycleConflict() {
  return new HttpError(409, 'ESPN connection or permissions changed; retry the operation', { error: 'connection_changed' });
}
export async function readLifecycle(redis, userId) {
  const [revision, raw] = await redis.eval(LIFECYCLE_SCRIPT, lifecycleKeys(userId), ['read', '', userId, '{}', '0']);
  return { revision: String(revision), credentials: raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null };
}
export async function beginLifecycle(redis, userId) {
  return String(await redis.get(lifecycleKeys(userId)[0]) ?? 0);
}
export async function transitionLifecycle(redis, userId, op, revision, payload = {}, ttl = 0) {
  const result = await redis.eval(LIFECYCLE_SCRIPT, lifecycleKeys(userId), [op, String(revision), userId, JSON.stringify(payload), String(ttl)]);
  if (result === null || result === false) throw lifecycleConflict();
  return String(result);
}
