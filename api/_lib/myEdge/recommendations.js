import { ENGINE_SPORTS } from '../../../leagueCapabilities.js';
import { createRecommendationContext } from '../recommendationSnapshot.js';
import { parseScoringSettings } from '../espnScoring.js';
import { fetchFreeAgents, fetchNflByes } from '../espnFantasy.js';
import { DATASET_KEY, WNBA_DATASET_KEY, NFL_DATASET_KEY } from '../kv.js';
const keys={mlb:DATASET_KEY,wnba:WNBA_DATASET_KEY,nfl:NFL_DATASET_KEY};
export function createRecommendationLoader(redis,creds,{now=Date.now,freeAgents=fetchFreeAgents,byes=fetchNflByes}={}) {
  const contexts=new Map(), byeCache=new Map();
  return async league=>{
    const sport=league.sport;
    if(!ENGINE_SPORTS.has(sport)) return {status:'READ_ONLY',reason:'recommendation_engine_not_validated'};
    if(league.rosterState!=='POPULATED') return {status:'READ_ONLY',reason:'no_populated_roster'};
    if(league.roster.some(p=>!p.slotKnown||!p.injuryStatusKnown||!p.lockStatusKnown)) return {status:'PARTIAL',reason:'provider_fields_unknown'};
    const scoring=parseScoringSettings(league.scoringRaw,sport);
    const items=league.scoringRaw?.scoringItems||[];
    const statCount=new Set(items.map(i=>i.statId)).size;
    if(!scoring || scoring.unrecognized || !scoring.cats.length || scoring.cats.length!==statCount
      || (sport==='mlb'?scoring.format!=='category':scoring.format!=='points')
      || items.some(i=>i.pointsOverrides)) return {status:'PARTIAL',reason:'scoring_coverage_incomplete'};
    if(!contexts.has(sport)) contexts.set(sport,redis.get(keys[sport]).then(dataset=>({dataset,recommend:createRecommendationContext(dataset,sport)})));
    const {dataset,recommend}=await contexts.get(sport);
    const age=now()-Date.parse(dataset?.builtAt);
    if(!Number.isFinite(age)||age<0||age>30*3600000||!dataset?.players?.length) return {status:'PARTIAL',reason:'valuation_stale_or_missing'};
    let byeWeeks=null;
    if(sport==='nfl') {
      if(!byeCache.has(league.season)) byeCache.set(league.season,byes(Number(league.season)).catch(()=>null));
      byeWeeks=await byeCache.get(league.season);
      if(!byeWeeks) return {status:'PARTIAL',reason:'bye_coverage_missing'};
    }
    let pool=[],waiversAvailable=false;
    try {pool=await freeAgents(creds,{leagueId:league.leagueId,seasonId:league.season,limit:40},sport);waiversAvailable=true;} catch { /* partial waiver coverage */ }
    const snapshot=recommend(league,{freeAgents:pool,byeWeeks});
    if(!snapshot.identityCoverage) return {status:'PARTIAL',reason:'valuation_identity_incomplete'};
    return {...snapshot,status:'RECOMMENDATIONS',waiversAvailable,waiverCoverage:'up_to_40_candidates',observedAt:new Date(now()).toISOString()};
  };
}
