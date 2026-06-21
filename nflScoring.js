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
// universal value function.
export function nflRankValue(p, scoring) {
  const ppr = p.fpPpr ?? p.fp ?? 0;
  const std = p.rankStd ?? p.fpStd ?? ppr;
  switch (normScoring(scoring)) {
    case 'standard': return std;
    case 'half': return (ppr + std) / 2;
    default: return ppr;
  }
}
