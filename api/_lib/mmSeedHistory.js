// March Madness seed-history priors — the static, compile-once historical layer that tempers
// the current-year BPI model in marchMadness.js. NOT a live feed: these are well-documented
// all-time NCAA Tournament rates that barely move year to year, so they live as constants (the
// scoping doc's "seed history is the trivial part"). See docs/march-madness-scoping.md.
//
// Two things are exported:
//   R64_FAV_WINRATE — empirical win rate of the FAVORITE (lower seed number) in each fixed
//     first-round pairing, all-time in the 64-team era. This is where the data is richest and
//     most decision-relevant (the 5/12, 8/9 coin-flips), so we use the real numbers here.
//   seedWinProb(favSeed, dogSeed, round) — P(lower seed beats higher seed). Round 1 reads the
//     empirical table; later rounds (sparse, matchup-dependent) fall back to a gentle logistic
//     on seed difference, since by then the BPI signal carries most of the weight anyway.

// All-time first-round favorite (lower seed) win rates. Sources: NCAA / documented seed
// matchup history through the 2020s (1 v 16 ≈ 156-2; the 5 v 12 ≈ 65%; 8 v 9 ≈ coin flip —
// 9-seeds have actually won a hair more than half, so the "favorite" 8-seed sits just under .500).
export const R64_FAV_WINRATE = {
  1: 0.987, // 1 vs 16
  2: 0.925, // 2 vs 15
  3: 0.847, // 3 vs 14
  4: 0.793, // 4 vs 13
  5: 0.647, // 5 vs 12  — the classic upset line
  6: 0.620, // 6 vs 11
  7: 0.607, // 7 vs 10
  8: 0.494, // 8 vs 9   — 9-seeds win slightly more often
};

// Historical advancement rates by seed — the share of teams at each seed line that reach a
// given round, all-time (64-team era). Not used in the win-probability math (the DP derives
// advancement from per-game probabilities); exposed for honest UI context, e.g. "a 12-seed
// reaches the Sweet 16 about 21% of the time." Keyed by seed → { s16, e8, f4, title }.
export const SEED_REACH_RATE = {
  1:  { s16: 0.87, e8: 0.70, f4: 0.41, title: 0.22 },
  2:  { s16: 0.64, e8: 0.45, f4: 0.22, title: 0.08 },
  3:  { s16: 0.51, e8: 0.30, f4: 0.13, title: 0.04 },
  4:  { s16: 0.45, e8: 0.23, f4: 0.09, title: 0.03 },
  5:  { s16: 0.34, e8: 0.16, f4: 0.05, title: 0.01 },
  6:  { s16: 0.32, e8: 0.14, f4: 0.04, title: 0.01 },
  7:  { s16: 0.28, e8: 0.09, f4: 0.02, title: 0.005 },
  8:  { s16: 0.22, e8: 0.09, f4: 0.04, title: 0.02 },
  9:  { s16: 0.12, e8: 0.04, f4: 0.01, title: 0.00 },
  10: { s16: 0.20, e8: 0.07, f4: 0.02, title: 0.00 },
  11: { s16: 0.19, e8: 0.10, f4: 0.03, title: 0.00 },
  12: { s16: 0.21, e8: 0.04, f4: 0.00, title: 0.00 },
  13: { s16: 0.09, e8: 0.02, f4: 0.00, title: 0.00 },
  14: { s16: 0.03, e8: 0.005, f4: 0.00, title: 0.00 },
  15: { s16: 0.02, e8: 0.005, f4: 0.00, title: 0.00 },
  16: { s16: 0.00, e8: 0.00, f4: 0.00, title: 0.00 },
};

// Later-round seed tilt: a gentle logistic on seed difference. Deliberately mild (BETA small)
// because deep-round seed matchups are sparse in history and the current-year BPI model is the
// primary signal by then — this only nudges toward the better seed, it doesn't dominate.
const BETA = 0.16;

// P(lower seed number beats higher seed number). favSeed <= dogSeed by convention; callers map
// the result back to the actual teams. Round 1 uses the empirical table (fixed pairings, rich
// data); every later round uses the seed-difference logistic.
export function seedWinProb(favSeed, dogSeed, round) {
  const lo = Math.min(favSeed, dogSeed);
  const hi = Math.max(favSeed, dogSeed);
  if (round === 1) {
    const p = R64_FAV_WINRATE[lo];
    if (p != null) return p;
  }
  // Logistic on the seed gap. Equal seeds → 0.5; wider gap → stronger favorite.
  return 1 / (1 + Math.exp(-BETA * (hi - lo)));
}
