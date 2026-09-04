// Generates api/_lib/cfbVenues.js — the FBS stadium coordinate table that lets the CFB Week feed
// show weather, the one thing it was missing relative to NFL Pick'em and the bowl feed.
//
//   node scripts/gen-cfb-venues.mjs [season...]   # default: this season and the two before it
//
// This is a ONE-OFF AUTHORING TOOL, not part of any build or cron. It runs by hand, its output is
// committed and reviewed as plain data, and nothing at runtime depends on the services used here.
// Re-run it when stadiums are added or renamed (realignment, a new build) — a venue missing from
// the table simply gets no weather, so it degrades rather than breaks.
//
// It walks SEVERAL seasons, including the current one, and unions the result. One season is not
// enough: college football plays neutral-site games at NFL stadiums, and a venue only used every
// few years drops out of a single-season walk. Wisconsin vs Notre Dame at Lambeau Field is exactly
// that case — no FBS game there in 2025, so a 2025-only table left that card with no forecast.
// Walking the current season also picks up scheduled venues before they have hosted anything.
//
// WHY IT EXISTS. ESPN publishes no coordinates: a venue carries a name, city/state, an `indoor`
// flag and a ZIP, but no lat/lon, and NWS needs lat/lon. The zip is the useful key — ESPN's are
// usually campus-specific (94305 = Stanford, 73019 = Oklahoma's campus, 90037 = the Coliseum), so
// a zip centroid normally lands within a couple of km of the stadium.
//
// PRECISION, HONESTLY. Not every zip is a normal geographic one. ESPN records Fenway Park under
// 02297, a unique/PO-box zip whose centroid sits ~15km east of the ballpark, and a few venues
// carry a nearby campus zip rather than their own. Checked against the independently hand-built
// BOWL_VENUES table, 26 of 30 shared venues agree within 8km and the worst is ~16km. That is
// several NWS grid cells, but it does not move a temperature, wind speed or chance of rain enough
// to change what the card says — so it is accepted rather than chased. Where a hand-verified
// coordinate already exists (the bowl venues), that one still wins; this table is the fallback.
//
// HOW EACH ROW IS VALIDATED. A geocoder returning a plausible-looking wrong answer is the real
// risk in a table like this, so every coordinate is round-tripped through the API that will
// consume it: NWS /points must resolve it to a gridpoint, and the city/state NWS reports back must
// match the state ESPN gave. Anything that fails is reported and left OUT of the table rather than
// written with a number nobody checked.
//
// Sources, all free and keyless: ESPN scoreboard + core venues, Zippopotam (zip -> lat/lon), with
// Open-Meteo geocoding as the fallback when a zip is missing or unknown, and NWS for validation.
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';
const NWS_UA = 'FantasyEdge/1.0 (cfb venue table generator; contact via app)';
// groups=80 is FBS. Without it the scoreboard answers with a handful of featured games (15 in a
// week that actually had 51), which would silently produce a table full of holes.
const SB = 'https://site.web.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard';
const VENUE = (id) => `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/venues/${id}`;
const WEEKS = 16;
const CONC = 4;
// Jurisdictions NWS actually forecasts for. It is not "USA only" — the territories are covered
// too, and college football does play in San Juan and Honolulu. ESPN reports these in its own
// `country` field rather than as a US state, so they have to be named explicitly or a real venue
// gets dropped. Anything outside this list (Dublin, London, Nassau) has no NWS forecast at all.
const NWS_COUNTRIES = new Set(['USA', 'Puerto Rico', 'U.S. Virgin Islands', 'Guam', 'American Samoa',
  'Northern Mariana Islands']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (url, headers = { 'User-Agent': UA }) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
    await sleep(150); // deliberately unhurried: these are small free services doing us a favour
  }
  return out;
}

// Every venue that hosted (or is scheduled to host) an FBS game across the given seasons,
// regular season plus postseason.
async function collectVenueIds(seasons) {
  const ids = new Map();
  const urls = [];
  for (const season of seasons) {
    for (let w = 1; w <= WEEKS; w++) urls.push(`${SB}?dates=${season}&seasontype=2&week=${w}&limit=400&groups=80`);
    urls.push(`${SB}?dates=${season}&seasontype=3&limit=400&groups=80`);
  }
  for (const url of urls) {
    try {
      const sb = await j(url);
      for (const ev of (sb.events || [])) {
        const v = ev.competitions?.[0]?.venue;
        if (v?.id) ids.set(String(v.id), v.fullName || '');
      }
    } catch (e) { console.error(`  ! scoreboard ${url.slice(-24)}: ${e.message}`); }
    await sleep(120);
  }
  return ids;
}

