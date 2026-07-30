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

// The positional target-share baseline is built from STARTERS only — each team's top pass-catchers
// at the position — so it reflects a typical starter's share, not the league-wide average that deep
// rosters (WR4+, backup TE/RB) drag down. A starter-level baseline makes the tilt separate ELITE
// usage from merely-good, rather than rewarding any every-week starter. Players who missed most of
// the season are excluded too, since their season-total share is diluted by the games they sat.
const STARTER_SLOTS = { WR: 2, TE: 1, RB: 1 }; // per-team slots that count as "starters" for the baseline
const STARTER_GAMES_FRAC = 0.5;                // must have played ≥ half the games to be rateable
const MIN_QUALIFIERS = 8;                       // below this pool size, fall back to a constant
const FALLBACK_BASELINE = { WR: 0.18, TE: 0.14, RB: 0.12 }; // starter-level fallbacks

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

  // Self-calibrating positional target-share baselines, computed over STARTERS only: each team's
  // top STARTER_SLOTS pass-catchers at the position, among players who played enough to be rateable.
  // Falls back to a constant when the pool is too thin (e.g. early in the season).
  const maxGames = dataset.counts?.maxGames || 0;
  const minGames = Math.max(1, maxGames > 0 ? STARTER_GAMES_FRAC * maxGames : 0);
  const baselines = {};
  for (const pos of ['WR', 'TE', 'RB']) {
    // Bucket each team's rateable contributors by share, then keep only that team's top starter slots.
    const byTeam = new Map();
    for (const p of dataset.players) {
      if (p.pos !== pos || p.searchOnly || !(p.games >= minGames)) continue;
      const s = shareOf(p);
      if (s == null || s <= 0) continue;
      if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
      byTeam.get(p.teamId).push(s);
    }
    const shares = [];
    for (const teamShares of byTeam.values()) {
      teamShares.sort((a, b) => b - a);
      for (const s of teamShares.slice(0, STARTER_SLOTS[pos])) shares.push(s);
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
    opportunity: {
      inSeason, season: datasetSeason, tagged, teams: Object.keys(tc).length,
      leagueAvgPace: r2(leagueAvgPace),
      baselines: { WR: r3(baselines.WR), TE: r3(baselines.TE), RB: r3(baselines.RB) }, // starter-level share baselines
    },
  };
}
