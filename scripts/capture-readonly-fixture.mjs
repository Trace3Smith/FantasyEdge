// Explicit operator-only authenticated GET capture. Never run as part of tests/CI.
// Load local secrets with Node --env-file=.env.local, never shell arguments.
import { mkdir, writeFile } from 'node:fs/promises';
import { discoverFanLeagues, fetchLeagueRoster, normalizeS2, normalizeSwid, isValidSwid } from '../api/_lib/espnFantasy.js';
import { sanitizeCapture } from './lib/sanitize-espn-fixture.mjs';
const sport=process.argv[2];
const nativeFetch=globalThis.fetch;
let stage="configuration";
try {
  if(!['nba','nhl'].includes(sport) || process.argv.length>4) throw new Error();
  const requestedSeason=process.argv[3]===undefined?null:Number(process.argv[3]);
  if(requestedSeason!==null && (!Number.isInteger(requestedSeason)||requestedSeason<2000||requestedSeason>2100)) throw new Error();
  const creds={espn_s2:normalizeS2(process.env.ESPN_S2||''),swid:normalizeSwid(process.env.SWID||'')};
  if(!creds.espn_s2 || !isValidSwid(creds.swid)) throw new Error();
  let fan,league;
  globalThis.fetch=async (url,options)=>{
    if(options?.method && options.method!=='GET') throw new Error();
    const host=new URL(url).hostname;
    if(!['fan.api.espn.com','lm-api-reads.fantasy.espn.com'].includes(host)) throw new Error();
    const r=await nativeFetch(url,{...options,redirect:'error'});
    if(r.ok) { const data=await r.clone().json(); if(host==='fan.api.espn.com') fan=data; else league=data; }
    return r;
  };
  stage="discovery";
  const {leagues,diag}=await discoverFanLeagues(creds,sport);
  if(!diag.ok) throw new Error();
  const discovered=leagues.sort((a,b)=>b.seasonId-a.seasonId)[0];
  const selection=discovered ? {...discovered,...(requestedSeason===null?{}:{seasonId:requestedSeason})}:null;
  if(!selection) {console.log(JSON.stringify({sport,result:'no_discovered_league'}));process.exitCode=2;}
  else {
    stage="roster";
    const parsed=await fetchLeagueRoster(creds,selection,sport); // authenticated ownership enforced
    stage="sanitization";
    const fixture=sanitizeCapture({fan,league,selection,owner:creds.swid,sport});
    fixture.provenance.discoveredSeason=discovered.seasonId;
    fixture.provenance.requestedSeason=selection.seasonId;
    const text=JSON.stringify(fixture,null,2);
    for(const secret of [creds.swid,creds.swid.replace(/[{}]/g,''),creds.espn_s2,process.env.ESPN_S2,process.env.SWID].filter(Boolean)) {
      if(text.toLowerCase().includes(secret.toLowerCase())) throw new Error();
    }
    stage="save";
    await mkdir('tmp/readonly-fixtures',{recursive:true,mode:0o700});
    await writeFile(`tmp/readonly-fixtures/${sport}-${selection.seasonId}.json`,text+'\n',{mode:0o600});
    console.log(JSON.stringify({sport,result:'sanitized_capture',season:selection.seasonId,leagues:leagues.length,
      ownershipVerified:true,rosterEntries:parsed.roster.length,scoringType:parsed.scoringType,
      slots:[...new Set(parsed.roster.map(p=>p.slotId))]}));
  }
} catch {console.error(JSON.stringify({result:'capture_stopped',stage}));process.exitCode=1;}
finally {globalThis.fetch=nativeFetch;}
