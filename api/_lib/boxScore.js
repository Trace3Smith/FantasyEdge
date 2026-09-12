// Box scores for completed games — the full stat line behind a result card.
//
// ESPN's summary endpoint carries everything: per-team totals plus per-athlete rows across ten stat
// groups. What it will NOT do is give you only that. `?enable=boxscore` and
// `?disable=drives,news,...` are both ignored — byte-identical 552KB responses — and `drives` alone
// is 69% of it. So the fetch is unavoidably heavy and the answer is to do it once: a finished box
// score never changes, so it's trimmed to ~6KB and cached without expiry. 552KB in, 6KB out, one
// time per game ever.
//
// Only FINAL games are cached. An in-progress game's numbers are still moving, and pinning them
// under an immutable key would freeze a game at halftime forever.
//
// AND ONLY GAMES THAT ACTUALLY CARRY STATS — see boxScoreHasStats. "Final" is not enough on its
// own, because ESPN serves finished games with `statistics: []` during an outage: the payload keeps
// its shape, both teams are present with scores and a winner, and only the stat arrays are empty.
// Cached without expiry, that pins the outage in place forever and never self-heals, which is the
// exact trade this file's cache-forever bargain is supposed to be safe to make. teamReport.js
// already refuses to cache an empty leaderboard for the same reason; this is that rule, here.
// Observed live on 2026-09-12 across completed CFB games.
import { getJson } from './espn.js';
import { redis, redisConfigured, boxScoreKey } from './kv.js';

const SUMMARY = (leaguePath, id) =>
  `https://site.web.api.espn.com/apis/site/v2/sports/${leaguePath}/summary?event=${encodeURIComponent(id)}`;

// The groups worth keeping. All ten are small once trimmed, so the payload keeps them and the page
// decides what to show — a reader who wants the kicking line shouldn't need another round trip.
const KEEP_GROUPS = new Set(['passing', 'rushing', 'receiving', 'fumbles', 'defensive',
  'interceptions', 'kickReturns', 'puntReturns', 'kicking', 'punting']);

// Strip a summary to what a box score actually renders. Everything here is display-ready: labels
// come from ESPN so the columns match what it publishes for that sport (CFB passing has no QBR or
// rating column, NFL does), and stats stay as strings because they already are — "21/37", "4-21".
function trim(j, id) {
  const comp = j.header?.competitions?.[0];
  const byAbbr = {};
  for (const c of (comp?.competitors || [])) {
    if (!c.team?.abbreviation) continue;
    byAbbr[c.team.abbreviation] = {
      score: c.score != null ? Number(c.score) : null,
      winner: c.winner === true,
      lines: (c.linescores || []).map((l) => l.displayValue ?? String(l.value ?? '')),
    };
  }

  const players = j.boxscore?.players || [];
  const teams = (j.boxscore?.teams || []).map((t) => {
    const abbr = t.team?.abbreviation || null;
    const side = players.find((p) => p.team?.abbreviation === abbr);
    return {
      abbr,
      name: t.team?.displayName || null,
      logo: t.team?.logo || null,
      homeAway: t.homeAway || null,
      score: byAbbr[abbr]?.score ?? null,
      winner: byAbbr[abbr]?.winner ?? false,
      lines: byAbbr[abbr]?.lines || [],
      totals: (t.statistics || []).map((s) => [s.label || s.name, s.displayValue]),
      groups: (side?.statistics || []).filter((g) => KEEP_GROUPS.has(g.name)).map((g) => ({
        name: g.name,
        labels: g.labels || [],
        // [displayName, ...stats] — an athlete with no stats is dropped rather than shown blank.
        rows: (g.athletes || []).filter((a) => (a.stats || []).length)
          .map((a) => [a.athlete?.displayName || '—', ...(a.stats || [])]),
      })).filter((g) => g.rows.length),
    };
  });

  return {
    id: String(id),
    date: comp?.date || null,
    state: comp?.status?.type?.state || null,
    final: comp?.status?.type?.state === 'post',
    venue: j.gameInfo?.venue?.fullName || null,
    teams,
    builtAt: new Date().toISOString(),
  };
}

// Does this payload carry the stats a box score exists to show? Used on BOTH sides of the cache,
// which is what makes the fix complete: refusing to write an empty one stops new poisoning, and
// refusing to trust one already stored lets whatever was poisoned before this landed heal itself on
// the next request.
//
// Every team must carry something. Requiring only that SOME team does would let a half-empty
// payload — one side's stats missing — cache permanently, and a box score rendered with one blank
// team is visibly broken. The cost of being strict is a re-fetch for the rare game that is
// legitimately final with no stats at all (a cancellation, a forfeit); the cost of being lax is a
// permanently wrong page.
export function boxScoreHasStats(box) {
  const teams = box?.teams || [];
  if (!teams.length) return false;
  return teams.every((t) => (t?.totals?.length || 0) > 0 || (t?.groups?.length || 0) > 0);
}

// One game's box score, cached forever once the game is final. Throws only if ESPN is unreachable;
// a game with no boxscore block returns a payload with empty teams rather than an error, which is
// what a game that hasn't kicked off looks like.
export async function getBoxScore(leaguePath, id) {
  const key = boxScoreKey(leaguePath, id);
  if (redisConfigured) {
    // A cached entry is only trusted if it is final AND carries stats. An entry stored empty by an
    // earlier outage is treated as a miss, re-fetched, and overwritten once ESPN is serving again.
    try {
      const hit = await redis.get(key);
      if (hit?.final && boxScoreHasStats(hit)) return hit;
    } catch { /* fetch it */ }
  }
  const box = trim(await getJson(SUMMARY(leaguePath, id)), id);
  // Only a finished game is immutable, and only one with stats is worth pinning forever.
  if (box.final && boxScoreHasStats(box) && redisConfigured) {
    try { await redis.set(key, box); } catch { /* serving it matters, storing it doesn't */ }
  }
  return box;
}
