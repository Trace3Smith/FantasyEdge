// NFL HOT/COLD form — the fixed-threshold model for a POINTS league, computed from fantasy points per
// game (FPPG) over the last few games. Unlike the roto sports, "value" here IS a single number
// (fantasy points), so the badge rides one per-position FPPG threshold instead of a 2+-category rule.
//
// SCORING IS PER-LEAGUE. FPPG is recomputed from each game's raw box-score line using a `weights` map
// (the league's actual points-per-stat, from espnScoring.parseScoringSettings). A league that scores
// generously (higher TD values, bonuses, full PPR) pushes everyone's FPPG up, which would make a flat
// bar meaningless — so the position bars are SCALED by that league's scoring volume vs a standard-PPR
// baseline: run a fixed reference "elite" line through both formulas, take the ratio, scale the bar.
// The bar stays a fixed absolute threshold, just recalibrated to what "elite" costs under those rules.
//
// This module is pure (no I/O): the cron passes NFL_PPR (the shared default badge) + the stored
// last-4 lines; the per-user endpoint passes the linked league's weights. Only QB/RB/WR/TE are badged
// — K/DST are excluded (their week-to-week output is near-random; see nflScoring.js).

export const NFL_WINDOW = 4;   // last 4 games
export const NFL_MIN = 3;      // need >= 3 to badge
export const NFL_GAP_DAYS = 24; // reset the window only on a multi-week absence (a bye ~14d does NOT reset)

// Standard-PPR baseline weights — the reference every league's scalar is measured against, and the
// default badge the shared cron bakes for logged-out / free / no-linked-league viewers.
export const NFL_PPR = {
  passYds: 0.04, passTD: 4, passInt: -2,
  rushYds: 0.1, rushTD: 6,
  rec: 1, recYds: 0.1, recTD: 6,
  fumLost: -2,
};

// Base HOT/COLD bars in standard-PPR FPPG (approved). Scaled per league by the scalar below.
const NFL_BARS = { QB: [23, 14], RB: [20, 8], WR: [19, 7], TE: [15, 5] };

// Fixed reference "elite" per-game lines — used ONLY to size a league's scalar (never badged). Each is
// roughly the production the PPR HOT bar represents, so the scalar reflects how that scoring system
// values a genuinely elite line at the position (QB has ~no receptions → PPR-invariant; skill
// positions carry the reception weight, which is where PPR type bites).
const NFL_REF = {
  QB: { passYds: 285, passTD: 2, passInt: 0.5, rushYds: 20, rushTD: 0.2 },
  RB: { rushYds: 85, rushTD: 0.6, rec: 4, recYds: 30, recTD: 0.15 },
  WR: { rec: 5.5, recYds: 80, recTD: 0.5 },
  TE: { rec: 5, recYds: 52, recTD: 0.4 },
};

// Guard tolerance: after dropping the single most-supportive game, the verdict must still hold within
// this factor of the bar — so one monster (or one dud) week alone can't flip the badge, but a genuinely
// consistent hot/cold run survives (dropping the best game from a 4-game window drops the mean a lot).
const GUARD = 0.85;

// Fantasy points for one game line under a weights map. Missing stats read as 0.
export function nflGameFpts(line, weights) {
  let s = 0;
  for (const k in weights) s += (line[k] || 0) * weights[k];
  return s;
}

// Per-position scalar = (elite line under THIS league) / (elite line under standard PPR). QB ≈ 1 unless
// the league changes passing values; skill positions drop for less-than-full PPR and rise for generous
// TD/yardage. Falls back to 1 if the reference somehow scores non-positive.
export function nflScalars(weights) {
  const out = {};
  for (const pos in NFL_REF) {
    const base = nflGameFpts(NFL_REF[pos], NFL_PPR);
    const lg = nflGameFpts(NFL_REF[pos], weights);
    out[pos] = base > 0 ? lg / base : 1;
  }
  return out;
}

// League-scaled [hot, cold] bars per position.
export function nflScaledBars(weights) {
  const sc = nflScalars(weights);
  const out = {};
  for (const pos in NFL_BARS) { const [h, c] = NFL_BARS[pos]; const f = sc[pos] ?? 1; out[pos] = [h * f, c * f]; }
  return out;
}

// HOT/COLD badge for one skill player from their stored recent game lines (newest-first) under a
// league's weights. Returns { tag, reason } or null. K/DST (no bar) always return null.
export function nflFormBadge(recentGames, pos, weights) {
  if (!NFL_BARS[pos]) return null; // QB/RB/WR/TE only
  const win = (recentGames || []).slice(0, NFL_WINDOW);
  if (win.length < NFL_MIN) return null;
  const fp = win.map((g) => nflGameFpts(g, weights));
  const total = fp.reduce((a, b) => a + b, 0);
  const mean = total / fp.length;
  const [hot, cold] = nflScaledBars(weights)[pos];
  const reason = `${mean.toFixed(1)} FPPG · last ${win.length}`;
  if (fp.length > 1) {
    // consistency guard: hold up after removing the single most-supportive game.
    const dropBest = (total - Math.max(...fp)) / (fp.length - 1);
    const dropWorst = (total - Math.min(...fp)) / (fp.length - 1);
    if (mean >= hot && dropBest >= hot * GUARD) return { tag: 'hot', reason };
    if (mean <= cold && dropWorst <= cold / GUARD) return { tag: 'cold', reason };
    return null;
  }
  if (mean >= hot) return { tag: 'hot', reason };
  if (mean <= cold) return { tag: 'cold', reason };
  return null;
}
