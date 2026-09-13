// Provider-neutral Advisor foundation. No credentials, persistence, valuation or transactions.
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
import { compareActions } from '../../../myEdgePriority.js';
export { compareActions };
export function aggregateSnapshots(snapshots, { now = Date.now() } = {}) {
  const actions = new Map(), assessments=[];
  const generatedAt = new Date(now).toISOString();
  for(const snapshot of snapshots) {
    const {scope,league,observedAt,capabilities=[],error,recommendations,vacancies}=snapshot;
    const assessment={scope,leagueName:league?.leagueName||`League ${scope.leagueId}`,unsupportedFields:scope.sport==='nhl'?['lineup_slot_roles','reserve_roles','scoring_category_labels']:[],recommendationSupport:'READ_ONLY',status:'PARTIAL',checkedSignals:[],unsupportedSignals:['lineup_upgrades','waivers','trades','lock_urgency'],capabilities,observedAt:observedAt||null};
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
    if(league.roster.some(p=>!p.slotKnown || p.starter===null)) {assessment.reason='slot_mapping_unsupported';assessment.unsupportedFields=['lineup_slot_roles','reserve_roles',...(scope.sport==='nhl'?['scoring_category_labels']:[])];continue;}
    assessment.checkedSignals.push('starter_availability');
    assessment.recommendationSupport=recommendations?.status||'READ_ONLY';
    assessment.recommendationReason=recommendations?.reason||null;
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
    const recAge=now-Date.parse(recommendations?.valuesAt);
    const recFresh=recommendations?.status==='RECOMMENDATIONS' && Number.isFinite(recAge) && recAge>=0 && recAge<=30*3600000;
    const moves=recFresh ? recommendations.suggestions?.moves||[] : [];
    if(recFresh) {
      assessment.checkedSignals.push('lineup_upgrades','il_ir');
      assessment.unsupportedSignals=assessment.unsupportedSignals.filter(s=>s!=='lineup_upgrades' && (s!=='waivers'||!recommendations.waiversAvailable));
      if(recommendations.waiversAvailable) assessment.checkedSignals.push('waivers_candidate_pool');
    } else if(recommendations?.status==='RECOMMENDATIONS') {
      assessment.recommendationSupport='PARTIAL';assessment.recommendationReason='valuation_stale_or_missing';
    }
    const scopeKey=[scope.platform,scope.sport,scope.season,scope.leagueId,scope.teamId];
    const addCard=(type,subject,headline,summary,evidence,extra={})=>{
      const id=hash([...scopeKey,type,subject]);
      actions.set(id,{schemaVersion:1,id,scope,type,leagueName:league.leagueName,subjects:[],headline,summary,evidence,
        urgency:{level:'UNKNOWN',deadlineAt:null,basis:'schedule_not_assessed'},impact:{level:'HIGH',kind:type,value:null},
        confidence:{level:'HIGH',basis:'shared_source'},actionable:true,apply:{capability:'READ_ONLY'},
        destination:{tool:'teamManager',scope},generatedAt,freshness:{observedAt,valuesAt:recFresh?recommendations.valuesAt:null,expiresAt:new Date(Date.parse(observedAt)+300000).toISOString()},...extra});
      return id;
    };
    for(const m of moves) {
      const type=m.reason==='waiver'?'WAIVER_OPPORTUNITY':m.reason==='empty_slot'?'EMPTY_SLOT':
        ['value','injury'].includes(m.reason)?'LINEUP_UPGRADE':m.reason==='il'?'IL_IR_ACTION':null;
      if(!type || (type==='WAIVER_OPPORTUNITY'&&!recommendations.waiversAvailable)) continue;
      const targets=league.roster.filter(p=>p.name===m.out);
      const prior=targets.length===1 ? actions.get(hash([...scopeKey,'STARTER_UNAVAILABLE',targets[0].id])) : null;
      if(prior && !prior.actionable) continue;
      if(prior) actions.delete(prior.id);
      const summary=m.reason==='il' ? `Review ${m.action==='to_il'?'moving to reserve':'activating'} ${m.out||m.in||'the player'}.` :m.in ? `Start ${m.in}${m.out?` over ${m.out}`:''}${m.slot?` at ${m.slot}`:''}.`
        :m.add ? `Review adding ${m.add}${m.drop?` for ${m.drop}`:''}.`
        :`Review ${m.action==='to_il'?'moving to reserve':'activating'} ${m.out||m.in||'the player'}.`;
      addCard(type,[m.reason,m.in,m.out,m.add,m.drop,m.slot,m.action],'Team Manager recommendation',summary,
        [...(prior?.evidence||[]),{kind:'shared_recommendation',source:'lineupAdvisor',value:m.reason,observedAt}],
        {recommendation:{source:'lineupAdvisor',move:m},confidence:{level:type==='WAIVER_OPPORTUNITY'?'MEDIUM':'HIGH',basis:type==='WAIVER_OPPORTUNITY'?'limited_candidate_pool':'shared_engine'},
          impact:{level:'HIGH',kind:'source_gain',value:Number.isFinite(m.gain)?m.gain:null}});
      found++;
    }
    if(Array.isArray(vacancies)) {
      assessment.checkedSignals.push('empty_required_slots');
      for(const v of vacancies) {
        const proposed=moves.filter(m=>m.reason==='empty_slot'&&m.slot===v.slot).length;
        const remaining=v.count-proposed;
        if(remaining<=0) continue;
        addCard('EMPTY_SLOT',v.slotId,'A required lineup slot is empty',`${remaining} ${v.slot} slot(s) ${proposed?'remain empty after the proposed fills':'are empty'}. Review your lineup.`,[{kind:'slot_count',source:'lineupAdvisor.activeOpenings',value:{...v,count:remaining},observedAt}]);found++;
      }
    } else {assessment.unsupportedSignals.push('empty_required_slots');}
    const unresolvedMoves=moves.some(m=>!['value','injury','empty_slot','il','waiver'].includes(m.reason));
    if(recommendations?.status==='PARTIAL' || (recommendations?.status==='RECOMMENDATIONS'&&!recFresh)) uncertain=true;
    if(unresolvedMoves) {assessment.unsupportedSignals.push('additional_roster_advice');uncertain=true;}
    assessment.status=found?'ACTIONS':uncertain?'PARTIAL':'ALL_CLEAR';
    assessment.clearScope=recFresh?'checked_signals':'starter_availability';
    assessment.summary=found?'Review the reported lineup issues and recommendations.':uncertain?'Some checks are incomplete.':recFresh?'No meaningful action found in the completed checks. See coverage for unassessed areas.':'No unavailable starters reported. Other lineup opportunities have not been assessed.';
  }
  const ordered=[...actions.values()].sort(compareActions);
  return {schemaVersion:1,mode:'ADVISOR',generatedAt,actions:ordered,attentionCount:ordered.filter(a=>a.actionable).length,assessments};
}
