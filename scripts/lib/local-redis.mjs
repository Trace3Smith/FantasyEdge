// Disposable real Redis over a private Unix socket: no TCP, persistence or external service.
import { spawn } from 'node:child_process';
import { readonlyLuaInputs } from './readonly-lua-inputs.mjs';
import { createConnection } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function localRedis() {
  const directory=await mkdtemp(join(tmpdir(),'fe-lifecycle-')),socket=join(directory,'redis.sock');
  const child=spawn(process.env.FE_TEST_REDIS_SERVER||'redis-server',[
    '--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no',
    '--dir',directory,'--loglevel','notice',
  ],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Local Redis startup timed out')),10000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Local Redis exited before ready'));});
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('ready to accept connections')){clearTimeout(timer);resolve();}});
  });
  const parse=(buf,start=0)=>{
    const lineEnd=buf.indexOf('\r\n',start);if(lineEnd<0)return null;
    const type=String.fromCharCode(buf[start]),line=buf.subarray(start+1,lineEnd).toString(),next=lineEnd+2;
    if(type==='+'||type===':')return [type===':'?Number(line):line,next];
    if(type==='-')throw new Error('Local Redis command failed: '+line);
    if(type==='$'){const size=Number(line);if(size===-1)return [null,next];if(buf.length<next+size+2)return null;return [buf.subarray(next,next+size).toString(),next+size+2];}
    if(type==='*'){const count=Number(line);if(count===-1)return [null,next];let cursor=next;const items=[];for(let i=0;i<count;i++){const result=parse(buf,cursor);if(!result)return null;items.push(result[0]);cursor=result[1];}return [items,cursor];}
    throw new Error('Unexpected local Redis protocol');
  };
  const command=(...args)=>new Promise((resolve,reject)=>{
    // Covers both direct eval() and the installed SDK's REST -> command() path.
    if (String(args[0]).toUpperCase() === 'EVAL') args[1] = readonlyLuaInputs(args[1]);
    const connection=createConnection(socket);let received=Buffer.alloc(0);
    connection.setTimeout(10000,()=>connection.destroy(new Error('Local Redis command timeout')));
    connection.on('error',reject);
    connection.on('connect',()=>{
      const chunks=[Buffer.from(`*${args.length}\r\n`)];
      for(const arg of args){const bytes=Buffer.from(String(arg));chunks.push(Buffer.from(`$${bytes.length}\r\n`),bytes,Buffer.from('\r\n'));}
      connection.write(Buffer.concat(chunks));
    });
    connection.on('data',chunk=>{received=Buffer.concat([received,chunk]);try{const result=parse(received);if(result){connection.end();resolve(result[0]);}}catch(e){connection.destroy();reject(e);}});
  });
  return {
    command,
    get:async key=>{const raw=await command('GET',key);if(raw===null)return null;try{return JSON.parse(raw);}catch{return raw;}},
    set:(key,value,options)=>command('SET',key,JSON.stringify(value),...(options?.ex?['EX',options.ex]:[])),
    del:(...keys)=>command('DEL',...keys),sadd:(...args)=>command('SADD',...args),srem:(...args)=>command('SREM',...args),
    smembers:key=>command('SMEMBERS',key),
    eval:(script,keys,args)=>command('EVAL',script,keys.length,...keys,...args),
    close:async()=>{await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});await rm(directory,{recursive:true,force:true});},
  };
}
