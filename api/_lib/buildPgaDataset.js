// PGA dataset assembly for FantasyEdge. Unlike the team sports (ESPN byathlete +
// roto z-score), golf has no box score to rank, so the backbone is the OWGR world
// ranking, enriched with:
//   • recent finishing form over the last ≤6 events (ESPN final leaderboards),
//   • this week's tournament field + live position (ESPN scoreboard),
//   • course-fit and cut-probability HEURISTICS (api/_lib/golfModel.js — the
//     DataGolf swap point), which are event-specific so only set for the field.
// HOT/COLD is computed here from recent form (golf has no per-game log, so it does
// NOT go through enrichForm.js). Output shape matches the other sports so the same
// frontend table renders it. See pga-rankings-build memory.

import { fetchOwgr, fetchScoreboard, pickCurrentEvent, fieldFromEvent, buildRecentForm, normName } from './golf.js';
import { courseFit, cutProbability } from './golfModel.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Cosmetic decorate (rank/own), mirroring the other builders' decorate().
function decorate(rec, i) {
  rec.rank = i + 1;
  rec.emoji = '🏌️';
  rec.own = null; // golf has no roster ownership %
}

export async function buildPgaDataset({ owgrLimit = 250 } = {}) {
  const [owgr, sb] = await Promise.all([fetchOwgr(owgrLimit), fetchScoreboard()]);

  const event = pickCurrentEvent(sb);
  const field = event ? fieldFromEvent(event) : new Map();
  const form = await buildRecentForm(sb, 6);

  // Field strength: share of the OWGR top 50 teeing it up this week (a major pulls
  // nearly all of them -> ~1.0; an opposite-field event -> low). Feeds the model.
  let top50InField = 0;
  for (const p of owgr) if (p.rank <= 50 && field.has(normName(p.name))) top50InField++;
  const ev = { name: event?.name || null, fieldStrength: clamp(top50InField / 50, 0, 1) };

  const players = owgr.map((p) => {
    const nm = normName(p.name);
    const f = form.get(nm) || null;
    const inFieldInfo = field.get(nm) || null;
    const inField = !!inFieldInfo;

    const mp = { rank: p.rank, pointsAvg: p.pointsAvg, form: f, inField };
    const fit = courseFit(mp, ev);          // 0..100 | null
    const cut = cutProbability(mp, ev);     // 0..1  | null

    // HOT/COLD from recent form, judged RELATIVE TO OWGR EXPECTATION — golf finishes
    // are too noisy for a raw trend, and an absolute cutoff would wrongly cold-badge
    // a #150 finishing where his rank predicts. Expected finish scales with rank
    // (#1 ≈ top 8, #150 ≈ ~60th); a recency-weighted avg far better/worse than that
    // is HOT/COLD. Needs a ≥3-event sample. Mirrors the tag/trend pairing elsewhere.
    let tag = null, trend = 'flat', trendVal = '';
    const n = f?.finishes?.length || 0;
    if (f && n >= 3) {
      // Judge the SAME number shown in the L6 column so the badge and the column
      // never contradict each other.
      //   HOT  = genuinely strong recent finishes (absolute) — catches in-form stars
      //          AND lower-ranked sleepers, which is the "who do I play" signal.
      //   COLD = a NAME player slumping (poor finishes + a ranking that expects more);
      //          a low-ranked player finishing where his rank predicts isn't "news".
      const a = f.avg;
      if (a <= 15) { tag = 'hot'; trend = 'up'; trendVal = 'T' + Math.round(a); }
      else if (a >= 40 && p.rank <= 60) { tag = 'cold'; trend = 'down'; trendVal = 'T' + Math.round(a); }
    }

    // Strength tags drive the star rating (getStarCount maps count -> stars).
    const cats = [];
    if (p.rank <= 5) cats.push('ELITE');
    if (p.rank <= 25) cats.push('TOP 25');
    if (f && f.avg <= 15) cats.push('FORM');
    if (tag === 'hot') cats.push('HOT');
    if (fit != null && fit >= 80) cats.push('FIT');
    if (fit != null && fit >= 88) cats.push('PRIME FIT');
    if (cut != null && cut >= 0.85) cats.push('SAFE');
    if (inField) cats.push('IN FIELD');

    // Composite "power rank" score — OWGR-led but rewarding current form, fit, and
    // make-cut odds, so a hot player can out-rank a cold higher-OWGR one (the edge).
    const oStr = clamp(1 - (p.rank - 1) / 220, 0, 1);
    const fStr = f?.avg != null ? clamp(1 - (f.avg - 1) / 60, 0, 1) : 0.5;
    const fitC = fit != null ? fit / 100 : fStr;
    const cutC = cut != null ? cut : 0.5;
    const score = 0.5 * oStr + 0.2 * fStr + 0.15 * fitC + 0.15 * cutC;

    return {
      id: 'owgr-' + p.rank + '-' + nm.replace(/\s+/g, '-'),
      name: p.name,
      team: p.country || '—',
      pos: p.country || '—',
      league: null,
      hasStats: true,
      searchOnly: false,
      // s1..s6 with inline labels (the ALL view shows them; PGA has a single view).
      s1: String(p.rank),
      s2: f?.avg != null ? String(Math.round(f.avg)) : '—',
      s3: fit != null ? String(fit) : '—',
      s4: cut != null ? Math.round(cut * 100) + '%' : '—',
      s5: p.pointsAvg != null ? p.pointsAvg.toFixed(2) : '—',
      s6: inField ? (inFieldInfo.pos != null ? 'T' + inFieldInfo.pos : 'TEE') : '—',
      statLabels: ['OWGR', 'L6', 'FIT', 'CUT%', 'PTS', 'WK'],
      cats,
      tag, trend, trendVal,
      _score: score,
    };
  });

  players.sort((a, b) => b._score - a._score);
  players.forEach(decorate);
  for (const r of players) delete r._score;

  return {
    builtAt: new Date().toISOString(),
    sport: 'pga',
    players,
    counts: {
      owgr: owgr.length,
      event: ev.name,
      fieldStrength: Math.round(ev.fieldStrength * 100) / 100,
      inField: players.filter((p) => p.s6 !== '—').length,
      withForm: players.filter((p) => p.s2 !== '—').length,
      hot: players.filter((p) => p.tag === 'hot').length,
      cold: players.filter((p) => p.tag === 'cold').length,
      total: players.length,
    },
  };
}
