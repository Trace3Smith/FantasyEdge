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
      return await r.json();
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
// Returns { athletes, categories, season }.
export async function fetchByAthlete({ sportPath, sort, limit = 50, seasonType = 2 }) {
  const base = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/statistics/byathlete`;
  const athletes = [];
  let categories = null;
  let season = null;
  let page = 1;
  let pages = 1;
  do {
    const url = `${base}?region=us&lang=en&contentorigin=espn&seasontype=${seasonType}&limit=${limit}&page=${page}&sort=${sort}`;
    const j = await getJson(url);
    if (page === 1) {
      categories = j.categories || [];
      season = j.requestedSeason?.displayName || j.currentSeason?.displayName || null;
      pages = j.pagination?.pages || 1;
    }
    if (Array.isArray(j.athletes)) athletes.push(...j.athletes);
    page++;
  } while (page <= pages);
  return { athletes, categories, season };
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
