// Draft-assistant engine: best-available recommendations over the cached rankings
// dataset, by value-over-replacement (VORP) adjusted for the drafter's roster needs.
// Shared by the mock draft (AI opponents + suggestions) and premium real-draft mode.
// Pure/algorithmic — no LLM here; advise.js layers a Claude rationale on top.
import { buildDataset } from './buildDataset.js';
import { buildNflDataset } from './buildNflDataset.js';
import { buildNbaDataset, buildWnbaDataset } from './buildNbaDataset.js';
import { buildNhlDataset } from './buildNhlDataset.js';
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, DATASET_VERSION } from './kv.js';
// The board ranks by the same per-format value function the rankings tab and draft board
// use — one shared definition (see /nflScoring.js), so the engine never drifts from the UI.
import { nflRankValue as valueOf, nflReplacementDepths } from '../../nflScoring.js';
// The roto (category) sports each have their own shared module — the roto analog of
// nflScoring.js, used identically by the rankings board, this engine, and the draft UI.
import * as NBA from '../../nbaScoring.js';
import * as MLB from '../../mlbScoring.js';
import * as NHL from '../../nhlScoring.js';

// Same per-sport wiring as api/sports.js, so the draft reads the identical cached dataset and
// self-heals on a cold-start miss. NFL is the headline draft sport. MLB carries no build
// version (its cold-start build skips prospect enrichment), so it self-heals on a missing roto
// value (zTotal) rather than a version bump — see loadPlayers.
const SPORTS = {
  nfl: { key: NFL_DATASET_KEY, build: () => buildNflDataset(), version: DATASET_VERSION },
  nba: { key: NBA_DATASET_KEY, build: () => buildNbaDataset(), version: DATASET_VERSION },
  wnba: { key: WNBA_DATASET_KEY, build: () => buildWnbaDataset(), version: DATASET_VERSION },
  nhl: { key: NHL_DATASET_KEY, build: () => buildNhlDataset(), version: DATASET_VERSION },
  mlb: { key: DATASET_KEY, build: () => buildDataset({ season: new Date().getFullYear() }), needsValue: true },
};

// Per-sport roto adapters: a uniform interface over each category module so the one
// recommendRoto engine drives NBA/WNBA/MLB/NHL identically (each just supplies its own
// value/need/slot functions + category keys). Points sports (NFL) use recommendNfl.
const ROTO = {
  nba: {
    value: NBA.nbaPlayerValue, adjustedValue: NBA.nbaAdjustedValue, categoryNeed: NBA.nbaCategoryNeed,
    replacementLevel: NBA.nbaReplacementLevel, bestOpenSlot: NBA.bestOpenSlot, specificOpenSlots: NBA.specificOpenSlots,
    CAT_KEYS: NBA.CAT_KEYS, CAT_LABEL: Object.fromEntries(NBA.NBA_CATS.map((c) => [c.key, c.label])),
  },
  mlb: {
    value: MLB.value, adjustedValue: MLB.adjustedValue, categoryNeed: MLB.categoryNeed,
    replacementLevel: MLB.replacementLevel, bestOpenSlot: MLB.bestOpenSlot, specificOpenSlots: MLB.specificOpenSlots,
    CAT_KEYS: MLB.CAT_KEYS, CAT_LABEL: MLB.CAT_LABEL,
  },
  nhl: {
    value: NHL.value, adjustedValue: NHL.adjustedValue, categoryNeed: NHL.categoryNeed,
    replacementLevel: NHL.replacementLevel, bestOpenSlot: NHL.bestOpenSlot, specificOpenSlots: NHL.specificOpenSlots,
    CAT_KEYS: NHL.CAT_KEYS, CAT_LABEL: NHL.CAT_LABEL,
  },
};
ROTO.wnba = ROTO.nba; // WNBA shares the basketball module
export const isRoto = (sport) => !!ROTO[sport];

// Basic (free-tier) league: a standard 10-team PPR snake draft. Premium can override.
export const DEFAULT_SETTINGS = {
  teams: 10,
  rounds: 15,
  scoring: 'ppr', // 'ppr' | 'standard'
  starters: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1 }, // FLEX = RB/WR/TE
};

// The minimum balanced roster every team must end up with. The recommender fills
// these starter requirements before chasing luxury depth, so a drafter can't end up
// with five RBs and no QB/TE/K/DST. The FLEX slot is satisfied by one extra RB/WR/TE
// drafted on top of these minimums (handled by the post-minimum "depth" tier below).
const MIN_ROSTER = { QB: 1, RB: 2, WR: 2, TE: 1, K: 1, DST: 1 };

