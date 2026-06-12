// FanGraphs playerId -> MLBAM id crosswalk, backed by the Chadwick Bureau
// register (open CC-licensed data on GitHub). MLBAM id is the universal join key
// for everything else in the dataset (40-man rosters, MiLB leaderboards), but the
// FanGraphs board carries only FanGraphs ids — so we bridge them here.
//
// The full register is ~64MB across 16 shards; we never want to pull that daily.
// Resolved ids are cached in KV (XWALK_KEY) and the register is fetched only to
// fill ids we haven't seen before. The board is stable, so after the first run
// most days resolve entirely from cache with zero Chadwick traffic.

import { XWALK_KEY } from './kv.js';

const UA = 'Mozilla/5.0';
const SHARDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
const SHARD_URL = (s) =>
  `https://raw.githubusercontent.com/chadwickbureau/register/master/data/people-${s}.csv`;

// Scan the register shards for the wanted FanGraphs ids, returning a plain
// { fgId: mlbamId } object. Sequential per shard to bound memory; stops early
// once every wanted id is found.
async function scanChadwick(wanted) {
  const found = {};
  let remaining = new Set(wanted);
  for (const s of SHARDS) {
    if (!remaining.size) break;
    let text;
    try {
      const r = await fetch(SHARD_URL(s), { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      text = await r.text();
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const iFg = header.indexOf('key_fangraphs');
    const iMlb = header.indexOf('key_mlbam');
    if (iFg < 0 || iMlb < 0) continue;
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(','); // key columns precede any name field → comma-safe
      const fg = cols[iFg];
      if (fg && remaining.has(fg)) {
        const mlb = cols[iMlb];
        if (mlb) found[fg] = parseInt(mlb, 10);
        remaining.delete(fg);
        if (!remaining.size) break;
      }
    }
  }
  return found;
}

// Resolve a list of numeric FanGraphs ids to MLBAM ids. Reads/writes the KV
// cache and only touches Chadwick for cache misses. Returns Map<fgId, mlbamId>.
export async function resolveCrosswalk(fgIds, redis) {
  const ids = [...new Set(fgIds.filter(Boolean).map(String))];
  let cache = {};
  try {
    cache = (await redis.get(XWALK_KEY)) || {};
  } catch {
    cache = {};
  }
  const missing = ids.filter((id) => !(id in cache));
  if (missing.length) {
    const found = await scanChadwick(missing);
    if (Object.keys(found).length) {
      Object.assign(cache, found);
      try {
        await redis.set(XWALK_KEY, cache);
      } catch {
        /* non-fatal: we still return what we resolved this run */
      }
    }
  }
  const out = new Map();
  for (const id of ids) {
    if (cache[id] != null) out.set(id, cache[id]);
  }
  return out;
}
