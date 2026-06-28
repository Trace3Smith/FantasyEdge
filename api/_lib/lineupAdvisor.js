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

// Injured-reserve slot is sport-specific (MLB 'IL' slot 17; NFL 'IR' slot 21;
// NBA 'IL'/'IR'; NHL 'IR'). Only MLB is wired up today — add a row to extend.
const IL_CONFIG = {
  mlb: { slotId: 17, benchId: 16, label: 'IL' },
  // nfl: { slotId: 21, benchId: 20, label: 'IR' },
  // nhl: { slotId: ?,  benchId: ?,  label: 'IR' },
  // nba: { slotId: ?,  benchId: ?,  label: 'IL' },
};
// Injury labels (see INJURY_LABEL) that qualify a player for an IL/IR slot.
const IL_ELIGIBLE = new Set(['O', 'IL', '60-IL']);

// Roster spots that aren't IL (active slots + bench) — used to cap activations so we
// don't overfill the roster and get the whole transaction rejected.
function nonIlCapacity(slotCounts, ilSlotId) {
  let cap = 0;
  for (const [sid, cnt] of Object.entries(slotCounts || {})) if (Number(sid) !== ilSlotId) cap += Number(cnt) || 0;
  return cap;
}

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
// slotId>. Two kinds of players are IMMOVABLE and get pinned to the slot they already
// hold (consuming that opening): LOCKED players (game started — ESPN 409s the whole
// txn) and UNRANKED players (minor leaguers / no MLB value — we won't bench them on a
// guess). Only ranked, unlocked, non-IL players are assigned INTO open slots, so we
// never recommend starting a minor leaguer.
function assignOptimal(roster, openings) {
  const assignable = (i) => !roster[i].locked && roster[i].slotId !== IL_SLOT && roster[i]._v.known;
  const assigned = new Map();
  const used = new Set();

  // Pin a starter we won't move (locked, or unranked) to its current active slot.
  const remaining = [...openings];
  for (let i = 0; i < roster.length; i++) {
    const rp = roster[i];
    if (rp.starter && (rp.locked || !rp._v.known)) {
      const at = remaining.indexOf(rp.slotId);
      if (at >= 0) { remaining.splice(at, 1); assigned.set(i, rp.slotId); used.add(i); }
    }
  }

  const candCount = (slotId) => roster.reduce((n, rp, i) => n + (assignable(i) && eligibleFor(rp, slotId) ? 1 : 0), 0);
  const orderedSlots = remaining
    .map((slotId) => ({ slotId, scarcity: candCount(slotId) }))
    .sort((a, b) => a.scarcity - b.scarcity);

  for (const { slotId } of orderedSlots) {
    let bestIdx = -1, bestVal = -Infinity;
    for (let i = 0; i < roster.length; i++) {
      if (used.has(i) || !assignable(i) || !eligibleFor(roster[i], slotId)) continue;
      if (roster[i]._v.adjZ > bestVal) { bestVal = roster[i]._v.adjZ; bestIdx = i; }
    }
    if (bestIdx >= 0) { assigned.set(bestIdx, slotId); used.add(bestIdx); }
  }
  return assigned;
}

const meta = (rp) => `${rp.pos}${rp.proTeam ? ' · ' + rp.proTeam : ''}${rp.injury ? ' · ' + rp.injury : ''}`;

