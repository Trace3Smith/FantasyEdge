// NFL defense-vs-position (DvP) — the BvP analog for football. ESPN exposes no ready-made pass/rush
// yards-allowed splits (its team endpoints carry own-offense only; the opponent param is a no-op and
// defensive.yardsAllowed returns 0), so DvP is DERIVED by aggregation: in each completed game a defense
// is credited with the OPPONENT's net-passing and rushing yards, summed over the season, then ranked into
// a pass-defense rank (for WR/TE/QB) and a rush-defense rank (for RB). Free/keyless via ESPN scoreboards
// (game ids) + game summaries (both teams' yards).
//
// This is the HEAVIEST matchup builder — ~1 scoreboard call per week + ~1 summary per completed game
// (~272/season). Bounded-concurrency + soft-budgeted + failure-tolerant so it can't dominate the cron;
// partial data still ranks. Empty out of season / before Week 1 → the synopsis falls back to Phase 1.
//
// Payload keyed by team abbrev = the DvP of the opponent THAT TEAM faces THIS WEEK (mirrors NHL/NBA):
//   teams[abbrev] = { opp, isHome, oppPassYdsAllowed, oppPassDRank, oppRushYdsAllowed, oppRushDRank }
// The synopsis def picks pass- vs rush-rank by the player's position and only fires in-season.

import { getJson } from './espn.js';

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const SCOREBOARD = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const SUMMARY = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/summary';
const MAX_WEEK = 18;
const MIN_GP = 4;                 // below this many games, ranks are too noisy for a favorable/tough lean
const CONC = 8, SOFT_MS = 45000;  // soft budget so DvP can't dominate the shared cron

const iso = (d) => d.toISOString().slice(0, 10);
const r1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const ord = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

// Classify from the OPPONENT's defensive rank (1 = best, fewest yards allowed). Opponent in the leakiest
// third → favorable; stingiest third → tough; else neutral. `rated` false early-season → neutral. Pure.
export function dvpLeanFor(oppDefRank, n, rated) {
  if (!rated || !oppDefRank || !n) return 'neutral';
  const tri = Math.max(1, Math.round(n / 3));
  if (oppDefRank >= n - tri + 1) return 'favorable'; // opponent allows a lot of yards (weak defense)
  if (oppDefRank <= tri) return 'tough';             // opponent is a stingy defense
  return 'neutral';
}

// Both teams' net-passing + rushing yards from a game summary boxscore, keyed by abbrev.
async function gameTeamYards(gameId) {
  const j = await getJson(`${SUMMARY}?event=${gameId}`);
  const teams = j.boxscore?.teams || [];
  const out = {};
  for (const t of teams) {
    const ab = t.team?.abbreviation; if (!ab) continue;
    const st = {}; for (const s of t.statistics || []) st[s.name] = s.displayValue;
    out[ab] = { pass: num(st.netPassingYards ?? st.passingYards), rush: num(st.rushingYards) };
  }
  const abbrevs = Object.keys(out);
  return abbrevs.length === 2 ? { a: abbrevs[0], b: abbrevs[1], yards: out } : null;
}

// Completed-game ids for one week.
async function weekGameIds(season, seasontype, week) {
  const j = await getJson(`${SCOREBOARD}?dates=${season}&seasontype=${seasontype}&week=${week}`);
  const ids = [];
  for (const e of j.events || []) {
    if (e.status?.type?.completed) ids.push(e.id);
  }
  return ids;
}

// This week's (or the next upcoming week's) matchups: teamAbbrev -> { opp, isHome }.
async function upcomingMatchups(season, seasontype) {
  const j = await getJson(`${SCOREBOARD}`); // no dates → current week
  const map = {};
  let week = null, sType = null, sYear = null;
  for (const e of j.events || []) {
    const comp = e.competitions?.[0]; if (!comp) continue;
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === 'home'), away = cs.find((c) => c.homeAway === 'away');
    if (!home?.team?.abbreviation || !away?.team?.abbreviation) continue;
    week = week ?? j.week?.number ?? e.week?.number;
    sType = sType ?? e.season?.type; sYear = sYear ?? e.season?.year;
    const H = home.team.abbreviation, A = away.team.abbreviation;
    const nm = (c) => c.team.shortDisplayName || c.team.name || c.team.abbreviation;
    map[A] = { opp: { abbrev: H, name: nm(home) }, isHome: false };
    map[H] = { opp: { abbrev: A, name: nm(away) }, isHome: true };
  }
  return { map, week, seasonType: sType, season: sYear };
}

