import assert from 'node:assert/strict';
import { encryptCredentials, decryptCredentials, migrateLegacyCredentials, CREDENTIAL_TTL_SECONDS } from '../api/_lib/espnCredentials.js';
const key = Buffer.alloc(32, 1).toString('base64'); // synthetic, never a deployment key
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = key;
const creds = { espn_s2: 'offline-cookie', swid: '{offline-owner}', savedAt: '2026-09-12T00:00:00Z' };
const now = Date.now();
const envelope = encryptCredentials('u', creds, now);
assert.equal(envelope.version, 1);
assert.equal(JSON.stringify(envelope).includes(creds.espn_s2), false);
assert.equal(decryptCredentials('u', envelope, now).espn_s2, creds.espn_s2);
assert.notEqual(encryptCredentials('u',creds,now).iv, envelope.iv);
assert.throws(() => decryptCredentials('other', envelope, now));
assert.throws(() => decryptCredentials('u', {...envelope, tag:Buffer.alloc(16).toString('base64')}, now));
assert.throws(() => decryptCredentials('u', {...envelope, tag:Buffer.from(envelope.tag,'base64').subarray(0,4).toString('base64')}, now));
assert.equal(decryptCredentials('u', envelope, now + CREDENTIAL_TTL_SECONDS*1000), null);
process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY = key;
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32,2).toString('base64');
assert.equal(decryptCredentials('u',envelope,now).swid,creds.swid);
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY;
assert.throws(() => decryptCredentials('u', envelope, now));
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;
assert.throws(() => encryptCredentials('u',creds));
assert.equal(decryptCredentials('u',creds),creds,'legacy remains compatible without a key');
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = 'malformed';
assert.throws(() => encryptCredentials('u',creds));
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = key;
let current = JSON.stringify(creds), expiry;
const redis = { eval: async (script, keys, args) => {
  if(current!==args[0]) return 0;
  current=args[1]; expiry=args[2]; return 1;
} };
assert.equal(await migrateLegacyCredentials(redis,'u',creds),true);
assert.equal(expiry,CREDENTIAL_TTL_SECONDS);
assert.equal(decryptCredentials('u',JSON.parse(current)).swid,creds.swid);
current=null;
assert.equal(await migrateLegacyCredentials(redis,'u',creds),false,'disconnect wins migration race');
assert.equal(current,null);
current='new connection';
assert.equal(await migrateLegacyCredentials(redis,'u',creds),false,'reconnect wins migration race');
assert.equal(current,'new connection');
console.log('PASS: authenticated encryption, user binding, tamper rejection, expiry, rotation, legacy compatibility and migration races');

// Diagnostics must not echo a credential-bearing fan URL or provider response.
const { fetchLeagueRoster, discoverFanLeagues, setLineup } = await import('../api/_lib/espnFantasy.js');
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const warnings = [];
try {
  globalThis.fetch = async () => ({ok:false,status:400,text:async()=>JSON.stringify(creds)});
  await assert.rejects(fetchLeagueRoster(creds,{leagueId:'1',seasonId:2026,teamId:1}),
    e => e.message === 'ESPN HTTP 400');
  const { diag } = await discoverFanLeagues(creds);
  assert.equal(diag.error, 'ESPN HTTP 400');
  assert.equal(JSON.stringify(diag).includes(creds.swid),false);
  globalThis.fetch = async () => ({ok:false,status:409,text:async()=>JSON.stringify(creds)});
  console.warn = (...args) => warnings.push(args.join(' '));
  await assert.rejects(setLineup(creds,{leagueId:'1',seasonId:2026,teamId:1,scoringPeriodId:1},
    [{playerId:1,fromLineupSlotId:16,toLineupSlotId:5}]),e=>e.message==='ESPN lineup write HTTP 409');
  assert.equal(warnings.join().includes(creds.espn_s2),false);
  assert.equal(warnings.join().includes(creds.swid),false);
} finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
console.log('PASS: read, fan and lineup diagnostics omit credential URLs and provider bodies');
