import { lineupVacancies } from '../lineupAdvisor.js';
import { createHash } from 'node:crypto';
import { discoverFanLeagues, fetchLeagueRoster, fetchLeagueByOwner, EspnAuthError } from '../espnFantasy.js';
import { leagueCapabilities } from '../../../leagueCapabilities.js';
import { aggregateSnapshots } from './aggregate.js';
// Authenticated caller supplies credentials in memory; they never enter snapshots or responses.
// One discovery + at most four roster reads; no browser-supplied ownership identifiers.
export async function aggregateEspn(creds, { discover=discoverFanLeagues, roster=fetchLeagueRoster, now=Date.now, cursor=null, userId='', enrich=null, manual=[], manualUnavailable=false, ownerRoster=fetchLeagueByOwner } = {}) {
  let discovery;
  try { discovery=await discover(creds,'all',{complete:true}); }
  catch (error) { if(error instanceof EspnAuthError)return {...aggregateSnapshots([],{now:now()}),connectionState:'RECONNECT_REQUIRED',complete:false}; discovery={leagues:[],diag:{ok:false,error:'discovery_failed'}}; }
  if(!discovery.diag.ok && !manual.length) return {...aggregateSnapshots([],{now:now()}),connectionState:'UNAVAILABLE',complete:false};
  const unique=[...new Map(discovery.leagues.map(l=>[JSON.stringify([l.sport,l.seasonId,l.leagueId,l.teamId]),l])).values()];
  let archivedManualCount=0;
  for(const ref of manual) {
    if(!ref || typeof ref!=='object')continue;
    const sport=ref.sport||'mlb',seasonId=Number(ref.season);
    if(sport!=='mlb'||!/^[1-9]\d{0,11}$/.test(String(ref.leagueId))||!Number.isInteger(seasonId)||seasonId<2000||seasonId>2100)continue;
    if(seasonId<new Date(now()).getUTCFullYear()){archivedManualCount++;continue;}
    if(!unique.some(l=>l.sport===sport&&Number(l.seasonId)===seasonId&&String(l.leagueId)===String(ref.leagueId)))
      unique.push({sport,seasonId,leagueId:String(ref.leagueId),teamId:null,manual:true});
  }
  let excludedManualCount=0;
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
      const league=l.manual?await ownerRoster(creds,l,l.sport):await roster(creds,l,l.sport),observedAt=new Date(now()).toISOString();
      if(l.manual){if(league.teamId==null)throw new Error();scope.teamId=String(league.teamId);}
      let recommendations=null;
      if(enrich) {try {recommendations=await enrich(league);} catch {recommendations={status:'PARTIAL',reason:'recommendation_source_unavailable'};}}
      return {scope,capabilities,league,observedAt,connectionSource:l.manual?'manual':'discovered',recommendations,vacancies:lineupVacancies(league,l.sport)};
    }
    catch {if(l.manual){excludedManualCount++;return null;}return {scope,capabilities,error:'provider_read_failed'};}
  }));
  return {...aggregateSnapshots(snapshots.filter(Boolean),{now:now()}),connectionState:unique.length?'CONNECTED':discovery.diag.prefCount?'NO_LEAGUES':'RECONNECT_REQUIRED',
    excludedManualCount,archivedManualCount,manualCoverage:manualUnavailable?'UNAVAILABLE':'LOADED',complete:offset+4>=unique.length,discoveryCoverage:discovery.diag.error?'PARTIAL':'AVAILABLE_VARIANTS',
    nextCursor:offset+4<unique.length?Buffer.from(JSON.stringify({offset:offset+4,revision})).toString('base64url'):null,
    pageOffset:offset,discoveredCount:unique.length,assessedCount:snapshots.filter(Boolean).length};
}
