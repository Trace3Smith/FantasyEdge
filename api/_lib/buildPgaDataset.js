// PGA dataset assembly for FantasyEdge — built for DFS golf. Golf DFS is about
// finding underpriced ball-strikers, not roto categories, so the board is keyed on
// STROKES GAINED rather than a single rank:
//   • OWGR is the backbone (a complete, stable name + country list to join on),
//   • real per-round strokes gained (off-the-tee / approach / putting) + scrambling,
//     fairways, and greens come from the PGA Tour stats API (api/_lib/pgaStats.js),
//   • course-fit + cut-probability HEURISTICS (api/_lib/golfModel.js — the DataGolf
//     swap point) are this-week, event-specific values for the field,
//   • each player gets a DFS value TIER (VALUE / SOLID / CHALK / PUNT) from SG
//     production vs. world ranking — the "underpriced producer" signal DFS lives on.
// Recent finishing form still drives a HOT/COLD trend (golf has no per-game log, so
// it does NOT go through enrichForm.js). Output shape matches the other sports so the
// same frontend table renders it (PGA uses two extra stat columns, s7/s8). See the
// pga-rankings-build memory.

import { fetchOwgr, fetchScoreboard, pickCurrentEvent, fieldFromEvent, buildRecentForm, tourMembers, KNOWN_LIV, normName } from './golf.js';
import { fetchPgaStats } from './pgaStats.js';
import { courseFit, cutProbability } from './golfModel.js';

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// Cosmetic decorate (rank/own), mirroring the other builders' decorate().
function decorate(rec, i) {
  rec.rank = i + 1;
  rec.emoji = '🏌️';
  rec.own = null; // golf has no roster ownership %
}

// Signed strokes-gained display, e.g. 0.763 -> "+0.76", -0.21 -> "-0.21".
const sgFmt = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(2));
const pctFmt = (v) => (v == null ? '—' : Math.round(v) + '%');

// DFS value tier from composite strokes gained vs. world ranking. The edge in golf
// DFS is rostering production the field underrates, so a strong ball-striker who
// isn't a marquee name grades VALUE, while the obvious studs everyone plays are CHALK.
//   CHALK = top-of-board talent everyone rosters (elite rank or huge SG).
//   VALUE = produces above his name/price — good SG without an elite ranking.
//   PUNT  = salary-saver: negative SG, or no measured SG and outside the top 100.
//   SOLID = dependable mid-tier (everything else).
function dfsTier(sg, rank) {
  const r = rank ?? 999;
  if (r <= 10 || (sg != null && sg >= 2.0)) return 'chalk';
  if (sg != null && sg >= 1.0 && r >= 25) return 'value';
  if (sg != null && sg >= 0.6 && r >= 60) return 'value';
  if ((sg != null && sg < 0) || (sg == null && r > 100)) return 'punt';
  return 'solid';
}

