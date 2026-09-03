// Team reports for Brackets & Bowls — the expandable per-team panel behind each Pick'em game
// card: recent form, season profile, and the offense-vs-defense ranks that explain WHY a
// matchup tilts. One builder serves both leagues (NFL + college football).
//
// THE DEFENSE PROBLEM, AND THE ENDPOINT THAT SOLVES IT. ESPN's per-team `statistics` endpoint
// carries own-offense only — its `defensive` category reports yardsAllowed/pointsAllowed as a
// flat 0 (see the header of nflDvp.js, which had to derive NFL pass/rush defense by aggregating
// ~272 game summaries a season). Doing that for 136 FBS teams is not affordable in a shared
// cron. The `statistics/byteam` leaderboard does it for us: every team arrives with its
// categories DOUBLED into "Own Passing"/"Opponent Passing", "Own Rushing"/"Opponent Rushing"
// and so on, where the Opponent split IS the defense — what this team allowed — and each stat
// already carries its national rank. One call, whole league, both sides of the ball.
//
// RANK DIRECTION. Rank 1 is good for the team in both splits, but for opposite reasons: on an
// Own split rank 1 = the most yards/points produced (best offense); on an Opponent split rank 1
// = the fewest allowed (best defense). Verified against 2025 FBS: Ohio State allowed 129.7 pass
// yds/g at opponent-rank 1, Stanford 288.9 at 136. So an offense rank and a defense rank are
// directly comparable — a #4 rush offense against a #61 rush defense is a real mismatch, and
// that comparison is the whole point of the panel.
//
// EARLY SEASON. A season's ranks are noise until enough of the league has played — in Week 1
// the CFB leaderboard returns 16 teams, most with one game. So the builder measures the season
// it's asked for and falls back to the last completed one when the sample is too thin, flagging
// `statsBasis: 'prior-season'` so the UI can label it rather than passing last year's ranks off
// as this year's. Recent form backfills across the same boundary, tagging each game's season.
import { getJson } from './espn.js';

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const BYTEAM = (lg, season) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/${lg}/statistics/byteam?season=${season}&seasontype=2&limit=400`;
const SCHEDULE = (lg, id, season) =>
  `https://site.web.api.espn.com/apis/site/v2/sports/${lg}/teams/${id}/schedule?season=${season}`;

const FORM_GAMES = 5;   // recent results shown per team
const MIN_GP = 4;       // games below which a team's own ranks are too noisy to lean on
const MIN_RATED = 0.5;  // fraction of the league that must clear MIN_GP for a season to rank
const CONC = 6;         // parallel schedule fetches — same bounded-concurrency shape as nflDvp
const SOFT_MS = 25000;  // soft budget; past it we stop fetching form and keep what we have

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

// Stat names differ between the leagues (CFB calls it passingYardsPerGame, the NFL
// netPassingYardsPerGame) and a league's `names` array can repeat a name, so every lookup is
// BY NAME with an ordered candidate list — never by column position.
function pickIndex(names, candidates) {
  for (const c of candidates) {
    const i = names.indexOf(c);
    if (i >= 0) return i;
  }
  return -1;
}

// The four stats the panel reads off each split, per category.
const WANT = {
  passing: {
    yardsPerGame: ['netPassingYardsPerGame', 'passingYardsPerGame'],
    pointsPerGame: ['totalPointsPerGame'],
    totalYardsPerGame: ['netYardsPerGame', 'yardsPerGame'],
  },
  rushing: {
    rushYardsPerGame: ['rushingYardsPerGame'],
    yardsPerCarry: ['yardsPerRushAttempt'],
  },
};

// One team's Own (offense) or Opponent (defense) side, as { stat: { value, rank } }.
function readSide(teamCats, glossary, side) {
  const want = side === 'own' ? /^Own /i : /^Opponent /i;
  const out = {};
  for (const [cat, fields] of Object.entries(WANT)) {
    const c = teamCats.find((x) => x.name === cat && want.test(x.displayName || ''));
    if (!c) continue;
    const names = glossary[cat] || [];
    for (const [key, candidates] of Object.entries(fields)) {
      const i = pickIndex(names, candidates);
      if (i < 0) continue;
      const value = c.values?.[i];
      if (typeof value !== 'number') continue;
      const rank = parseInt(c.ranks?.[i], 10);
      out[key] = { value: Math.round(value * 10) / 10, rank: Number.isFinite(rank) ? rank : null };
    }
  }
  return out;
}

