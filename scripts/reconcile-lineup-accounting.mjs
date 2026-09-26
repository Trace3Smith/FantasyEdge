// Private command: native reads only; no implicit repair or mutation mode.
import {PREFIX,CONTROL,REGISTRY,ALL,ACTIVE} from '../api/_lib/lineupAccounting.js';
import {validUuid,validateSafety,validateOperation,markerFor,requireAudit as require} from '../api/_lib/lineupAccountingSchema.js';
import {createHash} from 'node:crypto';
export async function reconcile(read){
 const snapshots=[],persistent=[];
 async function durable(key,type){
  require(await read(['TYPE',key])===type && await read(['PTTL',key])===-1);
  persistent.push([key,type]);
 }
 async function record(key){
  await durable(key,'string');const raw=await read(['GET',key]);require(typeof raw==='string');
  snapshots.push([key,raw]);return JSON.parse(raw);
 }
 const gate=await record(CONTROL),registry=await record(REGISTRY);validateSafety(gate,registry);
 const marker=markerFor(registry.id);
 async function members(key){
  await durable(key,'set');const values=await read(['SMEMBERS',key]);
  require(Array.isArray(values)&&values.length<=10001&&values.includes(marker)&&new Set(values).size===values.length);
  const ids=values.filter(x=>x!==marker);require(ids.every(validUuid));return ids;
 }
 const ids=await members(ALL),active=await members(ACTIVE);require(active.every(id=>ids.includes(id)));
 const counts={operations:ids.length,activeOrBlocked:active.length,PREPARED:0,POSSIBLY_SENT:0,ACKNOWLEDGED:0,REJECTED:0,UNKNOWN:0};
 const expected=new Set([CONTROL,REGISTRY,ALL,ACTIVE]),attemptIds=new Set();
 for(const id of ids){
  const key=PREFIX+'op:'+id,d=await record(key),attempts=validateOperation(d);
  require(d.id===id&&d.registryId===registry.id);expected.add(key);
  for(const a of attempts){require(!attemptIds.has(a.id));attemptIds.add(a.id);counts[a.state]++;}
  require((d.status!=='COMPLETE')===active.includes(id));
  if(d.status!=='COMPLETE'){
   const lock=PREFIX+'target:'+d.targetTag;expected.add(lock);await durable(lock,'string');
   const raw=await read(['GET',lock]);require(raw===id);snapshots.push([lock,raw]);
  }
 }
 let cursor='0';const found=new Set(),seen=new Set();
 do{
  require(!seen.has(cursor));seen.add(cursor);
  const r=await read(['SCAN',cursor,'MATCH',PREFIX+'*','COUNT',100]);require(Array.isArray(r)&&Array.isArray(r[1]));
  cursor=String(r[0]);require(/^\d+$/.test(cursor));r[1].forEach(k=>found.add(k));require(found.size<=30004);
 }while(cursor!=='0');
 require(found.size===expected.size&&[...found].every(k=>expected.has(k)));
 // Reread values, types and persistence, not just operation JSON. No repair occurs.
 for(const [key,raw] of snapshots)require(await read(['GET',key])===raw);
 for(const [key,type] of persistent)require(await read(['TYPE',key])===type&&await read(['PTTL',key])===-1);
 for(const [key,original] of [[ALL,ids],[ACTIVE,active]]){
  const values=await read(['SMEMBERS',key]);require(Array.isArray(values));
  require(JSON.stringify(values.slice().sort())===JSON.stringify([marker,...original].sort()));
 }
 // Last control/registry reread detects rotation during the other rereads.
 for(const [key,raw] of snapshots.slice(0,2))require(await read(['GET',key])===raw);
 return {admission:gate.phase,...counts,journalClear:gate.phase==='CLOSED'&&active.length===0&&counts.PREPARED===0&&counts.POSSIBLY_SENT===0&&counts.UNKNOWN===0};
}
async function main(){
 try{
  require(process.argv.length===2);
  const url=new URL(process.env.KV_REST_API_URL),token=process.env.KV_REST_API_TOKEN;
  require(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/'&&token);
  require(createHash('sha256').update(url.origin).digest('hex')===process.env.FE_EPOCH_ENDPOINT_SHA256);
  let calls=0;
  const result=await reconcile(async c=>{
   require(++calls<=100000&&['GET','SMEMBERS','PTTL','SCAN','TYPE'].includes(c[0]));
   const r=await fetch(url.origin,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(c),signal:AbortSignal.timeout(5000)});
   require(r.ok);const d=await r.json();require(!d.error&&Object.hasOwn(d,'result'));return d.result;
  });
  console.log(JSON.stringify({passed:true,...result,maintenanceAuthorized:false}));
 }catch{console.error('FAIL_LINEUP_RECONCILIATION');process.exitCode=1;}
}
if(process.argv[1]===new URL(import.meta.url).pathname)await main();
