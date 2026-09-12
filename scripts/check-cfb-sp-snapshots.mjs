// Offline prospective history tests. Never calls CFBD, ESPN or live Redis.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { makeSpSnapshot, recordSpSnapshot, spSnapshotKey } from '../api/_lib/cfbSpSnapshots.js';
const now = Date.parse('2026-09-12T11:05:00Z');
const rows = Array.from({length:20},(_,i)=>({team:`School ${i}`,year:2026,rating:i-10,offense:{rating:i}}));
const input = {
  now, observation:{rows,basis:'season',season:2026,observedAt:'2026-09-12T11:00:00Z'},
  ratings:{season:2026,basis:'season',v:1,builtAt:'2026-09-12T11:02:00Z',homeField:2.48,
    teams:{Home:{sp:{rating:5}}},crosswalk:{'1':'Home','2':'Away'}},
  feed:{season:2026,seasonType:2,week:3,games:[
    {id:'future',state:'pre',date:'2026-09-12T19:00:00Z',home:{id:1},away:{id:2},odds:{spread:-7}},
    {id:'started',state:'in',date:'2026-09-12T10:00:00Z',home:{id:1},away:{id:2}},
    {id:'stale-state',state:'pre',date:'2026-09-12T11:03:00Z',home:{id:1},away:{id:2}},
  ]},
};
const snapshot=makeSpSnapshot(input);
assert.equal(spSnapshotKey(snapshot),'ratings:cfb:sp:snapshot:v1:2026:2:3');
assert.deepEqual(snapshot.rawSp,rows);
assert.deepEqual(snapshot.games.map(g=>g.id),['future']);
assert.equal(snapshot.games[0].homeSpread,-7);
assert.equal(snapshot.validation.showWinProb,false);
assert.equal(snapshot.sourcePublishedAt,null);
const store = new Map();
const redis={set:async(k,v,opts)=>{
  assert.deepEqual(opts,{nx:true});
  if(store.has(k))return null;store.set(k,structuredClone(v));return 'OK';
}};
assert.equal((await recordSpSnapshot(redis,input)).status,'stored');
const later=structuredClone(input);later.observation.rows[0].rating=100;
assert.equal((await recordSpSnapshot(redis,later)).status,'already_exists');
assert.equal([...store.values()][0].rawSp[0].rating,-10);
for (const mutate of [
  x=>x.observation.basis='prior-season', x=>x.observation.season=2025,
  x=>x.ratings.season=2025, x=>x.feed.season=2025, x=>x.feed.week=null,
  x=>x.observation.observedAt='2026-09-11T11:00:00Z',
  x=>x.observation.observedAt='2026-09-12T12:00:00Z',
  x=>x.observation.rows=[], x=>x.observation.rows[0].year=2025,
  x=>x.feed.games=[], x=>x.ratings.crosswalk={},
]) { const bad=structuredClone(input);mutate(bad);assert.equal(makeSpSnapshot(bad),null); }
const post=structuredClone(input);post.feed.seasonType=3;
assert.notEqual(spSnapshotKey(makeSpSnapshot(post)),spSnapshotKey(snapshot));
const parallel = await Promise.all([recordSpSnapshot(redis,post),recordSpSnapshot(redis,post)]);
assert.deepEqual(parallel.map(x=>x.status).sort(),['already_exists','stored']);
// Real ratings builder reuses exactly the existing year-level requests.
const moduleUrl=new URL('../api/_lib/cfbd.js',import.meta.url).href;
const real = await import(moduleUrl);const calls=[];
mock.module(moduleUrl,{namedExports:{...real,cfbdConfigured:true,
  resetCfbdSpent:()=>{},cfbdSpent:()=>calls.length,
  spRatings:async year=>{calls.push(['sp',year]);return rows;},
  advancedSeasonStats:async year=>{calls.push(['advanced',year]);return [];},
  teamTalent:async year=>{calls.push(['talent',year]);return [];},
  returningProduction:async year=>{calls.push(['returning',year]);return [];},
  fbsTeams:async year=>{calls.push(['teams',year]);return [];},
  cfbdUsage:async()=>{calls.push(['usage']);return null;},
}});
const {buildCfbRatings}=await import('../api/_lib/cfbRatings.js');
let observed;
await buildCfbRatings({season:2026,espnTeams:[],onSpObserved:value=>{observed=value;}});
assert.equal(observed.rows,rows,'capture uses the exact fetched response');
assert.equal(observed.season,2026);assert.equal(observed.basis,'season');
assert.equal(calls.length,6);assert.equal(calls.filter(x=>x[0]==='sp').length,1);
console.log('PASS: prospective timestamps, raw payload, season/week identity, immutable snapshots, closed gates and zero additional CFBD calls');
