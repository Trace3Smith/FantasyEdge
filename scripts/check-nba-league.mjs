#!/usr/bin/env node
// Offline checks for NBA/WNBA league settings in Draft Mode: scored categories, custom lineups,
// bench → rounds, short-sample (injured) players on the draft board, and the opening-week season
// fallback. Runs the REAL dataset builder (ESPN stubbed with a synthetic league), the REAL draft
// engine, and the REAL mock-start / advise handlers (Clerk + Redis swapped for stand-ins).
//
// Pinned to a real league shape: Superstars League (ESPN NBA 117597, 2026-27) — 12-team roto,
// 8 categories with NO turnovers, PG/SG/SF/PF/C/G/F + 3 UTIL, 4 bench → 14 rounds.
//
// Usage:  npm run check:nba-league      Exit: 0 clean · 1 a check failed
import { mock } from 'node:test';

process.env.KV_REST_API_URL ||= 'https://offline.invalid';
process.env.KV_REST_API_TOKEN ||= 'offline';
delete process.env.ANTHROPIC_API_KEY; // advise falls back to the engine's own ranking — no network

let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); };
const part = (t) => console.log(`\n${t}`);

// ---- Synthetic ESPN byathlete payloads -------------------------------------------------------
const HEADER = [
  { name: 'general', names: ['gamesPlayed', 'avgMinutes', 'avgRebounds'] },
  { name: 'offensive', names: ['avgPoints', 'avgAssists', 'avgTurnovers', 'avgThreePointFieldGoalsMade', 'avgFieldGoalsMade', 'avgFieldGoalsAttempted', 'avgFreeThrowsMade', 'avgFreeThrowsAttempted', 'fieldGoalPct', 'freeThrowPct'] },
  { name: 'defensive', names: ['avgSteals', 'avgBlocks'] },
];
function athlete(id, name, pos, s) {
  return {
    athlete: { id: String(id), displayName: name, teamShortName: 'TST', position: { abbreviation: pos } },
    categories: [
      { name: 'general', totals: [s.g, s.min, s.reb] },
      { name: 'offensive', totals: [s.pts, s.ast, s.to, s.tpm, s.fgm, s.fga, s.ftm, s.fta, (100 * s.fgm / (s.fga || 1)).toFixed(1), (100 * s.ftm / (s.fta || 1)).toFixed(1)] },
      { name: 'defensive', totals: [s.stl, s.blk] },
    ],
  };
}
// Deterministic PRNG so every run builds the identical league.
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const POS = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F'];
function league({ maxGames = 82, seed = 7, extras = true } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < 240; i++) {
    const pos = POS[i % POS.length];
    const big = pos === 'C' || pos === 'PF';
    const tier = 1 - i / 240; // earlier ids are better players
    const fga = 6 + 12 * tier * (0.7 + 0.6 * r());
    const fta = 1 + 5 * tier * (0.6 + 0.8 * r());
    out.push(athlete(1000 + i, `Player ${i}`, pos, {
      g: Math.round(maxGames * (0.5 + 0.5 * r())), min: 14 + 22 * tier,
      pts: 5 + 22 * tier * (0.7 + 0.6 * r()), reb: (big ? 5 : 2) + 6 * tier * r(), ast: (big ? 1 : 2) + 6 * tier * r(),
      to: 0.6 + 2.2 * tier * r(), tpm: big ? 0.4 * r() : 0.5 + 2.5 * tier * r(),
      stl: 0.4 + 1.1 * tier * r(), blk: big ? 0.5 + 1.8 * tier * r() : 0.1 + 0.5 * r(),
      fga, fgm: fga * (big ? 0.5 + 0.08 * r() : 0.42 + 0.08 * r()), fta, ftm: fta * (big ? 0.62 + 0.15 * r() : 0.75 + 0.15 * r()),
    }));
  }
  if (extras) {
    // A ball-dominant star whose one real weakness is turnovers.
    out.push(athlete(9001, 'Turnover Star', 'PG', { g: maxGames - 2, min: 35, pts: 27, reb: 5, ast: 9.5, to: 5.2, tpm: 2.4, stl: 1.3, blk: 0.3, fgm: 9.5, fga: 20, ftm: 6.5, fta: 7.4 }));
    // An elite player who missed most of the season (well under the 40% games gate).
    out.push(athlete(9002, 'Injured Star', 'C', { g: Math.round(maxGames * 0.25), min: 34, pts: 26, reb: 12, ast: 5, to: 2.8, tpm: 1.2, stl: 1.2, blk: 2.2, fgm: 10, fga: 18.5, ftm: 5.5, fta: 7 }));
    // The same elite line over a full season — the yardstick for how much the short sample costs.
    out.push(athlete(9004, 'Healthy Twin', 'C', { g: maxGames - 2, min: 34, pts: 26, reb: 12, ast: 5, to: 2.8, tpm: 1.2, stl: 1.2, blk: 2.2, fgm: 10, fga: 18.5, ftm: 5.5, fta: 7 }));
    // A short-sample player with a clearly ordinary line: missing games must not make him look elite.
    out.push(athlete(9005, 'Injured Role Player', 'SF', { g: Math.round(maxGames * 0.25), min: 24, pts: 11, reb: 4, ast: 2.2, to: 1.4, tpm: 1.3, stl: 0.7, blk: 0.3, fgm: 4.1, fga: 9.4, ftm: 1.5, fta: 2 }));
    // A cup-of-coffee player: not enough games to be draftable at all.
    out.push(athlete(9003, 'Two Game Guy', 'SG', { g: 2, min: 22, pts: 30, reb: 4, ast: 4, to: 1, tpm: 5, stl: 2, blk: 0, fgm: 11, fga: 18, ftm: 3, fta: 3 }));
  }
  return out;
}