// Roughly how many starters the league as a whole wants at each position. Used to
// gauge scarcity: when the count of startable players left at a position drops toward
// (teams × demand), the position is drying up and urgency to grab one should rise.
// Fallback shape only — leagueDemandFrom derives the live values from the league's starters.
const LEAGUE_DEMAND = { QB: 1, RB: 2.5, WR: 2.5, TE: 1, K: 1, DST: 1 };

// Sanitize a client-sent custom NFL roster layout (premium only). K/DST are fixed at 1; the rest are
// clamped to sane ranges. Returns null (→ caller keeps the default starters) for absent/invalid input.
// Shared by mock-start and advise so both endpoints validate identically and can't diverge.
export function resolveStarters(rawStarters) {
  if (!rawStarters || typeof rawStarters !== 'object') return null;
  const clamp = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    QB: clamp(rawStarters.QB, 1, 2, 1), RB: clamp(rawStarters.RB, 1, 4, 2), WR: clamp(rawStarters.WR, 1, 4, 2),
    TE: clamp(rawStarters.TE, 1, 2, 1), FLEX: clamp(rawStarters.FLEX, 0, 3, 1), K: 1, DST: 1,
  };
}
// The mandatory per-position starting slots (FLEX excluded — it's soft demand, filled by extra
// RB/WR/TE depth). Derived from the league's starters so a custom roster drives need/forced/scarcity.
function minRosterFrom(settings) {
  const s = (settings && settings.starters) || DEFAULT_SETTINGS.starters;
  return { QB: s.QB || 0, RB: s.RB || 0, WR: s.WR || 0, TE: s.TE || 0, K: s.K || 0, DST: s.DST || 0 };
}
// League-wide starter demand for scarcity, folding the FLEX slots across RB/WR/TE (the same soft-demand
// split the VORP replacement depths use) so a deeper-FLEX league values those positions more.
function leagueDemandFrom(settings) {
  const s = (settings && settings.starters) || DEFAULT_SETTINGS.starters;
  const flex = s.FLEX || 0;
  return { QB: s.QB || 0, RB: (s.RB || 0) + flex * 0.5, WR: (s.WR || 0) + flex * 0.4, TE: (s.TE || 0) + flex * 0.1, K: s.K || 0, DST: s.DST || 0 };
}

// Load a sport's player list from cache, rebuilding on a miss (mirrors api/sports.js).
export async function loadPlayers(sport = 'nfl') {
  const cfg = SPORTS[sport];
  if (!cfg) return [];
  let dataset = await redis.get(cfg.key);
  const stale = !dataset || !dataset.players
    || (cfg.version != null && dataset.version !== cfg.version)
    || (cfg.needsValue && !dataset.players.some((p) => !p.searchOnly && typeof p.zTotal === 'number'));
  if (stale) {
    dataset = await cfg.build();
    if (cfg.version != null) dataset.version = cfg.version;
    await redis.set(cfg.key, dataset);
  }
  // Exclude two-way pitcher clones (Ohtani's Pitchers-tab entry): the draft lists a two-way player
  // once (his primary hitter record), never twice. The rankings board still shows both.
  return (dataset.players || []).filter((p) => !p.searchOnly && !p.twoWay);
}

// A player's ADP for the league's scoring. Half-PPR uses FFC's native half-PPR ADP
// when present, falling back to the PPR/Standard midpoint for any legacy cached dataset
// that predates the native field. Returns null when absent.
export function adpFor(p, scoring) {
  const a = p.adp;
  if (!a) return null;
  if (scoring === 'half') {
    if (a.half != null) return a.half;
    if (a.ppr != null && a.standard != null) return (a.ppr + a.standard) / 2;
    return a.ppr ?? a.standard ?? null;
  }
  return a[scoring] ?? null;
}

// Replacement-level value per position: the value of the player at the league-size-aware
// replacement depth (shared with the board/rankings tab via nflReplacementDepths, so the
// engine never drifts from the UI). NFL positions get depths from the league's size +
// starting lineup; any other sport's positions fall back to the pool's median depth.
function replacementLevels(players, scoring, settings) {
  const depths = nflReplacementDepths(settings || {});
  const byPos = {};
  for (const p of players) (byPos[p.pos] ||= []).push(valueOf(p, scoring));
  const levels = {};
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((a, b) => b - a);
    const depth = Math.round(depths[pos] ?? Math.ceil(vals.length / 2));
    levels[pos] = vals[Math.min(Math.max(depth - 1, 0), vals.length - 1)] ?? 0;
  }
  return levels;
}