// Build the DvP payload. `season`/`seasontype` default to the current in-season slate (derived from the
// live scoreboard); explicit values make the aggregation testable against a completed past season.
export async function buildNflDvp({ season, seasontype = 2, maxWeek = MAX_WEEK, prev = null } = {}) {
  const now = new Date().toISOString();
  // What's on this week (also gives us season/week when not passed explicitly).
  //
  // This was the one unguarded call in an otherwise failure-tolerant builder: every later fetch is
  // individually try/caught so partial data still ranks, but a single transient failure HERE threw
  // out of the whole build. That is exactly what happened in production — one Akamai 403 on the
  // bare scoreboard URL cost the entire day's DvP, even though a perfectly good payload was already
  // cached. On failure, fall back to the cached payload if we have one; only surface the error when
  // there is genuinely nothing to serve.
  let up;
  try {
    up = await upcomingMatchups();
  } catch (err) {
    if (prev && (prev.counts?.teamsRanked || 0) > 0) {
      return { ...prev, reusedAt: now, staleReason: `scoreboard unavailable: ${err.message}` };
    }
    throw err;
  }
  const seasonId = season || up.season || new Date().getFullYear();
  const sType = season ? seasontype : (up.seasonType || 2);

  // Weekly-freshness guard: DvP ranks only move as games complete (weekly), so if we already built for this
  // exact season+week and it has data, reuse it — a daily ~272-fetch rebuild would be pure waste. Costs
  // one scoreboard call (upcomingMatchups above) on the days it skips.
  if (prev && prev.season === seasonId && prev.week != null && prev.week === up.week && (prev.counts?.teamsRanked || 0) > 0) {
    return { ...prev, reusedAt: now };
  }

  // Gather completed game ids week by week, stopping after the first empty week (no games yet / season end).
  const deadline = Date.now() + SOFT_MS;
  const gameIds = [];
  for (let w = 1; w <= maxWeek; w++) {
    if (Date.now() > deadline) break;
    let ids = [];
    try { ids = await weekGameIds(seasonId, sType, w); } catch { ids = []; }
    if (!ids.length) { if (w > 1) break; else continue; }
    gameIds.push(...ids);
  }
  if (!gameIds.length) {
    return { season: seasonId, week: up.week ?? null, builtAt: now, rated: false, teams: {}, counts: { games: 0, teams: 0 } };
  }

  // Aggregate: each defense is credited with its opponent's yards in every completed game.
  const allowed = new Map(); // abbrev -> { pass, rush, gp }
  const add = (ab, pass, rush) => {
    const cur = allowed.get(ab) || { pass: 0, rush: 0, gp: 0 };
    cur.pass += pass; cur.rush += rush; cur.gp += 1; allowed.set(ab, cur);
  };
  await mapLimit(gameIds, CONC, async (id) => {
    if (Date.now() > deadline) return;
    try {
      const g = await gameTeamYards(id);
      if (!g) return;
      add(g.a, g.yards[g.b].pass, g.yards[g.b].rush); // a's defense allowed b's offense
      add(g.b, g.yards[g.a].pass, g.yards[g.a].rush);
    } catch { /* per-game failure is non-fatal */ }
  });

  // Per-game allowed + ranks (asc: 1 = fewest allowed = best defense).
  const rows = [];
  for (const [ab, v] of allowed) {
    if (v.gp <= 0) continue;
    rows.push({ abbrev: ab, gp: v.gp, passAllowed: r1(v.pass / v.gp), rushAllowed: r1(v.rush / v.gp) });
  }
  const n = rows.length;
  const rated = n > 0 && Math.min(...rows.map((r) => r.gp)) >= MIN_GP;
  const passRank = new Map(), rushRank = new Map();
  [...rows].sort((a, b) => a.passAllowed - b.passAllowed).forEach((r, i) => passRank.set(r.abbrev, i + 1));
  [...rows].sort((a, b) => a.rushAllowed - b.rushAllowed).forEach((r, i) => rushRank.set(r.abbrev, i + 1));
  const dvp = new Map();
  for (const r of rows) dvp.set(r.abbrev, { ...r, passDRank: passRank.get(r.abbrev), rushDRank: rushRank.get(r.abbrev) });

  // Combine with this week's schedule: each team's entry holds the OPPONENT's DvP for the matchup.
  const teams = {};
  for (const [ab, m] of Object.entries(up.map)) {
    const od = dvp.get(m.opp.abbrev);
    if (!od) continue;
    teams[ab] = {
      opp: m.opp, isHome: m.isHome, n,
      oppPassYdsAllowed: od.passAllowed, oppPassDRank: od.passDRank,
      oppRushYdsAllowed: od.rushAllowed, oppRushDRank: od.rushDRank,
    };
  }
  return {
    season: seasonId, week: up.week ?? null, builtAt: now, rated, teams,
    counts: { games: gameIds.length, teamsRanked: n, matchups: Object.keys(teams).length },
    // ranks table kept for display/debug (small).
    dvp: Object.fromEntries([...dvp].map(([ab, v]) => [ab, { passAllowed: v.passAllowed, passDRank: v.passDRank, rushAllowed: v.rushAllowed, rushDRank: v.rushDRank }])),
  };
}

