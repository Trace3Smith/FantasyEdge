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

// Bump whenever the LINES this module produces change — new roles, new rules, new copy.
//
// This exists because the payload's shape stops being a usable staleness signal once a feature is
// additive. A cached feed already carrying `injuryImpact` looked current after starter lines
// shipped, because "no starter line" is indistinguishable from "no starter is injured" — so the
// new lines stayed invisible until the next daily cron. Presence checks caught the first two
// rounds of this and could not catch the third. An explicit version can.
export const INJURY_IMPACT_VERSION = 3;

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

// STARTER LINES. A team's best player at a skill position going down outranks any count of
// backups, so these fire on ONE player and sit above the group lines. Which player is the starter
// is inferred by the caller (see nflPickem.js) from projection, and gated on a clear margin — the
// same method proved out on QB, where firing on any injured quarterback would have been wrong most
// of the time (9 notable QB injuries on a live snapshot, only 2 of them starters). With no starter
// supplied for a position the line simply never fires, which is the safe direction to be wrong in.
//
// The margin matters more at some positions than others, which is why it is the caller's job and
// not a constant here. Measured across the league, the top player's lead over the second is a
// median 21.3x at QB, 3.25x at TE, 2.51x at RB and only 1.36x at WR — so WR abstains far more
// often, correctly: where Chicago reads Burden 209.0 vs Odunze 207.9, naming either "the starter"
// would be inventing a fact.
//
// PASSRUSH is inferred differently from the rest, and deliberately so. The offensive roles come
// from a PROJECTION — a forecast of what a player will do. The pass rusher comes from PRODUCTION,
// last season's sack total, which is arguably the stronger evidence: it is measured output rather
// than an expectation. It also answers the case a depth chart can't, a rotational rusher who plays
// fewer snaps than a starter but is the reason the pass rush works.
//
// `positions` guards against a name collision between two players in different units. `group: 'auto'`
// resolves from the injured player's own position rather than a fixed unit, because a team's sack
// leader is as often a linebacker as a lineman (league-wide: 14 DE, 14 LB, 4 DT).
const STARTER_COPY = {
  QB: { lead: 'Starting QB', positions: ['QB'], group: null, impact: 'a backup under center changes the whole offense' },
  RB: { lead: 'Starting RB', positions: ['RB'], group: 'BACK', impact: 'could force a committee backfield' },
  WR: { lead: 'Starting WR', positions: ['WR'], group: 'RECV', impact: 'takes away their top target in the passing game' },
  TE: { lead: 'Starting TE', positions: ['TE'], group: 'RECV', impact: 'costs them a primary target and a blocker' },
  PASSRUSH: {
    lead: 'Top pass rusher',
    positions: ['DE', 'DT', 'NT', 'DL', 'EDGE', 'LB', 'OLB', 'ILB', 'MLB'],
    group: 'auto',
    impact: 'could mean far less pressure on the quarterback',
  },
};
// Fixed display order. QB leads because nothing outranks it; the rest follow the order a reader
// would weigh them. Deterministic, so a card never reshuffles between builds for no reason. This is
// a display convention, not a claim that a starting tight end matters more than an elite rusher.
const STARTER_ORDER = ['QB', 'RB', 'WR', 'TE', 'PASSRUSH'];
const MAX_LINES = 4; // a card is a glance, not a medical report

export { STARTER_COPY, STARTER_ORDER, MAX_LINES };

// Names come from two different feeds — ESPN's injury payload and our own dataset — so compare
// them forgivingly. Suffixes and punctuation are exactly where the same player is written two ways.
function sameName(a, b) {
  const norm = (x) => String(x || '').toLowerCase()
    .replace(/[.'`\u2019-]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
  return !!a && !!b && norm(a) === norm(b);
}

// Group one team's injuries into impact lines, highest-priority first.
//   rows     — [{ name, pos, status }] for the team, unabridged (see the cap note in pickem.js)
//   starters — { QB|RB|WR|TE|PASSRUSH: name }, only for roles the caller could
//              identify confidently. A bare string is accepted as shorthand for { QB: name }.
// Pure and side-effect free, so the whole rule set is testable without a network call.
export function groupInjuries(rows, starters = null) {
  const known = typeof starters === 'string' ? { QB: starters } : (starters || {});
  const usable = (rows || []).filter((r) => r && TRIGGER_STATUS.has(r.status));

  // 1. Starter lines, and the groups they already speak for.
  const starterLines = [];
  const covered = new Set();
  for (const role of STARTER_ORDER) {
    const name = known[role];
    if (!name) continue;
    const copy = STARTER_COPY[role];
    const hit = usable.find((r) => copy.positions.includes(r.pos) && sameName(r.name, name));
    if (!hit) continue;
    starterLines.push({ group: 'STARTER', role, count: 1, players: [hit], impact: copy.impact, _hit: hit });
    const g = copy.group === 'auto' ? POSITION_GROUP[hit.pos] : copy.group;
    if (g) covered.add(g);
  }

  // 2. Group lines — except where a starter line already covers that unit, in which case the depth
  // is folded INTO the starter line. "Starting RB X out" next to "2 RB out" says the same thing
  // twice; "Starting RB X out (2 RB affected)" says it once and adds what the second line knew.
  const byGroup = {};
  for (const r of usable) {
    const g = POSITION_GROUP[r.pos];
    if (g) (byGroup[g] = byGroup[g] || []).push(r);
  }
  const groupLines = [];
  for (const [g, list] of Object.entries(byGroup)) {
    if (list.length < MIN_GROUP) continue;
    if (covered.has(g)) {
      const owner = starterLines.find((l) => {
        const cg = STARTER_COPY[l.role].group;
        return (cg === 'auto' ? POSITION_GROUP[l.players[0].pos] : cg) === g;
      });
      if (owner && list.length >= MIN_GROUP) {
        owner.depth = { group: g, count: list.length };
        // The line is now about the whole unit, not just the one player, so `count` moves with
        // `players` — they describe the same set and must never disagree.
        owner.players = list;
        owner.count = list.length;
      }
      continue;
    }
    const copy = GROUP_COPY[g];
    groupLines.push({
      group: g,
      count: list.length,
      label: `${list.length} ${copy.name} ${phraseFor(list)}`,
      impact: copy.impact,
      players: list.map((r) => ({ name: r.name, pos: r.pos, status: r.status })),
    });
  }

  // 3. Labels for the starter lines, now that any folded depth is known.
  for (const l of starterLines) {
    const copy = STARTER_COPY[l.role];
    const depth = l.depth ? ` (${l.depth.count} ${GROUP_COPY[l.depth.group].name} affected)` : '';
    l.label = `${copy.lead} ${l._hit.name} ${l._hit.status.toLowerCase()}${depth}`;
    l.players = l.players.map((r) => ({ name: r.name, pos: r.pos, status: r.status }));
    delete l._hit;
  }

  // Starters first in their fixed order, then the biggest remaining units. Capped, because a card
  // that lists six things communicates less than one that lists three.
  starterLines.sort((a, b) => STARTER_ORDER.indexOf(a.role) - STARTER_ORDER.indexOf(b.role));
  groupLines.sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
  return [...starterLines, ...groupLines].slice(0, MAX_LINES);
}
