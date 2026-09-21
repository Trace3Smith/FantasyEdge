import { seedEpochCredential } from './lib/epoch-fixture.mjs';
import { installLifecycleFake } from './lib/lifecycle-fake.mjs';
// Offline execution-boundary regression: real cron, no provider or account writes.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { encryptCredentials, CREDENTIAL_TTL_SECONDS } from '../api/_lib/espnCredentials.js';
process.env.KV_REST_API_URL = 'https://offline.invalid';
process.env.KV_REST_API_TOKEN = 'offline';
process.env.CRON_SECRET = 'offline-cron';
const lib = (p) => new URL(`../api/_lib/${p}`, import.meta.url).href;
const store = new Map(), members = new Set();
const redis = {
  get: async k => structuredClone(store.get(k) ?? null),
  set: async (k,v) => store.set(k, structuredClone(v)),
  del: async k => store.delete(k),
  srem: async (k,u) => members.delete(u),
  smembers: async k => k === 'espn:autopilot:users' ? [...members] : [],
};
installLifecycleFake(redis);
let answers, writes, reads, duringRead;
const kv = await import(lib('kv.js'));
const auth = await import(lib('auth.js'));
const fantasy = await import(lib('espnFantasy.js'));
mock.module(lib('kv.js'), { namedExports: { ...kv, redis } });
mock.module(lib('auth.js'), { namedExports: { ...auth, premiumForUser: async () => {
  const value = answers.length > 1 ? answers.shift() : answers[0];
  if (value instanceof Error) throw value;
  return value;
} } });
mock.module(lib('espnFantasy.js'), { namedExports: { ...fantasy,
  fetchLeagueRoster: async () => { reads++; if (duringRead) await duringRead(); return { roster: [], scoringPeriodId: 1 }; },
  setLineup: async () => { writes++; return { applied: 1 }; },
} });
mock.module(lib('lineupAdvisor.js'), { namedExports: {
  buildValueIndex: () => new Map(), suggestLineup: () => ({ plan: [{ playerId: 1 }] }),
} });
const { default: cron } = await import('../api/cron/autopilot.js');
async function run(values, hook = null, setup = null) {
  duringRead = hook;
  store.clear(); members.clear(); members.add('user');
  process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,31).toString('base64');
  seedEpochCredential(store,'user',{espn_s2:'offline',swid:'{offline}'});
  store.set('espn:autopilot:user', { '2026:1:1': { sport: 'mlb', connectionId:'fixture-user' } });
  store.set(kv.DATASET_KEY, { players: [{ name: 'fixture' }] });
  if (setup) setup();
  answers = values; writes = reads = 0;
  const res = { statusCode: 200, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; } };
  await cron({ headers: { authorization: 'Bearer offline-cron' } }, res);
  assert.equal(res.statusCode, 200);
  return res.body.summary;
}
let s = await run([false]);
assert.equal(writes, 0); assert.equal(reads, 0); assert.equal(s.skippedEntitlement, 1);
assert.equal(store.has('espn:autopilot:user'), false); assert.equal(members.size, 0);
assert.ok(store.has('espn:creds:user'), 'cancellation must not disconnect ESPN');
s = await run([new Error('offline Clerk failure')]);
assert.equal(writes, 0); assert.equal(reads, 0); assert.equal(s.entitlementErrors, 1);
assert.ok(store.has('espn:autopilot:user'), 'transient outage preserves permission');
s = await run([true]); assert.equal(writes, 1); assert.equal(s.applied, 1);
s = await run([true, false]); assert.equal(reads, 1); assert.equal(writes, 0);
assert.equal(store.has('espn:autopilot:user'), false);
s = await run([true, new Error('offline Clerk failure')]);
assert.equal(writes, 0); assert.equal(s.entitlementErrors, 1);
assert.ok(store.has('espn:autopilot:user'));
await run([true], () => store.delete('espn:creds:user'));
assert.equal(writes, 0, 'disconnect during provider read blocks submission');
await run([true], () => store.delete('espn:autopilot:user'));
assert.equal(writes, 0, 'permission revocation during provider read blocks submission');
await run([true], () => seedEpochCredential(store,'user',{espn_s2:'offline-new',swid:'{offline}'},'new'));
assert.equal(writes, 0, 'reconnect during provider read blocks submission');
console.log('PASS: 8 Autopilot entitlement and revocation scenarios; no live calls');

process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,31).toString('base64');
const seedEncrypted=()=>{
 seedEpochCredential(store,'user',{espn_s2:'offline',swid:'{offline}'},'generation-one');
 store.set('espn:autopilot:user',{'mlb:2026:1:1':{sport:'mlb',connectionId:'generation-one'}});
};
await run([true],null,seedEncrypted);assert.equal(writes,1);
await run([true],()=>seedEpochCredential(store,'user',{espn_s2:'offline-new',swid:'{offline}'},'generation-two'),seedEncrypted);
assert.equal(writes,0,'encrypted reconnect invalidates in-flight generation');
await run([true],()=>store.delete('espn:autopilot:user'),seedEncrypted);assert.equal(writes,0);
await run([true],()=>store.delete('espn:creds:user'),seedEncrypted);assert.equal(writes,0);
await run([true],null,()=>{seedEncrypted();store.set('espn:autopilot:user',{'mlb:2026:1:1':{sport:'mlb',connectionId:'stale'}});});assert.equal(writes,0);assert.equal(reads,0);
await run([true],null,()=>{seedEncrypted();process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,32).toString('base64');});
assert.equal(writes,0);assert.ok(store.has('espn:creds:user'));assert.ok(store.has('espn:autopilot:user'));
await run([true],null,()=>{store.set('espn:creds:user',encryptCredentials('user',{espn_s2:'offline',swid:'{offline}'},Date.now()-CREDENTIAL_TTL_SECONDS*1000-1000));});
assert.equal(writes,0);assert.equal(store.has('espn:autopilot:user'),false);
console.log('PASS: encrypted Autopilot, stale/revoked generations, wrong-key preservation and expiry');
