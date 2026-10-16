import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {localRedis} from './lib/local-redis.mjs';
import {createAccounting,BEGIN,UPDATE,PREFIX,CONTROL,REGISTRY,ALL,ACTIVE,targetTag} from '../api/_lib/lineupAccounting.js';
import {initializeJournal,rotateAdmission} from './lib/lineup-accounting-fixture.mjs';
import {runAdversarial} from './lib/lineup-accounting-adversarial.mjs';
import {reconcile} from './reconcile-lineup-accounting.mjs';
const redis=await localRedis();const groups=[];
const key='synthetic-audit-key',source='021450cbc72346f365d2c198068d82156e07476f';
const target={game:'flb',seasonId:2026,leagueId:123,teamId:9};
const response=(status=200,body='')=>({ok:status>=200&&status<300,status,body});
const evalRedis=(s,k,a)=>redis.eval(s,k,a);
const account=(ev=evalRedis)=>createAccounting({evalRedis:ev,key,source});
const gate=phase=>rotateAdmission(redis,phase);
async function reset(){
 let cursor='0',keys=[];do{const r=await redis.command('SCAN',cursor,'MATCH',PREFIX+'*','COUNT',100);cursor=String(r[0]);keys.push(...r[1]);}while(cursor!=='0');
 if(keys.length)await redis.command('DEL',...new Set(keys));await initializeJournal(redis);
}
async function documents(){return Promise.all((await redis.command('SMEMBERS',ALL)).filter(id=>!id.startsWith('registry:')).map(async id=>JSON.parse(await redis.command('GET',PREFIX+'op:'+id))));}
const read=c=>redis.command(...c);
async function test(name,work){try{await reset();await work();groups.push(name);}catch(e){e.accountingCase=name;throw e;}}
try{
 await test('acknowledgement ordering, privacy and complete reconciliation',async()=>{
  let sends=0;
  const r=await account()(target,attempt=>attempt(async()=>{sends++;const [d]=await documents();assert.equal(d.attempts[0].state,'POSSIBLY_SENT');return response();}));
  assert.equal(r.status,200);assert.equal(sends,1);const [d]=await documents();assert.equal(d.status,'COMPLETE');assert.deepEqual(d.attempts[0].events.map(e=>e.state),['PREPARED','POSSIBLY_SENT','ACKNOWLEDGED']);
  const text=JSON.stringify(d);for(const forbidden of ['leagueId','teamId','cookie','token','playerId','swid'])assert(!text.includes(forbidden));
  await gate('CLOSED');const counts=await reconcile(read);assert.equal(counts.ACKNOWLEDGED,1);assert.equal(counts.journalClear,true);
 });
 await test('explicit rejection is distinct',async()=>{
  await account()(target,attempt=>attempt(async()=>response(403)));const [d]=await documents();assert.equal(d.attempts[0].state,'REJECTED');assert.equal(d.status,'COMPLETE');
 });
 for(const name of ['timeout','connection-loss','response-body-loss'])await test(name+' remains unknown with no resend',async()=>{
  let sent=0;await assert.rejects(()=>account()(target,attempt=>attempt(async()=>{sent++;throw new Error(name);})),/OUTCOME_UNKNOWN/);assert.equal(sent,1);
  const [d]=await documents();assert.equal(d.attempts[0].state,'UNKNOWN');assert.equal(d.status,'BLOCKED');
  await assert.rejects(()=>account()(target,attempt=>attempt(async()=>{sent++;return response();})));assert.equal(sent,1);
  await gate('CLOSED');const counts=await reconcile(read);assert.equal(counts.UNKNOWN,1);assert.equal(counts.journalClear,false);
 });
 await test('provider 500 is unknown, not a safe rejection',async()=>{
  await account()(target,attempt=>attempt(async()=>response(500)));assert.equal((await documents())[0].attempts[0].state,'UNKNOWN');
 });
 await test('failed and lost POSSIBLY_SENT journal acknowledgements never dispatch',async()=>{
  for(const commit of [false,true]){
   await reset();let sends=0;
   const ev=async(s,k,a)=>{if(s===UPDATE&&JSON.parse(a[1]).attempts?.at?.(-1)?.state==='POSSIBLY_SENT'){if(commit)await evalRedis(s,k,a);throw Error('synthetic');}return evalRedis(s,k,a);};
   await assert.rejects(()=>account(ev)(target,attempt=>attempt(async()=>{sends++;return response();})));assert.equal(sends,0);
   const [d]=await documents();assert.equal(d.status,'ACTIVE');assert.equal(d.attempts[0].state,commit?'POSSIBLY_SENT':'PREPARED');
  }
 });
 await test('lost acknowledgement of success cannot cause duplicate request',async()=>{
  let sends=0;
  const ev=async(s,k,a)=>{if(s===UPDATE&&JSON.parse(a[1]).attempts?.at?.(-1)?.state==='ACKNOWLEDGED')throw Error('synthetic');return evalRedis(s,k,a);};
  const r=await account(ev)(target,attempt=>attempt(async()=>{sends++;return response();}));assert.equal(r.ok,true);
  await assert.rejects(()=>account()(target,a=>a(async()=>{sends++;return response();})));assert.equal(sends,1);
  assert.equal((await documents())[0].attempts[0].state,'POSSIBLY_SENT');
 });
 await test('unacknowledged 409 journal outcome prevents retry',async()=>{
  let sends=0;
  const ev=async(s,k,a)=>{if(s===UPDATE&&JSON.parse(a[1]).attempts?.at?.(-1)?.state==='REJECTED')throw Error('synthetic');return evalRedis(s,k,a);};
  await assert.rejects(()=>account(ev)(target,async attempt=>{const r=await attempt(async()=>{sends++;return response(409);});if(r.status===409)return attempt(async()=>{sends++;return response();});}));assert.equal(sends,1);
  assert.equal((await documents())[0].attempts[0].state,'POSSIBLY_SENT');
 });
 await test('lost final acknowledgement preserves success and blocks reconciliation',async()=>{
  const ev=async(s,k,a)=>{if(s===UPDATE&&JSON.parse(a[1]).status==='COMPLETE')throw Error('synthetic');return evalRedis(s,k,a);};
  assert.equal((await account(ev)(target,a=>a(async()=>response()))).ok,true);
  await gate('CLOSED');assert.equal((await reconcile(read)).journalClear,false);
 });
 await test('closed admission and concurrent target lock',async()=>{
  await gate('CLOSED');let sends=0;await assert.rejects(()=>account()(target,a=>a(async()=>{sends++;return response();})));assert.equal(sends,0);
  await gate('OPEN');let unblock,started;const ready=new Promise(r=>started=r),wait=new Promise(r=>unblock=r);
  const running=account()(target,a=>a(async()=>{sends++;started();await wait;return response();}));await ready;
  await gate('CLOSED');await assert.rejects(()=>account()(target,a=>a(async()=>{sends++;return response();})));unblock();await running;assert.equal(sends,1);
  assert.equal((await reconcile(read)).journalClear,true);
 });
 await test('reconciliation rejects missing/expired/corrupt evidence',async()=>{
  await account()(target,a=>a(async()=>response()));await gate('CLOSED');const [d]=await documents();const k=PREFIX+'op:'+d.id;
  await redis.command('EXPIRE',k,100);await assert.rejects(()=>reconcile(read));await redis.command('PERSIST',k);
  await redis.command('DEL',k);await assert.rejects(()=>reconcile(read));
 });
 await test('reconciliation detects admission generation drift',async()=>{
  await gate('CLOSED');let gateReads=0;
  await assert.rejects(()=>reconcile(async c=>{if(c[0]==='GET'&&c[1]===CONTROL&&++gateReads===2)await gate('CLOSED');return read(c);}));
 });
 await runAdversarial({redis,test,reset,gate,documents,account,read,target,response,key,source});
 // Exercise the actual setLineup implementation and compare all wire payloads and
 // return values to the frozen Production source. Every fetch is intercepted.
 let baseline=execFileSync('git',['show',source+':api/_lib/espnFantasy.js'],{encoding:'utf8'});
 baseline=baseline.replace(/from '(\.\/[^']+)'/g,(_m,p)=>`from '${pathToFileURL(resolve('api/_lib',p)).href}'`);
 const old=await import('data:text/javascript;base64,'+Buffer.from(baseline).toString('base64'));
 const current=await import('../api/_lib/espnFantasy.js');
 const originalFetch=globalThis.fetch,oldWarn=console.warn;
 process.env.KV_REST_API_URL='https://synthetic-journal.invalid';process.env.KV_REST_API_TOKEN='synthetic-only';process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY=key;process.env.VERCEL_GIT_COMMIT_SHA=source;
 const creds={espn_s2:'synthetic-cookie',swid:'{synthetic-member}'};
 const ids={leagueId:'123456789',seasonId:2026,teamId:1,scoringPeriodId:2};
 const moves=[{playerId:1,fromLineupSlotId:16,toLineupSlotId:0},{playerId:2,fromLineupSlotId:16,toLineupSlotId:1}];
 const roster=[{id:1,name:'Alpha Player'},{id:2,name:'Beta Player'}];
 async function exercise(fn,responses,sport='mlb'){
  const wire=[];let i=0;console.warn=()=>{};
  globalThis.fetch=async(url,options)=>{
   if(String(url)==='https://synthetic-journal.invalid'){
    const c=JSON.parse(options.body);assert.equal(c[0],'EVAL');assert([BEGIN,UPDATE].includes(c[1]));
    const result=await redis.command(...c);return {ok:true,json:async()=>({result})};
   }
   assert(String(url).startsWith('https://lm-api-writes.fantasy.espn.com/'));
   wire.push({url,method:options.method,headers:options.headers,body:options.body});
   const next=responses[i++];assert(next);if(next.error)throw Error('synthetic lost response');
   return {ok:next.status===200,status:next.status,text:async()=>{if(next.bodyError)throw Error('synthetic body loss');return next.body||'';}};
  };
  let result,error;try{result=await fn(creds,ids,moves,{roster,sport});}catch(e){error=e.message;}return {wire,result,error};
 }
 try{
  for(const sport of ['mlb','nfl','wnba'])for(const [name,responses] of [['success',[{status:200}]],['409 chain',[{status:409,body:'Alpha Player is locked'},{status:200}]],['all moves rejected',[{status:409,body:'Alpha Player is locked and Beta Player is locked'}]]]){
   await test('wire and selection parity: '+sport+' '+name,async()=>{const before=await exercise(old.setLineup,responses,sport);const after=await exercise(current.setLineup,responses,sport);assert.deepEqual(after,before);const [d]=await documents();assert.equal(d.attempts.length,responses.length);assert.equal(new Set(d.attempts.map(a=>a.id)).size,responses.length);});
  }
  await test('actual fifteen-second abort becomes UNKNOWN without resend',async()=>{
   let sends=0;
   globalThis.fetch=async(url,options)=>{
    if(String(url)==='https://synthetic-journal.invalid'){
     const c=JSON.parse(options.body);assert.equal(c[0],'EVAL');assert([BEGIN,UPDATE].includes(c[1]));
     return {ok:true,json:async()=>({result:await redis.command(...c)})};
    }
    assert(String(url).startsWith('https://lm-api-writes.fantasy.espn.com/'));sends++;
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('synthetic abort')),{once:true}));
   };
   await assert.rejects(()=>current.setLineup(creds,ids,moves,{roster}),/OUTCOME_UNKNOWN/);
   assert.equal(sends,1);assert.equal((await documents())[0].attempts[0].state,'UNKNOWN');
  });
  await test('real write path connection and body loss do not retry',async()=>{
   for(const r of [{error:true},{status:200,bodyError:true}]){await reset();const after=await exercise(current.setLineup,[r]);assert.equal(after.wire.length,1);assert.equal(after.error,'ESPN_LINEUP_OUTCOME_UNKNOWN');assert.equal((await documents())[0].attempts[0].state,'UNKNOWN');}
  });
 }finally{globalThis.fetch=originalFetch;console.warn=oldWarn;}
 console.log(JSON.stringify({passed:true,groups:groups.length,cases:groups,externalCalls:0}));
}finally{await redis.close();}
