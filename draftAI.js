// AI opponent pick logic for mock drafts. Pure and dependency-free so it can be unit-tested
// (see scripts/test-draft-ai.mjs) and imported straight into the draft board.
//
// Opponents draft like real managers: they weigh what their roster still NEEDS (open starting
// slots, positional scarcity) against who's actually available (ADP for NFL, category value for
// roto), rather than blindly taking the best ADP within a window. The result is realistic roster
// construction — teams fill QB/RB/WR/TE/FLEX, don't hoard one position, and grab their K/DST and
// other mandatory slots late instead of leaving lineups half-empty.
//
// The two entry points (pickNflOpponent / pickRotoOpponent) share one selection core:
//   1. drop candidates whose position is already at a soft cap (no 2nd kicker, no QB hoarding),
//   2. if the team can no longer afford a luxury pick (remaining picks <= remaining hard needs),
//      restrict to players that fill an open need,
//   3. otherwise take best-available nudged toward needs,
//   4. finally apply the same reach-window randomness the board has always used.
//
// `available` is the pool already sorted best-first by the caller (ADP for NFL, boardCmp for
// roto) — this module never re-derives value, so it can't drift from the board.

// The roster-need primitives (open starting needs, position caps, roto open-slot assignment) live
// in the shared draftRoster.js so the opponent AI, the rankings board, and the server recommend
// engine can't drift. Re-exported so existing importers (scripts/test-draft-ai.mjs) keep working.
import { nflOpenNeeds, nflPosCaps, rotoOpenSlots, NFL_FLEX } from './draftRoster.js';
export { nflOpenNeeds, nflPosCaps, rotoOpenSlots };

// ---- shared selection core --------------------------------------------------------------------

// The reach window: opponents usually take one of the top few, occasionally reaching a little
// deeper (the window widens later in the draft, where ADP/value is noisier). pow(rand,1.6)
// biases toward the top of the window — the best available — matching the long-standing board.
function reachPick(pool, round, rand) {
  const window = Math.min(pool.length, 3 + Math.floor(round / 3));
  return pool[Math.floor(Math.pow(rand(), 1.6) * window)];
}

// Count a roster's players per position. `have` is an array of { pos }.
function countByPos(have) {
  const c = {};
  for (const p of have) c[p.pos] = (c[p.pos] || 0) + 1;
  return c;
}

// ---- per-manager personality ------------------------------------------------------------------
// Light, deterministic variation so a mock doesn't feel like drafting against N identical bots.

// 32-bit hash — a team's personality is stable for the whole draft (seeded by its slot) yet
// differs from its neighbours, with no per-draft state to store.
function hash32(n) {
  let h = ((n + 1) * 2654435761) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13;
  return h >>> 0;
}

// Positions an NFL manager can "lean" into. K/DST are excluded — everyone needs exactly one, so
// leaning there would only break legal rosters.
const LEAN_POS = ['RB', 'WR', 'QB', 'TE'];

// A subtle manager personality from the team's draft slot. Two small knobs:
//   needBonusDelta — shifts the need-urgency bonus by -2..+2 (some managers chase needs harder).
//   leanPos        — one position this manager over-values: +1 to its soft cap (rosters one more)
//                    plus a small earliness nudge (drafts it a touch sooner) — e.g. RB-heavy, QB-early.
// teamIdx == null (the analyst's own suggestion, or any caller that doesn't identify a seat) yields
// the NEUTRAL personality, so those paths are behaviourally unchanged.
export function managerVariation(teamIdx) {
  if (teamIdx == null) return { needBonusDelta: 0, leanPos: null };
  return {
    needBonusDelta: (hash32(teamIdx) % 5) - 2,                     // -2..+2
    leanPos: LEAN_POS[hash32(teamIdx * 2 + 1) % LEAN_POS.length],  // RB / WR / QB / TE
  };
}

// ---- NFL (points flow: ADP + fixed starter slots) --------------------------------------------
// nflOpenNeeds / nflPosCaps + NFL_FLEX are imported from draftRoster.js (see top of file).

// Does a position help fill an open starting need (a specific slot, or the FLEX)?
function fillsNflNeed(pos, open) {
  if ((open.hardNeeds[pos] || 0) > 0) return true;
  if (open.flexNeed > 0 && NFL_FLEX.includes(pos)) return true;
  return false;
}

