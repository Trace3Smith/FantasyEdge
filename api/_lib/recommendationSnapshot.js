// The same deterministic recommendation call serves Team Manager and My Edge.
import { buildValueIndex, suggestLineup } from './lineupAdvisor.js';
import { parseScoringSettings, categoryRanks } from './espnScoring.js';
import { normName } from './golf.js';
export function createRecommendationContext(dataset, sport) {
  const players=(dataset?.players||[]).filter(p=>!p.searchOnly);
  const indexes=new Map();
  return (league,{freeAgents=[],byeWeeks=null,ilWindowClosed}={})=>{
    const scoring=parseScoringSettings(league.scoringRaw,sport);
    const weights=scoring?.weights||null, signature=JSON.stringify(weights);
    if(!indexes.has(signature)) indexes.set(signature,buildValueIndex(players,sport,weights));
    const index=indexes.get(signature);
    return {source:'lineupAdvisor',valuesAt:dataset?.builtAt||null,scoring,
      identityCoverage:new Set(league.roster.map(p=>normName(p.name))).size===league.roster.length && league.roster.every(p=>index.has(normName(p.name))),
      suggestions:suggestLineup(league,index,sport,{freeAgents,cats:scoring?.cats||null,
        ranks:categoryRanks(league.standings,league.teamId,sport),byeWeeks,
        ...(ilWindowClosed===undefined?{}:{ilWindowClosed})})};
  };
}