// Count how many of each position the drafter already holds.
function countByPos(roster) {
  const c = {};
  for (const r of roster) c[r.pos] = (c[r.pos] || 0) + 1;
  return c;
}

// Draft-end pressure from how many spare picks remain beyond the mandatory starting
// slots we still haven't filled. This is derived from roster state, not a fixed round:
// urgency builds as the cushion shrinks, so a smart drafter reaches for must-haves as
// the clock runs out rather than at some hardcoded round. (slack <= 0 is handled as a
// hard "forced" tier in recommend; this is the smooth ramp leading up to it.)
function deadlinePressure(slack) {
  if (slack >= 5) return 1;       // plenty of picks left — no rush
  if (slack <= 0) return 2.2;     // out of cushion — needs surge (forced tier also fires)
  return 1 + (5 - slack) * 0.2;   // slack 4→1.2, 3→1.4, 2→1.6, 1→1.8
}

// VONA (Value Over Next Available): the same-position value cliff from the best available player at
// a position to the next one still on the board. A steep cliff means waiting costs a real drop-off,
// so urgency to grab the position NOW should rise. VONA_REF is the cliff size (in board-value points,
// which equal VORP points since the shared replacement level cancels in a same-position difference)
// that earns the full boost — set to the NFL steal/reach magnitude the UI grades by, so a one-"steal"
// cliff maxes out. VONA_MAX caps the extra urgency so a cliff nudges the order rather than dominating.
const VONA_REF = 15;
const VONA_MAX = 0.5;

