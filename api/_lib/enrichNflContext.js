// NFL Phase 2 — team-context opportunity modifiers (see docs/nfl-phase2-context-scoping.md).
//
// Layers TWO free-data opportunity signals onto skill players, clearly labeled as opportunity (not
// predictive precision):
//   • target share = playerTargets / teamTargets  (pass-catchers: WR / TE / RB)
//   • pace index   = teamPlaysPerGame / leagueAvgPlaysPerGame  (all skill; QB is pace-only)
//
// Both come from dataset.teamContext, captured for free during the DST team-stats fetch in
// buildNflDataset. This module is PURE (no network): it reads the built dataset, computes each
// skill player's share/pace, converts them into a small CAPPED tilt (≤ MAX_TILT), and attaches
// `p.opportunity = { targetShare, paceIndex, paceBucket, tilt, label, season, inSeason }`.
//
// It does NOT apply the tilt — nflBlend does, and only on the in-season current-pace leg of the
// blend (it stamps `applied` / `appliedTilt`). That split is deliberate: target share and pace are
// current-STAT-season figures, so in the offseason they are last season's usage — stale and
// actively misleading for players who changed teams, while the Sleeper projection already prices
// in expected new-team usage. In-season → a real nudge; offseason → context/display only. This
// module still computes the figures out of season (for the "2025 usage" display), but records
// inSeason so the blend/frontend know not to apply/act on them.
//
// Runs in the daily cron AFTER the build (needs teamContext + p.tgt) and BEFORE nflBlend.

const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const PASS_CATCHERS = new Set(['WR', 'TE', 'RB']); // target share applies here; QB is pace-only

// Capped-and-modest by design — an opportunity nudge, never a rewrite.
const MAX_TILT = 0.08;   // total tilt ceiling on the current-pace leg (± 8%)
const PACE_K = 0.4;      // pace: a ±10% pace deviation → ±4% tilt (before the shared cap)
const PACE_MAX = 0.05;   // pace component's own cap
const SHARE_K = 0.06;    // share: a pass-catcher at 2× positional baseline → +6% (before caps)
const SHARE_MAX = 0.06;  // share component's own cap

// Pace buckets for the label (index 1.0 = league average).
const PACE_FAST = 1.04, PACE_SLOW = 0.96;

// Only players with a non-trivial share count toward a positional baseline (excludes deep-bench
// bodies that would drag the average down); below this many qualifiers, fall back to a constant.
const MIN_SHARE_FOR_BASELINE = 0.03;
const MIN_QUALIFIERS = 8;
const FALLBACK_BASELINE = { WR: 0.15, TE: 0.13, RB: 0.11 };

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function enrichNflContext(dataset) {
  if (!dataset?.players?.length) return;
  const tc = dataset.teamContext || {};
  const datasetSeason = Number(dataset.counts?.season) || new Date().getFullYear();
  // In-season ⟺ ESPN's stat season is the ranking season (mirrors nflBlend's gate). Only then do
  // the figures reflect the real current situation; in the offseason they are last season's usage.
  const inSeason = datasetSeason >= new Date().getFullYear();

  // League-average offensive pace across teams that have played.
  const paces = Object.values(tc).map((t) => t.playsPerGame).filter((v) => v > 0);
  const leagueAvgPace = paces.length ? paces.reduce((a, b) => a + b, 0) / paces.length : 0;

  // Raw target share for a pass-catcher, or null when the team's target total is unknown.
  const shareOf = (p) => {
    const t = p.teamId != null ? tc[p.teamId] : null;
    if (!t || !(t.targets > 0) || p.tgt == null) return null;
    return p.tgt / t.targets;
  };

  // Self-calibrating positional target-share baselines (mean share among real contributors),
  // with a constant fallback when the pool is too thin (e.g. early in the season).
  const baselines = {};
  for (const pos of ['WR', 'TE', 'RB']) {
    const shares = [];
    for (const p of dataset.players) {
      if (p.pos !== pos || p.searchOnly || !(p.games > 0)) continue;
      const s = shareOf(p);
      if (s != null && s >= MIN_SHARE_FOR_BASELINE) shares.push(s);
    }
    baselines[pos] = shares.length >= MIN_QUALIFIERS
      ? shares.reduce((a, b) => a + b, 0) / shares.length
      : FALLBACK_BASELINE[pos];
  }

  let tagged = 0;
  for (const p of dataset.players) {
    if (!SKILL.has(p.pos)) continue;
    const t = p.teamId != null ? tc[p.teamId] : null;
    if (!t) continue; // no team context → nothing to layer (leaves p.opportunity unset)

    const paceIndex = leagueAvgPace > 0 && t.playsPerGame > 0 ? t.playsPerGame / leagueAvgPace : 1;
    const paceBucket = paceIndex >= PACE_FAST ? 'fast' : paceIndex <= PACE_SLOW ? 'slow' : 'avg';
    const paceTilt = clamp((paceIndex - 1) * PACE_K, -PACE_MAX, PACE_MAX);

    // Target share only for pass-catchers with a known denominator; QBs are pace-only.
    const targetShare = PASS_CATCHERS.has(p.pos) ? shareOf(p) : null;
    const baseline = baselines[p.pos];
    const shareTilt = (targetShare != null && baseline > 0)
      ? clamp((targetShare / baseline - 1) * SHARE_K, -SHARE_MAX, SHARE_MAX)
      : 0;

    const tilt = clamp(shareTilt + paceTilt, -MAX_TILT, MAX_TILT);

    // Label surfaces only what's notable: a target share (always shown for pass-catchers) and a
    // non-average pace. QB on an average-pace team therefore shows nothing (no false signal).
    const parts = [];
    if (targetShare != null) parts.push(`${Math.round(targetShare * 100)}% target share`);
    if (paceBucket !== 'avg') parts.push(`${paceBucket} pace`);
    const label = parts.join(' · ');

    p.opportunity = {
      targetShare: targetShare != null ? r3(targetShare) : null,
      paceIndex: r2(paceIndex),
      paceBucket,
      tilt: r3(tilt),
      label,
      season: datasetSeason,
      inSeason,
      applied: false,     // nflBlend flips this in-season when it applies the tilt to the pace leg
      appliedTilt: 0,
    };
    tagged++;
  }

  dataset.counts = {
    ...dataset.counts,
    opportunity: { inSeason, season: datasetSeason, tagged, teams: Object.keys(tc).length, leagueAvgPace: r2(leagueAvgPace) },
  };
}
