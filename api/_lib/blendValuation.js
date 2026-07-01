// Blended player valuation for MLB.
//
// Pure pre-season projections (or pure current-season z-scores) make a player's
// trade value lurch: a star's slow April tanks him, a fluke-hot scrub floats to
// the top. This module instead blends three views of a player onto ONE z-scale:
//
//   1) CURRENT  — this season's roto z-score (already computed in buildDataset).
//   2) BASELINE — the player's value over the prior 2-3 full seasons, z-scored
//      within each of those seasons' pools so it lives on the same scale as (1).
//      This also stands in for the pre-season-projection leg: a multi-year
//      baseline IS what projection systems mostly regress toward, and MLB has no
//      free projection feed (FanGraphs/Steamer sit behind Cloudflare). The
//      projection weight therefore folds into the baseline weight (see WEIGHTS).
//
// The blend is SAMPLE-SIZE AWARE: early in the season the current line is noisy,
// so the baseline carries most of the weight; by mid-season the weights cross to
// the user-requested 50/30/20-style split; late season the current line — now a
// large, reliable sample — dominates. Weighting is driven by team games played
// (a real sample-size signal), not the calendar.
//
// OUTLIER PROTECTION: a player whose current production is >30% below his multi-
// year baseline is FLAGGED (not silently devalued) early in the year — "may be an
// outlier, monitor before trading" — and gets extra baseline weight so a cold
// start doesn't crater his value. But once the sample is large enough that the
// slump has run 60+ days, the protection is dropped: it's real underperformance
// now (Tatís at 3 HR by late June is not noise), and the season-progress weights
// already lean on the current line to devalue him.
//
// Network access is isolated in fetchPriorSeasonLeaders(); the math
// (blendWeights / detectOutlier / blendPlayerValue) is pure and unit-testable.

const API = 'https://statsapi.mlb.com/api/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

// How many prior full seasons feed the baseline ("last 2-3 season average").
const PRIOR_SEASONS = 3;
// A full MLB season is 162 team games — the denominator for season progress.
const FULL_SEASON_GAMES = 162;
// ~60 days into a season ≈ this many team games. Past this, a below-baseline line
// is treated as sustained underperformance rather than a small-sample outlier.
const SUSTAINED_GAMES = 50;
// Current production must fall this far below the multi-year baseline to flag.
const OUTLIER_DROP = 0.30;
// Minimum opportunity for a prior season to count toward the baseline (filters
// cups of coffee that would add z-score noise).
const MIN_PRIOR_PA = 150;
const MIN_PRIOR_IP = 40;
// Minimum sample for a production rate to be trustworthy (outlier detection). Below
// this the rate is too noisy to compare, so we skip the flag rather than guess.
const MIN_RATE_IP = 20;
// Extra baseline weight shifted off the current leg while a player is outlier-
// protected (cold start, not yet sustained).
const OUTLIER_SHIFT = 0.18;

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

function parseIp(s) {
  if (s == null) return 0;
  // A number here is ALREADY-converted innings (e.g. rec._p.ip from buildDataset,
  // which parsed "75.1" → 75.333). Re-splitting its float string ("75.33333…")
  // would read the fraction as 33-billion-and-change outs and blow IP up ~2.5×,
  // collapsing K/9 and false-flagging elite pitchers. So treat numbers as final.
  if (typeof s === 'number') return Number.isFinite(s) ? s : 0;
  const [whole, frac] = String(s).split('.');
  return (parseInt(whole) || 0) + (frac ? parseInt(frac) / 3 : 0);
}

