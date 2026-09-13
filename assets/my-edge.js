import { compareActions } from '../myEdgePriority.js';
const friendly=value=>String(value||'').replaceAll('_',' ');
const tools={teamManager:['fantasyedge-autopilot.html','Open Team Manager'],tradeCenter:['fantasyedge-trade-center.html','Open Trade Center'],coach:['fantasyedge-coach.html','Open Coach']};
export function mergePages(pages,now=Date.now()) {
  const actions=new Map(),assessments=new Map();
  for(const page of pages) {
    for(const action of page.actions||[]) actions.set(action.id,action);
    for(const a of page.assessments||[]) assessments.set(JSON.stringify(a.scope),a);
  }
  const fresh=[...actions.values()].filter(a=>Date.parse(a.freshness?.expiresAt)>now).sort(compareActions);
  return {actions:fresh,assessments:[...assessments.values()],attentionCount:fresh.filter(a=>a.actionable).length,
    expiredCount:actions.size-fresh.length};
}
export function mountMyEdge(doc,FE) {
  const el=id=>doc.getElementById(id);
  let pages=[],cursor=null,busy=false,generation=0;
  const node=(tag,text,cls)=>{const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
  const identity=()=>`${FE.clerk?.session?.id||''}:${FE.isSignedIn()}:${FE.isPremium()}`;
  let account=identity();
  function render() {
    const merged=mergePages(pages);
    el('actions').replaceChildren();el('assessments').replaceChildren();
    el('attention').textContent=`${merged.attentionCount} action${merged.attentionCount===1?' needs':'s need'} your attention`;
    for(const action of merged.actions) {
      const card=node('article');card.append(node('p',`${action.scope.sport.toUpperCase()} · ${action.leagueName||'League'}`,'meta'),node('h3',action.headline),node('p',action.summary));
      card.append(node('p',`Checked ${new Date(action.freshness.observedAt).toLocaleString()}${action.actionable?'':' · Information only'}`,'meta'));
      const why=node('details'),title=node('summary','Why this appeared');why.append(title);
      for(const evidence of action.evidence||[]) why.append(node('p',`${evidence.kind==='provider_status'?'ESPN status':'Team Manager check'}: ${typeof evidence.value==='object'?`${evidence.value.count??''} ${evidence.value.slot??''} slot(s)`:friendly(evidence.value)}`));
      card.append(why);
      const links=node('div',undefined,'links');
      for(const target of [tools[action.destination?.tool]||tools.teamManager,tools.coach]) {const a=node('a',target[1]);a.href=target[0];links.append(a);}
      card.append(links);el('actions').append(card);
    }
    for(const assessment of merged.assessments) {
      const card=node('article');card.append(node('h3',`${assessment.scope.sport.toUpperCase()} · ${assessment.leagueName||'League'}`));
      const stale=assessment.observedAt && Date.now()-Date.parse(assessment.observedAt)>300000;
      card.append(node('p',stale?'This assessment is out of date. Refresh to check again.':assessment.summary||friendly(assessment.reason||assessment.status)));
      card.append(node('p',`Checks: ${(assessment.checkedSignals||[]).map(friendly).join(', ')||'not completed'}`,'meta'));
      card.append(node('p',`Not assessed: ${[...(assessment.unsupportedSignals||[]),...(assessment.unsupportedFields||[])].map(friendly).join(', ')||'none in this scope'}`,'meta'));
      if(assessment.recommendationReason) card.append(node('p',`Recommendation coverage: ${friendly(assessment.recommendationReason)}`,'meta'));
      el('assessments').append(card);
    }
    if(merged.expiredCount) el('status').textContent='Some actions expired and were hidden. Refresh for current advice.';
    el('more').hidden=!cursor;el('more').disabled=busy;
  }
  async function load(reset=false) {
    if(busy)return;
    if(reset){pages=[];cursor=null;generation++;render();}
    if(!FE.isSignedIn()||!FE.isPremium()) {
      el('status').textContent=FE.isSignedIn()?'Premium is required for connected-league advice.':'Sign in to view your connected leagues.';
      el('account').textContent=FE.isSignedIn()?'View Premium':'Sign in';el('account').hidden=false;return;
    }
    el('account').hidden=true;busy=true;el('refresh').disabled=true;el('more').disabled=true;
    const requestGeneration=generation,requestAccount=identity();
    el('status').textContent='Checking connected leagues…';
    try {
      const result=await FE.apiPost('/api/espn',{action:'myEdge',...(cursor?{cursor}:{})});
      if(requestGeneration!==generation || requestAccount!==identity())return;
      if(!result.ok)throw new Error();
      const page=result.data;
      if(page.paginationState==='RESTART_REQUIRED'){pages=[];cursor=null;el('status').textContent='Your league list changed. Refresh to start again.';render();return;}
      if(page.connectionState==='DISCONNECTED'||page.connectionState==='RECONNECT_REQUIRED') {
        pages=[];cursor=null;render();el('status').textContent='Connect or reconnect ESPN in Team Manager to continue.';return;
      }
      if(page.connectionState==='UNAVAILABLE')throw new Error();
      pages.push(page);cursor=page.nextCursor||null;
      el('status').textContent=`Loaded ${mergePages(pages).assessments.length} of ${page.discoveredCount||0} discovered leagues.${cursor?' Load more to continue.':''}${page.discoveryCoverage==='PARTIAL'?' Provider discovery was incomplete; refresh to retry.':''}`;
      render();
    } catch {if(requestGeneration===generation)el('status').textContent='Could not finish checking leagues. Refresh to retry; previous results may be out of date.';}
    finally {if(requestGeneration===generation){busy=false;el('refresh').disabled=false;el('more').disabled=false;}}
  }
  el('refresh').disabled=false;el('refresh').addEventListener('click',()=>load(true));
  el('more').addEventListener('click',()=>load(false));
  el('account').addEventListener('click',()=>FE.isSignedIn()?FE.openPricing():FE.openSignIn());
  FE.clerk?.addListener(()=>{const next=identity();if(next!==account){account=next;generation++;pages=[];cursor=null;busy=false;render();void load(true);}});
  const ready=load(true);
  const timer=setInterval(render,30000);timer.unref?.();
  return {ready,load,render,dispose:()=>clearInterval(timer)};
}
if(typeof document!=='undefined') {
  const start=()=>{if(window.FE)mountMyEdge(document,window.FE);};
  if(window.FE)start();else document.addEventListener('fe-auth-ready',start,{once:true});
}
