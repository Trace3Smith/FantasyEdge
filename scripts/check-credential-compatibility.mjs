import { installLifecycleFake } from './lib/lifecycle-fake.mjs';
// Actual credential storage + API dispatcher; all storage/provider/auth calls are synthetic.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import * as certified from './fixtures/credentials/my-edge-37ccd8d-codec.mjs';
import { encryptCredentials, CREDENTIAL_TTL_SECONDS } from '../api/_lib/espnCredentials.js';
process.env.KV_REST_API_URL = 'https://offline.invalid';
process.env.KV_REST_API_TOKEN = 'offline';
delete process.env.ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY;
const key = Buffer.alloc(32, 19).toString('base64'); // synthetic only
const creds = { espn_s2:'synthetic-cookie', swid:'{11111111-2222-3333-4444-555555555555}' };
const user='synthetic-user', credKey=`espn:creds:${user}`, prefKey=`espn:autopilot:${user}`;
const store=new Map(), sets=new Map(), mutations=[];
const snapshot=()=>JSON.stringify({store:[...store],sets:[...sets].map(([k,v])=>[k,[...v]])});
const redis={
 get:async k=>structuredClone(store.get(k)??null),
 set:async(k,v,opts)=>{
  if(k.startsWith('espn:creds:')) {
   assert.equal(v.version,1,'every credential write must be encrypted');
   assert.deepEqual(Object.keys(v).sort(),['data','iv','tag','version']);
   assert.equal(JSON.stringify(v).includes(creds.espn_s2),false);
   assert.equal(opts?.ex,CREDENTIAL_TTL_SECONDS);
  }
  mutations.push(['set',k]);store.set(k,structuredClone(v));
 },
 del:async k=>{mutations.push(['del',k]);store.delete(k);},
 sadd:async(k,u)=>{mutations.push(['sadd',k]);if(!sets.has(k))sets.set(k,new Set());sets.get(k).add(u);},
 srem:async(k,u)=>{mutations.push(['srem',k]);sets.get(k)?.delete(u);},
 smembers:async k=>[...(sets.get(k)||[])],
};
installLifecycleFake(redis);
// Any accidentally unmocked network request fails this offline suite.
globalThis.fetch=async()=>{throw new Error('Unexpected network request in compatibility test');};
const lib=p=>new URL(`../api/_lib/${p}`,import.meta.url).href;
const kv=await import(lib('kv.js')), auth=await import(lib('auth.js'));
const f=await import(lib('espnFantasy.js')), advisor=await import(lib('lineupAdvisor.js'));
let premium=true, duringRoster=null, writes=0;
mock.module(lib('kv.js'),{namedExports:{...kv,redis}});
mock.module(lib('auth.js'),{namedExports:{...auth,
 requireUser:async()=>({userId:user}),
 requirePremium:async()=>{if(!premium)throw new auth.HttpError(403,'Premium required');return {userId:user};},
}});
mock.module(lib('espnFantasy.js'),{namedExports:{...f,
 fetchFanLeagues:async()=>[],
 fetchLeagueRoster:async()=>{if(duringRoster)await duringRoster();return {roster:[],scoringPeriodId:1};},
 fetchNflByes:async()=>({}),
 setLineup:async()=>{writes++;return {applied:1};},
}});
mock.module(lib('lineupAdvisor.js'),{namedExports:{...advisor,
 buildValueIndex:()=>new Map(),suggestLineup:()=>({plan:[{playerId:1}],moves:[],summary:{}}),
}});
const {default:handler}=await import('../api/espn/index.js');
async function post(body){const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};await handler({method:'POST',headers:{},body},res);return res;}
function reset(){store.clear();sets.clear();mutations.length=0;premium=true;duringRoster=null;writes=0;process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=key;}
const connect=()=>post({action:'connect',...creds});
const seedPermissions=()=>{
 store.set(prefKey,{'mlb:2026:1:1':{sport:'mlb',connectionId:'old'}});
 sets.set('espn:autopilot:users',new Set([user]));
 store.set(`espn:dna:ack:${user}`,{version:2,include:true});
 sets.set('espn:dna:users',new Set([user]));
};
reset();store.set(credKey,creds);delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;
let before=snapshot();assert.deepEqual(await f.getCreds(redis,user),{...creds,lifecycleRevision:'0'});assert.equal(snapshot(),before);assert.equal(mutations.length,0);
assert.equal((await post({action:'status'})).body.connected,true);
console.log('PASS: plaintext reads without a key never write or migrate');

for(const bad of [undefined,'malformed',Buffer.alloc(31).toString('base64'),key.slice(0,-1)]){
 for(const existing of [null,creds,certified.encryptCredentials]){
  reset();seedPermissions();
  if(existing)store.set(credKey,existing===creds?creds:certified.encryptCredentials(user,creds));
  if(bad===undefined)delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;else process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=bad;
  before=snapshot();
  await assert.rejects(f.saveCreds(redis,user,creds),e=>e.status===503);
  assert.equal((await connect()).statusCode,503);
  assert.equal(snapshot(),before,'failed save preserves credentials, permissions and memberships');
  assert.equal(mutations.length,0,'no state writes before key validation');
 }
}
console.log('PASS: missing/malformed keys block first saves and reconnects before all state changes');

