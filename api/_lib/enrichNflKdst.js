// NFL v1 K/DST enrichment — picks a BETTER kicker/defense within the late-round window the draft engine
// already reserves for them. It does NOT change WHEN K/DST get drafted: it never touches VORP, the desire
// curves, or SCARCITY_SKIP_POS. It only attaches a `p.kdst` signal object (+ short human label) that the
// Coach/board surfaces read once we're already in that window, so the recommended K/DST is the stronger one.
//
// Three v1 signals, in priority order:
//   • projFpts   — Sleeper season-long projection (already on p.proj from enrichNflProjections). THE anchor:
//                  it natively prices in role, offense, and expectation for both K and DST.
//   • offenseTier— the kicker's team offense rank (points-for) from dataset.teamContext (buildNflDataset).
//                  A mid-pack offense drives into FG range but stalls in the red zone → more FG attempts.
//   • dome       — static venue attribute (weather-proof floor all season). K only in the label; DST carries
//                  the flag but doesn't lead with it (defense value isn't weather-driven).
//   • jobRole    — Sleeper depth_chart_order (kickers only) → lead / competition / backup. The projections
//                  feed lacks depth order, so it comes from the players dump (fetchKickerDepth, cached).
//
// Pure attachment, additive, failure-tolerant: a missing signal just drops out of the label; a failed depth
// pull degrades to the last good cached map. DST gets projFpts + its OWN defense rank (v2 — points-allowed
// rank from teamContext) + dome flag; no offense/job (it IS the defense). Runs in the daily cron AFTER
// enrichNflProjections (needs p.proj) — see api/cron/refresh.js.

import { keyFor } from './fantasyProjections.js';
import { NFL_DEPTH_KEY } from './kv.js';

// Domes + fixed/retractable roofs — a kicker here is weather-proof all year. Keyed by ESPN team abbrev.
// Retractable-roof stadiums are included: they play the vast majority of games closed, so for a season-long
// draft signal they read as indoor. (Game-week weather stays the Pick'em flow's job, not the draft board's.)
const DOME_TEAMS = new Set(['ARI', 'ATL', 'DAL', 'DET', 'HOU', 'IND', 'LV', 'MIN', 'NO', 'LAR', 'LAC']);

const SLEEPER_PLAYERS = 'https://api.sleeper.app/v1/players/nfl';
const UA = { 'User-Agent': 'FantasyEdge/1.0 (+https://fantasy-edge-nine.vercel.app)' };

// Fetch Sleeper's players dump (~14.6MB) and distill it to a tiny per-kicker map before returning, so KV
// never stores the raw dump. Returns { builtAt, kickers: { [keyFor('K',name)]: { order, status, injury } },
// teams: { [abbr]: activeKickerCount } } or null on any failure (caller falls back to the cached map).
export async function fetchKickerDepth() {
  try {
    const res = await fetch(SLEEPER_PLAYERS, { headers: UA });
    if (!res.ok) return null;
    const dump = await res.json();
    if (!dump || typeof dump !== 'object') return null;
    const kickers = {};
    const teams = {};
    for (const pl of Object.values(dump)) {
      if (!pl || pl.position !== 'K' || !pl.team) continue;
      // Ignore clearly-inactive bodies (waived/retired) for the competition count, but keep IR/injured on the
      // roster so an injured incumbent still reads as "on the roster" rather than vanishing.
      const active = pl.active !== false && pl.status !== 'Inactive';
      const name = pl.full_name || `${pl.first_name || ''} ${pl.last_name || ''}`.trim();
      if (!name) continue;
      const key = keyFor('K', name);
      kickers[key] = {
        order: pl.depth_chart_order ?? null,
        status: pl.status || null,
        injury: pl.injury_status || null,
        team: pl.team,
      };
      if (active) teams[pl.team] = (teams[pl.team] || 0) + 1;
    }
    if (!Object.keys(kickers).length) return null;
    // Second pass: a kicker on a team with >1 active kicker is in a competition (unless he clearly owns order 1).
    for (const k of Object.values(kickers)) {
      k.competition = (teams[k.team] || 0) > 1 && k.order !== 1;
    }
    return { builtAt: new Date().toISOString(), kickers, teams };
  } catch {
    return null;
  }
}

// Kicker job role from the distilled depth entry. order 1 (or sole rostered K) = lead; order >= 2 = backup;
// unranked but contested = competition. Injury/IR is surfaced separately so a hurt incumbent still reads as
// the starter but flagged.
function jobRoleOf(d) {
  if (!d) return null;
  if (d.order === 1) return 'lead';
  if (d.order != null && d.order >= 2) return 'backup';
  return d.competition ? 'competition' : 'lead'; // unranked + uncontested = de-facto starter
}