// Scenario the ESPN stub serves: current-season payload + prior-season payload.
let scenario = { current: { season: '2025-26', athletes: league() }, prior: { season: '2024-25', athletes: league({ seed: 11 }) } };
const lib = (p) => new URL(`../api/_lib/${p}`, import.meta.url).href;
const realEspn = await import(lib('espn.js'));
const realInj = await import(lib('espnInjuries.js'));
mock.module(lib('espn.js'), {
  namedExports: {
    ...realEspn,
    fetchByAthlete: async ({ season = null } = {}) => {
      const src = season == null ? scenario.current : scenario.prior;
      if (season != null && String(season) !== String(realEspn.priorSeasonParam(scenario.current.season))) {
        // The prior-year sidebar fetch for the PRIOR season (two back) — nothing to offer.
        return { athletes: [], categories: HEADER, season: null, skipped: 0 };
      }
      return { athletes: structuredClone(src.athletes), categories: HEADER, season: src.season, skipped: 0 };
    },
  },
});
mock.module(lib('espnInjuries.js'), { namedExports: { ...realInj, fetchInjuries: async () => new Map(), applyInjuries: () => 0 } });

// In-memory Redis + entitlement stand-ins for the handlers.
const store = new Map();
const fakeRedis = { get: async (k) => (store.has(k) ? structuredClone(store.get(k)) : null), set: async (k, v) => { store.set(k, structuredClone(v)); return 'OK'; } };
const realKv = await import(lib('kv.js'));
const realAuth = await import(lib('auth.js'));
let premiumUser = true;
mock.module(lib('kv.js'), { namedExports: { ...realKv, redis: fakeRedis } });
mock.module(lib('auth.js'), {
  namedExports: {
    ...realAuth,
    getEntitlement: async () => ({ userId: 'u1', premium: premiumUser }),
    consumeMockQuota: async () => {}, getMockUsage: async () => ({ used: 0 }),
  },
});

const { buildNbaDataset } = await import(lib('buildNbaDataset.js'));
const NBA = await import('../nbaScoring.js');
const { recommend, applyNbaLeague, DEFAULT_SETTINGS } = await import(lib('draft.js'));
const { pickRotoOpponent } = await import('../draftAI.js');
const { rotoOpenSlots } = await import('../draftRoster.js');
const { default: mockStart } = await import('../api/draft/mock-start.js');
const { default: advise } = await import('../api/draft/advise.js');

