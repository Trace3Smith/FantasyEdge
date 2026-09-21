// Packaging only. No network, Redis connection, deployment, env inspection or execution.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const output=resolve(process.argv[2] || '/tmp/fantasyedge-epoch-certification');
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim()) throw Error('COMMIT_REVIEWED_SOURCE_FIRST');
await mkdir(output,{recursive:true,mode:0o700});
const archive=resolve(output,'source.tar');
execFileSync('git',['archive','--format=tar',`--output=${archive}`,sha]);
const digest=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(resolve(output,'manifest.json'),JSON.stringify({sourceSha:sha,archiveSha256:digest,sdk:'@upstash/redis@1.38.0',targetProject:'fantasyedgepreview',targetProjectId:'prj_J2iHBHjE2viBnWRRRl6QeWk2dexi',productionAllowed:false,hostedExecutionAuthorized:false,requiredCommands:['EVAL','GET','SET','DEL','EXISTS','TYPE','INCR','EXPIRE','PTTL','TIME','SCAN','SADD','SREM','SMEMBERS','SISMEMBER','SCARD'],instructions:'docs/storage-epoch-certification.md'},null,2)+'\n');
console.log(JSON.stringify({sourceSha:sha,archiveSha256:digest,prepared:1,deployed:0}));
