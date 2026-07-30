// NFL season-long projections from Sleeper's free, no-key JSON API, fetched daily by the
// refresh cron and merged onto the cached NFL dataset so each draft card, the Coach, and the
// blended-value ranking can read a player's projected line + projected fantasy points.
//
// Why Sleeper (replaced a FantasyPros scrape): FantasyPros only server-renders ~10 players
// per position to a no-JS client (the rest is JS-loaded) and its full-roster feed needs a paid
// key — too thin to anchor a full-roster ranking. Sleeper's projections endpoint returns the
// FULL slate (~3k players) as clean JSON, with points in all three scoring formats natively.
//
//   GET https://api.sleeper.com/projections/nfl/{season}?season_type=regular&position[]=QB…
//   -> [ { player:{first_name,last_name,team,fantasy_positions,...}, stats:{pts_ppr,pts_std,
//          pts_half_ppr, pass_yd, pass_td, rush_yd, rush_td, rec, rec_yd, rec_td, ...} }, … ]
//
// Failure-tolerant: a failed fetch falls back to the last good pull stored in KV, so one bad
// run never wipes projections. Attaches `proj = { fpts, line[], scoring, pts:{ppr,std,half} }`
// per matched player — same shape the cards/Coach already read, plus `pts` for the blend model.
import { PROJECTIONS_KEY } from './kv.js';

const API = 'https://api.sleeper.com/projections/nfl';
const UA = { 'User-Agent': 'FantasyEdge/1.0 (+https://fantasy-edge-nine.vercel.app)' };
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']; // Sleeper uses DEF; we map it to DST

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;

// Normalize a player name for cross-source matching: lowercase, drop punctuation and
// generational suffixes (Jr/Sr/II-V), collapse whitespace.
export function normName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.'`,]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalize a team-defense identity: strip the "D/ST"/"Defense" designator so Sleeper's
// "Los Angeles Rams" matches ESPN's "Los Angeles Rams D/ST".
function teamKey(name) {
  return normName(String(name || '').replace(/d\/?st|defense|special teams/gi, ''));
}

// Index key a player record matches on: name+pos for skill/K, team identity for DST.
// Exported so the ADP enricher matches players against the dataset identically.
export function keyFor(pos, name) {
  return pos === 'DST' ? `DST|${teamKey(name)}` : `${pos}|${normName(name)}`;
}

// Full per-position stat columns as [displayLabel, sleeperStatKey], ALIGNED to buildNflDataset's
// statLabels order so a seeded (rookie) record's s1..s5 line up with the ranked table. A
// '__'-prefixed key is computed (see statValue); a null value renders '—'. K/DST are partial (they
// aren't seeded and their cards only show a few fields).
const COLUMNS = {
  QB: [['PaYd', 'pass_yd'], ['PaTD', 'pass_td'], ['INT', 'pass_int'], ['RuYd', 'rush_yd'], ['RuTD', 'rush_td']],
  RB: [['RuYd', 'rush_yd'], ['RuTD', 'rush_td'], ['Rec', 'rec'], ['ReYd', 'rec_yd'], ['ReTD', 'rec_td']],
  WR: [['Rec', 'rec'], ['ReYd', 'rec_yd'], ['ReTD', 'rec_td'], ['Tgt', '__tgt'], ['RuYd', 'rush_yd']],
  TE: [['Rec', 'rec'], ['ReYd', 'rec_yd'], ['ReTD', 'rec_td'], ['Tgt', '__tgt'], ['RuYd', 'rush_yd']],
  K: [['FGM', '__fg'], ['XPM', 'xpm']],
  DST: [['Sack', 'sack'], ['INT', 'int'], ['TD', '__deftd']],
};
// The subset of labels shown on the compact draft-card line (projected FPTS is the headline).
const CARD = {
  QB: ['PaYd', 'PaTD', 'INT', 'RuYd', 'RuTD'], RB: ['RuYd', 'RuTD', 'Rec', 'ReYd', 'ReTD'],
  WR: ['Rec', 'ReYd', 'ReTD', 'RuYd'], TE: ['Rec', 'ReYd', 'ReTD'], K: ['FGM', 'XPM'], DST: ['Sack', 'INT', 'TD'],
};
// Rookie seeding: only skill positions, only above this projected-PPR floor (skip camp bodies).
const SEED_POS = new Set(['QB', 'RB', 'WR', 'TE']);
const SEED_FLOOR = 50;

// Read a (possibly computed) stat from a Sleeper stats object. null -> the cell renders '—'.
function statValue(st, key) {
  if (key === '__tgt') return null; // Sleeper doesn't project targets separately
  if (key === '__fg') return Object.keys(st).filter((k) => /^fgm_\d/.test(k)).reduce((a, k) => a + (st[k] || 0), 0);
  if (key === '__deftd') return (st.def_fum_td || 0) + (st.def_kr_td || 0) + (st.def_st_td || 0) + (st.def_td || 0);
  return st[key];
}

// Sleeper fantasy_positions[0] -> our position code (DEF -> DST); null for anything we don't rank.
function posOf(pl) {
  const p = (pl.fantasy_positions || [])[0];
  if (p === 'DEF') return 'DST';
  return ['QB', 'RB', 'WR', 'TE', 'K'].includes(p) ? p : null;
}

