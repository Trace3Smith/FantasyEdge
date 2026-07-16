// Shared client for ESPN's public "byathlete" season-statistics endpoint, used by
// the basketball (NBA/WNBA) and hockey (NHL) builders. ESPN is free, needs no key
// and no special headers, and is CDN-fronted — the most datacenter-friendly source
// (stats.nba.com IP-blocks serverless; balldontlie is key-gated).
//
// Stats arrive split across named categories (general/offensive/defensive/…), each
// with a `names` array indexing the per-athlete `totals` array. Read BY NAME via
// makeReader so differing column orders across leagues are handled transparently.

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'application/json',
};

export async function getJson(url, tries = 3) {
  let lastErr;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      const j = await r.json();
      // ESPN answers 200 with an error BODY when its own upstream fails, e.g.
      // {"code":400,"message":"http://sports.core.api.espn.pvt/...: 400"} — which is
      // what a league returns out of season, when the requested seasontype has no data
      // yet. Surface it as an error instead of letting callers read it as "no data".
      if (j && typeof j.code === 'number' && j.code >= 400) {
        throw new Error(`ESPN ${j.code} for ${url}: ${j.message || 'no message'}`);
      }
      return j;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 400 * (t + 1)));
    }
  }
  throw lastErr;
}

// Pull every page of a byathlete leaderboard. sportPath is the ESPN sport/league
// segment, e.g. 'basketball/nba' or 'hockey/nhl'; sort is any valid sort key (the
// order doesn't matter — callers re-rank).
//
// seasonType defaults to 2 (REGULAR SEASON). This is load-bearing: without it the
// endpoint returns whatever season type is *currently active* on the real-world
// calendar, which during spring/summer is the Postseason (type 3) — only the
// playoff teams' players, ~1/3 of the league. Fantasy rankings want full-season
// regular-season stats, so we always ask for type 2 explicitly.
//
// POISON ROWS. ESPN cannot serialize certain individual athlete records: asking for
// one alone (limit=1) returns 200 with a stub body, and so does ANY page whose row
// range spans it — so one bad row silently empties a 1000-row request. We fetch in
// chunks and, when a chunk stubs, subdivide it down CHUNK_CHAIN until the bad rows
// are isolated to themselves and skipped; every healthy row around them is kept.
// The rows are identified by position in the sorted list, so they move as stats
// change — this is discovered per run, never hardcoded.
//
// Returns { athletes, categories, season, skipped } — skipped = count of rows ESPN
// could not serialize.
const CHUNK_CHAIN = [50, 10, 1]; // each entry must divide the previous one

// Distinguish ESPN's three "200 with no athletes" answers. Only a response carrying
// pagination is a real (empty) answer — a page past the end. A body with neither
// athletes nor pagination is a failed query ("stub"), NOT an empty league.
const isStub = (j) => !Array.isArray(j?.athletes) && !j?.pagination;

export async function fetchByAthlete({ sportPath, sort, seasonType = 2, concurrency = 6 }) {
  const base = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/statistics/byathlete`;
  const url = (limit, page) =>
    `${base}?region=us&lang=en&contentorigin=espn&seasontype=${seasonType}&limit=${limit}&page=${page}&sort=${sort}`;

  const athletes = [];
  const skipped = [];
  let categories = null;
  let season = null;
  let count = null;

  const absorb = (j) => {
    if (!categories && j.categories?.length) categories = j.categories;
    if (!season) season = j.requestedSeason?.displayName || j.currentSeason?.displayName || null;
    if (count == null && j.pagination?.count != null) count = j.pagination.count;
  };

  // Establish the row count from a cheap single-row probe. Row 1 is normally fine, but
  // walk a few rows in case the very first one is a poison row (a stub carries no
  // pagination, so it tells us nothing).
  for (let probe = 1; probe <= 5 && count == null; probe++) {
    const j = await getJson(url(1, probe));
    absorb(j);
  }
  if (count == null) {
    throw new Error(`ESPN byathlete returned no pagination for ${sportPath} — cannot page`);
  }

  // Fetch one chunk; on a stub, recurse into smaller chunks over the same rows.
  async function take(level, page) {
    const limit = CHUNK_CHAIN[level];
    const j = await getJson(url(limit, page));
    if (Array.isArray(j.athletes)) {
      absorb(j);
      athletes.push(...j.athletes);
      return;
    }
    if (!isStub(j)) {
      absorb(j); // past the end — legitimately empty
      return;
    }
    if (level === CHUNK_CHAIN.length - 1) {
      skipped.push(page); // a single row ESPN cannot serialize; drop it and move on
      return;
    }
    const factor = limit / CHUNK_CHAIN[level + 1];
    const first = (page - 1) * factor + 1;
    for (let i = 0; i < factor; i++) await take(level + 1, first + i);
  }

  const pages = Math.ceil(count / CHUNK_CHAIN[0]);
  const queue = Array.from({ length: pages }, (_, i) => i + 1);
  for (let i = 0; i < queue.length; i += concurrency) {
    await Promise.all(queue.slice(i, i + concurrency).map((p) => take(0, p)));
  }

  // Every chunk stubbing means the leaderboard itself is broken, not that the league is
  // empty. Fail loudly rather than hand back an empty dataset that a caller would cache.
  if (!athletes.length) {
    throw new Error(`ESPN byathlete returned no athletes for ${sportPath} (${count} rows advertised)`);
  }
  return { athletes, categories: categories || [], season, skipped: skipped.length };
}

// Map of statName -> column index, per category, from the leaderboard header.
export function buildIndex(categories) {
  const idx = {};
  for (const c of categories || []) idx[c.name] = new Map((c.names || []).map((n, i) => [n, i]));
  return idx;
}

// Returns (athlete, categoryName, statName) -> number|null, reading by name.
export function makeReader(idx) {
  return (athlete, cat, name) => {
    const c = athlete.categories?.find((x) => x.name === cat);
    if (!c) return null;
    const i = idx[cat]?.get(name);
    if (i == null) return null;
    const v = c.totals?.[i];
    // ESPN formats large counting stats with thousands separators ("3,668",
    // "1,202"); parseFloat stops at the comma ("3,668" -> 3), so strip commas
    // first. Matters for NFL season yardage (passing/rushing/receiving > 999).
    return v == null || v === '' ? null : parseFloat(String(v).replace(/,/g, ''));
  };
}
