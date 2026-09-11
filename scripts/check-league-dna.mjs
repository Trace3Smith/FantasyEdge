#!/usr/bin/env node
// Offline checks for League DNA consent: no user's leagues are captured until they've seen the notice
// and opted in, on EVERY capture path. Runs the REAL request handler (api/espn/index.js) and the REAL
// Autopilot cron, with Clerk and Redis swapped for stand-ins (node:test module mocks) and ESPN stubbed
// per account, so each capture can be traced to the user whose cookies made it.
//
// Uses Node's module mocks, hence --experimental-test-module-mocks in the npm script.
//
// Usage:  npm run check:league-dna      Exit: 0 clean · 1 a check failed
import { mock } from 'node:test';

// kv.js builds its Upstash client on import; the handler gets the in-memory stand-in below instead.
process.env.KV_REST_API_URL ||= 'https://offline.invalid';
process.env.KV_REST_API_TOKEN ||= 'offline';
process.env.CRON_SECRET = 'offline-cron';

let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); };

// --- in-memory Redis: just the commands these paths use ------------------------------------------
const store = new Map();
const sets = new Map();
const fakeRedis = {
  get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : null),
  set: async (k, v) => { store.set(k, structuredClone(v)); return 'OK'; },
  del: async (k) => (store.delete(k) ? 1 : 0),
  sadd: async (k, m) => { if (!sets.has(k)) sets.set(k, new Set()); sets.get(k).add(m); return 1; },
  srem: async (k, m) => (sets.get(k)?.delete(m) ? 1 : 0),
  smembers: async (k) => [...(sets.get(k) || [])],
};

let currentUser = null;
const lib = (p) => new URL(`../api/_lib/${p}`, import.meta.url).href;
const realKv = await import(lib('kv.js'));
const realAuth = await import(lib('auth.js'));
mock.module(lib('kv.js'), { namedExports: { ...realKv, redis: fakeRedis } });
mock.module(lib('auth.js'), { namedExports: { ...realAuth, requirePremium: async () => ({ userId: currentUser }) } });
const { default: espn } = await import('../api/espn/index.js');
const { default: cron } = await import('../api/cron/autopilot.js');
const { DNA_NOTICE_VERSION, DNA_USERS } = await import(lib('leagueDnaConsent.js'));
const { leagueConfigKey } = await import(lib('leagueConfig.js'));

// --- accounts: each owns one MLB league, so every capture is attributable -------------------------
const hex = (c) => `{${c.repeat(8)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(4)}-${c.repeat(12)}}`;
const U = {
  existing:  { swid: hex('a'), league: '101' }, // linked before the notice existed; never answers
  optsOut:   { swid: hex('b'), league: '202' }, // linked before; answers the notice with "no"
  optsIn:    { swid: hex('c'), league: '303' }, // linked before; answers the notice with "yes"
  newYes:    { swid: hex('d'), league: '404' }, // links now, box left ticked
  newNo:     { swid: hex('e'), league: '505' }, // links now, box unticked
  stalePage: { swid: hex('f'), league: '606' }, // links from a cached page that predates the notice
  cronUser:  { swid: hex('9'), league: '909' }, // opted in; only the cron should capture here
};
const userOfSwid = (swid) => Object.entries(U).find(([, u]) => u.swid === swid)?.[0];
const linked = (name) => store.set(`espn:creds:${name}`, { espn_s2: 's2', swid: U[name].swid });
for (const name of ['existing', 'optsOut', 'optsIn', 'cronUser']) linked(name);

const cfgKey = (name) => leagueConfigKey({ platform: 'espn', sport: 'mlb', leagueId: U[name].league, season: 2026 });
const captured = (name) => store.has(cfgKey(name));
const ack = (name) => store.get(`espn:dna:ack:${name}`) || null;
const inSweepList = (name) => !!sets.get(DNA_USERS)?.has(name);

// --- ESPN, stubbed per account: the fan API lists that SWID's league; the league API serves it ----
const leaguePayload = (id) => {
  const owner = Object.values(U).find((u) => u.league === id);
  return {
    scoringPeriodId: 150,
    settings: {
      name: `League ${id}`, size: 10,
      scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [] },
      draftSettings: { date: 1774310400000, type: 'SNAKE', pickOrder: [1] },
      tradeSettings: { deadlineDate: 1788192000000 },
    },
    teams: [{ id: 1, location: 'Team', nickname: id, primaryOwner: owner.swid, roster: { entries: [] } }],
  };
};
const espnCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const swid = /SWID=([^;]+)/.exec(opts.headers?.Cookie || '')?.[1];
  espnCalls.push({ u, user: userOfSwid(swid) });
  const ok = (body) => ({ ok: true, status: 200, json: async () => structuredClone(body), text: async () => '' });
  if (u.includes('fan.api.espn.com')) {
    const me = U[userOfSwid(swid)];
    return ok({ preferences: me ? [{ type: { type: 'x' }, metaData: { entry: {
      abbrev: 'FLB', seasonId: 2026, entryId: 1, groups: [{ groupId: Number(me.league), groupName: `League ${me.league}` }] } } }] : [] });
  }
  const m = /\/games\/flb\/seasons\/2026\/segments\/0\/leagues\/(\d+)/.exec(u);
  if (m && Object.values(U).some((x) => x.league === m[1])) return ok(leaguePayload(m[1]));
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
};

const call = async (handler, req) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
};
const post = (user, body) => { currentUser = user; return call(espn, { method: 'POST', headers: {}, body }); };
const choose = (user, include, via = 'notice', version = DNA_NOTICE_VERSION) =>
  post(user, { action: 'dnaChoice', version, include, via });
