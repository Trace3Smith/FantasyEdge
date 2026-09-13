import assert from 'node:assert/strict';
import { createRecommendationContext } from '../api/_lib/recommendationSnapshot.js';
import { buildValueIndex,suggestLineup,lineupVacancies } from '../api/_lib/lineupAdvisor.js';
import { parseScoringSettings,categoryRanks } from '../api/_lib/espnScoring.js';
import { aggregateSnapshots } from '../api/_lib/myEdge/aggregate.js';
import { aggregateEspn } from '../api/_lib/myEdge/espn.js';
import { createRecommendationLoader } from '../api/_lib/myEdge/recommendations.js';
const now=Date.now(),at=new Date(now).toISOString();
const rp=(name,id,starter)=>({name,id,pos:'PG',slotId:starter?0:12,starter,slotKnown:true,injuryStatus:'ACTIVE',injuryStatusKnown:true,
 availability:'AVAILABLE',injury:'',locked:false,lockStatusKnown:true,eligibleSlots:[0,11,12,13]});
const league={sport:'wnba',season:2026,leagueId:'1',teamId:1,team:{id:1},rosterState:'POPULATED',roster:[rp('Low',1,true),rp('High',2,false)],
 slotCounts:{0:1,12:2,13:1},scoringRaw:{scoringType:'H2H_POINTS',scoringItems:[{statId:0,points:1},{statId:6,points:1},{statId:3,points:1},{statId:2,points:1}]}};
const dataset={builtAt:at,players:[{name:'Low',pos:'PG',n:{pts:5}},{name:'High',pos:'PG',n:{pts:40}},{name:'Waiver',pos:'PG',n:{pts:80}}]};
const freeAgents=[rp('Waiver',3,false)],context=createRecommendationContext(dataset,'wnba'),scoring=parseScoringSettings(league.scoringRaw,'wnba');
const snapshot=context(league,{freeAgents});
assert.deepEqual(snapshot.suggestions,suggestLineup(league,buildValueIndex(dataset.players,'wnba',scoring.weights),'wnba',
 {freeAgents,cats:scoring.cats,ranks:categoryRanks(league.standings,league.teamId,'wnba'),byeWeeks:null}),'shared snapshot exactly matches Team Manager calculation');
