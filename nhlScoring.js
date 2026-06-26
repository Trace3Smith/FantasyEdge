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
export const NHL_CATS = [
  { key: 'g', label: 'G', group: 's' },
  { key: 'a', label: 'A', group: 's' },
  { key: 'pm', label: '+/-', group: 's' },
  { key: 'pim', label: 'PIM', group: 's' },
  { key: 'ppp', label: 'PPP', group: 's' },
  { key: 'sog', label: 'SOG', group: 's' },
  { key: 'fow', label: 'FOW', group: 's' },
  { key: 'gwg', label: 'GWG', group: 's' },
  { key: 'w', label: 'W', group: 'g' },
  { key: 'gaa', label: 'GAA', group: 'g' },
  { key: 'svpct', label: 'SV%', group: 'g' },
  { key: 'so', label: 'SO', group: 'g' },
  { key: 'sv', label: 'SV', group: 'g' },
];
export const CAT_KEYS = NHL_CATS.map((c) => c.key);
export const CAT_LABEL = Object.fromEntries(NHL_CATS.map((c) => [c.key, c.label]));

export function value(p) {
  return p && typeof p.zTotal === 'number' ? p.zTotal : 0;
}

// ---- Roster slots + positional eligibility --------------------------------------------------
// A standard fantasy-hockey lineup: two of each forward position, four defensemen, two goalies.
// Bench depth lives in `rounds`.
export const DEFAULT_LINEUP = { C: 2, LW: 2, RW: 2, D: 4, G: 2 };

// A generic forward (ESPN 'F') can fill any forward slot; specific forwards fill their own slot.
const SLOT_ELIGIBILITY = {
  C: ['C'],
  LW: ['LW'],
  RW: ['RW'],
  D: ['D'],
  G: ['G'],
  F: ['C', 'LW', 'RW'],
};

export function eligibleSlots(pos) {
  return SLOT_ELIGIBILITY[pos] || ['C', 'LW', 'RW'];
}

export function rosterSlots(settings = {}) {
  return { ...DEFAULT_LINEUP, ...(settings.lineup || {}) };
}

export function openSlots(roster, settings = {}) {
  const open = rosterSlots(settings);
  for (const p of roster) {
    for (const slot of eligibleSlots(p.pos)) {
      if (open[slot] > 0) { open[slot] -= 1; break; }
    }
  }
  const out = {};
  for (const [slot, n] of Object.entries(open)) if (n > 0) out[slot] = n;
  return out;
}

export function fillsOpenSlot(pos, open) {
  return eligibleSlots(pos).some((slot) => (open[slot] || 0) > 0);
}

export function bestOpenSlot(pos, open) {
  for (const slot of eligibleSlots(pos)) if ((open[slot] || 0) > 0) return slot;
  return null;
}

// Every NHL slot is positionally meaningful (no UTIL), so specific == all open slots.
export function specificOpenSlots(roster, settings = {}) {
  return openSlots(roster, settings);
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
