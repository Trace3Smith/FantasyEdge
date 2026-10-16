// Evaluates the actual proposed JSON predicates. This is not live WAF certification.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [quarantine,maintenance]=JSON.parse(await readFile(new URL('../docs/lineup-accounting-fencing.template.json',import.meta.url),'utf8'));
const cron='__VERIFIED_ACCOUNTING_DEPLOYMENT_CRON_HOST__',www='www.fantasyedgeapp.com';
function denied(rule,request){
 return rule.conditionGroup.some(g=>g.conditions.every(c=>{
  const v=['host','path'].includes(c.type)?request[c.type]:request[c.type]?.[c.key];
  let match;
  if(c.op==='ex')match=v!==undefined;
  else if(c.op==='eq')match=String(v).toLowerCase()===c.value.toLowerCase();
  else if(c.op==='inc')match=c.value.some(x=>x.toLowerCase()===String(v).toLowerCase());
  else if(c.op==='pre')match=String(v).toLowerCase().startsWith(c.value.toLowerCase());
  else throw Error('UNSUPPORTED_PREDICATE');
  return c.neg?!match:match;
 }));
}
let checks=0;
for(const host of ['old-immutable.vercel.app','old-branch.vercel.app','fantasy-edge-nine.vercel.app','fantasy-edge-dq1n9wuol-fantasy-edge-s-projects.vercel.app'])
 for(const path of ['/','/api/espn','/api/cron/autopilot','/legacy-rewrite','/%61pi/espn','/API/espn','/assets/app.js'])
  for(const method of ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD']){assert(denied(quarantine,{host,path,method}));checks++;}
for(const host of [www,www.toUpperCase(),cron,'fantasyedgeapp.com'])for(const path of ['/','/api/espn','/api/cron/autopilot'])
 for(const [kind,key] of [['header','x-deployment-id'],['query','dpl'],['cookie','__vdpl']]){
  assert(denied(quarantine,{host,path,[kind]:{[key]:'old'}}));checks++;
 }
assert(!denied(quarantine,{host:www,path:'/api/espn'}));
assert(!denied(quarantine,{host:'fantasyedgeapp.com',path:'/'}));
for(const path of ['/api/cron/autopilot','/api/cron/refresh']){
 assert(!denied(quarantine,{host:cron,path}));assert(denied(quarantine,{host:www,path}));
}
assert(denied(quarantine,{host:cron,path:'/api/espn'}));
for(const host of [www,cron,'old-immutable.vercel.app'])for(const path of ['/api','/api/espn','/api/cron/autopilot']){
 assert(denied(maintenance,{host,path}));checks++;
}
assert(!denied(maintenance,{host:www,path:'/'}));
console.log(JSON.stringify({passed:true,predicateChecks:checks+8,liveEnforcementTested:false}));
