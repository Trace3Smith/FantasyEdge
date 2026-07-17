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
// COST. Both windows, both stat groups, league-wide: FOUR requests total, plus one
// schedule call — not one per player. `limit` above the split count returns everything
// in a single response, and `playerPool=ALL` is load-bearing: the default silently
// returns only qualified batters (~148 of ~500).
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

// byDateRange takes ONE start date, but teams don't play in lockstep — over any given
// window they differ by a few games. Use the median team's Nth-most-recent game date, so
// the window is "the last ~N team games" for the league; per-player `tg` then records
// exactly what that player's own team played, which is the number the UI should trust.
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

// Games each team actually played from `start` onward. ISO dates compare correctly as strings.
function teamGamesSince(byTeam, start) {
  const m = new Map();
  for (const [id, arr] of byTeam) m.set(id, arr.filter((d) => d >= start).length);
  return m;
}

async function windowSplits(group, start, end, season) {
  const url = `${API}/stats?stats=byDateRange&group=${group}&season=${season}&sportId=1`
    + `&startDate=${start}&endDate=${end}&playerPool=ALL&limit=2000`;
  const j = await getJson(url);
  return j.stats?.[0]?.splits || [];
}

// Trimmed to what a rolling card actually shows — the full split carries 34 stat fields,
// and every byte here is multiplied by ~900 players inside the cached dataset.
function hitLine(s, tg) {
  return {
    g: num(s.gamesPlayed), tg,
    avg: s.avg ?? null, ops: s.ops ?? null,
    hr: num(s.homeRuns), rbi: num(s.rbi), r: num(s.runs), sb: num(s.stolenBases),
    val: r1(gameValueMlb('OF', s)), // window total on the HOT/COLD scale
  };
}
function pitchLine(s, tg) {
  return {
    g: num(s.gamesPlayed), tg,
    ip: s.inningsPitched ?? null, era: s.era ?? null, whip: s.whip ?? null,
    k: num(s.strikeOuts), w: num(s.wins), sv: num(s.saves),
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

  const windows = {};
  for (const [key, n] of Object.entries(WINDOWS)) {
    const start = windowStart(byTeam, n);
    if (start) windows[key] = { start, tg: teamGamesSince(byTeam, start) };
  }
  if (!Object.keys(windows).length) {
    dataset.counts = { ...dataset.counts, rollingActive: false, rollingError: 'could not derive windows' };
    return;
  }

  // One request per (window x group) — four total, in parallel.
  const jobs = [];
  for (const [key, w] of Object.entries(windows)) {
    for (const group of ['hitting', 'pitching']) jobs.push({ key, group, start: w.start });
  }
  const results = await Promise.all(
    jobs.map(async (j) => ({ ...j, splits: await windowSplits(j.group, j.start, end, season) }))
  );

  const byId = new Map();
  for (const p of dataset.players) if (p.id != null) byId.set(String(p.id), p);

  let touched = 0;
  for (const { key, group, splits } of results) {
    for (const sp of splits) {
      const p = byId.get(String(sp.player?.id));
      if (!p) continue;
      // Take each player from the group matching his listed position, so a two-way player
      // gets one line rather than hitting silently overwritten by pitching.
      const isPitcher = p.pos === 'SP' || p.pos === 'RP';
      if (isPitcher !== (group === 'pitching')) continue;
      const tg = windows[key].tg.get(sp.team?.id) ?? 0;
      const line = group === 'pitching' ? pitchLine(sp.stat || {}, tg) : hitLine(sp.stat || {}, tg);
      if (!p.rolling) { p.rolling = {}; touched++; }
      p.rolling[key] = line;
    }
  }

  // Report the real window bounds — the team-game spread is why `tg` exists, and the UI
  // should label from these rather than assume "15" means fifteen for everyone.
  const meta = {};
  for (const [key, w] of Object.entries(windows)) {
    const counts = [...w.tg.values()];
    meta[key] = { start: w.start, end, tgMin: Math.min(...counts), tgMax: Math.max(...counts) };
  }
  dataset.counts = {
    ...dataset.counts,
    rollingActive: true,
    rollingPlayers: touched,
    rollingWindows: meta,
  };
}
