// Free golf data sources for the PGA tab (no key required):
//   • OWGR official API  -> world ranking, country, ranking-points average
//   • ESPN golf scoreboard -> the current tournament + live field/positions, and
//     (via ?dates=YYYYMMDD) any past week's FINAL leaderboard, which we use to build
//     recent finishing form across the last several events.
//
// Names are the only join key across OWGR and ESPN, so everything is matched on a
// normalized name (see normName). See pga-rankings-build memory for endpoint shapes.

import { getJson } from './espn.js';

const OWGR_API = 'https://apiweb.owgr.com/api/owgr/rankings/getRankings';
const ESPN_SB = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

// Normalize a player name for cross-source matching: lowercase, strip accents,
// drop punctuation and common suffixes, collapse whitespace.
export function normName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// OWGR top-N: [{ rank, name, country, pointsAvg }]. One page; pageSize covers it.
export async function fetchOwgr(limit = 300) {
  const url = `${OWGR_API}?regionId=0&pageSize=${limit}&pageNumber=1&countryId=0&sortString=rank+asc`;
  const j = await getJson(url);
  const list = j.rankingsList || [];
  return list.map((r) => ({
    rank: r.rank,
    name: r.player?.fullName || `${r.player?.firstName || ''} ${r.player?.lastName || ''}`.trim(),
    country: r.player?.country?.code3 || null,
    pointsAvg: r.pointsAverage != null ? Number(r.pointsAverage) : null,
  })).filter((p) => p.name);
}

export async function fetchScoreboard(dates) {
  return getJson(dates ? `${ESPN_SB}?dates=${dates}` : ESPN_SB);
}

// Pick this week's tournament: prefer an in-progress event, else the soonest
// upcoming, else the most recent. Returns the raw ESPN event or null.
export function pickCurrentEvent(sb) {
  const evs = sb?.events || [];
  if (!evs.length) return null;
  const live = evs.find((e) => /in_progress|halftime|rain|suspended/i.test(e.status?.type?.name || ''));
  if (live) return live;
  const pre = evs.find((e) => /scheduled|pre/i.test(e.status?.type?.name || ''));
  return pre || evs[evs.length - 1];
}

// Extract a simple field map from a scoreboard event: normName -> { pos, score }.
// `order` is the finishing/leaderboard position (1 = leader/winner). For a FINAL
// event this is the final finish; for a live event it's the current position.
export function fieldFromEvent(ev) {
  const out = new Map();
  const comp = ev?.competitions?.[0];
  for (const c of comp?.competitors || []) {
    const name = c.athlete?.displayName || c.athlete?.fullName;
    if (!name) continue;
    out.set(normName(name), { pos: c.order ?? null, score: c.score ?? null });
  }
  return out;
}

// YYYYMMDD for the ESPN ?dates= param, from an ISO date string.
function ymd(iso) {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The N most-recently-completed events from the scoreboard calendar (each with an
// id + a date inside its window we can re-query). Excludes the current/future ones.
export function recentCompletedEvents(sb, n = 6) {
  const cal = sb?.leagues?.[0]?.calendar || [];
  const now = Date.now();
  const done = cal
    .filter((c) => c.endDate && new Date(c.endDate).getTime() < now)
    .sort((a, b) => new Date(b.endDate) - new Date(a.endDate))
    .slice(0, n);
  // Query each by a date inside its window (startDate resolves the FINAL board once over).
  return done.map((c) => ({ id: c.id, label: c.label, dates: ymd(c.startDate || c.endDate) }));
}

// Build recent finishing form: normName -> { finishes: [pos...] (newest first),
// avg, recent, prev, trend }. Pulls each recent event's FINAL leaderboard (≈N
// fetches total, not per-player). Failure-tolerant per event.
export async function buildRecentForm(sb, n = 6) {
  const events = recentCompletedEvents(sb, n);
  // Accumulate finishes per player, preserving event recency order.
  const byPlayer = new Map(); // normName -> [{order, idx}]
  for (let idx = 0; idx < events.length; idx++) {
    try {
      const board = await fetchScoreboard(events[idx].dates);
      // The dates query can return multiple events that week (opposite-field). Match
      // the one we asked for by id so finishes aren't mixed across tournaments.
      const ev = (board.events || []).find((e) => e.id === events[idx].id) || board.events?.[0];
      if (!ev) continue;
      for (const [nm, info] of fieldFromEvent(ev)) {
        if (info.pos == null) continue;
        if (!byPlayer.has(nm)) byPlayer.set(nm, []);
        byPlayer.get(nm).push({ order: info.pos, idx });
      }
    } catch {
      /* one missing event just shrinks the sample */
    }
  }

  const form = new Map();
  for (const [nm, arr] of byPlayer) {
    arr.sort((a, b) => a.idx - b.idx); // newest first (idx 0 = most recent event)
    const finishes = arr.map((x) => x.order);
    const avg = finishes.reduce((s, x) => s + x, 0) / finishes.length;
    const half = Math.max(1, Math.floor(finishes.length / 2));
    const recent = finishes.slice(0, half).reduce((s, x) => s + x, 0) / half;
    const prevArr = finishes.slice(half);
    const prev = prevArr.length ? prevArr.reduce((s, x) => s + x, 0) / prevArr.length : null;
    // Trend: lower finish = better, so recent < prev means improving (hot).
    let trend = 'flat';
    if (prev != null && finishes.length >= 3) {
      if (recent <= prev * 0.6) trend = 'up';
      else if (recent >= prev * 1.6) trend = 'down';
    }
    form.set(nm, { finishes, avg, recent, prev, trend });
  }
  return form;
}
