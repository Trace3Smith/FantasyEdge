// The "My pick" headline suffix that explains WHY the Coach reached off positional need. It must be
// TRUTHFUL to the chosen candidate's ACTUAL ADP position (the engine's signed adpDelta) — never a
// hardcoded "falling past his ADP" claim. A player still on the board past his ADP is a genuine falling
// value; a player taken AHEAD of his ADP is a real reach and must NOT be described as "falling."
// Shared by the draft panel (browser) and the offline regression suite so the wording can't drift.
//
// adpDelta = pick − ADP (signed, straight from api/_lib/draft.js): > 0 = still available past his ADP
// (a value/faller), < 0 = being taken ahead of his ADP (a true reach), ~0 = right around his ADP,
// null = no ADP data. The >=3 / <=-3 thresholds mirror describeNfl in api/draft/advise.js so the
// headline, the analyst's prompt line, and the board tag all read the same figure the same way.
export function reachSuffix(candidate = {}, { roto = false } = {}) {
  // Roto (NBA/MLB/NHL) has no ADP; a reach there is purely "clearly superior all-around player."
  if (roto) return ' — a clearly superior all-around player, worth the reach';
  const d = candidate.adpDelta;
  if (d != null && d >= 3) return ` — an elite value that's fallen ${d} picks past his ADP, worth the reach`;
  if (d != null && d <= -3) return ` — a reach ${-d} picks ahead of his ADP, but the value's worth it here`;
  // Right around ADP (or no ADP data): don't assert any direction — just frame the off-need pick.
  return " — worth the early pick even though it isn't a current need";
}

// Coarse board-row reason for the Coach's suggested player, kept HONEST to the pick's real adpDelta so an
// off-need reach is no longer blanket-labeled "top value" (the second surface of the same overload).
// `reach` (from the analyst) means only "went off positional need"; combined with the candidate's adpDelta
// it resolves to 'value' ONLY when he genuinely fell past his ADP, otherwise 'reach'. Non-reach picks keep
// the forced/need/value meaning. Same >=3 threshold as reachSuffix so tag and headline never disagree.
// Returns one of: 'value' | 'reach' | 'must-fill' | 'need'.
export function pickReasonTag(candidate = {}, { reach = false } = {}) {
  if (reach) return (candidate.adpDelta != null && candidate.adpDelta >= 3) ? 'value' : 'reach';
  if (candidate.forced) return 'must-fill';
  if (candidate.need) return 'need';
  return 'value';
}