// --- production rate: ONE positive number per player for outlier detection. -----
// A per-opportunity fantasy-ish rate so partial seasons compare fairly to full
// ones. Weighted toward the counting cats the user reasons about (HR/SB), which is
// exactly where slumps show up first (Judge's power, Tatís's HR).
export function hitterProdRate(h) {
  const pa = num(h.plateAppearances ?? h.pa);
  if (pa < 1) return null;
  const hr = num(h.homeRuns ?? h.hr), r = num(h.runs ?? h.r);
  const rbi = num(h.rbi), sb = num(h.stolenBases ?? h.sb), obp = num(h.obp);
  // power + run production + speed, lifted by on-base; scaled ×100 for readability.
  return ((4 * hr + r + rbi + 2 * sb) / pa + obp) * 100;
}
export function pitcherProdRate(p) {
  const ip = parseIp(p.inningsPitched ?? p.ip);
  if (ip < MIN_RATE_IP) return null; // too few innings to judge — skip the flag
  const k = num(p.strikeOuts ?? p.k);
  const era = num(p.era), whip = num(p.whip);
  // Stable, LINEAR skill components only: strikeout rate + run/baserunner prevention
  // vs a weak baseline. Wins/saves are deliberately dropped (team & bullpen-role
  // context, very high variance), and run prevention is linear — the old 1/ERA form
  // exploded for lucky low-ERA samples and false-flagged ~half the pitching pool as
  // "below career norms" on normal regression.
  const k9 = (k / ip) * 9;
  const runPrev = Math.max(0, 6.0 - (era > 0 ? era : 6.0));        // ER prevented vs a 6.00 ERA
  const whipPrev = Math.max(0, 1.60 - (whip > 0 ? whip : 1.60)) * 5; // baserunners prevented vs 1.60 WHIP
  return k9 + runPrev + whipPrev;
}

