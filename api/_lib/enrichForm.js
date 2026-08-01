// Recent-form HOT/COLD badges.
//
// HITTERS (MLB, in-season) use FIXED ABSOLUTE thresholds over the player's last-15-game window across
// five categories — AVG, HR, OBP, RBI, R — with no comparison to the league or to the player's own
// past. A category reads hot or cold purely by where its window total/rate lands vs a fixed bar (HR is
// hot-only — no cold side). The badge needs 2+ categories on one side AND strictly more than the other
// side; a single-category edge or an even tie is neutral. No consistency guard — the 15-game window +
// 6-appearance floor is the sample control. The badge carries a `formReason` listing the triggering
// numbers (e.g. ".310 AVG, .357 OBP · last 15").
//
// PITCHERS (MLB) still use a LEAGUE-BASELINE percentile model: starters on ERA/QS/K9/WHIP, relievers
// on ERA/K9/WHIP (ERA/WHIP inverted — lower is hotter). A SINGLE category clearing the league top/
// bottom-20% bar earns the badge, guarded by a drop-best-game consistency check.
//
// NHL (in-season) uses the SAME fixed-absolute per-category model as MLB hitters, split by role:
// SKATERS on G/A/SOG (two-sided) + PPP (hot-only); GOALIES on SV%/GAA/W (two-sided) + SO (hot-only),
// with GAA computed from time-on-ice. Same 2+-categories verdict, reason text, full-roster coverage,
// and last-15 window (last-15 appearances for goalies).
//
// NBA + WNBA use the SAME fixed-absolute model (one shared engine), but only PTS/FG% are two-sided —
// FT% and the specialty counting cats (3PM/AST/REB/STL/BLK) are HOT-ONLY, since a fixed COLD bar on a
// position-shaped stat would false-flag by role (a guard never blocks; a center never shoots threes or
// FTs well). WNBA uses the same code with thresholds scaled for its shorter season. See the basketball block.
//
// NFL is the only sport still on the older recent-vs-own-average model, until it's ported.
//
// Cost control + gating: top-N ranked players, in-season only (detected from the data), daily cron.
// Failure-tolerant per player and overall.

import { getJson } from './espn.js';
import { nflFormBadge, NFL_PPR, NFL_WINDOW, NFL_MIN, NFL_GAP_DAYS } from './nflForm.js';

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };

