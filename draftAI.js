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

// ---- NFL (points flow: ADP + fixed starter slots) --------------------------------------------

const NFL_FLEX = ['RB', 'WR', 'TE']; // positions a FLEX slot can absorb

// Open MANDATORY starting needs for an NFL roster, given league `starters` counts and what the
// team already `have`. FLEX is handled last: it's only "needed" once RB/WR/TE surplus (players
// beyond their own starter counts) can't cover it. Mirrors the board's openStartingNeeds model.
export function nflOpenNeeds(starters, have) {
  const counts = countByPos(have);
  const hardNeeds = {};
  let totalHard = 0;
  for (const [pos, n] of Object.entries(starters || {})) {
    if (pos === 'FLEX') continue;
    const need = Math.max(0, (Number(n) || 0) - (counts[pos] || 0));
    if (need > 0) { hardNeeds[pos] = need; totalHard += need; }
  }
  let surplus = 0;
  for (const pos of NFL_FLEX) surplus += Math.max(0, (counts[pos] || 0) - (Number(starters?.[pos]) || 0));
  const flexNeed = Math.max(0, (Number(starters?.FLEX) || 0) - surplus);
  return { hardNeeds, totalHard, flexNeed };
}

// Soft per-position caps: how many of a position a sane manager will roster. K/DST are capped at
// their (single) starter slot — nobody drafts two defenses; QB/TE get one backup; RB/WR stay
// deep for FLEX and bench. Prevents the "5 QBs, no kicker" rosters blind-ADP drafting produced.
export function nflPosCaps(starters) {
  const s = starters || {};
  const flex = Number(s.FLEX) || 0;
  return {
    QB: (Number(s.QB) || 1) + 1,
    TE: (Number(s.TE) || 1) + 1,
    K: Number(s.K) || 1,
    DST: Number(s.DST) || 1,
    RB: (Number(s.RB) || 2) + flex + 3,
    WR: (Number(s.WR) || 2) + flex + 3,
  };
}

// Does a position help fill an open starting need (a specific slot, or the FLEX)?
function fillsNflNeed(pos, open) {
  if ((open.hardNeeds[pos] || 0) > 0) return true;
  if (open.flexNeed > 0 && NFL_FLEX.includes(pos)) return true;
  return false;
}

// Choose an NFL opponent's pick. `available` is ADP-sorted best-first.
export function pickNflOpponent({ available, have, starters, round, totalRounds, rand = Math.random }) {
  if (!available || !available.length) return null;
  const caps = nflPosCaps(starters);
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
      if ((open.hardNeeds[player.pos] || 0) > 0) bonus = 6 + round;
      else if (open.flexNeed > 0 && NFL_FLEX.includes(player.pos)) bonus = 3;
      return { player, priority: idx - bonus };
    })
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.player);
  return reachPick(scored, round, rand);
}

// ---- Roto (category flow: no ADP, lineup slots via eligibility) --------------------------------

// Which starting slots are still open given a roster, by greedy most-specific-first assignment.
// Ported from the per-sport scoring modules (nba/mlb/nhlScoring openSlots) so this stays a pure,
// import-free module. `lineup` = slot->count; `eligibleSlots(pos)` = slots a position can fill,
// ordered tight->flex.
export function rotoOpenSlots(have, lineup, eligibleSlots) {
  const open = { ...lineup };
  for (const p of have) {
    for (const slot of eligibleSlots(p.pos)) {
      if (open[slot] > 0) { open[slot] -= 1; break; }
    }
  }
  const out = {};
  for (const [slot, n] of Object.entries(open)) if (n > 0) out[slot] = n;
  return out;
}

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

// Choose a roto opponent's pick. `available` is board-value-sorted best-first.
export function pickRotoOpponent({ available, have, lineup, eligibleSlots, round, totalRounds, rand = Math.random }) {
  if (!available || !available.length) return null;
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

  const scored = pool
    .map((player, idx) => ({ player, priority: idx - (fillsSpecific(player.pos) ? 5 : 0) }))
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.player);
  return reachPick(scored, round, rand);
}
