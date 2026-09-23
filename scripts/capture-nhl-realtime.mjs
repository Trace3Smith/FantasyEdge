// One-time authoring tool: capture 2025-26 hits + blocked shots from the NHL's public stats
// API and write the static snapshot api/_lib/nhl-realtime-2025-26.json.
//
// ESPN's byathlete NHL feed does not expose hits or blocked shots (see buildNhlDataset.js), but
// both are scored categories in many leagues. This is a MANUAL, network-backed authoring script
// in the spirit of scripts/gen-cfb-venues.mjs — it is never called at runtime: no Vercel
// function, no Redis key, no cron. buildNhlDataset.js imports the committed JSON directly.
//
//   node scripts/capture-nhl-realtime.mjs            # report the join, write nothing
//   node scripts/capture-nhl-realtime.mjs --write    # rewrite the committed snapshot
//
// The snapshot is keyed by ESPN athlete id, so the join (name + team) is resolved HERE, once,
// and the runtime build never has to guess. Unmatched players are reported, never invented.

import { writeFileSync } from 'node:fs';
import { fetchByAthlete, buildIndex, makeReader } from '../api/_lib/espn.js';

const SEASON_ID = 20252026;
const SEASON_LABEL = '2025-26';
const OUT = new URL('../api/_lib/nhl-realtime-2025-26.json', import.meta.url);

// ESPN team abbreviation -> NHL team abbreviation, for the handful that differ.
const TEAM_ALIAS = { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL' };
const nhlTeam = (t) => TEAM_ALIAS[t] || t;

// Name normalization for the join: lowercase, strip accents, drop punctuation and suffixes.
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
  .replace(/[^a-z ]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The NHL stats gateway intermittently returns a Cloudflare 524 on a cold page. Retry with
// backoff rather than abandoning a capture that is otherwise complete.
async function getPage(start, limit) {
  const qs = new URLSearchParams({
    isAggregate: 'false', isGame: 'false', start: String(start), limit: String(limit),
    sort: JSON.stringify([{ property: 'hits', direction: 'DESC' }, { property: 'playerId', direction: 'ASC' }]),
    cayenneExp: `gameTypeId=2 and seasonId=${SEASON_ID}`,
  });
  let last;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch(`https://api.nhle.com/stats/rest/en/skater/realtime?${qs}`, { signal: AbortSignal.timeout(45000) });
      if (r.ok) return r.json();
      last = new Error(`HTTP ${r.status}`);
    } catch (err) { last = err; }
    await sleep(attempt * 2000);
  }
  throw new Error(`NHL realtime failed at start=${start}: ${last?.message}`);
}

async function fetchRealtime() {
  const rows = [];
  const limit = 100;
  for (let start = 0; ; start += limit) {
    const j = await getPage(start, limit);
    rows.push(...(j.data || []));
    process.stderr.write(`  page ${start / limit + 1}: ${rows.length}/${j.total}\n`);
    if (rows.length >= (j.total || 0) || !j.data?.length) break;
  }
  return rows;
}

const nhlRows = await fetchRealtime();
console.log(`NHL realtime ${SEASON_LABEL}: ${nhlRows.length} skaters`);

// Our side: the same ESPN pull buildNhlDataset uses, so ids and teams line up exactly.
const { athletes, categories, season } = await fetchByAthlete({ sportPath: 'hockey/nhl', sort: 'offensive.points:desc' });
const val = makeReader(buildIndex(categories));
const ours = [];
for (const a of athletes) {
  const at = a.athlete || {};
  if (at.id == null) continue;
  const pos = at.position?.abbreviation || 'F';
  if (pos === 'G') continue; // hits/blocks are a skater category
  ours.push({
    id: String(at.id),
    name: at.displayName || `${at.firstName || ''} ${at.lastName || ''}`.trim(),
    team: at.teamShortName || at.teamName || '',
    gp: val(a, 'general', 'games') || 0,
  });
}
console.log(`ESPN ${season}: ${ours.length} skaters`);

