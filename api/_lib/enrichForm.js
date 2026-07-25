// Recent-form HOT/COLD badges.
//
// MLB (in-season) uses a LEAGUE-BASELINE, per-category model: a player is HOT/COLD when his recent
// window rate in a category sits in the league's ELITE / WEAK tier (top / bottom 20% of qualified
// regulars), not merely above/below his OWN average — so a weak hitter's lucky stretch that's still
// short of league-elite is not flagged. Hitters score on AVG, HR, OBP; starters on ERA, QS, K/9,
// WHIP; relievers on ERA, K/9, WHIP (ERA/WHIP inverted — lower is better/hotter). A SINGLE category
// clearing its bar earns the badge, guarded by a drop-best-game consistency check so one outlier
// game can't drive it. The badge carries a `formReason` (e.g. ".367 AVG, 6 HR · last 15").
//
// The OTHER sports (NBA/NHL/WNBA/NFL) still use the older recent-vs-own-average model (unchanged)
// until they're ported.
//
// Cost control + gating: top-N ranked players, in-season only (detected from the data), daily cron.
// Failure-tolerant per player and overall.

import { getJson } from './espn.js';

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
const MLB_TOP_N = 75;                         // evaluate the top-75 ranked

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
const rHR = (g) => (g.length ? sum(g, 'hr') / g.length : 0);
const rAVG = (g) => { const ab = sum(g, 'ab'); return ab ? sum(g, 'h') / ab : 0; };
const rOBP = (g) => { const pa = sum(g, 'pa'); return pa ? (sum(g, 'h') + sum(g, 'bb') + sum(g, 'hbp')) / pa : 0; };
const rERA = (g) => { const ip = sum(g, 'ip'); return ip ? sum(g, 'er') * 9 / ip : 0; };
const rWHIP = (g) => { const ip = sum(g, 'ip'); return ip ? (sum(g, 'h') + sum(g, 'bb')) / ip : 0; };
const rK9 = (g) => { const ip = sum(g, 'ip'); return ip ? sum(g, 'k') * 9 / ip : 0; };
const rQS = (g) => (g.length ? sum(g, 'qs') / g.length : 0);

const HIT_CATS = [
  { key: 'AVG', inv: false, rate: rAVG, disp: (g) => fmt3(rAVG(g)) + ' AVG' },
  { key: 'HR', inv: false, rate: rHR, disp: (g) => sum(g, 'hr') + ' HR' },
  { key: 'OBP', inv: false, rate: rOBP, disp: (g) => fmt3(rOBP(g)) + ' OBP' },
];
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
    date: sp.date || '', teamId: sp.team?.id ?? null,
    ab: num(s.atBats), h: num(s.hits), hr: num(s.homeRuns), bb: num(s.baseOnBalls), hbp: num(s.hitByPitch), pa: num(s.plateAppearances),
  }; });
}
async function mlbPitchGames(id, season) {
  const j = await getJson(`${MLB_API}/people/${id}/stats?stats=gameLog&season=${season}&group=pitching&gameType=R`);
  return (j.stats?.[0]?.splits || []).map((sp) => { const s = sp.stat || {}; const ip = ipDec(s.inningsPitched); return {
    date: sp.date || '', ip, er: num(s.earnedRuns), k: num(s.strikeOuts), h: num(s.hits), bb: num(s.baseOnBalls),
    gs: num(s.gamesStarted), qs: (ip >= 6 && num(s.earnedRuns) <= 3) ? 1 : 0,
  }; });
}

// --- league bars from qualified regulars' season rates (per-game for HR, ratios otherwise) ---
async function hitterBars(season) {
  const j = await getJson(`${MLB_API}/stats?stats=season&group=hitting&season=${season}&sportId=1&playerPool=qualified&limit=500`);
  const rows = (j.stats?.[0]?.splits || []).map((sp) => { const t = sp.stat || {}; const G = num(t.gamesPlayed), ab = num(t.atBats), h = num(t.hits), bb = num(t.baseOnBalls), hbp = num(t.hitByPitch), pa = num(t.plateAppearances);
    return { G, HR: G ? num(t.homeRuns) / G : 0, AVG: ab ? h / ab : 0, OBP: pa ? (h + bb + hbp) / pa : 0 }; }).filter((r) => r.G >= POOL_MIN);
  const bar = (k) => ({ elite: pctl(rows.map((r) => r[k]), ELITE_P), weak: pctl(rows.map((r) => r[k]), WEAK_P) });
  return { AVG: bar('AVG'), HR: bar('HR'), OBP: bar('OBP') };
}
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

