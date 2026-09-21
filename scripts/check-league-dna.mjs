#!/usr/bin/env node
import { seedEpochCredential } from './lib/epoch-fixture.mjs';
import { installLifecycleFake } from './lib/lifecycle-fake.mjs';
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
process.env.ESPN_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64'); // synthetic offline key
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

installLifecycleFake(fakeRedis);
let currentUser = null;
const lib = (p) => new URL(`../api/_lib/${p}`, import.meta.url).href;
const realKv = await import(lib('kv.js'));
const realAuth = await import(lib('auth.js'));
mock.module(lib('kv.js'), { namedExports: { ...realKv, redis: fakeRedis } });
mock.module(lib('auth.js'), { namedExports: { ...realAuth, requireUser: async () => ({ userId: currentUser }), requirePremium: async () => ({ userId: currentUser }), premiumForUser: async () => true } });
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
const linked = (name) => seedEpochCredential(store,name,{espn_s2:'s2',swid:U[name].swid});
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
  const prefs = (name) => ({ [`2026:${U[name].league}:1`]: { sport: 'mlb', connectionId:store.get(`espn:generation:${name}`) } });
  store.set('espn:autopilot:existing', prefs('existing'));
  store.set('espn:autopilot:cronUser', prefs('cronUser'));
  sets.set('espn:autopilot:users', new Set(['existing', 'cronUser']));
  store.set(realKv.DATASET_KEY, { players: [{ name: 'Placeholder OF', pos: 'OF', zTotal: 1 }] });

  const r = await call(cron, { headers: { authorization: 'Bearer offline-cron' } });
  check('the cron runs both users', r.statusCode === 200 && r.body?.summary?.users === 2, JSON.stringify(r.body?.summary));
  check('...captures the opted-in user\'s league', captured('cronUser'));
  check('...and not the league of a user who never answered', !captured('existing'));
}

console.log('\noffline — the daily sweep, run by the Autopilot cron');
{
  const { SWEEP_CURSOR_KEY } = await import(lib('leagueDnaSweep.js'));
  // Fresh accounts, answered directly in the store (not via dnaChoice, which captures straight away), so
  // only the sweep can have captured them. Two share a league, to show it's read once per run.
  Object.assign(U, {
    sweepA:       { swid: hex('1'), league: '701' },
    sweepShared:  { swid: hex('2'), league: '701' },
    sweepB:       { swid: hex('3'), league: '702' },
    sweepStale:   { swid: hex('4'), league: '703' }, // still in the set, but answered an older notice
    sweepExpired: { swid: hex('5'), league: '704' }, // opted in; cookies have since expired
  });
  if (!sets.has(DNA_USERS)) sets.set(DNA_USERS, new Set());
  for (const name of ['sweepA', 'sweepShared', 'sweepB', 'sweepStale', 'sweepExpired']) {
    linked(name);
    const version = name === 'sweepStale' ? DNA_NOTICE_VERSION - 1 : DNA_NOTICE_VERSION;
    store.set(`espn:dna:ack:${name}`, { version, include: true, connectionId:`fixture-${name}`, via: 'notice', at: '2026-09-01T00:00:00.000Z' });
    sets.get(DNA_USERS).add(name);
  }
  // Autopilot is on for the expired account, but it isn't in today's lineup run: the sweep must leave it be.
  const expiredPrefs = { '2026:704:1': { sport: 'mlb', connectionId:'fixture-sweepExpired' } };
  store.set('espn:autopilot:sweepExpired', expiredPrefs);
  const stub = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => ((opts.headers?.Cookie || '').includes(`SWID=${U.sweepExpired.swid}`)
    ? { ok: false, status: 401, json: async () => ({}), text: async () => '' }
    : stub(url, opts));
  const mark = espnCalls.length;

  // Capture the cron's console output: a cron's response body isn't visible in production, so its
  // log line is the only place the sweep's result can be read.
  const logged = [];
  const log = console.log;
  console.log = (...a) => { logged.push(a.join(' ')); };
  const r = await call(cron, { headers: { authorization: 'Bearer offline-cron' } });
  console.log = log;
  globalThis.fetch = stub;
  const sw = r.body?.summary?.sweep || {};
  const calls = espnCalls.slice(mark);
  check('the cron runs the sweep and reports it', r.statusCode === 200 && typeof sw.visited === 'number', JSON.stringify(sw));
  const PREFIX = '[autopilot] summary ';
  const line = logged.find((l) => l.startsWith(PREFIX));
  const fromLog = line ? JSON.parse(line.slice(PREFIX.length)) : null;
  check("the run logs its summary, sweep included, for Vercel's logs",
    fromLog?.sweep?.visited === sw.visited && fromLog.sweep.recorded === sw.recorded && fromLog.users === r.body.summary.users,
    line ? line.slice(0, 100) : 'no log line');
  check("opted-in users' leagues are captured", captured('sweepA') && captured('sweepB'));
  check('a user whose answer predates the current notice is skipped, though still in the set',
    !captured('sweepStale') && sw.skippedConsent === 1 && !calls.some((c) => c.user === 'sweepStale'));
  check('ESPN discovery runs only for users on the opted-in list',
    calls.filter((c) => c.u.includes('fan.api')).every((c) => sets.get(DNA_USERS).has(c.user) && c.user !== 'sweepStale'),
    calls.filter((c) => c.u.includes('fan.api')).map((c) => c.user).join(', '));
  const reads701 = calls.filter((c) => c.u.includes('/leagues/701?view=mSettings'));
  check("a shared league's settings are read once per run", reads701.length === 1, reads701.map((c) => c.user).join(', '));
  check('expired cookies are skipped quietly: counted, nothing else changed',
    sw.expired === 1 && ack('sweepExpired')?.include === true && inSweepList('sweepExpired')
      && store.has('espn:creds:sweepExpired')
      && JSON.stringify(store.get('espn:autopilot:sweepExpired')) === JSON.stringify(expiredPrefs));
  check('the lineup run is unaffected', r.body?.summary?.users === 2 && r.body.summary.errors === 0, JSON.stringify(r.body?.summary));
  check('a full pass resets the cursor to the top', sw.complete === true && store.get(SWEEP_CURSOR_KEY)?.after === null);
}

