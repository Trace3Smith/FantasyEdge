// NFL consensus ADP (average draft position) from the Fantasy Football Calculator
// free JSON API, fetched daily and merged onto the cached NFL dataset. Drives realistic
// mock-draft opponents (they pick near where real managers do) and the "falling past
// ADP" value boost in the recommendation engine.
//
// FFC publishes ADP per SCORING format — Standard, PPR, and Half-PPR (native, no blend
// needed) — and per league size. We pull the three formats at a canonical 12-team size;
// league size drives only the draft mechanics, not the ADP set. The API returns skill
// players plus PK/DEF; we keep skill players (QB/RB/WR/TE) to match how ADP has always
// been used here — K/DST have no meaningful early ADP and the engine drafts them late.
//
// Failure-tolerant: a format that fails to fetch is skipped, and enrichNflAdp falls back
// to the last good pull in KV so one bad run never drops ADP.
import { ADP_KEY } from './kv.js';
import { keyFor } from './fantasyProjections.js';

const FFC = 'https://fantasyfootballcalculator.com/api/v1/adp';
const UA = {
  'User-Agent': 'Mozilla/5.0 (compatible; FantasyEdge/1.0; +https://fantasy-edge-nine.vercel.app)',
};
// Our format key -> the FFC endpoint slug. Half-PPR is native here (replaces the old
// PPR/Standard midpoint blend).
const FORMATS = { ppr: 'ppr', standard: 'standard', half: 'half-ppr' };
const TEAMS = 12; // canonical league size for the stored ADP set

const round1 = (v) => Math.round(v * 10) / 10;

// FFC position codes -> ours. Skill positions pass straight through; anything else
// (PK / DEF) is dropped by the caller, matching how ADP has always been scoped here.
const SKILL = new Set(['QB', 'RB', 'WR', 'TE']);

// Fetch one scoring format into [{ name, team, pos, adp }]. Failure-tolerant — any error
// or non-OK response yields an empty list so the other formats still ship.
async function fetchFormat(slug, year) {
  try {
    const res = await fetch(`${FFC}/${slug}?teams=${TEAMS}&year=${year}&position=all`, { headers: UA });
    if (!res.ok) return [];
    const json = await res.json();
    const out = [];
    for (const p of json?.players || []) {
      const pos = String(p.position || '').toUpperCase();
      const adp = parseFloat(p.adp);
      if (!SKILL.has(pos) || !p.name || !isFinite(adp)) continue;
      out.push({ name: String(p.name).trim(), team: p.team || null, pos, adp: round1(adp) });
    }
    return out;
  } catch {
    return [];
  }
}

// Pull all three scoring formats. Returns { builtAt, ppr:[...], standard:[...], half:[...] }.
// builtAt is our fetch time (when this ran), i.e. how fresh our ADP copy is.
export async function fetchFfcAdp() {
  const year = new Date().getUTCFullYear();
  const result = { builtAt: new Date().toISOString() };
  const entries = Object.entries(FORMATS);
  const lists = await Promise.all(entries.map(([, slug]) => fetchFormat(slug, year)));
  entries.forEach(([key], i) => { result[key] = lists[i]; });
  return result;
}

const totalRows = (s) => (s?.ppr?.length || 0) + (s?.standard?.length || 0) + (s?.half?.length || 0);

// Fetch ADP and attach `adp: { ppr, standard, half }` to each matching NFL player. Stores
// the raw pull in KV; reuses the last good one if this run fetched nothing. Mutates
// dataset in place; additive and failure-tolerant.
export async function enrichNflAdp(dataset, redis) {
  if (!dataset?.players?.length) return;

  let adp = await fetchFfcAdp();
  if (totalRows(adp)) {
    await redis.set(ADP_KEY, adp);
  } else {
    const cached = await redis.get(ADP_KEY);
    if (totalRows(cached)) adp = cached;
  }
  if (!totalRows(adp)) return;

  // First ADP per key wins (rows are ranked best-first).
  const index = (rows) => {
    const map = new Map();
    for (const r of rows || []) {
      const k = keyFor(r.pos, r.name);
      if (!map.has(k)) map.set(k, r.adp);
    }
    return map;
  };
  const pprMap = index(adp.ppr);
  const stdMap = index(adp.standard);
  const halfMap = index(adp.half);

  let matched = 0;
  for (const pl of dataset.players) {
    const k = keyFor(pl.pos, pl.name);
    const ppr = pprMap.get(k);
    const standard = stdMap.get(k);
    const half = halfMap.get(k);
    if (ppr == null && standard == null && half == null) continue;
    pl.adp = { ppr: ppr ?? null, standard: standard ?? null, half: half ?? null };
    matched++;
  }

  dataset.counts = {
    ...dataset.counts,
    adp: {
      matched,
      ppr: adp.ppr?.length || 0,
      standard: adp.standard?.length || 0,
      half: adp.half?.length || 0,
      builtAt: adp.builtAt,
    },
  };
}
