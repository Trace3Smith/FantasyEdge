// Opponent-adjusted NFL team efficiency, from nflverse's pre-aggregated team-week file.
//
// WHY NOT PLAY-BY-PLAY. The obvious source for EPA is nflfastR play-by-play, but that is a 19MB
// gzip per season and parsing it in a shared cron to produce 32 numbers is not a trade worth
// making. `stats_team_week_<year>.csv.gz` is 76KB, carries the same season's EPA already summed
// per team per game, and is rebuilt by nflverse daily in season (verified: the 2026 assets were
// republished 2026-09-11). Scoped to what a margin model actually reads, it is the same data at
// 1/250th the size.
//
// WHAT THAT COSTS US, STATED PLAINLY. The team-week file has no `success` column, no drive
// boundaries, and no win-probability column — so success rate, points per drive and any
// GARBAGE-TIME FILTER are simply not available on this path. CFB gets all three free from CFBD
// (see cfbRatings.js), and this asymmetry is deliberately surfaced to the reader rather than
// hidden: every rating produced here carries `instrumentation: 'team-week'`, and the card says so.
// Moving this to play-by-play later would close the gap without changing any consumer.
//
// THE DEFENSIVE SPLIT IS A SELF-JOIN, not a missing feature. The file is offense-only, but every
// row names its `opponent_team`, and the EPA a team's opponents produced against it IS its
// defensive EPA. Verified against 2024: Baltimore leads the league on offense (+0.209 EPA/play),
// Denver and Philadelphia are elite on defense (-0.104, -0.084), and Carolina's historically bad
// defense lands at +0.157 — the leaderboard matches the season as it was actually played.
import { gunzipSync } from 'node:zlib';
import { ridgeSolve } from './ridge.js';

const STATS_URL = (season) =>
  `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv.gz`;

// nflverse is a GitHub release asset, so this is a plain CDN fetch with no key and no rate limit —
// unlike every ESPN path in this codebase, which needs the browser UA dance in espn.js.
const UA = 'FantasyEdge/1.0 (game model; contact via app)';

// Bump when the ratings payload changes shape OR when a change would make a fresh build disagree
// with a cached one — same rule, for the same reason, as FEED_CONTENT_VERSION in pickem.js.
export const RATINGS_VERSION = 1;

// Team abbreviation drift across nflverse seasons. The file uses the franchise's abbreviation AT
// THE TIME, so a 2016 row says SD and a 2019 row says OAK; ratings have to key on one name or a
// relocated team reads as two half-seasons of a team that never existed.
const TEAM_ALIAS = { SD: 'LAC', OAK: 'LV', STL: 'LAR', LA: 'LAR', WAS: 'WSH', JAC: 'JAX' };
const norm = (t) => TEAM_ALIAS[t] || t;

