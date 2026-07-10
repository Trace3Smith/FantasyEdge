// Lineup suggestions engine (Autopilot step 2). Given a user's ESPN league roster
// (players + their eligible lineup slots + the league's active slot counts) and our
// internal player valuations, compute the optimal legal starting lineup and diff it
// against what's currently set — surfacing concrete "start X over Y" moves, plus
// IL/IR management, waiver adds, and drop recommendations.
//
// The optimizer is VALUE-AGNOSTIC: it only needs one comparable number per player
// (higher = start). Two valuations feed it, selected by `sport`:
//   • MLB  → roto zTotal / blended value (sum of category z-scores, ~ -8..+15).
//   • WNBA → projected H2H Points per game (~10..50) — buildWnbaValueIndex below.
// Players we don't rank (deep bench / non-qualifiers) get a per-sport low floor, so a
// known, valued player is preferred — but two unknowns keep the status quo (no churn
// for churn's sake).
import { normName } from './golf.js';
import { slotLabel, isActiveSlot } from './espnFantasy.js';

// --- per-sport tuning ------------------------------------------------------------
// Because the two valuations live on different scales, every threshold (injury
// penalty, min swap gain, waiver gain, the floor for an unranked player) is defined
// per-sport. IL/IR slot ids differ too (MLB IL=17/bench=16; ESPN basketball IR=13/
// bench=12). `outPenalty` is the penalty at/above which a sit is treated as
// injury-driven (always surfaced, regardless of the value delta).
const SPORT_CFG = {
  mlb: {
    il: { slotId: 17, benchId: 16, label: 'IL' },
    ilEligible: new Set(['O', 'IL', '60-IL']),
    injuryPenalty: { '': 0, Q: 0.4, DTD: 0.8, D: 1.5, O: 6, IL: 8, '60-IL': 10, SUSP: 8 },
    outPenalty: 6,
    minDelta: 1.5,   // min value gain (z) to surface a value-based start/sit
    waiverGain: 2.0, // min value gain (z) to surface a waiver add/drop
    floor: -5,       // value for a player we don't rank
    deferIl: true,   // MLB games run all day → defer IL moves once the slate's underway
  },
  wnba: {
    il: { slotId: 13, benchId: 12, label: 'IR' },
    ilEligible: new Set(['O', 'IL', '60-IL']),
    // Points scale (fantasy pts/game). An OUT player must never out-rank a healthy
    // starter, so the OUT/IR penalties dwarf the largest realistic point gap.
    injuryPenalty: { '': 0, Q: 3, DTD: 5, D: 8, O: 45, IL: 55, '60-IL': 65, SUSP: 55 },
    outPenalty: 45,
    minDelta: 4,     // ~4 fantasy pts/game is a meaningful start/sit upgrade
    waiverGain: 5,   // ~5 fantasy pts/game to justify a waiver churn
    floor: 10,       // replacement-level fantasy output for an unranked body
    deferIl: false,  // WNBA sets daily; IR moves can go anytime before lock
  },
};
const cfgFor = (sport) => SPORT_CFG[sport] || SPORT_CFG.mlb;

// IL roster moves should land before the day's games start. Once it's past noon ET
// the slate is effectively underway, so a live apply suppresses IL moves (they'd risk
// locked players / waste the move) and defers them to tomorrow. The daily cron runs at
// 13:00 UTC (≈9am ET) — comfortably inside the window — so it still does IL moves.
export function isIlWindowClosed(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now)) % 24;
  return hour >= 12;
}

// Roster spots that aren't IL (active slots + bench) — used to cap activations so we
// don't overfill the roster and get the whole transaction rejected.
function nonIlCapacity(slotCounts, ilSlotId) {
  let cap = 0;
  for (const [sid, cnt] of Object.entries(slotCounts || {})) if (Number(sid) !== ilSlotId) cap += Number(cnt) || 0;
  return cap;
}

