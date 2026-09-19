import assert from 'node:assert/strict';
import { fetchLeagueRoster,fetchFreeAgents,fetchLeagueAllTeams,slotLabel } from '../api/_lib/espnFantasy.js';
import { buildValueIndex,suggestLineup } from '../api/_lib/lineupAdvisor.js';
import { mlbPositionFixture,mlbPositions,mlbOwner } from './lib/mlb-position-fixture.mjs';
const {raw,freeAgents}=mlbPositionFixture();
const creds={swid:mlbOwner,espn_s2:'synthetic-offline'};
const selection={leagueId:'1',seasonId:2026,teamId:1};
const originalFetch=globalThis.fetch;
try {
  globalThis.fetch=async(url,options={})=>{
    assert.ok(!options.method || options.method==='GET');
    return {ok:true,status:200,json:async()=>structuredClone(String(url).includes('kona_player_info')?{players:freeAgents}:raw)};
  };
  const read=()=>fetchLeagueRoster(creds,selection,'mlb');
  const league=await read(),pool=await fetchFreeAgents(creds,selection,'mlb');
  for(let i=0;i<11;i++) {
    const p=league.roster.find(p=>p.id===i+1),source=raw.teams[0].roster.entries[i];
    assert.equal(p.pos,mlbPositions[i]);assert.equal(p.positionKnown,true);
    assert.equal(p.positionId,i+1);assert.equal(p.slotId,source.lineupSlotId);
    assert.deepEqual(p.eligibleSlots,source.playerPoolEntry.player.eligibleSlots);
    assert.equal(pool[i].pos,mlbPositions[i]);assert.equal(pool[i].positionKnown,true);
    assert.equal(pool[i].positionId,i+1);assert.deepEqual(pool[i].eligibleSlots,source.playerPoolEntry.player.eligibleSlots);
  }
  assert.deepEqual(league.slotCounts,raw.settings.rosterSettings.lineupSlotCounts);
  for(const [id,slot,pos] of [[12,'BE','SP'],[13,'IL','RP']]) {
    const p=league.roster.find(p=>p.id===id);assert.equal(p.slot,slot);assert.equal(p.pos,pos);assert.equal(p.starter,false);
  }
  // Compare corrected labels with the old decoder while holding all decision inputs fixed.
  const z=n=>Object.fromEntries(['r','hr','rbi','sb','avg','w','sv','k','era','whip'].map(k=>[k,n]));
  const idx=buildValueIndex([...league.roster,...pool].map(p=>({name:p.name,zTotal:p.id>=100?20:p.id===1?1:10,z:z(p.id>=100?20:p.id===1?1:10)})),'mlb');
  const old=p=>({...p,pos:slotLabel(p.positionId,'mlb')});
  const withoutLabels=x=>JSON.parse(JSON.stringify(x,(k,v)=>k.endsWith('Meta')?undefined:v));
  for(const injured of [false,true]) {
    const current=structuredClone(league);
    if(injured)Object.assign(current.roster.find(p=>p.id===1),{injury:'IL',injuryStatus:'INJURY_RESERVE'});
    const corrected=suggestLineup(current,idx,'mlb',{freeAgents:pool,ilWindowClosed:false});
    const previous=suggestLineup({...current,roster:current.roster.map(old)},idx,'mlb',{freeAgents:pool.map(old),ilWindowClosed:false});
    assert.deepEqual(withoutLabels(corrected),withoutLabels(previous),'plans, eligibility decisions, waiver choices, gains and category calculations unchanged');
    assert.ok(corrected.plan.length,'exercise real lineup decisions');
    if(!injured)assert.ok(corrected.moves.some(m=>m.reason==='waiver'&&m.cats),'exercise category-based waiver selection');
    else assert.ok(corrected.moves.some(m=>m.reason==='il'),'exercise IL decisions');
    for(const move of corrected.plan)assert.ok(current.roster.find(p=>p.id===move.playerId).eligibleSlots.includes(move.toLineupSlotId));
  }
  // Unknown IDs may coincide with valid lineup-slot IDs: never borrow their slot labels.
  for(const id of [0,12,14,99,null,undefined,'constructor']) {
    raw.teams[0].roster.entries[0].playerPoolEntry.player.defaultPositionId=id;
    freeAgents[0].player.defaultPositionId=id;
    for(const p of [(await read()).roster.find(p=>p.id===1),(await fetchFreeAgents(creds,selection,'mlb'))[0]]) {
      assert.equal(p.pos,'Unknown position');assert.equal(p.positionKnown,false);
      assert.deepEqual(p.eligibleSlots,[13,14,16,17]);
    }
  }
  raw.teams.push({...structuredClone(raw.teams[0]),id:2,primaryOwner:'other',record:{overall:{wins:5,losses:3,ties:1}}});
  assert.ok((await fetchLeagueAllTeams(creds,selection,'mlb')).teams.every(t=>t.record===''),'ROTO omits W-L for owned and alternate teams');
  for(const type of ['H2H_POINTS','H2H_CATEGORY','H2H_MOST_CATEGORIES']) {
    raw.settings.scoringSettings.scoringType=type;
    assert.deepEqual((await fetchLeagueAllTeams(creds,selection,'mlb')).teams.map(t=>t.record),['0-0','5-3-1']);
  }
  console.log('PASS: MLB actual roster/free-agent position readers, unknown IDs, preserved eligibility/lineup/IL/waiver decisions and ROTO/H2H team records');
} finally {globalThis.fetch=originalFetch;}