// Index the NHL rows by normalized name+team, and by name alone (only when unambiguous).
const byNameTeam = new Map();
const byName = new Map();
for (const r of nhlRows) {
  const n = norm(r.skaterFullName);
  for (const t of String(r.teamAbbrevs || '').split(/[,/]/).map((x) => x.trim()).filter(Boolean)) {
    byNameTeam.set(`${n}|${t}`, r);
  }
  if (byName.has(n)) byName.set(n, null); // ambiguous — never guess
  else byName.set(n, r);
}

// The NHL feed uses LEGAL names where ESPN uses common ones ("John-Jason Peterka" vs "JJ
// Peterka", "Mathew Dumba" vs "Matt Dumba", "Mats Zuccarello Aasen" vs "Mats Zuccarello"), and
// Vancouver carried two different Elias Petterssons. Last resort: same team, identical games
// played, and a shared name token — accepted ONLY when that lands on exactly one NHL row.
const byTeam = new Map();
for (const r of nhlRows) {
  for (const t of String(r.teamAbbrevs || '').split(/[,/]/).map((x) => x.trim()).filter(Boolean)) {
    (byTeam.get(t) || byTeam.set(t, []).get(t)).push(r);
  }
}
const tokens = (s) => new Set(norm(s).split(' ').filter((t) => t.length >= 3));
function sharedToken(a, b) {
  const tb = tokens(b);
  for (const t of tokens(a)) if (tb.has(t)) return true;
  return false;
}

const out = {};
const unmatched = [];
let viaTeam = 0, viaName = 0, viaGp = 0;
for (const p of ours) {
  const n = norm(p.name);
  let row = byNameTeam.get(`${n}|${nhlTeam(p.team)}`);
  if (row) viaTeam++;
  else {
    row = byName.get(n) || null;
    if (row) viaName++;
    else {
      const pool = (byTeam.get(nhlTeam(p.team)) || [])
        .filter((r) => r.gamesPlayed === p.gp && sharedToken(p.name, r.skaterFullName));
      if (pool.length === 1) { row = pool[0]; viaGp++; }
    }
  }
  if (!row) { unmatched.push(p); continue; }
  out[p.id] = { hit: row.hits ?? 0, blk: row.blockedShots ?? 0, gp: row.gamesPlayed ?? 0 };
}

const matched = Object.keys(out).length;
const rate = (matched / ours.length) * 100;
console.log(`\nmatched ${matched}/${ours.length} = ${rate.toFixed(2)}%  (name+team ${viaTeam}, name-only ${viaName}, team+GP+token ${viaGp})`);

// The draft only ever ranks skaters above the games gate, so report that population separately.
const maxGp = ours.reduce((m, p) => Math.max(m, p.gp), 0);
const gate = Math.max(3, Math.round(0.35 * maxGp));
const ranked = ours.filter((p) => p.gp >= gate);
const rankedMatched = ranked.filter((p) => out[p.id]).length;
console.log(`ranked skaters (gp >= ${gate}): ${rankedMatched}/${ranked.length} = ${((rankedMatched / ranked.length) * 100).toFixed(2)}%`);

if (unmatched.length) {
  console.log(`\nunmatched (${unmatched.length}), worst by games played:`);
  for (const p of unmatched.sort((a, b) => b.gp - a.gp).slice(0, 20)) {
    console.log(`  ${String(p.gp).padStart(3)} GP  ${p.name} (${p.team})`);
  }
}

if (process.argv.includes('--write')) {
  writeFileSync(OUT, `${JSON.stringify({ season: SEASON_LABEL, source: 'api.nhle.com/stats/rest/en/skater/realtime', capturedAt: new Date().toISOString().slice(0, 10), players: out }, null, 0)}\n`);
  console.log(`\nwrote ${OUT.pathname} (${matched} players)`);
} else {
  console.log('\n(dry run — pass --write to rewrite the snapshot)');
}