// Phrase an opponent's DvP for a given position group. `group` is 'pass' (WR/TE/QB) or 'rush' (RB).
// `rated` is the PAYLOAD's flag (every team has MIN_GP games). Returns { lean, reason } or null. Pure.
//
// This used to pass `rated=true` to dvpLeanFor unconditionally, so the MIN_GP guard the builder
// computes was never applied where DvP is actually shown: a week-2 AI Report would have called a
// matchup "favorable" or "tough" off a single game. It now defaults to NOT rated, so a caller that
// forgets the flag gets a neutral, sample-size-honest line rather than a confident call.
export function dvpMatchup(entry, group, rated = false) {
  if (!entry || entry.n == null) return null;
  const rank = group === 'rush' ? entry.oppRushDRank : entry.oppPassDRank;
  const yds = group === 'rush' ? entry.oppRushYdsAllowed : entry.oppPassYdsAllowed;
  const n = entry.n;
  const lean = dvpLeanFor(rank, n, rated);
  const oppName = entry.opp?.name || entry.opp?.abbrev || 'the opponent';
  const kind = group === 'rush' ? 'rush defense' : 'pass defense';
  const yUnit = group === 'rush' ? 'rush yds' : 'pass yds';
  let reason;
  if (!rated) reason = `Faces ${oppName}'s ${kind} — too early in the season to rate it (defense ranks settle after ${MIN_GP} games).`;
  else if (lean === 'favorable') reason = `Favorable matchup — ${oppName} have a bottom-tier ${kind}, allowing the ${ord(n - rank + 1)}-most ${yUnit}/game (${yds}).`;
  else if (lean === 'tough') reason = `Tough matchup — ${oppName} have a top ${kind}, ${ord(rank)}-fewest ${yUnit}/game allowed (${yds}).`;
  else reason = `Faces ${oppName}'s ${kind} (${ord(rank)} of ${n}, ${yds} ${yUnit}/game allowed).`;
  return { lean, reason, rank, yds, group };
}

// ---- Matchup for one player: ONE helper behind Team Manager's chips and the AI Report ------------------
// Both surfaces call nflMatchupFor, so they can never disagree about a matchup.

export const DVP_GROUP = { RB: 'rush', WR: 'pass', TE: 'pass', QB: 'pass' };

// The NFL dataset mixes feeds, and some rows tag Washington 'WAS' where ESPN says 'WSH' (both seen live
// in the dataset), so those players silently never matched a DvP entry. Normalise before any ESPN lookup.
const ESPN_ABBREV = { WAS: 'WSH', JAC: 'JAX', LA: 'LAR' };
export const espnAbbrev = (ab) => (ab ? (ESPN_ABBREV[ab] || ab) : ab);