// Fetch one position's season projections from Sleeper. Returns normalized rows; [] on failure.
async function fetchPosition(season, sleeperPos) {
  try {
    const url = `${API}/${season}?season_type=regular&position[]=${sleeperPos}&order_by=pts_ppr`;
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return [];
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    const rows = [];
    for (const r of arr) {
      const pl = r.player || {};
      const pos = posOf(pl);
      if (!pos) continue;
      const st = r.stats || {};
      const name = pos === 'DST'
        ? `${pl.first_name || ''} ${pl.last_name || ''}`.trim() // "Los Angeles Rams"
        : `${pl.first_name || ''} ${pl.last_name || ''}`.trim();
      if (!name) continue;
      const stats = {};
      for (const [label, key] of (COLUMNS[pos] || [])) {
        const v = statValue(st, key);
        if (v != null) stats[label] = round1(v);
      }
      rows.push({
        id: r.player_id != null ? String(r.player_id) : null, // Sleeper's stable id (row-level)
        exp: pl.years_exp,                                     // 0 = rookie
        name, team: pl.team || null, pos,
        pts: { ppr: round1(st.pts_ppr), std: round1(st.pts_std ?? st.pts_ppr), half: round1(st.pts_half_ppr ?? st.pts_ppr) },
        stats,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

// Pull every position and return { builtAt, season, scoring, players:[...] }. Positions that
// fail are simply absent (the whole run only "fails" if nothing came back at all).
export async function fetchSleeperProjections(season) {
  const players = [];
  for (const sp of POSITIONS) players.push(...await fetchPosition(season, sp));
  return { builtAt: new Date().toISOString(), season, scoring: 'PPR', players };
}

// Fetch Sleeper projections and attach a `proj` object to each matching NFL dataset player.
// Stores the raw pull in KV (PROJECTIONS_KEY) and reuses the last good one if this run pulls
// nothing. Mutates dataset in place; additive and failure-tolerant.
export async function enrichNflProjections(dataset, redis) {
  if (!dataset?.players?.length) return;
  // The UPCOMING/ranking season, not ESPN's stat season: in the offseason ESPN's byathlete is still
  // last year's completed data (dataset.counts.season = 2025) while we want the 2026 projections.
  const season = Math.max(new Date().getFullYear(), Number(dataset.counts?.season) || 0);

  let pull = await fetchSleeperProjections(season);
  if (pull.players.length) {
    await redis.set(PROJECTIONS_KEY, pull);
  } else {
    const cached = await redis.get(PROJECTIONS_KEY);
    if (cached?.players?.length) pull = cached;
  }
  if (!pull.players?.length) return;

  // First projection per key wins (rows arrive best-first by pts_ppr, so the starter keeps the key).
  const byKey = new Map();
  for (const r of pull.players) {
    const k = keyFor(r.pos, r.name);
    if (!byKey.has(k)) byKey.set(k, r);
  }

  // The compact card line (CARD subset) for a projection row.
  const cardLine = (r) => (CARD[r.pos] || [])
    .map((label) => ({ label, val: r.stats[label] }))
    .filter((s) => s.val != null);
  const projOf = (r) => ({ fpts: r.pts.ppr, line: cardLine(r), scoring: pull.scoring, pts: r.pts });

  // Match existing dataset players; also record which keys already exist (so seeding can't dupe).
  const existing = new Set();
  let matched = 0;
  for (const pl of dataset.players) {
    existing.add(keyFor(pl.pos, pl.name));
    const r = byKey.get(keyFor(pl.pos, pl.name));
    if (!r) continue;
    pl.proj = projOf(r); // `pts` feeds the blend; `fpts`+`line` are what cards/Coach render
    matched++;
  }

  // Seed true rookies (years_exp === 0) that Sleeper projects but ESPN's byathlete universe lacks,
  // so a projection-aware draft board isn't missing the incoming class. Skill positions only, above
  // a projected-PPR floor, never duplicating an existing key. Synthetic record: no current/prior
  // stats (games 0), so the blend collapses to the projection. fpPpr/fpStd seed the blend's actual/
  // recent legs (both = projection in the offseason), yielding blend = projection. See
  // docs/nfl-rookie-seeding-scoping.md.
  let seeded = 0;
  for (const r of pull.players) {
    if (!SEED_POS.has(r.pos) || r.exp !== 0 || !r.id || r.pts.ppr < SEED_FLOOR) continue;
    const k = keyFor(r.pos, r.name);
    if (existing.has(k)) continue;
    existing.add(k);
    const cols = COLUMNS[r.pos] || [];
    const s = cols.map(([label]) => (r.stats[label] != null ? String(r.stats[label]) : '—'));
    dataset.players.push({
      id: `sleeper-${r.id}`, name: r.name, team: r.team || '—', league: null, pos: r.pos,
      hasStats: true, games: 0, rookie: true, searchOnly: false,
      fpPpr: r.pts.ppr, fpStd: r.pts.std, fp: r.pts.ppr,
      s1: s[0] ?? '—', s2: s[1] ?? '—', s3: s[2] ?? '—', s4: s[3] ?? '—', s5: s[4] ?? '—', s6: r.pts.ppr.toFixed(1),
      statLabels: [...cols.map(([label]) => label), 'FPTS'], cats: [],
      proj: projOf(r), emoji: '🏈', trend: 'flat', trendVal: '', own: 5, tag: null,
    });
    seeded++;
  }

  dataset.counts = {
    ...dataset.counts,
    projections: { matched, seeded, pulled: pull.players.length, source: 'sleeper', builtAt: pull.builtAt },
  };
}
