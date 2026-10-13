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
//
// `cats` (optional) is the league's scored categories. Omitted or the full standard nine, the value is
// the stored 9-cat zTotal exactly (unchanged behaviour). A custom set (e.g. 8-cat with no turnovers)
// sums only those cats' z, so a category the league doesn't score can neither help nor hurt a player.
export function nbaPlayerValue(p, cats) {
  if (!p || typeof p.zTotal !== 'number') return 0;
  if (!cats || isStandardCats(cats) || !p.z) return p.zTotal;
  let s = 0;
  for (const k of cats) s += p.z[k] || 0;
  return s;
}

// ---- League settings: categories ------------------------------------------------------------
// Leagues customize which categories count (8-cat without TO, or without FT%, etc.). Only the
// nine standard cats are supported, because they're the ones the dataset carries a z for. A
// request naming anything else is dropped rather than guessed at.
const isStandardCats = (cats) => cats.length === CAT_KEYS.length && CAT_KEYS.every((k) => cats.includes(k));

// Sanitize a client-supplied category list → an ordered subset of CAT_KEYS (board order), or null
// when it isn't usable (not an array, or fewer than MIN_CATS valid entries). Shared by the draft
// page and the server so both read the same league shape.
export const MIN_CATS = 3;
export function resolveNbaCats(raw) {
  if (!Array.isArray(raw)) return null;
  const want = new Set(raw.map((k) => String(k)));
  const cats = CAT_KEYS.filter((k) => want.has(k));
  return cats.length >= MIN_CATS ? cats : null;
}

// The league's scored categories from a settings object, defaulting to the standard nine.
export function nbaCatsOf(settings) {
  return resolveNbaCats(settings && settings.cats) || CAT_KEYS.slice();
}

// Short board/analyst label: "9-CAT" for the standard set, otherwise "8-CAT" etc.
export function nbaCatLabel(cats) {
  return `${(cats && cats.length) || CAT_KEYS.length}-CAT`;
}

// Human list of the scored cats, e.g. "PTS, REB, AST, STL, BLK, 3PM, FG%, FT%".
export function nbaCatList(cats) {
  const label = Object.fromEntries(NBA_CATS.map((c) => [c.key, c.label]));
  return (cats || CAT_KEYS).map((k) => label[k]).join(', ');
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

// Compound positions ("G-F", "F-C", "PG/SG") take the union of each part's slots, kept
// most-specific-first, so a swingman can fill either a guard or a forward slot.
export function eligibleSlots(pos) {
  if (SLOT_ELIGIBILITY[pos]) return SLOT_ELIGIBILITY[pos];
  const parts = String(pos || '').toUpperCase().split(/[-/,\s]+/).filter((x) => SLOT_ELIGIBILITY[x]);
  if (!parts.length) return ['UTIL'];
  const out = [];
  for (const part of parts) for (const slot of SLOT_ELIGIBILITY[part]) if (slot !== 'UTIL' && !out.includes(slot)) out.push(slot);
  out.push('UTIL');
  return out;
}

// ---- League settings: roster ----------------------------------------------------------------
// Per-slot bounds for a custom lineup. Every ESPN/Yahoo/Sleeper basketball layout we know of
// fits inside these; anything outside is clamped, never trusted.
export const LINEUP_BOUNDS = { PG: [0, 3], SG: [0, 3], SF: [0, 3], PF: [0, 3], C: [0, 3], G: [0, 3], F: [0, 3], UTIL: [0, 6] };
export const STARTERS_RANGE = [5, 15];
export const BENCH_RANGE = [0, 12];
export const DEFAULT_BENCH = 3; // 10 starters + 3 bench = the legacy 13-round default

// Sanitize a client-supplied lineup → full { PG..UTIL } counts, or null when unusable (not an
// object, or a starter total outside STARTERS_RANGE). Missing slots count as 0 once any is given.
export function resolveNbaLineup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let total = 0;
  for (const [slot, [lo, hi]] of Object.entries(LINEUP_BOUNDS)) {
    const v = Math.round(Number(raw[slot]));
    const n = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;
    out[slot] = n;
    total += n;
  }
  return total >= STARTERS_RANGE[0] && total <= STARTERS_RANGE[1] ? out : null;
}

