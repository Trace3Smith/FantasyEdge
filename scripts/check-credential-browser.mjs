// Real Team Manager page, synthetic auth/API, all external requests blocked.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { chromium }=await import(process.env.FE_PLAYWRIGHT_MODULE||'playwright');
const html=await readFile(new URL('../fantasyedge-autopilot.html',import.meta.url),'utf8');
const auth=`window.FE={isSignedIn:()=>true,isPremium:()=>true,apiPost:async(path,body)=>{const r=await fetch(path,{method:'POST',body:JSON.stringify(body)});return {ok:r.ok,status:r.status,data:await r.json()};}};document.dispatchEvent(new Event('fe-auth-ready'));`;
const browser=await chromium.launch({headless:true});
try {
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),calls=[],errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  let mode='error';
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='http://compatibility.test')return route.abort();
   if(url.pathname==='/fantasyedge-autopilot.html')return route.fulfill({contentType:'text/html',body:html});
   if(url.pathname==='/auth.js')return route.fulfill({contentType:'text/javascript',body:auth});
   if(url.pathname==='/api/espn'){
    const body=route.request().postDataJSON();calls.push(body);
    if(body.action==='status')return route.fulfill({status:mode==='error'?503:200,contentType:'application/json',body:JSON.stringify(mode==='error'?{error:'Synthetic unavailable configuration'}:{connected:mode==='connected',confirmationPending:mode==='pending',dnaNotice:{needed:false,include:false}})});
    if(body.action==='confirmConnection'){assert.equal(body.confirm,true);mode='connected';return route.fulfill({contentType:'application/json',body:JSON.stringify({connected:true})});}
    if(body.action==='leagues')return route.fulfill({contentType:'application/json',body:JSON.stringify({leagues:[],state:'no_leagues'})});
    throw new Error('Unexpected mutation in browser test');
   }
   return route.fulfill({status:404,body:''});
  });
  await page.goto('http://compatibility.test/fantasyedge-autopilot.html');
  await page.waitForSelector('#connectionError:not(.hidden)');
  assert.equal(await page.locator('#connectPanel').isVisible(),false);
  assert.equal(await page.locator('#connectedWrap').isVisible(),false);
  // Even a programmatic click cannot send cookies while status is unverified.
  await page.evaluate(()=>{document.getElementById('s2Input').value='synthetic';document.getElementById('swidInput').value='{synthetic}';document.getElementById('connectBtn').click();});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(r)));
  assert.deepEqual(calls.map(c=>c.action),['status']);
  mode='disconnected';await page.locator('#retryConnection').click();
  await page.waitForSelector('#connectPanel:not(.hidden)');
  assert.equal(await page.locator('#connectionError').isVisible(),false);
  mode='pending';await page.reload();await page.waitForSelector('#confirmationPanel:not(.hidden)');
  assert.equal(await page.locator('#connectPanel').isVisible(),false);
  assert.equal(calls.some(c=>c.action==='confirmConnection'),false);
  await page.locator('#confirmConnectionBtn').click();await page.waitForSelector('#connectedWrap:not(.hidden)');
  assert.equal(calls.filter(c=>c.action==='confirmConnection').length,1);
  mode='connected';await page.reload();await page.waitForSelector('#connectedWrap:not(.hidden)');
  assert.equal(await page.locator('#connectPanel').isVisible(),false);
  assert.equal(await page.locator('a[href*="my-edge"]').count(),0);
  assert.deepEqual(errors,[]);
  await page.close();console.log(`PASS: ${width}px credential-status failure, guarded connect, retry and normal connected UI`);
 }
} finally {await browser.close();}