assert.ok(snapshot.suggestions.moves.some(m=>m.reason==='value'));
assert.deepEqual(lineupVacancies(league,'wnba'),[]);
const vacant=structuredClone(league);vacant.slotCounts[0]=2;
assert.deepEqual(lineupVacancies(vacant,'wnba'),[{slotId:0,slot:'PG',count:1}]);
assert.equal(lineupVacancies({...league,roster:[]},'wnba'),null);
assert.equal(lineupVacancies(league,'nhl'),null);
const scope={platform:'espn',sport:'wnba',season:2026,leagueId:'1',teamId:'1'};
const snap={scope,league,capabilities:['READ_ONLY','RECOMMENDATIONS'],observedAt:at,vacancies:[],recommendations:{...snapshot,status:'RECOMMENDATIONS',waiversAvailable:true}};
let result=aggregateSnapshots([snap],{now});
assert.ok(result.actions.some(a=>a.type==='LINEUP_UPGRADE'));
assert.ok(result.actions.every(a=>a.apply.capability==='READ_ONLY'));
assert.equal(aggregateSnapshots([snap,snap],{now}).actions.length,result.actions.length);
const injury=structuredClone(snap);Object.assign(injury.league.roster[0],{injuryStatus:'OUT',availability:'UNAVAILABLE'});
injury.recommendations.suggestions.moves=[{reason:'injury',in:'High',out:'Low',slot:'PG',gain:35}];
result=aggregateSnapshots([injury],{now});assert.equal(result.actions.length,1);assert.equal(result.actions[0].evidence.length,2);
const il=structuredClone(snap);il.recommendations.suggestions.moves=[{reason:'il',action:'from_il',in:'High',slot:'BE'}];
assert.match(aggregateSnapshots([il],{now}).actions[0].summary,/activating High/);
const wafer=structuredClone(snap);wafer.recommendations.suggestions.moves=[{reason:'waiver',add:'Waiver',drop:'Low',gain:75}];
assert.equal(aggregateSnapshots([wafer],{now}).actions[0].type,'WAIVER_OPPORTUNITY');
wafer.recommendations.waiversAvailable=false;assert.equal(aggregateSnapshots([wafer],{now}).actions.length,0);
const stale=structuredClone(snap);stale.recommendations.valuesAt=new Date(now-31*3600000).toISOString();
assert.equal(aggregateSnapshots([stale],{now}).actions.length,0);assert.equal(aggregateSnapshots([stale],{now}).assessments[0].status,'PARTIAL');
const clear=structuredClone(snap);clear.recommendations.suggestions.moves=[];
assert.equal(aggregateSnapshots([clear],{now}).assessments[0].status,'ALL_CLEAR');
clear.recommendations.suggestions.moves=[{reason:'il_full'}];assert.equal(aggregateSnapshots([clear],{now}).assessments[0].status,'PARTIAL');
let dsReads=0,faReads=0;
const loader=createRecommendationLoader({get:async()=>{dsReads++;return dataset;}},{},{now:()=>now,freeAgents:async()=>{faReads++;return freeAgents;}});
assert.equal((await loader(league)).status,'RECOMMENDATIONS');assert.equal((await loader(league)).status,'RECOMMENDATIONS');assert.equal(dsReads,1);
assert.equal((await loader({...league,sport:'nba'})).status,'READ_ONLY');assert.equal((await loader({...league,sport:'nhl'})).status,'READ_ONLY');assert.equal(faReads,2);
const partialLoader=createRecommendationLoader({get:async()=>({...dataset,builtAt:'bad'})},{},{now:()=>now,freeAgents:async()=>{throw new Error('must not fetch stale');}});
assert.equal((await partialLoader(league)).reason,'valuation_stale_or_missing');
let reads=0;
const discovered=Array.from({length:9},(_,i)=>({sport:i%2?'nba':'nhl',seasonId:2027,leagueId:String(i),teamId:1}));
const deps={userId:'a',now:()=>now,discover:async()=>({diag:{ok:true,prefCount:9},leagues:discovered}),roster:async(c,l)=>{reads++;return {...league,...l,season:2027,rosterState:'EMPTY',roster:[]};}};
const pages=[];let cursor=null;
do {const page=await aggregateEspn({connectionId:'generation'}, {...deps,cursor});pages.push(page);cursor=page.nextCursor;}while(cursor);
assert.equal(pages.length,3);assert.equal(reads,9);assert.deepEqual(pages.map(p=>p.assessedCount),[4,4,1]);
assert.equal(new Set(pages.flatMap(p=>p.assessments.map(a=>a.scope.leagueId))).size,9);assert.equal(pages.at(-1).complete,true);
assert.equal((await aggregateEspn({connectionId:'other'}, {...deps,cursor:pages[0].nextCursor})).paginationState,'RESTART_REQUIRED');
assert.equal((await aggregateEspn({connectionId:'generation'}, {...deps,userId:'b',cursor:pages[0].nextCursor})).paginationState,'RESTART_REQUIRED');
assert.equal((await aggregateEspn({connectionId:'generation'}, {...deps,cursor:'bad'})).paginationState,'RESTART_REQUIRED');
assert.equal((await aggregateEspn({connectionId:'generation'}, {...deps,cursor:pages[0].nextCursor,discover:async()=>({diag:{ok:true},leagues:discovered.slice(1)})})).paginationState,'RESTART_REQUIRED');
console.log('PASS: exact shared-engine parity, vacancies, upgrades/IL/waiver adapters, duplicate remedies, stale/partial/clear, dataset reuse, capability gates and multi-account pagination');
// Available fan request variants are unioned, not stopped after the first successful list.
const nativeFetch=globalThis.fetch;
try {
 const {discoverFanLeagues}=await import('../api/_lib/espnFantasy.js');let fanCalls=0;
 globalThis.fetch=async()=>({ok:true,json:async()=>({preferences:[{metaData:{entry:{abbrev:'FBA',seasonId:2027,entryId:1,groups:[{groupId:++fanCalls}]}}}]})});
 const discovered=await discoverFanLeagues({swid:'offline',espn_s2:'offline'},'all',{complete:true});
 assert.equal(fanCalls,2);assert.equal(discovered.leagues.length,2);
} finally {globalThis.fetch=nativeFetch;}
console.log('PASS: discovery combines both available provider variants');

const multipleVacancies=structuredClone(snap);
multipleVacancies.vacancies=[{slotId:0,slot:'PG',count:2}];
multipleVacancies.recommendations.suggestions.moves=[{reason:'empty_slot',in:'High',slot:'PG',gain:40}];
const fills=aggregateSnapshots([multipleVacancies],{now});
assert.equal(fills.actions.length,2,'one proposed fill must not hide another unfilled required slot');
assert.ok(fills.actions.some(a=>a.evidence.some(e=>e.kind==='slot_count'&&e.value.count===1)));
console.log('PASS: partial vacancy remedies preserve remaining empty slots');