async function enrichMlbForm(dataset, season) {
  const top = dataset.players.filter((p) => !p.searchOnly && p.rank != null).sort((a, b) => a.rank - b.rank).slice(0, MLB_TOP_N);
  const [hBars, pBars] = await Promise.all([hitterBars(season), pitcherBars(season)]);
  let hot = 0, cold = 0;
  await mapLimit(top, 8, async (p) => {
    try {
      const first = (p.pos || '').split('/')[0].trim();
      const isPit = first === 'SP' || first === 'RP';
      let win, cats, wlabel, bars;
      if (isPit) {
        const g = await mlbPitchGames(p.id, season);
        g.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
        if (first === 'SP') { win = g.filter((x) => x.gs > 0).slice(0, SP_WINDOW); if (win.length < SP_MIN) return; wlabel = `last ${win.length} starts`; cats = SP_CATS; }
        else { win = g.slice(0, RP_WINDOW); if (win.length < RP_MIN) return; wlabel = `last ${win.length} appearances`; cats = RP_CATS; }
        bars = pBars;
      } else {
        const g = await mlbHitGames(p.id, season);
        g.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
        win = recentWindow(g, HIT_WINDOW, HIT_GAP_DAYS); // last 15 games played, reset at any >14-day gap
        if (win.length < HIT_MIN_APPEAR) return; // too few appearances since returning from an absence
        cats = HIT_CATS; bars = hBars; wlabel = `last ${win.length}`;
      }
      const b = badgeFrom(win, cats, bars);
      if (!b) return;
      p.tag = b.tag; p.trend = b.tag === 'hot' ? 'up' : 'down'; p.trendVal = '';
      p.formReason = `${b.reason} · ${wlabel}`;
      if (b.tag === 'hot') hot++; else cold++;
    } catch { /* per-player failure is non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: top.length };
}

// ════════════════════════════════════════════════════════════════════════════
// LEGACY: recent-vs-own-average model (NBA / NHL / WNBA / NFL — unchanged)
// ════════════════════════════════════════════════════════════════════════════
const FORM = {
  nba: { minGames: 10, full: 82, recent: 5, path: 'basketball/nba' },
  wnba: { minGames: 10, full: 44, recent: 5, path: 'basketball/wnba' },
  nhl: { minGames: 10, full: 82, recent: 5, path: 'hockey/nhl' },
  nfl: { minGames: 4, full: 17, recent: 3, path: 'football/nfl' },
};
const HOT = 1.20, COLD = 0.80;

function gameValueEspn(sport, pos, v) {
  if (sport === 'nba' || sport === 'wnba')
    return v('points') + 1.2 * v('totalRebounds') + 1.5 * v('assists') + 3 * v('steals') + 3 * v('blocks') - v('turnovers');
  if (sport === 'nhl') {
    if (pos === 'G') return 2 * v('wins') + 0.2 * v('saves') + 3 * v('shutouts') - 1.5 * v('goalsAgainst');
    return 3 * v('goals') + 2 * v('assists') + 0.4 * v('shotsTotal') + 0.5 * (v('powerPlayGoals') + v('powerPlayAssists')) + v('plusMinus');
  }
  if (sport === 'nfl')
    return v('passingYards') * 0.04 + v('passingTouchdowns') * 4 - v('interceptions') * 2
      + v('rushingYards') * 0.1 + v('rushingTouchdowns') * 6
      + v('receptions') + v('receivingYards') * 0.1 + v('receivingTouchdowns') * 6 - v('fumblesLost') * 2;
  return 0;
}
async function espnGames(path, id, sport, pos) {
  const gl = await getJson(`https://site.web.api.espn.com/apis/common/v3/sports/${path}/athletes/${id}/gamelog`);
  const idx = new Map((gl.names || []).map((n, i) => [n, i]));
  const events = gl.events || {};
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const games = [];
  for (const cat of st.categories || []) for (const ev of cat.events || []) {
    const v = (name) => num(ev.stats?.[idx.get(name)]);
    const d = events[ev.eventId]?.gameDate;
    games.push({ date: d ? new Date(d).getTime() : 0, value: gameValueEspn(sport, pos, v) });
  }
  return games;
}
async function enrichFormLegacy(dataset, { sport }) {
  const cfg = FORM[sport];
  if (!cfg) return;
  const maxGames = dataset.counts?.maxGames;
  if (maxGames == null || maxGames >= cfg.full) { dataset.counts = { ...dataset.counts, formActive: false }; return; }
  const top = dataset.players.filter((p) => !p.searchOnly && p.rank != null).sort((a, b) => a.rank - b.rank).slice(0, MLB_TOP_N);
  let hot = 0, cold = 0;
  await mapLimit(top, 8, async (p) => {
    try {
      const games = await espnGames(cfg.path, p.id, sport, p.pos);
      if (games.length < cfg.minGames) return;
      games.sort((a, b) => b.date - a.date);
      const recent = games.slice(0, cfg.recent);
      const seasonAvg = games.reduce((a, g) => a + g.value, 0) / games.length;
      const recentAvg = recent.reduce((a, g) => a + g.value, 0) / recent.length;
      if (seasonAvg <= 0) return;
      const ratio = recentAvg / seasonAvg;
      if (ratio >= HOT) { p.tag = 'hot'; p.trend = 'up'; p.trendVal = '+' + Math.round((ratio - 1) * 100) + '%'; hot++; }
      else if (ratio <= COLD) { p.tag = 'cold'; p.trend = 'down'; p.trendVal = '-' + Math.round((1 - ratio) * 100) + '%'; cold++; }
    } catch { /* non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, formActive: true, formHot: hot, formCold: cold, formChecked: top.length };
}

// Mutates dataset.players: sets tag 'hot'|'cold' (+ trend, formReason for MLB) on the top players.
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
  return enrichFormLegacy(dataset, { sport, season });
}
