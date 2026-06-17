// FantasyPros consensus draft-season projections for the NFL, scraped daily by the
// refresh cron and merged onto the cached NFL dataset so each draft card can show a
// player's projected stat line alongside last season's actuals.
//
// FantasyPros has no public API, so we parse the projections tables (one page per
// position). The markup is stable: every player row carries fp-player-name="..." and
// a trailing team abbreviation, followed by ordered numeric <td class="center"> cells
// whose meaning per position is fixed (see COLUMNS). DST rows are the team itself, so
// they carry no trailing abbr and are matched by team name instead.
//
// Failure-tolerant by design: a position page that fails to fetch/parse is skipped,
// and enrichNflProjections falls back to the last good scrape stored in KV so one bad
// run never wipes existing projections.
import { PROJECTIONS_KEY } from './kv.js';

const BASE = 'https://www.fantasypros.com/nfl/projections';
const UA = {
  'User-Agent': 'Mozilla/5.0 (compatible; FantasyEdge/1.0; +https://fantasy-edge-nine.vercel.app)',
};
const SCORING = 'PPR'; // matches the draft board's default (fp = PPR-anchored)

// Ordered labels for each position's center-cell values (last is always FPTS). Values
// are aligned to these from the RIGHT, so FPTS always lands even if a layout ever
// gains a leading column.
const COLUMNS = {
  QB: ['PaAtt', 'Cmp', 'PaYd', 'PaTD', 'INT', 'RuAtt', 'RuYd', 'RuTD', 'FL', 'FPTS'],
  RB: ['RuAtt', 'RuYd', 'RuTD', 'Rec', 'ReYd', 'ReTD', 'FL', 'FPTS'],
  WR: ['Rec', 'ReYd', 'ReTD', 'RuAtt', 'RuYd', 'RuTD', 'FL', 'FPTS'],
  TE: ['Rec', 'ReYd', 'ReTD', 'FL', 'FPTS'],
  K: ['FG', 'FGA', 'XP', 'FPTS'],
  DST: ['Sack', 'INT', 'FR', 'FF', 'TD', 'Safety', 'PA', 'YdsAgn', 'FPTS'],
};

// The compact, draft-relevant subset shown on each card (projected FPTS is shown
// separately as the headline number).
const DISPLAY = {
  QB: ['PaYd', 'PaTD', 'INT', 'RuYd', 'RuTD'],
  RB: ['RuYd', 'RuTD', 'Rec', 'ReYd', 'ReTD'],
  WR: ['Rec', 'ReYd', 'ReTD', 'RuYd'],
  TE: ['Rec', 'ReYd', 'ReTD'],
  K: ['FG', 'XP'],
  DST: ['Sack', 'INT', 'TD', 'PA'],
};

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
};
const round1 = (v) => Math.round(v * 10) / 10;

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

// Normalize a team-defense identity: strip the "D/ST"/"Defense" designator so
// FantasyPros's "Houston Texans" matches ESPN's "Houston Texans D/ST".
function teamKey(name) {
  return normName(String(name || '').replace(/d\/?st|defense|special teams/gi, ''));
}

// Index key a player record matches on: name+pos for skill, team identity for DST.
// Exported so the ADP enricher matches players against the dataset identically.
export function keyFor(pos, name) {
  return pos === 'DST' ? `DST|${teamKey(name)}` : `${pos}|${normName(name)}`;
}

// Parse one position page into [{ name, team, pos, fpts, stats:{label:val} }].
function parsePage(html, pos) {
  const t = html.indexOf('id="data"');
  if (t < 0) return [];
  const tbodyStart = html.indexOf('<tbody', t);
  const tbodyEnd = html.indexOf('</tbody>', tbodyStart);
  if (tbodyStart < 0 || tbodyEnd < 0) return [];
  const body = html.slice(tbodyStart, tbodyEnd);
  const labels = COLUMNS[pos] || [];
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(body))) {
    const row = m[1];
    const name =
      (row.match(/fp-player-name="([^"]+)"/) || [])[1] ||
      (row.match(/class="player-name[^"]*"[^>]*>([^<]+)/) || [])[1];
    if (!name) continue;
    const team = pos === 'DST' ? null : (row.match(/<\/a>\s*([A-Za-z]{2,4})\s*<\/td>/) || [])[1] || null;
    const vals = [...row.matchAll(/<td[^>]*class="center"[^>]*>\s*([\d.,\-]+)/g)].map((x) => num(x[1]));
    if (!vals.length) continue;
    // Align values to labels from the right so FPTS (the last label) always lines up.
    const stats = {};
    for (let i = 1; i <= labels.length && i <= vals.length; i++) {
      stats[labels[labels.length - i]] = vals[vals.length - i];
    }
    rows.push({ name: name.trim(), team, pos, fpts: stats.FPTS ?? vals[vals.length - 1], stats });
  }
  return rows;
}

// Scrape every position page. Returns { builtAt, scoring, players: [...] }; positions
// that fail are simply absent.
export async function scrapeFantasyProjections() {
  const positions = ['qb', 'rb', 'wr', 'te', 'k', 'dst'];
  const players = [];
  for (const p of positions) {
    try {
      const res = await fetch(`${BASE}/${p}.php?scoring=${SCORING}&week=draft`, { headers: UA });
      if (!res.ok) continue;
      const html = await res.text();
      players.push(...parsePage(html, p.toUpperCase()));
    } catch {
      /* skip this position */
    }
  }
  return { builtAt: new Date().toISOString(), scoring: SCORING, players };
}

// Scrape FantasyPros and attach a `proj` object to each matching NFL dataset player.
// Stores the raw scrape in KV (PROJECTIONS_KEY) and reuses the last good one if this
// run scrapes nothing. Mutates dataset in place; additive and failure-tolerant.
export async function enrichNflProjections(dataset, redis) {
  if (!dataset?.players?.length) return;

  let scrape = await scrapeFantasyProjections();
  if (scrape.players.length) {
    await redis.set(PROJECTIONS_KEY, scrape);
  } else {
    const cached = await redis.get(PROJECTIONS_KEY);
    if (cached?.players?.length) scrape = cached;
  }
  if (!scrape.players?.length) return;

  // First projection per key wins (rows are ranked best-first, so this keeps the
  // starter when a name collides).
  const byKey = new Map();
  for (const r of scrape.players) {
    const k = keyFor(r.pos, r.name);
    if (!byKey.has(k)) byKey.set(k, r);
  }

  let matched = 0;
  for (const pl of dataset.players) {
    const r = byKey.get(keyFor(pl.pos, pl.name));
    if (!r) continue;
    const line = (DISPLAY[pl.pos] || [])
      .map((label) => ({ label, val: r.stats[label] }))
      .filter((s) => s.val != null);
    pl.proj = { fpts: round1(r.fpts || 0), line, scoring: scrape.scoring };
    matched++;
  }

  dataset.counts = {
    ...dataset.counts,
    projections: { matched, scraped: scrape.players.length, builtAt: scrape.builtAt },
  };
}