const SUPERSTARS = {
  teams: 12,
  cats: ['pts', 'reb', 'ast', 'stl', 'blk', 'tpm', 'fgPct', 'ftPct'],
  lineup: { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1, UTIL: 3 },
  bench: 4,
};
const draftPool = (ds) => ds.players.filter((p) => !p.searchOnly || p.draftEligible); // = loadPlayers
const byName = (ds, n) => ds.players.find((p) => p.name === n);
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------------------------
part('PART 1 — dataset: short-sample stars reach the draft board, rankings table unchanged');
const ds = await buildNbaDataset();
const inj = byName(ds, 'Injured Star');
const two = byName(ds, 'Two Game Guy');
check('injured star is scored (has zTotal) and flagged draftEligible + lowSample', typeof inj?.zTotal === 'number' && inj.draftEligible && inj.lowSample, `zTotal=${inj?.zTotal}`);
check('...but stays OFF the rankings table (searchOnly, no rank)', inj?.searchOnly === true && inj?.rank == null);
check('a 2-game player is NOT draftable (below the games floor)', two && !two.draftEligible && two.zTotal == null);
check('injured star lands in the draft pool', draftPool(ds).some((p) => p.name === 'Injured Star'));
{
  // The availability discount, tuned on real 2025-26 data so a star who missed most of the season
  // lands around picks 30–60 of a real board (see LOW_SAMPLE_PRIOR_FRAC). Asserted here as the
  // properties that tuning must keep, not as a fixed rank in this synthetic league:
  const ranks = NBA.nbaRankMap(draftPool(ds));
  const rk = ranks.get(inj.id);
  const twin = byName(ds, 'Healthy Twin');
  const role = byName(ds, 'Injured Role Player');
  const rkTwin = ranks.get(twin.id);
  const rkRole = ranks.get(role.id);
  check('injured star ranks BELOW the same line played over a full season (a real discount)', rk > rkTwin && inj.zTotal < twin.zTotal, `injured #${rk} (${inj.zTotal}) vs healthy twin #${rkTwin} (${twin.zTotal})`);
  check('...but keeps most of his value: still an early-round pick, not buried', rk <= 24 && inj.zTotal >= 0.6 * twin.zTotal, `board #${rk}, ${Math.round(100 * inj.zTotal / twin.zTotal)}% of the healthy value`);
  check('a short-sample player with an ordinary line stays well below the healthy elite', role.draftEligible && rkRole > 60 && rkRole > rk, `board #${rkRole}`);
}
check('counts report the basis and the short-sample count', ds.counts.basis === 'season' && ds.counts.draftEligibleLowSample >= 1, JSON.stringify({ basis: ds.counts.basis, low: ds.counts.draftEligibleLowSample }));
// Norm independence: scoring the short-sample extras must not move any ranked player's value.
{
  const saved = scenario;
  scenario = { ...saved, current: { ...saved.current, athletes: saved.current.athletes.filter((a) => a.athlete.id !== '9002') } };
  const without = await buildNbaDataset();
  scenario = saved;
  const ranked = ds.players.filter((p) => !p.searchOnly);
  const moved = ranked.filter((p) => { const q = without.players.find((x) => x.id === p.id); return !q || q.zTotal !== p.zTotal; });
  check('adding a short-sample player changes NO ranked player\'s value', moved.length === 0, `${moved.length} moved`);
}

part('PART 2 — dataset: opening-week guard ranks on the prior full season');
{
  const saved = scenario;
  scenario = { current: { season: '2026-27', athletes: league({ maxGames: 3, seed: 3 }) }, prior: { season: '2025-26', athletes: league({ seed: 7 }) } };
  const early = await buildNbaDataset();
  check('3 games into a new season → basis = prior-season', early.counts.basis === 'prior-season', early.counts.basis);
  check('...and the board is full, not a handful of players', early.counts.ranked > 150, `ranked=${early.counts.ranked}`);
  check('...labelled with the season it actually ranked', early.counts.season === '2025-26', early.counts.season);
  scenario = { current: { season: '2026-27', athletes: league({ maxGames: 20, seed: 3 }) }, prior: saved.prior };
  const later = await buildNbaDataset();
  check('20 games in → ranks on the current season again', later.counts.basis === 'season' && later.counts.season === '2026-27');
  scenario = saved;
}

