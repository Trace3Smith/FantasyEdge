// Rolling last-15 / last-30 team-game splits for the MLB board. Each ranked player gets
// a `rolling` record per window holding his production over that stretch, alongside `tg`
// — how many games his TEAM played in the same window — so the gap between `g` and `tg`
// is the playing-time signal (a bench bat reads 6 of 15; an everyday guy reads 15 of 15).
//
// WHY DATE RANGES, NOT lastXGames. The MLB Stats API offers both, and they answer
// different questions:
//   • stats=lastXGames&gamesBack=15 returns each player's last 15 APPEARANCES, so every
//     player comes back with gamesPlayed=15 exactly. It normalises playing time away —
//     a part-timer's "last 15" can span two months. Useless for spotting a benching.
//   • stats=byDateRange returns whatever a player did in a real window, so gamesPlayed
//     varies (1..24 over 30 days). That variance is the whole point here.
// So we take a date window and record the team-game denominator ourselves.
//
// FIXED-COUNT WINDOWS. The window is each team's OWN last-N games by COUNT (its Nth-most-recent
// game date onward), so the denominator is exactly N — not a shared calendar range where an off
// day made it read "14 of 14". byDateRange takes ONE start date per call, so we group teams by
// their Nth-game date and issue one call per distinct date; teams that share a date share a call.
//
// COST. One schedule call, then one byDateRange per (window x distinct team-start x group). Teams
// bunch onto a few distinct Nth-game dates (typically ~4-6 per window), so this is ~15-24 calls, not
// one per team and not one per player. `limit` above the split count returns everything in a single
// response, and `playerPool=ALL` is load-bearing: the default silently returns only qualified
// batters (~148 of ~500). Calls are concurrency-capped so ~20 parallel requests don't trip limits.
//
// Gating and failure behaviour follow enrichForm: no-op out of season (no fetches at
// all), and the caller treats a throw as non-fatal, leaving the board unenriched.

import { getJson } from './espn.js';
import { gameValueMlb } from './enrichForm.js';

const API = 'https://statsapi.mlb.com/api/v1';
const FULL_SEASON = 162;
const WINDOWS = { l15: 15, l30: 30 }; // measured in TEAM games, not player appearances
// 30 team games is ~35 days; off days, the All-Star break and rainouts stretch that, so
// look back far enough that the 30th-most-recent game is always inside the range.
const LOOKBACK_DAYS = 60;

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const r1 = (v) => Math.round(v * 10) / 10;
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };

// teamId -> ['YYYY-MM-DD', ...] of completed regular-season games, newest first.
// Doubleheaders legitimately repeat a date; they are two games and count twice.
async function teamGameDates(start, end) {
  const j = await getJson(`${API}/schedule?sportId=1&gameType=R&startDate=${start}&endDate=${end}`);
  const byTeam = new Map();
  for (const d of j.dates || []) {
    for (const g of d.games || []) {
      if (g.status?.detailedState !== 'Final') continue;
      for (const side of ['home', 'away']) {
        const id = g.teams?.[side]?.team?.id;
        if (id == null) continue;
        if (!byTeam.has(id)) byTeam.set(id, []);
        byTeam.get(id).push(d.date);
      }
    }
  }
  for (const arr of byTeam.values()) arr.sort().reverse();
  return byTeam;
}

// Representative window start for the card's date SUBTITLE only (the real per-team windows are
// fixed-count below). The median team's Nth-most-recent game date gives a sensible "roughly the
// last-N-game window" range without implying one shared boundary.
function windowStart(byTeam, n) {
  const dates = [];
  for (const arr of byTeam.values()) {
    const d = arr[Math.min(n, arr.length) - 1];
    if (d) dates.push(d);
  }
  if (!dates.length) return null;
  dates.sort();
  return dates[Math.floor(dates.length / 2)];
}

// Bounded-concurrency map, so grouping teams into ~20 byDateRange calls doesn't fire them all at once.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

async function windowSplits(group, start, end, season) {
  const url = `${API}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1`
    + `&startDate=${start}&endDate=${end}&playerPool=ALL&limit=2000`;
  const j = await getJson(url);
  return j.stats?.[0]?.splits || [];
}

// Trimmed to what the rolling card + the board's windowed (L15/L30) columns show — the full split
// carries 34 stat fields, and every byte here is multiplied by ~900 players inside the cached dataset.
// obp (hitters) and hd/holds (pitchers) are carried so the windowed board columns match the season set
// exactly (OBP and HD have no other rolling source).
function hitLine(s, tg) {
  return {
    g: num(s.gamesPlayed), tg,
    avg: s.avg ?? null, obp: s.obp ?? null, ops: s.ops ?? null,
    hr: num(s.homeRuns), rbi: num(s.rbi), r: num(s.runs), sb: num(s.stolenBases),
    val: r1(gameValueMlb('OF', s)), // window total on the HOT/COLD scale
  };
}
function pitchLine(s, tg) {
  return {
    g: num(s.gamesPlayed), tg,
    ip: s.inningsPitched ?? null, era: s.era ?? null, whip: s.whip ?? null,
    k: num(s.strikeOuts), w: num(s.wins), sv: num(s.saves), hd: num(s.holds),
    val: r1(gameValueMlb('SP', s)),
  };
}