// The roto categories carried in each MLB dataset player's per-category z block
// (`p.z`). Every z is already oriented higher = better (ERA/WHIP are sign-flipped in
// the build), so a weighted value is just Σ weight[cat] × z[cat]. Default weight 1.
export const MLB_CAT_KEYS = ['r', 'hr', 'rbi', 'sb', 'avg', 'obp', 'w', 'sv', 'k', 'era', 'whip'];
// Display labels for the roto categories (match the roster card's CATS_BY_SPORT).
export const MLB_CAT_LABELS = { r: 'R', hr: 'HR', rbi: 'RBI', sb: 'SB', avg: 'BA', obp: 'OBP', w: 'W', sv: 'SV', k: 'K', era: 'ERA', whip: 'WHIP' };

// Net roto category impact of swapping `dropZc` OUT for `addZc` IN, over the league's
// scored categories. Each category's z is oriented higher = better (ERA/WHIP already
// sign-flipped in the build), so the add IMPROVES a category when its z exceeds the
// dropped player's, and WORSENS it when lower. A tiny |Δ| < CAT_EPS counts as no change
// (z noise). `cats` restricts to the league's actually-scored categories (from ESPN
// settings); falls back to all standard roto cats when unknown. Missing per-cat z →
// treated as 0 (replacement level), so a valued add still compares against an unranked
// drop.
//
// STANDINGS WEIGHTING: `ranks` (from view=mStandings, { catKey: { rank, of } }) weights
// each category by how the user currently ranks in it — gaining a category you're LAST
// in matters far more than one you already lead. Weight = rank / of ∈ (0,1]: last place
// (rank = of) → 1.0, first place → 1/of (≈0.08 in a 12-team league). `weightedNet` =
// Σ w(gained) − Σ w(lost) is the standings-aware score the engine gates and ranks waiver
// swaps on. Returns { up, down, net, weightedNet } where up/down are { cat, rank, of }
// entries ordered most-impactful (highest weight) first.
//
// Fallback weights matter: an UNKNOWN rank must never be treated as maximally urgent.
//  • No standings at all (`ranks` null) → weight 1 everywhere, so weightedNet collapses
//    to the plain category count (`net`) — the honest "we can't weight" degrade.
//  • Standings present but this category didn't resolve a rank → NEUTRAL (mid-pack) weight,
//    NOT 1.0. Defaulting an unresolved category to the top weight is what let an already-
//    dominant category (e.g. ERA at rank 1) drive a waiver suggestion that doesn't move the
//    standings — so an unknown category is assumed average, never last-place.
const CAT_EPS = 0.05;
const NEUTRAL_W = 0.5; // unresolved category when standings exist: assume mid-pack, never max
export function rotoCategoryImpact(addZc, dropZc, cats = null, ranks = null) {
  const keys = (Array.isArray(cats) && cats.length ? cats : MLB_CAT_KEYS).filter((c) => c in MLB_CAT_LABELS);
  const up = [], down = [];
  let weightedNet = 0;
  for (const c of keys) {
    const a = typeof addZc?.[c] === 'number' ? addZc[c] : 0;
    const d = typeof dropZc?.[c] === 'number' ? dropZc[c] : 0;
    const delta = a - d;
    if (Math.abs(delta) <= CAT_EPS) continue;
    const r = ranks && ranks[c];
    const w = r && r.of ? r.rank / r.of : (ranks ? NEUTRAL_W : 1);
    const entry = { cat: MLB_CAT_LABELS[c], rank: r ? r.rank : null, of: r ? r.of : null, w };
    if (delta > 0) { up.push(entry); weightedNet += w; }
    else { down.push(entry); weightedNet -= w; }
  }
  up.sort((a, b) => b.w - a.w);
  down.sort((a, b) => b.w - a.w);
  return { up, down, net: up.length - down.length, weightedNet: Math.round(weightedNet * 100) / 100 };
}

