// Blended NFL value model — replaces raw current-season fantasy points as the ranking basis with a
// season-progress-weighted blend of {consensus projection, most-recent completed-season actuals,
// current-season pace}. Mirrors MLB's blendValuation: in the preseason it leans on the projection +
// last year's actuals; as real games are played the current-season pace takes over. It overwrites
// fpPpr / fpStd / fp (+ the s6 display) for skill players (QB/RB/WR/TE), so every surface — the
// rankings tab, draft board, draft engine, Coach — ranks by the blend through the single
// nflRankValue() hook, with no other file changes. Additive fields: p.actual, p.blend.
//
// Runs in the daily cron AFTER enrichNflProjections (needs p.proj.pts) and reads p.prevYear.pts
// (prior-season actuals from buildNflDataset). K/DST are left untouched (the board buries them by
// their own tier), as is every non-NFL player.
//
// Season nuance: in the offseason ESPN's "current" byathlete stats ARE last season's completed
// actuals (a full 17-game season), while the projection targets the UPCOMING season. So "current-
// season pace" only exists when ESPN's stat season equals the ranking season (inSeason); otherwise
// progress is 0 and the blend is projection + last-year anchored — exactly what a preseason board
// should be.

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const SEASON_GAMES = 17;
// A player with no current-season stats (searchOnly, e.g. a rookie in the offseason) but a real
// projection at or above this many projected PPR points is promoted onto the ranked board — so a
// projection-aware draft board isn't missing draftable newcomers. ~50 ≈ a deep-bench flyer.
const PROMOTE_FLOOR = 50;

const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function enrichNflBlend(dataset) {
  if (!dataset?.players?.length) return;
  const datasetSeason = Number(dataset.counts?.season) || new Date().getFullYear();
  const projSeason = Math.max(new Date().getFullYear(), datasetSeason);
  const inSeason = datasetSeason === projSeason; // ESPN's current-stat season IS the ranking season
  const maxGames = dataset.counts?.maxGames || 0;
  const progress = inSeason ? clamp(maxGames / SEASON_GAMES, 0, 1) : 0;
  const wCur = clamp(0.15 + 0.7 * progress, 0.15, 0.85); // current-pace weight grows with the season

  let blended = 0, promoted = 0;
  for (const p of dataset.players) {
    if (!SKILL.has(p.pos)) continue;
    const actual = { ppr: p.fpPpr ?? 0, std: p.fpStd ?? (p.fpPpr ?? 0) };
    const proj = p.proj?.pts || null;                       // upcoming-season consensus (Sleeper)
    // Most recent COMPLETED season's actuals: offseason -> this dataset (build fp IS last season);
    // in-season -> prevYear (last completed). Current-season pace only exists in-season w/ games.
    const recent = inSeason ? (p.prevYear?.pts || null) : actual;
    const games = p.games || 0;
    const pace = (inSeason && games > 0)
      ? { ppr: (actual.ppr / games) * SEASON_GAMES, std: (actual.std / games) * SEASON_GAMES }
      : null;

    const blendFmt = (fmt) => {
      const pj = proj ? proj[fmt] : null;
      const rc = recent ? recent[fmt] : null;
      // Baseline expectation: projection-led with recent actuals in support; degrade gracefully.
      const baseline = (pj != null && rc != null) ? 0.65 * pj + 0.35 * rc
        : (pj != null ? pj : (rc != null ? rc : actual[fmt]));
      return pace != null ? wCur * pace[fmt] + (1 - wCur) * baseline : baseline;
    };
    const bppr = blendFmt('ppr'), bstd = blendFmt('std');

    p.actual = { ppr: r1(actual.ppr), std: r1(actual.std) }; // keep true current-season points
    p.fpPpr = r1(bppr);
    p.fpStd = r1(bstd);
    p.fp = p.fpPpr;
    p.s6 = p.fpPpr.toFixed(1); // FPTS display column now shows the blended (ranking) value
    p.blend = {
      ppr: p.fpPpr, std: p.fpStd,
      proj: proj ? proj.ppr : null, recent: recent ? r1(recent.ppr) : null, pace: pace ? r1(pace.ppr) : null,
      wCur: Math.round(wCur * 100) / 100, progress: Math.round(progress * 100) / 100, inSeason,
    };
    blended++;

    if (p.searchOnly && proj && p.fpPpr >= PROMOTE_FLOOR) { p.searchOnly = false; promoted++; }
  }

  // Re-rank the NFL board by blended PPR points (the build ranked by raw fp identically). p.rank is
  // a stored ordinal/gate — every surface still re-orders by VORP client-side via nflRankValue —
  // but keeping it coherent matters for consumers that read p.rank directly (Coach, ADP fallback).
  const board = dataset.players.filter((p) => !p.searchOnly);
  board.sort((a, b) => (b.fpPpr || 0) - (a.fpPpr || 0));
  board.forEach((p, i) => { p.rank = i + 1; });

  dataset.counts = { ...dataset.counts, blend: { inSeason, projSeason, progress: r1(progress), blended, promoted } };
}