// Mutates dataset.players: sets `rolling: { l15, l30 }` on players with production in
// each window. Players with no appearances in a window simply have no entry for it —
// absence is meaningful (didn't play), and skipping them keeps the payload down.
export async function enrichRolling(dataset, { season }) {
  if (!Array.isArray(dataset.players)) return;

  // Out of season the dataset holds the last completed season, where a "recent form"
  // window is stale by definition. Same gate as enrichForm, and it costs zero requests.
  const teamGames = dataset.counts?.teamGames;
  if (teamGames == null || teamGames >= FULL_SEASON) {
    dataset.counts = { ...dataset.counts, rollingActive: false };
    return;
  }

  const end = iso(new Date());
  const byTeam = await teamGameDates(daysAgo(LOOKBACK_DAYS), end);
  if (!byTeam.size) {
    dataset.counts = { ...dataset.counts, rollingActive: false, rollingError: 'no completed games in lookback' };
    return;
  }

  // Per-team fixed-COUNT windows: each team's OWN last-N completed games. boundaryByTeam is the date
  // of a team's Nth-most-recent game; tgByTeam is that count (N mid-season, fewer early on). Teams
  // that share an Nth-game date share a stat call (teamsByStart), which keeps the call count bounded.
  const windows = {};
  for (const [key, n] of Object.entries(WINDOWS)) {
    const boundaryByTeam = new Map(), tgByTeam = new Map(), teamsByStart = new Map();
    for (const [tid, arr] of byTeam) {
      if (!arr.length) continue;
      const count = Math.min(n, arr.length);
      const start = arr[count - 1];
      boundaryByTeam.set(tid, start);
      tgByTeam.set(tid, count);
      if (!teamsByStart.has(start)) teamsByStart.set(start, new Set());
      teamsByStart.get(start).add(tid);
    }
    if (boundaryByTeam.size) windows[key] = { n, boundaryByTeam, tgByTeam, teamsByStart };
  }
  if (!Object.keys(windows).length) {
    dataset.counts = { ...dataset.counts, rollingActive: false, rollingError: 'could not derive windows' };
    return;
  }

  // One byDateRange per (window x distinct team-start x group), concurrency-capped. Each call from a
  // given start returns every player league-wide over that date range; we keep only the players whose
  // TEAM's window actually starts on that date (teamsByStart), so each player gets exactly one line.
  const jobs = [];
  for (const [key, w] of Object.entries(windows)) {
    for (const start of w.teamsByStart.keys()) {
      for (const group of ['hitting', 'pitching']) jobs.push({ key, group, start });
    }
  }
  const results = await mapLimit(jobs, 6, async (j) => ({ ...j, splits: await windowSplits(j.group, j.start, end, season) }));

  // id -> [records]. Usually one, but a two-way player (Ohtani) has both a hitter and a pitcher record
  // under the same MLB id; each takes the split from its own group below.
  const byId = new Map();
  for (const p of dataset.players) if (p.id != null) { const k = String(p.id); const a = byId.get(k); if (a) a.push(p); else byId.set(k, [p]); }

  const touchedIds = new Set();
  for (const { key, group, start, splits } of results) {
    const w = windows[key];
    const teams = w.teamsByStart.get(start); // only players whose team's window STARTS on this date
    for (const sp of splits) {
      const teamId = sp.team?.id;
      if (teamId == null || !teams.has(teamId)) continue; // this call is the wrong window for him
      const recs = byId.get(String(sp.player?.id));
      if (!recs) continue;
      // tg is his team's game count in the window (N). Clamp up only if his own gamesPlayed exceeds
      // it (a mid-window trade counts games from two teams) — never bumps a rested player up to N.
      const g = num((sp.stat || {}).gamesPlayed);
      const tg = Math.max(w.tgByTeam.get(teamId) ?? 0, g);
      const line = group === 'pitching' ? pitchLine(sp.stat || {}, tg) : hitLine(sp.stat || {}, tg);
      // Apply to the record(s) matching this stat group — a two-way player's hitter record gets the
      // hitting split and his pitcher record the pitching split; a normal player has just the one.
      for (const p of recs) {
        const isPitcher = p.pos === 'SP' || p.pos === 'RP';
        if (isPitcher !== (group === 'pitching')) continue;
        if (!p.rolling) p.rolling = {};
        p.rolling[key] = line;
        touchedIds.add(p.id);
      }
    }
  }
  const touched = touchedIds.size;

  // Subtitle date range only: a representative (median-team) window start, same as the card showed
  // before. Denominators above are now exact per team, so tgMin/tgMax collapses toward N.
  const meta = {};
  for (const [key, w] of Object.entries(windows)) {
    const counts = [...w.tgByTeam.values()];
    meta[key] = { start: windowStart(byTeam, w.n), end, tgMin: Math.min(...counts), tgMax: Math.max(...counts) };
  }
  dataset.counts = {
    ...dataset.counts,
    rollingActive: true,
    rollingPlayers: touched,
    rollingWindows: meta,
  };
}
