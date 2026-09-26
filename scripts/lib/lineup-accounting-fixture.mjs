// Synthetic test fixtures only. Never imported by the application or reconciliation CLI.
import {randomUUID} from 'node:crypto';
import {CONTROL,REGISTRY,ALL,ACTIVE} from '../../api/_lib/lineupAccounting.js';
import {markerFor} from '../../api/_lib/lineupAccountingSchema.js';
export const INIT=`
for _,k in ipairs(KEYS) do if redis.call('EXISTS',k) ~= 0 then return redis.error_reply('FIXTURE_EXISTS') end end
redis.call('SET',KEYS[1],ARGV[1]);redis.call('SET',KEYS[2],ARGV[2])
redis.call('SADD',KEYS[3],ARGV[3]);redis.call('SADD',KEYS[4],ARGV[3]);return 1`;
export const ROTATE=`
if redis.call('GET',KEYS[1]) ~= ARGV[1] or redis.call('GET',KEYS[2]) ~= ARGV[2] then return redis.error_reply('FIXTURE_CAS') end
redis.call('SET',KEYS[1],ARGV[3]);redis.call('SET',KEYS[2],ARGV[4]);return 1`;
export async function initializeJournal(redis){
 const id=randomUUID(),generation=randomUUID();
 const gate={schema:1,registryId:id,generation,phase:'OPEN'},registry={schema:1,id,generation};
 await redis.eval(INIT,[CONTROL,REGISTRY,ALL,ACTIVE],[JSON.stringify(gate),JSON.stringify(registry),markerFor(id)]);
}
export async function rotateAdmission(redis,phase){
 const gate=await redis.command('GET',CONTROL),registry=await redis.command('GET',REGISTRY);
 const g=JSON.parse(gate),r=JSON.parse(registry),generation=randomUUID();
 await redis.eval(ROTATE,[CONTROL,REGISTRY],[gate,registry,JSON.stringify({...g,phase,generation}),JSON.stringify({...r,generation})]);
}