part('PART 3 — league settings: sanitizing what the client sends');
{
  const lg = NBA.resolveNbaLeague(SUPERSTARS);
  check('Superstars League → 8 cats (no TO), 10 starters + 4 bench = 14 rounds', lg.cats.length === 8 && !lg.cats.includes('to') && lg.rounds === 14, JSON.stringify(lg));
  const junk = NBA.resolveNbaLeague({ cats: 'pts', lineup: 'x', bench: 'y' });
  check('junk input → standard 9-cat, default lineup, 13 rounds', junk.cats.length === 9 && junk.rounds === 13);
  check('fewer than 3 cats → standard 9 (never a 2-cat league by accident)', NBA.resolveNbaCats(['pts', 'reb']) === null);
  check('unknown cat names are dropped, board order kept', JSON.stringify(NBA.resolveNbaCats(['ftPct', 'pts', 'dunks', 'reb'])) === '["pts","reb","ftPct"]');
  const big = NBA.resolveNbaLineup({ PG: 1, SG: 1, SF: 1, PF: 1, C: 1, UTIL: 99 });
  check('an oversized UTIL is clamped (6), not trusted', big && big.UTIL === 6);
  check('an all-zero lineup is rejected (→ default)', NBA.resolveNbaLineup({ PG: 0 }) === null && NBA.nbaRosterSlots({ lineup: { PG: 0 } }).UTIL === 3);
  check('bench is clamped to 0–12', NBA.resolveNbaBench(40) === 12 && NBA.resolveNbaBench(-3) === 0);
  check('compound positions get both slot families (G-F → guard + forward)', ['PG', 'SG', 'SF', 'PF', 'UTIL'].every((s) => NBA.eligibleSlots('G-F').includes(s)));
  const s = applyNbaLeague({ ...DEFAULT_SETTINGS, sport: 'nba' }, SUPERSTARS);
  check('server applyNbaLeague: rounds 14, scoring label 8cat', s.rounds === 14 && s.scoring === '8cat' && s.cats.length === 8);
}

part('PART 4 — valuation: an unscored category neither helps nor hurts');
{
  const pool = draftPool(ds);
  const nine = NBA.CAT_KEYS;
  const eight = SUPERSTARS.cats;
  const ts = byName(ds, 'Turnover Star');
  check('default value is exactly the stored 9-cat zTotal', pool.every((p) => NBA.nbaPlayerValue(p) === p.zTotal && NBA.nbaPlayerValue(p, nine) === p.zTotal));
  check('8-cat value = 9-cat value minus the TO z', near(NBA.nbaPlayerValue(ts, eight), ts.zTotal - ts.z.to), `${NBA.nbaPlayerValue(ts, eight).toFixed(2)} vs ${(ts.zTotal - ts.z.to).toFixed(2)}`);
  const r9 = NBA.nbaRankMap(pool, nine).get(ts.id);
  const r8 = NBA.nbaRankMap(pool, eight).get(ts.id);
  check('the turnover-heavy star ranks HIGHER in a no-TO league', r8 < r9, `9-cat #${r9} → 8-cat #${r8}`);
  const w = NBA.nbaCategoryNeed(pool.slice(0, 6), eight);
  check('category need is computed over the league\'s cats only (no TO key)', !('to' in w) && Object.keys(w).length === 8);
}

part('PART 5 — engine: recommend() drafts for the league it is given');
{
  const players = draftPool(ds);
  const settings = applyNbaLeague({ ...DEFAULT_SETTINGS, sport: 'nba', teams: 12 }, SUPERSTARS);
  // A roster built to look weak in turnovers (high-TO players) — TO must never be called a need.
  const highTo = players.filter((p) => p.z && p.z.to < -1).slice(0, 4);
  const res = recommend(players, highTo.map((p) => p.id), highTo.map((p) => ({ id: p.id, pos: p.pos })), settings, 5);
  check('weak categories never include TO in a no-TO league', !res.board.weakCats.includes('TO'), `weakCats=${res.board.weakCats.join(',') || '—'}`);
  check('no candidate reason cites TO', res.candidates.every((c) => !/\bTO\b/.test(c.reasonLabel || '')));
  const rank8 = NBA.nbaRankMap(players, settings.cats);
  check('candidate board ranks are the 8-cat board, not the 9-cat rankings tab', res.candidates.every((c) => c.rank === rank8.get(c.id)));
  check('picks left uses 14 rounds', res.board.picksLeft === 14 - highTo.length, `picksLeft=${res.board.picksLeft}`);
  const std = recommend(players, [], [], { ...DEFAULT_SETTINGS, sport: 'nba', scoring: '9cat', rounds: 13 }, 1);
  const legacyTop = players.filter((p) => !p.searchOnly).slice().sort(NBA.nbaBoardCmp)[0];
  check('default (no league settings) still opens with the 9-cat #1', std.candidates[0].id === legacyTop.id, `top=${std.candidates[0].name} (${std.candidates[0].value}) legacy=${legacyTop.name} (${legacyTop.zTotal})`);
  const twoC = applyNbaLeague({ ...DEFAULT_SETTINGS, sport: 'nba' }, { lineup: { PG: 1, SG: 1, SF: 1, PF: 1, C: 2, UTIL: 2 }, bench: 5 });
  const oneC = players.find((p) => p.pos === 'C');
  const res2 = recommend(players, [oneC.id], [{ id: oneC.id, pos: 'C' }], twoC, 2);
  check('custom 2-C lineup: after one C, a C slot is still open', res2.board.needs.some((n) => n.pos === 'C' && n.gap === 1), JSON.stringify(res2.board.needs));
  check('custom lineup with no G/F slots never reports them as needs', !res2.board.needs.some((n) => n.pos === 'G' || n.pos === 'F'));
}

