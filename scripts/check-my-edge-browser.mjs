// Real Chromium + local HTTP + actual aggregator, controlled auth/provider fixtures.
// No production keys, Clerk login, provider calls or application transactions.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile,mkdir } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
const { chromium } = await import(process.env.FE_PLAYWRIGHT_MODULE || 'playwright');
import { fetchLeagueRoster } from '../api/_lib/espnFantasy.js';
import { toolLink, leagueTarget, leagueMatches } from '../leagueNavigation.js';
import { mergePages } from '../assets/my-edge.js';
import { aggregateEspn } from '../api/_lib/myEdge/espn.js';
import { checkTeamManagerBrowser } from './lib/check-team-manager-browser.mjs';
const root=resolve('.'),originalFetch=globalThis.fetch,leagues=[];
try {
 for(const [sport,season] of [['nba',2026],['nba',2027],['nhl',2026]]) {
  const f=JSON.parse(await readFile(`scripts/fixtures/readonly-rosters/${sport}-${season}.json`));
  globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(f.league)});
  leagues.push(await fetchLeagueRoster({swid:f.owner,espn_s2:'synthetic'},f.selection,sport));
 }
} finally {globalThis.fetch=originalFetch;}
const auth=`window.testAccount='premium';window.testScenario='normal';let listener;
window.FE={clerk:{session:{id:'test'},addListener:f=>listener=f},isSignedIn:()=>testAccount!=='signedout',isPremium:()=>testAccount==='premium',openSignIn:()=>{},openPricing:()=>{},
apiPost:async(path,body)=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Scenario':testScenario},body:JSON.stringify(body)});const data=await r.json();window.testLastResponse=data;return {ok:r.ok,status:r.status,data};}};
window.testChangeAccount=a=>{testAccount=a;listener?.();};document.dispatchEvent(new Event('fe-auth-ready'));`;
const requests=[];
const server=createServer(async(req,res)=>{
 try {
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/auth.js'){res.setHeader('Content-Type','text/javascript');res.end(auth);return;}
  if(path==='/api/espn') {
   let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);requests.push(input);
   const scenario=req.headers['x-test-scenario']||'normal';
   if(scenario==='loading')await new Promise(r=>setTimeout(r,700));
   const source=Array.from({length:scenario==='empty'?0:8},(_,i)=>{
    const l=structuredClone(leagues[i%3]);l.leagueId=String(100+i);l.leagueName=`Test ${l.sport.toUpperCase()} ${String.fromCharCode(65+i)}`;
    if(scenario==='clear'){l.roster=structuredClone(leagues[0].roster);l.sport='nba';l.rosterState='POPULATED';l.roster.forEach(p=>{p.injuryStatus='ACTIVE';p.availability='AVAILABLE';});}
    return l;
   });
   let result;
   if(input.action==='myEdge')result=await aggregateEspn({connectionId:'test'}, {userId:'test',cursor:input.cursor||null,
    discover:async()=>({diag:{ok:true,prefCount:Math.max(1,source.length),error:scenario==='partial'?'fixture_failure':null},leagues:source.map(l=>({...l,seasonId:l.season}))}),
    roster:async(c,l)=>source.find(s=>s.leagueId===l.leagueId)});
   else if(input.action==='status')result={connected:true,previewReadOnly:false,dnaNotice:{version:2,acknowledged:true,include:false}};
   else if(input.action==='leagues') {
    const target=input.target?leagueTarget(input.target):null;
    if(input.target&&!target){res.statusCode=400;result={error:'invalid_target'};}
    else {const found=source.filter(l=>l.sport===input.sport&&(!target||leagueMatches(l,target)));result={leagues:found,state:'ok'};}
   } else if(input.action==='leagueContext') {
    const target=leagueTarget(input.target),l=target&&source.find(l=>leagueMatches(l,target));
    if(!l){res.statusCode=403;result={error:'not_owned'};}
    else result={scope:target,leagueName:l.leagueName,teamName:l.team.name,scoringType:l.scoringType,observedAt:new Date().toISOString(),roster:l.roster.map(p=>({name:p.name,position:p.pos,slot:p.slotKnown?p.slot:'Unverified slot',availability:p.availability}))};
   }
   else {res.statusCode=400;result={error:'test_disallows_action'};}
   if(scenario==='stale') {for(const a of result.actions||[])a.freshness.expiresAt=new Date(0).toISOString();for(const a of result.assessments||[])a.observedAt=new Date(0).toISOString();}
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));return;
  }
  const file=resolve(root,'.'+decodeURIComponent(path));
  if(!file.startsWith(root+'/')||path.split('/').some(s=>s.startsWith('.'))||!['.html','.js','.css'].includes(extname(file))){res.statusCode=404;res.end();return;}
  res.setHeader('Content-Type',extname(file)==='.js'?'text/javascript':extname(file)==='.css'?'text/css':'text/html');res.end(await readFile(file));
 } catch {res.statusCode=500;res.end('Local test failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 await mkdir('/tmp/fe-my-edge-browser',{recursive:true});
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://**',route=>route.fulfill({status:200,body:''}));
  await page.goto(base+'/fantasyedge-my-edge.html');await page.waitForSelector('#assessments article');
  const first=await page.evaluate(()=>testLastResponse);
  await page.screenshot({path:`/tmp/fe-my-edge-browser/${viewport.width}.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  assert.match(await page.locator('#assessments').innerText(),/No players|rostered yet/);
  await page.locator('#more').click();await page.waitForFunction(()=>document.querySelectorAll('#assessments article').length===8);
  assert.equal(await page.locator('#more').isVisible(),false);
  assert.match(await page.locator('#assessments').innerText(),/reserve roles/);
  const second=await page.evaluate(()=>testLastResponse);
  assert.deepEqual(await page.locator('#actions article').evaluateAll(nodes=>nodes.map(n=>n.dataset.actionId)),mergePages([first,second]).actions.map(a=>a.id),'visible action order and deduplication match the server comparator');
  const headlines=await page.locator('#actions article h3').allTextContents();assert.ok(headlines.length);
  const text=await page.locator('main').innerText();assert.doesNotMatch(text,/undefined|NaN|117597|28525/);
  await page.evaluate(()=>{testScenario='loading';document.getElementById('refresh').click();});
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Checking'));
  await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
  for(const [scenario,pattern] of [['empty',/0 league references/],['clear',/No unavailable starters/],['partial',/Provider discovery was incomplete/],['stale',/expired|out of date/]]) {
   await page.evaluate(s=>{testScenario=s;document.getElementById('refresh').click();},scenario);
   await page.waitForFunction(()=>!document.getElementById('refresh').disabled);
   assert.match(await page.locator('main').innerText(),pattern);
  }
  await page.evaluate(()=>testChangeAccount('signedout'));await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Sign in'));
  assert.equal(await page.locator('#actions article').count(),0);
  await page.evaluate(()=>testChangeAccount('free'));await page.waitForFunction(()=>document.getElementById('status').textContent.includes('Premium'));
  // Follow an actual action scope into existing tools; each tool requests validated context.
  const target=first.actions[0].scope;
  await page.goto(base+'/'+toolLink('teamManager',target));await page.waitForSelector('.league-card');
  assert.equal(await page.locator('.league-card').count(),1);
  assert.match(await page.locator('.lc-league').innerText(),/Test NBA/i);
  assert.equal(await page.locator('[data-action=apply]').count(),0);
  await page.screenshot({path:`/tmp/fe-my-edge-browser/team-manager-${viewport.width}.png`,fullPage:true});
  if(viewport.width<600){await page.locator('.nav-toggle').click();assert.ok(await page.locator('body').evaluate(e=>e.classList.contains('nav-open')));await page.locator('.sidebar-nav a[href="fantasyedge-my-edge.html"]').click();await page.waitForSelector('#assessments article');}
  const hockey=second.assessments.find(a=>a.scope.sport==='nhl').scope;
  await page.goto(base+'/'+toolLink('teamManager',hockey));await page.waitForSelector('.league-card');
  assert.match(await page.locator('#leaguesArea').innerText(),/Unverified slot/);
  assert.equal(await page.locator('.bench-sep').count(),0,'unknown NHL role is not labeled bench');
  assert.doesNotMatch(await page.locator('#leaguesArea').innerText(),/undefined|NaN/);
  await page.goto(base+'/'+toolLink('tradeCenter',target));await page.waitForFunction(()=>document.getElementById('leagueSelect')?.options.length===1 && document.getElementById('leagueSelect').options[0].textContent.includes('Test NBA'));
  await page.goto(base+'/'+toolLink('coach',target));await page.waitForFunction(()=>document.getElementById('coachInput')?.value.includes('Verified ESPN context'));
  assert.match(await page.locator('#coachInput').inputValue(),/Test NBA/);
  await page.goto(base+'/fantasyedge-autopilot.html?platform=espn&sport=nba&season=2027&leagueId=bad&teamId=1');
  await page.waitForFunction(()=>document.getElementById('leaguesMsg')?.textContent.includes('invalid'));
  await page.goto(base+'/'+toolLink('teamManager',{...target,teamId:'9999'}));
  await page.waitForFunction(()=>document.getElementById('leaguesMsg')?.textContent.includes('not available'));
  await page.route('**/api/espn',async route=>{
   if(route.request().postDataJSON()?.action==='status')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'storage_unavailable'})});
   return route.continue();
  });
  await page.goto(base+'/'+toolLink('teamManager',target));await page.waitForSelector('#connectionError:not(.hidden)');
  assert.equal(await page.locator('#connectPanel').isVisible(),false,'failed status never invites credential entry');
  await page.unroute('**/api/espn');await page.locator('#retryConnection').click();await page.waitForSelector('.league-card');
  await checkTeamManagerBrowser(page,base);
  assert.deepEqual(errors,[]);await page.close();
 }
 assert.ok(requests.every(r=>['myEdge','status','leagues','leagueContext'].includes(r.action)));
 console.log('PASS: real Chromium desktop/mobile, local aggregator HTTP, controlled auth, loading, empty, scoped clear, NBA preseason, NHL partial, pagination, stale labels, safety and no writes');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
