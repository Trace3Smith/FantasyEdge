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
// EARLY SEASON, AND THE CROSSOVER. A season's ranks are noise until a team has actually played:
// in Week 1 the CFB leaderboard carries 16 teams, most with one game. So each team is placed on
// a basis of its own — the current season once it clears MIN_GP games, the last completed season
// until then — and crosses over on its own schedule as the year fills in. This is per TEAM, not
// per league: a team off a bye with two games does not get ranked on two games just because the
// rest of the conference has four, and a team that started early is not held on last year's
// numbers waiting for everyone else.
//
// A team's basis is also gated on the RANKING POPULATION, because a rank is only as meaningful as
// the field it's drawn from. Note that being listed is not the same as having played: ESPN's 2026
// CFB leaderboard already carries 138 teams in Week 1, nearly all with zero games, so a team with
// one game under its belt would "rank" against 137 teams that have produced nothing. The gate is
// therefore on how many teams have played MIN_GP games, not on how many are listed. That makes
// the rule two-part and both parts are needed: the team itself must have a real sample (per team),
// and so must the league it is being ranked within (per league). In practice both clear around
// Week 5, which is about when season ranks start meaning anything anyway.
//
// BOTH seasons are kept for every team, which is what makes the matchup line honest. Ranks are
// only comparable inside one population, so an offense ranked on 2026 cannot be set against a
// defense ranked on 2025 — the panel picks the newest season BOTH teams share and says which it
// used. Holding both costs ~400 bytes a team and removes the whole class of mixed-basis nonsense.
//
// COST. A completed season's numbers never change, so the prior-season leaderboard is cached in
// Redis without expiry (byteamKey) — fetched once per league per season, then free. Only the
// in-progress season is fetched live on each build. Recent form backfills across the same
// boundary, tagging each game's season.
import { getJson } from './espn.js';
import { redis, byteamKey } from './kv.js';

// HOST: site.web.api, NOT site.api — the latter is blocked from Vercel's egress (see espn.js).
const BYTEAM = (lg, season) =>
  `https://site.web.api.espn.com/apis/common/v3/sports/${lg}/statistics/byteam?season=${season}&seasontype=2&limit=400`;
const SCHEDULE = (lg, id, season) =>
  `https://site.web.api.espn.com/apis/site/v2/sports/${lg}/teams/${id}/schedule?season=${season}`;

const FORM_GAMES = 5;   // recent results shown per team
const MIN_GP = 4;       // games below which a team's own ranks are too noisy to lean on
const MIN_FIELD = 0.75; // share of the league that must be ON the leaderboard for its ranks to count
const CONC = 6;         // parallel schedule fetches — same bounded-concurrency shape as nflDvp
const SOFT_MS = 25000;  // soft budget; past it we stop fetching form and keep what we have

// Bump when the teamReports payload SHAPE changes — api/sports.js treats a cached feed built
// against an older version as stale and rebuilds it once, so a deploy self-heals rather than
// feeding the new page an object it can't read.
export const TEAM_REPORT_VERSION = 2;

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

