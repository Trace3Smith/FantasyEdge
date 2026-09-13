// Synthetic privacy/shape tests; never claimed as provider evidence.
import assert from 'node:assert/strict';
import { sanitizeCapture } from './lib/sanitize-espn-fixture.mjs';
const owner='{11111111-1111-1111-1111-111111111111}';
for (const sport of ['nba','nhl']) {
 const a=sport==='nba'?'FBA':'FHL';
 const input={sport,owner,selection:{sport,leagueId:'4',seasonId:2027,teamId:2,leagueName:'PRIVATE'},
  fan:{email:'PRIVATE',preferences:[{type:{abbrev:a},metaData:{entry:{seasonId:2027,entryId:2,groups:[{groupId:4,groupName:'PRIVATE'}]}}}]},
  league:{id:4,seasonId:2027,scoringPeriodId:1,members:[{id:owner,email:'PRIVATE'}],settings:{name:'PRIVATE',size:2,
   rosterSettings:{lineupSlotCounts:{11:2,13:1},isBenchUnlimited:false},scoringSettings:{scoringType:'ROTO',scoringItems:[{statId:10,isReverseItem:true,points:-1}]}},
   teams:[{id:2,owners:[owner],primaryOwner:owner,name:'PRIVATE',logo:'https://PRIVATE',roster:{entries:[{lineupSlotId:13,playerPoolEntry:{lineupLocked:false,player:{id:7,fullName:'Public Athlete',defaultPositionId:1,proTeamId:5,eligibleSlots:[0,11,13],injuryStatus:'INJURY_RESERVE'}}}]}},
    {id:3,owners:['other-private-owner'],roster:{entries:[{private:'PRIVATE'}]}}]}};
 const f=sanitizeCapture(input),str=JSON.stringify(f);
 assert.equal(str.includes('PRIVATE'),false);assert.equal(str.includes(owner),false);assert.equal(str.includes('other-private-owner'),false);
 assert.equal(f.league.teams[0].owners[0],f.owner);assert.equal(f.league.teams[0].primaryOwner,f.owner);
 assert.notEqual(f.league.teams[1].owners[0],f.owner);assert.equal(f.league.teams[1].roster,undefined);
 assert.deepEqual(f.league.settings.rosterSettings,input.league.settings.rosterSettings);
 assert.deepEqual(f.league.settings.scoringSettings,input.league.settings.scoringSettings);
 assert.equal(f.league.teams[0].roster.entries[0].playerPoolEntry.lineupLocked,false);
 assert.equal(f.league.teams[0].roster.entries[0].playerPoolEntry.rosterLocked,undefined);
 assert.deepEqual(f.league.teams[0].roster.entries[0].playerPoolEntry.player.eligibleSlots,[0,11,13]);
 assert.equal(f.fan.preferences[0].metaData.entry.groups[0].groupId,4);
}
console.log('PASS: synthetic capture privacy, owner association, numeric rules, eligibility and absent lock fields; not provider validation');