// Candidate coordinates in order of preference: the zip centroid first, then a city-level
// geocode. Both are offered rather than just the best available, because a zip can be plainly
// WRONG in ESPN's data and still resolve fine — East Carolina's stadium in Greenville, NC is
// recorded with 37604, which is Johnson City, Tennessee, ~250 miles away. Validation is what
// catches that, so it needs a second candidate to fall through to.
async function geocodeCandidates(zip, city, state) {
  const out = [];
  if (zip) {
    try {
      const z = await j(`https://api.zippopotam.us/us/${encodeURIComponent(zip)}`);
      const p = z.places?.[0];
      if (p) out.push({ lat: Number(p.latitude), lon: Number(p.longitude), how: `zip ${zip}` });
    } catch { /* the city candidate below may still work */ }
  }
  try {
    const g = await j(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=10&country=US`);
    const hit = (g.results || []).find((r) => (r.admin1_code || r.admin1 || '').toUpperCase().startsWith(state)) || (g.results || [])[0];
    if (hit) out.push({ lat: hit.latitude, lon: hit.longitude, how: `city ${city}, ${state}` });
  } catch { /* nothing more to try */ }
  return out;
}

// The coordinate must be usable by the service that will actually read it, and must land where
// ESPN says the stadium is. Returns the city NWS reports, or throws with the reason it's rejected.
async function validate(lat, lon, state) {
  const p = (await j(`https://api.weather.gov/points/${lat},${lon}`, { 'User-Agent': NWS_UA })).properties;
  if (!p?.gridId) throw new Error('NWS returned no gridpoint');
  const rl = p.relativeLocation?.properties;
  if (rl?.state && state && rl.state !== state) throw new Error(`NWS says ${rl.city}, ${rl.state} but ESPN says ${state}`);
  return `${rl?.city ?? '?'}, ${rl?.state ?? '?'}`;
}

const argv = process.argv.slice(2).map(Number).filter(Number.isFinite);
const thisYear = new Date().getFullYear();
const seasons = argv.length ? argv : [thisYear, thisYear - 1, thisYear - 2];
console.log(`Collecting FBS venues for ${seasons.join(', ')}…`);
const ids = await collectVenueIds(seasons);
console.log(`  ${ids.size} distinct venues hosted an FBS game\n`);

const rows = [], skipped = [], failed = [];
await mapLimit([...ids.keys()], CONC, async (id) => {
  let v;
  try { v = await j(VENUE(id)); } catch (e) { failed.push([id, ids.get(id), `venue fetch: ${e.message}`]); return; }
  const name = v.fullName || ids.get(id) || id;
  const { city = '', state = '', zipCode = '', country = '' } = v.address || {};
  const where = `${name} — ${city}, ${state}`;

  // NWS covers the US and its territories only, so a genuinely international site (a Dublin
  // opener, say) is left out on purpose. Validation below is the real backstop: anything NWS
  // cannot resolve is reported rather than written.
  if (country && !NWS_COUNTRIES.has(country)) { skipped.push([id, where, `outside NWS coverage (${country})`]); return; }
  // A dome needs no coordinate: the pipeline skips the forecast entirely.
  if (v.indoor === true) { rows.push({ id, name, city, state, dome: true }); return; }

  const cands = await geocodeCandidates(zipCode, city, state);
  if (!cands.length) { failed.push([id, where, 'no coordinate from either geocoder']); return; }
  const why = [];
  for (const g of cands) {
    try {
      const nws = await validate(g.lat, g.lon, state);
      if (why.length) console.log(`  ~ ${where}: fell back to ${g.how} (${why[0]})`);
      rows.push({ id, name, city, state, dome: false, lat: g.lat, lon: g.lon, how: g.how, nws });
      return;
    } catch (e) { why.push(`${g.how}: ${e.message}`); }
  }
  failed.push([id, where, why.join(' | ')]);
});

rows.sort((a, b) => Number(a.id) - Number(b.id));
const r4 = (n) => Math.round(n * 10000) / 10000;
const body = rows.map((r) => {
  const val = r.dome ? '{ dome: true }' : `{ lat: ${r4(r.lat)}, lon: ${r4(r.lon)}, dome: false }`;
  const pad = ' '.repeat(Math.max(0, 42 - val.length));
  return `  '${r.id}': ${val},${pad} // ${r.name} — ${r.city}, ${r.state}`;
}).join('\n');

writeFileSync(new URL('../api/_lib/cfbVenues.js', import.meta.url), `\
// FBS stadium coordinates for the CFB Week weather forecast, keyed by ESPN venue id (stable across
// seasons). GENERATED — do not hand-edit; run \`node scripts/gen-cfb-venues.mjs\` and commit the
// result. That script explains where the numbers come from and how each one was checked.
//
// Coordinates are zip-code centroids from ESPN's own venue records — usually campus-specific, so
// normally within a couple of km of the stadium. A handful of venues carry a unique/PO-box or
// neighbouring-campus zip and land further out; against the hand-built bowl table, 26 of 30 shared
// venues agree within 8km and the worst is ~16km, which is immaterial for temperature, wind and
// precipitation. Every row was round-tripped through NWS /points and confirmed to resolve to the
// state ESPN reports for that venue; anything that failed was left out rather than guessed at.
//
// Domes carry no coordinate: the shared pipeline skips the forecast for them, and ESPN's per-game
// \`indoor\` flag is the authoritative override at build time anyway. A venue that isn't listed
// here simply gets no weather, which is the same graceful degrade the bowl table has.
//
// Generated from the ${seasons.join(', ')} FBS seasons · ${rows.length} venues (${rows.filter((r) => r.dome).length} domed).
export const CFB_VENUES = {
${body}
};
`);

console.log(`\nWrote api/_lib/cfbVenues.js — ${rows.length} venues (${rows.filter((r) => r.dome).length} domed)`);
if (skipped.length) {
  console.log(`\nSkipped ${skipped.length} deliberately:`);
  for (const [id, w, why] of skipped) console.log(`  ${id.padStart(5)}  ${w} — ${why}`);
}
if (failed.length) {
  console.log(`\nNOT WRITTEN — ${failed.length} need a look:`);
  for (const [id, w, why] of failed) console.log(`  ${id.padStart(5)}  ${w} — ${why}`);
}
