// Lineup suggestions engine (Autopilot step 2). Given a user's ESPN league roster
// (players + their eligible lineup slots + the league's active slot counts) and our
// internal MLB player valuations, compute the optimal legal starting lineup and diff
// it against what's currently set — surfacing concrete "start X over Y" moves.
//
// Valuation: a player's roto value is our dataset zTotal (sum of category z-scores),
// minus an injury penalty so OUT/IL players fall out of the optimal start set. Players
// we don't rank (deep bench / non-qualifiers) get a low floor, so a known, valued
// player is preferred — but two unknowns keep the status quo (no churn for churn's sake).
import { normName } from './golf.js';
import { slotLabel, isActiveSlot } from './espnFantasy.js';

// Injury penalty in z units, keyed by our short injury label (see INJURY_LABEL).
const INJURY_PENALTY = { '': 0, Q: 0.4, DTD: 0.8, D: 1.5, O: 6, IL: 8, '60-IL': 10, SUSP: 8 };
// Only surface a value-based swap when the gain clears this (z units); injury-driven
// swaps are always surfaced. Keeps the list to moves that actually matter.
const MIN_DELTA = 1.5;
const FLOOR_Z = -5;   // value for a player we don't rank
const BE_SLOT = 16;   // bench
const IL_SLOT = 17;   // injured list

// Index our MLB dataset by normalized name → { z, pos, tag, rank }. On duplicate
// names, keep the higher-valued record.
export function buildMlbValueIndex(players = []) {
  const idx = new Map();
  for (const p of players) {
    if (typeof p.zTotal !== 'number') continue;
    const key = normName(p.name);
    if (!key) continue;
    const prev = idx.get(key);
    if (!prev || p.zTotal > prev.z) idx.set(key, { z: p.zTotal, pos: p.pos, tag: p.tag || null, rank: p.rank ?? null });
  }
  return idx;
}

function valueOf(rp, idx) {
  const rec = idx.get(normName(rp.name));
  const z = rec ? rec.z : FLOOR_Z;
  const penalty = INJURY_PENALTY[rp.injury] ?? 0;
  return { z, adjZ: z - penalty, known: !!rec, tag: rec?.tag || null, rank: rec?.rank ?? null, penalty };
}

// Expand the league's { slotId: count } into a flat list of active slot openings.
// Falls back to the slots currently filled by starters if settings are missing.
function activeOpenings(slotCounts, roster) {
  const openings = [];
  const entries = Object.entries(slotCounts || {});
  if (entries.length) {
    for (const [slotId, count] of entries) {
      const id = Number(slotId);
      if (isActiveSlot(id)) for (let i = 0; i < count; i++) openings.push(id);
    }
  }
  if (!openings.length) {
    for (const rp of roster) if (rp.starter) openings.push(rp.slotId);
  }
  return openings;
}

const eligibleFor = (rp, slotId) => {
  const slots = (rp.eligibleSlots && rp.eligibleSlots.length) ? rp.eligibleSlots : [rp.slotId];
  return slots.includes(slotId);
};

// Greedy optimal assignment: fill the most-constrained slots first (fewest eligible
// players), each with the best-value player still available. Returns Map<rosterIdx,
// slotId>. Locked players (game started) are IMMOVABLE: a locked starter is pinned to
// its current slot (that opening is consumed), and locked players are never assigned
// elsewhere — so the resulting plan never tries to move one (ESPN 409s the whole txn).
function assignOptimal(roster, openings) {
  const movable = (i) => !roster[i].locked && roster[i].slotId !== IL_SLOT;
  const assigned = new Map();
  const used = new Set();

  // Pin locked starters to the active slot they already hold; consume that opening.
  const remaining = [...openings];
  for (let i = 0; i < roster.length; i++) {
    const rp = roster[i];
    if (rp.locked && rp.starter) {
      const at = remaining.indexOf(rp.slotId);
      if (at >= 0) { remaining.splice(at, 1); assigned.set(i, rp.slotId); used.add(i); }
    }
  }

  const candCount = (slotId) => roster.reduce((n, rp, i) => n + (movable(i) && eligibleFor(rp, slotId) ? 1 : 0), 0);
  const orderedSlots = remaining
    .map((slotId) => ({ slotId, scarcity: candCount(slotId) }))
    .sort((a, b) => a.scarcity - b.scarcity);

  for (const { slotId } of orderedSlots) {
    let bestIdx = -1, bestVal = -Infinity;
    for (let i = 0; i < roster.length; i++) {
      if (used.has(i) || !movable(i) || !eligibleFor(roster[i], slotId)) continue;
      if (roster[i]._v.adjZ > bestVal) { bestVal = roster[i]._v.adjZ; bestIdx = i; }
    }
    if (bestIdx >= 0) { assigned.set(bestIdx, slotId); used.add(bestIdx); }
  }
  return assigned;
}

