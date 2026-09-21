// The sole runtime Redis boundary. Logical keys remain stable; physical keys never do.
// No raw client, unknown command, caller Lua or legacy fallback is exposed.
export const EPOCH = 'e1';
export const PREFIX = `fe:${EPOCH}:`;
export const CONTROL = `${PREFIX}control`;
const scripts = new Set();
export function registerEpochScript(script) {
  // This is an allowlist for the repository's lifecycle script, not arbitrary Lua.
  // Catch literal/dynamic key mistakes before a script can be registered.
  if (typeof script !== 'string' || /KEYS\s*\[[^\]]+\]\s*=|(?:rawset|loadstring|load|require)\s*\(|table\./.test(script)) throw new Error('Unsafe epoch script');
  for (const call of script.matchAll(/redis\.call\(([^\n]*)/g)) {
    const args=call[1];
    if (/^'TIME'\)/.test(args)) continue;
    if (/^'TYPE', key\)/.test(args)) continue; // key comes only from ipairs(KEYS)
    if (!/^'(GET|SET|DEL|INCR|SADD|SREM|EXISTS)', KEYS\[\d+\][,)]/.test(args)) throw new Error('Unsafe epoch script key');
  }
  scripts.add(script); return script;
}
export const epochKey = key => {
  if (typeof key !== 'string' || !key || key.startsWith('fe:') || /[\x00-\x1f]/.test(key) || key === 'control') throw new Error('Invalid epoch key');
  return PREFIX + key;
};
export const ACTIVE_GUARD = `
local ctlraw = redis.call('GET', KEYS[1])
if not ctlraw then return redis.error_reply('EPOCH_MAINTENANCE') end
local ok, ctl = pcall(cjson.decode, ctlraw)
if not ok or type(ctl) ~= 'table' or ctl.schema ~= 1 or ctl.epoch ~= 'e1' or ctl.phase ~= 'active' or ctl.manifestClosed ~= true or type(ctl.runId) ~= 'string' or type(ctl.quotaNotBefore) ~= 'number' then
 return redis.error_reply('EPOCH_MAINTENANCE')
end
table.remove(KEYS, 1)
`;
const COMMAND = ACTIVE_GUARD + `
local op = ARGV[1]
if op == 'quotaBlocked' then return tonumber(ARGV[2]) < ctl.quotaNotBefore and 1 or 0 end
if op == 'get' then return redis.call('GET', KEYS[1]) end
if op == 'set' then
 local options = {}
 if ARGV[3] ~= '' then options = {ARGV[3], ARGV[4]} end
 if ARGV[5] == '1' then options[#options+1] = 'NX' end
 return redis.call('SET', KEYS[1], ARGV[2], unpack(options))
end
if op == 'del' then return redis.call('DEL', unpack(KEYS)) end
if op == 'exists' then return redis.call('EXISTS', unpack(KEYS)) end
if op == 'type' then return redis.call('TYPE', KEYS[1]).ok end
if op == 'incr' then return redis.call('INCR', KEYS[1]) end
if op == 'expire' then return redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if op == 'smembers' then return redis.call('SMEMBERS', KEYS[1]) end
if op == 'sadd' or op == 'srem' then return redis.call(string.upper(op), KEYS[1], unpack(ARGV, 2)) end
return redis.error_reply('EPOCH_COMMAND_DENIED')
`;
const decode = v => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
export function epochRedis(raw) {
  const call = async (script, keys, args) => {
    try { return await raw.eval(script, [CONTROL, ...keys.map(epochKey)], args); }
    catch (err) {
      // Never echo provider errors, Lua arguments, URLs or credentials.
      const e = new Error(String(err?.message).includes('EPOCH_MAINTENANCE') ? 'Storage maintenance' : 'Storage operation failed');
      e.status = 503; e.payload = { error: 'storage_unavailable' }; throw e;
    }
  };
  const cmd = (op, keys, args = []) => {
    if (!['get','exists','type','smembers','quotaBlocked'].includes(op) && keys.some(k => /^(espn:(creds:|lifecycle:|ready:|generation:|autopilot:|dna:ack:|dna:users$|prospectwatch:|manualleagues:)|bootstrap:)/.test(k))) throw new Error('Lifecycle operation required');
    return call(COMMAND, keys, [op, ...args]);
  };
  const client = {
    get: async k => decode(await cmd('get', [k])),
    set: (k, v, opts = {}) => {
      if (/^(espn:(creds|lifecycle|ready|generation|autopilot|dna:ack|dna:users|prospectwatch|manualleagues):?|bootstrap:)/.test(k)) throw new Error('Lifecycle operation required');
      if (Object.keys(opts).some(x => !['ex','px','nx'].includes(x)) || (opts.ex !== undefined && opts.px !== undefined) || ['ex','px'].some(x => opts[x] !== undefined && (!Number.isSafeInteger(opts[x]) || opts[x] <= 0)) || (opts.nx !== undefined && typeof opts.nx !== 'boolean')) throw new Error('Unsupported epoch SET options');
      return cmd('set', [k], [JSON.stringify(v), opts.ex !== undefined ? 'EX' : opts.px !== undefined ? 'PX' : '', opts.ex ?? opts.px ?? '', opts.nx ? '1' : '0']);
    },
    del: (...keys) => cmd('del', keys), exists: (...keys) => cmd('exists', keys),
    type: k => cmd('type', [k]), incr: k => cmd('incr', [k]),
    expire: (k, seconds) => cmd('expire', [k], [seconds]),
    smembers: k => cmd('smembers', [k]), sadd: (k, ...members) => cmd('sadd', [k], members), srem: (k, ...members) => cmd('srem', [k], members),
    quotaBlocked: async () => !!await cmd('quotaBlocked', [], [Date.now()]),
    eval: (script, keys, args) => {
      if (!scripts.has(script)) throw new Error('Unregistered epoch script');
      return call(ACTIVE_GUARD + script, keys, args);
    },
  };
  // No runtime consumer currently needs a pipeline. Reject rather than silently expose
  // an unwrapped SDK pipeline/multi/evalsha/scan/sendCommand escape hatch.
  return Object.freeze(client);
}
