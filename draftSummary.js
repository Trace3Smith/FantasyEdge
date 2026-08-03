// Post-draft summary — pure, no DOM/network. Turns a completed draft into an overall grade + analysis, a
// league-finish projection, and each drafted player's positional rank. Everything runs off the SAME board
// value function the draft/rankings already use (NFL VORP, roto category value) and the per-pick
// value-over-next-best deltas already computed live (gradePick) — no new ranking system, no draft-time logic.
//
// The client passes its own valueFn (boardValue) and threshold (gradeThreshold), so grades stay on the same
// scale the board shows. All functions are pure so they're unit-testable against synthetic drafts.

// Positional rank map: playerId -> { pos, posRank, posTotal } (e.g. RB ranked 4th of 61 -> RB4). Ranks the
// FULL pool per position by valueFn (higher = better), so "RB4" means the 4th-most-valuable RB overall.
export function positionalRanks(pool, valueFn) {
  const byPos = {};
  for (const p of pool || []) {
    if (!p || p.pos == null || p.id == null) continue;
    (byPos[p.pos] ||= []).push(p);
  }
  const map = new Map();
  for (const pos of Object.keys(byPos)) {
    const arr = byPos[pos].filter((p) => Number.isFinite(valueFn(p))).sort((a, b) => valueFn(b) - valueFn(a));
    arr.forEach((p, i) => map.set(p.id, { pos, posRank: i + 1, posTotal: arr.length }));
  }
  return map;
}
export const posRankLabel = (e) => (e ? `${e.pos}${e.posRank}` : '');

// League-finish projection: rank each team by total roster value. teams = [{ teamIndex, isUser, roster:[player] }].
// Returns { rows:[{teamIndex,isUser,total,rank}] (best first), userRank, teams }. Value-based, so it reflects
// the same VORP/category strength the board ranks by — a projection, not a guarantee.
export function leagueRanking(teams, valueFn) {
  const rows = (teams || []).map((t) => ({
    teamIndex: t.teamIndex,
    isUser: !!t.isUser,
    total: Math.round((t.roster || []).reduce((s, p) => s + (Number.isFinite(valueFn(p)) ? valueFn(p) : 0), 0) * 10) / 10,
  }));
  rows.sort((a, b) => b.total - a.total);
  rows.forEach((r, i) => { r.rank = i + 1; });
  const user = rows.find((r) => r.isUser) || null;
  return { rows, userRank: user ? user.rank : null, teams: rows.length };
}

// Letter grade from a value index (vi = avg per-pick value-over-next-best / the sport's steal/reach
// threshold). vi > 0 means the roster consistently beat the board (value); vi < 0 means it reached. Centered
// so an average, on-value draft (vi≈0) lands at B.
const GRADE_BANDS = [
  [0.5, 'A+'], [0.35, 'A'], [0.2, 'A-'], [0.1, 'B+'], [0.0, 'B'],
  [-0.1, 'B-'], [-0.2, 'C+'], [-0.35, 'C'], [-0.5, 'C-'], [-0.7, 'D'], [-Infinity, 'F'],
];
export function letterFor(vi) {
  for (const [t, g] of GRADE_BANDS) if (vi >= t) return g;
  return 'F';
}

// Overall draft grade from the per-pick value deltas. picks = [{ pos, delta }] (delta = value(picked) −
// value(best other available at pick time), the same steal/reach signal shown live). threshold = the sport's
// magnitude (NFL ~15 VORP pts, roto ~1.5 z). Returns { grade, valueIndex, avgDelta, byPosition, analysis }.
export function draftGrade(picks, threshold) {
  const T = threshold || 1;
  const valued = (picks || []).filter((p) => p && typeof p.delta === 'number' && Number.isFinite(p.delta));
  const n = valued.length || 1;
  const avg = valued.reduce((s, p) => s + p.delta, 0) / n;
  const vi = avg / T;

  const byPos = {};
  for (const p of valued) (byPos[p.pos] ||= []).push(p.delta);
  const byPosition = {};
  for (const pos of Object.keys(byPos)) {
    const a = byPos[pos].reduce((s, d) => s + d, 0) / byPos[pos].length;
    byPosition[pos] = {
      avg: Math.round(a * 10) / 10,
      label: a >= 0.4 * T ? 'strong value' : a <= -0.4 * T ? 'reach' : 'fair value',
    };
  }

  return {
    grade: letterFor(vi),
    valueIndex: Math.round(vi * 100) / 100,
    avgDelta: Math.round(avg * 10) / 10,
    byPosition,
    analysis: analysisText(byPosition),
  };
}

// Plain-language analysis from the per-position breakdown, in the app's own voice ("strong value at RB/WR,
// reached slightly at TE"). Deterministic — no LLM in v1.
export function analysisText(byPosition) {
  const strong = Object.keys(byPosition).filter((p) => byPosition[p].label === 'strong value');
  const reached = Object.keys(byPosition).filter((p) => byPosition[p].label === 'reach');
  if (strong.length && reached.length) return `You got strong value at ${strong.join('/')}, but reached at ${reached.join('/')}.`;
  if (strong.length) return `You got strong value at ${strong.join('/')}.`;
  if (reached.length) return `You reached at ${reached.join('/')} but took fair value elsewhere.`;
  return 'A balanced, on-value draft — you took the board at fair value throughout.';
}
