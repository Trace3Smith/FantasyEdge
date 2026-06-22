// Draft-assistant engine: best-available recommendations over the cached rankings
// dataset, by value-over-replacement (VORP) adjusted for the drafter's roster needs.
// Shared by the mock draft (AI opponents + suggestions) and premium real-draft mode.
// Pure/algorithmic — no LLM here; advise.js layers a Claude rationale on top.
import { buildNflDataset } from './buildNflDataset.js';
import { buildNbaDataset, buildWnbaDataset } from './buildNbaDataset.js';
import { buildNhlDataset } from './buildNhlDataset.js';
import { redis, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, DATASET_VERSION } from './kv.js';
// The board ranks by the same per-format value function the rankings tab and draft board
// use — one shared definition (see /nflScoring.js), so the engine never drifts from the UI.
import { nflRankValue as valueOf, nflReplacementDepths } from '../../nflScoring.js';

// Same per-sport wiring as api/sports.js, so the draft reads the identical cached
// dataset and self-heals on a cold-start miss. NFL is the headline draft sport.
const SPORTS = {
  nfl: { key: NFL_DATASET_KEY, build: () => buildNflDataset() },
  nba: { key: NBA_DATASET_KEY, build: () => buildNbaDataset() },
  wnba: { key: WNBA_DATASET_KEY, build: () => buildWnbaDataset() },
  nhl: { key: NHL_DATASET_KEY, build: () => buildNhlDataset() },
};

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
const LEAGUE_DEMAND = { QB: 1, RB: 2.5, WR: 2.5, TE: 1, K: 1, DST: 1 };