// Index our MLB dataset by normalized name → { z, pos, tag, rank }. On duplicate
// names, keep the higher-valued record. When `weights` is supplied (a per-category
// map), value = Σ weight[cat] × z[cat] over the current-season category z block —
// the user's custom roto weighting. Without weights we keep the blended model value
// (current-season z + multi-year baseline, cold-start outlier protection) so a slow
// start doesn't bench a known star.
export function buildMlbValueIndex(players = [], weights = null) {
  const custom = weights && typeof weights === 'object';
  const idx = new Map();
  for (const p of players) {
    let z;
    if (custom) {
      if (!p.z || typeof p.z !== 'object') continue; // no per-cat z (search-only) — can't weight
      z = 0;
      for (const c of MLB_CAT_KEYS) z += (typeof p.z[c] === 'number' ? p.z[c] : 0) * (weights[c] ?? 1);
    } else {
      z = typeof p.blendVal === 'number' ? p.blendVal : p.zTotal;
    }
    if (typeof z !== 'number') continue;
    const key = normName(p.name);
    if (!key) continue;
    const prev = idx.get(key);
    // Keep the per-category z block (`zc`) so the waiver engine can judge roto
    // category-by-category impact, not just aggregate value.
    if (!prev || z > prev.z) idx.set(key, { z, zc: (p.z && typeof p.z === 'object') ? p.z : null, pos: p.pos, tag: p.tag || null, rank: p.rank ?? null });
  }
  return idx;
}

// H2H Points default scoring (ESPN Points spirit). A player's total points already
// fold in their FG/FT/3PT makes, so we score the box-score AGGREGATES (not shot makes)
// to avoid double-counting. `dd` (double-double) is estimated, not counted — see below.
export const WNBA_POINTS_DEFAULTS = { pts: 1, reb: 1, ast: 1, stl: 1.5, blk: 1.5, tpm: 1, dd: 2 };

// Estimated double-doubles per game from a season-average line. We only have averages
// (not game logs), so this APPROXIMATES the rate: a DD needs the top two categories to
// each clear 10 in a game. PTS is almost always the first; the SECOND-highest category
// is the binding constraint, so we ramp on it (2nd-cat avg 6 → ~0, 10 → ~0.5, 14+ → 1).
export function estimateDoubleDoubles(n) {
  if (!n || typeof n !== 'object') return 0;
  const c = [n.pts || 0, n.reb || 0, n.ast || 0, n.stl || 0, n.blk || 0].sort((a, b) => b - a);
  if (c[0] < 10) return 0; // no category reliably reaches double digits
  return Math.max(0, Math.min(1, (c[1] - 6) / 8));
}

// Projected fantasy points per game from a per-game stat line (rec.n), under the given
// H2H Points weights (defaults if omitted). Supports an optional `to` (turnover) weight
// and a `dd` (estimated double-double) weight.
export function wnbaFantasyPoints(n, weights = WNBA_POINTS_DEFAULTS) {
  if (!n || typeof n !== 'object') return null;
  const w = weights || WNBA_POINTS_DEFAULTS;
  let v = (n.pts || 0) * (w.pts ?? 0) + (n.reb || 0) * (w.reb ?? 0) + (n.ast || 0) * (w.ast ?? 0)
    + (n.stl || 0) * (w.stl ?? 0) + (n.blk || 0) * (w.blk ?? 0) + (n.tpm || 0) * (w.tpm ?? 0);
  if (w.to) v += (n.to || 0) * w.to;                 // turnovers (typically negative)
  if (w.dd) v += estimateDoubleDoubles(n) * w.dd;    // estimated double-double bonus
  return v;
}

// Index the WNBA dataset by normalized name → { z, pos, tag, rank }, where `z` is the
// H2H Points value (fantasy pts/game) under `weights`. Mirrors buildMlbValueIndex's
// shape so suggestLineup treats both sports identically. No stat line → skipped.
export function buildWnbaValueIndex(players = [], weights = null) {
  const w = { ...WNBA_POINTS_DEFAULTS, ...(weights || {}) };
  const idx = new Map();
  for (const p of players) {
    const fp = wnbaFantasyPoints(p.n, w);
    if (typeof fp !== 'number') continue;
    const key = normName(p.name);
    if (!key) continue;
    const prev = idx.get(key);
    if (!prev || fp > prev.z) idx.set(key, { z: fp, pos: p.pos, tag: p.tag || null, rank: p.rank ?? null });
  }
  return idx;
}

