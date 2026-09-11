#!/usr/bin/env node
// Offline regression checks for api/espn/index.js, run through the REAL request handler with its two
// outside dependencies swapped out: Clerk (auth.js) and Redis (kv.js). ESPN is a stubbed fetch, so
// every URL the handler asks for is recorded and asserted on.
//
// Uses Node's module mocks (node:test mock.module), hence --experimental-test-module-mocks in the npm
// script.
//
// Usage:  npm run check:espn-handler      Exit: 0 clean · 1 a check failed
import { mock } from 'node:test';

// kv.js builds its Upstash client on import. Real-looking env keeps it quiet; it is never called,
// because the handler gets the in-memory stand-in below.
process.env.KV_REST_API_URL ||= 'https://offline.invalid';
process.env.KV_REST_API_TOKEN ||= 'offline';

let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); };

const SWID = '{11111111-2222-3333-4444-555555555555}';
const USER = 'user_offline';
const store = new Map([[`espn:creds:${USER}`, { espn_s2: 's2', swid: SWID }]]);
const fakeRedis = {
  get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : null),
  set: async (k, v) => { store.set(k, structuredClone(v)); return 'OK'; },
};

const lib = (p) => new URL(`../api/_lib/${p}`, import.meta.url).href;
const realKv = await import(lib('kv.js'));
// nflForm needs the cron-built NFL dataset to exist (it 503s without one). A single player with no
// recentGames is enough to reach the response; badge math is covered by nflForm.js's own checks.
store.set(realKv.NFL_DATASET_KEY, { players: [{ id: 1, name: 'Placeholder WR', pos: 'WR' }] });
const realAuth = await import(lib('auth.js'));
mock.module(lib('kv.js'), { namedExports: { ...realKv, redis: fakeRedis } });
mock.module(lib('auth.js'), { namedExports: { ...realAuth, requirePremium: async () => ({ userId: USER }) } });
const { default: handler } = await import('../api/espn/index.js');
const { scoringKey } = await import(lib('espnScoring.js'));

// An NFL league the user owns a team in, scored half-PPR. ESPN only knows it in the football game:
// asked for in any other game (the baseball one, say), it 404s.
const nflLeague = {
  settings: {
    name: 'Sunday League',
    scoringSettings: { scoringType: 'H2H_POINTS', scoringItems: [
      { statId: 3, points: 0.04 }, { statId: 4, points: 4 }, { statId: 24, points: 0.1 }, { statId: 25, points: 6 },
      { statId: 42, points: 0.1 }, { statId: 43, points: 6 }, { statId: 53, points: 0.5 },
    ] },
  },
  teams: [{ id: 4, location: 'My', nickname: 'Team', primaryOwner: SWID, roster: { entries: [] } }],
};
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('/games/ffl/') && u.includes('/leagues/555')) {
    return { ok: true, status: 200, json: async () => structuredClone(nflLeague), text: async () => '' };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => 'Not Found' };
};

const post = async (body) => {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  await handler({ method: 'POST', headers: {}, body }, res);
  return res;
};

console.log("offline — nflForm reads the league from ESPN's football game");
{
  // Cache miss: nothing stored for this league yet, so the handler has to fetch it from ESPN.
  const res = await post({ action: 'nflForm', leagueId: '555', season: 2026 });
  const leagueCalls = calls.filter((u) => u.includes('/leagues/555'));
  // THE REGRESSION: fetchLeagueByOwner was called without a sport, defaulted to MLB, and asked the
  // baseball game (flb) for an NFL league id.
  check('the league is fetched from the NFL game (ffl)',
    leagueCalls.length > 0 && leagueCalls.every((u) => u.includes('/games/ffl/')), leagueCalls.join(' | '));
  check('...never from the baseball game (flb)', !calls.some((u) => u.includes('/games/flb/')));
  check('the request succeeds', res.statusCode === 200, `${res.statusCode} ${JSON.stringify(res.body).slice(0, 160)}`);
  const cached = store.get(scoringKey('nfl', 2026, '555'));
  check("the league's own scoring is cached — half PPR, from the football league", cached?.weights?.rec === 0.5,
    JSON.stringify(cached?.weights));

  // Cache hit: the next request uses the stored scoring and makes no ESPN call.
  const before = calls.length;
  const again = await post({ action: 'nflForm', leagueId: '555', season: 2026 });
  check('a repeat request is served from the cache, no ESPN call', calls.length === before && again.statusCode === 200);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
