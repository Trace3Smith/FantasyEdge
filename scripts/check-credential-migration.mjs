import assert from 'node:assert/strict';
import { parseOptions, runMigration } from './migrate-espn-credentials.mjs';
import { encryptCredentials, CREDENTIAL_TTL_SECONDS } from '../api/_lib/espnCredentials.js';
const key = Buffer.alloc(32, 7).toString('base64'); // synthetic only
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = key;
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY;
const legacy = { espn_s2: 'offline-cookie', swid: 'offline-owner', savedAt: '2026-01-01' };
function storage(entries) {
  const values = new Map(entries.map(([id, value]) => [`espn:creds:${id}`, JSON.stringify(value)]));
  let reads = 0, writes = 0;
  return {
    get reads() { return reads; }, get writes() { return writes; },
    async scan() { reads++; return ['0', [...values.keys()]]; },
    async get(id) { reads++; return JSON.parse(values.get(id)); },
    async eval(script, [id], [before, after, ttl]) {
      assert.equal(ttl, CREDENTIAL_TTL_SECONDS);
      if (values.get(id) !== before) return 0;
      values.set(id, after); writes++; return 1;
    }
  };
}
for (const args of [['--aply'], ['--apply','--verify'], ['--verify','--limit','1'],
  ['--apply','--limit','0'], ['--apply','--limit'], ['--apply','--limit','1.5']]) {
  assert.throws(() => parseOptions(args));
}
const db = storage([['a',legacy], ['b',legacy], ['c',encryptCredentials('c',legacy)]]);
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;
let result = await runMigration(db);
assert.equal(result.legacy,2); assert.equal(result.encrypted,1); assert.equal(db.writes,0);
let before = db.reads;
await assert.rejects(runMigration(db,parseOptions(['--apply'])));
assert.equal(db.reads,before,'missing key rejects before any storage access');
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = key;
process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY = 'malformed';
await assert.rejects(runMigration(db,parseOptions(['--verify'])));
assert.equal(db.reads,before,'malformed previous key rejects before storage access');
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY;
result = await runMigration(db,parseOptions(['--apply','--limit','1']));
assert.equal(result.migrated,1); assert.equal(result.attempted,1); assert.equal(result.complete,false);
result = await runMigration(db,parseOptions(['--verify']));
assert.equal(result.readable,2); assert.equal(result.legacy,1); assert.equal(db.writes,1);
result = await runMigration(db,parseOptions(['--apply']));
assert.equal(result.migrated,1); assert.equal(result.complete,true);
assert.equal((await runMigration(db,parseOptions(['--apply']))).migrated,0,'rerun is idempotent');
const bad = storage([['wrong-user',encryptCredentials('right-user',legacy)],
  ['expired',encryptCredentials('expired',legacy,Date.now()-CREDENTIAL_TTL_SECONDS*1000-1000)],
  ['unknown',{...legacy,version:2}]]);
result = await runMigration(bad,parseOptions(['--verify']));
assert.equal(result.unreadable,1); assert.equal(result.expired,1); assert.equal(result.invalid,1);
assert.equal(bad.writes,0);
const race = storage([['a',legacy],['b',legacy]]);
race.eval = async () => 0;
result = await runMigration(race,parseOptions(['--apply','--limit','1']));
assert.equal(result.attempted,1); assert.equal(result.changedDuringRead,1); assert.equal(result.migrated,0);
assert.equal(JSON.stringify(result).includes(legacy.espn_s2),false);
console.log('PASS: migration inventory, strict flags, key preflight, bounded canary, read-only verification, expiry, unsupported versions, reruns and races');
