// Focused tests for the AI opponent draft logic (draftAI.js): realistic roster construction.
// Plain node, no framework — run with `node scripts/test-draft-ai.mjs` (see package.json test:draft).
//
// The point of these tests is behavioural, not cosmetic: drive FULL simulated drafts where every
// seat is an AI opponent and assert each team ends with a legal, realistic roster — starters
// filled, no position hoarded, K/DST taken exactly once and late. Blind best-ADP drafting (the old
// behaviour) fails these: with K/DST parked at the end of ADP, some teams never draft one.

import assert from 'node:assert/strict';
import {
  pickNflOpponent, pickRotoOpponent, nflOpenNeeds, nflPosCaps, rotoOpenSlots, managerVariation,
} from '../draftAI.js';
import { DEFAULT_LINEUP as nbaLineup, eligibleSlots as nbaElig } from '../nbaScoring.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// Deterministic RNG so the sim is reproducible across runs/CI.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const countByPos = (roster) => roster.reduce((c, p) => ((c[p.pos] = (c[p.pos] || 0) + 1), c), {});
const snakeTeam = (i, teams) => (Math.floor(i / teams) % 2 === 0 ? i % teams : teams - 1 - (i % teams));

// Build an ADP-ordered NFL pool. K/DST are deliberately parked at the very end of ADP so the test
// proves need-awareness (not ADP) is what makes teams draft them.
function nflPool() {
  const pool = [];
  let id = 0;
  const add = (pos, n) => { for (let i = 0; i < n; i++) pool.push({ id: id++, pos }); };
  // Interleave skill positions across the meaningful ADP range.
  const skill = [];
  const push = (pos, n) => { for (let i = 0; i < n; i++) skill.push(pos); };
  push('RB', 60); push('WR', 60); push('QB', 30); push('TE', 20);
  // Shuffle-ish but deterministic interleave: RB/WR heavy early, QB/TE sprinkled.
  const order = [];
  const pools = { RB: skill.filter((p) => p === 'RB'), WR: skill.filter((p) => p === 'WR'), QB: skill.filter((p) => p === 'QB'), TE: skill.filter((p) => p === 'TE') };
  const seq = ['RB', 'WR', 'RB', 'WR', 'QB', 'TE', 'WR', 'RB'];
  let si = 0;
  while (pools.RB.length || pools.WR.length || pools.QB.length || pools.TE.length) {
    const pos = seq[si++ % seq.length];
    if (pools[pos].length) order.push(pools[pos].pop());
  }
  for (const pos of order) add(pos, 1);
  add('K', 12); add('DST', 12); // parked last in ADP on purpose
  return pool;
}

// Run a full snake draft with every seat driven by the opponent AI; return each team's roster.
function simulate(pickFn, { teams, rounds, pool, extra = () => ({}) }) {
  const rosters = Array.from({ length: teams }, () => []);
  const drafted = new Set();
  const total = teams * rounds;
  for (let i = 0; i < total; i++) {
    const team = snakeTeam(i, teams);
    const round = Math.floor(i / teams) + 1;
    const available = pool.filter((p) => !drafted.has(p.id));
    const pick = pickFn({ available, have: rosters[team], round, totalRounds: rounds, teamIdx: team, ...extra() });
    assert.ok(pick, `pick returned for overall ${i} (round ${round}, team ${team})`);
    drafted.add(pick.id);
    rosters[team].push({ id: pick.id, pos: pick.pos });
  }
  return rosters;
}

console.log('draftAI — NFL need/cap unit checks');

test('nflOpenNeeds: empty roster needs every starter + FLEX', () => {
  const starters = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
  const o = nflOpenNeeds(starters, []);
  assert.deepEqual(o.hardNeeds, { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 });
  assert.equal(o.totalHard, 8);
  assert.equal(o.flexNeed, 1);
});

test('nflOpenNeeds: RB/WR/TE surplus absorbs the FLEX', () => {
  const starters = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
  const have = [{ pos: 'RB' }, { pos: 'RB' }, { pos: 'RB' }]; // 3 RBs => 1 flex-eligible surplus
  const o = nflOpenNeeds(starters, have);
  assert.equal(o.hardNeeds.RB, undefined, 'RB starter need satisfied');
  assert.equal(o.flexNeed, 0, 'surplus RB covers FLEX');
});

test('nflPosCaps: K/DST hard-capped at 1, QB/TE at starter+1', () => {
  const caps = nflPosCaps({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 });
  assert.equal(caps.K, 1);
  assert.equal(caps.DST, 1);
  assert.equal(caps.QB, 2);
  assert.equal(caps.TE, 2);
  assert.ok(caps.RB >= 5 && caps.WR >= 5, 'RB/WR stay deep for FLEX/bench');
});

test('must-fill: a team down to its last pick takes the needed K over better-ADP skill players', () => {
  const starters = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
  // Roster already has 14 of 15 players, everything but a kicker.
  const have = [
    { pos: 'QB' }, { pos: 'RB' }, { pos: 'RB' }, { pos: 'RB' }, { pos: 'WR' }, { pos: 'WR' },
    { pos: 'WR' }, { pos: 'TE' }, { pos: 'TE' }, { pos: 'DST' }, { pos: 'RB' }, { pos: 'WR' },
    { pos: 'QB' }, { pos: 'WR' },
  ];
  const available = [{ id: 1, pos: 'RB' }, { id: 2, pos: 'WR' }, { id: 3, pos: 'K' }];
  const pick = pickNflOpponent({ available, have, starters, round: 15, totalRounds: 15, rand: () => 0 });
  assert.equal(pick.pos, 'K', 'forced to fill the only open mandatory slot');
});

