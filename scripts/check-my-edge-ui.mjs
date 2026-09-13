// DOM-contract smoke test, not a claim of real-browser visual verification.
import assert from 'node:assert/strict';
import { mountMyEdge,mergePages } from '../assets/my-edge.js';
class Element {
 constructor(tag){this.tag=tag;this.children=[];this.events={};this.hidden=false;this.disabled=false;this.value='';}
 set textContent(v){this.value=String(v);this.children=[];}get textContent(){return this.value+this.children.map(c=>c.textContent).join('');}
 append(...n){this.children.push(...n);}replaceChildren(...n){this.value='';this.children=n;}
 addEventListener(e,f){this.events[e]=f;}
}
const root=new Map(['actions','assessments','attention','status','more','refresh','account'].map(id=>[id,new Element('div')]));
const doc={getElementById:id=>root.get(id),createElement:tag=>new Element(tag)};
const now=Date.now(),scope={platform:'espn',sport:'nba',season:2027,leagueId:'1',teamId:'1'};
const action={id:'a',scope,leagueName:'<img onerror=alert(1)>',headline:'Review lineup',summary:'Example',type:'LINEUP_UPGRADE',actionable:true,
 urgency:{level:'UNKNOWN'},impact:{level:'HIGH'},confidence:{level:'HIGH'},evidence:[{kind:'provider_status',source:'ESPN',value:'OUT'}],destination:{tool:'javascript:alert(1)'},
 freshness:{observedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()}};
let signedIn=true,listener,calls=[];
const pages=[{connectionState:'CONNECTED',actions:[action],assessments:[{scope,leagueName:'Preseason league',status:'EMPTY_ROSTER',summary:'No players rostered yet.',checkedSignals:['authenticated_roster']}],nextCursor:'next',discoveredCount:2},
 {connectionState:'CONNECTED',actions:[action],assessments:[{scope:{...scope,leagueId:'2'},status:'PARTIAL',unsupportedFields:['reserve_roles']}],nextCursor:null,discoveredCount:2}];
const FE={isSignedIn:()=>signedIn,isPremium:()=>signedIn,clerk:{session:{id:'test'},addListener:f=>listener=f},apiPost:async(path,body)=>{calls.push({path,body});return {ok:true,data:pages[calls.length-1]};}};
const app=mountMyEdge(doc,FE);await app.ready;
assert.equal(root.get('more').hidden,false);assert.match(root.get('assessments').textContent,/No players rostered yet/);
assert.match(root.get('actions').textContent,/<img onerror/,'untrusted name rendered as text');
const links=root.get('actions').children[0].children.at(-1).children;
assert.equal(links[0].href,'fantasyedge-autopilot.html');assert.equal(links[1].href,'fantasyedge-coach.html');
await app.load();assert.equal(calls[1].body.cursor,'next');assert.equal(root.get('more').hidden,true);
assert.equal(root.get('actions').children.length,1,'duplicate action across pages appears once');
assert.equal(root.get('assessments').children.length,2);assert.match(root.get('assessments').textContent,/reserve roles/);
assert.equal(mergePages(pages,now+61000).attentionCount,0,'expired actions excluded');
signedIn=false;listener();assert.equal(root.get('actions').children.length,0,'signout clears private cards');assert.equal(root.get('account').hidden,false);
assert.ok(calls.every(c=>c.path==='/api/espn'&&c.body.action==='myEdge'));
app.dispose();console.log('PASS: Advisor UI pagination, deduplication, escaped text, allowlisted tools, expiry, preseason/partial coverage and signout clearing');