// A CSV reader that respects quotes. Required, not optional: the team-week file carries
// `fg_made_list` and friends, which are quoted comma-separated lists — a naive split on comma
// shifts every column after them and silently corrupts the numbers we came for.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length === header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// One season of team-week rows. Regular season only: a team's playoff games are played against a
// biased sample of opponents (good ones), which is exactly the thing opponent adjustment is
// trying to correct for, and including them overweights the teams that got there.
export async function fetchTeamWeeks(season) {
  const r = await fetch(STATS_URL(season), { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`nflverse stats_team HTTP ${r.status} for ${season}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return parseCsv(gunzipSync(buf).toString('utf8')).filter((x) => x.season_type === 'REG');
}

// Per-team-game offensive line: the four quantities the model reads, plus the play count that
// weights them. Plays are dropbacks + carries (attempts + sacks + rushes) — special teams are
// excluded because EPA per play on a punt says nothing about how good an offense is.
//
// `passing_yards` is gross of sack yardage (the file carries sack_yards_lost separately), so net
// yards subtracts it; otherwise a team that gets sacked eight times looks like it gained ground.
export function offenseLine(r) {
  const plays = num(r.attempts) + num(r.carries) + num(r.sacks_suffered);
  return {
    team: norm(r.team),
    opp: norm(r.opponent_team),
    week: num(r.week),
    plays,
    epa: num(r.passing_epa) + num(r.rushing_epa),
    yards: num(r.passing_yards) + num(r.rushing_yards) - num(r.sack_yards_lost),
    explosive: num(r.passing_20) + num(r.rushing_20),
    sacksTaken: num(r.sacks_suffered),
    dropbacks: num(r.attempts) + num(r.sacks_suffered),
  };
}

// Raw (unadjusted) per-team rates, offense and defense, from a set of team-week rows.
// `throughWeek` truncates the season, which is what makes a leak-free backtest possible: rating a
// Week 9 game may only ever see Weeks 1-8.
export function rawRates(rows, { throughWeek = Infinity } = {}) {
  const lines = rows.map(offenseLine).filter((l) => l.plays > 0 && l.week <= throughWeek);
  const acc = {};
  const bucket = (t) => (acc[t] = acc[t] || {
    team: t, games: 0,
    off: { plays: 0, epa: 0, yards: 0, explosive: 0, sacks: 0, dropbacks: 0 },
    def: { plays: 0, epa: 0, yards: 0, explosive: 0, sacks: 0, dropbacks: 0 },
  });
  for (const l of lines) {
    const o = bucket(l.team), d = bucket(l.opp);
    o.games++;
    for (const [side, b] of [['off', o.off], ['def', d.def]]) {
      b.plays += l.plays; b.epa += l.epa; b.yards += l.yards;
      b.explosive += l.explosive; b.sacks += l.sacksTaken; b.dropbacks += l.dropbacks;
      void side;
    }
  }
  const rate = (b) => ({
    epaPerPlay: b.plays ? b.epa / b.plays : 0,
    yardsPerPlay: b.plays ? b.yards / b.plays : 0,
    explosiveRate: b.plays ? b.explosive / b.plays : 0,
    sackRate: b.dropbacks ? b.sacks / b.dropbacks : 0,
    plays: b.plays,
  });
  const out = {};
  for (const t of Object.keys(acc)) {
    out[t] = { team: t, games: acc[t].games, offense: rate(acc[t].off), defense: rate(acc[t].def) };
  }
  return { teams: out, lines };
}

// Opponent-adjusted offense and defense, in EPA per play above/below league average.
//
// The model is `epaPerPlay(i attacking j) = mu + off_i - def_j`, fit over every team-game with
// plays as the weight, so a 70-play game counts for more than a 45-play one. Sign convention:
// POSITIVE IS GOOD ON BOTH SIDES — off_i above zero means this offense beats an average one,
// def_j above zero means this defense holds an average offense below its usual output. That makes
// `net = off + def` directly meaningful and is why the design uses `- def_j` rather than `+`.
export function adjustEpa(lines, { lambda = 6 } = {}) {
  const teams = [...new Set(lines.flatMap((l) => [l.team, l.opp]))].sort();
  if (teams.length < 2) return { teams: {}, mu: 0, n: 0 };
  const idx = Object.fromEntries(teams.map((t, i) => [t, i]));
  const P = 1 + teams.length * 2;
  const rows = [], y = [], weights = [];
  for (const l of lines) {
    const row = new Array(P).fill(0);
    row[0] = 1;
    row[1 + idx[l.team]] = 1;              // offense of the team with the ball
    row[1 + teams.length + idx[l.opp]] = -1; // defense of the team without it
    rows.push(row); y.push(l.epa / l.plays); weights.push(l.plays);
  }
  const penalize = rows[0].map((_, i) => i !== 0); // never shrink the intercept
  const beta = ridgeSolve({ rows, y, weights, lambda, penalize });
  const out = {};
  for (const t of teams) {
    const off = beta[1 + idx[t]];
    const def = beta[1 + teams.length + idx[t]];
    out[t] = { off, def, net: off + def };
  }
  return { teams: out, mu: beta[0], n: lines.length };
}

// Blend a partial current season with the previous season's finished ratings.
//
// A Week 3 rating computed on two games is mostly noise, and the codebase already has an opinion
// about this: teamReport.js holds a team on last season's ranks until it has MIN_GP games. The
// same idea, made continuous rather than a cliff — weight the current season by how much of it has
// actually happened. STABLE_GAMES is a fixed eight-game blending assumption, also used by the offline backtest.
export const STABLE_GAMES = 8;

export function blendSeasons(current, prior, { stableGames = STABLE_GAMES } = {}) {
  const out = {};
  const teams = new Set([...Object.keys(current.teams || {}), ...Object.keys(prior?.teams || {})]);
  for (const t of teams) {
    const c = current.teams?.[t], p = prior?.teams?.[t];
    const gp = current.games?.[t] || 0;
    const w = p ? Math.min(gp / stableGames, 1) : 1;
    const pick = (k) => (c && p ? w * c[k] + (1 - w) * p[k] : (c?.[k] ?? p?.[k] ?? 0));
    out[t] = { off: pick('off'), def: pick('def'), net: pick('net'), weight: Math.round(w * 100) / 100 };
  }
  return out;
}

// Everything the feed needs for one season, ready to cache: adjusted ratings blended across the
// season boundary, plus the raw rates the explanation lines quote and the league ranks they cite.
export async function buildNflRatings({ season, throughWeek = Infinity, fetchImpl = fetchTeamWeeks } = {}) {
  let cur;
  try { cur = await fetchImpl(season); } catch (err) {
    if (!/HTTP 404/.test(err.message)) throw err;
    cur = []; // The new season asset may not exist before Week 1.
  }
  const curRates = rawRates(cur, { throughWeek });
  const curAdj = adjustEpa(curRates.lines);
  const games = Object.fromEntries(Object.entries(curRates.teams).map(([t, v]) => [t, v.games]));

  // The prior season is a fallback, never a requirement — in Week 1 it is the only signal there
  // is, and by Week 10 it is nearly gone. A failure to fetch it degrades to current-season-only.
  let priorAdj = null;
  try {
    const prev = await fetchImpl(season - 1);
    priorAdj = adjustEpa(rawRates(prev).lines);
  } catch { /* first season available, or a transient failure — current season stands alone */ }

  const blended = blendSeasons({ ...curAdj, games }, priorAdj);
  const ranked = rankTeams(blended);
  if (!Object.keys(ranked).length) throw new Error('NFL ratings contain no teams');
  return {
    v: RATINGS_VERSION,
    sport: 'nfl',
    season,
    throughWeek: Number.isFinite(throughWeek) ? throughWeek : null,
    instrumentation: 'team-week',      // see the header: no success rate, no garbage-time filter
    garbageTimeFiltered: false,
    teams: ranked,
    raw: curRates.teams,
    counts: { teams: Object.keys(ranked).length, teamGames: curAdj.n, priorSeason: !!priorAdj },
    builtAt: new Date().toISOString(),
  };
}

// League ranks for each rating, so the card can say "11th" without the page re-deriving it.
// Rank 1 is best on both sides, which is only true because of the sign convention in adjustEpa.
export function rankTeams(blended) {
  const list = Object.entries(blended);
  const rankBy = (key) => {
    const sorted = list.slice().sort((a, b) => b[1][key] - a[1][key]);
    return Object.fromEntries(sorted.map(([t], i) => [t, i + 1]));
  };
  const rOff = rankBy('off'), rDef = rankBy('def'), rNet = rankBy('net');
  const out = {};
  for (const [t, v] of list) {
    out[t] = {
      off: Math.round(v.off * 1e4) / 1e4,
      def: Math.round(v.def * 1e4) / 1e4,
      net: Math.round(v.net * 1e4) / 1e4,
      offRank: rOff[t], defRank: rDef[t], netRank: rNet[t],
      weight: v.weight ?? 1,
    };
  }
  return out;
}