export function resolveNbaBench(raw) {
  const v = Math.round(Number(raw));
  if (!Number.isFinite(v)) return null;
  return Math.min(BENCH_RANGE[1], Math.max(BENCH_RANGE[0], v));
}

// The starting lineup for a league (counts per slot). A valid settings.lineup replaces the default.
export function nbaRosterSlots(settings = {}) {
  return resolveNbaLineup(settings && settings.lineup) || { ...DEFAULT_LINEUP };
}

// Normalize a whole NBA league-settings object (cats + lineup + bench) and derive rounds =
// starters + bench. The one place both the server and the draft page turn raw input into a
// league shape, so a lineup the client shows is exactly the one the engine drafts for.
export function resolveNbaLeague(raw = {}) {
  const lineup = nbaRosterSlots(raw);
  const bench = resolveNbaBench(raw.bench) ?? DEFAULT_BENCH;
  const starters = Object.values(lineup).reduce((a, b) => a + b, 0);
  return { cats: nbaCatsOf(raw), lineup, bench, rounds: starters + bench };
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
// `cats` limits the balance to the league's scored categories (default: all nine), so an
// unscored cat (e.g. TO in an 8-cat league) is never reported as a weakness to fix.
export function nbaCategoryNeed(roster, cats = CAT_KEYS) {
  const totals = {};
  for (const k of cats) totals[k] = 0;
  for (const p of roster) {
    if (!p || !p.z) continue;
    for (const k of cats) totals[k] += p.z[k] || 0;
  }
  const vals = cats.map((k) => totals[k]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
  const weight = {};
  for (const k of cats) {
    const deficit = (mean - totals[k]) / sd; // > 0 == this cat lags the roster's others
    weight[k] = Math.min(1.6, Math.max(0.6, 1 + deficit * 0.3));
  }
  return weight;
}

// A player's category-balanced value: his per-cat z reweighted by the roster's category needs.
// Equals nbaPlayerValue when weights are flat (empty roster), and tilts toward weak cats as the
// roster fills — the core of smart category drafting. Falls back to total z if z block missing.
export function nbaAdjustedValue(p, weight) {
  if (!p || !p.z || !weight) return nbaPlayerValue(p, weight ? Object.keys(weight) : undefined);
  // Iterate the weight's own keys: categoryNeed builds it over the league's scored cats only.
  let s = 0;
  for (const k of Object.keys(weight)) s += (p.z[k] || 0) * weight[k];
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
  const cats = nbaCatsOf(settings);
  // Same pool the board drafts from (nbaDraftable): ranked players plus the short-sample ones the
  // builder flagged draftEligible, so "startable" counts and VORP agree with what's actually on the board.
  const ranked = players
    .filter(nbaDraftable)
    .map((p) => nbaPlayerValue(p, cats))
    .sort((a, b) => b - a);
  if (!ranked.length) return 0;
  const depth = Math.min(teams * startersPerTeam, ranked.length) - 1;
  return ranked[Math.max(0, depth)] ?? 0;
}

// Board comparator (descending) — NBA orders purely by total 9-cat z. No K/DST tier to bury.
export function nbaBoardCmp(a, b) {
  return nbaPlayerValue(b) - nbaPlayerValue(a);
}

// Comparator for a league's own category set (the standard nine → identical to nbaBoardCmp).
export function nbaBoardCmpFor(cats) {
  return (a, b) => nbaPlayerValue(b, cats) - nbaPlayerValue(a, cats);
}

// Draftable for the board: scored, and either in the ranked table or flagged draftEligible
// (a real player on a short sample — e.g. missed most of last season — scored against the
// ranked pool's norms so he's on the draft board without entering the rankings table).
export const nbaDraftable = (p) => !!p && typeof p.zTotal === 'number' && (!p.searchOnly || !!p.draftEligible);

// id -> 1..N board rank for a player pool, ordered by value under `cats` (default: all nine).
export function nbaRankMap(players, cats) {
  const ranked = players
    .filter(nbaDraftable)
    .slice()
    .sort(nbaBoardCmpFor(cats));
  return new Map(ranked.map((p, i) => [p.id, i + 1]));
}
