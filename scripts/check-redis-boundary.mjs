// Architectural regression: every runtime Redis consumer goes through the fixed epoch.
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
const walk=async d=>(await Promise.all((await readdir(d,{withFileTypes:true})).map(x=>x.isDirectory()?walk(`${d}/${x.name}`):`${d}/${x.name}`))).flat();
const files=(await walk('api')).filter(f=>f.endsWith('.js'));
const commands=new Set(['get','set','del','eval','expire','incr','smembers','sadd','srem','quotaBlocked']);
const consumers=[];
for(const file of files){
 const source=await readFile(file,'utf8');
 if(source.includes('@upstash/redis'))assert.equal(file,'api/_lib/kv.js');
 assert.equal(/(?:bootstrap-storage|epoch-bootstrap)/.test(source),false,file);
 if(file!=='api/_lib/storageEpoch.js')assert.equal(source.includes('fe:e1:'),false,file);
 assert.equal(/\bredis\s*\[/.test(source),false,file);
 if(/\bredis\./.test(source))consumers.push(file);
 for(const m of source.matchAll(/\bredis\.(\w+)\s*\(/g)){
  if(['call','error_reply'].includes(m[1])){assert.ok(['api/_lib/espnLifecycle.js','api/_lib/storageEpoch.js'].includes(file));continue;}
  assert.ok(commands.has(m[1]),`${file}: ${m[1]}`);
  if(m[1]==='eval')assert.equal(file,'api/_lib/espnLifecycle.js');
 }
 if(source.includes('registerEpochScript('))assert.ok(['api/_lib/storageEpoch.js','api/_lib/espnLifecycle.js'].includes(file));
 if(source.includes('decryptCredentials('))assert.equal(file,'api/_lib/espnCredentials.js');
}
const kv=await readFile('api/_lib/kv.js','utf8');assert.match(kv,/export const redis = epochRedis\(new Redis/);
console.log(`PASS: ${consumers.length} Redis consumers; shared epoch boundary, registered lifecycle Lua only, no raw client or bootstrap/runtime legacy fallback`);
