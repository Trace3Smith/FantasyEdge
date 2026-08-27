// Single source of truth for NBA (and WNBA) category value + draft logic. The roto analog
// of nflScoring.js: shared by the build pipeline, the server draft engine (api/_lib/draft.js),
// and the draft front end (fantasyedge-draft.html) so "what is this player worth" and "which
// roster slots/categories does this team still need" have exactly ONE definition per surface.
// Pure ESM, no dependencies, so the static client pages and the serverless functions both import it.
//
// Unlike football (points), fantasy basketball is a CATEGORY game: a player's worth is how far
// he moves the needle across the standard 9 cats. buildNbaDataset.js already computes a 9-cat
// z-score per player (PTS/REB/AST/STL/BLK/3PM, TO negative, FG%/FT% as volume-weighted marginal
// impacts) and now exposes it on each record as:
//   • z      — per-category z block { pts, reb, ast, stl, blk, tpm, to, fgPct, ftPct } (sign folded in)
//   • zTotal — the summed 9-cat value (the rankings-tab ordering)
//   • n      — per-game stat object (real PTS/REB/… for display)
// This module reads those; it never recomputes the z-score, so value can't drift from the board.

// The nine standard categories, in board order. `sign` is already folded into each player's
// stored z (turnovers contribute negatively), so it's here only for labels/iteration, not math.
import { rotoOpenSlots } from './draftRoster.js'; // shared greedy open-slot assignment (single source)

export const NBA_CATS = [
  { key: 'pts', label: 'PTS' },
  { key: 'reb', label: 'REB' },
  { key: 'ast', label: 'AST' },
  { key: 'stl', label: 'STL' },
  { key: 'blk', label: 'BLK' },
  { key: 'tpm', label: '3PM' },
  { key: 'to', label: 'TO' },
  { key: 'fgPct', label: 'FG%' },
  { key: 'ftPct', label: 'FT%' },
];
export const CAT_KEYS = NBA_CATS.map((c) => c.key);

// A player's raw category value: the summed 9-cat z. The one function every surface calls so
// the board, the draft engine, and the UI never diverge. Falls back to 0 for unscored
// (search-only / sub-threshold) players so they sort to the bottom rather than NaN.
export function nbaPlayerValue(p) {
  return p && typeof p.zTotal === 'number' ? p.zTotal : 0;
}

// ---- Roster slots + positional eligibility --------------------------------------------------
// Standard ESPN-style starting lineup. UTIL takes any position; G/F are the basketball analog
// of NFL's FLEX. Bench depth lives in `rounds`, not here. Premium settings can override later.
export const DEFAULT_LINEUP = { PG: 1, SG: 1, SF: 1, PF: 1, C: 1, G: 1, F: 1, UTIL: 3 };

// Which starting slots a player at a given ESPN position is eligible to fill, most-specific
// first (greedy assignment fills tight slots before flex ones). Unknown/missing positions are
// UTIL-only so they still count toward the roster but never claim a specific slot.
const SLOT_ELIGIBILITY = {
  PG: ['PG', 'G', 'UTIL'],
  SG: ['SG', 'G', 'UTIL'],
  SF: ['SF', 'F', 'UTIL'],
  PF: ['PF', 'F', 'UTIL'],
  C: ['C', 'UTIL'],
  G: ['G', 'PG', 'SG', 'UTIL'],
  F: ['F', 'SF', 'PF', 'UTIL'],
};

export function eligibleSlots(pos) {
  return SLOT_ELIGIBILITY[pos] || ['UTIL'];
}

// The starting lineup for a league (counts per slot). settings.lineup overrides the default.
export function nbaRosterSlots(settings = {}) {
  return { ...DEFAULT_LINEUP, ...(settings.lineup || {}) };
}

// Which starting slots are still OPEN given the drafted roster. Greedy bipartite assignment:
// each drafted player claims the most-specific open slot he's eligible for (tight slots like C
// before flex UTIL), so the leftover open slots are the team's true positional needs. Players
// who can't claim any open starting slot are bench/overflow and don't reduce need.
export function openSlots(roster, settings = {}) {
  return rotoOpenSlots(roster, nbaRosterSlots(settings), eligibleSlots); // shared greedy assignment
}