// Need multiplier — how much to want this position right now, reading both our roster
// and the live board. No fixed round logic: urgency emerges from (1) whether we still
// owe a starting slot, (2) how fast startable players at the position are drying up,
// (3) a live run on the position, (4) how few picks remain to meet requirements, and
// (5) a steep same-position value cliff (VONA) that makes grabbing now worth it.
// The wide spread lets real need override the raw-VORP edge that made every pick an RB.
function needFactor(pos, counts, board) {
  const have = counts[pos] || 0;
  const min = (board.minRoster || MIN_ROSTER)[pos] || 0;
  const gap = Math.max(0, min - have); // unfilled starting slots at this position

  // (1) Desire from our own roster. Below the minimum we want it badly; once the starter slot is
  // filled, appetite for more is per-position, with hard caps so the board can't hoard one position:
  //   RB/WR — no cap: they reward real bench depth (FLEX, byes, injuries), so desire decays slowly and
  //     stays meaningfully elevated (floor ~0.45), well above the QB/TE tail below.
  //   QB — soft cap ~3: a 2nd is a fine backup/streamer, the 3rd drops sharply (tighter still in
  //     single-QB leagues), the 4th is ~zero — keeps 3rd+ QB out of the shortlist.
  //   TE — one "auto" TE (the starter). In a standard 1-TE league every TE beyond it is a FLEX body,
  //     wanted only when it out-values the best RB/WR left for the flex; 2-TE leagues keep the soft cap.
  //   K/DST — a backup is worthless; the forced tier still guarantees the one starter.
  let desire;
  if (gap > 0) {
    desire = gap >= 2 ? 1.5 : 1.2;
  } else {
    const surplus = have - min; // extra bodies beyond the mandatory starters at this position
    // RB/WR bench/flex depth: rewards real depth (FLEX, byes, injuries), decays slowly, floor ~0.45.
    // A flex-winning TE (below) is valued on this SAME curve — it's competing for the same flex spot.
    const flexDepthDesire = surplus === 0 ? 0.9 : surplus === 1 ? 0.75 : surplus === 2 ? 0.62 : surplus === 3 ? 0.52 : 0.45;
    if (pos === 'RB' || pos === 'WR') {
      desire = flexDepthDesire;
    } else if (pos === 'QB') {
      // Single-QB leagues: a 3rd QB is nearly worthless (one starter, at most a bye-week streamer),
      // so the surplus-1 tier is tightened to ~0.05 — it only clears the shortlist on a real value
      // outlier. Superflex/2-QB (min ≥ 2) keeps the looser 0.10, where a 3rd QB is a legit
      // flex-startable body. The 2nd-QB backup (surplus 0) and 4th+ tail are unchanged.
      const singleQB = min === 1;
      desire = surplus === 0 ? 0.45 : surplus === 1 ? (singleQB ? 0.05 : 0.1) : 0.03;
    } else if (pos === 'TE') {
      if (min === 1) {
        // Standard single-TE league: only ONE TE is an "auto" pick — the starter slot (handled by the
        // gap>0 branch above). Every TE beyond it (2nd, 3rd, …) is really a FLEX body competing with
        // RB/WR, so it's wanted only when the best TE left out-values the best flex-eligible RB/WR left.
        // Win the flex and it's valued on the same RB/WR depth curve (flexDepthDesire); lose it and it
        // drops to the dead-depth tail, so the Coach can't hoard TEs over thinner RB/WR benches. This is
        // the flex evaluation applied to TE as a candidate, not a TE-specific threshold. TE-premium/
        // 2-TE-starter leagues (min ≥ 2) keep the looser soft-cap curve.
        const bv = board.bestVorp || {};
        const winsFlex = (bv.TE || 0) > Math.max(bv.RB || 0, bv.WR || 0);
        desire = winsFlex ? flexDepthDesire : 0.03;
      } else {
        desire = surplus === 0 ? 0.5 : surplus === 1 ? 0.12 : 0.03;
      }
    } else {
      desire = 0.02; // K / DST
    }
  }

  // (2) Scarcity from the board: startable (above-replacement) players left vs. how many
  // the league still wants. As the pool thins toward demand, urgency climbs — but it's
  // muted for slots we've already filled (a scarce position we're set at isn't our problem).
  const demand = (board.teams || 10) * ((board.demand || LEAGUE_DEMAND)[pos] || 1);
  const left = board.startableLeft[pos] || 0;
  const ratio = demand > 0 ? left / demand : 1;
  let scarcity = 1 + Math.max(0, 1 - ratio);            // 1.0 (plenty) .. 2.0 (nearly gone)
  if (gap === 0) scarcity = 1 + (scarcity - 1) * 0.25;  // dampened once the slot is filled

  // (3) React to a live run on a position we still need — others are clearing the shelf.
  const runBump = board.run && gap > 0 ? 1.2 : 1;

  // (4) Draft-end pressure on slots we still owe.
  const deadline = gap > 0 ? deadlinePressure(board.slack) : 1;

  // (5) VONA cliff: a steep same-position drop-off (best available minus next available) raises
  // urgency to grab this position before the tier breaks. Capped by VONA_MAX so it nudges rather
  // than dominates, and dampened once the starting slot is filled so it can't reignite depth-
  // hoarding at a position we're already set at (keeps it from fighting the QB/TE soft caps).
  const cliff = (board.vonaCliff || {})[pos] || 0;
  let vona = 1 + clampNum(cliff / VONA_REF, 0, 1) * VONA_MAX;
  if (gap === 0) vona = 1 + (vona - 1) * 0.4;

  return desire * scarcity * runBump * deadline * vona;
}