// Coarse tier from a 1-based rank within `n` ranked teams (thirds) — used for both the kicker's offense
// rank and the DST's defense rank. The label carries the raw rank number too, so the exact "mid-pack"
// read isn't lost to bucketing.
function rankTierOf(rank, n) {
  if (!rank || !n) return null;
  if (rank <= Math.ceil(n / 3)) return 'top';
  if (rank <= Math.ceil((2 * n) / 3)) return 'mid';
  return 'low';
}

const INJ = /(IR|Out|Doubtful|PUP|Suspension)/i;

// Pure per-player K/DST signal builder (no network) — the offline-testable core. Returns the p.kdst object
// for one K/DST player, or null for anything else. `tc` = dataset.teamContext; `depthMap` = distilled
// kicker depth (keyFor('K',name) -> { order, status, injury }). Kept separate from the network wrapper so
// the labeling logic has direct regression coverage (verify-draft-coach) without hitting Sleeper.
export function kdstForPlayer(p, tc = {}, depthMap = {}) {
  if (!p) return null;
  if (p.pos === 'K') {
    const abbr = (p.teamId != null && tc[p.teamId]?.abbr) || p.team || null;
    const t = p.teamId != null ? tc[p.teamId] : null;
    const offenseRank = t?.offenseRank ?? null;
    const offenseTier = rankTierOf(offenseRank, t?.teamsRanked);
    const dome = abbr ? DOME_TEAMS.has(abbr) : null;
    const d = depthMap[keyFor('K', p.name)] || null;
    const jobRole = jobRoleOf(d);
    const hurt = d?.injury ? INJ.test(d.injury) : false;
    const projFpts = p.proj?.fpts ?? null;

    const parts = [];
    if (projFpts != null) parts.push(`proj ${Math.round(projFpts)} pts`);
    if (offenseRank) parts.push(`${abbr || 'team'} offense #${offenseRank}`);
    if (dome) parts.push('dome');
    if (jobRole === 'lead' && !hurt) parts.push('lead K');
    else if (jobRole === 'competition') parts.push('in a K competition');
    else if (jobRole === 'backup') parts.push('backup K');
    if (hurt) parts.push(`injury: ${d.injury}`);

    return {
      projFpts, offenseRank, offenseTier, defenseRank: null, defenseTier: null, dome,
      jobRole, jobOrder: d?.order ?? null, jobInjury: d?.injury ?? null,
      label: parts.join(' · ') || null,
    };
  }
  if (p.pos === 'DST') {
    // v2: a DST's own defensive strength (points-allowed rank from teamContext) is the "which DST" signal
    // beyond the raw projection. Joins teamContext by p.teamId (buildNflDataset stamps it on the DST row).
    const projFpts = p.proj?.fpts ?? null;
    const t = p.teamId != null ? tc[p.teamId] : null;
    const abbr = (t?.abbr) || p.team || null;
    const defenseRank = t?.defenseRank ?? null;
    const defenseTier = rankTierOf(defenseRank, t?.teamsRanked);
    const dome = abbr ? DOME_TEAMS.has(abbr) : null;

    const parts = [];
    if (projFpts != null) parts.push(`proj ${Math.round(projFpts)} pts`);
    if (defenseRank) parts.push(`${abbr || 'team'} defense #${defenseRank}`);

    return {
      projFpts, offenseRank: null, offenseTier: null, defenseRank, defenseTier, dome,
      jobRole: null, jobOrder: null, jobInjury: null,
      label: parts.join(' · ') || null,
    };
  }
  return null;
}

// Attach p.kdst to every K/DST in the dataset. Fetches kicker depth (job security), loops the pure builder.
// Additive + failure-tolerant.
export async function enrichNflKdst(dataset, redis) {
  if (!dataset?.players?.length) return;
  const tc = dataset.teamContext || {};

  // Kicker depth (job security). Fresh pull, else last good cached map — never drops the signal on one bad run.
  let depth = null;
  try {
    depth = await fetchKickerDepth();
    if (depth) await redis?.set?.(NFL_DEPTH_KEY, depth);
    else depth = await redis?.get?.(NFL_DEPTH_KEY);
  } catch {
    try { depth = await redis?.get?.(NFL_DEPTH_KEY); } catch { depth = null; }
  }
  const depthMap = depth?.kickers || {};

  let taggedK = 0, taggedDst = 0;
  for (const p of dataset.players) {
    const kdst = kdstForPlayer(p, tc, depthMap);
    if (!kdst) continue;
    p.kdst = kdst;
    if (p.pos === 'K') taggedK++; else taggedDst++;
  }

  dataset.counts = {
    ...dataset.counts,
    kdst: {
      taggedK, taggedDst,
      depthSource: depth ? (depth.builtAt ? 'sleeper' : 'cached') : 'none',
      kickersWithDepth: Object.keys(depthMap).length,
    },
  };
}
