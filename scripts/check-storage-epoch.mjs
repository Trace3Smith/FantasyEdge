// Exact-source offline rehearsal: actual Lua, disposable Redis, synthetic identities.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { localRedis } from './lib/local-redis.mjs';
import { sdkLocalRedis } from './lib/sdk-local-redis.mjs';
import { epochRedis, epochKey, CONTROL, registerEpochScript } from '../api/_lib/storageEpoch.js';
import { beginBootstrap, captureManifest, bootstrapUser, importManifest, sealBootstrap, activateBootstrap, verifyBootstrap, PENDING_MS } from './lib/epoch-bootstrap.mjs';
import { encryptCredentials, decryptActive } from '../api/_lib/espnCredentials.js';
import * as f from '../api/_lib/espnFantasy.js';
import { beginLifecycle, readLifecycle } from '../api/_lib/espnLifecycle.js';
import { pendingCandidate } from '../api/_lib/espnPending.js';
import { getDnaConsent, recordDnaChoice } from '../api/_lib/leagueDnaConsent.js';
import { getWatch, setWatch } from '../api/_lib/prospectWatch.js';
process.env.KV_REST_API_URL='https://offline.invalid';process.env.KV_REST_API_TOKEN='synthetic';
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=Buffer.alloc(32,43).toString('base64');
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY;
globalThis.fetch=async()=>{throw Error('NETWORK_FORBIDDEN');};
const raw=await (process.env.FE_TEST_UPSTASH_SDK === '1' ? sdkLocalRedis() : localRedis()), redis=epochRedis(raw), user='synthetic-user', run='synthetic-run';
const legacy={espn_s2:'synthetic-cookie',swid:'{11111111-2222-3333-4444-555555555555}'};
let authenticated=true,premium=true,providerFails=false,providerCalls=0,providerHook=null,discoveryEmpty=false;
const lib=p=>new URL(`../api/_lib/${p}`,import.meta.url).href;
const kv=await import(lib('kv.js')),auth=await import(lib('auth.js'));
mock.module(lib('kv.js'),{namedExports:{...kv,redis}});
const identity=async()=>{if(!authenticated)throw new auth.HttpError(401,'Sign in');return {userId:user};};
mock.module(lib('auth.js'),{namedExports:{...auth,requireUser:identity,requirePremium:async()=>{const i=await identity();if(!premium)throw new auth.HttpError(403,'Premium');return i;}}});
mock.module(lib('espnFantasy.js'),{namedExports:{...f,discoverFanLeagues:async()=>{providerCalls++;if(providerHook)await providerHook();if(providerFails)throw Error('provider unavailable');return {diag:{ok:!discoveryEmpty},leagues:discoveryEmpty?[]:[{leagueId:'1',teamId:1,seasonId:2026,sport:'mlb'}]};},fetchLeagueRoster:async()=>({teamId:1,roster:[]})}});
const {default:handler}=await import('../api/espn/index.js');
async function post(body){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};await handler({method:'POST',headers:{},body},res);return res;}
const confirm=()=>post({action:'confirmConnection',confirm:true});
try {
 await assert.rejects(redis.get('espn:creds:'+user));
 await raw.set(CONTROL,{phase:'active'});await assert.rejects(redis.get('x'));await raw.del(CONTROL);

 await assert.rejects(redis.get('fe:e1:x'));
 assert.throws(()=>redis.set('espn:creds:x',legacy));
 assert.equal(redis.pipeline,undefined);assert.equal(redis.multi,undefined);assert.equal(redis.sendCommand,undefined);
 assert.throws(()=>redis.eval("return redis.call('GET','espn:creds:x')",[],[]));
 assert.throws(()=>registerEpochScript("return redis.call('GET', 'espn:creds:x')"));
 assert.throws(()=>registerEpochScript("KEYS[1] = 'legacy'; return redis.call('GET', KEYS[1])"));
 await raw.set(`espn:creds:${user}`,legacy);
 await raw.set('espn:creds:bad',{version:55});
 await raw.set('espn:creds:expired',encryptCredentials('expired',legacy,Date.now()-2000,Date.now()-1000));
 await raw.set('espn:creds:short',encryptCredentials('short',legacy,Date.now(),Date.now()+60000));
 await beginBootstrap(raw,run);await beginBootstrap(raw,run);
 await assert.rejects(redis.get('espn:creds:'+user));
 await captureManifest(raw,run);
 await assert.rejects(sealBootstrap(raw,run));
 assert.equal(await bootstrapUser(raw,run,user),'pending');
 const pendingBytes=await raw.command('GET',epochKey(`bootstrap:creds:${user}`));
 assert.equal(pendingBytes.includes(legacy.espn_s2),false);
 const pending=JSON.parse(pendingBytes);
 assert.ok(pending.expiresAt-Date.now()<=PENDING_MS && pending.expiresAt-Date.now()>PENDING_MS-3000);
 assert.equal(await raw.command('EXISTS',epochKey(`espn:creds:${user}`)),0);
 await raw.set(`espn:creds:${user}`,{...legacy,espn_s2:'late-before-seal'});
 assert.equal(await bootstrapUser(raw,run,user),'unchanged');
 assert.equal(await raw.command('GET',epochKey(`bootstrap:creds:${user}`)),pendingBytes);
 await importManifest(raw,run);assert.equal((await importManifest(raw,run)).unchanged,4);
 // Hook represents import already read/encrypted before a concurrently sealing operator.
 await raw.set('espn:creds:race',legacy);
 // Existing completed-user retries may return no-op only while preparing.
 await sealBootstrap(raw,run);
 await assert.rejects(bootstrapUser(raw,run,user));
 await assert.rejects(redis.get('espn:creds:'+user));
 assert.equal((await verifyBootstrap(raw,run)).complete,4);
 await activateBootstrap(raw,run);
 await assert.rejects(beginBootstrap(raw,run));await assert.rejects(captureManifest(raw,run));
 assert.equal(await f.getCreds(redis,user),null);
 assert.equal(await f.getCreds(redis,'unlisted'),null);
 assert.equal(await redis.quotaBlocked(),true);
 assert.ok(await pendingCandidate(redis,user));
 assert.equal(await pendingCandidate(redis,user,pending.expiresAt),null);
 assert.equal(await pendingCandidate(redis,'expired'),null);
 assert.equal(await pendingCandidate(redis,'bad'),null);
 assert.ok((await pendingCandidate(redis,'short')).candidate.expiresAt<Date.now()+61000);
 authenticated=false;assert.equal((await confirm()).statusCode,401);assert.equal(providerCalls,0);authenticated=true;
 premium=false;assert.equal((await confirm()).statusCode,403);premium=true;
 assert.equal((await post({action:'confirmConnection'})).statusCode,400);assert.equal(providerCalls,0);
 providerFails=true;assert.equal((await confirm()).statusCode,401);assert.equal(await f.getCreds(redis,user),null);providerFails=false;
 discoveryEmpty=true;assert.equal((await confirm()).statusCode,401);assert.equal(await f.getCreds(redis,user),null);discoveryEmpty=false;
 assert.equal((await confirm()).statusCode,200);
 const active=await f.getCreds(redis,user);assert.ok(active.connectionId);assert.equal(active.storageEpoch,'e1');
 assert.equal(await pendingCandidate(redis,user),null);
 assert.deepEqual(await f.getAutopilot(redis,user),{});assert.equal(await getDnaConsent(redis,user),null);
 // Late old commands do not affect e1, including decision datasets.
 const before=await readLifecycle(redis,user);
 for(const [key,value] of [[`espn:creds:${user}`,legacy],[`espn:autopilot:${user}`,{'mlb:2026:1:1':true}],[`espn:dna:ack:${user}`,{version:2,include:true}],[`espn:prospectwatch:${user}`,{old:{lg:'old'}}],[`espn:manualleagues:${user}`,[{leagueId:'old'}]],[kv.DATASET_KEY,{players:['old']}]] ) await raw.set(key,value);
 await raw.sadd('espn:autopilot:users',user);await raw.sadd('espn:dna:users',user);
 assert.deepEqual(await readLifecycle(redis,user),before);assert.deepEqual(await f.getAutopilot(redis,user),{});
 assert.equal(await getDnaConsent(redis,user),null);assert.deepEqual(await getWatch(redis,user),{});assert.deepEqual(await f.getManualLeagues(redis,user),[]);
 assert.equal(await redis.get(kv.DATASET_KEY),null);
 const {default:synopsis}=await import('../api/synopsis/index.js');
 const coldRes={setHeader(){},statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};
 await synopsis({method:'POST',headers:{},body:{sport:'mlb',playerId:'synthetic'}},coldRes);
 assert.equal(coldRes.statusCode,503);assert.equal(coldRes.body.error,'no_dataset');
 let rebuilt=0;
 mock.module(lib('buildNflDataset.js'),{namedExports:{buildNflDataset:async()=>{rebuilt++;return {players:[{id:'fresh-provider-fixture'}]};}}});
 const {loadPlayers}=await import('../api/_lib/draft.js');
 await raw.set(kv.NFL_DATASET_KEY,{version:kv.DATASET_VERSION,players:[{id:'legacy-only'}]});
 assert.equal((await loadPlayers('nfl'))[0].id,'fresh-provider-fixture');
 assert.equal((await loadPlayers('nfl'))[0].id,'fresh-provider-fixture');assert.equal(rebuilt,1);
 assert.equal((await redis.get(kv.NFL_DATASET_KEY)).players[0].id,'fresh-provider-fixture');
 assert.equal(await redis.quotaBlocked(),true);


 // Cold activation: legacy datasets are ignored; rebuilt data and NX/PX locks stay in e1.
 assert.equal(await redis.set('synthetic:cooldown', 1, {nx:true,px:60000}), 'OK');
 assert.equal(await redis.set('synthetic:cooldown', 2, {nx:true,px:60000}), null);
 assert.ok(await raw.command('PTTL',epochKey('synthetic:cooldown'))>0);
 await redis.set(kv.DATASET_KEY,{players:[{id:'synthetic-fresh'}]});
 assert.deepEqual(await redis.get(kv.DATASET_KEY),{players:[{id:'synthetic-fresh'}]});
 for(const value of ['123','true','null','{"x":1}',[1,'2'],{x:'3'}]) {
  await redis.set('synthetic:codec',value);assert.deepEqual(await redis.get('synthetic:codec'),value);
 }
 await Promise.all([redis.set('synthetic:pipeline1',1),redis.set('synthetic:pipeline2',2)]);
 assert.deepEqual(await Promise.all([redis.get('synthetic:pipeline1'),redis.get('synthetic:pipeline2')]),[1,2]);
 assert.equal(await raw.command('EXISTS','synthetic:pipeline1'),0);

 await raw.command('DEL',`espn:creds:${user}`);assert.deepEqual(await readLifecycle(redis,user),before);
 // New associations bind to generation and cannot survive reconnect; stale writes conflict.
 await setWatch(redis,user,{synthetic:{lg:'mlb:2026:1:1'}},active);
 const current=await f.getCreds(redis,user);
 await f.addManualLeague(redis,user,{leagueId:'1',season:2026},current);
 const stale=await f.getCreds(redis,user);await f.saveCreds(redis,user,legacy);
 await assert.rejects(setWatch(redis,user,{bad:{}},stale));
 assert.deepEqual(await getWatch(redis,user),{});assert.deepEqual(await f.getManualLeagues(redis,user),[]);
 await recordDnaChoice(redis,user,{version:2,include:true,via:'settings'});
 assert.equal((await getDnaConsent(redis,user)).include,true);
 // Future My Edge CONTRACT fixture uses the exact same epoch/codec/lifecycle; not104 certification.
 const future=epochRedis(raw), futureBefore=await f.getCreds(future,user);
 await f.setAutopilotLeague(future,user,'mlb:2026:1:1',true,'mlb',futureBefore.connectionId,futureBefore.lifecycleRevision);
 const rollback=epochRedis(raw);assert.equal((await f.getCreds(rollback,user)).connectionId,futureBefore.connectionId);
 assert.ok((await f.getAutopilot(rollback,user))['mlb:2026:1:1']);
 await f.deleteCreds(rollback,user);assert.equal(await f.getCreds(future,user),null);
 console.log('PASS epoch rehearsal: bootstrap/seal/activate, late legacy writes, auth/provider confirmation, expiry, association CAS, future-contract rollback');
 // Separate actual interleaving: last import pauses after source read; seal cannot pass
 // incomplete manifest; after completion, any additional import is rejected.
 await raw.command('FLUSHDB');await raw.set(`espn:creds:${user}`,legacy);await beginBootstrap(raw,run);await captureManifest(raw,run);
 let release,entered;const blocked=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
 const job=bootstrapUser(raw,run,user,{beforeCommit:async()=>{entered();await blocked;}});await reached;
 await assert.rejects(sealBootstrap(raw,run));release();await job;await sealBootstrap(raw,run);await assert.rejects(bootstrapUser(raw,run,user));
 // Duplicate importer reads while the first commit races sealing: late commit refuses.
 await raw.command('FLUSHDB');await raw.set(`espn:creds:${user}`,legacy);await beginBootstrap(raw,run);await captureManifest(raw,run);
 let release2,entered2;const wait2=new Promise(r=>release2=r),seen2=new Promise(r=>entered2=r);
 const late=bootstrapUser(raw,run,user,{beforeCommit:async()=>{entered2();await wait2;}});await seen2;
 await bootstrapUser(raw,run,user);await sealBootstrap(raw,run);release2();await assert.rejects(late);
 await activateBootstrap(raw,run);
 providerHook=()=>f.deleteCreds(redis,user);
 assert.equal((await confirm()).statusCode,409);assert.equal(await f.getCreds(redis,user),null);providerHook=null;
 // Expiry during provider validation is checked by Redis TIME at the final commit.
 await raw.command('FLUSHDB');await raw.set(`espn:creds:${user}`,legacy);await beginBootstrap(raw,run);await captureManifest(raw,run);await importManifest(raw,run);await sealBootstrap(raw,run);await activateBootstrap(raw,run);
 providerHook=()=>raw.command('PEXPIREAT',epochKey(`bootstrap:creds:${user}`),Date.now()-1);
 assert.equal((await confirm()).statusCode,409);assert.equal(await f.getCreds(redis,user),null);providerHook=null;
 await raw.set(CONTROL,'malformed');await assert.rejects(redis.get('dataset:mlb'));
 await raw.del(CONTROL);await assert.rejects(beginBootstrap(raw,run),'refuse nonempty epoch reuse');
 console.log('PASS actual Redis import/seal, duplicate importer, disconnect/expiry during confirmation, malformed control and nonempty-epoch rejection');
 if(raw.stats){assert.ok(raw.stats.pipelines>0);console.log('PASS installed SDK 1.38.0 EVAL/REST/base64/automatic pipelines/codec/NX/PX: '+JSON.stringify(raw.stats));}
} finally {await raw.close();}
