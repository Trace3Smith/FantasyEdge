import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateSnapshots, compareActions } from '../api/_lib/myEdge/aggregate.js';
import { aggregateEspn } from '../api/_lib/myEdge/espn.js';
import { fetchLeagueRoster } from '../api/_lib/espnFantasy.js';
const now=Date.parse('2026-09-12T12:00:00Z'), observedAt=new Date(now).toISOString();
const originalFetch=globalThis.fetch;
const snapshots=[];
try {
 for(const sport of ['nba','nhl']) for(const season of [2027,2026]) {
   const f=JSON.parse(readFileSync(new URL(`fixtures/readonly-rosters/${sport}-${season}.json`,import.meta.url)));
   globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(f.league)});
   const league=await fetchLeagueRoster({swid:f.owner,espn_s2:'offline'},f.selection,sport);
   const scope={platform:'espn',sport,season,leagueId:f.selection.leagueId,teamId:String(f.selection.teamId)};
   const snapshot={scope,league,observedAt,capabilities:['READ_ONLY']};snapshots.push(snapshot);
   const result=aggregateSnapshots([snapshot],{now});
   if(season===2027) {assert.equal(result.assessments[0].status,'EMPTY_ROSTER');assert.equal(result.attentionCount,0);assert.equal(league.rosterState,'EMPTY');}
   if(sport==='nhl'&&season===2026) {
     assert.deepEqual([...new Set(league.roster.map(p=>p.pos))].sort(),['C','D','G','LW','RW']);
     assert.ok(league.roster.every(p=>p.starter===null),'unknown slot roles are not mislabeled starters');
     assert.equal(result.assessments[0].reason,'slot_mapping_unsupported');
   }
   if(sport==='nba'&&season===2026) {
     assert.ok(league.roster.every(p=>p.positionKnown&&p.slotKnown));
     assert.ok(result.actions.length>0);assert.ok(result.actions.every(a=>a.apply.capability==='READ_ONLY'));
   }
 }
} finally {globalThis.fetch=originalFetch;}
const nba=snapshots.find(s=>s.scope.sport==='nba'&&s.scope.season===2026);
assert.equal(aggregateSnapshots([{...nba,observedAt:'bad'}],{now}).assessments[0].status,'STALE');
assert.equal(aggregateSnapshots([{...nba,observedAt:new Date(now-300001).toISOString()}],{now}).attentionCount,0);
assert.equal(aggregateSnapshots([{...nba,error:'secret error'}],{now}).assessments[0].status,'UNAVAILABLE');
const clear=structuredClone(nba);clear.league.roster.forEach(p=>{p.availability='AVAILABLE';p.injuryStatus='ACTIVE';});
let result=aggregateSnapshots([clear],{now});
assert.equal(result.assessments[0].status,'ALL_CLEAR');assert.equal(result.assessments[0].clearScope,'starter_availability');
clear.league.roster.find(p=>p.starter).injuryStatusKnown=false;
assert.equal(aggregateSnapshots([clear],{now}).assessments[0].status,'PARTIAL');
assert.equal(aggregateSnapshots([nba,nba],{now}).actions.length,aggregateSnapshots([nba],{now}).actions.length);
const other=structuredClone(nba);other.scope.sport='wnba';
assert.equal(aggregateSnapshots([nba,other],{now}).actions.length,2*aggregateSnapshots([nba],{now}).actions.length);
const locked=structuredClone(nba);locked.league.roster.forEach(p=>p.locked=true);
assert.equal(aggregateSnapshots([locked],{now}).attentionCount,0);
const action=aggregateSnapshots([nba],{now}).actions[0];
assert.ok(compareActions({...action,id:'a',urgency:{level:'HIGH'}},{...action,id:'b',urgency:{level:'LOW'}})<0);
assert.ok(compareActions({...action,id:'a',impact:{level:'HIGH'}},{...action,id:'b',impact:{level:'LOW'}})<0);
assert.ok(compareActions({...action,id:'a',confidence:{level:'HIGH'}},{...action,id:'b',confidence:{level:'LOW'}})<0);
let reads=0,discoveries=0;
const deps={now:()=>now,discover:async()=>{discoveries++;return {diag:{ok:true,prefCount:5},leagues:Array.from({length:5},(_,i)=>({sport:'nba',seasonId:2027,leagueId:String(i),teamId:1}))};},
 roster:async(c,l)=>{reads++;if(l.leagueId==='1')throw new Error('private failure');return snapshots[0].league;}};
result=await aggregateEspn({espn_s2:'secret-never-return',swid:'private-owner'},deps);
assert.equal(discoveries,1);assert.equal(reads,4);assert.equal(result.complete,false);
assert.equal(result.assessments.filter(a=>a.status==='UNAVAILABLE').length,1);
assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(JSON.stringify(result).includes('secret-never-return'),false);
assert.equal((await aggregateEspn({}, {...deps,discover:async()=>({diag:{ok:false},leagues:[]})})).connectionState,'UNAVAILABLE');
console.log('PASS: preseason empties, NBA health, NHL position evidence/slot gaps, scoped All Clear, stale/unknown data, deduplication, priorities, per-sport IDs, bounded reads and partial errors');
// Missing fields must remain distinguishable from affirmative healthy/unlocked evidence.
try {
 const f=JSON.parse(readFileSync(new URL('fixtures/readonly-rosters/nba-2026.json',import.meta.url)));
 const team=f.league.teams.find(t=>t.id===f.selection.teamId);
 const entry=team.roster.entries[0];
 delete entry.lineupLocked;delete entry.playerPoolEntry.lineupLocked;delete entry.playerPoolEntry.rosterLocked;
 delete entry.playerPoolEntry.player.injuryStatus;
 entry.lineupSlotId=999;
 globalThis.fetch=async()=>({ok:true,json:async()=>f.league});
 let parsed=await fetchLeagueRoster({swid:f.owner,espn_s2:'offline'},f.selection,'nba');
 const p=parsed.roster.find(p=>p.id===entry.playerPoolEntry.player.id);
 assert.equal(p.lockStatusKnown,false);assert.equal(p.injuryStatusKnown,false);assert.equal(p.availability,'UNKNOWN');
 assert.equal(p.starter,null);assert.equal(p.slotKnown,false);
 assert.ok(parsed.roster.indexOf(p)<parsed.roster.findIndex(x=>x.slotId===12),'unknown and bench slots retain input order when both have no active slot order');
 delete team.roster;
 parsed=await fetchLeagueRoster({swid:f.owner,espn_s2:'offline'},f.selection,'nba');
 assert.equal(parsed.rosterState,'UNAVAILABLE','absent roster is different from explicit empty entries');
} finally {globalThis.fetch=originalFetch;}
console.log('PASS: missing provider evidence and unrecognized slots remain unknown');
