// Live grounding for the AI Coach. Before each reply we look at the user's latest
// message, figure out which sport(s) and player(s) it's about, pull those players'
// CURRENT data from the same Vercel KV datasets the rankings tab serves
// (dataset:<sport>, built daily by the cron), and hand it to Claude as the source of
// truth — so answers reflect today's rank, form (HOT/COLD), and stats instead of only
// training-data recall. Entirely failure-tolerant: any error yields '' and the coach
// falls back to its base behavior.
import { redis, DATASET_KEY, NBA_DATASET_KEY, WNBA_DATASET_KEY, NHL_DATASET_KEY, NFL_DATASET_KEY, PGA_DATASET_KEY } from './kv.js';

const KEYS = {
  nfl: NFL_DATASET_KEY,
  mlb: DATASET_KEY,
  nba: NBA_DATASET_KEY,
  wnba: WNBA_DATASET_KEY,
  nhl: NHL_DATASET_KEY,
  pga: PGA_DATASET_KEY,
};
const ALL_SPORTS = ['nfl', 'mlb', 'nba', 'wnba', 'nhl', 'pga'];

// Keyword hints that pin a question to a sport even when no player is named
// ("best waiver pickup in PPR?"). Kept specific to avoid mis-detecting a sport.
const SPORT_HINTS = {
  nfl: ['nfl', 'football', 'qb', 'rb', 'wr', 'te', 'quarterback', 'running back', 'wide receiver', 'tight end', 'ppr', 'superflex'],
  mlb: ['mlb', 'baseball', 'pitcher', 'hitter', 'era', 'whip', 'rbi', 'closer', 'saves', 'strikeouts'],
  nba: ['nba', 'basketball'],
  wnba: ['wnba'],
  nhl: ['nhl', 'hockey', 'goalie', 'puck', 'power play'],
  pga: ['pga', 'golf', 'golfer', 'owgr', 'masters', 'fairway', 'the open', 'us open'],
};

const MAX_PLAYERS = 8;       // matched players to attach
const TOP_N = 10;            // leaderboard rows per keyword-detected sport
const CACHE_TTL = 5 * 60_000; // reuse a fetched dataset for 5 min on a warm instance

const _cache = new Map(); // sport -> { data, at }

function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadDataset(sport) {
  const hit = _cache.get(sport);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
  let data = null;
  try {
    const key = KEYS[sport];
    if (key) data = await redis.get(key);
  } catch {
    data = null;
  }
  _cache.set(sport, { data, at: Date.now() });
  return data;
}

// Phrasing that signals the user thinks they're proposing a trade.
const TRADE_RE = /\b(trade|traded|trading|swap|swapping|deal|deals|dealing)\b/;
const isTradeQuery = (text) => TRADE_RE.test(normalize(text));

function detectSports(text) {
  const m = ' ' + normalize(text) + ' ';
  const out = [];
  for (const [sport, hints] of Object.entries(SPORT_HINTS)) {
    if (hints.some((h) => m.includes(' ' + h + ' '))) out.push(sport);
  }
  return out;
}

// Find players named in the text across the loaded datasets. Full-name matches are
// kept unconditionally; last-name-only matches are kept only for ranked players or
// notable prospects, which filters out the long tail of search-only names that happen
// to collide with a common word.
//
// Generational suffixes (Sr/Jr/II/III/IV/V) are dropped before matching so a natural "Kyle Pitts"
// question still finds "Kyle Pitts Sr." — otherwise the full name never appears in the query and the
// last token is the two-letter suffix, so both match paths miss. Matching on the suffix-stripped base
// still works when the user DOES include the suffix (the base is a prefix of the full name).
const NAME_SUFFIXES = new Set(['sr', 'jr', 'ii', 'iii', 'iv', 'v']);
function baseName(nn) {
  const parts = nn.split(' ');
  if (parts.length > 1 && NAME_SUFFIXES.has(parts[parts.length - 1])) parts.pop();
  return parts.join(' ');
}
function matchPlayers(text, datasets) {
  const m = ' ' + normalize(text) + ' ';
  const seen = new Set();
  const matches = [];
  for (const { sport, data } of datasets) {
    for (const p of data.players || []) {
      const nn = normalize(p.name);
      if (!nn) continue;
      const base = baseName(nn); // drop a trailing Sr/Jr/II+ so "Kyle Pitts" matches "Kyle Pitts Sr."
      const full = m.includes(' ' + base + ' ');
      let hit = full;
      if (!hit) {
        const last = base.split(' ').pop();
        if (last.length >= 4 && m.includes(' ' + last + ' ') && (p.rank != null || p.fv != null)) hit = true;
      }
      if (!hit) continue;
      const dedupe = sport + '|' + nn;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      matches.push({ p, sport, full });
    }
  }
  // Full-name matches first, then by best (lowest) rank; unranked last.
  matches.sort((a, b) => {
    if (a.full !== b.full) return a.full ? -1 : 1;
    return (a.p.rank ?? 1e9) - (b.p.rank ?? 1e9);
  });
  return matches.slice(0, MAX_PLAYERS);
}

const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return 'today'; }
};

