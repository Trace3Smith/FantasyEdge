// Operational journal, separate from fe:e1:. No cookies, payloads or raw target IDs.
import {createHmac, randomUUID} from 'node:crypto';
import {validUuid, validateOperation, attemptsOf, rejectionStatuses} from './lineupAccountingSchema.js';
export const PREFIX='fe:lineup-audit:v1:';
export const CONTROL=PREFIX+'admission', ALL=PREFIX+'operations', ACTIVE=PREFIX+'active';
export const REGISTRY=PREFIX+'registry';
// Every safety root is mandatory and persistent, including empty set sentinels.
// The same atomic predicate protects BEGIN and each transition toward dispatch.
const safetyLua=`
local function uuid(s)
 if type(s) ~= 'string' or #s ~= 36 or s ~= string.lower(s) then return false end
 if not string.match(s,'^%x%x%x%x%x%x%x%x%-%x%x%x%x%-4%x%x%x%-[89ab]%x%x%x%-%x%x%x%x%x%x%x%x%x%x%x%x$') then return false end
 return true
end
local function shape(t,n)
 if type(t) ~= 'table' then return false end
 local count=0;for _ in pairs(t) do count=count+1 end;return count == n
end
local function safety(c,r,all,active)
 for _,k in ipairs({c,r,all,active}) do
  if redis.call('PTTL',k) ~= -1 then error('AUDIT_DURABILITY') end
 end
 if redis.call('TYPE',c).ok ~= 'string' or redis.call('TYPE',r).ok ~= 'string' or redis.call('TYPE',all).ok ~= 'set' or redis.call('TYPE',active).ok ~= 'set' then error('AUDIT_TYPE') end
 local g=cjson.decode(redis.call('GET',c));local registry=cjson.decode(redis.call('GET',r))
 if not shape(g,4) or g.schema ~= 1 or not uuid(g.registryId) or not uuid(g.generation) or (g.phase ~= 'OPEN' and g.phase ~= 'CLOSED') then error('AUDIT_ADMISSION') end
 if not shape(registry,3) or registry.schema ~= 1 or not uuid(registry.id) or not uuid(registry.generation) or registry.id ~= g.registryId or registry.generation ~= g.generation then error('AUDIT_REGISTRY') end
 local marker='registry:'..registry.id
 if redis.call('SISMEMBER',all,marker) ~= 1 or redis.call('SISMEMBER',active,marker) ~= 1 then error('AUDIT_LINK') end
 return g
end
`;
export const BEGIN=safetyLua+`
local g=safety(KEYS[1],KEYS[2],KEYS[3],KEYS[4])
if g.phase ~= 'OPEN' then return redis.error_reply('AUDIT_CLOSED') end
if redis.call('EXISTS',KEYS[5]) ~= 0 or redis.call('EXISTS',KEYS[6]) ~= 0 then return redis.error_reply('AUDIT_BUSY') end
local d=cjson.decode(ARGV[1]);d.registryId=g.registryId;d.generation=g.generation
local t=redis.call('TIME');d.createdAt=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000);d.updatedAt=d.createdAt
local out=cjson.encode(d)
redis.call('SET',KEYS[5],out);redis.call('SET',KEYS[6],d.id)
redis.call('SADD',KEYS[3],d.id);redis.call('SADD',KEYS[4],d.id)
return out`;
export const UPDATE=safetyLua+`
local g=safety(KEYS[4],KEYS[5],KEYS[6],KEYS[3])
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return redis.error_reply('AUDIT_CAS') end
local d=cjson.decode(ARGV[2]);local previous=cjson.decode(ARGV[1])
if d.registryId ~= g.registryId or d.registryId ~= previous.registryId or d.generation ~= previous.generation or d.id ~= previous.id then return redis.error_reply('AUDIT_LINK') end
if redis.call('PTTL',KEYS[1]) ~= -1 or redis.call('PTTL',KEYS[2]) ~= -1 or redis.call('GET',KEYS[2]) ~= d.id then return redis.error_reply('AUDIT_LOCK') end
if redis.call('SISMEMBER',KEYS[6],d.id) ~= 1 or redis.call('SISMEMBER',KEYS[3],d.id) ~= 1 then return redis.error_reply('AUDIT_LINK') end
local a=d.attempts[#d.attempts]
if a and (a.state == 'PREPARED' or a.state == 'POSSIBLY_SENT') then
 if g.phase ~= 'OPEN' or d.generation ~= g.generation then return redis.error_reply('AUDIT_STALE') end
end
local t=redis.call('TIME');d.updatedAt=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local out=cjson.encode(d);redis.call('SET',KEYS[1],out)
if d.status == 'COMPLETE' then redis.call('DEL',KEYS[2]);redis.call('SREM',KEYS[3],d.id) end
return out`;
const fail=()=>new Error('LINEUP_ACCOUNTING_UNAVAILABLE');
export function canonicalTarget(target){
 const decimal=value=>{
  if(typeof value === 'number'){
   if(!Number.isSafeInteger(value)||value<=0)throw fail();
   return String(value);
  }
  if(typeof value!=='string'||!/^\d{1,64}$/.test(value))throw fail();
  const n=BigInt(value);if(n<=0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw fail();
  return String(n);
 };
 if(!target||!['flb','ffl','fba','wfba','fhl'].includes(target.game))throw fail();
 return [target.game,decimal(target.seasonId),decimal(target.leagueId),decimal(target.teamId)];
}
export function targetTag(key, target){
 if(!key)throw fail();
 const subkey=createHmac('sha256',key).update('FantasyEdge lineup audit target v1').digest();
 return createHmac('sha256',subkey).update(JSON.stringify(canonicalTarget(target))).digest('hex');
}
export function createAccounting({evalRedis,key,source,uuid=randomUUID,now=Date.now}){
 return async function account(target,work){
  if(!/^[a-f0-9]{40}$/.test(source||''))throw fail();
  const id=uuid(),tag=targetTag(key,target),op=PREFIX+'op:'+id,lock=PREFIX+'target:'+tag;
  if(!validUuid(id))throw fail();
  let raw,doc,healthy=true;
  async function decode(promise){
   try{const r=await promise;if(typeof r!=='string')throw fail();const d=JSON.parse(r);validateOperation(d);if(d.id!==id)throw fail();raw=r;doc=d;}
   catch{healthy=false;throw fail();}
  }
  await decode(evalRedis(BEGIN,[CONTROL,REGISTRY,ALL,ACTIVE,op,lock],[JSON.stringify({schema:1,id,targetTag:tag,source,status:'ACTIVE',revision:0,attempts:[],createdAt:0,updatedAt:0})]));
  async function update(next){
   if(!healthy)throw fail();
   const candidate={...next,revision:doc.revision+1};validateOperation(candidate);
   await decode(evalRedis(UPDATE,[op,lock,ACTIVE,CONTROL,REGISTRY,ALL],[raw,JSON.stringify(candidate)]));
  }
  async function transition(index,state,httpStatus=0){
   const attempts=attemptsOf(doc).slice();
   const a={...attempts[index],state,httpStatus,events:[...attempts[index].events,{state,at:now()}]};attempts[index]=a;
   await update({...doc,attempts});
  }
  async function attempt(send){
   if(!healthy||(Array.isArray(doc.attempts)&&doc.attempts.some(a=>['POSSIBLY_SENT','UNKNOWN'].includes(a.state))))throw fail();
   const attempts=attemptsOf(doc).slice();
   if(attempts.length>=6)throw fail();
   if(attempts.length && !(attempts.at(-1).state==='REJECTED' && attempts.at(-1).httpStatus===409))throw fail();
   const index=attempts.length,attemptId=uuid();if(!validUuid(attemptId))throw fail();
   attempts.push({id:attemptId,operationId:id,ordinal:index+1,state:'PREPARED',httpStatus:0,events:[{state:'PREPARED',at:now()}]});
   await update({...doc,attempts});
   // Await durable acknowledgement immediately before the only call to send.
   await transition(index,'POSSIBLY_SENT');
   let response;
   try{response=await send();}
   catch{
    try{await transition(index,'UNKNOWN');}catch{} // POSSIBLY_SENT is still blocking if persistence fails.
    throw new Error('ESPN_LINEUP_OUTCOME_UNKNOWN');
   }
   const state=response.ok?'ACKNOWLEDGED':rejectionStatuses.includes(response.status)?'REJECTED':'UNKNOWN';
   try{await transition(index,state,response.status);}
   catch{
    // Preserve explicit success for the caller; never turn a known success into a retry prompt.
    // Journal stays active/possibly-sent, target remains fenced and reconciliation blocks.
    if(response.ok)return response;
    throw fail(); // In particular, do not start a 409 retry if its journal acknowledgement failed.
   }
   return response;
  }
  try{return await work(attempt);}
  finally{
   if(healthy && attemptsOf(doc).length){
    const pending=(Array.isArray(doc.attempts)?doc.attempts:[]).some(a=>['POSSIBLY_SENT','UNKNOWN'].includes(a.state));
    try{await update({...doc,status:pending?'BLOCKED':'COMPLETE'});}catch{}
    // A failed final write leaves ACTIVE/target lock; no TTL or timer-based recovery.
   }
  }
 };
}

// No SDK retries: a lost Redis acknowledgement never triggers another ESPN send.
async function evalRedis(script,keys,args){
 const url=new URL(process.env.KV_REST_API_URL||process.env.UPSTASH_REDIS_REST_URL);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw fail();
 const token=process.env.KV_REST_API_TOKEN||process.env.UPSTASH_REDIS_REST_TOKEN;if(!token)throw fail();
 const r=await fetch(url.origin,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(['EVAL',script,keys.length,...keys,...args]),signal:AbortSignal.timeout(5000)});
 if(!r.ok)throw fail();const d=await r.json();if(d.error)throw fail();return d.result;
}
export function accountLineup(target,work){
 return createAccounting({evalRedis,key:process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY,source:process.env.VERCEL_GIT_COMMIT_SHA})(target,work);
}