// Human phrasings for a VONA "swing" (see recommendNfl's vonaSwing). Kept here next to the signal so
// the deterministic clause and the analyst-prompt facts can't drift, and so both stay offline-testable
// (advise.js can't be imported without Clerk creds). `swing` is the { pos, startable, altName, altPos,
// altStartable } object, or null → empty string.
//
// The clause the user always sees: it carries the concrete startable-count numbers.
export function vonaScarcityClause(swing) {
  if (!swing) return '';
  return `Only ${swing.startable} startable ${swing.pos} left vs. ${swing.altStartable} ${swing.altPos}.`;
}
// The facts fed to the analyst (Claude), told to explain the reasoning but not restate the raw counts
// (the clause above already carries them), so its prose stays consistent with the deterministic clause.
export function vonaScarcityPromptNote(swing) {
  if (!swing) return '';
  return `\n\nSCARCITY TRADEOFF: ${swing.pos} is scarcer than ${swing.altPos} — only ${swing.startable} `
    + `startable ${swing.pos} left vs. ${swing.altStartable} ${swing.altPos}. The highest raw value on the `
    + `board is ${swing.altName} (${swing.altPos}), but securing ${swing.pos} now is the smarter play. `
    + `Explain WHY this tradeoff is worth it in your rationale, but do NOT restate the raw startable counts.`;
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Structured, non-LLM reason-label for an NFL candidate (board highlight + Claude-unavailable fallback).
// Leads with roster fit (the team-balance point), then the signal that colors the pick. `depth` is a
// useful non-need position (RB/WR/TE) where added bodies still matter.
function nflReasonLabel({ pos, need, forced, falling, consistency, form }) {
  const chips = [];
  if (forced) chips.push(`must fill ${pos}`);
  else if (need) chips.push(`fills ${pos} need`);
  else if (pos === 'RB' || pos === 'WR' || pos === 'TE') chips.push(`${pos} depth`);
  if (falling) chips.push('falling past ADP');
  if (consistency != null) {
    if (consistency >= 70) chips.push('steady floor');
    else if (consistency <= 45) chips.push('high-variance');
  }
  if (form === 'hot') chips.push('hot');
  return chips.slice(0, 3).join(' · ');
}

// Structured reason-label for a roto candidate: which of the ROSTER'S weak categories this player fills
// (the team-balance point), else his elite categories, plus an open lineup slot. `weight` is categoryNeed's
// per-cat up-weighting (>1 = the roster is light there); z is the player's per-cat standardized value.
function rotoReasonLabel(p, weight, cfg, slotPos) {
  const chips = [];
  const z = p.z || {};
  const gapCats = cfg.CAT_KEYS
    .filter((k) => (weight[k] ?? 1) > 1.1 && (z[k] ?? 0) >= 0.6)  // roster light here AND he's strong here
    .sort((a, b) => (z[b] || 0) - (z[a] || 0))
    .slice(0, 2)
    .map((k) => cfg.CAT_LABEL[k]);
  if (gapCats.length) {
    chips.push(`fills your ${gapCats.join('/')} gap`);
  } else {
    const strong = cfg.CAT_KEYS
      .map((k) => ({ k, z: z[k] || 0 })).sort((a, b) => b.z - a.z)
      .filter((x) => x.z >= 0.8).slice(0, 2).map((x) => cfg.CAT_LABEL[x.k]);
    if (strong.length) chips.push(`elite ${strong.join('/')}`);
  }
  if (slotPos) chips.push(`open ${slotPos} slot`);
  return chips.slice(0, 2).join(' · ');
}

// Detect a recent run on a position (scarcity signal) from the last few picks.
function positionRuns(recentPicks) {
  const counts = {};
  for (const p of recentPicks.slice(-6)) counts[p.pos] = (counts[p.pos] || 0) + 1;
  return Object.entries(counts)
    .filter(([, n]) => n >= 3)
    .map(([pos]) => pos);
}

/**
 * Recommend the best available picks.
 * @param players  full player list (from loadPlayers)
 * @param drafted  Set/array of already-drafted player ids
 * @param roster   the drafter's current picks [{ id, pos }]
 * @param settings league settings (DEFAULT_SETTINGS shape)
 * @param round    current round (1-based)
 * @param recentPicks recent league picks [{ pos }] for run detection (optional)
 * @returns { candidates, runs } — candidates sorted best-first
 */
export function recommend(players, drafted, roster = [], settings = DEFAULT_SETTINGS, round = 1, recentPicks = []) {
  const sport = settings.sport || 'nfl';
  const cfg = ROTO[sport];
  // Re-hydrate the roster: callers pass [{ id, pos }] (positions + ids only), but the team-balance logic
  // needs each drafted player's full profile — the per-category z (roto category need) and the signal set
  // (consistency, form). Join the ids back to the full pool so categoryNeed/adjustedValue/weakCats actually
  // fire (they skip any entry with no .z, so today they no-op on the bare {id,pos} roster). The roster
  // entry's own fields win on conflict, so the drafted SLOT (pos) is preserved.
  const byId = new Map(players.map((p) => [p.id, p]));
  const hydrated = (roster || []).map((r) => { const full = r && byId.get(r.id); return full ? { ...full, ...r } : r; });
  if (cfg) return recommendRoto(players, drafted, hydrated, settings, round, recentPicks, cfg);
  return recommendNfl(players, drafted, hydrated, settings, round, recentPicks);
}

// --- Roto (category) recommender -------------------------------------------------------------
// Drives every category sport (NBA/WNBA/MLB/NHL) off a uniform per-sport adapter `M` (see the
// ROTO table). Same contract as recommendNfl ({ candidates, runs, board }) so advise.js and the
// UI are structurally unchanged, but value is category-based: a player's worth is his total
// category z, reweighted toward the roster's WEAK categories (M.categoryNeed) so the engine
// balances cats rather than always grabbing the highest raw z. Positional need comes from open
// starting slots; a late-draft forced tier guarantees a legal lineup. No ADP/projections in v1,
// so those candidate fields are null and mock opponents pick by category value.
function recommendRoto(players, drafted, roster = [], settings = {}, round = 1, recentPicks = [], M) {
  const taken = drafted instanceof Set ? drafted : new Set(drafted);
  const teams = settings.teams || 12;
  const totalRounds = settings.rounds || 13;
  const available = players.filter((p) => !taken.has(p.id) && typeof p.zTotal === 'number');

  const replacement = M.replacementLevel(players, settings);
  const weight = M.categoryNeed(roster);    // up-weights the roster's lagging categories
  // Open starting slots (flex-aware). Flex/UTIL takes anyone, so only the SPECIFIC slots can
  // truly go unfilled — those drive need, the forced tier, and the analyst note.
  const open = M.specificOpenSlots(roster, settings);
  const openCount = Object.values(open).reduce((a, b) => a + b, 0);
  const picksLeft = Math.max(0, totalRounds - roster.length);
  const slack = picksLeft - openCount;      // spare picks beyond unfilled specific starting slots

  // Above-replacement players left by base position — the scarcity signal for the analyst.
  const startableLeft = {};
  for (const p of available) {
    if (M.value(p) > replacement) startableLeft[p.pos] = (startableLeft[p.pos] || 0) + 1;
  }

  const runs = positionRuns(recentPicks);
  const runSet = new Set(runs);

  const scored = available
    .map((p) => {
      const v = M.value(p);
      const adj = M.adjustedValue(p, weight); // category-balanced value
      const slot = M.bestOpenSlot(p.pos, open); // tightest specific open slot he fills (or null)
      const fills = slot != null;              // addresses a real positional gap (not just flex)
      // Slot urgency: a nudge for filling an open specific slot, surging as the cushion runs out
      // so we lock a legal lineup before chasing luxury depth (roto analog of the NFL forced tier).
      const slotBoost = fills ? (slack <= 0 ? 1.6 : slack <= 2 ? 1.2 : 1.05) : 1;
      const runBump = fills && runSet.has(p.pos) ? 1.08 : 1;
      return {
        id: p.id, name: p.name, team: p.team, pos: p.pos, rank: p.rank,
        value: Math.round(v * 100) / 100,
        vorp: Math.round((v - replacement) * 100) / 100,
        score: Math.round(adj * slotBoost * runBump * 100) / 100,
        need: fills,                       // fills an open specific starting slot
        forced: fills && slack <= 0,       // out of spare picks — must lock a starter now
        adp: null, picksPastAdp: 0, falling: false, proj: null, // no roto ADP/projections in v1
        z: p.z, n: p.n, cats: p.cats,      // category detail for the analyst layer
        form: (p.tag === 'hot' || p.tag === 'cold') ? p.tag : null, // in-season only; usually absent preseason
        statLabels: p.statLabels, stats: [p.s1, p.s2, p.s3, p.s4, p.s5, p.s6], // real stat line
        // Which of the roster's WEAK categories he fills (team-balance point), else his elite cats + open slot.
        reasonLabel: rotoReasonLabel(p, weight, M, slot),
      };
    })
    .sort((a, b) =>
      (b.forced ? 1 : 0) - (a.forced ? 1 : 0) ||
      b.score - a.score ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9)
    );

  // Open specific slots double as roster "needs"; weakest categories guide the analyst's read.
  const needs = Object.entries(open).map(([pos, gap]) => ({ pos, gap }));
  const weakCats = M.CAT_KEYS.slice()
    .sort((a, b) => weight[b] - weight[a])
    .filter((k) => weight[k] > 1.05)
    .slice(0, 3)
    .map((k) => M.CAT_LABEL[k]);

  const board = {
    startableLeft, slack, teams, picksLeft, totalRounds, needs, weakCats,
    mustFillNow: slack <= 0 && needs.length > 0,
    fillSoon: slack === 1 && needs.length > 0,
  };
  return { candidates: scored.slice(0, 12), runs, board };
}

