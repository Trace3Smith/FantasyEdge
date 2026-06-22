// Single source of truth for NFL fantasy-point scoring + ranking by format. Shared by
// the rankings tab (fantasyedge-rankings.html), the draft board (fantasyedge-draft.html),
// and the server draft engine (api/_lib/draft.js) so there is exactly ONE definition of
// "rank players by FPTS in this scoring format" — no separate ranking system per surface.
// Pure ESM, no dependencies, so both the static client pages and the serverless functions
// can import it.
//
// Each NFL player from buildNflDataset carries:
//   • fpPpr — PPR fantasy points (1 pt per reception); fp === fpPpr for the default board.
//   • fpStd — Standard fantasy points (= fpPpr − receptions; no per-reception point).
//   • rankStd — kickers only: a Standard-board RANKING value distinct from displayed
//     points, so a kicker's realistic points don't drag it up the Standard board
//     (see scaleKickers in buildNflDataset.js).
// Half-PPR is EXACT, not an approximation: since fpStd = fpPpr − receptions, half-PPR
// points = fpPpr − 0.5·receptions = (fpPpr + fpStd) / 2.

// Normalize the scoring tokens the two UIs use ('PPR'/'STD' on the rankings tab,
// 'ppr'/'half'/'standard' in draft setup) into one canonical set.
export function normScoring(scoring) {
  const s = String(scoring || '').toLowerCase();
  if (s === 'std' || s === 'standard') return 'standard';
  if (s === 'half' || s === 'half-ppr' || s === 'halfppr') return 'half';
  return 'ppr';
}

// Displayed fantasy points in the chosen format (half = exact midpoint of PPR & Standard).
export function nflFpts(p, scoring) {
  const ppr = p.fpPpr ?? p.fp ?? 0;
  const std = p.fpStd ?? ppr;
  switch (normScoring(scoring)) {
    case 'standard': return std;
    case 'half': return (ppr + std) / 2;
    default: return ppr;
  }
}

// Ranking value used to order the big board. Mirrors nflFpts except kickers use their
// separate rankStd in non-PPR formats. For non-NFL players (no fpStd/rankStd) this
// gracefully collapses to p.fp in every format, so it doubles as the draft engine's
// universal value function. This is the RAW value that VORP is measured against.
export function nflRankValue(p, scoring) {
  const ppr = p.fpPpr ?? p.fp ?? 0;
  const std = p.rankStd ?? p.fpStd ?? ppr;
  switch (normScoring(scoring)) {
    case 'standard': return std;
    case 'half': return (ppr + std) / 2;
    default: return ppr;
  }
}

// ---- Value Over Replacement (VORP) ----------------------------------------------
// Ranking players by raw fantasy points puts QBs on top (they score the most), which is
// wrong for a draft board: a replacement-level QB is still excellent, so an elite QB's
// edge over the next-best is small, while an elite RB towers over a waiver-wire RB. VORP
// ranks by how far a player outscores the replacement-level player AT HIS OWN POSITION,
// which is what makes elite RB/WR go early and QBs slide to the middle rounds.

// Default league shape for VORP when a surface has no explicit settings (the rankings
// tab's initial view): a standard 12-team lineup.
export const DEFAULT_LEAGUE = {
  teams: 12,
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 },
};

// How many players at each position are drafted as startable before quality drops to
// "replacement" level, derived from league size + the starting lineup. The FLEX slot
// (RB/WR/TE) is split mostly toward RB/WR (where flex is actually spent) with a sliver
// to TE; deepening RB/WR replacement is what pushes elite RB/WR up a VORP board.
export function nflReplacementDepths({ teams = 12, starters } = {}) {
  const s = { ...DEFAULT_LEAGUE.starters, ...(starters || {}) };
  const flex = teams * (s.FLEX || 0);
  return {
    QB:  teams * (s.QB  || 0),
    RB:  teams * (s.RB  || 0) + flex * 0.5,
    WR:  teams * (s.WR  || 0) + flex * 0.4,
    TE:  teams * (s.TE  || 0) + flex * 0.1,
    K:   teams * (s.K   || 0),
    DST: teams * (s.DST || 0),
  };
}

// Replacement-level VALUE per position: the ranking value of the player sitting at the
// replacement depth, in the chosen format. Uses nflRankValue so kickers' rankStd is
// respected. Positions not in the depth table (other sports) fall back to the pool's
// median, so this stays safe if reused beyond NFL. Depth beyond the pool clamps to last.
export function nflReplacementLevels(players, scoring, settings) {
  const depths = nflReplacementDepths(settings || {});
  const byPos = {};
  for (const p of players) {
    if (!p || p.searchOnly || p.rank == null) continue;
    (byPos[p.pos] ||= []).push(nflRankValue(p, scoring));
  }
  const levels = {};
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((a, b) => b - a);
    const depth = Math.round(depths[pos] ?? Math.ceil(vals.length / 2));
    // depth is a 1-based count of startable players; the next one sets replacement.
    const i = Math.min(Math.max(depth - 1, 0), vals.length - 1);
    levels[pos] = vals[i] ?? 0;
  }
  return levels;
}

// Value Over Replacement: how far this player's format value sits above the replacement
// player at his own position. The draft-board ordering metric — can be negative, which
// simply sorts a player below replacement. Pass precomputed levels for the whole pool.
export function nflVorp(p, scoring, levels) {
  return nflRankValue(p, scoring) - ((levels && levels[p.pos]) ?? 0);
}

// id -> 1..N VORP board rank for a player pool. Ordered by VORP desc, tie-broken by raw
// format value desc so players below replacement (deep bench, kickers) still order sanely.
export function nflVorpRankMap(players, scoring, settings) {
  const levels = nflReplacementLevels(players, scoring, settings);
  const ranked = players
    .filter((p) => p && !p.searchOnly && p.rank != null)
    .map((p) => ({ id: p.id, v: nflVorp(p, scoring, levels), raw: nflRankValue(p, scoring) }))
    .sort((a, b) => b.v - a.v || b.raw - a.raw);
  return new Map(ranked.map((x, i) => [x.id, i + 1]));
}
