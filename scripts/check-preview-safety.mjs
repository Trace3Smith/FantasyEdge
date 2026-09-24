import { configurePreview } from './preview-test-config.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blockPreview } from '../api/_lib/previewSafety.js';
import { WRITE_SPORTS, AUTOPILOT_SPORTS } from '../leagueCapabilities.js';
const res=()=>({code:0,headers:{},setHeader(k,v){this.headers[k]=v;},status(c){this.code=c;return this;},json(b){this.body=b;return this;}});
configurePreview();
for(const action of ['status','myEdge','leagueContext','leagues','connect','disconnect']) assert.equal(blockPreview({method:'POST',body:{action}},res(),'espn'),false);
for(const action of ['apply','autopilot','dnaChoice','addLeague','removeLeague','watchProspect','tradeScan','tradeAdvise','nflForm',undefined]) {
 const response=res();assert.equal(blockPreview({method:'POST',body:{action,on:false,dryRun:true}},response,'espn'),true);assert.equal(response.code,403);
}
delete process.env.FE_PREVIEW_ESPN_CREDENTIAL_TOKEN;
for (const action of ['status','myEdge','connect','disconnect']) {
 const missingWriter=res();
 assert.equal(blockPreview({method:'POST',body:{action}},missingWriter,'espn'),true);
 assert.equal(missingWriter.code,503);
 assert.equal(missingWriter.body.reason,'preview_credential_token_missing');
 assert.ok(!JSON.stringify(missingWriter.body).includes('test-credential'));
}
configurePreview();
delete process.env.FE_PREVIEW_REDIS_READ_ONLY_TOKEN;
const missing=res();assert.equal(blockPreview({method:'POST',body:{action:'myEdge'}},missing,'espn'),true);assert.equal(missing.code,503);
let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Network forbidden in preview safety check');};
const files=['espn/index','cron/autopilot','cron/refresh','stripe/checkout','stripe/portal','stripe/webhook','coach/chat','draft/advise','draft/mock-start','sports','synopsis/index'];
for(const name of files) {
 const handler=(await import('../api/'+name+'.js')).default;
 const response=res();await handler({method:'POST',body:{action:'apply'},headers:{}},response);
 assert.equal(response.code,403,name+' blocked before authentication, provider or storage work');
}
assert.equal(calls,0);
const source=await readFile(new URL('../api/_lib/kv.js',import.meta.url),'utf8');
assert.ok(source.includes('? isolatedPreview?.readToken'),'preview uses isolated read-only configuration');
const handlerSource=await readFile(new URL('../api/espn/index.js',import.meta.url),'utf8');
for(const mutation of ['if (!isPreview() && await dnaCaptureAllowed','if (!isPreview()) redis.set(scoringKey(sport, lg.season','if (!isPreview()) setWatch(redis, userId, nextWatch)'])assert.ok(handlerSource.includes(mutation));
for(const sport of ['nba','nhl']){assert.equal(WRITE_SPORTS.has(sport),false);assert.equal(AUTOPILOT_SPORTS.has(sport),false);}
process.env.VERCEL_ENV='production';assert.equal(blockPreview({method:'POST',body:{action:'apply'}},res(),'espn'),false);
delete process.env.VERCEL_ENV;assert.equal(blockPreview({},res(),'disabled'),false);
console.log('PASS: all preview mutation handlers blocked before network/auth, read allowlist, missing read token fails closed, persistence guards, production unchanged, NBA/NHL write gates closed');
