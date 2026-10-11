// Deterministic regression for hosted Redis's immutable KEYS and ARGV inputs.
import assert from 'node:assert/strict';
import { localRedis } from './lib/local-redis.mjs';
import { registerEpochScript } from '../api/_lib/storageEpoch.js';
const raw = await localRedis();
try {
  let rejected = 0;
  for (const name of ['KEYS', 'ARGV']) {
    for (const mutation of [
      `${name}[1] = 'changed'`, `${name}[3] = 'appended'`, `${name}[1] = nil`,
      `table.remove(${name}, 1)`, `table.insert(${name}, 'appended')`, `table.sort(${name})`,
      `rawset(${name}, 1, 'changed')`, `local alias = ${name}; alias[1] = 'changed'`,
      `local alias = ${name}; table.remove(alias, 1)`,
      `local iterator,state = ipairs(${name}); state[1] = 'changed'`,
    ]) {
      await assert.rejects(raw.eval(mutation + '; return 1', ['one','two'], ['alpha','beta']), /READONLY_REDIS_INPUT/);
      rejected++;
    }
    for (const script of [`${name}[1] = 'changed'`, `${name} = {}`]) {
      assert.throws(() => registerEpochScript(script), /Unsafe epoch script/);
    }
  }
  assert.deepEqual(await raw.eval(`
local keys, args = {}, {}
for i=1,#KEYS do keys[i]=KEYS[i] end
for i,value in ipairs(ARGV) do args[i]=value end
for _,value in pairs(KEYS) do assert(value=='one' or value=='two') end
table.remove(keys,1); table.insert(args,'gamma'); table.sort(args)
return {#KEYS,#ARGV,KEYS[1],ARGV[1],keys[1],unpack(args)}
`, ['one','two'], ['alpha','beta']), [2,2,'one','alpha','two','alpha','beta','gamma']);
  console.log(`PASS: ${rejected} KEYS/ARGV mutation attempts rejected; ordered reads and local-copy transformations preserved`);
} finally { await raw.close(); }
