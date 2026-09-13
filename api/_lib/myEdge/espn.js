import { discoverFanLeagues, fetchLeagueRoster, EspnAuthError } from '../espnFantasy.js';
import { leagueCapabilities } from '../../../leagueCapabilities.js';
import { aggregateSnapshots } from './aggregate.js';
// Authenticated caller supplies credentials in memory; they never enter snapshots or responses.
// One discovery + at most four roster reads; no browser-supplied ownership identifiers.
export async function aggregateEspn(creds, { discover=discoverFanLeagues, roster=fetchLeagueRoster, now=Date.now } = {}) {
  let discovery;
  try { discovery=await discover(creds,'all'); }
  catch (error) { return {...aggregateSnapshots([],{now:now()}),connectionState:error instanceof EspnAuthError?'RECONNECT_REQUIRED':'UNAVAILABLE',complete:false}; }
  if(!discovery.diag.ok) return {...aggregateSnapshots([],{now:now()}),connectionState:'UNAVAILABLE',complete:false};
  const unique=[...new Map(discovery.leagues.map(l=>[JSON.stringify([l.sport,l.seasonId,l.leagueId,l.teamId]),l])).values()];
  const selected=unique.slice(0,4);
  const snapshots=await Promise.all(selected.map(async l=>{
    const scope={platform:'espn',sport:l.sport,season:l.seasonId,leagueId:String(l.leagueId),teamId:String(l.teamId)};
    const capabilities=leagueCapabilities(l.sport).capabilities;
    try {return {scope,capabilities,league:await roster(creds,l,l.sport),observedAt:new Date(now()).toISOString()};}
    catch {return {scope,capabilities,error:'provider_read_failed'};}
  }));
  return {...aggregateSnapshots(snapshots,{now:now()}),connectionState:unique.length?'CONNECTED':discovery.diag.prefCount?'NO_LEAGUES':'RECONNECT_REQUIRED',
    complete:unique.length<=4,discoveredCount:unique.length,assessedCount:snapshots.length};
}