export async function buildPgaDataset({ owgrLimit = 250 } = {}) {
  const [owgr, sb, sgData] = await Promise.all([fetchOwgr(owgrLimit), fetchScoreboard(), fetchPgaStats()]);

  const event = pickCurrentEvent(sb);
  const field = event ? fieldFromEvent(event) : new Map();
  const { form, members: pgaSet } = await buildRecentForm(sb, 6);

  // Tour classification by where players actually compete (data-driven, no hardcoded
  // rosters). LIV is checked first because LIV players are contractually exclusive
  // but still appear in majors (which sit on the PGA feed); PGA before DP World since
  // the top dual-members are primarily PGA Tour. Unknown -> '—'.
  const [livFeed, eurSet] = await Promise.all([tourMembers('liv', 8), tourMembers('eur', 5)]);
  const livSet = new Set(livFeed);
  for (const n of KNOWN_LIV) livSet.add(normName(n)); // backfill names ESPN's LIV feed omits
  const tourOf = (nm) =>
    livSet.has(nm) ? 'LIV' : pgaSet.has(nm) ? 'PGA Tour' : eurSet.has(nm) ? 'DP World Tour' : '—';

  // Field strength: share of the OWGR top 50 teeing it up this week (a major pulls
  // nearly all of them -> ~1.0; an opposite-field event -> low). Feeds the model.
  let top50InField = 0;
  for (const p of owgr) if (p.rank <= 50 && field.has(normName(p.name))) top50InField++;
  const ev = { name: event?.name || null, fieldStrength: clamp(top50InField / 50, 0, 1) };

  const players = owgr.map((p) => {
    const nm = normName(p.name);
    const f = form.get(nm) || null;
    const sg = sgData.byName.get(nm) || null;
    const inFieldInfo = field.get(nm) || null;
    const inField = !!inFieldInfo;

    // Composite SG (off-the-tee + approach + putting) — the DFS ball-striking signal.
    // Only meaningful when all three are measured; partial data stays null.
    const sgComposite =
      sg && sg.ott != null && sg.app != null && sg.putt != null ? sg.ott + sg.app + sg.putt : null;

    const mp = { rank: p.rank, pointsAvg: p.pointsAvg, form: f, sg: sgComposite, inField };
    const fit = courseFit(mp, ev);          // 0..100 | null (in field only)
    const cut = cutProbability(mp, ev);     // 0..1  | null (in field only)

    // HOT/COLD from recent finishing form, judged on the same L6 avg, so the trend
    // column and a star-free DFS board still flag who's playing well right now.
    // HOT = strong recent finishes (catches in-form stars AND sleepers); COLD = a
    // name player slumping (poor finishes + a ranking that expects more).
    let tag = null, trend = 'flat', trendVal = '';
    const n = f?.finishes?.length || 0;
    if (f && n >= 3) {
      const a = f.avg;
      if (a <= 15) { tag = 'hot'; trend = 'up'; trendVal = 'T' + Math.round(a); }
      else if (a >= 40 && p.rank <= 60) { tag = 'cold'; trend = 'down'; trendVal = 'T' + Math.round(a); }
    }

    const tier = dfsTier(sgComposite, p.rank);

    // DFS power score — SG-led, rewarding fit + make-cut odds + form, so an
    // underpriced ball-striker can out-rank a bigger name (the value edge). Players
    // without measured SG fall back to ranking so they aren't unfairly buried.
    const oStr = clamp(1 - (p.rank - 1) / 220, 0, 1);
    const sgStr = sgComposite != null ? clamp((sgComposite + 1.5) / 4, 0, 1) : oStr;
    const fStr = f?.avg != null ? clamp(1 - (f.avg - 1) / 60, 0, 1) : 0.5;
    const fitC = fit != null ? fit / 100 : sgStr;
    const cutC = cut != null ? cut : 0.5;
    const score = 0.45 * sgStr + 0.2 * oStr + 0.1 * fStr + 0.125 * fitC + 0.125 * cutC;

    return {
      id: 'owgr-' + p.rank + '-' + nm.replace(/\s+/g, '-'),
      name: p.name,
      team: tourOf(nm),       // which tour the player competes on (Team column)
      pos: p.country || '—',  // country (shown under the 'Country' header)
      league: null,
      hasStats: sgComposite != null,
      searchOnly: false,
      // DFS stat columns. s1..s6 are the season ball-striking profile; s7/s8 are this
      // week's model outputs (PGA-only extra columns on the frontend).
      s1: sgFmt(sg?.ott),
      s2: sgFmt(sg?.app),
      s3: sgFmt(sg?.putt),
      s4: pctFmt(sg?.scr),
      s5: pctFmt(sg?.fir),
      s6: pctFmt(sg?.gir),
      s7: cut != null ? Math.round(cut * 100) + '%' : '—',
      s8: fit != null ? String(fit) : '—',
      statLabels: ['SG:OTT', 'SG:APP', 'SG:PUTT', 'SCR', 'FIR', 'GIR', 'CUT%', 'FIT'],
      tier,                   // DFS value tier: 'value' | 'solid' | 'chalk' | 'punt'
      inField,
      tag, trend, trendVal,
      _score: score,
    };
  });

  players.sort((a, b) => b._score - a._score);
  players.forEach(decorate);
  for (const r of players) delete r._score;

  const tierCount = (t) => players.filter((p) => p.tier === t).length;

  return {
    builtAt: new Date().toISOString(),
    sport: 'pga',
    players,
    counts: {
      owgr: owgr.length,
      statYear: sgData.year,
      withSG: players.filter((p) => p.s1 !== '—').length,
      sgFromPrior: owgr.filter((p) => sgData.fromPrior.has(normName(p.name))).length,
      event: ev.name,
      fieldStrength: Math.round(ev.fieldStrength * 100) / 100,
      inField: players.filter((p) => p.inField).length,
      tiers: { value: tierCount('value'), solid: tierCount('solid'), chalk: tierCount('chalk'), punt: tierCount('punt') },
      hot: players.filter((p) => p.tag === 'hot').length,
      cold: players.filter((p) => p.tag === 'cold').length,
      total: players.length,
    },
  };
}
