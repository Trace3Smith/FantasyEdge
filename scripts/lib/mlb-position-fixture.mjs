// Synthetic league/ownership, using MLB position IDs cross-checked against ESPN's public
// /apis/v3/games/flb/seasons/2026/players?view=players_wl feed. Not a captured private roster.
export const mlbPositions = ['SP','C','1B','2B','3B','SS','LF','CF','RF','DH','RP'];
export const mlbOwner = '{00000000-0000-0000-0000-000000000001}';
export function mlbPositionFixture() {
  const slots = [14,0,1,2,3,4,8,9,10,11,15];
  const player = (id, positionId, eligibleSlots) => ({id, fullName:`Test ${id>=100?'Freeagent':'Roster'} ${String.fromCharCode(65+id%100)}`,
    defaultPositionId:positionId, proTeamId:1, eligibleSlots, injuryStatus:'ACTIVE'});
  const entry = (p, lineupSlotId) => ({lineupSlotId, playerPoolEntry:{lineupLocked:false, player:p}});
  const entries = slots.map((slot,i) => entry(player(i+1,i+1,
    i===0?[13,14,16,17]:i===10?[13,15,16,17]:[slot,12,16,17]),slot));
  entries[2].playerPoolEntry.player.eligibleSlots = [1,3,7,12,16,17]; // Multi-position hitter.
  entries.push(entry(player(12,1,[13,14,16,17]),16));
  entries.push(entry({...player(13,11,[13,15,16,17]),injuryStatus:'INJURY_RESERVE'},17));
  const raw = {scoringPeriodId:1,settings:{name:'Synthetic MLB',scoringSettings:{scoringType:'ROTO'},
    rosterSettings:{lineupSlotCounts:{...Object.fromEntries(slots.map(s=>[s,1])),16:3,17:2}}},
    teams:[{id:1,name:'Synthetic Team',primaryOwner:mlbOwner,record:{overall:{wins:0,losses:0,ties:0}},roster:{entries}}]};
  const freeAgents = mlbPositions.map((_,i)=>({player:player(101+i,i+1,entries[i].playerPoolEntry.player.eligibleSlots)}));
  return {raw,freeAgents};
}
