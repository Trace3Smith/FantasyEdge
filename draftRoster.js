// Shared roster-need primitives — the ONE canonical home for "given a roster + league
// settings, what does this team still need?" Both the browser opponent AI (draftAI.js) and
// the per-sport scoring modules (nba/mlb/nhlScoring openSlots) import from here, so the mock
// opponents, the rankings board, and the server recommend engine can never drift apart when
// league settings change. Pure, dependency-free, browser- and node-importable.

// ---- NFL (points flow: fixed starter slots) ---------------------------------------------------

const NFL_FLEX = ['RB', 'WR', 'TE']; // positions a FLEX slot can absorb

function countByPos(have) {
  const c = {};
  for (const p of have) c[p.pos] = (c[p.pos] || 0) + 1;
  return c;
}

// Open MANDATORY starting needs for an NFL roster, given league `starters` counts and what the
// team already `have`. FLEX is handled last: it's only "needed" once RB/WR/TE surplus (players
// beyond their own starter counts) can't cover it. Mirrors the board's openStartingNeeds model.
export function nflOpenNeeds(starters, have) {
  const counts = countByPos(have);
  const hardNeeds = {};
  let totalHard = 0;
  for (const [pos, n] of Object.entries(starters || {})) {
    if (pos === 'FLEX') continue;
    const need = Math.max(0, (Number(n) || 0) - (counts[pos] || 0));
    if (need > 0) { hardNeeds[pos] = need; totalHard += need; }
  }
  let surplus = 0;
  for (const pos of NFL_FLEX) surplus += Math.max(0, (counts[pos] || 0) - (Number(starters?.[pos]) || 0));
  const flexNeed = Math.max(0, (Number(starters?.FLEX) || 0) - surplus);
  return { hardNeeds, totalHard, flexNeed };
}

// Soft per-position caps: how many of a position a sane manager will roster. K/DST are capped at
// their (single) starter slot — nobody drafts two defenses; QB/TE get one backup; RB/WR stay
// deep for FLEX and bench. Prevents the "5 QBs, no kicker" rosters blind-ADP drafting produced.
export function nflPosCaps(starters) {
  const s = starters || {};
  const flex = Number(s.FLEX) || 0;
  return {
    QB: (Number(s.QB) || 1) + 1,
    TE: (Number(s.TE) || 1) + 1,
    K: Number(s.K) || 1,
    DST: Number(s.DST) || 1,
    RB: (Number(s.RB) || 2) + flex + 3,
    WR: (Number(s.WR) || 2) + flex + 3,
  };
}

export { NFL_FLEX };

// ---- Roto (category flow: lineup slots via eligibility) ---------------------------------------

// Which starting slots are still open given a roster, by greedy most-specific-first assignment:
// each drafted player claims the tightest open slot he's eligible for, so the leftover open slots
// are the team's true positional needs. `lineup` = slot->count (already merged with any override);
// `eligibleSlots(pos)` = slots a position can fill, ordered tight->flex. This is the SINGLE
// implementation of the greedy assignment — nba/mlb/nhlScoring openSlots delegate here.
export function rotoOpenSlots(roster, lineup, eligibleSlots) {
  const open = { ...lineup };
  for (const p of roster) {
    for (const slot of eligibleSlots(p.pos)) {
      if (open[slot] > 0) { open[slot] -= 1; break; }
    }
  }
  const out = {};
  for (const [slot, n] of Object.entries(open)) if (n > 0) out[slot] = n;
  return out;
}
