import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BEGIN,UPDATE,PREFIX,CONTROL,REGISTRY,ALL,ACTIVE,targetTag} from '../../api/_lib/lineupAccounting.js';
import {markerFor} from '../../api/_lib/lineupAccountingSchema.js';
import {reconcile} from '../reconcile-lineup-accounting.mjs';

export async function runAdversarial({redis,test,reset,gate,documents,account,read,target,response,key}){
 const put=(k,v)=>redis.command('SET',k,JSON.stringify(v));
 const get=async k=>JSON.parse(await redis.command('GET',k));
 const readonly=c=>{assert(['GET','TYPE','PTTL','SMEMBERS','SCAN'].includes(c[0]));return read(c);};
 const noSend=async()=>{
  let constructed=0;
  for(let i=0;i<2;i++)await assert.rejects(()=>account()(target,a=>a(async()=>{constructed++;return response();})));
  assert.equal(constructed,0);
 };
 for(const [name,value] of [['missing',undefined],['malformed','invalid'],['empty',''],['wrong type',3],['null',null],
  ['uppercase','ABCDEF12-3456-4789-ABCD-0123456789AB'],['wrong version','abcdef12-3456-1789-abcd-0123456789ab'],['hyphens','-'.repeat(36)]]){
  await test('admission rejects '+name+' generation before request construction',async()=>{
   const g=await get(CONTROL);g.generation=value;await put(CONTROL,g);await noSend();
   await assert.rejects(()=>reconcile(readonly));
  });
 }
 for(const [name,mutate] of [
  ['mismatched generation',async()=>{const g=await get(CONTROL);g.generation=randomUUID();await put(CONTROL,g);}],
  ['mismatched registry identity',async()=>{const g=await get(CONTROL);g.registryId=randomUUID();await put(CONTROL,g);}],
  ['missing registry generation',async()=>{const r=await get(REGISTRY);delete r.generation;await put(REGISTRY,r);}],
  ['extra admission field',async()=>{const g=await get(CONTROL);g.extra=true;await put(CONTROL,g);}],
  ['missing registry sentinel',async()=>{const r=await get(REGISTRY);await redis.command('SREM',ACTIVE,markerFor(r.id));}],
  ['wrong registry sentinel',async()=>{await redis.command('DEL',ALL);await redis.command('SADD',ALL,markerFor(randomUUID()));}],
 ])await test(name+' fails closed with no resend',async()=>{await mutate();await noSend();await assert.rejects(()=>reconcile(readonly));});
 for(const point of ['BEGIN','PREPARED'])await test('stale captured generation at '+point+' cannot dispatch',async()=>{
  let changed=false,sends=0;
  const ev=async(s,k,a)=>{
   const value=await redis.eval(s,k,a);
   if(!changed&&(point==='BEGIN'?s===BEGIN:s===UPDATE&&JSON.parse(a[1]).attempts.at(-1)?.state==='PREPARED')){
    changed=true;await gate('OPEN');
   }return value;
  };
  await assert.rejects(()=>account(ev)(target,a=>a(async()=>{sends++;return response();})));
  assert(changed);assert.equal(sends,0);await noSend();await gate('CLOSED');
  assert.equal((await reconcile(readonly)).journalClear,false);
 });
 await test('generation or registry corruption immediately before POSSIBLY_SENT blocks dispatch',async()=>{
  let sends=0;
  const ev=async(s,k,a)=>{
   if(s===UPDATE&&JSON.parse(a[1]).attempts.at(-1)?.state==='POSSIBLY_SENT'){
    const r=await get(REGISTRY);r.generation=randomUUID();await put(REGISTRY,r);
   }return redis.eval(s,k,a);
  };
  await assert.rejects(()=>account(ev)(target,a=>a(async()=>{sends++;return response();})));
  assert.equal(sends,0);assert.equal((await documents())[0].status,'ACTIVE');
 });
 for(const safetyKey of [CONTROL,REGISTRY,ALL,ACTIVE]){
  const name=safetyKey.slice(PREFIX.length);
  for(const defect of ['expiry','missing','wrong type'])await test(name+' '+defect+' cannot admit or reconcile',async()=>{
   if(defect==='expiry')await redis.command('EXPIRE',safetyKey,300);
   if(defect==='missing')await redis.command('DEL',safetyKey);
   if(defect==='wrong type'){
    await redis.command('DEL',safetyKey);
    if([ALL,ACTIVE].includes(safetyKey))await redis.command('SET',safetyKey,'unsafe');
    else await redis.command('SADD',safetyKey,'unsafe');
   }
   await noSend();await assert.rejects(()=>reconcile(readonly));
   // The read-only observer neither recreates missing state nor clears a TTL.
   const ttl=await redis.command('PTTL',safetyKey);
   if(defect==='expiry')assert(ttl>0);
   if(defect==='missing')assert.equal(ttl,-2);
  });
 }
 await test('persistent empty journal accepted; absent empty sets are not invented',async()=>{
  await gate('CLOSED');const r=await reconcile(readonly);assert.equal(r.operations,0);assert.equal(r.journalClear,true);
  for(const k of [CONTROL,REGISTRY,ALL,ACTIVE])assert.equal(await redis.command('PTTL',k),-1);
 });
 await test('TTL introduced during stable rereads is rejected without repair',async()=>{
  await gate('CLOSED');let gets=0;
  await assert.rejects(()=>reconcile(async c=>{
   if(c[0]==='GET'&&c[1]===CONTROL&&++gets===2)await redis.command('EXPIRE',REGISTRY,300);
   return readonly(c);
  }));assert(await redis.command('PTTL',REGISTRY)>0);
 });
 const corruptions=[
  ['missing attempts',d=>{delete d.attempts;}],['null attempts',d=>{d.attempts=null;}],
  ['string attempts',d=>{d.attempts='';}],['empty attempts',d=>{d.attempts=[];}],['empty object attempts',d=>{d.attempts={};}],
  ['invalid status',d=>{d.status='DONE';}],['unknown schema',d=>{d.schema=2;}],
  ['orphan attempt',d=>{d.attempts[0].operationId=randomUUID();}],
  ['incorrect revision',d=>{d.revision++;}],['unknown attempt state',d=>{d.attempts[0].state='SAFE';}],
  ['missing HTTP status',d=>{delete d.attempts[0].httpStatus;}],['null HTTP status',d=>{d.attempts[0].httpStatus=null;}],
  ['missing event',d=>{d.attempts[0].events.splice(1,1);}],
  ['acknowledgement without success',d=>{d.attempts[0].httpStatus=500;}],
  ['duplicate attempt IDs',d=>{
   const a=d.attempts[0];a.state='REJECTED';a.httpStatus=409;a.events[2].state='REJECTED';
   d.attempts.push({...structuredClone(a),ordinal:2});d.revision=7;
  }],
  ['retry after acknowledgement',d=>{d.attempts.push({...structuredClone(d.attempts[0]),id:randomUUID(),ordinal:2});d.revision=7;}],
  ['non-409 retry chain',d=>{const a=d.attempts[0];a.state='REJECTED';a.httpStatus=403;a.events[2].state='REJECTED';d.attempts.push({...structuredClone(a),id:randomUUID(),ordinal:2});d.revision=7;}],
  ['wrong registry linkage',d=>{d.registryId=randomUUID();}],
 ];
 for(const [name,change] of corruptions)await test('reconciliation rejects '+name,async()=>{
  await account()(target,a=>a(async()=>response()));await gate('CLOSED');const [d]=await documents();change(d);
  await put(PREFIX+'op:'+d.id,d);await assert.rejects(()=>reconcile(readonly));
 });
 await test('orphan attempt key is rejected by exact namespace inventory',async()=>{
  await account()(target,a=>a(async()=>response()));await gate('CLOSED');
  await put(PREFIX+'attempt:'+randomUUID(),{synthetic:true});await assert.rejects(()=>reconcile(readonly));
 });
 await test('duplicate attempt IDs across operations are rejected',async()=>{
  await account()(target,a=>a(async()=>response()));await account()({...target,teamId:10},a=>a(async()=>response()));
  const [a,b]=await documents();b.attempts[0].id=a.attempts[0].id;await put(PREFIX+'op:'+b.id,b);await gate('CLOSED');
  await assert.rejects(()=>reconcile(readonly));
 });
 await test('empty pristine BEGIN remains active and never journalClear',async()=>{
  await account()(target,async()=>{});await gate('CLOSED');assert.equal((await reconcile(readonly)).journalClear,false);
 });
 await test('operation changing during reread is rejected',async()=>{
  await account()(target,a=>a(async()=>response()));await gate('CLOSED');let changed=false;
  await assert.rejects(()=>reconcile(async c=>{
   const value=await readonly(c);
   if(!changed&&c[0]==='GET'&&c[1].startsWith(PREFIX+'op:')){
    changed=true;const d=JSON.parse(value);d.source='a'.repeat(40);await put(c[1],d);
   }return value;
  }));assert(changed);
 });
 await test('canonical numeric identity equivalence and domain separation',async()=>{
  const tag=targetTag(key,target);
  for(const seasonId of [2026,'2026','02026'])for(const leagueId of [123,'123','000123'])for(const teamId of [9,'9','009'])
   assert.equal(targetTag(key,{...target,seasonId,leagueId,teamId}),tag);
  const tags=[tag];for(const field of ['seasonId','leagueId','teamId'])tags.push(targetTag(key,{...target,[field]:target[field]+1}));
  tags.push(targetTag(key,{...target,game:'ffl'}));assert.equal(new Set(tags).size,tags.length);
  let sends=0;await assert.rejects(()=>account()(target,a=>a(async()=>{sends++;throw Error('synthetic');})));
  await assert.rejects(()=>account()({...target,leagueId:'000123',teamId:'09',seasonId:'02026'},a=>a(async()=>{sends++;return response();})));
  assert.equal(sends,1);
 });
 await test('invalid or ambiguous identity encodings fail before BEGIN',async()=>{
  let commands=0,sends=0;const a=account(async()=>{commands++;throw Error('unexpected');});
  for(const value of [undefined,null,0,-0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'',' 123','+123','1e2','0x7b','123.0','１２３','0','9'.repeat(65),'9007199254740992',{},[],true,123n]){
   await assert.rejects(()=>a({...target,leagueId:value},attempt=>attempt(async()=>{sends++;return response();})));
  }
  assert.equal(commands,0);assert.equal(sends,0);
 });
 await test('real hosted PREPARED and POSSIBLY_SENT persist before dispatch',async()=>{
  let prepared=false,possible=false,sends=0;
  const ev=async(s,k,a)=>{
   const value=await redis.eval(s,k,a);
   if(s===UPDATE){const d=JSON.parse(value),state=d.attempts.at(-1).state;
    if(state==='PREPARED'){assert.equal(sends,0);assert.equal((await get(k[0])).attempts[0].state,'PREPARED');prepared=true;}
    if(state==='POSSIBLY_SENT'){assert.equal(sends,0);assert.equal((await get(k[0])).attempts[0].state,'POSSIBLY_SENT');possible=true;}
   }return value;
  };
  await account(ev)(target,a=>a(async()=>{assert(prepared&&possible);sends++;return response();}));assert.equal(sends,1);
 });
 await test('concurrent target lock works while admission stays OPEN',async()=>{
  let start,release,sends=0;const started=new Promise(r=>start=r),wait=new Promise(r=>release=r);
  const running=account()(target,a=>a(async()=>{sends++;start();await wait;return response();}));await started;
  try{await assert.rejects(()=>account()(target,a=>a(async()=>{sends++;return response();})));assert.equal(sends,1);}
  finally{release();await running;}
 });
}
