// Single source of truth for MLB (standard roto) category value + draft logic. The
// baseball analog of nbaScoring.js — fantasy baseball is a CATEGORY game, so a player's
// worth is how far he moves the needle across the standard 5x5-style categories, split
// between hitters and pitchers. Shared by the server draft engine (api/_lib/draft.js)
// and the draft front end (fantasyedge-draft.html) so "what is this player worth" and
// "which roster slots / categories does this team still need" have exactly ONE
// definition per surface. Pure ESM, no dependencies.
//
// buildDataset.js z-scores hitters across their six hitting cats and pitchers across
// their five pitching cats (on a comparable standardized scale), then exposes on each
// ranked record:
//   • z      — per-category z block keyed by CAT_KEYS (own group filled, other group 0)
//   • zTotal — the summed value (the board ordering)
// Hitters carry zero in the pitching cats and vice-versa, so a roster's category profile
// spans both groups — which makes categoryNeed naturally steer a hitter-heavy roster
// toward pitching once the bats are stocked.

// The standard roto categories, in board order. `group` ('h' hitter / 'p' pitcher) is
// used only for labels/iteration; the sign of each cat is already folded into the stored z
// (ERA/WHIP are inverted so lower is better → positive z).
import { rotoOpenSlots } from './draftRoster.js'; // shared greedy open-slot assignment (single source)

export const MLB_CATS = [
  { key: 'r', label: 'R', group: 'h' },
  { key: 'hr', label: 'HR', group: 'h' },
  { key: 'rbi', label: 'RBI', group: 'h' },
  { key: 'sb', label: 'SB', group: 'h' },
  { key: 'avg', label: 'AVG', group: 'h' },
  { key: 'obp', label: 'OBP', group: 'h' },
  { key: 'w', label: 'W', group: 'p' },
  { key: 'sv', label: 'SV', group: 'p' },
  { key: 'k', label: 'K', group: 'p' },
  { key: 'era', label: 'ERA', group: 'p' },
  { key: 'whip', label: 'WHIP', group: 'p' },
];
export const CAT_KEYS = MLB_CATS.map((c) => c.key);
export const CAT_LABEL = Object.fromEntries(MLB_CATS.map((c) => [c.key, c.label]));

// A player's raw category value: the summed roto z. Falls back to 0 for unscored
// (search-only / sub-threshold) players so they sort to the bottom rather than NaN.
export function value(p) {
  return p && typeof p.zTotal === 'number' ? p.zTotal : 0;
}

// ---- Roster slots + positional eligibility --------------------------------------------------
// A standard mixed fantasy-baseball lineup: the four infield corners + middle, three OF, a
// UTIL bat (any hitter), and a small pitching staff split SP/RP. Bench depth lives in `rounds`.
export const DEFAULT_LINEUP = { C: 1, '1B': 1, '2B': 1, '3B': 1, SS: 1, OF: 3, UTIL: 1, SP: 2, RP: 1 };

// Which starting slots a player at a given position is eligible to fill, most-specific
// first (greedy assignment fills tight slots before flex ones). Outfield variants collapse
// to OF; DH and any unknown hitter position are UTIL-only; pitchers fill their own SP/RP.
const SLOT_ELIGIBILITY = {
  C: ['C', 'UTIL'],
  '1B': ['1B', 'UTIL'],
  '2B': ['2B', 'UTIL'],
  '3B': ['3B', 'UTIL'],
  SS: ['SS', 'UTIL'],
  OF: ['OF', 'UTIL'], LF: ['OF', 'UTIL'], CF: ['OF', 'UTIL'], RF: ['OF', 'UTIL'],
  DH: ['UTIL'],
  SP: ['SP'],
  RP: ['RP'],
};

export function eligibleSlots(pos) {
  return SLOT_ELIGIBILITY[pos] || ['UTIL'];
}

export function rosterSlots(settings = {}) {
  return { ...DEFAULT_LINEUP, ...(settings.lineup || {}) };
}

// Which starting slots are still OPEN given the drafted roster. Greedy assignment: each
// drafted player claims the most-specific open slot he's eligible for, so the leftover open
// slots are the team's true positional needs.
export function openSlots(roster, settings = {}) {
  return rotoOpenSlots(roster, rosterSlots(settings), eligibleSlots); // shared greedy assignment
}

export function fillsOpenSlot(pos, open) {
  return eligibleSlots(pos).some((slot) => (open[slot] || 0) > 0);
}

// The most-SPECIFIC open slot a position can fill (eligibleSlots is ordered tight→flex).
// Returns the slot name, or null if nothing's open.
export function bestOpenSlot(pos, open) {
  for (const slot of eligibleSlots(pos)) if ((open[slot] || 0) > 0) return slot;
  return null;
}

// Open starting slots that are positionally meaningful (everything except UTIL) — the basis
// for "need", the forced tier, and the analyst's roster-necessity note.
export function specificOpenSlots(roster, settings = {}) {
  const open = openSlots(roster, settings);
  delete open.UTIL;
  return open;
}

// ---- Category balance -----------------------------------------------------------------------
// A roto draft is won by BALANCE across categories. This returns a per-category WEIGHT from the
// roster's current category profile — cats the team lags in get weight > 1 so the recommender
// favors a player who shores them up. An empty roster yields ~1.0 everywhere (best-available).
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

// A player's category-balanced value: per-cat z reweighted by the roster's category needs.
export function adjustedValue(p, weight) {
  if (!p || !p.z || !weight) return value(p);
  let s = 0;
  for (const k of CAT_KEYS) s += (p.z[k] || 0) * (weight[k] ?? 1);
  return s;
}

// ---- Replacement level + board ordering -----------------------------------------------------
// One global replacement baseline: the value of the last starter-quality player off the board
// (teams × starters-per-team). VORP = a player's value above this line.
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

// Board comparator (descending) — order purely by total roto z.
export function boardCmp(a, b) {
  return value(b) - value(a);
}

// id -> 1..N board rank for a player pool (search-only excluded), ordered by total z.
export function rankMap(players) {
  const ranked = players
    .filter((p) => p && !p.searchOnly && typeof p.zTotal === 'number')
    .slice()
    .sort(boardCmp);
  return new Map(ranked.map((p, i) => [p.id, i + 1]));
}