test('caps: never drafts a 2nd DST even if it tops the pool', () => {
  const starters = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
  const have = [{ pos: 'DST' }];
  const available = [{ id: 1, pos: 'DST' }, { id: 2, pos: 'RB' }];
  const pick = pickNflOpponent({ available, have, starters, round: 8, totalRounds: 15, rand: () => 0 });
  assert.notEqual(pick.pos, 'DST', 'DST already capped at 1');
});

console.log('draftAI — full NFL snake draft produces realistic rosters');

test('every team fills its lineup (10-team, 15-round, K/DST parked last in ADP)', () => {
  const starters = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 };
  const rand = mulberry32(20260824);
  const rosters = simulate(
    (args) => pickNflOpponent({ ...args, starters, rand }),
    { teams: 10, rounds: 15, pool: nflPool() },
  );
  const caps = nflPosCaps(starters);
  rosters.forEach((roster, t) => {
    const c = countByPos(roster);
    assert.equal(roster.length, 15, `team ${t} drafted a full roster`);
    assert.ok((c.QB || 0) >= 1, `team ${t} has a QB`);
    assert.ok((c.RB || 0) >= 2, `team ${t} has 2+ RB`);
    assert.ok((c.WR || 0) >= 2, `team ${t} has 2+ WR`);
    assert.ok((c.TE || 0) >= 1, `team ${t} has a TE`);
    assert.equal(c.K || 0, 1, `team ${t} has exactly one K`);
    assert.equal(c.DST || 0, 1, `team ${t} has exactly one DST`);
    // FLEX covered: RB+WR+TE beyond their own starter minimums leaves at least one for FLEX.
    const flexEligible = (c.RB || 0) + (c.WR || 0) + (c.TE || 0);
    assert.ok(flexEligible >= 6, `team ${t} can fill RB/WR/TE starters + FLEX (${flexEligible})`);
    // No position hoarded past its cap — using THIS manager's caps (a leaned position gets +1).
    const { leanPos } = managerVariation(t);
    const teamCaps = { ...caps };
    if (leanPos) teamCaps[leanPos] = teamCaps[leanPos] + 1;
    for (const [pos, n] of Object.entries(c)) {
      assert.ok(n <= (teamCaps[pos] ?? Infinity), `team ${t} within cap for ${pos} (${n} <= ${teamCaps[pos]})`);
    }
  });
});

console.log('draftAI — per-manager personality');

test('managerVariation: neutral for null, deterministic + varied across seats', () => {
  // Null seat (analyst suggestion / unidentified caller) is the neutral baseline.
  assert.deepEqual(managerVariation(null), { needBonusDelta: 0, leanPos: null });
  // Deterministic: same seat -> same personality every time.
  assert.deepEqual(managerVariation(3), managerVariation(3));
  // Subtle bounds: need-bonus delta stays within -2..+2; lean is a real skill position (never K/DST).
  const seats = Array.from({ length: 12 }, (_, i) => managerVariation(i));
  for (const v of seats) {
    assert.ok(v.needBonusDelta >= -2 && v.needBonusDelta <= 2, `delta in range (${v.needBonusDelta})`);
    assert.ok(['RB', 'WR', 'QB', 'TE'].includes(v.leanPos), `lean is a skill pos (${v.leanPos})`);
  }
  // Managers aren't all identical: a 12-team league shows more than one distinct personality.
  const distinct = new Set(seats.map((v) => `${v.needBonusDelta}:${v.leanPos}`));
  assert.ok(distinct.size >= 4, `personalities vary across seats (${distinct.size} distinct)`);
});

console.log('draftAI — full roto (NBA) snake draft fills lineup slots');

test('every roto team fills its specific starting slots, no position hoarded', () => {
  // Positional pool sized to satisfy 10 teams' lineups with room to spare.
  const pool = [];
  let id = 0;
  const add = (pos, n) => { for (let i = 0; i < n; i++) pool.push({ id: id++, pos }); };
  add('PG', 30); add('SG', 30); add('SF', 30); add('PF', 30); add('C', 20);
  const rand = mulberry32(7);
  const rosters = simulate(
    (args) => pickRotoOpponent({ ...args, lineup: nbaLineup, eligibleSlots: nbaElig, rand }),
    { teams: 10, rounds: 13, pool },
  );
  rosters.forEach((roster, t) => {
    const open = rotoOpenSlots(roster, nbaLineup, nbaElig);
    const specificOpen = Object.entries(open).filter(([slot]) => slot !== 'UTIL' && slot !== 'BENCH');
    assert.equal(specificOpen.length, 0, `team ${t} left no specific slot open: ${JSON.stringify(open)}`);
    // Sanity: no single position beyond a sane cap (its eligible-slot demand + 2).
    const c = countByPos(roster);
    for (const [pos, n] of Object.entries(c)) {
      const cap = nbaElig(pos).reduce((s, slot) => s + (nbaLineup[slot] || 0), 0) + 2;
      assert.ok(n <= cap, `team ${t} within cap for ${pos} (${n} <= ${cap})`);
    }
  });
});

console.log(`\nAll ${passed} draftAI tests passed.`);
