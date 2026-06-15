// Draft-assistant engine: best-available recommendations over the cached rankings
// dataset, by value-over-replacement (VORP) adjusted for the drafter's roster needs.
// Shared by the mock draft (AI opponents + suggestions) and premium real-draft mode.
// Pure/algorithmic — no LLM here; advise.js layers a Claude rationale on top.
import { buildNflDataset } from './buildNflDataset.js';
import { buildNbaDataset, buildWnbaDataset } from './buildNbaDataset.js';
import { buildNhlDataset } from './buildNhlDataset.js';
import { redis, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, DATASET_VERSION } from './kv.js';

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

// Roughly how deep each position is drafted before quality falls to "replacement"
// level in a ~10-team league. The Nth-best player at a position sets its baseline.
const REPLACEMENT_DEPTH = { QB: 12, RB: 30, WR: 30, TE: 10, K: 10, DST: 10 };
const FLEX_POS = new Set(['RB', 'WR', 'TE']);

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

// The ranking value we draft on: PPR uses fp (PPR-anchored), Standard uses the
// Standard ranking value when present. Falls back across fields for non-NFL sports.
function valueOf(p, scoring) {
  if (scoring === 'standard') return p.rankStd ?? p.fpStd ?? p.fp ?? p.fpPpr ?? 0;
  return p.fp ?? p.fpPpr ?? p.fpStd ?? 0;
}

// Replacement-level value per position: the value of the player at REPLACEMENT_DEPTH.
function replacementLevels(players, scoring) {
  const byPos = {};
  for (const p of players) (byPos[p.pos] ||= []).push(valueOf(p, scoring));
  const levels = {};
  for (const [pos, vals] of Object.entries(byPos)) {
    vals.sort((a, b) => b - a);
    const depth = REPLACEMENT_DEPTH[pos] ?? Math.ceil(vals.length / 2);
    levels[pos] = vals[Math.min(depth, vals.length - 1)] ?? 0;
  }
  return levels;
}

// Count how many of each position the drafter already holds.
function countByPos(roster) {
  const c = {};
  for (const r of roster) c[r.pos] = (c[r.pos] || 0) + 1;
  return c;
}

// Need multiplier: boost positions whose starter slots aren't filled, soften ones
// already stocked, and strongly defer K/DST until the draft is winding down.
function needFactor(pos, counts, settings, round) {
  if ((pos === 'K' || pos === 'DST') && round < settings.rounds - 2) return 0.15;

  const starters = settings.starters || {};
  const have = counts[pos] || 0;
  let target = starters[pos] || 0;
  // FLEX-eligible positions get a little extra headroom for the flex slot.
  if (FLEX_POS.has(pos)) target += starters.FLEX || 0;

  if (have < target) return 1.3; // still need a starter here
  if (have < target + 1) return 1.0; // useful depth
  return 0.8; // already deep
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
  const levels = replacementLevels(players, scoring);
  const counts = countByPos(roster);

  const scored = players
    .filter((p) => !taken.has(p.id))
    .map((p) => {
      const vorp = Math.max(0, valueOf(p, scoring) - (levels[p.pos] ?? 0));
      const factor = needFactor(p.pos, counts, settings, round);
      return {
        id: p.id,
        name: p.name,
        team: p.team,
        pos: p.pos,
        rank: p.rank,
        value: Math.round(valueOf(p, scoring) * 10) / 10,
        vorp: Math.round(vorp * 10) / 10,
        score: Math.round(vorp * factor * 10) / 10,
        need: factor >= 1.3,
      };
    })
    .sort((a, b) => b.score - a.score || (a.rank ?? 1e9) - (b.rank ?? 1e9));

  return { candidates: scored.slice(0, 8), runs: positionRuns(recentPicks) };
}
