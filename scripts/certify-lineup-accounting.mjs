// Hosted synthetic certification only. Invoked by the private fixed-purpose launcher.
// No production/preview env loading; all ESPN traffic is intercepted by the test suite.
import assert from 'node:assert/strict';
import {mock} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {BEGIN,UPDATE,PREFIX,CONTROL,REGISTRY,ALL,ACTIVE} from '../api/_lib/lineupAccounting.js';
import {INIT,ROTATE} from './lib/lineup-accounting-fixture.mjs';

const output=resolve('.cache/lineup-accounting-certification');await mkdir(output,{recursive:true,mode:0o700});
const nativeFetch=globalThis.fetch;
const evidence={passed:false,database:'fantasyedge-epoch-cert',identityBasis:'owner-designated cert endpoint matched to prior certified fingerprint',commands:{},groups:0,cleanup:'NOT_STARTED',stage:'provenance',realEspnCalls:0};
for(const name of ['log','info','warn','error','debug'])console[name]=()=>{};
let owns=false,reservationAttempted=false,endpoint,token;
const run=randomUUID(),owner='accounting_cert:owner',owned=new Set();
const reserve="if redis.call('DBSIZE') ~= 0 then return redis.error_reply('CERT_NOT_EMPTY') end return redis.call('SET',KEYS[1],ARGV[1],'NX')";
const clean="if redis.call('GET',KEYS[1]) ~= ARGV[1] then return redis.error_reply('CERT_OWNER') end return redis.call('DEL',unpack(KEYS,2))";
const release="if redis.call('GET',KEYS[1]) ~= ARGV[1] then return redis.error_reply('CERT_OWNER') end return redis.call('DEL',KEYS[1])";
async function raw(c){
 evidence.commands[c[0]]=(evidence.commands[c[0]]||0)+1;
 const r=await nativeFetch(endpoint,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(c),signal:AbortSignal.timeout(15000)});
 assert(r.ok);const d=await r.json();
 if(d.error){
  evidence.lastRedisErrorTags=['AUDIT_DURABILITY','AUDIT_TYPE','AUDIT_ADMISSION','AUDIT_REGISTRY','AUDIT_LINK','AUDIT_CAS','AUDIT_LOCK','AUDIT_STALE','AUDIT_CLOSED','AUDIT_BUSY','FIXTURE_CAS','FIXTURE_EXISTS','readonly','global','syntax','nil','number','boolean','KEYS','ARGV','attempt','not supported','unpack'].filter(tag=>String(d.error).includes(tag));
  throw Error('CERT_REDIS_ERROR');
 }
 if(c[0]==='EVAL'&&[BEGIN,UPDATE].includes(c[1])&&typeof d.result==='string'){
  const v=JSON.parse(d.result);
  evidence.lastRecordShape={script:c[1]===BEGIN?'BEGIN':'UPDATE',schema:v.schema,status:v.status,revision:v.revision,
   createdAtInteger:Number.isSafeInteger(v.createdAt),updatedAtInteger:Number.isSafeInteger(v.updatedAt),
   attemptsArray:Array.isArray(v.attempts),attemptCount:Array.isArray(v.attempts)?v.attempts.length:null,
   attemptShapes:Array.isArray(v.attempts)?v.attempts.map(a=>({ordinal:a.ordinal,state:a.state,httpStatus:a.httpStatus,
    hasHttpStatus:Object.hasOwn(a,'httpStatus'),linked:a.operationId===v.id,eventsArray:Array.isArray(a.events),
    events:Array.isArray(a.events)?a.events.map(e=>({state:e.state,integer:Number.isSafeInteger(e.at)})):null})):[]};
 }
 return d.result;
}
async function ownerCheck(){assert.equal(await raw(['GET',owner]),run);}
async function journal(){await writeFile(resolve(output,'owned-keys.json'),JSON.stringify({run,keys:[...owned]},null,2),{mode:0o600});}
function validKey(k){return [CONTROL,REGISTRY,ALL,ACTIVE].includes(k)||new RegExp('^'+PREFIX+'(?:(?:op|attempt):[a-f0-9-]{36}|target:[a-f0-9]{64})$').test(k);}
async function command(...c){
 assert(owns);assert(['GET','SET','DEL','SCAN','SMEMBERS','PTTL','TYPE','EXPIRE','PERSIST','SADD','SREM','EVAL'].includes(c[0]));
 if(c[0]==='SCAN'){assert.deepEqual(c.slice(2),['MATCH',PREFIX+'*','COUNT',100]);return raw(c);}
 const keys=c[0]==='EVAL'?c.slice(3,3+Number(c[2])):c[0]==='DEL'?c.slice(1):[c[1]];
 assert(keys.every(validKey));
 if(c[0]==='EVAL')assert([BEGIN,UPDATE,INIT,ROTATE].includes(c[1]));
 if(['GET','SMEMBERS','PTTL','TYPE'].includes(c[0]))return raw(c);
 await ownerCheck();
 if(['DEL','EXPIRE','PERSIST','SREM'].includes(c[0]))assert(keys.every(k=>owned.has(k)));
 keys.forEach(k=>owned.add(k));await journal();return raw(c);
}
async function cleanup(){
 // Lost reservation acknowledgement is resolved read-only before any cleanup.
 if(!owns&&reservationAttempted)owns=await raw(['GET',owner])===run;
 if(!owns){evidence.cleanup='NO_OWNED_KEYS';return;}
 await ownerCheck();const keys=[...owned];
 for(let i=0;i<keys.length;i+=40)await raw(['EVAL',clean,1+keys.slice(i,i+40).length,owner,...keys.slice(i,i+40),run]);
 assert.equal(await raw(['DBSIZE']),1);await raw(['EVAL',release,1,owner,run]);owns=false;
 assert.equal(await raw(['DBSIZE']),0);evidence.cleanup='PASS';
}
const hash=b=>createHash('sha256').update(b).digest('hex');
async function hashes(){
 const paths=JSON.parse(await readFile(new URL('./lineup-accounting-source-files.json',import.meta.url),'utf8'));
 const result={};for(const path of paths)result[path]=hash(await readFile(resolve(path)));return result;
}
try{
 assert(process.argv.length===2);
 evidence.baseSha='021450cbc72346f365d2c198068d82156e07476f';
 evidence.preCommitHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 evidence.files=await hashes();evidence.manifestSha256=hash(JSON.stringify(evidence.files));
 const u=new URL(process.env.CERT_URL);assert(u.protocol==='https:'&&u.hostname.endsWith('.upstash.io')&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/');
 endpoint=u.origin;token=process.env.CERT_TOKEN;assert(token);
 assert.equal(hash(endpoint),process.env.CERT_EXPECTED_DIGEST);evidence.endpointIdentitySha256=process.env.CERT_EXPECTED_DIGEST;
 for(const n of Object.keys(process.env))if(n!=='PATH')delete process.env[n];
 // Defense in depth: the only real fetch reference is private to raw(), pinned above.
 globalThis.fetch=async()=>{throw Error('CERT_UNEXPECTED_NETWORK');};
 await journal();evidence.stage='reservation';reservationAttempted=true;
 assert.equal(await raw(['EVAL',reserve,1,owner,run]),'OK');owns=true;
 evidence.stage='accounting_suite';
 mock.module(pathToFileURL(resolve('scripts/lib/local-redis.mjs')).href,{namedExports:{localRedis:async()=>({command,eval:(s,k,a)=>command('EVAL',s,k.length,...k,...a),close:async()=>{}})}});
 console.log=line=>{const r=JSON.parse(line);assert(r.passed);evidence.groups=r.groups;evidence.cases=r.cases;};
 await import('./check-lineup-accounting.mjs');console.log=()=>{};
 assert.deepEqual(await hashes(),evidence.files);
 delete evidence.lastRecordShape;delete evidence.lastRedisErrorTags;
 evidence.passed=true;evidence.stage='complete';
}catch(e){
 evidence.failedAt=evidence.stage;evidence.stage='FAILED';
 if(typeof e.accountingCase==='string'&&/^[a-zA-Z0-9 :(),/-]{1,160}$/.test(e.accountingCase))evidence.failedCase=e.accountingCase;
}finally{
 try{await cleanup();}catch{evidence.cleanup='FAIL_REQUIRES_OWNED_KEY_REVIEW';evidence.passed=false;}
 await writeFile(resolve(output,'hosted-evidence.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
 process.exitCode=evidence.passed?0:1;
}
