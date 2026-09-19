import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { configurePreview } from './preview-test-config.mjs';
configurePreview();
const store=new Map([['fe:preview:project','prj_test']]),writes=[];
let failReadKey=null;
class Redis {
 constructor(options){assert.equal(options.url,'https://isolated-test.upstash.io');this.token=options.token;}
 async get(key){if(key===failReadKey)throw new Error('synthetic private Redis detail');assert.equal(this.token,'test-read');return structuredClone(store.get(key)??null);}
 async eval(script,keys,args){
  assert.equal(this.token,'test-credential');
  for(const key of keys)assert.match(key,/^preview:espn:creds:user_/);
  const [key,revision]=keys,[op,expected,json,ttl]=args;
  const current=String(store.get(revision)??0);
  if(op!=='disconnect'&&current!==expected)return null;
  const next=String(Number(current)+1);store.set(revision,next);writes.push(key);
  if(op==='connect'){const envelope=JSON.parse(json);assert.equal(envelope.version,1);assert.equal(Number(ttl),7776000);store.set(key,envelope);}
  else {assert.equal(op,'disconnect');store.delete(key);}
  return next;
 }
}
mock.module('@upstash/redis',{namedExports:{Redis}});
const auth=await import('../api/_lib/auth.js');
let premium=true;
mock.module(new URL('../api/_lib/auth.js',import.meta.url).href,{namedExports:{...auth,
 requireUser:async()=>({userId:'user_test'}),requirePremium:async()=>{if(!premium)throw new auth.HttpError(403,'Premium required');return {userId:'user_test'};}}});
const {default:handler}=await import('../api/espn/index.js');
const {previewCredentials}=await import('../api/_lib/previewCredentials.js');
const {migrateLegacyCredentials}=await import('../api/_lib/espnCredentials.js');
const {previewConfig}=await import('../api/_lib/previewIsolation.js');
const swid='{11111111-2222-3333-4444-555555555555}',cookie='offline-cookie-only';
let providerReads=0;
globalThis.fetch=async(url,opts={})=>{assert.ok(!opts.method||opts.method==='GET');providerReads++;return {ok:true,status:200,json:async()=>({preferences:[]})};};
const response=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.code=c;return this;},json(body){this.body=body;return this;}});
async function post(body){const r=response();await handler({method:'POST',headers:{},body},r);return r;}
const connected=await post({action:'connect',swid,espn_s2:cookie,dnaNotice:{version:2,include:true}});
assert.equal(connected.code,200);assert.equal(connected.body.connected,true);
const encrypted=store.get('preview:espn:creds:user_test');assert.equal(encrypted.version,1);
assert.ok(!JSON.stringify(encrypted).includes(cookie));assert.ok(!JSON.stringify(connected.body).includes(cookie));
assert.equal((await previewCredentials.read('user_test')).espn_s2,cookie);
const previewStatus=(await post({action:'status'})).body;
assert.equal(previewStatus.connected,true);assert.equal(previewStatus.previewReadOnly,true);assert.equal(previewStatus.dnaNotice,null);
assert.deepEqual([...store.keys()].sort(),['fe:preview:project','preview:espn:creds:user_test','preview:espn:creds:user_test:lifecycle']);
const before=JSON.stringify([...store]),count=providerReads;
for(const action of ['apply','autopilot','dnaChoice','tradeScan'])assert.equal((await post({action,on:false,include:true})).code,403);
assert.equal(JSON.stringify([...store]),before);assert.equal(providerReads,count);
await assert.rejects(()=>migrateLegacyCredentials({},'user_test',{espn_s2:cookie,swid}));
premium=false;assert.equal((await post({action:'connect',swid,espn_s2:cookie})).code,403);
assert.equal((await post({action:'disconnect'})).code,200);assert.equal(await previewCredentials.read('user_test'),null);
assert.deepEqual(writes,['preview:espn:creds:user_test','preview:espn:creds:user_test']);
premium=true;
const valid={...process.env};
for(const name of ['FE_PREVIEW_ISOLATED','FE_PREVIEW_PROJECT_ID','VERCEL_PROJECT_ID','FE_PREVIEW_REDIS_REST_URL','FE_PREVIEW_REDIS_READ_ONLY_TOKEN','FE_PREVIEW_ESPN_CREDENTIAL_TOKEN','ESPN_CREDENTIAL_ENCRYPTION_KEY']) {
 delete process.env[name];assert.equal(previewConfig(),null,name);assert.equal((await post({action:'connect',swid,espn_s2:cookie})).code,503);process.env[name]=valid[name];
}
for(const [name,value] of [['VERCEL_PROJECT_ID','prj_wrong'],['FE_PREVIEW_REDIS_REST_URL','http://isolated-test.upstash.io'],['ESPN_CREDENTIAL_ENCRYPTION_KEY','bad'],['KV_REST_API_URL','https://production.upstash.io']]) {
 process.env[name]=value;assert.equal(previewConfig(),null);if(valid[name])process.env[name]=valid[name];else delete process.env[name];
}
process.env.FE_PREVIEW_PROJECT_ID=process.env.VERCEL_PROJECT_ID='prj_A28CS5v2BGhbNTrRJxb3IhGr8XPw';assert.equal(previewConfig(),null);configurePreview();
store.set('fe:preview:project','different-project');assert.equal((await post({action:'connect',swid,espn_s2:cookie})).code,503);assert.equal(writes.length,2);
store.delete('fe:preview:project');await assert.rejects(()=>previewCredentials.disconnect('user_test'));assert.equal(writes.length,2);
console.log('PASS: isolated encrypted connect/read/disconnect, TTL, no DNA capture, Premium connect/free revoke, migration blocked, namespace-only writes, missing/mismatched isolation denied');

for(const [value,reason] of [[null,'preview_database_marker_missing'],['wrong-project','preview_database_marker_mismatch'],[{project:'prj_test'},'preview_database_marker_mismatch']]){
 if(value===null)store.delete('fe:preview:project');else store.set('fe:preview:project',value);
 for(const action of ['status','myEdge']){const r=await post({action});assert.equal(r.code,503);assert.equal(r.body.reason,reason);assert.equal(JSON.stringify(r.body).includes('wrong-project'),false);}
}
store.set('fe:preview:project','prj_test');
await assert.rejects(()=>previewCredentials.read('unexpected-user'),e=>e.payload.reason==='preview_user_id_invalid');
failReadKey='fe:preview:project';
assert.equal((await post({action:'status'})).body.reason,'preview_redis_read_failed');
failReadKey='preview:espn:creds:user_test';
const failed=await post({action:'myEdge'});assert.equal(failed.body.reason,'preview_credential_read_failed');assert.ok(!JSON.stringify(failed.body).includes('synthetic private'));
failReadKey=null;
const readsBeforeEmpty=providerReads;
assert.equal((await post({action:'status'})).body.connected,false);
const disconnected=await post({action:'myEdge'});assert.equal(disconnected.code,200);assert.equal(disconnected.body.connectionState,'DISCONNECTED');
assert.equal(providerReads,readsBeforeEmpty);assert.equal(writes.length,2);
console.log('PASS: safe distinct configuration/marker/read diagnostics, no private error details, verified empty connection returns200 without provider calls or writes');
