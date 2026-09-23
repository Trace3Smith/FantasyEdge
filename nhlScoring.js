// Single source of truth for NHL (standard roto) category value + draft logic. The hockey
// analog of nbaScoring.js / mlbScoring.js — fantasy hockey is a CATEGORY game split between
// skaters and goalies. Shared by the server draft engine (api/_lib/draft.js) and the draft
// front end (fantasyedge-draft.html) so value and roster-need have ONE definition per surface.
// Pure ESM, no dependencies.
//
// buildNhlDataset.js z-scores skaters across their skater cats and goalies across their goalie
// cats (on a comparable standardized scale), then exposes on each ranked record:
//   • z      — per-category z block keyed by CAT_KEYS (own group filled, other group 0)
//   • zTotal — the summed value (the board ordering)
// Skaters carry zero in the goalie cats and vice-versa, so a roster's category profile spans
// both groups — categoryNeed steers a skater-heavy roster toward goalies once the skaters fill.

// The standard categories, in board order. `group` ('s' skater / 'g' goalie) is used only for
// labels/iteration; each cat's sign is already folded into the stored z (GAA is inverted).
import { rotoOpenSlots } from './draftRoster.js'; // shared greedy open-slot assignment (single source)

// DEF (defensemen points) is a skater category that only D-eligible players can contribute to,
// so it is standardized over the defensemen pool alone and left at 0 for forwards — the same
// "own group filled, other group 0" rule that separates skaters from goalies.
export const NHL_CATS = [
  { key: 'g', label: 'G', group: 's' },
  { key: 'a', label: 'A', group: 's' },
  { key: 'pm', label: '+/-', group: 's' },
  { key: 'pim', label: 'PIM', group: 's' },
  { key: 'ppp', label: 'PPP', group: 's' },
  { key: 'sog', label: 'SOG', group: 's' },
  { key: 'hit', label: 'HIT', group: 's' },
  { key: 'blk', label: 'BLK', group: 's' },
  { key: 'def', label: 'DEF', group: 's' },
  { key: 'w', label: 'W', group: 'g' },
  { key: 'gaa', label: 'GAA', group: 'g' },
  { key: 'svpct', label: 'SV%', group: 'g' },
];
export const CAT_KEYS = NHL_CATS.map((c) => c.key);
export const CAT_LABEL = Object.fromEntries(NHL_CATS.map((c) => [c.key, c.label]));

export function value(p) {
  return p && typeof p.zTotal === 'number' ? p.zTotal : 0;
}

// ---- Roster slots + positional eligibility --------------------------------------------------
// A standard fantasy-hockey lineup: a pooled forward group, a deep blue line, two goalies and
// one UTIL that takes any skater. Bench depth lives in `rounds`. Leagues that split forwards
// into C/LW/RW slots are still supported through `settings.lineup` and the eligibility below.
export const DEFAULT_LINEUP = { F: 9, D: 5, G: 2, UTIL: 1 };

// Slots each position can fill, ordered tight -> flex, so the greedy assignment in
// rotoOpenSlots claims the most specific slot first. UTIL takes any SKATER: goalies are
// deliberately excluded so a spare goalie can never absorb a skater slot.
const SLOT_ELIGIBILITY = {
  C: ['C', 'F', 'UTIL'],
  LW: ['LW', 'F', 'UTIL'],
  RW: ['RW', 'F', 'UTIL'],
  D: ['D', 'UTIL'],
  G: ['G'],
  F: ['C', 'LW', 'RW', 'F', 'UTIL'],
};

export function eligibleSlots(pos) {
  return SLOT_ELIGIBILITY[pos] || ['F', 'UTIL'];
}

export function rosterSlots(settings = {}) {
  return { ...DEFAULT_LINEUP, ...(settings.lineup || {}) };
}

export function openSlots(roster, settings = {}) {
  return rotoOpenSlots(roster, rosterSlots(settings), eligibleSlots); // shared greedy assignment
}

export function fillsOpenSlot(pos, open) {
  return eligibleSlots(pos).some((slot) => (open[slot] || 0) > 0);
}

export function bestOpenSlot(pos, open) {
  for (const slot of eligibleSlots(pos)) if ((open[slot] || 0) > 0) return slot;
  return null;
}

// Open slots that are positionally MEANINGFUL: everything except UTIL, which takes any skater
// and so never represents scarcity or forces a pick. Mirrors mlbScoring/nbaScoring.
export function specificOpenSlots(roster, settings = {}) {
  const open = openSlots(roster, settings);
  delete open.UTIL;
  return open;
}

// Roster-construction caps, the hockey analog of nflPosCaps' QB/TE rule. `demand` is how many
// starting slots the position can actually fill; past that a player is bench depth, and past
// `cap` he is dead weight the engine won't rank at all.
//
// Goalies are the tight one: only two start, and a season GP cap means a third goalie's starts
// mostly cannot be used. So goalies get exactly one backup (cap 3, never a 4th), while skaters
// keep real bench room for injuries and off-nights.
export function posCap(pos, settings = {}) {
  const lineup = rosterSlots(settings);
  let demand = 0;
  for (const slot of eligibleSlots(pos)) demand += Number(lineup[slot]) || 0;
  const cap = pos === 'G' ? (Number(lineup.G) || 0) + 1 : demand + 2;
  return { demand, cap };
}

// ---- Category balance -----------------------------------------------------------------------
export function categoryNeed(roster) {
  const totals = {};
  for (const k of CAT_KEYS) totals[k] = 0;
  for (const p of roster) {
    if (!p || !p.z) continue;
    for (const k of CAT_KEYS) totals[k] += p.z[k] || 0;
  }
  const vals = CAT_KEYS.map((k) => totals[k]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const weight = {};
  for (const k of CAT_KEYS) {
    const deficit = (mean - totals[k]) / sd;
    weight[k] = Math.min(1.6, Math.max(0.6, 1 + deficit * 0.3));
  }
  return weight;
}

export function adjustedValue(p, weight) {
  if (!p || !p.z || !weight) return value(p);
  let s = 0;
  for (const k of CAT_KEYS) s += (p.z[k] || 0) * (weight[k] ?? 1);
  return s;
}

// ---- Replacement level + board ordering -----------------------------------------------------
export function replacementLevel(players, settings = {}) {
  const teams = settings.teams || 12;
  const lineup = rosterSlots(settings);
  const startersPerTeam = Object.values(lineup).reduce((a, b) => a + b, 0);
  const ranked = players
    .filter((p) => p && !p.searchOnly && typeof p.zTotal === 'number')
    .map(value)
    .sort((a, b) => b - a);
  if (!ranked.length) return 0;
  const depth = Math.min(teams * startersPerTeam, ranked.length) - 1;
  return ranked[Math.max(0, depth)] ?? 0;
}

export function boardCmp(a, b) {
  return value(b) - value(a);
}

export function rankMap(players) {
  const ranked = players
    .filter((p) => p && !p.searchOnly && typeof p.zTotal === 'number')
    .slice()
    .sort(boardCmp);
  return new Map(ranked.map((p, i) => [p.id, i + 1]));
}