// Small batched-parallel helper (cap concurrent fetches).
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared: MLB per-game fantasy value (exported — enrichRolling scores its window aggregates on the
// identical scale, so a rolling total can never drift from a badge). Kept even though the new MLB
// form model below is per-category, because enrichRolling still imports it.
const ipToOuts = (ip) => { const [w, f] = String(ip ?? '0').split('.'); return (parseInt(w) || 0) * 3 + (parseInt(f) || 0); };
export function gameValueMlb(pos, s) {
  if (pos === 'SP' || pos === 'RP') {
    return ipToOuts(s.inningsPitched) + 2 * num(s.strikeOuts) - 2 * num(s.earnedRuns) - num(s.hits) - num(s.baseOnBalls);
  }
  const tb = num(s.hits) + num(s.doubles) + 2 * num(s.triples) + 3 * num(s.homeRuns);
  return tb + num(s.runs) + num(s.rbi) + num(s.baseOnBalls) + num(s.stolenBases);
}

// ════════════════════════════════════════════════════════════════════════════
// NEW: MLB league-baseline per-category HOT/COLD
// ════════════════════════════════════════════════════════════════════════════
const MLB_API = 'https://statsapi.mlb.com/api/v1';
const ipDec = (ip) => { const [w, o] = String(ip ?? '0').split('.'); return (parseInt(w) || 0) + (parseInt(o) || 0) / 3; };
const fmt3 = (x) => x.toFixed(3).replace(/^0/, ''); // 0.367 -> ".367"
const sum = (arr, k) => arr.reduce((t, g) => t + g[k], 0);

const ELITE_P = 0.80, WEAK_P = 0.20; // league percentile bars
const HIT_WINDOW = 15, HIT_MIN_APPEAR = 6, HIT_GAP_DAYS = 14; // player's own last 15 games played; reset the window at any >14-day inactivity gap (IL/demotion), so stale pre-absence games don't count; still need >= 6 appearances since returning
const SP_WINDOW = 8, SP_MIN = 5;             // last 8 starts; need >= 5
const RP_WINDOW = 15, RP_MIN = 8;            // last 15 relief appearances; need >= 8
const POOL_MIN = 20;                          // season games/starts to count toward the bars
const MLB_FORM_CONC = 10;                     // concurrent statsapi game-log fetches (verified well under any throttle)
const MLB_FORM_SOFT_MS = 90000;               // soft time budget for the MLB form step — stop launching new work past it, so full-roster form can never dominate the shared 300s cron

function pctl(arr, p) { const a = [...arr].sort((x, y) => x - y); if (!a.length) return 0; const i = p * (a.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); }

// Player's recent-appearance window with an inactivity guard: walk back from the most recent game,
// taking up to `window` appearances, but STOP at the first gap longer than `gapDays` between
// consecutive games — an IL stint or demotion resets the window so pre-absence games don't count
// toward current form. Returns fewer than `window` games for a just-returned player. `games` must be
// newest-first with an ISO `date`.
const dayGap = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
function recentWindow(games, window, gapDays) {
  if (!games.length) return [];
  const win = [games[0]];
  for (let i = 1; i < games.length && win.length < window; i++) {
    if (dayGap(games[i - 1].date, games[i].date) > gapDays) break;
    win.push(games[i]);
  }
  return win;
}

// Per-category rate over a set of games.
const rAVG = (g) => { const ab = sum(g, 'ab'); return ab ? sum(g, 'h') / ab : 0; };
const rOBP = (g) => { const pa = sum(g, 'pa'); return pa ? (sum(g, 'h') + sum(g, 'bb') + sum(g, 'hbp')) / pa : 0; };
const rERA = (g) => { const ip = sum(g, 'ip'); return ip ? sum(g, 'er') * 9 / ip : 0; };
const rWHIP = (g) => { const ip = sum(g, 'ip'); return ip ? (sum(g, 'h') + sum(g, 'bb')) / ip : 0; };
const rK9 = (g) => { const ip = sum(g, 'ip'); return ip ? sum(g, 'k') * 9 / ip : 0; };
const rQS = (g) => (g.length ? sum(g, 'qs') / g.length : 0);

// ── HITTERS: fixed absolute bars over the last-15-game window ──
// AVG/OBP are window rates; HR/RBI/R are window totals. HR has no cold side. RBI/R bars sit just above
// the ~P80 of regulars' 15-game production (elite pace), cold near P15. Verdict = 2+ categories on one
// side AND strictly more than the other; otherwise neutral. Reason lists the triggering numbers.
const HIT_HOT = { AVG: 0.300, OBP: 0.350, HR: 5, RBI: 11, R: 11 };
const HIT_COLD = { AVG: 0.220, OBP: 0.290, RBI: 3, R: 3 };
function hitterBadge(win) {
  const avg = rAVG(win), obp = rOBP(win), hr = sum(win, 'hr'), rbi = sum(win, 'rbi'), r = sum(win, 'r');
  const H = [], C = [];
  if (avg >= HIT_HOT.AVG) H.push(fmt3(avg) + ' AVG'); else if (avg <= HIT_COLD.AVG) C.push(fmt3(avg) + ' AVG');
  if (hr >= HIT_HOT.HR) H.push(hr + ' HR'); // hot-only
  if (obp >= HIT_HOT.OBP) H.push(fmt3(obp) + ' OBP'); else if (obp <= HIT_COLD.OBP) C.push(fmt3(obp) + ' OBP');
  if (rbi >= HIT_HOT.RBI) H.push(rbi + ' RBI'); else if (rbi <= HIT_COLD.RBI) C.push(rbi + ' RBI');
  if (r >= HIT_HOT.R) H.push(r + ' R'); else if (r <= HIT_COLD.R) C.push(r + ' R');
  if (H.length >= 2 && H.length > C.length) return { tag: 'hot', reason: H.join(', ') };
  if (C.length >= 2 && C.length > H.length) return { tag: 'cold', reason: C.join(', ') };
  return null; // single-category edge or an even tie → neutral
}

const SP_CATS = [
  { key: 'ERA', inv: true, rate: rERA, disp: (g) => rERA(g).toFixed(2) + ' ERA' },
  { key: 'WHIP', inv: true, rate: rWHIP, disp: (g) => rWHIP(g).toFixed(2) + ' WHIP' },
  { key: 'K', inv: false, rate: rK9, disp: (g) => rK9(g).toFixed(1) + ' K/9' },
  { key: 'QS', inv: false, rate: rQS, disp: (g) => Math.round(rQS(g) * 100) + '% QS' },
];
const RP_CATS = SP_CATS.filter((c) => c.key !== 'QS');

// Classify one category for a window vs the league bar, with the drop-best-game consistency guard:
// the flag must survive removing the single game that most supports it.
function classifyCat(win, cat, bar) {
  if (!bar) return { elite: false, weak: false };
  const inv = cat.inv, r = cat.rate(win);
  const eliteRaw = inv ? r <= bar.elite : r >= bar.elite;
  const weakRaw = inv ? r >= bar.weak : r <= bar.weak;
  let elite = eliteRaw, weak = weakRaw;
  if (win.length > 1) {
    const outs = win.map((_, i) => cat.rate(win.filter((__, j) => j !== i)));
    if (eliteRaw) { const worst = inv ? Math.max(...outs) : Math.min(...outs); elite = inv ? worst <= bar.elite : worst >= bar.elite; }
    if (weakRaw) { const best = inv ? Math.min(...outs) : Math.max(...outs); weak = inv ? best >= bar.weak : best <= bar.weak; }
  }
  return { elite, weak };
}

// A single category clearing its bar is enough; the winning side (elite vs weak) sets the badge.
function badgeFrom(win, cats, bars) {
  const E = [], W = [];
  for (const c of cats) { const f = classifyCat(win, c, bars[c.key]); if (f.elite) E.push(c); else if (f.weak) W.push(c); }
  if (E.length && E.length > W.length) return { tag: 'hot', reason: E.map((c) => c.disp(win)).join(', ') };
  if (W.length && W.length > E.length) return { tag: 'cold', reason: W.map((c) => c.disp(win)).join(', ') };
  return null;
}

// --- game logs (rich, per category) ---
async function mlbHitGames(id, season) {
  const j = await getJson(`${MLB_API}/people/${id}/stats?stats=gameLog&season=${season}&group=hitting&gameType=R`);
  return (j.stats?.[0]?.splits || []).map((sp) => { const s = sp.stat || {}; return {
    date: sp.date || '',
    ab: num(s.atBats), h: num(s.hits), hr: num(s.homeRuns), rbi: num(s.rbi), r: num(s.runs),
    bb: num(s.baseOnBalls), hbp: num(s.hitByPitch), pa: num(s.plateAppearances),
  }; });
}
async function mlbPitchGames(id, season) {
  const j = await getJson(`${MLB_API}/people/${id}/stats?stats=gameLog&season=${season}&group=pitching&gameType=R`);
  return (j.stats?.[0]?.splits || []).map((sp) => { const s = sp.stat || {}; const ip = ipDec(s.inningsPitched); return {
    date: sp.date || '', ip, er: num(s.earnedRuns), k: num(s.strikeOuts), h: num(s.hits), bb: num(s.baseOnBalls),
    gs: num(s.gamesStarted), qs: (ip >= 6 && num(s.earnedRuns) <= 3) ? 1 : 0,
  }; });
}

// --- league bars for PITCHERS from qualified regulars' season rates (hitters use fixed bars above) ---
async function pitcherBars(season) {
  const j = await getJson(`${MLB_API}/stats?stats=season&group=pitching&season=${season}&sportId=1&playerPool=qualified&limit=500`);
  const sp = (j.stats?.[0]?.splits || []).map((s) => { const t = s.stat || {}; return { id: s.player?.id, gs: num(t.gamesStarted), ERA: num(t.era), WHIP: num(t.whip), K: num(t.strikeoutsPer9Inn) }; }).filter((r) => r.gs >= POOL_MIN / 2);
  // Season pitching stats don't expose Quality Starts, so the QS-rate distribution comes from each
  // qualified starter's game log (concurrency-capped). ERA/WHIP inverted: elite = low = P20 bar.
  const qsRates = [];
  await mapLimit(sp, 8, async (r) => { try { const g = (await mlbPitchGames(r.id, season)).filter((x) => x.gs > 0); if (g.length) qsRates.push(g.reduce((t, x) => t + x.qs, 0) / g.length); } catch { /* skip */ } });
  return {
    ERA: { elite: pctl(sp.map((r) => r.ERA), WEAK_P), weak: pctl(sp.map((r) => r.ERA), ELITE_P) },
    WHIP: { elite: pctl(sp.map((r) => r.WHIP), WEAK_P), weak: pctl(sp.map((r) => r.WHIP), ELITE_P) },
    K: { elite: pctl(sp.map((r) => r.K), ELITE_P), weak: pctl(sp.map((r) => r.K), WEAK_P) },
    QS: { elite: pctl(qsRates, ELITE_P), weak: pctl(qsRates, WEAK_P) },
  };
}

// Active-roster player IDs across all 30 clubs (~780). Cross-referencing the dataset against this both
// defines full-roster coverage AND limits form to currently-active players, so IL/optioned players
// (whose recent game logs are weeks stale) are never badged. ~30 cheap calls.
async function activeRosterIds(season) {
  const j = await getJson(`${MLB_API}/teams?sportId=1&season=${season}`);
  const ids = new Set();
  await mapLimit(j.teams || [], 10, async (t) => {
    try {
      const r = await getJson(`${MLB_API}/teams/${t.id}/roster?rosterType=active`);
      for (const m of r.roster || []) if (m.person?.id != null) ids.add(m.person.id);
    } catch { /* a failed team just means its players fall back to unbadged */ }
  });
  return ids;
}

async function enrichMlbForm(dataset, season) {
  const [pBars, activeIds] = await Promise.all([pitcherBars(season), activeRosterIds(season)]);
  // Full-roster coverage: every dataset player on an active MLB roster. Sorted by rank so that if the
  // soft time guard trips, the most fantasy-relevant players are already done (graceful degradation).
  const targets = dataset.players
    .filter((p) => !p.searchOnly && p.id != null && activeIds.has(p.id))
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const deadline = Date.now() + MLB_FORM_SOFT_MS;
  let hot = 0, cold = 0, checked = 0, skipped = 0;
  await mapLimit(targets, MLB_FORM_CONC, async (p) => {
    if (Date.now() > deadline) { skipped++; return; } // past the soft budget — leave the rest unbadged this run
    checked++;
    try {
      const first = (p.pos || '').split('/')[0].trim();
      const isPit = first === 'SP' || first === 'RP';
      let b = null, wlabel = '';
      if (isPit) {
        const g = await mlbPitchGames(p.id, season);
        g.sort((a, bb) => (a.date < bb.date ? 1 : -1)); // newest first
        let win, cats;
        if (first === 'SP') { win = g.filter((x) => x.gs > 0).slice(0, SP_WINDOW); if (win.length < SP_MIN) return; wlabel = `last ${win.length} starts`; cats = SP_CATS; }
        else { win = g.slice(0, RP_WINDOW); if (win.length < RP_MIN) return; wlabel = `last ${win.length} appearances`; cats = RP_CATS; }
        b = badgeFrom(win, cats, pBars);
      } else {
        const g = await mlbHitGames(p.id, season);
        g.sort((a, bb) => (a.date < bb.date ? 1 : -1)); // newest first
        const win = recentWindow(g, HIT_WINDOW, HIT_GAP_DAYS); // last 15 games played, reset at any >14-day gap
        if (win.length < HIT_MIN_APPEAR) return; // too few appearances since returning from an absence
        wlabel = `last ${win.length}`;
        b = hitterBadge(win);
      }
      if (!b) return;
      p.tag = b.tag; p.trend = b.tag === 'hot' ? 'up' : 'down'; p.trendVal = '';
      p.formReason = `${b.reason} · ${wlabel}`;
      if (b.tag === 'hot') hot++; else cold++;
    } catch { /* per-player failure is non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: checked, formTargets: targets.length, formSkipped: skipped };
}

// ════════════════════════════════════════════════════════════════════════════
// NHL: fixed-absolute per-category HOT/COLD (mirrors the MLB hitter model)
// ════════════════════════════════════════════════════════════════════════════
const NHL_GL = 'https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes';
const NHL_WINDOW = 15, NHL_MIN = 8, NHL_GAP_DAYS = 14; // last 15 games (appearances for goalies); reset at a >14-day gap; need >= 8 to badge
const NHL_FORM_CONC = 8;                               // concurrent ESPN gamelog fetches
const NHL_FORM_SOFT_MS = 90000;                        // soft time budget so full-roster form can't dominate the shared cron

// "mm:ss" time-on-ice → minutes (num() would keep only the whole-minute part).
const toiMin = (s) => { const [m, sec] = String(s ?? '0:0').split(':'); return (parseInt(m) || 0) + (parseInt(sec) || 0) / 60; };

// ── SKATERS: G/A/SOG two-sided + PPP hot-only, over the last-15-game window (totals) ──
// Bars are fixed 15-game production, not league/self-relative. HOT ≈ elite pace: 8 G (~44-goal pace),
// 10 A (~55-assist pace), 50 SOG (top-15 shot volume), 6 PPP (~33 PPP/82). COLD = a clear drought.
// PPP is hot-only (a scoreless PP stretch usually means off PP1, i.e. deployment, not cold form).
//
// ROLE TIER (from live verification): DEFENSEMEN are HOT-ONLY. G/A/SOG all scale with offensive role,
// so a normal defenseman line ("0 G, 15 SOG") clears two cold bars just by being a defenseman — 55% of
// D-men false-flagged COLD in testing. The high HOT bars stay role-appropriate (only a genuine
// offensive-D run like Fox's 14 A / 11 PPP clears two), so D keeps HOT and drops COLD entirely.
const SK_HOT = { G: 8, A: 10, SOG: 50, PPP: 6 };
const SK_COLD = { G: 1, A: 2, SOG: 22 };
function nhlSkaterBadge(win, isD) {
  const g = sum(win, 'g'), a = sum(win, 'a'), sog = sum(win, 'sog'), ppp = sum(win, 'ppp');
  const H = [], C = []; // isD → cold side suppressed (C stays empty, so a defenseman can never go cold)
  if (g >= SK_HOT.G) H.push(g + ' G'); else if (!isD && g <= SK_COLD.G) C.push(g + ' G');
  if (a >= SK_HOT.A) H.push(a + ' A'); else if (!isD && a <= SK_COLD.A) C.push(a + ' A');
  if (sog >= SK_HOT.SOG) H.push(sog + ' SOG'); else if (!isD && sog <= SK_COLD.SOG) C.push(sog + ' SOG');
  if (ppp >= SK_HOT.PPP) H.push(ppp + ' PPP'); // hot-only
  if (H.length >= 2 && H.length > C.length) return { tag: 'hot', reason: H.join(', ') };
  if (C.length >= 2 && C.length > H.length) return { tag: 'cold', reason: C.join(', ') };
  return null; // single-category edge or an even tie → neutral
}

// ── GOALIES: SV%/GAA/W two-sided + SO hot-only, over the last-15-appearance window ──
// SV% and GAA are aggregated from the window's raw totals (saves/shots-against and goals-against/TOI),
// not by averaging per-game rates. GAA is inverted (lower = elite). SO is hot-only (0 is normal).
const G_HOT = { SVPCT: 0.925, GAA: 2.40, W: 10, SO: 2 };
const G_COLD = { SVPCT: 0.890, GAA: 3.30, W: 4 };
function nhlGoalieBadge(win) {
  const ga = sum(win, 'ga'), toi = sum(win, 'toi'), sa = sum(win, 'sa'), sv = sum(win, 'sv'), w = sum(win, 'w'), so = sum(win, 'so');
  const svpct = sa ? sv / sa : 0;
  const gaa = toi ? ga * 60 / toi : 0;
  const H = [], C = [];
  if (svpct >= G_HOT.SVPCT) H.push(fmt3(svpct) + ' SV%'); else if (svpct <= G_COLD.SVPCT) C.push(fmt3(svpct) + ' SV%');
  if (gaa <= G_HOT.GAA) H.push(gaa.toFixed(2) + ' GAA'); else if (gaa >= G_COLD.GAA) C.push(gaa.toFixed(2) + ' GAA'); // inverted
  if (w >= G_HOT.W) H.push(w + ' W'); else if (w <= G_COLD.W) C.push(w + ' W');
  if (so >= G_HOT.SO) H.push(so + ' SO'); // hot-only
  if (H.length >= 2 && H.length > C.length) return { tag: 'hot', reason: H.join(', ') };
  if (C.length >= 2 && C.length > H.length) return { tag: 'cold', reason: C.join(', ') };
  return null;
}

// Per-game NHL log, split by role. Skaters carry G/A/SOG/PPP totals; goalies carry the raw
// components SV%/GAA are rebuilt from (plus wins/shutouts). Goalie DNPs (0 TOI) are dropped so the
// window is 15 real appearances.
async function nhlGames(id, isGoalie) {
  const gl = await getJson(`${NHL_GL}/${id}/gamelog`);
  const idx = new Map((gl.names || []).map((n, i) => [n, i]));
  const events = gl.events || {};
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const at = (s, name) => num(s[idx.get(name)]);
  const games = [];
  for (const cat of st.categories || []) for (const ev of cat.events || []) {
    const s = ev.stats || [];
    const d = events[ev.eventId]?.gameDate;
    const date = d ? new Date(d).toISOString() : '';
    if (isGoalie) {
      const toi = toiMin(s[idx.get('timeOnIcePerGame')]);
      if (toi <= 0) continue; // didn't actually play
      games.push({ date, toi, ga: at(s, 'goalsAgainst'), sa: at(s, 'shotsAgainst'), sv: at(s, 'saves'), w: at(s, 'wins'), so: at(s, 'shutouts') });
    } else {
      games.push({ date, g: at(s, 'goals'), a: at(s, 'assists'), sog: at(s, 'shotsTotal'), ppp: at(s, 'powerPlayGoals') + at(s, 'powerPlayAssists') });
    }
  }
  return games;
}

async function enrichNhlForm(dataset) {
  // Full-roster coverage: every non-searchOnly NHL player (rankedSk + rankedG). Sorted by rank so if
  // the soft time guard trips, the most fantasy-relevant players are already done.
  const targets = dataset.players
    .filter((p) => !p.searchOnly && p.id != null)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const deadline = Date.now() + NHL_FORM_SOFT_MS;
  let hot = 0, cold = 0, checked = 0, skipped = 0;
  await mapLimit(targets, NHL_FORM_CONC, async (p) => {
    if (Date.now() > deadline) { skipped++; return; } // past the soft budget — leave the rest unbadged this run
    checked++;
    try {
      const pos = (p.pos || '').toUpperCase();
      const isG = pos === 'G';
      const g = await nhlGames(p.id, isG);
      g.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
      const win = recentWindow(g, NHL_WINDOW, NHL_GAP_DAYS);
      if (win.length < NHL_MIN) return; // too few appearances (early season / just returned / backup)
      const b = isG ? nhlGoalieBadge(win) : nhlSkaterBadge(win, pos === 'D');
      if (!b) return;
      p.tag = b.tag; p.trend = b.tag === 'hot' ? 'up' : 'down'; p.trendVal = '';
      p.formReason = `${b.reason} · last ${win.length}`;
      if (b.tag === 'hot') hot++; else cold++;
    } catch { /* per-player failure is non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: checked, formTargets: targets.length, formSkipped: skipped };
}

// ════════════════════════════════════════════════════════════════════════════
// BASKETBALL (NBA + WNBA): fixed-absolute per-category HOT/COLD (mirrors MLB hitter model)
// ════════════════════════════════════════════════════════════════════════════
// NBA and WNBA share the 9-cat roto set AND an identical ESPN gamelog schema, so ONE engine drives both
// (hoopsGames / hoopsBadge / enrichHoopsForm) — only the thresholds differ (WNBA scaled for its shorter,
// 40-minute season).
const NBA_GL = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes';
const WNBA_GL = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/wnba/athletes';
const HOOPS_WINDOW = 15, HOOPS_MIN = 8, HOOPS_GAP_DAYS = 14; // last 15 games; reset at a >14-day gap; need >= 8 to badge
const HOOPS_FORM_CONC = 8, HOOPS_FORM_SOFT_MS = 90000;

// ESPN gives FG/3PT/FT as "made-attempted" strings ("8-18"); split to component totals.
const madeAtt = (s) => { const [m, a] = String(s ?? '0-0').split('-'); return [num(m), num(a)]; };

// ── Only PTS/FG% are two-sided; FT% + the specialty counting cats (3PM/AST/REB/STL/BLK) are HOT-ONLY. ──
// Basketball roto cats are heavily position-shaped (a guard gets ~0 BLK, a center ~0 3PM), so a fixed
// COLD bar on any of them would false-flag by role — the NHL-defenseman problem, worse. The COLD side
// rides only the position-robust signals PTS + FG%: a slumping scorer of any position reads low PTS AND
// low FG%, while a low-usage big stays EFFICIENT (FG% not cold) so the 2+ rule leaves him neutral.
// FT% is HOT-ONLY on purpose: it's the one rate where bigs are the WORST, so a two-sided FT% re-leaked
// the role problem (poor-FT bigs like Gobert false-flagged COLD on PTS+FT% baseline, not a slump) —
// live verification caught it. Specialty cats stay hot-only so each archetype (guard 3PM/FT%, big
// REB/BLK, playmaker AST) can earn HOT its own way. Counting cats are per-game averages over the window;
// FG%/FT% are window make/attempt totals.
const NBA_HOT = { PTS: 25.0, FG: 0.520, FT: 0.900, TPM: 3.5, AST: 8.0, REB: 12.0, STL: 2.2, BLK: 2.0 };
const NBA_COLD = { PTS: 12.0, FG: 0.400 };
// WNBA — same structure, scaled for the 44-game / 40-minute season: scoring & 3PT volume run lower, while
// REB/BLK scale less (bigs still play big minutes). FT% stays hot-only for the same poor-FT-big reason.
const WNBA_HOT = { PTS: 20.0, FG: 0.500, FT: 0.900, TPM: 2.5, AST: 6.5, REB: 10.5, STL: 2.0, BLK: 1.8 };
const WNBA_COLD = { PTS: 9.0, FG: 0.380 };
function hoopsBadge(win, HOT, COLD) {
  const gp = win.length;
  const ppg = sum(win, 'pts') / gp;
  const fga = sum(win, 'fga'), fgm = sum(win, 'fgm'), fg = fga ? fgm / fga : 0;
  const fta = sum(win, 'fta'), ftm = sum(win, 'ftm'), ft = fta ? ftm / fta : 0;
  const tpm = sum(win, 'tpm') / gp, ast = sum(win, 'ast') / gp, reb = sum(win, 'reb') / gp;
  const stl = sum(win, 'stl') / gp, blk = sum(win, 'blk') / gp;
  const H = [], C = [];
  // two-sided (position-robust): PTS + FG%
  if (ppg >= HOT.PTS) H.push(ppg.toFixed(1) + ' PTS'); else if (ppg <= COLD.PTS) C.push(ppg.toFixed(1) + ' PTS');
  if (fga && fg >= HOT.FG) H.push(fmt3(fg) + ' FG%'); else if (fga && fg <= COLD.FG) C.push(fmt3(fg) + ' FG%');
  // hot-only: FT% (bigs are chronically poor → no cold side) + specialty counting cats
  if (fta && ft >= HOT.FT) H.push(fmt3(ft) + ' FT%');
  if (tpm >= HOT.TPM) H.push(tpm.toFixed(1) + ' 3PM');
  if (ast >= HOT.AST) H.push(ast.toFixed(1) + ' AST');
  if (reb >= HOT.REB) H.push(reb.toFixed(1) + ' REB');
  if (stl >= HOT.STL) H.push(stl.toFixed(1) + ' STL');
  if (blk >= HOT.BLK) H.push(blk.toFixed(1) + ' BLK');
  if (H.length >= 2 && H.length > C.length) return { tag: 'hot', reason: H.join(', ') };
  if (C.length >= 2 && C.length > H.length) return { tag: 'cold', reason: C.join(', ') };
  return null;
}

// Per-game basketball log (NBA or WNBA — identical schema). DNP rows (0 minutes) dropped so the window
// is 15 real appearances. `base` is the sport's athletes URL.
async function hoopsGames(id, base) {
  const gl = await getJson(`${base}/${id}/gamelog`);
  const idx = new Map((gl.names || []).map((n, i) => [n, i]));
  const events = gl.events || {};
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const gi = (s, name) => s[idx.get(name)];
  const games = [];
  for (const cat of st.categories || []) for (const ev of cat.events || []) {
    const s = ev.stats || [];
    if (num(gi(s, 'minutes')) <= 0) continue; // DNP
    const [fgm, fga] = madeAtt(gi(s, 'fieldGoalsMade-fieldGoalsAttempted'));
    const [ftm, fta] = madeAtt(gi(s, 'freeThrowsMade-freeThrowsAttempted'));
    const [tpm] = madeAtt(gi(s, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
    const d = events[ev.eventId]?.gameDate;
    games.push({
      date: d ? new Date(d).toISOString() : '',
      pts: num(gi(s, 'points')), reb: num(gi(s, 'totalRebounds')), ast: num(gi(s, 'assists')),
      stl: num(gi(s, 'steals')), blk: num(gi(s, 'blocks')), tpm, fgm, fga, ftm, fta,
    });
  }
  return games;
}

async function enrichHoopsForm(dataset, base, HOT, COLD) {
  // Full-roster coverage: every non-searchOnly player, sorted by rank for graceful degradation.
  const targets = dataset.players
    .filter((p) => !p.searchOnly && p.id != null)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const deadline = Date.now() + HOOPS_FORM_SOFT_MS;
  let hot = 0, cold = 0, checked = 0, skipped = 0;
  await mapLimit(targets, HOOPS_FORM_CONC, async (p) => {
    if (Date.now() > deadline) { skipped++; return; }
    checked++;
    try {
      const g = await hoopsGames(p.id, base);
      g.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
      const win = recentWindow(g, HOOPS_WINDOW, HOOPS_GAP_DAYS);
      if (win.length < HOOPS_MIN) return;
      const b = hoopsBadge(win, HOT, COLD);
      if (!b) return;
      p.tag = b.tag; p.trend = b.tag === 'hot' ? 'up' : 'down'; p.trendVal = '';
      p.formReason = `${b.reason} · last ${win.length}`;
      if (b.tag === 'hot') hot++; else cold++;
    } catch { /* per-player failure is non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: checked, formTargets: targets.length, formSkipped: skipped };
}

// ════════════════════════════════════════════════════════════════════════════
// NFL: fantasy-points-per-game form (points league — see nflForm.js for the model)
// ════════════════════════════════════════════════════════════════════════════
// HYBRID by design: the cron does the expensive gamelog work ONCE — it stores each skill player's raw
// last-N game lines on `p.recentGames` (so the per-user endpoint can recompute FPPG under that league's
// own scoring, no network) AND bakes a default STANDARD-PPR badge here for logged-out / free /
// no-linked-league viewers. Only QB/RB/WR/TE are covered; K/DST are excluded (near-random week to week).
const NFL_GL = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes';
const NFL_SKILL = new Set(['QB', 'RB', 'WR', 'TE']);
const NFL_FORM_CONC = 8, NFL_FORM_SOFT_MS = 90000;
// Relevance gate: badge only rosterable-caliber skill players (top-N per position by SEASON fantasy
// value). NFL rosters carry a long non-contributor tail (4-5 RBs, 6-7 WRs per team) that a fixed COLD
// bar would perma-flag — "not startable" isn't "slumping". Gating by season value (are you rosterable?)
// while the badge reads recent form (are you slumping?) keeps COLD meaningful: a startable player still
// has the season value to stay in the gate even mid-slump. Also caps the gamelog fetches to ~150.
const NFL_DEPTH = { QB: 30, RB: 45, WR: 55, TE: 24 };

// Per-game NFL box-score line (raw components any scoring formula needs). Position-specific gamelogs
// omit the irrelevant fields, so missing stats read as 0 (a WR has no passing columns, etc.).
async function nflGames(id) {
  const gl = await getJson(`${NFL_GL}/${id}/gamelog`);
  const idx = new Map((gl.names || []).map((n, i) => [n, i]));
  const events = gl.events || {};
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const gi = (s, name) => num(s[idx.get(name)]);
  const games = [];
  for (const cat of st.categories || []) for (const ev of cat.events || []) {
    const s = ev.stats || [];
    const d = events[ev.eventId]?.gameDate;
    games.push({
      date: d ? new Date(d).toISOString() : '',
      passYds: gi(s, 'passingYards'), passTD: gi(s, 'passingTouchdowns'), passInt: gi(s, 'interceptions'),
      rushYds: gi(s, 'rushingYards'), rushTD: gi(s, 'rushingTouchdowns'),
      rec: gi(s, 'receptions'), recYds: gi(s, 'receivingYards'), recTD: gi(s, 'receivingTouchdowns'),
      fumLost: gi(s, 'fumblesLost'),
    });
  }
  return games;
}

async function enrichNflForm(dataset) {
  // Relevance gate: top-N per position by season fantasy value (fpPpr), so only rosterable-caliber
  // skill players are badged / get recentGames — the endpoint inherits the gate (no lines to rescore
  // for a gated-out player). Sorted by rank for graceful degradation under the soft time budget.
  const byPos = {};
  for (const p of dataset.players) {
    if (p.searchOnly || p.id == null || !NFL_SKILL.has(p.pos)) continue;
    (byPos[p.pos] ||= []).push(p);
  }
  const eligible = new Set();
  for (const pos in byPos) {
    byPos[pos].sort((a, b) => (b.fpPpr ?? b.fp ?? 0) - (a.fpPpr ?? a.fp ?? 0));
    for (const p of byPos[pos].slice(0, NFL_DEPTH[pos] ?? 0)) eligible.add(p);
  }
  const targets = [...eligible].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const deadline = Date.now() + NFL_FORM_SOFT_MS;
  let hot = 0, cold = 0, checked = 0, skipped = 0;
  await mapLimit(targets, NFL_FORM_CONC, async (p) => {
    if (Date.now() > deadline) { skipped++; return; }
    checked++;
    try {
      const g = await nflGames(p.id);
      g.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
      const win = recentWindow(g, NFL_WINDOW, NFL_GAP_DAYS); // gap reset uses ISO dates (a bye ~14d doesn't reset)
      if (win.length < NFL_MIN) return;
      // Store the raw window lines (date stripped — it was only for the gap logic) so the per-user
      // endpoint can recompute FPPG under any league's weights. Stored even when the default badge is
      // neutral, since a custom league can read hot/cold where standard PPR doesn't.
      p.recentGames = win.map(({ date, ...line }) => line);
      const b = nflFormBadge(win, p.pos, NFL_PPR); // default badge = standard PPR
      if (!b) return;
      p.tag = b.tag; p.trend = b.tag === 'hot' ? 'up' : 'down'; p.trendVal = '';
      p.formReason = b.reason;
      if (b.tag === 'hot') hot++; else cold++;
    } catch { /* per-player failure is non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: checked, formTargets: targets.length, formSkipped: skipped };
}

// Mutates dataset.players: sets tag 'hot'|'cold' (+ trend, formReason). All supported sports use the
// fixed-absolute model with full-roster coverage: MLB/NHL/NBA/WNBA per-category, NFL fantasy-points
// (which also stores p.recentGames so the per-user endpoint can rescore under a linked league).
// No-op (and no fetches) when the sport is out of season.
export async function enrichForm(dataset, { sport, season }) {
  if (!Array.isArray(dataset.players)) return;
  if (sport === 'mlb') {
    const teamGames = dataset.counts?.teamGames;
    if (teamGames == null || teamGames >= 162) { dataset.counts = { ...dataset.counts, formActive: false }; return; }
    try { await enrichMlbForm(dataset, season); }
    catch (err) { dataset.counts = { ...dataset.counts, formActive: false, formError: String(err?.message || err) }; }
    return;
  }
  if (sport === 'nhl') {
    const maxGames = dataset.counts?.maxGames;
    if (maxGames == null || maxGames >= 82) { dataset.counts = { ...dataset.counts, formActive: false }; return; }
    try { await enrichNhlForm(dataset); }
    catch (err) { dataset.counts = { ...dataset.counts, formActive: false, formError: String(err?.message || err) }; }
    return;
  }
  if (sport === 'nba') {
    const maxGames = dataset.counts?.maxGames;
    if (maxGames == null || maxGames >= 82) { dataset.counts = { ...dataset.counts, formActive: false }; return; }
    try { await enrichHoopsForm(dataset, NBA_GL, NBA_HOT, NBA_COLD); }
    catch (err) { dataset.counts = { ...dataset.counts, formActive: false, formError: String(err?.message || err) }; }
    return;
  }
  if (sport === 'wnba') {
    const maxGames = dataset.counts?.maxGames;
    if (maxGames == null || maxGames >= 44) { dataset.counts = { ...dataset.counts, formActive: false }; return; }
    try { await enrichHoopsForm(dataset, WNBA_GL, WNBA_HOT, WNBA_COLD); }
    catch (err) { dataset.counts = { ...dataset.counts, formActive: false, formError: String(err?.message || err) }; }
    return;
  }
  if (sport === 'nfl') {
    const maxGames = dataset.counts?.maxGames;
    if (maxGames == null || maxGames >= 17) { dataset.counts = { ...dataset.counts, formActive: false }; return; }
    try { await enrichNflForm(dataset); }
    catch (err) { dataset.counts = { ...dataset.counts, formActive: false, formError: String(err?.message || err) }; }
    return;
  }
  dataset.counts = { ...dataset.counts, formActive: false }; // unknown sport → no form model
}
