// Pluggable golf projection model. The two metrics the user wants that NO free API
// exposes — course fit and cut probability — live here as transparent heuristics
// derived from OWGR world ranking + recent finishing form.
//
// THIS IS THE DATAGOLF SWAP POINT. To upgrade to pro-grade modeled numbers, keep
// these two signatures and have them read DataGolf's pre-tournament-predictions
// endpoint instead (make_cut for cutProbability; a skill/course-fit blend for
// courseFit). Nothing else in the pipeline changes. See pga-rankings-build memory.
//
// Inputs (built by buildPgaDataset):
//   player = { rank (OWGR, 1=best, null if unranked), pointsAvg, form }
//     form = { avg (avg finish over last ≤6, lower=better, null if none), trend }
//   event = { fieldStrength (0..1, higher = tougher field) }
// Outputs:
//   courseFit  -> integer 0..100, or null when the player isn't in this week's field
//   cutProbability -> 0..1, or null when not in the field

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// World-ranking strength on a 0..1 scale (rank 1 ≈ 1.0, decaying past ~200).
function owgrStrength(rank) {
  if (rank == null) return 0.15;
  return clamp(1 - (rank - 1) / 220, 0, 1);
}

// Recent-form strength on a 0..1 scale from average finishing position over the
// last ≤6 starts (a win/T1 ≈ 1.0, ~60th ≈ 0). Missing form falls back to neutral.
function formStrength(avg) {
  if (avg == null) return 0.5;
  return clamp(1 - (avg - 1) / 60, 0, 1);
}

// Course fit (heuristic): a blend of world-class quality and current form, nudged
// by how demanding the field is. Event-specific, so only meaningful for players in
// the field — returns null otherwise. DataGolf would replace this with a real
// course-history/skill fit. We weight form a touch heavier than ranking so a hot
// mid-tier player can out-fit a cold elite, which is the whole point of the column.
export function courseFit(player, event) {
  if (!player.inField) return null;
  const o = owgrStrength(player.rank);
  const f = formStrength(player.form?.avg);
  const tough = event?.fieldStrength ?? 0.5;
  // Tougher fields compress everyone's fit slightly (harder to stand out).
  const raw = 0.4 * o + 0.45 * f + 0.15 * (1 - 0.3 * tough);
  return Math.round(clamp(raw, 0, 1) * 100);
}

// Cut probability (heuristic): logistic on a quality score (ranking + form), shifted
// by field strength. Tuned so an elite is ~0.95, a ~70th-ranked player in an average
// field is ~0.5, and fringe players trail off — the canonical make-cut shape.
// DataGolf would replace this with its modeled make_cut. Null when not in the field.
export function cutProbability(player, event) {
  if (!player.inField) return null;
  const o = owgrStrength(player.rank);
  const f = formStrength(player.form?.avg);
  const tough = event?.fieldStrength ?? 0.5;
  // Quality 0..1 -> logit. Center the 50/50 point around quality ≈ 0.5, steepen with k.
  const quality = 0.6 * o + 0.4 * f;
  const k = 7;
  // A tougher field lowers everyone's make-cut odds a bit.
  const z = k * (quality - 0.5) - 0.8 * (tough - 0.5);
  const p = 1 / (1 + Math.exp(-z));
  return clamp(p, 0.05, 0.99);
}