// leagueStats for a season, through the cache when the season is over. A finished season is
// immutable, so it is fetched once per league and then read from Redis forever after; the
// in-progress season always goes to the network. Cache failures are non-fatal in both
// directions — a miss just costs the fetch we were going to make anyway.
async function leagueStatsCached(leaguePath, season, { immutable }) {
  if (!immutable) return leagueStats(leaguePath, season);
  const key = byteamKey(leaguePath, season);
  try {
    const hit = await redis.get(key);
    if (hit?.count) return hit;
  } catch { /* fall through to the network */ }
  const fresh = await leagueStats(leaguePath, season);
  // Never cache an empty answer — that would pin a transient ESPN failure in place for good.
  if (fresh.count) { try { await redis.set(key, fresh); } catch { /* serving it matters, storing it doesn't */ } }
  return fresh;
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

// THE CROSSOVER RULE. Are the current season's ranks credible for this team yet? Two gates, both
// required: the team has its own real sample, and enough of the league does too for a rank drawn
// from it to mean anything. `ratedSize` counts teams that have PLAYED MIN_GP games, not teams
// listed — ESPN lists a team from the schedule release, long before it has produced a yard.
export function currentSeasonRankable({ gamesPlayed, ratedSize, fullFieldSize }) {
  const fieldOk = !fullFieldSize || ratedSize >= fullFieldSize * MIN_FIELD;
  return gamesPlayed >= MIN_GP && fieldOk;
}

// Which season's numbers a team is READ on: the current one once it's rankable, else the last
// completed one, else nothing. A season is only ever offered here if it also passed the storage
// rule below, so a basis always names numbers that are actually worth showing.
export function basisFor({ hasCurrent, hasPrior }) {
  if (hasCurrent) return 'season';
  if (hasPrior) return 'prior-season';
  return 'none';
}

// Build the expandable report for every team on a slate.
//   leaguePath — ESPN sport/league segment, e.g. 'football/nfl' or 'football/college-football'
//   season     — the scoreboard's season year
//   teamIds    — ESPN team ids appearing on the slate (deduped by the caller or here)
// Returns { v, season, priorSeason, leagueSizes, ratedCounts, teams }, where each team carries its recent
// form, the basis it should be READ on, and BOTH seasons' stats under `seasons` so a matchup can
// find a basis the two teams share. Best-effort throughout: a failure anywhere degrades to a
// smaller report, never a thrown slate.
export async function buildTeamReports({ leaguePath, season, teamIds }) {
  const ids = [...new Set((teamIds || []).filter(Boolean).map(String))];
  const prior = season ? season - 1 : null;
  const empty = { v: TEAM_REPORT_VERSION, season, priorSeason: prior, leagueSizes: {}, ratedCounts: {}, teams: {} };
  if (!ids.length || !season) return empty;

  // Both seasons, independently best-effort. The prior one is the fallback AND the shared basis
  // for a mixed matchup, so it is worth having even when the current season is healthy; it comes
  // from cache after its first fetch, so asking for it every build is close to free.
  const [cur, prev] = await Promise.all([
    leagueStatsCached(leaguePath, season, { immutable: false }).catch(() => null),
    leagueStatsCached(leaguePath, prior, { immutable: true }).catch(() => null),
  ]);
  // `leagueSizes` is the denominator a rank is shown against (ESPN ranks across everyone listed);
  // `ratedCounts` is how many of those have actually played, which is what gates the crossover and
  // what makes a stalled build legible in the cron summary.
  const leagueSizes = { [season]: cur?.count || 0, [prior]: prev?.count || 0 };
  const ratedCounts = { [season]: cur?.rated || 0, [prior]: prev?.rated || 0 };

  const deadline = Date.now() + SOFT_MS;
  const forms = await mapLimit(ids, CONC, async (id) => {
    if (Date.now() > deadline) return [id, []]; // out of budget: the profile still renders
    return [id, await teamForm(leaguePath, id, season)];
  });

  // STORAGE RULE. A season is kept for a team only if its ranks are worth reading — real stats on
  // both sides of the ball, and, for the in-progress season, the crossover rule satisfied. This is
  // what keeps a matchup honest: the panel pairs two teams on the newest season they BOTH have, so
  // a season nobody should be ranked on must never be in the map at all. ESPN lists teams before
  // they play, with every stat zero and no rank, and without this those zeros would look like a
  // shared 2026 basis and get compared.
  const usable = (st) => !!st?.offense?.yardsPerGame && !!st?.defense?.yardsPerGame?.rank;

  const teams = {};
  for (const [id, form] of forms) {
    const c = cur?.teams?.[id], p = prev?.teams?.[id];
    const gamesPlayed = c?.gamesPlayed ?? 0;
    const hasCurrent = usable(c) && currentSeasonRankable({
      gamesPlayed,
      ratedSize: cur?.rated || 0,
      fullFieldSize: prev?.count || 0,
    });
    const hasPrior = usable(p);
    const basis = basisFor({ hasCurrent, hasPrior });
    const seasons = {};
    if (hasCurrent) seasons[season] = { gamesPlayed, offense: c.offense, defense: c.defense };
    if (hasPrior) seasons[prior] = { gamesPlayed: p.gamesPlayed ?? 0, offense: p.offense, defense: p.defense };
    teams[id] = {
      form,
      gamesPlayed,
      basis,
      basisSeason: basis === 'season' ? season : basis === 'prior-season' ? prior : null,
      seasons,
    };
  }
  return { v: TEAM_REPORT_VERSION, season, priorSeason: prior, leagueSizes, ratedCounts, teams };
}
