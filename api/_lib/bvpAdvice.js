// Start/sit advice from a batter's career line against the day's probable starter.
//
// Approved rules (2026-07, confirmed with Trace):
//   STAR OVERRIDE. A hitter in the top 15 of the board by roto zTotal always reads START,
//     regardless of BvP. Condition (a) (preseason ADP) was dropped — the app has no MLB
//     preseason ADP source — so "star" is purely current-season top-tier.
//   NON-STAR, thin/none (< 3 AB, including a first career matchup at 0 AB). BvP is NOT a
//     signal. The call is 'neutral' and the consumer falls back to rolling form / season
//     value as if BvP weren't a factor. Below the floor it never pushes either direction.
//   NON-STAR, 3+ AB. The BvP line drives the call:
//     start  when OPS >= .800 OR AVG >= .275   (~league p70 — clearly above average)
//     sit    when OPS <= .600 AND AVG <= .225  (below p25 on BOTH — one noisy number,
//              at 3-20 AB, must not sit a player on its own)
//     neutral otherwise.
//   THIN-BUT-COUNTED. 3-5 AB clears the floor but is low-confidence; flagged so the UI can
//     mark a borderline call. HR is shown as context but the call rides on AVG/OPS, which
//     already price power in via OPS.
//
// Pure and side-effect-free so the cron, the API, and any test call it identically.

export const STAR_RANK_MAX = 15;    // top N hitters by zTotal are "stars"
const AB_FLOOR = 3;                 // below this, BvP is no signal
const THIN_MAX = 5;                 // 3..5 AB counts but is flagged low-confidence
const START_OPS = 0.800, START_AVG = 0.275;
const SIT_OPS = 0.600, SIT_AVG = 0.225;

const numOrNull = (v) => { if (v == null) return null; const n = parseFloat(String(v)); return isFinite(n) ? n : null; };

// Ids of the top STAR_RANK_MAX hitters by zTotal. Ranked here (not by the stored `rank`,
// which sequences hitters and pitchers separately) so "top 15 hitters" means exactly that.
// Pitchers and anyone without a numeric zTotal are ignored.
export function starHitterIds(players = []) {
  const hitters = players
    .filter((p) => p && !p.searchOnly && p.id != null
      && !['SP', 'RP'].includes(p.pos) && typeof p.zTotal === 'number')
    .sort((a, b) => b.zTotal - a.zTotal)
    .slice(0, STAR_RANK_MAX);
  return new Set(hitters.map((p) => String(p.id)));
}

// The advice object for one batter. `line` is a BvP line { ab, h, hr, avg, ops, ... };
// `isStar` is membership in starHitterIds. Returns:
//   { call: 'start'|'sit'|'neutral', star, counts, thin, reason }
//   counts = did BvP actually drive the call (false for stars and sub-floor samples)
//   thin   = call rode on a 3-5 AB sample (only meaningful when counts is true)
export function bvpAdvice(line, isStar) {
  if (isStar) {
    return { call: 'start', star: true, counts: false, thin: false, reason: 'Top-15 hitter — start regardless of matchup.' };
  }
  const ab = line ? (line.ab || 0) : 0;
  if (ab < AB_FLOOR) {
    const why = ab === 0 ? 'First career matchup — no BvP history.' : `Only ${ab} career AB — too thin to count.`;
    return { call: 'neutral', star: false, counts: false, thin: false, reason: why + ' Falls back to form/season.' };
  }
  const ops = numOrNull(line.ops), avg = numOrNull(line.avg);
  const thin = ab <= THIN_MAX;
  let call = 'neutral';
  if ((ops != null && ops >= START_OPS) || (avg != null && avg >= START_AVG)) call = 'start';
  else if (ops != null && ops <= SIT_OPS && avg != null && avg <= SIT_AVG) call = 'sit';

  const hstr = `${line.h}-for-${ab}`;
  let reason;
  if (call === 'start') reason = `Hits this pitcher well (${hstr}, ${avg != null ? avg.toFixed(3) : '—'}/${ops != null ? ops.toFixed(3) : '—'} OPS).`;
  else if (call === 'sit') reason = `Struggles vs this pitcher (${hstr}, ${avg != null ? avg.toFixed(3) : '—'}/${ops != null ? ops.toFixed(3) : '—'} OPS).`;
  else reason = `Mixed vs this pitcher (${hstr}) — no clear BvP lean.`;
  if (thin && call !== 'neutral') reason += ` Thin sample (${ab} AB).`;
  return { call, star: false, counts: call !== 'neutral', thin: thin && call !== 'neutral', reason };
}
