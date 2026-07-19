// Rolling last-N team-game splits for the ESPN sports (NBA / WNBA / NHL), the counterpart
// to MLB's enrichRolling. The shape it writes matches MLB's — each player gets
// `rolling: { <window>: { g, tg, ...stats, val } }` and the dataset gets
// counts.rollingWindows — so the same API and frontend serve all four sports.
//
// WHY THIS IS SEPARATE FROM MLB. MLB Stats API has a league-wide byDateRange endpoint, so
// MLB rolling is four calls total. ESPN has NO such endpoint (its date params are ignored,
// verified), so here rolling means ONE gamelog fetch per player. To bound that we cover only
// the top ROLL_TOP_N ranked players per sport.
//
// THE TEAM-GAMES DENOMINATOR, FOR FREE. The playing-time signal is a player's games vs his
// TEAM's games in the window. ESPN has no cheap league schedule, and a gamelog lists only
// games the player PLAYED (no DNP rows) — so team games can't come from one player's log.
// But every gamelog event carries homeTeamId/awayTeamId/date, and the top-N pool covers
// ~5-10 players per team, so the UNION of the pool's events reconstructs each team's game
// calendar with no extra calls. That calendar gives the tg denominator.
//
// Additive + failure-tolerant + a no-op out of season, exactly like enrichForm/enrichRolling.

import { getJson } from './espn.js';

const ROLL_TOP_N = 150;

// Per-sport config: gamelog path, full-season length (for the in-season gate), the windows
// (in TEAM games), and how to read/score a single game's line from the gamelog stat row.
export const ROLL_ESPN = {
  nba:  { path: 'basketball/nba',  full: 82, windows: { l15: 15, l30: 30 } },
  wnba: { path: 'basketball/wnba', full: 44, windows: { l10: 10, l20: 20 } },
  nhl:  { path: 'hockey/nhl',      full: 82, windows: { l15: 15, l30: 30 } },
};

const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const iso = (d) => new Date(d).toISOString().slice(0, 10);

// Per-game fantasy value on the same scale as enrichForm's gameValueEspn, so a rolling total
// can't drift from the HOT/COLD badges. `v(name)` reads a named stat from the game row.
function gameValue(sport, isGoalie, v) {
  if (sport === 'nba' || sport === 'wnba') {
    return v('points') + 1.2 * v('totalRebounds') + 1.5 * v('assists') + 3 * v('steals') + 3 * v('blocks') - v('turnovers');
  }
  if (isGoalie) return 2 * v('wins') + 0.2 * v('saves') + 3 * v('shutouts') - 1.5 * v('goalsAgainst');
  return 3 * v('goals') + 2 * v('assists') + 0.4 * v('shotsTotal') + 0.5 * (v('powerPlayGoals') + v('powerPlayAssists')) + v('plusMinus');
}

// A window's displayed stat line: per-game rates for the counting cats (matching how the
// board shows them), plus the value total. Sport- and role-specific.
function windowLine(sport, isGoalie, games) {
  const n = games.length;
  const sum = (name) => games.reduce((a, g) => a + g.v(name), 0);
  const per = (name) => (n ? r1(sum(name) / n) : 0);
  const val = r1(games.reduce((a, g) => a + gameValue(sport, isGoalie, g.v), 0));
  if (sport === 'nba' || sport === 'wnba') {
    return { pts: per('points'), reb: per('totalRebounds'), ast: per('assists'), stl: per('steals'), blk: per('blocks'), val };
  }
  if (isGoalie) {
    const svPct = sum('saves') + sum('goalsAgainst') > 0 ? r2(sum('saves') / (sum('saves') + sum('goalsAgainst'))) : null;
    return { w: sum('wins'), gaa: n ? r2(sum('goalsAgainst') / n) : 0, svpct: svPct, so: sum('shutouts'), val };
  }
  // `gls`, not `g`: `g` is reserved for games-played in the window record, so a goals field
  // named `g` would be overwritten by the spread below (and vice versa).
  return { gls: sum('goals'), a: sum('assists'), pts: sum('goals') + sum('assists'), pm: sum('plusMinus'), sog: sum('shotsTotal'), val };
}