// Build the right value index for a sport from that sport's cached dataset players,
// optionally under the user's custom scoring weights (per-league; null = defaults).
export function buildValueIndex(players, sport = 'mlb', weights = null) {
  return sport === 'wnba' ? buildWnbaValueIndex(players, weights) : buildMlbValueIndex(players, weights);
}

function valueOf(rp, idx, cfg) {
  const rec = idx.get(normName(rp.name));
  const z = rec ? rec.z : cfg.floor;
  const penalty = cfg.injuryPenalty[rp.injury] ?? 0;
  return { z, adjZ: z - penalty, known: !!rec, tag: rec?.tag || null, rank: rec?.rank ?? null, penalty, zc: rec?.zc || null };
}

// Expand the league's { slotId: count } into a flat list of active slot openings.
// Falls back to the slots currently filled by starters if settings are missing.
function activeOpenings(slotCounts, roster, sport, benchId, ilSlotId) {
  const openings = [];
  const entries = Object.entries(slotCounts || {});
  if (entries.length) {
    for (const [slotId, count] of entries) {
      const id = Number(slotId);
      // Exclude the bench and the (possibly auto-detected) IL/IR slot so we never treat
      // a reserve slot as a startable opening, then defer to the sport's active-slot set.
      if (id === benchId || id === ilSlotId) continue;
      if (isActiveSlot(id, sport)) for (let i = 0; i < count; i++) openings.push(id);
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
// txn) and UNRANKED players (no value — we won't bench them on a guess). Only ranked,
// unlocked, non-IL players are assigned INTO open slots.
function assignOptimal(roster, openings, ilSlotId) {
  const assignable = (i) => !roster[i].locked && roster[i].slotId !== ilSlotId && roster[i]._v.known;
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

// Compute IL + start/sit + waiver moves for one league. `sport` selects the value
// scale + IL/IR slot config; `freeAgents` (optional) enables waiver-wire suggestions.
// Returns { moves, plan, summary }. NOTE: waiver/drop suggestions are display-only —
// never in `plan` (drops are irreversible; the user executes them on ESPN).
export function suggestLineup(league, idx, sport = 'mlb', { freeAgents = [], ilWindowClosed, cats = null, ranks = null } = {}) {
  const cfg = cfgFor(sport);
  const roster = (league.roster || []).map((rp) => ({ ...rp }));
  const empty = { moves: [], plan: [], summary: { count: 0, ilMoves: 0, injuredStarters: 0, totalGain: 0, optimal: true } };
  if (!roster.length) return empty;
  for (const rp of roster) rp._v = valueOf(rp, idx, cfg);

  const IL = cfg.il;
  const benchId = IL.benchId;
  // Detect the league's REAL IL/IR slot id. The sport default (13 for WNBA) is wrong for
  // some leagues — writing an injured player to a slot the league doesn't have returns
  // ESPN 409 "Lineup slot does not exist" (TRAN_ROSTER_SLOT). Use the default when the
  // league actually has it; otherwise some leagues use a COMPRESSED slot scheme with no
  // slot 13 (e.g. a WNBA league whose lineupSlotCounts only spans 0-8). Roster slots are
  // laid out active (low ids) → bench → IL/IR (highest), so the reserve/IR slot is the
  // HIGHEST slot id present in lineupSlotCounts (confirmed: this league's IR is slot 8).
  const slotIds = new Set(Object.keys(league.slotCounts || {}).map(Number));
  let ilSlotId = IL.slotId;
  if (!slotIds.has(ilSlotId) && slotIds.size) {
    ilSlotId = Math.max(...slotIds);
  }
  // Whether the league actually has this IL/IR slot. If not, we never generate IL moves
  // (no capacity, nothing added to the executable plan) so Apply can't 409 on it.
  const ilSlotExists = slotIds.has(ilSlotId);
  const onIL = (rp) => rp.slotId === ilSlotId;

  // --- IL/IR management ---------------------------------------------------------
  // Recovered IL players (want to activate) and injured active players (want to IL).
  const recoveredIdx = roster.map((_, i) => i).filter((i) => onIL(roster[i]) && !roster[i].injury);
  const injuredIdx = roster.map((_, i) => i).filter((i) => !onIL(roster[i]) && cfg.ilEligible.has(roster[i].injury));
  const R = recoveredIdx.length, I = injuredIdx.length;
  const nonRecoveredIL = roster.filter((rp) => onIL(rp) && rp.injury).length;

  // Past the window the slate is underway — defer IL roster moves to tomorrow (the cron
  // does them pre-games). We still optimize the active lineup; only IL moves wait.
  // Sports that set daily (WNBA) don't defer.
  const ilClosed = cfg.deferIl ? (ilWindowClosed ?? isIlWindowClosed()) : false;
  const ilDeferred = ilClosed && (R > 0 || I > 0);

  // IL/IR capacity comes straight from the league's real IL/IR slot count. If the
  // league has no such slot, capacity is 0 (no IL moves) — we never invent one.
  const onIlCount = R + nonRecoveredIL;
  const ilCapacity = ilSlotExists ? (Number(league.slotCounts[ilSlotId]) || 0) : 0;
  const openIL = Math.max(0, ilCapacity - onIlCount);                                          // empty IL slots
  const roomNonIL = Math.max(0, nonIlCapacity(league.slotCounts, ilSlotId) - roster.filter((rp) => !onIL(rp)).length);

  // A recovered↔injured pair can always swap (activate one + IL the other = net-zero on
  // both rosters). Leftover recovered then need open roster room to activate; leftover
  // injured need an open IL slot. Anything we can't fit is surfaced as an IL-full warning
  // (never forced — ESPN would reject it; the user must drop someone on ESPN).
  const swaps = Math.min(R, I);
  const nActivate = swaps + Math.min(R - swaps, roomNonIL);
  const nIL = swaps + Math.min(I - swaps, openIL);

  const recByVal = [...recoveredIdx].sort((a, b) => roster[b]._v.adjZ - roster[a]._v.adjZ);
  const activateIdx = new Set(ilDeferred ? [] : recByVal.slice(0, nActivate));
  const activateBlocked = ilDeferred ? [] : recByVal.slice(nActivate);                          // can't activate (IL/roster full)

  const injByPriority = [...injuredIdx].sort((a, b) => (roster[a].starter === roster[b].starter ? 0 : roster[a].starter ? -1 : 1));
  const toILset = new Set(ilDeferred ? [] : injByPriority.slice(0, nIL));
  const ilBlocked = ilDeferred ? [] : injByPriority.slice(nIL);                                 // can't IL (IL full)

  // --- optimize the active lineup on the post-IL roster --------------------------
  const work = roster.map((rp, i) => {
    if (toILset.has(i)) return { ...rp, slotId: ilSlotId, starter: false };   // → IL (inactive)
    if (activateIdx.has(i)) return { ...rp, slotId: benchId, starter: false }; // → bench (available)
    return rp;
  });
  const assigned = assignOptimal(work, activeOpenings(league.slotCounts, work, sport, benchId, ilSlotId), ilSlotId);

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
  if (ilDeferred) {
    moves.push({ reason: 'il_deferred', ilDeferred: true, label: IL.label });
  }
  for (let i = 0; i < roster.length; i++) {
    if (toILset.has(i)) moves.push({ reason: 'il', il: true, action: 'to_il', out: roster[i].name, outMeta: meta(roster[i]), slot: IL.label });
  }
  for (const i of activateIdx) {
    const dest = assigned.has(i) ? slotLabel(assigned.get(i), sport) : 'bench';
    moves.push({ reason: 'il', il: true, action: 'from_il', in: roster[i].name, inMeta: meta(roster[i]), inHot: roster[i]._v.tag === 'hot', slot: dest, fromLabel: IL.label });
  }
  // Droppable bench players (on bench, unlocked, have an id), weakest value first —
  // shared by forced-drop and waiver suggestions (never auto-executed; drops are
  // irreversible and require the user to confirm on ESPN).
  const dropPool = roster.map((_, i) => i)
    .filter((i) => roster[i].slotId === benchId && !roster[i].locked && roster[i].id != null)
    .sort((a, b) => roster[a]._v.adjZ - roster[b]._v.adjZ);

  // FORCED DROP: a recovered IL player we can't activate because IL + roster are full.
  // Name the specific lowest-value bench player to drop (only if worth less than the
  // player we'd activate). Falls back to the generic IL-full warning if none qualifies.
  for (const ri of activateBlocked) {
    const rec = roster[ri];
    const pos = dropPool.findIndex((di) => roster[di]._v.adjZ < rec._v.adjZ);
    if (pos >= 0) {
      const d = roster[dropPool.splice(pos, 1)[0]];
      moves.push({ reason: 'drop', drop: true, slot: IL.label, dropName: d.name, dropMeta: meta(d), activate: rec.name, activateMeta: meta(rec), gain: Math.round((rec._v.adjZ - d._v.adjZ) * 10) / 10 });
    } else {
      moves.push({ reason: 'il_full', ilFull: true, action: 'cant_activate', name: rec.name, nameMeta: meta(rec), slot: IL.label });
    }
  }
  // FORCED IL/IR DROP: injured starters that can't reach the IL/IR because it's full of
  // OTHER injured players. Value EVERY player currently on the IL under the league's
  // scoring (their `_v.z`), rank them, and take the WEAKEST. If it's worth less than the
  // injured starter, recommend dropping that specific player (by name + value) to open a
  // slot and stash the injured starter there (freeing their active roster spot). If the
  // weakest IL player is worth MORE, still NAME it and show the value comparison so the
  // user can decide. Compare RAW value (`z`, not injury-penalized `adjZ`) since both are
  // injured. Rescue the most valuable injured starters first. Display-only (irreversible).
  const ilOccupantPool = roster.map((_, i) => i)
    .filter((i) => onIL(roster[i]) && roster[i].injury && !roster[i].locked && roster[i].id != null)
    .sort((a, b) => roster[a]._v.z - roster[b]._v.z); // weakest raw value first
  const r1 = (x) => Math.round(x * 10) / 10;
  const ilBlockedByVal = [...ilBlocked].sort((a, b) => roster[b]._v.z - roster[a]._v.z);
  for (const bi of ilBlockedByVal) {
    const inj = roster[bi];
    const pos = ilOccupantPool.findIndex((oi) => roster[oi]._v.z < inj._v.z);
    if (pos >= 0) {
      const d = roster[ilOccupantPool.splice(pos, 1)[0]];
      moves.push({
        reason: 'drop', drop: true, fromIl: true, slot: IL.label,
        dropName: d.name, dropMeta: meta(d), dropVal: r1(d._v.z), dropKnown: d._v.known,
        stash: inj.name, stashMeta: meta(inj), stashVal: r1(inj._v.z), stashKnown: inj._v.known,
        gain: r1(inj._v.z - d._v.z),
      });
      continue;
    }
    // No IL player is worth less than this (the most valuable remaining) injured starter
    // — so none is for the weaker ones either. NAME the weakest IL player + show the
    // value comparison so the user can make the call, then stop.
    if (ilOccupantPool.length) {
      const w = roster[ilOccupantPool[0]];
      moves.push({
        reason: 'il_full', ilFull: true, action: 'cant_il_compare', slot: IL.label,
        name: inj.name, nameMeta: meta(inj), stashVal: r1(inj._v.z), stashKnown: inj._v.known,
        weakestName: w.name, weakestMeta: meta(w), weakestVal: r1(w._v.z), weakestKnown: w._v.known,
      });
    } else {
      moves.push({ reason: 'il_full', ilFull: true, action: 'cant_il', name: inj.name, nameMeta: meta(inj), slot: IL.label });
    }
    break;
  }

  // PROACTIVE WAIVER: recommend the free agent that most improves the roster over the
  // weakest droppable bench player. For MLB ROTO a swap must clear TWO gates: it wins
  // strictly more categories than it loses (raw net > 0 — a break-even or category-losing
  // add is never a roto upgrade, even if standings weighting inflates the score; e.g.
  // adding an arm that dents a category the team already leads), AND it's standings-
  // positive (weightedNet > 0). Standings weighting therefore only PRIORITIZES among
  // genuine net-category gains — it never rescues a raw-neutral/negative swap. We pick
  // the FA with the best weighted net (aggregate value breaks ties) and attach the per-
  // category up/down breakdown (with the user's rank per cat) so the UI can show why.
  // WNBA (H2H Points) has no categories, so it keeps the scalar points-gain gate.
  if (freeAgents.length && dropPool.length) {
    const wb = roster[dropPool[0]]; // weakest remaining droppable bench player
    const roto = sport === 'mlb';
    let best = null;
    for (const fa of freeAgents) {
      const rec = idx.get(normName(fa.name));
      if (!rec || typeof rec.z !== 'number') continue;       // only suggest a free agent we can value
      if (roto) {
        const impact = rotoCategoryImpact(rec.zc, wb._v.zc, cats, ranks);
        if (impact.net <= 0 || impact.weightedNet <= 0) continue; // must gain more cats than it loses AND be standings-positive
        if (!best || impact.weightedNet > best.impact.weightedNet
          || (impact.weightedNet === best.impact.weightedNet && rec.z > best.z)) {
          best = { name: fa.name, pos: fa.pos, proTeam: fa.proTeam, z: rec.z, impact };
        }
      } else {
        if (rec.z - wb._v.z < cfg.waiverGain) continue;      // points-league value gate
        if (!best || rec.z > best.z) best = { name: fa.name, pos: fa.pos, proTeam: fa.proTeam, z: rec.z };
      }
    }
    if (best) {
      moves.push({
        reason: 'waiver', waiver: true,
        add: best.name, addMeta: `${best.pos}${best.proTeam ? ' · ' + best.proTeam : ''}`,
        drop: wb.name, dropMeta: meta(wb),
        gain: Math.round((best.z - wb._v.z) * 10) / 10,
        cats: best.impact || null,   // { up, down, net, weightedNet } for roto; null for points
      });
    }
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

    const delta = inP._v.adjZ - (outP ? outP._v.adjZ : cfg.floor);
    const injuryDriven = !!outP && (cfg.injuryPenalty[outP.injury] ?? 0) >= cfg.outPenalty;
    if (outP && !injuryDriven && delta < cfg.minDelta) continue;

    moves.push({
      in: inP.name, inMeta: meta(inP), inHot: inP._v.tag === 'hot',
      out: outP ? outP.name : null, outMeta: outP ? meta(outP) : '',
      slot: slotLabel(slotId, sport), gain: Math.round(delta * 10) / 10,
      reason: injuryDriven ? 'injury' : (outP ? 'value' : 'empty_slot'),
    });
  }

  const ilMoves = toILset.size + activateIdx.size;
  const ilFull = moves.filter((m) => m.ilFull).length;
  const waiverMoves = moves.filter((m) => m.waiver || m.drop).length;
  const injuredStarters = roster.filter((rp) => rp.starter && (cfg.injuryPenalty[rp.injury] ?? 0) >= cfg.outPenalty).length;
  // Projected value gain reflects the LINEUP changes only (not waiver/drop roster moves).
  const isLineup = (m) => !m.il && !m.ilFull && !m.waiver && !m.drop && !m.ilDeferred;
  const totalGain = Math.round(moves.filter(isLineup).reduce((s, m) => s + (m.gain > 0 ? m.gain : 0), 0) * 10) / 10;
  // Keep all special moves (IL / warnings / waiver / drop); cap only the start/sit list.
  const special = moves.filter((m) => !isLineup(m));
  const lineupMoves = moves.filter(isLineup).slice(0, 6);
  return {
    moves: [...special, ...lineupMoves],
    plan,
    summary: {
      count: moves.length, ilMoves, ilFull, waiverMoves, injuredStarters, totalGain, optimal: moves.length === 0,
      // IL/IR diagnostics (for verifying slot detection against a live league): the
      // resolved IL/IR slot, whether the league actually has it, capacity/openings, and
      // every lineup-slot id the league reports (so the real IR id is visible).
      il: { slot: ilSlotId, exists: ilSlotExists, cap: ilCapacity, open: openIL, onIl: onIlCount, injured: I, slots: [...slotIds].sort((a, b) => a - b) },
    },
  };
}