// One compact, human-readable line of a player's current FantasyEdge data.
function playerLine(p, sport) {
  const stats = (p.statLabels || [])
    .map((l, i) => { const v = p['s' + (i + 1)]; return v != null && v !== '—' ? `${l} ${v}` : null; })
    .filter(Boolean)
    .join(', ');
  const where = [p.pos, p.team].filter((x) => x && x !== '—').join(', ');
  const bits = [`${p.name}${where ? ` (${where})` : ''}`, `${sport.toUpperCase()} rank #${p.rank ?? '—'}`];
  if (stats) bits.push(stats);
  if (p.tag === 'hot') bits.push('HOT' + (p.trendVal ? ` (${p.trendVal})` : ''));
  else if (p.tag === 'cold') bits.push('COLD' + (p.trendVal ? ` (${p.trendVal})` : ''));
  // ADP is a scalar for most sports but an object { ppr, standard, half } for NFL — show the PPR figure
  // (board default) rather than "[object Object]".
  const adpVal = p.adp && typeof p.adp === 'object' ? (p.adp.ppr ?? p.adp.standard ?? p.adp.half) : p.adp;
  if (adpVal != null) bits.push(`ADP ${adpVal}`);
  // Depth signals (NFL enrichment; present only for rosterable skill players, ~top 150) — weekly floor
  // vs. upside, season projection, and opportunity, so the Coach cites real numbers instead of guessing.
  if (p.consistency != null) bits.push(`consistency ${p.consistency}/100 (weekly floor, higher = steadier)`);
  if (p.ceiling != null) bits.push(`~${Math.round(p.ceiling)}-pt weekly ceiling`);
  if (p.proj?.fpts != null) bits.push(`2026 projection ${Math.round(p.proj.fpts)} pts`);
  if (p.opportunity?.label) bits.push(p.opportunity.label);
  if (p.fv != null) bits.push(`prospect FV ${p.fv}`);
  if (p.synopsis) bits.push(`scouting note: ${p.synopsis}`);
  return '- ' + bits.join(' — ');
}

const HEADER =
  'LIVE FANTASYEDGE DATA — treat the player data below as the current source of truth for rankings, recent form, and status; it reflects today\'s real data and overrides your training knowledge wherever they differ. Use it naturally in your answer; do NOT mention that data was provided to you or refer to your "training data". If the user asks about a player who is not listed below, say you don\'t have live data on them right now and answer from general knowledge with that caveat. The "FPTS" figure is our blended ranking value (projection + recent actuals) and each player\'s rank reflects it — rank and compare players by FPTS/rank, not by the separate "2026 projection" figure, which is only one input to that blend.';

// Assemble the context block from already-loaded datasets ([{ sport, data }]). Pure
// (no KV) so it can be unit-tested directly. Returns '' when there's nothing relevant
// to attach (a general question with no player or sport).
export function buildContextFromDatasets(text, datasets) {
  const detected = detectSports(text);
  const matched = matchPlayers(text, datasets);

  // A general question with no player and no sport keyword: nothing useful to ground on.
  if (!matched.length && !detected.length) return '';

  const out = [HEADER];

  if (matched.length) {
    out.push('', 'Players the user is asking about (current data):');
    for (const { p, sport } of matched) out.push(playerLine(p, sport));
  }

  // Golf has no trades: if the user framed a golfer question as a trade, tell the
  // coach to reframe it as a who-to-pick / more-value-this-week decision.
  if (matched.some((m) => m.sport === 'pga') && isTradeQuery(text)) {
    out.push('', 'REFRAME: This is phrased as a "trade", but the player(s) above are golfers and golf (PGA) has no trades. Answer it as a who-to-pick / who-has-more-value-this-week decision for the user\'s DFS lineup or golf pool — compare the golfers above and tell them who to roster this week, not how to weigh a roster trade.');
  }

  // For a clearly sport-scoped question, attach a current top-N so ranking/waiver
  // questions are grounded even when no specific player was named. Capped to the
  // first couple of detected sports to keep the prompt bounded.
  for (const s of detected.slice(0, 2)) {
    const d = datasets.find((x) => x.sport === s);
    if (!d) continue;
    const top = (d.data.players || [])
      .filter((p) => !p.searchOnly && p.rank != null && !p.twoWay) // skip two-way pitcher clones (list a player once)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, TOP_N);
    if (!top.length) continue;
    out.push('', `Current top ${s.toUpperCase()} by FantasyEdge rank (as of ${fmtDate(d.data.builtAt)}):`);
    for (const p of top) out.push(playerLine(p, s));
  }

  return out.join('\n');
}

// Build the live-data context block for the latest user turn: load the relevant
// dataset(s) from KV (sports named in the message, else all), then delegate to the
// pure assembler. Returns '' on no match.
export async function buildLiveContext(messages) {
  const lastUser = [...(messages || [])].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
  if (!lastUser) return '';
  const text = lastUser.content;

  const detected = detectSports(text);
  const toLoad = detected.length ? detected : ALL_SPORTS;

  const datasets = [];
  for (const s of toLoad) {
    const d = await loadDataset(s);
    if (d && Array.isArray(d.players) && d.players.length) datasets.push({ sport: s, data: d });
  }
  if (!datasets.length) return '';

  return buildContextFromDatasets(text, datasets);
}