// Fetch one player's regular-season gamelog -> [{ date, eventId, teamId, homeTeamId,
// awayTeamId, v }] newest-last. `v(name)` closes over this game's stat row.
async function playerGames(path, id) {
  const gl = await getJson(`https://site.web.api.espn.com/apis/common/v3/sports/${path}/athletes/${id}/gamelog`);
  const idx = new Map((gl.names || []).map((nm, i) => [nm, i]));
  const events = gl.events || {};
  const st = (gl.seasonTypes || []).find((s) => /regular season/i.test(s.displayName || ''));
  if (!st) return [];
  const out = [];
  for (const cat of st.categories || []) {
    for (const ev of cat.events || []) {
      const meta = events[ev.eventId] || {};
      if (!meta.gameDate) continue;
      const v = (name) => num(ev.stats?.[idx.get(name)]);
      out.push({
        date: iso(meta.gameDate), eventId: ev.eventId,
        teamId: meta.team?.id != null ? String(meta.team.id) : null,
        homeTeamId: meta.homeTeamId != null ? String(meta.homeTeamId) : null,
        awayTeamId: meta.awayTeamId != null ? String(meta.awayTeamId) : null,
        v,
      });
    }
  }
  return out;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

// teamId -> sorted-desc array of that team's distinct game dates, reconstructed from the pool.
function teamCalendars(allGames) {
  const byTeam = new Map(); // teamId -> Set(date)
  const add = (tid, date) => { if (!tid) return; if (!byTeam.has(tid)) byTeam.set(tid, new Set()); byTeam.get(tid).add(date); };
  for (const g of allGames) { add(g.homeTeamId, g.date); add(g.awayTeamId, g.date); }
  const out = new Map();
  for (const [tid, dates] of byTeam) out.set(tid, [...dates].sort().reverse());
  return out;
}

// League window start for N team games: the median team's Nth-most-recent game date, so the
// window is "the last ~N team games" league-wide; per-team tg then records each team's own
// count since that date. Mirrors MLB's enrichRolling.
function windowStart(cal, n) {
  const dates = [];
  for (const arr of cal.values()) { const d = arr[Math.min(n, arr.length) - 1]; if (d) dates.push(d); }
  if (!dates.length) return null;
  dates.sort();
  return dates[Math.floor(dates.length / 2)];
}

// Mutates dataset.players: sets `rolling` on the top-N ranked players. No-op (zero fetches)
// out of season. `sport` is 'nba' | 'wnba' | 'nhl'.
export async function enrichRollingEspn(dataset, { sport }) {
  const cfg = ROLL_ESPN[sport];
  if (!cfg || !Array.isArray(dataset.players)) return;
  const maxGames = dataset.counts?.maxGames;
  if (maxGames == null || maxGames >= cfg.full) {
    dataset.counts = { ...dataset.counts, rollingActive: false };
    return;
  }

  const top = dataset.players
    .filter((p) => !p.searchOnly && p.rank != null && p.id != null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, ROLL_TOP_N);
  if (!top.length) { dataset.counts = { ...dataset.counts, rollingActive: false }; return; }

  // Fetch every top player's gamelog; keep the games and pool them for the team calendars.
  const fetched = await mapLimit(top, 8, async (p) => {
    try { return { p, games: await playerGames(cfg.path, p.id) }; }
    catch { return { p, games: [] }; }
  });
  const pool = [];
  for (const f of fetched) pool.push(...f.games);
  if (!pool.length) { dataset.counts = { ...dataset.counts, rollingActive: false, rollingError: 'no gamelogs' }; return; }

  const cal = teamCalendars(pool);
  const end = pool.reduce((m, g) => (g.date > m ? g.date : m), '0000-00-00');
  const windows = {}; // key -> { start, tgByTeam: Map }
  for (const [key, n] of Object.entries(cfg.windows)) {
    const start = windowStart(cal, n);
    if (!start) continue;
    const tgByTeam = new Map();
    for (const [tid, arr] of cal) tgByTeam.set(tid, arr.filter((d) => d >= start).length);
    windows[key] = { start, tgByTeam };
  }
  if (!Object.keys(windows).length) { dataset.counts = { ...dataset.counts, rollingActive: false }; return; }

  let touched = 0;
  for (const { p, games } of fetched) {
    if (!games.length) continue;
    const isGoalie = (p.pos || '').toUpperCase().split('/')[0].trim() === 'G';
    const teamId = games[games.length - 1].teamId; // his current team (last game's)
    const rolling = {};
    for (const [key, w] of Object.entries(windows)) {
      const inWin = games.filter((g) => g.date >= w.start);
      if (!inWin.length) continue;
      // tg is reconstructed from the top-N pool, so it can undercount a thinly-covered team,
      // and a player traded mid-window has games from two teams while tg is only his current
      // one's — either can make g exceed tg. Clamp so the denominator is never below the
      // numerator (no "played 17 of 15"); the rare clamp reads as "played every game".
      const rawTg = teamId != null ? (w.tgByTeam.get(teamId) ?? inWin.length) : inWin.length;
      const tg = Math.max(rawTg, inWin.length);
      rolling[key] = { g: inWin.length, tg, ...windowLine(sport, isGoalie, inWin) };
    }
    if (Object.keys(rolling).length) { p.rolling = rolling; touched++; }
  }

  const meta = {};
  for (const [key, w] of Object.entries(windows)) {
    const counts = [...w.tgByTeam.values()].filter((x) => x > 0);
    meta[key] = { start: w.start, end, tgMin: counts.length ? Math.min(...counts) : 0, tgMax: counts.length ? Math.max(...counts) : 0 };
  }
  dataset.counts = { ...dataset.counts, rollingActive: true, rollingPlayers: touched, rollingWindows: meta };
}
