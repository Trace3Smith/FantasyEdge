// Allowlist projection: raw responses and real owner identifiers never reach disk.
export function sanitizeCapture({ fan, league, selection, owner, sport }) {
  const ids = new Map([[owner.toLowerCase(), '{00000000-0000-0000-0000-000000000001}']]);
  const pseudonym = id => {
    const k=String(id).toLowerCase();
    if(!ids.has(k)) ids.set(k,`{00000000-0000-0000-0000-${String(ids.size+1).padStart(12,'0')}}`);
    return ids.get(k);
  };
  const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
  // Provider numeric/boolean rules retained recursively; unreviewed strings omitted.
  const numeric = v => {
    if(v===null || typeof v==='number' || typeof v==='boolean') return v;
    if(Array.isArray(v)) return v.map(numeric).filter(x=>x!==undefined);
    if(v && typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,numeric(x)]).filter(([,x])=>x!==undefined));
  };
  const entries = en => ({...numeric(pick(en,['lineupSlotId','lineupLocked','injuryStatus','status','acquisitionType'])),
    playerPoolEntry:{...numeric(pick(en.playerPoolEntry,['id','lineupLocked','rosterLocked','status'])),
      player:{...numeric(pick(en.playerPoolEntry?.player || en.player,['id','defaultPositionId','proTeamId','eligibleSlots','injured'])),
        ...pick(en.playerPoolEntry?.player || en.player,['fullName','injuryStatus'])}}});
  const abbrev=sport==='nba'?'FBA':'FHL';
  const prefs=(fan.preferences||[]).filter(p=>{
    const e=p.metaData?.entry; const a=e?.abbrev||e?.gameAbbrev||e?.gameKey||p.type?.abbrev||p.metaData?.abbrev;
    return String(a).toUpperCase()===abbrev;
  }).map(p=>({type:pick(p.type,['abbrev']),metaData:{...pick(p.metaData,['abbrev']),entry:{
    ...pick(p.metaData.entry,['abbrev','gameAbbrev','gameKey','seasonId','entryId','teamId','groupId','leagueId']),
    ...(p.metaData.entry.groups ? {groups:p.metaData.entry.groups.map(g=>pick(g,['groupId','groupManagerTeamId']))}: {})}}}));
  return {provenance:{source:'authenticated ESPN GET',capturedAt:new Date().toISOString(),sport,
    omissions:'User/profile fields and unreviewed settings strings omitted; owners pseudonymized; player public names retained.'},
    owner:ids.get(owner.toLowerCase()),selection:pick(selection,['sport','leagueId','seasonId','teamId']),fan:{preferences:prefs},
    league:{...numeric(pick(league,['id','seasonId','scoringPeriodId','status'])),settings:{
      ...numeric(pick(league.settings,['size','rosterSettings','scoringSettings'])),
      scoringSettings:{...numeric(league.settings?.scoringSettings),...pick(league.settings?.scoringSettings,['scoringType'])}},
      teams:(league.teams||[]).map(t=>({...pick(t,['id']),
        ...(t.primaryOwner?{primaryOwner:pseudonym(t.primaryOwner)}:{}),
        ...(t.owners?{owners:t.owners.map(pseudonym)}:{}),
        ...(String(t.id)===String(selection.teamId)?{roster:{entries:(t.roster?.entries||[]).map(entries)}}:{})}))}};
}