// Choose an NFL opponent's pick. `available` is ADP-sorted best-first. `teamIdx` (optional) gives
// this seat a stable manager personality; omit it for the neutral (baseline) behaviour.
export function pickNflOpponent({ available, have, starters, round, totalRounds, rand = Math.random, teamIdx = null }) {
  if (!available || !available.length) return null;
  const { needBonusDelta, leanPos } = managerVariation(teamIdx);
  const caps = nflPosCaps(starters); // fresh object per call — safe to tweak for this manager
  if (leanPos) caps[leanPos] = (caps[leanPos] ?? Infinity) + 1; // leans into one position (never K/DST)
  const counts = countByPos(have);

  // Respect caps — but never return nothing: if the whole pool is capped positions, ignore caps.
  let pool = available.filter((p) => (counts[p.pos] || 0) < (caps[p.pos] ?? Infinity));
  if (!pool.length) pool = available.slice();

  const open = nflOpenNeeds(starters, have);
  const remaining = Math.max(1, totalRounds - have.length); // picks this team still has (incl. now)
  const mustFill = remaining <= open.totalHard + open.flexNeed;

  if (open.totalHard + open.flexNeed > 0 && mustFill) {
    // No room left for luxury picks — only take players that fill an open lineup slot.
    const needed = pool.filter((p) => fillsNflNeed(p.pos, open));
    return reachPick(needed.length ? needed : pool, round, rand);
  }

  // Best-available, nudged toward needs: a needed player jumps up the board by a bounded bonus
  // (larger later in the draft), so needs win ties and small ADP gaps but a clearly better player
  // at a non-need position can still go. `idx` is the player's ADP rank within the pool.
  const scored = pool
    .map((player, idx) => {
      let bonus = 0;
      if ((open.hardNeeds[player.pos] || 0) > 0) bonus = Math.max(1, 6 + round + needBonusDelta);
      else if (open.flexNeed > 0 && NFL_FLEX.includes(player.pos)) bonus = 3;
      if (player.pos === leanPos) bonus += 2; // over-valued position drafts a touch earlier
      return { player, priority: idx - bonus };
    })
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.player);
  return reachPick(scored, round, rand);
}

// ---- Roto (category flow: no ADP, lineup slots via eligibility) --------------------------------
// rotoOpenSlots is imported from draftRoster.js (see top of file) — the same greedy open-slot
// assignment the per-sport scoring modules now delegate to, so opponents and the board never drift.

// UTIL/BENCH take anyone, so they never represent positional scarcity — only "specific" open
// slots count as a genuine need (and drive the must-fill switch).
const ROTO_SOFT_SLOTS = new Set(['UTIL', 'BENCH']);

// Soft cap for a roto position: the total lineup demand across every slot it's eligible for,
// plus a little bench room. Stops opponents from stacking a single position.
function rotoPosCap(pos, lineup, eligibleSlots) {
  let cap = 0;
  for (const slot of eligibleSlots(pos)) cap += Number(lineup[slot]) || 0;
  return cap + 2;
}

// Choose a roto opponent's pick. `available` is board-value-sorted best-first. `teamIdx` (optional)
// gives this seat a stable manager personality; omit it for the neutral behaviour.
export function pickRotoOpponent({ available, have, lineup, eligibleSlots, round, totalRounds, rand = Math.random, teamIdx = null }) {
  if (!available || !available.length) return null;
  const { needBonusDelta } = managerVariation(teamIdx); // roto varies the need bonus only (slots are hard)
  const counts = countByPos(have);

  let pool = available.filter((p) => (counts[p.pos] || 0) < rotoPosCap(p.pos, lineup, eligibleSlots));
  if (!pool.length) pool = available.slice();

  const open = rotoOpenSlots(have, lineup, eligibleSlots);
  const specificNeed = Object.entries(open).reduce((n, [slot, c]) => n + (ROTO_SOFT_SLOTS.has(slot) ? 0 : c), 0);
  const remaining = Math.max(1, totalRounds - have.length);
  const fillsSpecific = (pos) => eligibleSlots(pos).some((slot) => !ROTO_SOFT_SLOTS.has(slot) && (open[slot] || 0) > 0);

  if (specificNeed > 0 && remaining <= specificNeed) {
    const needed = pool.filter((p) => fillsSpecific(p.pos));
    return reachPick(needed.length ? needed : pool, round, rand);
  }

  const needBonus = Math.max(1, 5 + needBonusDelta);
  const scored = pool
    .map((player, idx) => ({ player, priority: idx - (fillsSpecific(player.pos) ? needBonus : 0) }))
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.player);
  return reachPick(scored, round, rand);
}