// Does this position help fill any currently-open starting slot?
export function fillsOpenSlot(pos, open) {
  return eligibleSlots(pos).some((slot) => (open[slot] || 0) > 0);
}

// The most-SPECIFIC open slot a position can fill (eligibleSlots is ordered tight→flex, so
// the first open hit is the tightest). Returns the slot name, or null if nothing's open.
// Used to tell a genuine positional need (an open PG/SG/SF/PF/C/G/F) apart from merely filling
// a UTIL slot — UTIL takes anyone, so it never represents positional scarcity or a forced pick.
export function bestOpenSlot(pos, open) {
  for (const slot of eligibleSlots(pos)) if ((open[slot] || 0) > 0) return slot;
  return null;
}

// Open starting slots that are positionally meaningful (everything except UTIL). These are the
// slots that can actually go unfilled — the basis for "need", the forced tier, and the analyst's
// roster-necessity note. UTIL is excluded because any drafted player fills it.
export function specificOpenSlots(roster, settings = {}) {
  const open = openSlots(roster, settings);
  delete open.UTIL;
  return open;
}

// ---- Category balance (the roto analog of positional scarcity) ------------------------------
// A category draft is won by BALANCE: a roster stacked in points/rebounds but empty in assists/
// 3PM loses those cats no matter how high its total z. This returns a per-category WEIGHT from
// the drafted roster's current category profile — cats the team is weak in get weight > 1 so the
// recommender favors a player who shores them up over one who piles onto an existing strength.
// An empty roster yields ~1.0 everywhere, so early picks are just best-available by total z.
export function nbaCategoryNeed(roster) {
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
    const deficit = (mean - totals[k]) / sd; // > 0 == this cat lags the roster's others
    weight[k] = Math.min(1.6, Math.max(0.6, 1 + deficit * 0.3));
  }
  return weight;
}

// A player's category-balanced value: his per-cat z reweighted by the roster's category needs.
// Equals nbaPlayerValue when weights are flat (empty roster), and tilts toward weak cats as the
// roster fills — the core of smart category drafting. Falls back to total z if z block missing.
export function nbaAdjustedValue(p, weight) {
  if (!p || !p.z || !weight) return nbaPlayerValue(p);
  let s = 0;
  for (const k of CAT_KEYS) s += (p.z[k] || 0) * (weight[k] ?? 1);
  return s;
}

// ---- Replacement level + board ordering -----------------------------------------------------
// One global replacement baseline: the total-z of the last STARTER-quality player off the board
// (league-wide starting slots ≈ teams × starters-per-team). Unlike football there's little
// positional replacement nuance once UTIL/G/F flex is in play, so a single baseline is both
// simpler and accurate. VORP = a player's total z above this line.
export function nbaReplacementLevel(players, settings = {}) {
  const teams = settings.teams || 12;
  const lineup = nbaRosterSlots(settings);
  const startersPerTeam = Object.values(lineup).reduce((a, b) => a + b, 0);
  const ranked = players
    .filter((p) => p && !p.searchOnly && typeof p.zTotal === 'number')
    .map(nbaPlayerValue)
    .sort((a, b) => b - a);
  if (!ranked.length) return 0;
  const depth = Math.min(teams * startersPerTeam, ranked.length) - 1;
  return ranked[Math.max(0, depth)] ?? 0;
}

// Board comparator (descending) — NBA orders purely by total 9-cat z. No K/DST tier to bury.
export function nbaBoardCmp(a, b) {
  return nbaPlayerValue(b) - nbaPlayerValue(a);
}

// id -> 1..N board rank for a player pool (search-only excluded), ordered by total z.
export function nbaRankMap(players) {
  const ranked = players
    .filter((p) => p && !p.searchOnly && typeof p.zTotal === 'number')
    .slice()
    .sort(nbaBoardCmp);
  return new Map(ranked.map((p, i) => [p.id, i + 1]));
}
