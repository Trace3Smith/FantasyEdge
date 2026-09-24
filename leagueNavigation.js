// Navigation intent only. A valid shape never substitutes for server-side provider ownership.
const sports=new Set(['mlb','nfl','nba','nhl','wnba']);
const integer=v=>/^[1-9]\d{0,11}$/.test(String(v??''));
export function leagueTarget(value) {
 if(!value || value.platform!=='espn' || !sports.has(value.sport) || !integer(value.leagueId)||!integer(value.teamId)) return null;
 const season=Number(value.season);
 if(!Number.isInteger(season)||season<2000||season>2100) return null;
 return {platform:'espn',sport:value.sport,season,leagueId:String(value.leagueId),teamId:String(value.teamId)};
}
export function targetFromSearch(search) {
 const p=new URLSearchParams(search),keys=['platform','sport','season','leagueId','teamId'];
 if(!keys.some(k=>p.has(k)))return {target:null,error:false};
 if(keys.some(k=>p.getAll(k).length!==1))return {target:null,error:true};
 const target=leagueTarget(Object.fromEntries(keys.map(k=>[k,p.get(k)])));
 return {target,error:!target};
}
export function leagueMatches(league,target,sport=league.sport) {
 return !!target && sport===target.sport && Number(league.season)===target.season && String(league.leagueId)===target.leagueId
  && String(league.teamId??league.team?.id)===target.teamId;
}
export function toolLink(tool,scope) {
 const routes={teamManager:'fantasyedge-autopilot.html',tradeCenter:'fantasyedge-trade-center.html',coach:'fantasyedge-coach.html'};
 const route=routes[tool]||routes.teamManager,target=leagueTarget(scope);
 return target?`${route}?${new URLSearchParams(target)}`:route;
}
