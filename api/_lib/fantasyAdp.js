// FantasyPros consensus ADP (average draft position) for the NFL, scraped daily and
// merged onto the cached NFL dataset. Drives realistic mock-draft opponents (they pick
// near where real managers do) and the "falling past ADP" value boost in the
// recommendation engine.
//
// FantasyPros publishes ADP per SCORING format (PPR / Standard) but NOT per league
// size — the ?teams= param is ignored — so we store both formats and let league size
// drive only the draft mechanics. The overall ADP page covers skill players
// (QB/RB/WR/TE); K/DST are absent, which is fine: they have no meaningful early ADP,
// opponents defer them via a rank fallback, and the engine drafts them late anyway.
//
// Failure-tolerant: a format that fails to scrape is skipped, and enrichNflAdp falls
// back to the last good scrape in KV so one bad run never drops ADP.
import { ADP_KEY } from './kv.js';
import { keyFor } from './fantasyProjections.js';

const BASE = 'https://www.fantasypros.com/nfl/adp';
const UA = {
  'User-Agent': 'Mozilla/5.0 (compatible; FantasyEdge/1.0; +https://fantasy-edge-nine.vercel.app)',
};
// The overall consensus ADP page per scoring format.
const PAGES = { ppr: 'ppr-overall.php', standard: 'overall.php' };

const round1 = (v) => Math.round(v * 10) / 10;

// Parse one ADP page into [{ name, team, pos, adp }]. A row's plain <td> cells are
// [rank, POS+posrank, AVG]; the player cell carries a class, so the no-attribute <td>
// match skips it. ADP is the last numeric cell.
function parsePage(html) {
  const t = html.indexOf('id="data"');
  if (t < 0) return [];
  const s = html.indexOf('<tbody', t);
  const e = html.indexOf('</tbody>', s);
  if (s < 0 || e < 0) return [];
  const body = html.slice(s, e);
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(body))) {
    const row = m[1];
    const name =
      (row.match(/fp-player-name="([^"]+)"/) || [])[1] ||
      (row.match(/class="player-name[^"]*"[^>]*>([^<]+)/) || [])[1];
    if (!name) continue;
    const team = (row.match(/<small>\s*([A-Za-z]{2,4})\s*<\/small>/) || [])[1] || null;
    const plain = [...row.matchAll(/<td>\s*([^<]+?)\s*<\/td>/g)].map((x) => x[1]);
    if (plain.length < 2) continue;
    const pos = (plain.find((c) => /[A-Za-z]/.test(c)) || '').match(/[A-Za-z]+/)?.[0];
    const adp = parseFloat(String(plain[plain.length - 1]).replace(/,/g, ''));
    if (!pos || !isFinite(adp)) continue;
    out.push({ name: name.trim(), team, pos: pos.toUpperCase(), adp: round1(adp) });
  }
  return out;
}

// Scrape both scoring formats. Returns { builtAt, ppr:[...], standard:[...] }.
export async function scrapeFantasyAdp() {
  const result = { builtAt: new Date().toISOString() };
  for (const [scoring, page] of Object.entries(PAGES)) {
    try {
      const res = await fetch(`${BASE}/${page}`, { headers: UA });
      result[scoring] = res.ok ? parsePage(await res.text()) : [];
    } catch {
      result[scoring] = [];
    }
  }
  return result;
}

const totalRows = (s) => (s?.ppr?.length || 0) + (s?.standard?.length || 0);

// Scrape ADP and attach `adp: { ppr, standard }` to each matching NFL player. Stores
// the raw scrape in KV; reuses the last good one if this run scraped nothing. Mutates
// dataset in place; additive and failure-tolerant.
export async function enrichNflAdp(dataset, redis) {
  if (!dataset?.players?.length) return;

  let scrape = await scrapeFantasyAdp();
  if (totalRows(scrape)) {
    await redis.set(ADP_KEY, scrape);
  } else {
    const cached = await redis.get(ADP_KEY);
    if (totalRows(cached)) scrape = cached;
  }
  if (!totalRows(scrape)) return;

  // First ADP per key wins (rows are ranked best-first).
  const index = (rows) => {
    const map = new Map();
    for (const r of rows || []) {
      const k = keyFor(r.pos, r.name);
      if (!map.has(k)) map.set(k, r.adp);
    }
    return map;
  };
  const pprMap = index(scrape.ppr);
  const stdMap = index(scrape.standard);

  let matched = 0;
  for (const pl of dataset.players) {
    const k = keyFor(pl.pos, pl.name);
    const ppr = pprMap.get(k);
    const standard = stdMap.get(k);
    if (ppr == null && standard == null) continue;
    pl.adp = { ppr: ppr ?? null, standard: standard ?? null };
    matched++;
  }

  dataset.counts = {
    ...dataset.counts,
    adp: {
      matched,
      ppr: scrape.ppr?.length || 0,
      standard: scrape.standard?.length || 0,
      builtAt: scrape.builtAt,
    },
  };
}