// The whole league's own+opponent profile for one season, keyed by ESPN team id. Also reports
// how many teams have played enough for the ranks to mean anything, which decides the fallback.
async function leagueStats(leaguePath, season) {
  const j = await getJson(BYTEAM(leaguePath, season));
  const glossary = {};
  for (const c of (j.categories || [])) glossary[c.name] = c.names || [];
  const gpIdx = pickIndex(glossary.general || [], ['gamesPlayed']);

  const teams = {};
  let rated = 0;
  for (const t of (j.teams || [])) {
    const id = t.team?.id;
    if (!id) continue;
    const cats = t.categories || [];
    const gen = cats.find((x) => x.name === 'general' && /^Own /i.test(x.displayName || ''));
    const gp = gpIdx >= 0 ? gen?.values?.[gpIdx] ?? 0 : 0;
    if (gp >= MIN_GP) rated++;
    teams[id] = {
      abbr: t.team.abbreviation || null,
      gamesPlayed: gp,
      offense: readSide(cats, glossary, 'own'),
      defense: readSide(cats, glossary, 'opponent'),
    };
  }
  // `count` is the league size ESPN ranked against — the denominator the UI shows a rank out of.
  return { teams, count: Object.keys(teams).length, rated };
}

// Completed games from a team's schedule, newest first, as compact result rows. Preseason is
// excluded: an NFL team's schedule carries its August exhibitions (seasonType 1) as completed
// games, and starters barely play in them — reading those as recent form would be wrong. Regular
// season (2) and postseason (3) both count; CFB schedules only ever carry the former.
function formFrom(schedule, season) {
  const rows = [];
  for (const ev of (schedule.events || [])) {
    const c = ev.competitions?.[0];
    if (!c || c.status?.type?.state !== 'post') continue;
    const stype = ev.seasonType?.type;
    if (typeof stype === 'number' && stype < 2) continue;
    const cs = c.competitors || [];
    const me = cs.find((x) => String(x.team?.id) === String(schedule.team?.id));
    const opp = cs.find((x) => x !== me);
    if (!me || !opp) continue;
    const score = (t) => { const n = Number(t.score?.value ?? t.score?.displayValue ?? t.score); return Number.isFinite(n) ? n : null; };
    const oppRank = opp.curatedRank?.current;
    rows.push({
      date: ev.date,
      season,
      opp: opp.team?.abbreviation || '',
      oppRank: typeof oppRank === 'number' && oppRank >= 1 && oppRank <= 25 ? oppRank : null,
      home: me.homeAway === 'home',
      score: score(me),
      oppScore: score(opp),
      won: me.winner === true,
    });
  }
  return rows.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

// Recent form for one team. Early in a season there aren't FORM_GAMES results yet, so the
// previous season backfills the tail — each row carries its own `season` so the UI can say so.
async function teamForm(leaguePath, id, season) {
  let rows = [];
  try { rows = formFrom(await getJson(SCHEDULE(leaguePath, id, season)), season); } catch { /* keep going */ }
  if (rows.length < 3) {
    try {
      const prev = formFrom(await getJson(SCHEDULE(leaguePath, id, season - 1)), season - 1);
      rows = rows.concat(prev);
    } catch { /* prior season is a bonus, never a requirement */ }
  }
  return rows.slice(0, FORM_GAMES);
}

// Build the expandable report for every team on a slate.
//   leaguePath — ESPN sport/league segment, e.g. 'football/nfl' or 'football/college-football'
//   season     — the scoreboard's season year
//   teamIds    — ESPN team ids appearing on the slate (deduped by the caller or here)
// Returns { statsSeason, statsBasis, leagueSize, teams: { [id]: { form, offense, defense, … } } }.
// Best-effort throughout: a failure anywhere degrades to a smaller report, never a thrown slate.
export async function buildTeamReports({ leaguePath, season, teamIds }) {
  const ids = [...new Set((teamIds || []).filter(Boolean).map(String))];
  const empty = { statsSeason: season, statsBasis: 'none', leagueSize: 0, teams: {} };
  if (!ids.length || !season) return empty;

  // Rank against the requested season when enough of the league has played, else the last
  // completed one — Week 1 ranks computed off a handful of teams would be actively misleading.
  let statsSeason = season, statsBasis = 'season', stats = null;
  try {
    stats = await leagueStats(leaguePath, season);
    // A league that hasn't kicked off answers with a wholly EMPTY body — `{}`, no teams and no
    // categories, not an error — so "no teams at all" has to fall back just like "too few rated".
    if (!stats.count || stats.rated / stats.count < MIN_RATED) {
      try {
        const prior = await leagueStats(leaguePath, season - 1);
        if (prior.count) { stats = prior; statsSeason = season - 1; statsBasis = 'prior-season'; }
      } catch { /* thin current-season ranks still beat none */ }
    }
  } catch { stats = null; statsBasis = 'none'; }

  const deadline = Date.now() + SOFT_MS;
  const forms = await mapLimit(ids, CONC, async (id) => {
    if (Date.now() > deadline) return [id, []]; // out of budget: the profile still renders
    return [id, await teamForm(leaguePath, id, season)];
  });

  const teams = {};
  for (const [id, form] of forms) {
    const s = stats?.teams?.[id];
    teams[id] = {
      form,
      gamesPlayed: s?.gamesPlayed ?? 0,
      offense: s?.offense || {},
      defense: s?.defense || {},
    };
  }
  return { statsSeason, statsBasis, leagueSize: stats?.count || 0, teams };
}