part('PART 6 — full 12-team, 14-round Superstars mock: every roster is legal');
{
  const players = draftPool(ds);
  const settings = applyNbaLeague({ ...DEFAULT_SETTINGS, sport: 'nba', teams: 12 }, SUPERSTARS);
  const cmp = NBA.nbaBoardCmpFor(settings.cats);
  const drafted = new Set();
  const rosters = Array.from({ length: 12 }, () => []);
  const r = rng(42);
  const USER = 6;
  for (let round = 1; round <= settings.rounds; round++) {
    const order = round % 2 ? [...Array(12).keys()] : [...Array(12).keys()].reverse();
    for (const t of order) {
      let pick;
      if (t === USER) {
        pick = recommend(players, [...drafted], rosters[t].map((p) => ({ id: p.id, pos: p.pos })), settings, round).candidates[0];
        pick = players.find((p) => p.id === pick.id);
      } else {
        const available = players.filter((p) => !drafted.has(p.id)).sort(cmp);
        pick = pickRotoOpponent({ available, have: rosters[t], lineup: settings.lineup, eligibleSlots: NBA.eligibleSlots, round, totalRounds: settings.rounds, rand: r, teamIdx: t });
      }
      drafted.add(pick.id);
      rosters[t].push(pick);
    }
  }
  const illegal = rosters.map((ro, t) => ({ t, open: rotoOpenSlots(ro, settings.lineup, NBA.eligibleSlots) }))
    .filter(({ open }) => Object.values(open).some((n) => n > 0));
  check('all 12 teams draft exactly 14 players', rosters.every((ro) => ro.length === 14));
  check('every team fills all 10 starting slots', illegal.length === 0, illegal.map((x) => `T${x.t + 1}:${JSON.stringify(x.open)}`).join(' '));
  check('nobody is drafted twice', drafted.size === 12 * 14);
}

part('PART 7 — handlers: mock-start + advise carry the league end to end');
{
  store.set(realKv.NBA_DATASET_KEY, { ...ds, version: realKv.DATASET_VERSION });
  const call = async (h, body) => {
    let status = 200; let out;
    const res = { setHeader() {}, status(c) { status = c; return this; }, json(j) { out = j; return this; } };
    await h({ method: 'POST', body, headers: {} }, res);
    return { status, out };
  };
  for (const tier of [true, false]) {
    premiumUser = tier;
    const ms = await call(mockStart, { sport: 'nba', settings: SUPERSTARS, position: 4 });
    const st = ms.out?.settings || {};
    check(`mock-start (${tier ? 'premium' : 'free'}): 8 cats, 14 rounds, user lineup echoed`, ms.status === 200 && st.cats?.length === 8 && st.rounds === 14 && st.lineup?.UTIL === 3, JSON.stringify({ s: ms.status, r: st.rounds, c: st.cats?.length }));
  }
  premiumUser = true;
  const highTo = draftPool(ds).filter((p) => p.z && p.z.to < -1).slice(0, 3);
  const ad = await call(advise, { sport: 'nba', round: 4, settings: { ...SUPERSTARS, rounds: 14 }, drafted: highTo.map((p) => p.id), roster: highTo.map((p) => ({ id: p.id, pos: p.pos })), rationale: false });
  check('advise returns candidates for the 8-cat league', ad.status === 200 && ad.out.candidates.length > 0, `status=${ad.status}`);
  check('advise board: weak cats exclude TO, picks left from 14 rounds', !(ad.out.board.weakCats || []).includes('TO') && ad.out.board.picksLeft === 11, JSON.stringify(ad.out.board));
  const ad9 = await call(advise, { sport: 'nba', round: 1, settings: { teams: 12 }, drafted: [], roster: [], rationale: false });
  check('advise with no league settings keeps the legacy 9-cat / 13-round default', ad9.status === 200 && ad9.out.board.picksLeft === 13);
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL NBA LEAGUE CHECKS PASSED');
process.exit(failed ? 1 : 0);
