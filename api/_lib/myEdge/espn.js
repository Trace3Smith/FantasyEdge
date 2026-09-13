import { lineupVacancies } from '../lineupAdvisor.js';
import { createHash } from 'node:crypto';
import { discoverFanLeagues, fetchLeagueRoster, EspnAuthError } from '../espnFantasy.js';
import { leagueCapabilities } from '../../../leagueCapabilities.js';
import { aggregateSnapshots } from './aggregate.js';
// Authenticated caller supplies credentials in memory; they never enter snapshots or responses.
// One discovery + at most four roster reads; no browser-supplied ownership identifiers.
export async function aggregateEspn(creds, { discover=discoverFanLeagues, roster=fetchLeagueRoster, now=Date.now, cursor=null, userId='', enrich=null } = {}) {
  let discovery;
  try { discovery=await discover(creds,'all',{complete:true}); }
  catch (error) { return {...aggregateSnapshots([],{now:now()}),connectionState:error instanceof EspnAuthError?'RECONNECT_REQUIRED':'UNAVAILABLE',complete:false}; }
  if(!discovery.diag.ok) return {...aggregateSnapshots([],{now:now()}),connectionState:'UNAVAILABLE',complete:false};
  const unique=[...new Map(discovery.leagues.map(l=>[JSON.stringify([l.sport,l.seasonId,l.leagueId,l.teamId]),l])).values()];
  unique.sort((a,b)=>JSON.stringify([a.sport,a.seasonId,a.leagueId,a.teamId]).localeCompare(JSON.stringify([b.sport,b.seasonId,b.leagueId,b.teamId])));
  const revision=createHash('sha256').update(JSON.stringify([userId,creds.connectionId||creds.swid,unique.map(l=>[l.sport,l.seasonId,l.leagueId,l.teamId])])).digest('hex');
  let offset=0;
  if(cursor!==null) {
    try {
      if(typeof cursor!=='string'||cursor.length>512) throw new Error();
      const token=JSON.parse(Buffer.from(cursor,'base64url').toString());
      if(token.revision!==revision || !Number.isInteger(token.offset)||token.offset<0||token.offset>=unique.length) throw new Error();
      offset=token.offset;
    } catch {return {...aggregateSnapshots([],{now:now()}),connectionState:'CONNECTED',paginationState:'RESTART_REQUIRED',complete:false,nextCursor:null};}
  }
  const selected=unique.slice(offset,offset+4);
  const snapshots=await Promise.all(selected.map(async l=>{
    const scope={platform:'espn',sport:l.sport,season:l.seasonId,leagueId:String(l.leagueId),teamId:String(l.teamId)};
    const capabilities=leagueCapabilities(l.sport).capabilities;
    try {
      const league=await roster(creds,l,l.sport),observedAt=new Date(now()).toISOString();
      let recommendations=null;
      if(enrich) {try {recommendations=await enrich(league);} catch {recommendations={status:'PARTIAL',reason:'recommendation_source_unavailable'};}}
      return {scope,capabilities,league,observedAt,recommendations,vacancies:lineupVacancies(league,l.sport)};
    }
    catch {return {scope,capabilities,error:'provider_read_failed'};}
  }));
  return {...aggregateSnapshots(snapshots,{now:now()}),connectionState:unique.length?'CONNECTED':discovery.diag.prefCount?'NO_LEAGUES':'RECONNECT_REQUIRED',
    complete:offset+4>=unique.length,discoveryCoverage:discovery.diag.error?'PARTIAL':'AVAILABLE_VARIANTS',
    nextCursor:offset+4<unique.length?Buffer.from(JSON.stringify({offset:offset+4,revision})).toString('base64url'):null,
    pageOffset:offset,discoveredCount:unique.length,assessedCount:snapshots.length};
}