reset();assert.equal((await connect()).statusCode,200);
const first=await f.getCreds(redis,user);assert.ok(first.connectionId);
seedPermissions();assert.equal((await connect()).statusCode,200);
const second=await f.getCreds(redis,user);assert.notEqual(second.connectionId,first.connectionId);
assert.equal(store.has(prefKey),false);assert.equal(sets.get('espn:autopilot:users').has(user),false);
// Missing/wrong keys never turn an encrypted record into disconnected or modify it.
for(const bad of [undefined,Buffer.alloc(32,20).toString('base64'),'bad']){
 if(bad===undefined)delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;else process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=bad;
 before=snapshot();await assert.rejects(f.getCreds(redis,user),e=>e.status===503);
 const status=await post({action:'status'});assert.equal(status.statusCode,503);assert.notEqual(status.body.connected,false);assert.equal(snapshot(),before);
}
console.log('PASS: encrypted saves only; fresh reconnect generation and explicit key-read failures');

reset();store.set(credKey,encryptCredentials(user,creds,Date.now()-CREDENTIAL_TTL_SECONDS*1000-1000));
before=snapshot();assert.equal(await f.getCreds(redis,user),null);assert.equal((await post({action:'status'})).body.connected,false);assert.equal(snapshot(),before);
reset();store.set(credKey,{version:1,data:'unreadable-synthetic'});seedPermissions();premium=false;delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;
assert.equal((await post({action:'disconnect'})).statusCode,200);
assert.equal(store.has(credKey),false);assert.equal(store.has(prefKey),false);assert.equal(store.has(`espn:dna:ack:${user}`),false);
assert.equal(sets.get('espn:autopilot:users').has(user),false);assert.equal(sets.get('espn:dna:users').has(user),false);
console.log('PASS: expiry; disconnect revokes credentials, automation and DNA without key/Premium');

for(const sport of ['mlb','wnba','nfl']){
 for(const event of ['none','disconnect','reconnect']){
  reset();await f.saveCreds(redis,user,creds);
  store.set({mlb:kv.DATASET_KEY,wnba:kv.WNBA_DATASET_KEY,nfl:kv.NFL_DATASET_KEY}[sport],{players:[{name:'Synthetic'}]});
  if(event==='disconnect')duringRoster=()=>f.deleteCreds(redis,user);
  if(event==='reconnect')duringRoster=()=>f.saveCreds(redis,user,creds);
  const result=await post({action:'apply',sport,leagueId:'1',season:2026,teamId:1});
  assert.equal(result.statusCode,event==='none'?200:409);assert.equal(writes,event==='none'?1:0);
  if(event==='none'){
   const enabled=await post({action:'autopilot',sport,on:true,league:{leagueId:'1',season:2026,teamId:1}});
   assert.equal(enabled.statusCode,200);
   assert.equal((await f.getAutopilot(redis,user))[`${sport}:2026:1:1`].connectionId,(await f.getCreds(redis,user)).connectionId);
  }
 }
}
for(const sport of ['nba','nhl']){
 reset();await f.saveCreds(redis,user,creds);
 for(const dryRun of [false,true])assert.equal((await post({action:'apply',sport,dryRun,leagueId:'1',season:2026,teamId:1})).statusCode,400);
 assert.equal((await post({action:'autopilot',sport,on:true,league:{leagueId:'1',season:2026,teamId:1}})).statusCode,400);assert.equal(writes,0);
}
console.log('PASS: supported Apply/Autopilot unchanged; stale Apply generations and disabled sports denied');

// Freeze the real certified codec: verify both directions, not two copies of this branch's codec.
reset();await f.saveCreds(redis,user,creds);
const baseline=await f.getCreds(redis,user);
const withoutRevision=({lifecycleRevision,...rest})=>rest;
assert.deepEqual(certified.decryptCredentials(user,store.get(credKey)),withoutRevision(baseline));
const edgeCreds={...withoutRevision(baseline),connectionId:'synthetic-my-edge-generation'};
store.set(credKey,certified.encryptCredentials(user,edgeCreds));
const returned=await f.getCreds(redis,user);assert.equal(returned.connectionId,edgeCreds.connectionId);assert.equal(returned.espn_s2,creds.espn_s2);
await f.saveCreds(redis,user,creds);
assert.deepEqual(certified.decryptCredentials(user,store.get(credKey)),withoutRevision(await f.getCreds(redis,user)));
await f.deleteCreds(redis,user);assert.equal(certified.decryptCredentials(user,store.get(credKey)),null);
console.log('PASS: baseline → certified My Edge v1 → baseline interoperability; revocation survives rollback');