console.log("\noffline — the sweep's time budget and cursor");
{
  const { sweepLeagueConfigs, SWEEP_CURSOR_KEY } = await import(lib('leagueDnaSweep.js'));
  // A small separate Redis: five opted-in users with cookies.
  const mk = () => {
    const kv = new Map();
    const members = new Set();
    const r = {
      get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
      set: async (k, v) => { kv.set(k, structuredClone(v)); return 'OK'; },
      smembers: async () => [...members],
    };
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) {
      members.add(id);
      kv.set(`espn:dna:ack:${id}`, { version: DNA_NOTICE_VERSION, include: true, connectionId:`fixture-${id}`, via: 'notice' });
      seedEpochCredential(kv,id,{espn_s2:'s2',swid:`{${id}}`});
    }
    installLifecycleFake(r);
    return { r, kv };
  };

  // A fake clock where each user's ESPN work costs 7s, against a 20s budget.
  let t = 0;
  const visits = [];
  const fetchConfigs = async (creds) => { visits.push(creds.swid); t += 7000; return []; };
  const { r, kv } = mk();
  const run = () => sweepLeagueConfigs(r, { deadline: t + 20000, now: () => t, fetchConfigs });

  const s1 = await run();
  check('a run stops starting users once under 6s remain', s1.visited === 3 && visits.join() === '{u1},{u2},{u3}', visits.join());
  check('...and saves where it stopped', kv.get(SWEEP_CURSOR_KEY)?.after === 'u3' && s1.complete === false);
  visits.length = 0;
  await run();
  check('the next run resumes after it, wrapping round to the top', visits.join() === '{u4},{u5},{u1}', visits.join());

  // A user whose ESPN work is still running at the deadline is abandoned, and the cursor doesn't pass them.
  const { r: r2, kv: kv2 } = mk();
  kv2.set(SWEEP_CURSOR_KEY, { after: 'u2' });
  const s3 = await sweepLeagueConfigs(r2, { deadline: Date.now() + 60, minUserMs: 10, fetchConfigs: () => new Promise(() => {}) });
  check('a user still running at the deadline is abandoned', s3.timedOut === 1 && s3.visited === 0, JSON.stringify(s3));
  check("...and the cursor stays put, so they're first next run", kv2.get(SWEEP_CURSOR_KEY)?.after === 'u2');
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