// --- per-season z-scoring (mirrors buildDataset's marginal-rate approach) --------
// Standardize a column set over a pool and return id -> summed z. read(p) yields the
// raw numeric source for p. Rate cats are pre-marginalized by the callers.
function standardizeIds(pool, cols, read, idOf) {
  const out = new Map();
  if (!pool.length) return out;
  const norm = {};
  for (const [src] of cols) {
    const xs = pool.map((p) => read(p)[src]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    norm[src] = { m, sd };
  }
  for (const p of pool) {
    let tot = 0;
    for (const [src] of cols) tot += (read(p)[src] - norm[src].m) / norm[src].sd;
    out.set(idOf(p), tot);
  }
  return out;
}

// Build id -> zTotal for one season's qualified hitters (marginal AVG/OBP weighted
// by playing time, same as the live build).
function scoreSeasonHitters(rows) {
  const pool = rows
    .filter((s) => s.player?.id && num(s.stat?.plateAppearances) >= MIN_PRIOR_PA)
    .map((s) => ({ id: s.player.id, h: {
      pa: num(s.stat.plateAppearances), ab: num(s.stat.atBats), h: num(s.stat.hits),
      bb: num(s.stat.baseOnBalls), hbp: num(s.stat.hitByPitch), sf: num(s.stat.sacFlies),
      hr: num(s.stat.homeRuns), r: num(s.stat.runs), rbi: num(s.stat.rbi),
      sb: num(s.stat.stolenBases), avg: num(s.stat.avg), obp: num(s.stat.obp),
    } }));
  if (!pool.length) return new Map();
  const sum = (f) => pool.reduce((a, p) => a + f(p.h), 0);
  const lgAVG = sum((h) => h.h) / (sum((h) => h.ab) || 1);
  const lgOBP = sum((h) => h.h + h.bb + h.hbp) / (sum((h) => h.ab + h.bb + h.hbp + h.sf) || 1);
  for (const p of pool) {
    p.h.mAVG = (p.h.avg - lgAVG) * p.h.ab;
    p.h.mOBP = (p.h.obp - lgOBP) * (p.h.ab + p.h.bb + p.h.hbp + p.h.sf);
  }
  return standardizeIds(
    pool,
    [['r'], ['hr'], ['rbi'], ['sb'], ['mAVG'], ['mOBP']],
    (p) => p.h, (p) => p.id,
  );
}

function scoreSeasonPitchers(rows) {
  const pool = rows
    .filter((s) => s.player?.id && parseIp(s.stat?.inningsPitched) >= MIN_PRIOR_IP)
    .map((s) => ({ id: s.player.id, p: {
      ip: parseIp(s.stat.inningsPitched), w: num(s.stat.wins), sv: num(s.stat.saves),
      k: num(s.stat.strikeOuts), era: num(s.stat.era), whip: num(s.stat.whip),
    } }));
  if (!pool.length) return new Map();
  const sumIp = pool.reduce((a, p) => a + p.p.ip, 0) || 1;
  const lgERA = pool.reduce((a, p) => a + p.p.era * p.p.ip, 0) / sumIp;
  const lgWHIP = pool.reduce((a, p) => a + p.p.whip * p.p.ip, 0) / sumIp;
  for (const p of pool) {
    p.p.mERA = (lgERA - p.p.era) * p.p.ip;
    p.p.mWHIP = (lgWHIP - p.p.whip) * p.p.ip;
  }
  return standardizeIds(
    pool,
    [['w'], ['sv'], ['k'], ['mERA'], ['mWHIP']],
    (p) => p.p, (p) => p.id,
  );
}

// Fetch the season leaderboards (hitting + pitching) for one prior season. Returns
// the raw splits arrays. Network-isolated so the math stays unit-testable.
async function fetchPriorSeasonLeaders(season) {
  const [hd, pd] = await Promise.all([
    getJson(`${API}/stats?stats=season&group=hitting&gameType=R&season=${season}&limit=2000&sortStat=homeRuns&order=desc`),
    getJson(`${API}/stats?stats=season&group=pitching&gameType=R&season=${season}&limit=2000&sortStat=strikeOuts&order=desc`),
  ]);
  return { hit: hd.stats?.[0]?.splits || [], pit: pd.stats?.[0]?.splits || [] };
}

// --- pure blend math ------------------------------------------------------------

// Weights for {current, baseline} given season progress (0..1 of a full season).
// The pre-season-projection leg folds into baseline (no free MLB projection feed),
// so the returned baseline weight is (historical + projection). With `protect` the
// blend leans harder on the baseline (outlier protection for a cold start).
// Calibrated so mid-season (~progress 0.5) lands near the requested 50% current /
// (30% history + 20% projection) split.
export function blendWeights(progress, { protect = false } = {}) {
  const p = clamp(progress, 0, 1);
  // current grows with sample size; baseline (history+proj) takes the rest.
  let cur = clamp(0.15 + 0.65 * p, 0.15, 0.78);
  // notional projection leg, decaying late as the current sample gets definitive.
  const proj = clamp(0.30 - 0.25 * p, 0.05, 0.30);
  let base = 1 - cur; // baseline already absorbs the projection leg
  if (protect) {
    const shift = Math.min(OUTLIER_SHIFT, cur - 0.10);
    cur -= shift; base += shift;
  }
  // Split the baseline into its history vs projection components for transparency.
  const projW = clamp((proj / (1 - 0.15)) * base, 0, base); // proportional share
  return { current: cur, baseline: base, history: base - projW, projection: projW, progress: p };
}

// Flag a cold start vs the multi-year baseline. `sustained` (large sample) demotes
// an "outlier" to real underperformance and drops the protection.
export function detectOutlier({ currentProd, baselineProd, teamGames, name }) {
  if (!(baselineProd > 0) || currentProd == null) return null;
  const ratio = currentProd / baselineProd;
  const belowPct = 1 - ratio;
  if (belowPct <= OUTLIER_DROP) return null; // within normal range (or above)
  const sustained = teamGames >= SUSTAINED_GAMES;
  const pct = Math.round(belowPct * 100);
  if (sustained) {
    return {
      status: 'sustained', protect: false, ratio, belowPct,
      note: `${name} is ${pct}% below career norms over ${teamGames}+ games — sustained underperformance, treat as their real value.`,
    };
  }
  return {
    status: 'outlier', protect: true, ratio, belowPct,
    note: `${name} trending ${pct}% below career norms — may be an outlier, monitor before trading.`,
  };
}

// Blend the available components onto the z-scale, renormalizing over whatever is
// present (current is always present; baseline needs prior seasons). Returns the
// blended value plus the parts/weights used (for transparency in the dataset).
export function blendPlayerValue({ current, baseline, projection = null, weights }) {
  const comps = [];
  if (current != null) comps.push([current, weights.current]);
  // history + projection share the baseline scale; if we ever get a real projection
  // on the z-scale, pass it as `projection` and it replaces that slice.
  if (baseline != null) comps.push([baseline, projection != null ? weights.history : weights.baseline]);
  if (baseline != null && projection != null) comps.push([projection, weights.projection]);
  const wSum = comps.reduce((a, [, w]) => a + w, 0) || 1;
  const value = comps.reduce((a, [v, w]) => a + v * w, 0) / wSum;
  return {
    value,
    parts: {
      current: current ?? null,
      baseline: baseline ?? null,
      projection,
      weights: { current: weights.current, baseline: weights.baseline, history: weights.history, projection: weights.projection },
      progress: weights.progress,
    },
  };
}

// --- entry point: enrich a freshly-built MLB dataset in place -------------------
//
// Called by buildDataset AFTER scoring (records still carry _h/_p and zTotal) and
// BEFORE the wire-cleanup. Adds rec.blendVal / rec.valParts / rec.outlier to each
// ranked hitter & pitcher. Additive + failure-tolerant: any error leaves the live
// current-season values untouched (callers fall back to zTotal).
export async function enrichBlendedValue(records, { season, teamGames }) {
  const ranked = records.filter((r) => r.hasStats && (r._h || r._p) && typeof r.zTotal === 'number');
  if (!ranked.length) return { ok: false, reason: 'no ranked players' };

  // 1) Pull prior-season baselines (per-season z + production rate per player id).
  const priorSeasons = Array.from({ length: PRIOR_SEASONS }, (_, i) => season - 1 - i);
  const histZ = new Map();   // id -> [zTotal per qualified prior season]
  const histProd = new Map(); // id -> [prodRate per prior season w/ opportunity]
  let seasonsLoaded = 0;
  const results = await Promise.allSettled(priorSeasons.map((s) => fetchPriorSeasonLeaders(s)));
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    seasonsLoaded++;
    const { hit, pit } = res.value;
    const hZ = scoreSeasonHitters(hit);
    const pZ = scoreSeasonPitchers(pit);
    for (const [id, z] of hZ) { if (!histZ.has(id)) histZ.set(id, []); histZ.get(id).push(z); }
    for (const [id, z] of pZ) { if (!histZ.has(id)) histZ.set(id, []); histZ.get(id).push(z); }
    for (const s of hit) {
      if (num(s.stat?.plateAppearances) < MIN_PRIOR_PA) continue; // baseline from real samples only
      const r = hitterProdRate(s.stat || {});
      if (s.player?.id && r != null) { if (!histProd.has(s.player.id)) histProd.set(s.player.id, []); histProd.get(s.player.id).push(r); }
    }
    for (const s of pit) {
      if (parseIp(s.stat?.inningsPitched) < MIN_PRIOR_IP) continue; // baseline from real samples only
      const r = pitcherProdRate(s.stat || {});
      if (s.player?.id && r != null) { if (!histProd.has(s.player.id)) histProd.set(s.player.id, []); histProd.get(s.player.id).push(r); }
    }
  }

  // 2) Blend each ranked player.
  const progress = clamp((teamGames || 0) / FULL_SEASON_GAMES, 0, 1);
  const mean = (arr) => (arr && arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  let blended = 0, flagged = 0;
  for (const rec of ranked) {
    const baseline = mean(histZ.get(rec.id));
    const curProd = rec._h ? hitterProdRate({ ...rec._h, plateAppearances: rec._h.pa }) : pitcherProdRate({ ...rec._p, inningsPitched: rec._p.ip });
    const baseProd = mean(histProd.get(rec.id));
    const outlier = detectOutlier({ currentProd: curProd, baselineProd: baseProd, teamGames: teamGames || 0, name: rec.name });
    const weights = blendWeights(progress, { protect: !!outlier?.protect });
    const { value, parts } = blendPlayerValue({ current: rec.zTotal, baseline, weights });
    rec.blendVal = Math.round(value * 1000) / 1000;
    rec.valParts = parts;
    if (outlier) { rec.outlier = { status: outlier.status, note: outlier.note, belowPct: Math.round(outlier.belowPct * 100) / 100 }; flagged++; }
    blended++;
  }
  return { ok: true, blended, flagged, seasonsLoaded, progress: Math.round(progress * 100) / 100 };
}
