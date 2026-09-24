import assert from 'node:assert/strict';
import { fetchLeagueRoster } from '../../api/_lib/espnFantasy.js';
import { mlbPositionFixture,mlbOwner } from './mlb-position-fixture.mjs';

export async function checkTeamManagerBrowser(page,base) {
  const {raw}=mlbPositionFixture(),originalFetch=globalThis.fetch;
  let league;
  try {
    globalThis.fetch=async()=>({ok:true,json:async()=>structuredClone(raw)});
    league=await fetchLeagueRoster({swid:mlbOwner,espn_s2:'synthetic'},{leagueId:'1',seasonId:2026,teamId:1},'mlb');
  } finally {globalThis.fetch=originalFetch;}
  league.scoring={label:'Roto (category)',format:'category',cats:[]};
  league.suggestions={moves:[{reason:'value',in:'Bench arm',out:'Starter arm',slot:'SP',gain:9}],summary:{count:1}};
  let preview=true,connected=true,needed=true;
  const calls=[];
  await page.route('**/api/espn',async route=>{
    const body=route.request().postDataJSON();calls.push(body);
    let result;
    if(body.action==='status') result={connected,previewReadOnly:preview,dnaNotice:{needed,include:false}};
    else if(body.action==='leagues') result={leagues:[league],state:'ok'};
    else if(body.action==='connect') {connected=true;result={connected:true};}
    else if(body.action==='dnaChoice') {needed=false;result={dnaNotice:{needed:false,include:body.include}};}
    else result={changes:[],applied:0};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  const url=base+'/fantasyedge-autopilot.html?platform=espn&sport=mlb&season=2026&leagueId=1&teamId=1';
  await page.goto(url);await page.waitForSelector('.league-card');
  assert.equal(await page.locator('.lc-record').count(),0,'ROTO has no W-L');
  assert.match(await page.locator('.lc-scoring').innerText(),/Roto/);
  assert.match(await page.locator('.pmeta').first().innerText(),/^C/);
  assert.ok((await page.locator('.pmeta').allTextContents()).some(t=>t.startsWith('SP')));
  assert.ok((await page.locator('.pmeta').allTextContents()).some(t=>t.startsWith('RP')));
  assert.equal(await page.locator('#dnaNoticePanel').isVisible(),false);
  assert.equal(await page.locator('#dnaToggle').count(),0);
  assert.match(await page.locator('#dnaSetting').innerText(),/collection is disabled in this preview/);
  assert.equal(await page.locator('.ap-toggle,.apply-btn,.preview-btn').count(),0);
  assert.match(await page.locator('.lc-controls').innerText(),/Autopilot.*unavailable/);
  const before=calls.length;
  // Reinsert actionable DOM, forge global state and dispatch events: closure-held server
  // capability must still block requests (backend guards remain the security boundary).
  await page.evaluate(()=>{
    window.previewReadOnly=false;window.connectionStatusVerified=true;
    document.getElementById('dnaInclude').disabled=false;
    document.getElementById('dnaYesBtn').click();document.getElementById('dnaNoBtn').click();
    const box=document.querySelector('.lc-controls');
    box.innerHTML='<button class="apply-btn">Apply</button><button class="preview-btn">Dry run</button><input type="checkbox" class="ap-toggle">';
    box.querySelector('.apply-btn').click();box.querySelector('.preview-btn').click();
    const toggle=box.querySelector('input');toggle.checked=true;toggle.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(calls.length,before,'no requests from manipulated Preview controls');
  await page.goto(url);await page.waitForSelector('.league-card');
  await page.screenshot({path:`/tmp/fe-my-edge-browser/mlb-preview-${page.viewportSize().width}.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  // Connect carries no consent in preview, including when the hidden checkbox is altered.
  for(const mode of [true,false]) {
    preview=mode;connected=false;needed=true;
    await page.goto(url);await page.waitForSelector('#connectPanel:not(.hidden)');
    assert.equal(await page.locator('#dnaInclude').isVisible(),!mode);
    assert.equal(await page.locator('#dnaInclude').isDisabled(),mode);
    assert.equal(await page.locator('#previewDnaNote').isVisible(),mode);
    await page.evaluate(()=>{const c=document.getElementById('dnaInclude');c.disabled=false;c.checked=true;});
    await page.locator('#s2Input').fill('synthetic-offline-cookie-'.repeat(4));
    await page.locator('#swidInput').fill(mlbOwner);
    await page.locator('#connectBtn').click();await page.waitForSelector('.league-card');
    const sent=calls.findLast(c=>c.action==='connect');
    if(mode)assert.equal(Object.hasOwn(sent,'dnaNotice'),false);
    else assert.deepEqual(sent.dnaNotice,{version:2,include:true});
  }
  // Normal production-mode controls remain functional against local mocks only.
  assert.equal(await page.locator('#dnaNoticePanel').isVisible(),true);
  await page.locator('#dnaYesBtn').click();await page.waitForSelector('#dnaToggle');
  assert.equal(calls.findLast(c=>c.action==='dnaChoice').include,true);
  await page.locator('#dnaToggle').click();await page.waitForFunction(()=>document.getElementById('dnaToggle')?.textContent==='Include them');
  assert.equal(calls.findLast(c=>c.action==='dnaChoice').include,false);
  await page.locator('.switch').click();await page.waitForFunction(()=>document.querySelector('.ap-msg')?.textContent.includes('On'));
  assert.equal(calls.findLast(c=>c.action==='autopilot').on,true);
  await page.locator('.preview-btn').click();await page.waitForSelector('.ap-preview:not([hidden])');
  assert.equal(calls.findLast(c=>c.action==='apply').dryRun,true);
  page.once('dialog',dialog=>dialog.accept());await page.locator('.apply-btn').click();
  await page.waitForFunction(()=>document.querySelector('.ap-msg')?.textContent.includes('Already optimal'));
  assert.equal(calls.findLast(c=>c.action==='apply').dryRun,undefined);
  league.scoringType='H2H_POINTS';league.scoring.label='H2H Points';
  Object.assign(league.team,{wins:5,losses:3,ties:1});
  await page.goto(url);await page.waitForSelector('.lc-record');
  assert.equal(await page.locator('.lc-record').innerText(),'5-3-1');
  Object.assign(league.team,{wins:0,losses:0,ties:0});
  await page.goto(url);await page.waitForSelector('.lc-record');
  assert.equal(await page.locator('.lc-record').innerText(),'0-0','H2H preseason zero record is preserved');
  await page.unroute('**/api/espn');
  console.log(`PASS: Team Manager ${page.viewportSize().width}px MLB labels, ROTO/H2H records, Preview UI/request guards and production controls/connect consent`);
}