const connect = (user, dnaNotice) => post(user, { action: 'connect', espn_s2: 's2'.repeat(40), swid: U[user].swid, ...(dnaNotice ? { dnaNotice } : {}) });

console.log('offline — an already-linked user who has never seen the notice');
{
  const st = await post('existing', { action: 'status' });
  check('status asks for the notice', st.body?.dnaNotice?.needed === true && st.body.dnaNotice.version === DNA_NOTICE_VERSION);
  const lg = await post('existing', { action: 'leagues', sport: 'mlb' });
  check('their leagues still load', lg.statusCode === 200 && lg.body?.leagues?.some((l) => l.leagueId === '101'), `${lg.statusCode}`);
  check('...but nothing is captured', !captured('existing'));
  check('...and the config never reaches the browser', lg.body?.leagues?.every((l) => !('leagueConfig' in l)));
  const stale = await choose('existing', true, 'notice', DNA_NOTICE_VERSION + 1);
  check('an answer on a different notice version is refused', stale.statusCode === 400 && stale.body?.error === 'stale_notice',
    `${stale.statusCode} ${JSON.stringify(stale.body)}`);
  check('...records nothing, captures nothing', ack('existing') === null && !captured('existing'));
}

console.log('\noffline — answering the one-time notice');
{
  const no = await choose('optsOut', false);
  check('"Don\'t include my leagues" is recorded', no.statusCode === 200 && ack('optsOut')?.include === false && ack('optsOut')?.via === 'notice');
  check('...stops the notice asking again', no.body?.dnaNotice?.needed === false && no.body.dnaNotice.include === false);
  check('...keeps them off the sweep list', !inSweepList('optsOut'));
  await post('optsOut', { action: 'leagues', sport: 'mlb' });
  check('...and their leagues are never captured', !captured('optsOut'));

  const yes = await choose('optsIn', true);
  check('"Got it" is recorded and joins the sweep list', yes.statusCode === 200 && ack('optsIn')?.include === true && inSweepList('optsIn'));
  check('...and captures their leagues straight away', captured('optsIn'));
  store.delete(cfgKey('optsIn'));
  await post('optsIn', { action: 'leagues', sport: 'mlb' });
  check('...after which the leagues fetch captures too', captured('optsIn'));
}

console.log('\noffline — linking an account from the connect panel');
{
  const y = await connect('newYes', { version: DNA_NOTICE_VERSION, include: true });
  check('box ticked: linked, choice recorded at linking, leagues captured',
    y.statusCode === 200 && ack('newYes')?.include === true && ack('newYes')?.via === 'connect' && captured('newYes'),
    `${y.statusCode} ${JSON.stringify(y.body)}`);
  const n = await connect('newNo', { version: DNA_NOTICE_VERSION, include: false });
  check('box unticked: linked, "no" recorded, nothing captured',
    n.statusCode === 200 && ack('newNo')?.include === false && !captured('newNo') && !inSweepList('newNo'));
  const s = await connect('stalePage', null);
  check('a page that never showed the notice: linked, but no choice and nothing captured',
    s.statusCode === 200 && ack('stalePage') === null && !captured('stalePage'));
  check('...so that user gets the one-time notice', (await post('stalePage', { action: 'status' })).body?.dnaNotice?.needed === true);
  check('...and no ESPN settings read was made for them',
    !espnCalls.some((c) => c.user === 'stalePage' && c.u.includes('view=mSettings') && !c.u.includes('mRoster')));
}

console.log('\noffline — changing your mind, and disconnecting');
{
  const off = await choose('optsIn', false, 'settings');
  check('turning it off later is recorded and leaves the sweep list',
    off.statusCode === 200 && ack('optsIn')?.include === false && ack('optsIn')?.via === 'settings' && !inSweepList('optsIn'));
  check('...already-saved settings stay (they carry no user id)', captured('optsIn'));
  store.delete(cfgKey('optsIn'));
  await post('optsIn', { action: 'leagues', sport: 'mlb' });
  check('...and later fetches no longer capture', !captured('optsIn'));

  await post('newYes', { action: 'disconnect' });
  check('disconnecting forgets the choice and leaves the sweep list', ack('newYes') === null && !inSweepList('newYes'));
  check('...saved settings stay', captured('newYes'));
  const choiceNoCreds = await choose('newYes', true);
  check('no choice can be recorded without a linked account', choiceNoCreds.statusCode === 409 && ack('newYes') === null);
}

console.log('\noffline — the Autopilot cron captures for opted-in users only');
{
  await choose('cronUser', true);
  store.delete(cfgKey('cronUser'));                     // clear the opt-in capture: only the cron may write now
  const prefs = (name) => ({ [`2026:${U[name].league}:1`]: { sport: 'mlb' } });
  store.set('espn:autopilot:existing', prefs('existing'));
  store.set('espn:autopilot:cronUser', prefs('cronUser'));
  sets.set('espn:autopilot:users', new Set(['existing', 'cronUser']));
  store.set(realKv.DATASET_KEY, { players: [{ name: 'Placeholder OF', pos: 'OF', zTotal: 1 }] });

  const r = await call(cron, { headers: { authorization: 'Bearer offline-cron' } });
  check('the cron runs both users', r.statusCode === 200 && r.body?.summary?.users === 2, JSON.stringify(r.body?.summary));
  check('...captures the opted-in user\'s league', captured('cronUser'));
  check('...and not the league of a user who never answered', !captured('existing'));
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
