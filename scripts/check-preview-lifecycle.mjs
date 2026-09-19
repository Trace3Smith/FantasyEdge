// Actual isolated Preview adapter + actual Lua under a restricted local Redis ACL.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { randomBytes } from 'node:crypto';
import { localRedis } from './lib/local-redis.mjs';
import { configurePreview } from './preview-test-config.mjs';
configurePreview();
const redis=await localRedis(),password=randomBytes(24).toString('hex');
const user='user_test',key=`preview:espn:creds:${user}`,revisionKey=key+':lifecycle';
await redis.set('fe:preview:project','prj_test');
await redis.command('ACL','SETUSER','preview-writer','reset','on','>'+password,'~preview:espn:creds:user_*','+get','+set','+del','+eval');
const writes=[],providerCalls=[];
let commitHook=null,fanHook=null;
class Redis {
 constructor(options){assert.equal(options.url,'https://isolated-test.upstash.io');this.token=options.token;}
 async get(k){assert.equal(this.token,'test-read');return redis.get(k);}
 async eval(script,keys,args){
  assert.equal(this.token,'test-credential');for(const k of keys)assert.match(k,/^preview:espn:creds:user_/);
  assert.equal(keys[1],keys[0]+':lifecycle');
  if(args[0]==='connect'){
   assert.equal(JSON.parse(args[2]).version,1);assert.equal(Number(args[3]),7776000);
   if(commitHook){const h=commitHook;commitHook=null;await h();}
  }
  writes.push(args[0]);
  return redis.commandAs('preview-writer',password,'EVAL',script,keys.length,...keys,...args);
 }
}
mock.module('@upstash/redis',{namedExports:{Redis}});
const auth=await import('../api/_lib/auth.js');
mock.module(new URL('../api/_lib/auth.js',import.meta.url).href,{namedExports:{...auth,requireUser:async()=>({userId:user}),requirePremium:async()=>({userId:user})}});
const {default:handler}=await import('../api/espn/index.js');
const {previewCredentials}=await import('../api/_lib/previewCredentials.js');
const creds={espn_s2:'synthetic-only',swid:'{11111111-2222-3333-4444-555555555555}'};
globalThis.fetch=async(url,opts={})=>{
 assert.ok(!opts.method||opts.method==='GET');assert.equal(new URL(url).hostname,'fan.api.espn.com');providerCalls.push('synthetic fan read');
 if(fanHook){const h=fanHook;fanHook=null;await h();}
 return {ok:true,status:200,json:async()=>({preferences:[]})};
};
async function post(body){const res={code:200,setHeader(){},status(c){this.code=c;return this;},json(b){this.body=b;return this;}};await handler({method:'POST',body,headers:{}},res);return res;}
const connect=()=>post({action:'connect',...creds,dnaNotice:{version:2,include:true}}),disconnect=()=>post({action:'disconnect'});
const barrier=()=>{let release,entered;const reached=new Promise(r=>entered=r),blocked=new Promise(r=>release=r);return {reached,release,hold:async()=>{entered();await blocked;}};};
const conflict=r=>{assert.equal(r.code,409);assert.equal(r.body.error,'connection_changed');assert.notEqual(r.body.connected,false);};
try {
 assert.equal((await connect()).code,200);
 const stop=barrier();commitHook=stop.hold;const pending=connect();await stop.reached;
 assert.equal((await disconnect()).code,200);stop.release();conflict(await pending);assert.equal(await previewCredentials.read(user),null);
 assert.equal((await connect()).code,200);assert.ok(await previewCredentials.read(user));
 console.log('PASS: Preview paused reconnect cannot undo disconnect; new reconnect succeeds');
 const revision=await previewCredentials.begin(user);
 const pair=await Promise.allSettled([previewCredentials.save(user,creds,revision),previewCredentials.save(user,creds,revision)]);
 assert.equal(pair.filter(r=>r.status==='fulfilled').length,1);assert.equal(pair.filter(r=>r.status==='rejected'&&r.reason.status===409).length,1);
 for(let i=0;i<5;i++){
  const validation=barrier();fanHook=validation.hold;const old=connect();await validation.reached;
  assert.equal((await disconnect()).code,200);assert.equal((await connect()).code,200);const newer=await previewCredentials.read(user);
  validation.release();conflict(await old);assert.deepEqual(await previewCredentials.read(user),newer);
 }
 console.log('PASS: Preview same-revision contenders and repeated disconnects during provider validation');
 const writesBefore=writes.length,callsBefore=providerCalls.length;
 for(const action of ['apply','autopilot','dnaChoice'])for(const sport of ['mlb','nfl','nba','nhl']){
  for(const dryRun of [false,true])assert.equal((await post({action,sport,on:true,include:true,dryRun})).code,403);
 }
 assert.equal(writes.length,writesBefore);assert.equal(providerCalls.length,callsBefore);
 assert.deepEqual((await redis.command('KEYS','*')).sort(),['fe:preview:project',key,revisionKey].sort());
 console.log('PASS: stale/forged Preview Apply, dry-run, Autopilot and DNA remain blocked before storage/provider calls');
 const original=process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY,envelope=await redis.get(key),rev=await redis.get(revisionKey);
 for(const value of [null,'malformed',randomBytes(32).toString('base64')]){
  if(value===null)delete process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY;else process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=value;
  assert.equal((await post({action:'status'})).code,503);
  if(value===null||value==='malformed')assert.equal((await connect()).code,503);
  assert.deepEqual(await redis.get(key),envelope);assert.equal(await redis.get(revisionKey),rev);
 }
 process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=original;
 assert.ok(await redis.command('TTL',key)>0);assert.equal(await redis.command('TTL',revisionKey),-1);
 // Existing GET/SET/DEL-only ACL must fail closed: no racy fallback and no partial commit.
 await redis.command('ACL','SETUSER','preview-writer','-eval');
 const denied=await connect();assert.equal(denied.code,503);assert.equal(denied.body.reason,'preview_credential_write_failed');
 assert.deepEqual(await redis.get(key),envelope);assert.equal(await redis.get(revisionKey),rev);
 await redis.command('ACL','SETUSER','preview-writer','+eval');
 for(const outside of ['espn:creds:user_test','espn:lifecycle:user_test','fe:preview:project','preview:espn:creds:invalid']){
  await assert.rejects(redis.commandAs('preview-writer',password,'EVAL',"return redis.call('SET',KEYS[1],'forbidden')",1,outside));
 }
 await assert.rejects(redis.commandAs('preview-writer',password,'EVAL',"return redis.call('SADD',KEYS[1],'forbidden')",1,key));
 assert.equal(await redis.get('fe:preview:project'),'prj_test');
 console.log('PASS: key errors, encrypted-only saves, 90-day TTL, persistent revision, denied EVAL and actual ACL namespace/command restrictions');
 // No production alias may be used, even if the isolated configuration is otherwise valid.
 process.env.KV_REST_API_URL='https://production.invalid';
 const attempts=writes.length;assert.equal((await connect()).code,503);assert.equal(writes.length,attempts);delete process.env.KV_REST_API_URL;
 assert.equal((await disconnect()).code,200);assert.equal(await previewCredentials.read(user),null);
 assert.deepEqual((await redis.command('KEYS','*')).sort(),['fe:preview:project',revisionKey].sort());
 console.log('PASS: no production fallback, no plaintext or automation/DNA state under any interleaving');
} finally {await redis.close();}
