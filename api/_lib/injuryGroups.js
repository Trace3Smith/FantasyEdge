// Position-group injury impact for the Pick'em cards. Turns a team's individual injuries into the
// one thing a reader actually wants — "is a unit banged up, and what does that do to this game?"
// — without an LLM call per game. Every sentence here is a fixed template chosen by group and
// severity; the only thing computed at build time is which template applies.
//
// NFL ONLY IN PRACTICE. Nothing gates it by league, but ESPN publishes no usable college-football
// injury data: the CFB endpoint returns 3 rows league-wide (median age ~4 years), the per-team
// endpoint returns 0 for every team checked, and our own live CFB feed carries 0 injury rows
// across every card. So CFB simply produces no groups and the section never renders there. See
// docs/brackets-data-research.md for what it would take to source that data, and why we didn't.
//
// TWO RULES THAT KEEP IT HONEST, both learned from measuring the real feed:
//
// 1. INJURED RESERVE IS NOT NEWS. IR is the single largest status bucket (168 of 800 NFL rows),
//    and it means a player has been gone for weeks and is already priced into the line. Of the 85
//    groups that would fire on a live snapshot, 13 were entirely IR — "3 OL out, expect pressure
//    on the QB" reads as breaking news about a months-old situation. IR is excluded from the
//    trigger; it still appears in the per-player list underneath.
//
// 2. A GROUP NEEDS TWO. One questionable player is noise, and a questionable kicker is not a story
//    at all — specialists (K/PK/P/LS) are left out of the map entirely, so they can never fire it.
//
// QB is the deliberate exception to rule 2, handled separately below.

// ESPN position abbreviation -> unit. Measured against a live NFL payload, whose full vocabulary is
// C CB DE DT FB G LB LS OL OT P PK QB RB S TE WR; the extras here cover abbreviations other leagues
// and seasons use. Anything unmapped simply never groups, which is the safe default.
const POSITION_GROUP = {
  C: 'OL', G: 'OL', OG: 'OL', OT: 'OL', OL: 'OL', T: 'OL', LT: 'OL', RT: 'OL', LG: 'OL', RG: 'OL',
  DE: 'DL', DT: 'DL', NT: 'DL', DL: 'DL', EDGE: 'DL',
  LB: 'LB', ILB: 'LB', OLB: 'LB', MLB: 'LB', WLB: 'LB', SLB: 'LB',
  CB: 'SEC', S: 'SEC', SS: 'SEC', FS: 'SEC', DB: 'SEC',
  WR: 'RECV', TE: 'RECV',
  RB: 'BACK', FB: 'BACK', HB: 'BACK',
  // QB is intentionally absent: it is handled by its own single-player rule, not by group count.
  // K, PK, P, LS are intentionally absent: a questionable kicker must never trigger an impact line.
};

// One fixed sentence per unit. Written as consequences a reader can act on, and hedged ("could")
// because this is a count of unavailable players, not a prediction.
const GROUP_COPY = {
  OL: { name: 'OL', impact: 'could mean more pressure on the QB and a weaker run game' },
  DL: { name: 'DL', impact: 'could mean less pass rush and an easier day for their run game' },
  LB: { name: 'LB', impact: 'could open up the middle of the field in run support and coverage' },
  SEC: { name: 'DB', impact: 'could leave the secondary exposed to the pass' },
  RECV: { name: 'WR/TE', impact: 'thins out the passing targets' },
  BACK: { name: 'RB', impact: 'could force a committee backfield and a thinner run game' },
};

// Statuses that mean "may not play THIS week". Injured Reserve is deliberately absent (rule 1);
// so is Probable, which ESPN reports as Active anyway.
const TRIGGER_STATUS = new Set(['Out', 'Doubtful', 'Questionable', 'Suspension']);
const MIN_GROUP = 2; // a unit needs two to be a story

export { POSITION_GROUP, GROUP_COPY, TRIGGER_STATUS, MIN_GROUP };

// "3 OL out", "2 DB questionable", "3 OL out or questionable" — phrased from the statuses actually
// present rather than a single catch-all, so a group of three outs doesn't read as hedged.
function phraseFor(rows) {
  const out = rows.filter((r) => /^(out|suspension)$/i.test(r.status)).length;
  const doubtful = rows.filter((r) => /doubtful/i.test(r.status)).length;
  const quest = rows.filter((r) => /questionable/i.test(r.status)).length;
  if (out && !doubtful && !quest) return 'out';
  if (quest && !out && !doubtful) return 'questionable';
  if (doubtful && !out && !quest) return 'doubtful';
  return 'out or questionable';
}

// The QB rule. A single injured QB outweighs any group, but ESPN publishes no starter flag, and
// firing on any QB injury would be wrong most of the time: on a live 32-team snapshot, 9 teams had
// a notable QB injury and only 2 were actual starters (Mahomes, Penix) — the rest were backups and
// IR depth arms. So this fires ONLY when the caller can confirm the injured player is the starter.
// With no starter information it never fires, which is the safe direction to be wrong in.
function qbLine(rows, starterName) {
  if (!starterName) return null;
  const hit = rows.find((r) => r.pos === 'QB' && r.name === starterName && TRIGGER_STATUS.has(r.status));
  if (!hit) return null;
  const out = /^(out|doubtful|suspension)$/i.test(hit.status);
  return {
    group: 'QB',
    count: 1,
    label: `Starting QB ${hit.status.toLowerCase()}`,
    impact: out ? 'a backup under center changes the whole offense' : 'a backup under center would change the whole offense',
    players: [hit],
  };
}

// Group one team's injuries into impact lines, most-affected unit first.
//   rows        — [{ name, pos, status }] for the team, unabridged (see the cap note in pickem.js)
//   starterName — that team's starting QB, when the caller can identify one; enables the QB rule
// Pure and side-effect free, so the whole rule set is testable without a network call.
export function groupInjuries(rows, starterName = null) {
  const usable = (rows || []).filter((r) => r && TRIGGER_STATUS.has(r.status));
  const byGroup = {};
  for (const r of usable) {
    const g = POSITION_GROUP[r.pos];
    if (!g) continue;
    (byGroup[g] = byGroup[g] || []).push(r);
  }

  const lines = [];
  const qb = qbLine(usable, starterName);
  if (qb) lines.push(qb); // the QB always leads: no unit outranks it

  for (const [g, list] of Object.entries(byGroup)) {
    if (list.length < MIN_GROUP) continue;
    const copy = GROUP_COPY[g];
    lines.push({
      group: g,
      count: list.length,
      label: `${list.length} ${copy.name} ${phraseFor(list)}`,
      impact: copy.impact,
      players: list.map((r) => ({ name: r.name, pos: r.pos, status: r.status })),
    });
  }

  // QB first, then the biggest units. A tie keeps a stable order so the card doesn't reshuffle
  // between builds for no reason.
  return lines.sort((a, b) => (b.group === 'QB' ? 1 : 0) - (a.group === 'QB' ? 1 : 0)
    || b.count - a.count || a.group.localeCompare(b.group));
}