// Who a player faces in `week` and how good a matchup that is for his position. Ranks come from THIS
// season's DvP once it is rated (every team has MIN_GP games); before that from LAST season's final ranks,
// flagged `prior` and named by `source` season; with neither, the opponent alone and no lean. Never a
// rating from nothing. Returns null when the schedule doesn't know the team or the week (feed failed,
// unknown id): no chip beats a guessed one. `schedule` is fetchNflSchedule's shape. Pure.
//   { bye: true }
//   { opp, isHome, lean: 'favorable'|'tough'|'neutral'|null, group, rank, n, source, prior, reason }
export function nflMatchupFor({ pos, proTeamId, week, season = null, schedule, current = null, prior = null }) {
  const id = Number(proTeamId), wk = Number(week);
  if (!schedule || !id || !wk) return null;
  const games = schedule.games?.get(id);
  if (!games || !games.size) return null;
  const g = games.get(wk);
  if (!g) return schedule.byes?.get(id) === wk ? { bye: true } : null;
  const opp = schedule.abbrev?.get(g.oppId) || null;
  if (!opp) return null;
  const out = { opp, isHome: !!g.isHome, lean: null, group: null, rank: null, n: null, source: null, prior: false, reason: null };
  const group = DVP_GROUP[String(pos || '').toUpperCase()];
  if (!group) return out; // K, D/ST, IDP: DvP has no split for them, so the opponent alone
  out.group = group;
  const kind = group === 'rush' ? 'rush defense' : 'pass defense';
  const usable = (d, s) => !!(d && d.rated && d.dvp && d.dvp[opp] && (s == null || Number(d.season) === Number(s)));
  let table = null;
  if (usable(current, season)) table = current;
  else if (usable(prior, season != null ? Number(season) - 1 : null)) { table = prior; out.prior = true; }
  if (!table) {
    out.reason = `Faces ${opp}'s ${kind} — too early in the season to rate it (defense ranks settle after ${MIN_GP} games).`;
    return out;
  }
  const r = table.dvp[opp];
  const n = Object.keys(table.dvp).length;
  const rank = group === 'rush' ? r.rushDRank : r.passDRank;
  const yds = group === 'rush' ? r.rushAllowed : r.passAllowed;
  const unit = group === 'rush' ? 'rush yds' : 'pass yds';
  Object.assign(out, { lean: dvpLeanFor(rank, n, true), rank, n, source: Number(table.season) || null });
  const basis = out.prior ? ` — based on ${out.source} (this season's ranks settle after ${MIN_GP} games)` : '';
  if (out.lean === 'favorable') out.reason = `Favorable matchup — ${opp} allowed the ${ord(n - rank + 1)}-most ${unit}/game (${yds})${basis}.`;
  else if (out.lean === 'tough') out.reason = `Tough matchup — ${opp} allowed the ${ord(rank)}-fewest ${unit}/game (${yds})${basis}.`;
  else out.reason = `Faces ${opp}'s ${kind} (${ord(rank)} of ${n}, ${yds} ${unit}/game)${basis}.`;
  return out;
}

// "This week" for a surface with no league week (the AI Report): the team's next game that hasn't
// finished, if it's within NEXT_GAME_DAYS. Kickoff up to ~5h ago counts as in progress. 12 days covers
// the longest normal gap between games (Thursday night, then the next week's Monday night: ~11 days), so
// a TNF team isn't left blank for days; a bye or the preseason puts the next game further out: no matchup.
// The DvP payload's scoreboard week can't stand in: in preseason it's a PRESEASON week number, which maps
// to the wrong regular-season opponent. Pure (pass `now` to test).
const NEXT_GAME_DAYS = 12;
export function nflNextWeek(schedule, teamId, now = Date.now()) {
  const games = schedule?.games?.get(Number(teamId));
  if (!games) return null;
  let best = null;
  for (const [wk, g] of games) {
    if (!g?.date || g.date < now - 5 * 3600e3) continue;
    if (!best || g.date < best.date) best = { wk, date: g.date };
  }
  return best && best.date - now <= NEXT_GAME_DAYS * 86400e3 ? best.wk : null;
}
