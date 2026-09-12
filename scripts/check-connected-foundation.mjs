// Uses the actual storage, provider parser and API dispatcher against offline fakes.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { leagueKeyOf } from '../leagueIdentity.js';
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); // synthetic offline key
process.env.KV_REST_API_URL = 'https://offline.invalid';
process.env.KV_REST_API_TOKEN = 'offline';
const lib = p => new URL(`../api/_lib/${p}`, import.meta.url).href;
const store = new Map(), members = new Set();
const redis = {
  get: async k => structuredClone(store.get(k) ?? null),
  set: async (k,v) => store.set(k, structuredClone(v)),
  del: async k => store.delete(k),
  sadd: async (k,u) => members.add(u), srem: async (k,u) => members.delete(u),
  smembers: async () => [...members],
};
const kv = await import(lib('kv.js')), auth = await import(lib('auth.js'));
let premium = true;
mock.module(lib('kv.js'), { namedExports: { ...kv, redis } });
mock.module(lib('auth.js'), { namedExports: { ...auth,
  requireUser: async () => ({ userId: 'u' }),
  requirePremium: async () => { if (!premium) throw new auth.HttpError(403,'Premium required'); return { userId:'u' }; },
} });
const f = await import(lib('espnFantasy.js'));
const { default: handler } = await import('../api/espn/index.js');
const ids = { season: 2026, leagueId: '1', teamId: 1 };
store.set('espn:autopilot:u', { '2026:1:1': true });
await f.setAutopilotLeague(redis,'u',leagueKeyOf({...ids,sport:'nfl'}),true,'nfl');
let prefs = await f.getAutopilot(redis,'u');
assert.ok(prefs['mlb:2026:1:1']); assert.ok(prefs['nfl:2026:1:1']);
await f.setAutopilotLeague(redis,'u',leagueKeyOf({...ids,sport:'nfl'}),false,'nfl');
assert.ok((await f.getAutopilot(redis,'u'))['mlb:2026:1:1']);
store.set('espn:autopilot:u', { '2026:1:1': {sport:'wnba'} });
assert.ok((await f.getAutopilot(redis,'u'))['wnba:2026:1:1']);
store.set('espn:manualleagues:u', [{leagueId:'1', season:2026}]);
await f.addManualLeague(redis,'u',{...ids,sport:'nba'});
await f.removeManualLeague(redis,'u',{...ids,sport:'nba'});
assert.deepEqual(await f.getManualLeagues(redis,'u'),[{leagueId:'1',season:2026,sport:'mlb'}]);
const swid = '{11111111-2222-3333-4444-555555555555}';
let calls=0, posts=0;
globalThis.fetch = async (url,opts={}) => {
  calls++; if(opts.method === 'POST') posts++;
  return {ok:true,status:200,json:async()=>({settings:{},teams:[
    {id:1, primaryOwner:swid, roster:{entries:[]}},
    {id:2, primaryOwner:'{somebody-else}', roster:{entries:[]}},
  ]})};
};
const creds={espn_s2:'offline',swid};
store.set('espn:creds:u',creds);
assert.equal((await f.fetchLeagueRoster(creds,{leagueId:'1',seasonId:2026,teamId:'1'},'nfl')).teamId,1);
await assert.rejects(f.fetchLeagueRoster(creds,{leagueId:'1',seasonId:2026,teamId:2},'nfl'),e=>e.status===403);
async function post(body) {
  const res={statusCode:200,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};
  await handler({method:'POST',headers:{},body},res);return res;
}
assert.equal((await post({action:'autopilot',sport:'nfl',on:true,league:{...ids,teamId:2}})).statusCode,403);
assert.equal((await post({action:'apply',sport:'nfl',...ids,teamId:2})).statusCode,403);
assert.equal(posts,0);
for(const sport of ['nba','nhl']) {
  assert.equal((await post({action:'apply',sport,...ids,dryRun:true})).statusCode,400);
  assert.equal((await post({action:'autopilot',sport,on:true,league:ids})).statusCode,400);
}
assert.equal((await post({action:'watchProspect',sport:'nhl',playerId:1})).statusCode,400);
store.set('league:espn:mlb:1:2026:config',{history:'retain'});
store.set('espn:prospectwatch:u', { '99': { name:'Watch fixture',lg:'2026:1:1',reclaim:true } });
store.set('espn:dna:ack:u',{version:2,include:true});
await f.setAutopilotLeague(redis,'u','mlb:2026:1:1',true);
premium=false;
// Revocation must work even when the encryption key for a stored connection is unavailable.
store.set('espn:creds:u', { version: 1, data: 'unreadable' });
assert.equal((await post({action:'autopilot',sport:'mlb',on:false,league:ids})).statusCode,200);
assert.equal((await post({action:'dnaChoice',version:2,include:false})).statusCode,200);
assert.equal((await post({action:'apply',sport:'mlb',...ids})).statusCode,403);
assert.equal((await post({action:'disconnect'})).statusCode,200);
assert.equal(store.has('espn:creds:u'),false);
assert.deepEqual(await f.getAutopilot(redis,'u'),{});
assert.equal(store.has('espn:dna:ack:u'),false);
assert.ok(store.has('league:espn:mlb:1:2026:config'));
assert.ok(store.has('espn:manualleagues:u'));
assert.equal(store.get('espn:prospectwatch:u')['99'].lg, '');
assert.equal(store.get('espn:prospectwatch:u')['99'].reclaim, true);
await f.saveCreds(redis, 'u', creds);
assert.deepEqual(await f.getAutopilot(redis, 'u'), {});
assert.ok((await f.getCreds(redis, 'u')).connectionId);
await f.setAutopilotLeague(redis, 'u', 'mlb:2026:1:1', true);
await f.saveCreds(redis, 'u', creds);
assert.deepEqual(await f.getAutopilot(redis, 'u'), {}, 'relink also revokes automation');
assert.equal(posts,0);
console.log('PASS: legacy migration, overlapping sport IDs, ownership, disabled sports, free disconnect and DNA retention');
