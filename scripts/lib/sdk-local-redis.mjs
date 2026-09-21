// Installed SDK -> real REST framing/automatic pipeline -> disposable Redis.
// No sockets except local Redis's private Unix socket; all non-synthetic HTTP denied.
import { Redis } from '@upstash/redis';
import { localRedis } from './local-redis.mjs';
export async function sdkLocalRedis() {
 const local = await localRedis(), previous = globalThis.fetch;
 const stats = {requests:0, commands:0, pipelines:0};
 const encode = value => Array.isArray(value) ? value.map(encode) : typeof value === 'string' && value !== 'OK' ? Buffer.from(value).toString('base64') : value;
 globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://epoch-sdk.invalid/')) throw Error('NETWORK_FORBIDDEN');
  stats.requests++;
  const body = JSON.parse(options.body), pipeline = Array.isArray(body[0]);
  if(pipeline) stats.pipelines++;
  const results=[];
  for(const command of pipeline ? body : [body]) {
   stats.commands++;
   try { results.push({result:encode(await local.command(...command))}); }
   catch { results.push({error:'SYNTHETIC_REDIS_ERROR'}); }
  }
  return new Response(JSON.stringify(pipeline ? results : results[0]),{status:200,headers:{'content-type':'application/json'}});
 };
 const sdk = new Redis({url:'https://epoch-sdk.invalid',token:'synthetic-only',automaticDeserialization:false,retry:false,enableTelemetry:false});
 return {eval:(...a)=>sdk.eval(...a),get:(...a)=>sdk.get(...a),set:(...a)=>sdk.set(...a),del:(...a)=>sdk.del(...a),sadd:(...a)=>sdk.sadd(...a),srem:(...a)=>sdk.srem(...a),smembers:(...a)=>sdk.smembers(...a),command:local.command,stats,
  close:async()=>{globalThis.fetch=previous;await local.close();}};
}