function recommendNfl(players, drafted, roster = [], settings = DEFAULT_SETTINGS, round = 1, recentPicks = []) {
  const taken = drafted instanceof Set ? drafted : new Set(drafted);
  const scoring = settings.scoring || 'ppr';
  const levels = replacementLevels(players, scoring, settings);
  const counts = countByPos(roster);
  const minRoster = minRosterFrom(settings);   // mandatory slots for THIS league (drives need/forced)
  const demand = leagueDemandFrom(settings);   // per-position scarcity demand (FLEX folded in)
  const teams = settings.teams || 10;
  const totalRounds = settings.rounds || 15;

  const available = players.filter((p) => !taken.has(p.id));

  // Board read: how many startable (above-replacement) players remain at each position.
  // This is the live scarcity signal that drives reactive urgency in needFactor.
  const startableLeft = {};
  for (const p of available) {
    if (valueOf(p, scoring) > (levels[p.pos] ?? 0)) startableLeft[p.pos] = (startableLeft[p.pos] || 0) + 1;
  }

  // Same-position value cliffs for VONA urgency: best-available minus next-available at each
  // position, on raw board value (the shared replacement level cancels in the difference, so this
  // is exactly the VORP gap). needFactor turns a steep cliff into extra urgency to grab it now.
  const posVals = {};
  for (const p of available) (posVals[p.pos] ||= []).push(valueOf(p, scoring));
  const vonaCliff = {};
  for (const pos of Object.keys(posVals)) {
    const vs = posVals[pos].sort((a, b) => b - a);
    vonaCliff[pos] = vs.length >= 2 ? Math.max(0, vs[0] - vs[1]) : 0;
  }

  // Best-available VORP by position (posVals is now sorted desc, so [0] is the top value). The FLEX
  // comparator in needFactor: since RB/WR/TE all fill the flex, a TE beyond its lone starter slot is
  // worth drafting only when its best remaining body out-values the best flex-eligible RB/WR left.
  const bestVorp = {};
  for (const pos of Object.keys(posVals)) bestVorp[pos] = Math.max(0, posVals[pos][0] - (levels[pos] ?? 0));

  // Draft-end cushion: spare picks beyond the mandatory starting slots still unfilled.
  // Derived from roster state, not the round number — when it hits zero, those unmet
  // requirements become "forced" and sort ahead of pure value so we never end the draft
  // missing a starter (e.g. no kicker), which raw VORP would otherwise never pick.
  let mandatoryRemaining = 0;
  for (const [pos, m] of Object.entries(minRoster)) mandatoryRemaining += Math.max(0, m - (counts[pos] || 0));
  const picksLeft = Math.max(0, totalRounds - roster.length);
  const slack = picksLeft - mandatoryRemaining;

  const runs = positionRuns(recentPicks);
  const runSet = new Set(runs);

  // The overall pick currently on the clock (every drafted player is one prior pick),
  // used to spot players who've slipped past their average draft position.
  const currentPick = taken.size + 1;

  const scored = available
    .map((p) => {
      const v = valueOf(p, scoring);
      // K/DST sink below the startable skill pool: pure VORP floats elite ones into the
      // early rounds, but they belong in the last couple rounds (near-random week to week).
      // Zeroing their VORP keeps them out of proactive picks; the forced tier below still
      // guarantees a kicker/defense gets drafted once the roster cushion runs out.
      const isKD = p.pos === 'K' || p.pos === 'DST';
      const vorp = isKD ? 0 : Math.max(0, v - (levels[p.pos] ?? 0));
      const gap = Math.max(0, (minRoster[p.pos] || 0) - (counts[p.pos] || 0));
      const factor = needFactor(p.pos, counts, { startableLeft, teams, slack, run: runSet.has(p.pos), minRoster, demand, vonaCliff, bestVorp });

      // ADP value: a player still on the board well past his average draft position is
      // a falling value. Bump priority by how far he's slipped, capped at ~two rounds
      // past ADP (so a massive faller can't override genuine roster need entirely).
      const adp = adpFor(p, scoring);
      const adpDelta = adp != null ? currentPick - adp : 0; // > 0 means falling past ADP
      const adpBoost = adpDelta > 0 ? 1 + (Math.min(adpDelta, 2 * teams) / (2 * teams)) * 0.6 : 1;

      // Consistency as a SMALL tiebreaker (±5% at most, centered at 60): a steady floor breaks near-ties
      // between comparable players without overriding VORP/need. Absent (offseason/thin) → neutral.
      const consBoost = p.consistency != null ? 1 + clampNum((p.consistency - 60) / 40, -1, 1) * 0.05 : 1;
      const need = gap > 0;
      const forced = gap > 0 && slack <= 0;
      const falling = adpDelta >= teams;
      const form = (p.tag === 'hot' || p.tag === 'cold') ? p.tag : null;

      return {
        id: p.id,
        name: p.name,
        team: p.team,
        pos: p.pos,
        rank: p.rank,
        value: Math.round(v * 10) / 10,
        vorp: Math.round(vorp * 10) / 10,
        // The +0.5 floor keeps the need factor meaningful at/below replacement (vorp≈0): a capped 3rd
        // QB/TE must still sort BELOW uncapped RB/WR depth in the late rounds, instead of everyone
        // collapsing to score 0 and the raw board rank piling a position up.
        score: Math.round((vorp + 0.5) * factor * adpBoost * consBoost * 10) / 10,
        need,                           // still owe a starting slot here
        forced,                         // out of spare picks — must take a need now
        adp: adp != null ? Math.round(adp * 10) / 10 : null,
        // Signed pick-vs-ADP gap: > 0 = still on the board past his ADP (value); < 0 = taken ahead of his
        // ADP (a reach). The analyst phrases both directions off THIS number instead of inventing its own.
        adpDelta: adp != null ? Math.round(adpDelta) : null,
        picksPastAdp: adpDelta > 0 ? Math.round(adpDelta) : 0, // how far he's slipped past ADP (kept for scoring)
        falling,                        // slipped a full round-plus past expected — a value
        proj: p.proj?.fpts ?? null,     // consensus (Sleeper) projected fantasy points
        // Fused signals (already on the dataset row): weekly consistency + ceiling, and in-season form.
        consistency: p.consistency ?? null,
        ceiling: p.ceiling ?? null,
        form,
        reasonLabel: nflReasonLabel({ pos: p.pos, need, forced, falling, consistency: p.consistency ?? null, form }),
      };
    })
    // Forced needs first (so a mandatory slot is never skipped at the buzzer), then by
    // the reactive score, then by raw board rank as a tiebreak.
    .sort((a, b) =>
      (b.forced ? 1 : 0) - (a.forced ? 1 : 0) ||
      b.score - a.score ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9)
    );

  // Unfilled mandatory starting slots, for the AI surfaces to flag roster necessity late
  // in the draft (when the only spots left are essentially K/DST). `mustFillNow` fires when
  // there's no cushion left — those needs are also `forced` above; `fillSoon` is the
  // one-pick-early heads-up so the user isn't squeezed into back-to-back forced picks.
  const needs = [];
  for (const [pos, m] of Object.entries(minRoster)) {
    const gap = Math.max(0, m - (counts[pos] || 0));
    if (gap > 0) needs.push({ pos, gap });
  }

  // VONA swing: did positional scarcity decide the pick? This fires only when the recommended pick is a
  // need at a scarcer position that we took OVER a genuinely higher-raw-value name still on the board at
  // a deeper position — i.e. the drop-off/scarcity logic (which VONA feeds) passed on more raw value to
  // secure the drying-up position. (A same-position cliff alone never triggers this: it lifts an already
  // top-value name, so there's nothing higher passed over. The real tradeoff is cross-position.) Skipped
  // under a roster-necessity override (forced) — that's a legality pick, not a scarcity read. The
  // concrete startable-count tradeoff is surfaced so the analyst layer can explain it.
  let vonaSwing = null;
  const pick = scored[0];
  if (pick && !pick.forced && pick.need) {
    let alt = null; // highest raw-value (VORP) candidate at a DIFFERENT position — the name we passed over
    for (const c of scored) {
      if (c.pos === pick.pos) continue;
      if (!alt || c.vorp > alt.vorp) alt = c;
    }
    if (alt && alt.vorp > pick.vorp
      && (startableLeft[pick.pos] || 0) < (startableLeft[alt.pos] || 0)) {
      vonaSwing = {
        pos: pick.pos, startable: startableLeft[pick.pos] || 0,
        altName: alt.name, altPos: alt.pos, altStartable: startableLeft[alt.pos] || 0,
      };
    }
  }

  // Board context for the analyst layer (advise.js): positional scarcity, draft-end
  // cushion, league size, roster needs, and a VONA scarcity-swing note when one fired.
  // Additive — existing consumers read candidates/runs only.
  const board = {
    startableLeft, slack, teams, picksLeft, totalRounds, needs, vonaSwing,
    mustFillNow: slack <= 0 && needs.length > 0,
    fillSoon: slack === 1 && needs.length > 0,
  };
  return { candidates: scored.slice(0, 12), runs, board };
}
