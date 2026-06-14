// FanGraphs "THE BOARD" prospect-list (Phase 2 ranking source).
//
// IMPORTANT — Cloudflare: FanGraphs sits behind a Cloudflare JS challenge that
// reliably 403s server-side requests (Node fetch AND curl from a datacenter IP),
// so we CANNOT depend on fetching it from the Vercel cron. Instead the cron reads
// a committed board snapshot (prospect-board.json) — the ranking list is slow-
// moving (FanGraphs revises it a few times a year), so a periodically-refreshed
// snapshot is the right granularity. The live fetch is kept only as an
// opportunistic refresher: if it ever succeeds, we use the fresher data.
//
// To refresh the snapshot: open the board in a browser (it loads fine client-
// side — Cloudflare only challenges servers), run the console snippet in
// scripts/refresh-board.md, and replace prospect-board.json.
//
// Each record carries FanGraphs ids (NOT MLBAM) plus the ranking fields we need:
// Position (separates hitters from pitchers), FV_Current, and Org_Rank. The
// FanGraphs id is bridged to MLBAM downstream (see crosswalk.js).

import { readFileSync } from 'fs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Positions on the board that are hitters; the pitcher set is SP / SIRP / MIRP.
// TWP (two-way) is treated as a hitter so a player is never tracked twice.
const HITTER_POS = new Set(['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH', 'UTIL', 'TWP']);
const PITCHER_POS = new Set(['SP', 'SIRP', 'MIRP', 'RP', 'P']);

function parseBoard(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('FanGraphs: __NEXT_DATA__ not found');
  const data = JSON.parse(m[1]);
  const queries = data?.props?.pageProps?.dehydratedState?.queries || [];
  // The board list is the first query whose data is a large array of player rows.
  for (const q of queries) {
    const arr = q?.state?.data;
    if (Array.isArray(arr) && arr.length > 100 && arr[0] && 'Org_Rank' in arr[0]) {
      return arr;
    }
  }
  throw new Error('FanGraphs: prospect list not found in page data');
}

// Returns { hitters: [...], pitchers: [...] } where each row is
// { fgId, fgIdRaw, name, org, pos, fv, orgRank, bats, throws, eta }. fgId is the
// numeric FanGraphs PlayerId when present (used by the Chadwick crosswalk);
// fgIdRaw keeps the original (may be an "sa…" minor id that won't crosswalk and
// falls through to name-matching). Hitters carry bats; pitchers carry throws.
export async function fetchBoard({ season = new Date().getFullYear() } = {}) {
  // Prefer the current-year list; fall back to the prior year early in the season
  // before the new board is published.
  const slugs = [`${season}-prospect-list`, `${season - 1}-prospect-list`];
  let rows = null;
  let usedSlug = null;
  let lastErr = null;
  for (const slug of slugs) {
    try {
      const url = `https://www.fangraphs.com/prospects/the-board/${slug}/summary`;
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      rows = parseBoard(html);
      usedSlug = slug;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!rows) throw new Error(`FanGraphs board fetch failed: ${lastErr?.message || 'unknown'}`);

  const hitters = [];
  const pitchers = [];
  for (const r of rows) {
    const pos = r.Position || r.pos;
    const isHitter = HITTER_POS.has(pos);
    const isPitcher = !isHitter && PITCHER_POS.has(pos);
    if (!isHitter && !isPitcher) continue;
    const raw = r.PlayerId ?? r.UPID ?? r.ID;
    const numeric = /^\d+$/.test(String(raw)) ? String(raw) : null;
    const row = {
      fgId: numeric, // null when only an "sa…" id exists → name-match fallback
      fgIdRaw: String(raw),
      name: r.playerName || `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
      org: r.Team || r.cORG || '—',
      pos,
      fv: r.FV_Current ?? (r.cFV != null ? Number(r.cFV) : null),
      orgRank: r.Org_Rank ?? r.Org_Rk ?? null,
      bats: r.Bats || null,
      throws: r.Throws || null,
      eta: r.ETA_Current ?? r.cETA ?? null,
    };
    (isHitter ? hitters : pitchers).push(row);
  }
  return { hitters, pitchers, slug: usedSlug, fetchedAt: new Date().toISOString() };
}

// The committed snapshot, used when the live fetch is blocked (the normal case).
export function loadBoardSnapshot() {
  try {
    const json = JSON.parse(readFileSync(new URL('./prospect-board.json', import.meta.url), 'utf8'));
    return {
      hitters: json.hitters || [],
      pitchers: json.pitchers || [], // absent in pre-Phase-3 snapshots → no pitchers tracked
      slug: 'snapshot',
      fetchedAt: json._meta?.capturedAt || null,
      snapshot: true,
    };
  } catch {
    return { hitters: [], pitchers: [], slug: 'snapshot', fetchedAt: null, snapshot: true };
  }
}

// Primary loader: try the live board, fall back to the committed snapshot.
// Returns { hitters, slug, fetchedAt, snapshot, live }. `snapshot:true` means the
// list came from the committed file (the expected path on Vercel).
export async function loadBoard({ season = new Date().getFullYear() } = {}) {
  try {
    const live = await fetchBoard({ season });
    if (live.hitters.length) return { ...live, snapshot: false, live: true };
  } catch {
    /* fall through to snapshot */
  }
  return { ...loadBoardSnapshot(), live: false };
}

// Top-N prospects per org, ordered by Org_Rank ascending (1 = best). Rows
// missing an Org_Rank sort to the back. Org_Rank is shared across the whole
// system (hitters and pitchers interleave), so each pool gets its own top-N.
function topByOrg(rows, n) {
  const byOrg = new Map();
  for (const h of rows) {
    if (!byOrg.has(h.org)) byOrg.set(h.org, []);
    byOrg.get(h.org).push(h);
  }
  const out = [];
  for (const list of byOrg.values()) {
    list.sort((a, b) => (a.orgRank ?? 1e9) - (b.orgRank ?? 1e9));
    out.push(...list.slice(0, n));
  }
  return out;
}

export const topHittersByOrg = (hitters, n = 10) => topByOrg(hitters, n);
export const topPitchersByOrg = (pitchers, n = 10) => topByOrg(pitchers, n);
