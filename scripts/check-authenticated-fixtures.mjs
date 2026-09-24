// Offline replay of sanitized authenticated provider reads. No cookies or network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverFanLeagues, fetchLeagueRoster } from '../api/_lib/espnFantasy.js';
import { leagueCapabilities, WRITE_SPORTS, AUTOPILOT_SPORTS } from '../leagueCapabilities.js';
const originalFetch=globalThis.fetch;
try {
 for(const sport of ['nba','nhl']) {
  for(const season of [2027,2026]) {
   const fixture=JSON.parse(readFileSync(new URL(`fixtures/readonly-rosters/${sport}-${season}.json`,import.meta.url)));
   const {selection,owner,league,fan}=fixture;
   const creds={swid:owner,espn_s2:'offline-synthetic-cookie'};
   globalThis.fetch=async (url,options)=>{
    assert.ok(!options.method || options.method==='GET');
    const u=new URL(url);
    const isFan=u.hostname==='fan.api.espn.com';
    if(!isFan) {
      assert.equal(u.hostname,'lm-api-reads.fantasy.espn.com');
      assert.ok(u.pathname.includes(`/games/${sport==='nba'?'fba':'fhl'}/seasons/${season}/`));
    }
    return {ok:true,status:200,json:async()=>structuredClone(isFan?fan:league)};
   };
   const discovery=await discoverFanLeagues(creds,sport);
   assert.equal(discovery.diag.ok,true);
   assert.ok(discovery.leagues.some(x=>x.leagueId===selection.leagueId && String(x.teamId)===String(selection.teamId) && x.seasonId===2027));
   const result=await fetchLeagueRoster(creds,selection,sport);
   assert.equal(result.season,season);
   assert.equal(result.teamId,selection.teamId);
   assert.equal(result.scoringType,'ROTO');
   assert.deepEqual(result.scoringRaw,league.settings.scoringSettings);
   assert.deepEqual(result.slotCounts,league.settings.rosterSettings.lineupSlotCounts);
   assert.equal(result.roster.length,season===2027?0:sport==='nba'?15:22);
   assert.equal(result.rosterState,season===2027?'EMPTY':'POPULATED');
   const entries=league.teams.find(t=>t.id===selection.teamId).roster.entries;
   for(const entry of entries) {
     const source=entry.playerPoolEntry.player, parsed=result.roster.find(p=>p.id===source.id);
     assert.ok(parsed);
     assert.equal(parsed.proTeamId,source.proTeamId);
     assert.equal(parsed.slotId,entry.lineupSlotId);
     assert.equal(parsed.positionId,source.defaultPositionId);
     assert.equal(parsed.injuryStatusKnown,true);
     assert.equal(parsed.lockStatusKnown,true);
     assert.deepEqual(parsed.eligibleSlots,source.eligibleSlots);
     assert.equal(parsed.injuryStatus,source.injuryStatus);
     assert.equal(parsed.locked,entry.lineupLocked===true || entry.playerPoolEntry.lineupLocked===true || entry.playerPoolEntry.rosterLocked===true);
   }
   if(sport==='nba' && season===2026) {
     assert.ok(result.roster.some(p=>p.slotId===13 && !p.starter && p.injuryStatus==='OUT'));
     assert.ok(result.roster.some(p=>p.slotId===12 && !p.starter));
     assert.deepEqual([...new Set(result.roster.map(p=>p.pos))].sort(),['C','PF','PG','SF','SG']);
   }
   if(sport==='nhl' && season===2026) {
     const evidence=JSON.parse(readFileSync(new URL('fixtures/readonly-rosters/nhl-position-evidence.json',import.meta.url)));
     for(const row of evidence.rows) {
       const player=result.roster.find(p=>p.id===row.athleteId);
       assert.equal(player.positionId,row.fantasyDefaultPositionId);
       assert.equal(player.pos,row.position.abbreviation);
     }
     assert.ok(result.roster.every(p=>p.starter===null && !p.slotKnown));
   }
   const other=league.teams.find(t=>![t.primaryOwner,...(t.owners||[])].includes(owner));
   assert.ok(other,'capture retains a nonowned team identity');
   await assert.rejects(fetchLeagueRoster(creds,{...selection,teamId:other.id},sport),e=>e.status===403 || e.statusCode===403);
   await assert.rejects(fetchLeagueRoster({...creds,swid:'{ffffffff-ffff-ffff-ffff-ffffffffffff}'},selection,sport));
   assert.deepEqual(leagueCapabilities(sport).capabilities,['READ_ONLY']);
   assert.ok(leagueCapabilities(sport).limitations.length);
   assert.equal(WRITE_SPORTS.has(sport),false);assert.equal(AUTOPILOT_SPORTS.has(sport),false);
   console.log(`PASS: ${sport} ${season} authenticated fixture discovery, ownership, roster identity, eligibility, settings and closed write gates`);
  }
 }
} finally {globalThis.fetch=originalFetch;}