// Load a sport's player list from cache, rebuilding on a miss (mirrors api/sports.js).
export async function loadPlayers(sport = 'nfl') {
  const cfg = SPORTS[sport];
  if (!cfg) return [];
  let dataset = await redis.get(cfg.key);
  const stale = !dataset || !dataset.players || dataset.version !== DATASET_VERSION;
  if (stale) {
    dataset = await cfg.build();
    dataset.version = DATASET_VERSION;
    await redis.set(cfg.key, dataset);
  }
  return (dataset.players || []).filter((p) => !p.searchOnly);
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

// Need multiplier — how much to want this position right now, reading both our roster
// and the live board. No fixed round logic: urgency emerges from (1) whether we still
// owe a starting slot, (2) how fast startable players at the position are drying up,
// (3) a live run on the position, and (4) how few picks remain to meet requirements.
// The wide spread lets real need override the raw-VORP edge that made every pick an RB.
function needFactor(pos, counts, board) {
  const have = counts[pos] || 0;
  const min = MIN_ROSTER[pos] || 0;
  const gap = Math.max(0, min - have); // unfilled starting slots at this position

  // (1) Desire from our own roster. Below the minimum we want it badly; once the slot
  // is filled, appetite for more depends on the position — RB/WR reward bench depth and
  // feed the FLEX, TE a little, while a backup QB/K/DST is almost worthless.
  let desire;
  if (gap > 0) {
    desire = gap >= 2 ? 1.5 : 1.2;
  } else {
    const surplus = have - min;
    if (pos === 'RB' || pos === 'WR') desire = surplus === 0 ? 0.9 : surplus === 1 ? 0.65 : surplus === 2 ? 0.45 : 0.3;
    else if (pos === 'TE') desire = surplus === 0 ? 0.5 : 0.3;
    else desire = 0.05; // extra QB / K / DST — essentially never
  }

  // (2) Scarcity from the board: startable (above-replacement) players left vs. how many
  // the league still wants. As the pool thins toward demand, urgency climbs — but it's
  // muted for slots we've already filled (a scarce position we're set at isn't our problem).
  const demand = (board.teams || 10) * (LEAGUE_DEMAND[pos] || 1);
  const left = board.startableLeft[pos] || 0;
  const ratio = demand > 0 ? left / demand : 1;
  let scarcity = 1 + Math.max(0, 1 - ratio);            // 1.0 (plenty) .. 2.0 (nearly gone)
  if (gap === 0) scarcity = 1 + (scarcity - 1) * 0.25;  // dampened once the slot is filled

  // (3) React to a live run on a position we still need — others are clearing the shelf.
  const runBump = board.run && gap > 0 ? 1.2 : 1;

  // (4) Draft-end pressure on slots we still owe.
  const deadline = gap > 0 ? deadlinePressure(board.slack) : 1;

  return desire * scarcity * runBump * deadline;
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
  const taken = drafted instanceof Set ? drafted : new Set(drafted);
  const scoring = settings.scoring || 'ppr';
  const levels = replacementLevels(players, scoring, settings);
  const counts = countByPos(roster);
  const teams = settings.teams || 10;
  const totalRounds = settings.rounds || 15;

  const available = players.filter((p) => !taken.has(p.id));

  // Board read: how many startable (above-replacement) players remain at each position.
  // This is the live scarcity signal that drives reactive urgency in needFactor.
  const startableLeft = {};
  for (const p of available) {
    if (valueOf(p, scoring) > (levels[p.pos] ?? 0)) startableLeft[p.pos] = (startableLeft[p.pos] || 0) + 1;
  }

  // Draft-end cushion: spare picks beyond the mandatory starting slots still unfilled.
  // Derived from roster state, not the round number — when it hits zero, those unmet
  // requirements become "forced" and sort ahead of pure value so we never end the draft
  // missing a starter (e.g. no kicker), which raw VORP would otherwise never pick.
  let mandatoryRemaining = 0;
  for (const [pos, m] of Object.entries(MIN_ROSTER)) mandatoryRemaining += Math.max(0, m - (counts[pos] || 0));
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
      const vorp = Math.max(0, v - (levels[p.pos] ?? 0));
      const gap = Math.max(0, (MIN_ROSTER[p.pos] || 0) - (counts[p.pos] || 0));
      const factor = needFactor(p.pos, counts, { startableLeft, teams, slack, run: runSet.has(p.pos) });

      // ADP value: a player still on the board well past his average draft position is
      // a falling value. Bump priority by how far he's slipped, capped at ~two rounds
      // past ADP (so a massive faller can't override genuine roster need entirely).
      const adp = adpFor(p, scoring);
      const adpDelta = adp != null ? currentPick - adp : 0; // > 0 means falling past ADP
      const adpBoost = adpDelta > 0 ? 1 + (Math.min(adpDelta, 2 * teams) / (2 * teams)) * 0.6 : 1;

      return {
        id: p.id,
        name: p.name,
        team: p.team,
        pos: p.pos,
        rank: p.rank,
        value: Math.round(v * 10) / 10,
        vorp: Math.round(vorp * 10) / 10,
        score: Math.round(vorp * factor * adpBoost * 10) / 10,
        need: gap > 0,                  // still owe a starting slot here
        forced: gap > 0 && slack <= 0,  // out of spare picks — must take a need now
        adp: adp != null ? Math.round(adp * 10) / 10 : null,
        picksPastAdp: adpDelta > 0 ? Math.round(adpDelta) : 0, // how far he's slipped past ADP
        falling: adpDelta >= teams,     // slipped a full round-plus past expected — a value
        proj: p.proj?.fpts ?? null,     // FantasyPros projected fantasy points
      };
    })
    // Forced needs first (so a mandatory slot is never skipped at the buzzer), then by
    // the reactive score, then by raw board rank as a tiebreak.
    .sort((a, b) =>
      (b.forced ? 1 : 0) - (a.forced ? 1 : 0) ||
      b.score - a.score ||
      (a.rank ?? 1e9) - (b.rank ?? 1e9)
    );

  // Board context for the analyst layer (advise.js): positional scarcity, draft-end
  // cushion, and league size. Additive — existing consumers read candidates/runs only.
  const board = { startableLeft, slack, teams, picksLeft, totalRounds };
  return { candidates: scored.slice(0, 12), runs, board };
}