const meta = (rp) => `${rp.pos}${rp.proTeam ? ' · ' + rp.proTeam : ''}${rp.injury ? ' · ' + rp.injury : ''}`;

// Compute start/sit moves for one league. Returns { moves, summary } or { moves:[],
// summary:null, reason } when there's nothing to evaluate.
export function suggestLineup(league, idx) {
  const roster = (league.roster || []).map((rp) => ({ ...rp }));
  if (!roster.length) return { moves: [], summary: null, reason: 'no_roster' };
  for (const rp of roster) rp._v = valueOf(rp, idx);

  const openings = activeOpenings(league.slotCounts, roster);
  const assigned = assignOptimal(roster, openings);
  const optimal = new Set(assigned.keys());

  // Bench-but-should-start (best first); starting-but-should-sit forms the pool we
  // draw the displaced player from.
  const idxList = roster.map((rp, i) => i);
  const shouldStart = idxList.filter((i) => optimal.has(i) && !roster[i].starter)
    .sort((a, b) => roster[b]._v.adjZ - roster[a]._v.adjZ);
  const sitPool = idxList.filter((i) => !optimal.has(i) && roster[i].starter);

  const moves = [];
  for (const inIdx of shouldStart) {
    const inP = roster[inIdx];
    const slotId = assigned.get(inIdx);
    // Pair with the weakest currently-starting player who is ELIGIBLE for the slot
    // this player will take, so "start X over Y at SLOT" is positionally sensible.
    let outPos = -1, outVal = Infinity;
    for (let j = 0; j < sitPool.length; j++) {
      const oi = sitPool[j];
      if (!eligibleFor(roster[oi], slotId)) continue;
      if (roster[oi]._v.adjZ < outVal) { outVal = roster[oi]._v.adjZ; outPos = j; }
    }
    const outP = outPos >= 0 ? roster[sitPool[outPos]] : null;
    if (outP) sitPool.splice(outPos, 1);

    const delta = inP._v.adjZ - (outP ? outP._v.adjZ : FLOOR_Z);
    const injuryDriven = !!outP && (INJURY_PENALTY[outP.injury] ?? 0) >= INJURY_PENALTY.O;
    if (outP && !injuryDriven && delta < MIN_DELTA) continue;

    moves.push({
      in: inP.name, inMeta: meta(inP), inHot: inP._v.tag === 'hot',
      out: outP ? outP.name : null, outMeta: outP ? meta(outP) : '',
      slot: slotLabel(slotId),
      gain: Math.round(delta * 10) / 10,
      reason: injuryDriven ? 'injury' : (outP ? 'value' : 'empty_slot'),
    });
  }

  // Executable plan: the from→to slot move for every player whose slot should
  // change. Bench = 16; players currently on the IL (17) are never touched, and a
  // player without an ESPN id can't be moved.
  const plan = [];
  for (let i = 0; i < roster.length; i++) {
    const rp = roster[i];
    // Never move a locked player (ESPN 409s the txn), an IL player, or one w/o an id.
    if (rp.locked || rp.slotId === IL_SLOT || rp.id == null) continue;
    const target = assigned.has(i) ? assigned.get(i) : BE_SLOT;
    if (target !== rp.slotId) {
      plan.push({ playerId: rp.id, name: rp.name, fromLineupSlotId: rp.slotId, toLineupSlotId: target });
    }
  }

  const injuredStarters = roster.filter((rp) => rp.starter && (INJURY_PENALTY[rp.injury] ?? 0) >= INJURY_PENALTY.O).length;
  const totalGain = Math.round(moves.reduce((s, m) => s + (m.gain > 0 ? m.gain : 0), 0) * 10) / 10;
  return {
    moves: moves.slice(0, 6),
    plan,
    summary: { count: moves.length, injuredStarters, totalGain, optimal: moves.length === 0 },
  };
}

// Annotate each league in a fetchLeaguesWithRosters result with `.suggestions`,
// using the MLB dataset players. Best-effort: a league with no roster is left as-is.
export function attachSuggestions(result, mlbPlayers) {
  const idx = buildMlbValueIndex(mlbPlayers);
  if (!idx.size) return result;
  for (const lg of (result.leagues || [])) {
    if (lg && lg.team && Array.isArray(lg.roster) && lg.roster.length) {
      lg.suggestions = suggestLineup(lg, idx);
    }
  }
  result.suggestionsReady = true;
  return result;
}
