// Both keys stay under the existing isolated credential ACL prefix. The revision
// is a permanent revocation tombstone; only the encrypted credential gets a TTL.
export const previewCredentialKeys = userId => [
  `preview:espn:creds:${userId}`, `preview:espn:creds:${userId}:lifecycle`,
];
// Only GET/SET/DEL inside EVAL: no production keys, generic write API, permissions,
// DNA, or database-marker mutation. ACL must also authorize EVAL for the writer.
export const PREVIEW_CREDENTIAL_SCRIPT = `
local op, expected = ARGV[1], ARGV[2]
local revision = redis.call('GET', KEYS[2]) or '0'
if op ~= 'disconnect' and revision ~= expected then return false end
local n = tonumber(revision)
if not n or n < 0 or n >= 9007199254740990 or n ~= math.floor(n) then
  return redis.error_reply('Invalid preview lifecycle revision')
end
-- Preflight all reads, types, JSON and arguments before the first mutation.
redis.call('GET', KEYS[1])
if op == 'connect' then
  local envelope = cjson.decode(ARGV[3])
  local ttl = tonumber(ARGV[4])
  if envelope.version ~= 1 or not ttl or ttl <= 0 or ttl ~= math.floor(ttl) then
    return redis.error_reply('Invalid preview credential commit')
  end
elseif op ~= 'disconnect' then return redis.error_reply('Invalid preview operation') end
local nextRevision = string.format('%.0f', n + 1)
redis.call('SET', KEYS[2], nextRevision)
if op == 'connect' then redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
else redis.call('DEL', KEYS[1]) end
return nextRevision
`;