// Compute IL + start/sit moves for one league. `sport` selects the IL/IR slot config.
// Returns { moves, plan, summary }.
export function suggestLineup(league, idx, sport = 'mlb') {
  const roster = (league.roster || []).map((rp) => ({ ...rp }));
  const empty = { moves: [], plan: [], summary: { count: 0, ilMoves: 0, injuredStarters: 0, totalGain: 0, optimal: true } };
  if (!roster.length) return empty;
  for (const rp of roster) rp._v = valueOf(rp, idx);

  const IL = IL_CONFIG[sport] || IL_CONFIG.mlb;
  const ilSlotId = IL.slotId, benchId = IL.benchId;
  const onIL = (rp) => rp.slotId === ilSlotId;

  // --- IL management ------------------------------------------------------------
  // Activate IL players who've recovered (injury cleared); move OUT/IL-status active
  // players onto open IL slots (starters first, to free their active spot).
  const activateIdx = new Set();
  roster.forEach((rp, i) => { if (onIL(rp) && !rp.injury) activateIdx.add(i); });

  const ilCapacity = Number(league.slotCounts?.[ilSlotId]) || 0;
  const stayingIL = roster.filter((rp, i) => onIL(rp) && !activateIdx.has(i)).length;
  let availableIL = ilCapacity - stayingIL;

  const toILset = new Set();
  roster.map((rp, i) => ({ rp, i }))
    .filter(({ rp }) => !onIL(rp) && IL_ELIGIBLE.has(rp.injury))
    .sort((a, b) => (a.rp.starter === b.rp.starter ? 0 : a.rp.starter ? -1 : 1))
    .forEach(({ i }) => { if (availableIL > 0) { toILset.add(i); availableIL--; } });

  // Cap activations by non-IL roster room (IL-ing someone frees a spot); activate the
  // highest-value recovered players first. Avoids overfilling → whole-txn rejection.
  let room = nonIlCapacity(league.slotCounts, ilSlotId) - roster.filter((rp) => !onIL(rp)).length + toILset.size;
  for (const i of [...activateIdx].sort((a, b) => roster[b]._v.adjZ - roster[a]._v.adjZ)) {
    if (room > 0) room--; else activateIdx.delete(i);
  }

  // --- optimize the active lineup on the post-IL roster --------------------------
  const work = roster.map((rp, i) => {
    if (toILset.has(i)) return { ...rp, slotId: ilSlotId, starter: false };   // → IL (inactive)
    if (activateIdx.has(i)) return { ...rp, slotId: benchId, starter: false }; // → bench (available)
    return rp;
  });
  const assigned = assignOptimal(work, activeOpenings(league.slotCounts, work));

  const finalSlot = (i) => {
    const rp = roster[i];
    if (toILset.has(i)) return ilSlotId;
    if (activateIdx.has(i)) return assigned.has(i) ? assigned.get(i) : benchId;
    if (onIL(rp)) return ilSlotId;                    // staying on IL — untouched
    if (rp.locked || !rp._v.known) return rp.slotId;  // immovable
    return assigned.has(i) ? assigned.get(i) : benchId;
  };

  // --- executable plan ----------------------------------------------------------
  const plan = [];
  for (let i = 0; i < roster.length; i++) {
    const rp = roster[i];
    if (rp.id == null) continue;
    const target = finalSlot(i);
    if (target !== rp.slotId) {
      plan.push({ playerId: rp.id, name: rp.name, fromLineupSlotId: rp.slotId, toLineupSlotId: target, il: toILset.has(i) || activateIdx.has(i) });
    }
  }

  // --- display moves: IL moves first, then start/sit ----------------------------
  const moves = [];
  for (let i = 0; i < roster.length; i++) {
    if (toILset.has(i)) moves.push({ reason: 'il', il: true, action: 'to_il', out: roster[i].name, outMeta: meta(roster[i]), slot: IL.label });
  }
  for (const i of activateIdx) {
    const dest = assigned.has(i) ? slotLabel(assigned.get(i)) : 'bench';
    moves.push({ reason: 'il', il: true, action: 'from_il', in: roster[i].name, inMeta: meta(roster[i]), inHot: roster[i]._v.tag === 'hot', slot: dest, fromLabel: IL.label });
  }

  const ilHandled = new Set([...toILset, ...activateIdx]);
  const optimal = new Set(assigned.keys());
  const idxList = roster.map((_, i) => i);
  const shouldStart = idxList.filter((i) => optimal.has(i) && !work[i].starter && !ilHandled.has(i))
    .sort((a, b) => roster[b]._v.adjZ - roster[a]._v.adjZ);
  const sitPool = idxList.filter((i) => !optimal.has(i) && work[i].starter && roster[i]._v.known && !roster[i].locked && !ilHandled.has(i));

  for (const inIdx of shouldStart) {
    const inP = roster[inIdx];
    const slotId = assigned.get(inIdx);
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
      slot: slotLabel(slotId), gain: Math.round(delta * 10) / 10,
      reason: injuryDriven ? 'injury' : (outP ? 'value' : 'empty_slot'),
    });
  }

  const ilMoves = toILset.size + activateIdx.size;
  const injuredStarters = roster.filter((rp) => rp.starter && (INJURY_PENALTY[rp.injury] ?? 0) >= INJURY_PENALTY.O).length;
  const totalGain = Math.round(moves.reduce((s, m) => s + (m.gain > 0 ? m.gain : 0), 0) * 10) / 10;
  return {
    moves: moves.slice(0, 8),
    plan,
    summary: { count: moves.length, ilMoves, injuredStarters, totalGain, optimal: moves.length === 0 },
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
