// Actual production Lua and handler, disposable real Redis, synthetic identities/provider only.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { localRedis } from './lib/local-redis.mjs';
process.env.KV_REST_API_URL='https://offline.invalid';process.env.KV_REST_API_TOKEN='synthetic';
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('base64');
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY;
const key=process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;
globalThis.fetch=async()=>{throw new Error('Network forbidden in lifecycle tests');};
const redis=await localRedis(),lib=p=>new URL(`../api/_lib/${p}`,import.meta.url).href;
const user='user_synthetic',creds={espn_s2:'synthetic-only',swid:'{11111111-2222-3333-4444-555555555555}'};
let fanHook=null,commitHook=null,rosterHook=null,providerWrites=0;
const evalReal=redis.eval;
redis.eval=async(script,keys,args)=>{
 if(args[0]==='connect'){
  assert.equal(JSON.parse(args[3]).envelope.version,1,'never commit plaintext');
  if(commitHook){const hook=commitHook;commitHook=null;await hook();}
 }
 return evalReal(script,keys,args);
};
const kv=await import(lib('kv.js')),auth=await import(lib('auth.js')),f=await import(lib('espnFantasy.js'));
const life=await import(lib('espnLifecycle.js')),dna=await import(lib('leagueDnaConsent.js'));
const advisor=await import(lib('lineupAdvisor.js'));
mock.module(lib('kv.js'),{namedExports:{...kv,redis}});
mock.module(lib('auth.js'),{namedExports:{...auth,requireUser:async()=>({userId:user}),requirePremium:async()=>({userId:user}),premiumForUser:async()=>true}});
mock.module(lib('espnFantasy.js'),{namedExports:{...f,
 fetchFanLeagues:async()=>{if(fanHook){const h=fanHook;fanHook=null;await h();}return [];},
 fetchLeagueRoster:async()=>{if(rosterHook){const h=rosterHook;rosterHook=null;await h();}return {roster:[],scoringPeriodId:1};},
 fetchNflByes:async()=>({}),setLineup:async()=>{providerWrites++;return {applied:1};},
}});
mock.module(lib('lineupAdvisor.js'),{namedExports:{...advisor,buildValueIndex:()=>new Map(),suggestLineup:()=>({plan:[{playerId:1}],moves:[],summary:{}})}});
const {default:handler}=await import('../api/espn/index.js');
const {default:cron}=await import('../api/cron/autopilot.js');
async function post(body){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};await handler({method:'POST',headers:{},body},res);return res;}
const connect=()=>post({action:'connect',...creds,dnaNotice:{version:2,include:true}});
const disconnect=()=>post({action:'disconnect'});
const barrier=()=>{let entered,release;const reached=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);return {reached,release,hold:async()=>{entered();await blocked;}};};
const conflict=result=>{assert.equal(result.statusCode,409);assert.equal(result.body.error,'connection_changed');assert.notEqual(result.body.connected,false);};
const disconnected=async()=>{
 assert.equal(await f.getCreds(redis,user),null);assert.deepEqual(await f.getAutopilot(redis,user),{});
 assert.equal((await redis.smembers('espn:autopilot:users')).includes(user),false);
 assert.equal(await dna.getDnaConsent(redis,user),null);assert.equal((await redis.smembers('espn:dna:users')).includes(user),false);
};
try {
 // Pause at the exact pre-EVAL boundary that reproduced the old unconditional SET race.
 assert.equal((await connect()).statusCode,200);
 const stop=barrier();commitHook=stop.hold;const pending=connect();await stop.reached;
 assert.equal((await disconnect()).statusCode,200);await disconnected();stop.release();conflict(await pending);await disconnected();
 console.log('PASS: paused credential commit cannot resurrect credentials, automation or DNA after disconnect');
 assert.equal((await connect()).statusCode,200);assert.ok(await f.getCreds(redis,user));
 assert.ok(await redis.command('TTL',`espn:creds:${user}`)>0);
 assert.equal(await redis.command('TTL',`espn:lifecycle:${user}`),-1);
 console.log('PASS: genuinely new post-disconnect connect succeeds; credential TTL and persistent revision');
 const revision=await life.beginLifecycle(redis,user);
 const pair=await Promise.allSettled([f.saveCreds(redis,user,creds,revision),f.saveCreds(redis,user,creds,revision)]);
 assert.equal(pair.filter(r=>r.status==='fulfilled').length,1);assert.equal(pair.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 console.log('PASS: overlapping reconnects from one revision have exactly one winner');
 for(let i=0;i<5;i++){
  const validation=barrier();fanHook=validation.hold;const old=connect();await validation.reached;
  assert.equal((await disconnect()).statusCode,200);assert.equal((await connect()).statusCode,200);
  const latest=await f.getCreds(redis,user);validation.release();conflict(await old);
  assert.deepEqual(await f.getCreds(redis,user),latest);
 }
 console.log('PASS: repeated disconnect during provider validation rejects old operations and preserves new connect');
 // Permission/consent snapshots taken before revocation cannot re-enable state.
 let current=await f.getCreds(redis,user),oldRevision=current.lifecycleRevision;
 await f.setAutopilotLeague(redis,user,'mlb:2026:1:1',false,'mlb','legacy',oldRevision);
 await assert.rejects(f.setAutopilotLeague(redis,user,'mlb:2026:1:1',true,'mlb',current.connectionId,oldRevision),e=>e.status===409);
 oldRevision=await life.beginLifecycle(redis,user);
 await dna.recordDnaChoice(redis,user,{version:2,include:false,via:'settings'},oldRevision);
 await assert.rejects(dna.recordDnaChoice(redis,user,{version:2,include:true,via:'settings'},oldRevision),e=>e.status===409);
 assert.equal((await redis.smembers('espn:autopilot:users')).includes(user),false);assert.equal((await redis.smembers('espn:dna:users')).includes(user),false);
 console.log('PASS: stale permission and consent requests cannot undo revocation');
 await redis.set(kv.DATASET_KEY,{players:[{name:'synthetic'}]});
 rosterHook=async()=>{await dna.recordDnaChoice(redis,user,{version:2,include:false,via:'settings'});};
 conflict(await post({action:'apply',sport:'mlb',leagueId:'1',season:2026,teamId:1}));assert.equal(providerWrites,0);
 console.log('PASS: Apply rejects changed lifecycle revision even with unchanged credential generation');
 current=await f.getCreds(redis,user);
 await f.setAutopilotLeague(redis,user,'mlb:2026:1:1',true,'mlb',current.connectionId,current.lifecycleRevision);
 rosterHook=async()=>{await f.setAutopilotLeague(redis,user,'mlb:2026:1:1',false);};
 process.env.CRON_SECRET='synthetic-cron';
 const res={status(n){this.code=n;return this;},json(v){this.body=v;return this;}};
 await cron({headers:{authorization:'Bearer synthetic-cron'}},res);assert.equal(providerWrites,0);
 console.log('PASS: Autopilot rejects revoked permission/lifecycle revision during planning');
 for(const bad of [null,'malformed']){
  const before=await life.readLifecycle(redis,user);
  if(bad===null)delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;else process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=bad;
  assert.equal((await connect()).statusCode,503);assert.deepEqual(await life.readLifecycle(redis,user),before);
 }
 process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=randomBytes(32).toString('base64');
 assert.equal((await post({action:'status'})).statusCode,503);process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=key;
 console.log('PASS: missing/malformed/wrong key behavior remains explicit, with no plaintext fallback');
 // A wrong-type membership must fail before revision/credential changes: Lua errors aren't rollback.
 const before=await life.readLifecycle(redis,user);
 await redis.command('SET','espn:autopilot:users','bad-type');
 await assert.rejects(f.saveCreds(redis,user,creds));assert.deepEqual(await life.readLifecycle(redis,user),before);
 await redis.del('espn:autopilot:users');
 console.log('PASS: Lua preflight prevents partial commits on invalid storage types');
 assert.equal((await disconnect()).statusCode,200);await disconnected();
 console.log('PASS: all deterministic lifecycle interleavings; zero live resources/provider writes');
} finally {await redis.close();}
