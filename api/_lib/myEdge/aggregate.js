// Provider-neutral Advisor foundation. No credentials, persistence, valuation or transactions.
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const band = { HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };
// Prioritization orders evidence, never recomputes fantasy player value.
export function compareActions(a,b) {
  return (band[b.urgency.level]-band[a.urgency.level]) || (band[b.impact.level]-band[a.impact.level])
    || (band[b.confidence.level]-band[a.confidence.level]) || a.id.localeCompare(b.id);
}
export function aggregateSnapshots(snapshots, { now = Date.now() } = {}) {
  const actions = new Map(), assessments=[];
  const generatedAt = new Date(now).toISOString();
  for(const snapshot of snapshots) {
    const {scope,league,observedAt,capabilities=[],error}=snapshot;
    const assessment={scope,status:'PARTIAL',checkedSignals:[],unsupportedSignals:['lineup_upgrades','waivers','trades','lock_urgency'],capabilities,observedAt:observedAt||null};
    assessments.push(assessment);
    if(error || !league) {assessment.status='UNAVAILABLE';assessment.reason='provider_read_failed';continue;}
    assessment.checkedSignals=['authenticated_roster'];
    const age=now-Date.parse(observedAt);
    if(!Number.isFinite(age)||age<0||age>300000) {assessment.status='STALE';continue;}
    if(league.rosterState==='EMPTY') {
      assessment.status='EMPTY_ROSTER';assessment.summary='Your league is connected. No players are rostered yet.';
      continue; // Normal pre-draft state: not a broken league or an empty-slot alert.
    }
    if(league.rosterState!=='POPULATED' || !Array.isArray(league.roster)) {assessment.reason='roster_unavailable';continue;}
    if(!capabilities.includes('READ_ONLY')) {assessment.status='UNSUPPORTED';continue;}
    if(league.roster.some(p=>!p.slotKnown || p.starter===null)) {assessment.reason='slot_mapping_unsupported';continue;}
    assessment.checkedSignals.push('starter_availability');
    const starters=league.roster.filter(p=>p.starter);
    let uncertain=starters.some(p=>p.id == null || !p.injuryStatusKnown || !['AVAILABLE','UNAVAILABLE'].includes(p.availability));
    let found=0;
    for(const p of starters) {
      if(p.id == null || !p.injuryStatusKnown || p.availability!=='UNAVAILABLE') continue;
      found++;
      const id=hash([scope.platform,scope.sport,scope.season,scope.leagueId,scope.teamId,'STARTER_UNAVAILABLE',p.id]);
      const action={schemaVersion:1,id,scope,type:'STARTER_UNAVAILABLE',leagueName:league.leagueName,
        subjects:[{providerPlayerId:String(p.id),name:p.name}],headline:'A starter is listed unavailable',
        summary:p.locked ? `${p.name} is listed ${p.injuryStatus}; the provider reports this player locked.` : `${p.name} is listed ${p.injuryStatus}. Review your lineup.`,
        evidence:[{kind:'provider_status',value:p.injuryStatus,source:'authenticated_roster',observedAt}],
        urgency:{level:'UNKNOWN',deadlineAt:null,basis:'schedule_not_assessed'},
        impact:{level:'HIGH',kind:'starter_availability',value:null},confidence:{level:'HIGH',basis:'provider_report'},
        actionable:!p.locked,apply:{capability:'READ_ONLY'},
        destination:{tool:'teamManager',scope},generatedAt,
        freshness:{observedAt,expiresAt:new Date(Date.parse(observedAt)+300000).toISOString()}};
      actions.set(id,action);
    }
    assessment.status=found?'ACTIONS':uncertain?'PARTIAL':'ALL_CLEAR';
    assessment.clearScope='starter_availability';
    assessment.summary=found?'Review reported unavailable starters.':uncertain?'Some starter availability is unknown.':'No unavailable starters reported. Other lineup opportunities have not been assessed.';
  }
  const ordered=[...actions.values()].sort(compareActions);
  return {schemaVersion:1,mode:'ADVISOR',generatedAt,actions:ordered,attentionCount:ordered.filter(a=>a.actionable).length,assessments};
}
