// NFL weekly consistency + ceiling, from per-game PPR fantasy points over the season.
//
// CONSISTENCY = round(100 × floor / median) = P25 / P50 — "how close is a bad week to a typical week."
// Floor-relative-to-median (not floor/ceiling) on purpose: a big ceiling is UPSIDE, not inconsistency,
// so a high-ceiling stud (Amon-Ra) shouldn't read as unreliable. Higher = steadier. CEILING = P90 is
// stored SEPARATELY as a distinct upside stat (never folded into the consistency number).
//
// Cron enrichment, computed in PPR (the board default; the scoring toggle doesn't change it — a known,
// accepted v1 approximation). Runs YEAR-ROUND (unlike the form badges): offseason it reports the last
// completed season, still a useful "boom-or-bust?" signal; in-season it recomputes as games accrue.
// Relevance-gated to rosterable skill players (top-N per position by season value), >= 6 games played.
// The ESPN game log lists games PLAYED (inactive weeks aren't logged), so percentiles are over real
// games — a bye/injury week isn't counted as a 0. Additive + failure-tolerant.

import { getJson } from './espn.js';
import { nflGameFpts, NFL_PPR } from './nflForm.js';

const NFL_GL = 'https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes';
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);          // K/DST excluded — near-random, no per-game skill signal
const DEPTH = { QB: 30, RB: 45, WR: 55, TE: 24 };          // relevance gate (same shape as the form badges)
const MIN_GAMES = 6;
const CONC = 8, SOFT_MS = 90000;                           // soft budget so it can't dominate the shared cron

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const r1 = (v) => Math.round(v * 10) / 10;

async function mapLimit(items, limit, fn) {
  for (let i = 0; i < items.length; i += limit) await Promise.all(items.slice(i, i + limit).map(fn));
}

// Linear-interpolated percentile of a numeric array.
function pctl(arr, q) {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = q * (a.length - 1), lo = Math.floor(i), hi = Math.ceil(i);
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

// Per-game PPR fantasy points for one player's regular-season game log.
async function seasonFpts(id) {
  const gl = await getJson(`${NFL_GL}/${id}/gamelog`);
  const idx = new Map((gl.names || []).map((n, i) => [n, i]));
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const gi = (s, name) => num(s[idx.get(name)]);
  const out = [];
  for (const cat of st.categories || []) for (const ev of cat.events || []) {
    const s = ev.stats || [];
    out.push(nflGameFpts({
      passYds: gi(s, 'passingYards'), passTD: gi(s, 'passingTouchdowns'), passInt: gi(s, 'interceptions'),
      rushYds: gi(s, 'rushingYards'), rushTD: gi(s, 'rushingTouchdowns'),
      rec: gi(s, 'receptions'), recYds: gi(s, 'receivingYards'), recTD: gi(s, 'receivingTouchdowns'),
      fumLost: gi(s, 'fumblesLost'),
    }, NFL_PPR));
  }
  return out;
}

// Mutates dataset.players: sets p.consistency (0-100, higher = steadier) and p.ceiling (P90 upside pts)
// on rosterable skill players with enough games. Leaves others untouched (render as '—').
export async function enrichNflConsistency(dataset) {
  if (!Array.isArray(dataset.players)) return;
  // Relevance gate: top-N per position by season fantasy value.
  const byPos = {};
  for (const p of dataset.players) {
    if (p.searchOnly || p.id == null || !SKILL.has(p.pos)) continue;
    (byPos[p.pos] ||= []).push(p);
  }
  const targets = [];
  for (const pos in byPos) {
    byPos[pos].sort((a, b) => (b.fpPpr ?? b.fp ?? 0) - (a.fpPpr ?? a.fp ?? 0));
    targets.push(...byPos[pos].slice(0, DEPTH[pos] ?? 0));
  }
  const deadline = Date.now() + SOFT_MS;
  let done = 0, skipped = 0;
  await mapLimit(targets, CONC, async (p) => {
    if (Date.now() > deadline) { skipped++; return; }
    try {
      const fpts = await seasonFpts(p.id);
      if (fpts.length < MIN_GAMES) return;
      const p25 = pctl(fpts, 0.25), p50 = pctl(fpts, 0.50), p90 = pctl(fpts, 0.90);
      p.consistency = p50 > 0 ? Math.round(100 * p25 / p50) : null; // floor relative to a typical week
      p.ceiling = r1(p90);                                          // upside, stored separately
      done++;
    } catch { /* per-player failure is non-fatal */ }
  });
  dataset.counts = { ...dataset.counts, consistency: done, consistencySkipped: skipped };
}
