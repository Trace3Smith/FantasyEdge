// NFL data assembly for FantasyEdge. Unlike the roto sports (MLB/NBA/NHL), fantasy
// football is POINTS-based, so there's no z-score: every player gets a fantasy-
// point total and the whole league is ranked on one scale (the "overall big
// board"), with the position filter (QB/RB/WR/TE/K/DST) subsetting it.
//
// Each player carries BOTH scoring totals — fpPpr (1 pt per reception) and fpStd
// (no reception bonus; fpStd = fpPpr − receptions) — so the frontend's Standard vs
// PPR toggle just re-sorts/re-ranks client-side with no rebuild. fp (= fpPpr) is
// the default used for the server-side rank/badges; K and DST have no receptions so
// the two totals are equal.
//
// Two data sources, both ESPN, both regular season (seasonType=2):
//   1. Skill players (QB/RB/WR/TE/K) — the byathlete leaderboard, sorted by
//      scoring.totalPoints (the broadest pool, ~1700 athletes). PPR scoring is
//      computed from passing/rushing/receiving/kicking stat lines.
//   2. DST (team defense/special teams) — NOT an athlete, so it comes from the
//      core team-statistics endpoint (sacks, takeaways, def TDs, safeties, blocked
//      kicks) plus the standings endpoint (points allowed, the biggest DST factor).
//      DST is optional: if either team source fails we still return skill players.
//
// Output shape matches the other sports so the same frontend renders it; per-row
// statLabels drive the inline column labels in the mixed ALL view (like NHL).

import { fetchByAthlete, buildIndex, makeReader } from './espn.js';
import { getJson } from './espn.js';

// Standard PPR scoring weights.
const PASS_YD = 0.04, PASS_TD = 4, PASS_INT = -2;
const RUSH_YD = 0.1, RUSH_TD = 6;
const REC = 1, REC_YD = 0.1, REC_TD = 6;
const FUMBLE_LOST = -2, TWO_PT = 2;

// Kicking: distance-tiered field goals + extra points.
const FG_SHORT = 3, FG_40 = 4, FG_50 = 5, XP = 1;

// DST scoring.
const DST_SACK = 1, DST_INT = 2, DST_FR = 2, DST_TD = 6, DST_SAFETY = 2, DST_BLK = 2;

// Overall-board slot the top kicker should land near (~12th round, 12-team). This
// anchor also sets the top kicker's displayed point total to the board value there
// (~115-140), which doubles as the fix for ESPN's inflated raw kicker counts.
const KICKER_TARGET_RANK = 140;

// Fantasy positions we keep; everything else (OL, DL, LB, DB, P, LS) is dropped.
// ESPN labels kickers "PK" and has fullbacks "FB"; we fold those into K and RB.
const POS_MAP = { QB: 'QB', RB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', PK: 'K' };

// Per-game points-allowed -> DST fantasy points (standard ESPN/Yahoo tiers).
function paPoints(perGame) {
  if (perGame <= 0) return 10;
  if (perGame <= 6) return 7;
  if (perGame <= 13) return 4;
  if (perGame <= 20) return 1;
  if (perGame <= 27) return 0;
  if (perGame <= 34) return -1;
  return -4;
}

const r1 = (v) => Math.round(v * 10) / 10; // one-decimal round

// Scale kickers so the top kicker lands ~KICKER_TARGET_RANK on the board. Mutates
// kicker records in place. Two things are decoupled here, because a kicker's raw
// points are inflated AND identical across formats while the players it competes
// with are not:
//   • DISPLAYED points (fpPpr/fpStd, shown in the FPTS column) — one PPR-anchored
//     factor, so the top kicker reads a realistic ~115-140 in BOTH formats.
//   • RANKING value (fp for the default/PPR board, rankStd for Standard) — anchored
//     to each format's own distribution, so the kicker stays in the late rounds in
//     both views even though Standard skill players score less.
// Only ever scales kickers down (factors clamped to <= 1).
function scaleKickers(skill, dsts) {
  const kickers = skill.filter((r) => r.pos === 'K' && r.fp > 0);
  if (!kickers.length) return;
  const others = [...skill.filter((r) => r.pos !== 'K' && r.fp > 0 && r._games > 0), ...dsts];
  if (!others.length) return;
  const idx = Math.min(KICKER_TARGET_RANK - 1, others.length - 1);
  const anchorPpr = others.map((r) => r.fpPpr).sort((a, b) => b - a)[idx];
  const anchorStd = others.map((r) => r.fpStd).sort((a, b) => b - a)[idx];
  const topK = Math.max(...kickers.map((k) => k.fpPpr));
  const dispScale = Math.min(1, anchorPpr / topK); // display + PPR rank
  const stdRankScale = Math.min(1, anchorStd / topK); // Standard rank only

  for (const k of kickers) {
    const raw = k.fpPpr;
    k.fpPpr = r1(raw * dispScale); // displayed total (same in both formats)
    k.fpStd = k.fpPpr;
    k.fp = k.fpPpr; // default board ranks on PPR
    k.rankStd = r1(raw * stdRankScale); // Standard-board ranking value (not displayed)
    k.s6 = k.fpPpr.toFixed(1);
  }
}

// Cosmetic trend/own/tag from rank — identical formula to the other sports.
function decorate(rec, i) {
  rec.rank = i + 1;
  rec.emoji = '🏈';
  rec.trend = 'flat';   // real HOT/COLD form is applied later by enrichForm (cron)
  rec.trendVal = '';
  rec.own = Math.max(10, 99 - i * 2);
  rec.tag = null;       // no rank-based badges; HOT/COLD come from recent form
}

// Category-strength pills (drive the star count). The categories mirror the PPR
// scoring inputs shown in the roto banner.
function skillCats(pos, n) {
  const cats = [];
  if (pos === 'QB') {
    if (n.passYd >= 4000) cats.push('PaYd');
    if (n.passTD >= 25) cats.push('PaTD');
    if (n.rushYd >= 400) cats.push('RuYd');
    if (n.rushTD >= 4) cats.push('RuTD');
  } else if (pos === 'K') {
    if (n.fgm >= 25) cats.push('FG');
    if (n.xpm >= 35) cats.push('XP');
  } else {
    if (n.rushYd >= 800) cats.push('RuYd');
    if (n.rushTD >= 7) cats.push('RuTD');
    if (n.rec >= 70) cats.push('Rec');
    if (n.recYd >= 900) cats.push('ReYd');
    if (n.recTD >= 6) cats.push('ReTD');
  }
  return cats;
}

function dstCats(n) {
  const cats = [];
  if (n.sacks >= 40) cats.push('Sack');
  if (n.int >= 14) cats.push('INT');
  if (n.fr >= 10) cats.push('FR');
  if (n.td >= 3) cats.push('TD');
  if (n.paPerGame <= 19) cats.push('PA');
  return cats;
}

// --- DST + team offensive context: core team statistics + standings points-allowed --------------
// Returns { dsts, teamContext }. Phase 2 (see docs/nfl-phase2-context-scoping.md) piggybacks the
// per-team statistics fetch this already does for DST to ALSO capture each team's offensive
// context — total receiving targets (denominator for a pass-catcher's target share) and offensive
// plays per game (the pace signal) — so the opportunity modifiers cost no extra network calls.
// teamContext is keyed by ESPN team id (a String), the reliable join key back to each skill
// player's `teamId` (team abbreviations can drift between endpoints).
async function buildDsts(season) {
  const standUrl = `https://site.web.api.espn.com/apis/v2/sports/football/nfl/standings?region=us&lang=en&season=${season}&seasontype=2`;
  const stand = await getJson(standUrl);
  const teams = []; // { id, abbr, name, pa, games }
  for (const conf of stand.children || []) {
    for (const e of conf.standings?.entries || []) {
      const t = e.team || {};
      const stats = e.stats || [];
      const pa = stats.find((s) => s.name === 'pointsAgainst')?.value ?? 0;
      const wins = stats.find((s) => s.name === 'wins')?.value ?? 0;
      const losses = stats.find((s) => s.name === 'losses')?.value ?? 0;
      const ties = stats.find((s) => s.name === 'ties')?.value ?? 0;
      teams.push({ id: t.id, abbr: t.abbreviation, name: t.displayName, pa, games: wins + losses + ties });
    }
  }

  const coreStat = (cats, cat, name) => {
    const c = cats.find((x) => x.name === cat);
    const s = c?.stats?.find((y) => y.name === name);
    return s ? (s.value ?? 0) : 0;
  };

  // Fetch every team's core stat line in parallel — one call per team drives BOTH the DST record
  // and the offensive-context entry.
  const results = await Promise.all(
    teams.map(async (tm) => {
      try {
        const j = await getJson(
          `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/types/2/teams/${tm.id}/statistics`
        );
        const cats = (j.splits || j).categories || [];
        const games = tm.games || coreStat(cats, 'general', 'gamesPlayed') || 1;
        const sacks = coreStat(cats, 'defensive', 'sacks');
        const int = coreStat(cats, 'defensiveInterceptions', 'interceptions');
        const fr = coreStat(cats, 'general', 'fumblesRecovered');
        const safeties = coreStat(cats, 'defensive', 'safeties');
        const blk = coreStat(cats, 'defensive', 'kicksBlocked');
        const td =
          coreStat(cats, 'defensive', 'defensiveTouchdowns') +
          coreStat(cats, 'returning', 'kickReturnTouchdowns') +
          coreStat(cats, 'returning', 'puntReturnTouchdowns');
        const paPerGame = games > 0 ? tm.pa / games : tm.pa;
        const fp =
          sacks * DST_SACK + int * DST_INT + fr * DST_FR + td * DST_TD +
          safeties * DST_SAFETY + blk * DST_BLK + paPoints(paPerGame) * games;
        const n = { sacks, int, fr, td, safeties, blk, pa: tm.pa, paPerGame };
        const dst = {
          id: 'dst-' + tm.id,
          name: tm.name + ' D/ST',
          team: tm.abbr,
          league: null,
          pos: 'DST',
          hasStats: true,
          games, // team games played — surfaces as the GP column
          fp: r1(fp), fpPpr: r1(fp), fpStd: r1(fp), // no receptions: same in both formats
          s1: String(sacks), s2: String(int), s3: String(fr),
          s4: String(td), s5: String(tm.pa), s6: r1(fp).toFixed(1),
          statLabels: ['Sack', 'INT', 'FR', 'TD', 'PA', 'FPTS'],
          cats: dstCats(n),
        };
        // Phase 2 offensive context: team receiving targets + offensive pace, keyed by team id.
        const targets = coreStat(cats, 'receiving', 'receivingTargets');
        const plays = coreStat(cats, 'passing', 'totalOffensivePlays');
        const ctx = { id: String(tm.id), abbr: tm.abbr, targets, plays, games, playsPerGame: games > 0 ? plays / games : 0 };
        return { dst, ctx };
      } catch {
        return null;
      }
    })
  );
  const dsts = [];
  const teamContext = {};
  for (const r of results) {
    if (!r) continue;
    dsts.push(r.dst);
    if (r.ctx?.id != null) teamContext[r.ctx.id] = r.ctx;
  }
  return { dsts, teamContext };
}

// Prior full-season line for the Mock Draft sidebar, keyed by athlete id. Shows only the volume
// categories the player actually produced in (so a QB shows passing, a WR receiving), with total
// touchdowns as the headline. Additive and failure-tolerant (empty map on any error).
async function fetchPrevYearNfl(priorSeasonParam) {
  const out = new Map();
  if (!Number.isFinite(priorSeasonParam)) return out;
  try {
    const { athletes, categories, season } = await fetchByAthlete({ sportPath: 'football/nfl', sort: 'scoring.totalPoints:desc', season: priorSeasonParam, tolerant: true });
    const val = makeReader(buildIndex(categories));
    for (const a of athletes) {
      const at = a.athlete || {};
      if (at.id == null) continue;
      const num = (c, k) => val(a, c, k) || 0;
      const passYd = num('passing', 'passingYards'), passTD = num('passing', 'passingTouchdowns'), passInt = num('passing', 'interceptions');
      const rushYd = num('rushing', 'rushingYards'), rushTD = num('rushing', 'rushingTouchdowns');
      const rec = num('receiving', 'receptions'), recYd = num('receiving', 'receivingYards'), recTD = num('receiving', 'receivingTouchdowns');
      const fumLost = num('rushing', 'rushingFumblesLost') + num('receiving', 'receivingFumblesLost');
      const twoPt = num('scoring', 'totalTwoPointConvs');
      const raw = [
        ['PaYd', passYd], ['PaTD', passTD], ['RuYd', rushYd], ['RuTD', rushTD],
        ['Rec', rec], ['ReYd', recYd], ['ReTD', recTD],
      ];
      const line = raw.filter(([, v]) => v > 0).map(([cat, v]) => ({ cat, val: String(v) }));
      if (!line.length) continue;
      const totalTD = passTD + rushTD + recTD;
      // Prior-season fantasy points in the SAME scoring as the current-season build, so the blend
      // model can regress this season's pace toward last year's actual production. Half is exact.
      const ppr = passYd * PASS_YD + passTD * PASS_TD + passInt * PASS_INT + rushYd * RUSH_YD +
        rushTD * RUSH_TD + rec * REC + recYd * REC_YD + recTD * REC_TD + fumLost * FUMBLE_LOST + twoPt * TWO_PT;
      const std = ppr - rec * REC;
      out.set(String(at.id), {
        season, headline: totalTD > 0 ? `${totalTD} TD` : '', line,
        pts: { ppr: r1(ppr), std: r1(std), half: r1((ppr + std) / 2) },
      });
    }
  } catch { /* prior season unavailable — no-op */ }
  return out;
}

// ---- Current team affiliation -----------------------------------------------------------------
// The byathlete leaderboard reports each athlete alongside the team they played for in the STAT
// season, not the team they are on now. That is correct for the stats and wrong for everything else:
// after an offseason of trades and signings ~20% of the pool showed a stale team (A.J. Brown as PHI,
// Kenneth Walker as SEA, Wan'Dale Robinson as NYG). It was never a caching or refresh problem — the
// cron re-reads this feed daily, the field just means "2025 team". ESPN has the current answer on the
// per-team roster endpoint, so we overwrite from there, joined on the ESPN athlete id (exact — no
// name matching, so none of the collision risk that carries).
const TEAMS_URL = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40';
const ROSTER_URL = (id) => `https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/teams/${id}/roster`;
// Fallback roster source. The site roster endpoint is not uniformly available: Arizona (team 22)
// returns an empty 216-byte body every time, on both hosts and for both the numeric id and the `ari`
// abbreviation — an upstream gap, not a transient error. Left alone that silently excludes a whole
// team from team correction AND from injury coverage. The core API lists the same squad (79 athletes
// for ARI) as $ref URLs with the athlete id in the path, which is all we need for an id join.
const CORE_ROSTER_URL = (season, id) =>
  `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/teams/${id}/athletes?limit=200`;
const REF_ID = /\/athletes\/(\d+)/;

// ESPN's structured injury designations. Same shape of gap as the stale-team bug: the data exists and
// we were not reading it. 800 entries league-wide (Injured Reserve, Questionable, Out, Suspension,
// plus Active for players who have recovered), each with the body part, a return date where known,
// and a sourced beat-writer comment. NOTE the entries carry NO athlete.id field — the id is only in
// athlete.links (…/nfl/player/_/id/<id>/…), so we parse it rather than fall back to name matching.
const INJURIES_URL = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/injuries';
const LINK_ID = /\/id\/(\d+)/;

// athleteId -> { abbr, teamId } across all 32 current rosters. Failure-tolerant: a team whose roster
// fails is simply absent, which costs corrections but never invents them. Returns { index, teams }.
async function fetchCurrentTeams(season) {
  const index = new Map();
  let teams = 0, fellBack = 0;
  try {
    const list = await getJson(TEAMS_URL);
    const meta = (list?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t?.team).filter((t) => t?.id);
    const results = await Promise.all(meta.map(async (t) => {
      const teamId = String(t.id), abbr = t.abbreviation;
      let rows = [];
      try {
        const j = await getJson(ROSTER_URL(teamId));
        for (const grp of (j?.athletes || [])) for (const a of (grp?.items || [])) {
          if (a?.id != null) rows.push([String(a.id), { abbr, teamId }]);
        }
      } catch { rows = []; }
      if (rows.length) return { rows, fallback: false };
      // Empty is the Arizona signature, so try the core API before giving up on the whole squad.
      try {
        const c = await getJson(CORE_ROSTER_URL(season, teamId));
        for (const it of (c?.items || [])) {
          const m = REF_ID.exec(it?.$ref || '');
          if (m) rows.push([m[1], { abbr, teamId }]);
        }
      } catch { /* both sources failed for this team */ }
      return { rows, fallback: rows.length > 0 };
    }));
    for (const r of results) {
      if (!r?.rows?.length) continue;
      teams++;
      if (r.fallback) fellBack++;
      for (const [k, v] of r.rows) index.set(k, v);
    }
  } catch { /* no index — every team stays as the stat feed reported it */ }
  return { index, teams, fellBack };
}

// athleteId -> injury record, from the league injuries feed. Failure-tolerant: an empty map simply
// means no player carries an injury this build.
async function fetchInjuries() {
  const index = new Map();
  try {
    const j = await getJson(INJURIES_URL);
    for (const t of (j?.injuries || [])) {
      for (const e of (t?.injuries || [])) {
        const href = (e?.athlete?.links || []).map((l) => l?.href).find((h) => LINK_ID.test(h || ''));
        const m = href && LINK_ID.exec(href);
        if (!m) continue;
        index.set(m[1], {
          status: e.status || null,                                   // Questionable | Out | Injured Reserve | Suspension | Active
          abbr: e.type?.abbreviation || null,                         // Q | O | IR | SUSP …
          // "Ankle Sprain". ESPN fills unknown sub-fields with the literal "Not Specified", which reads
          // as noise next to a real body part ("Head Not Specified"), so those are dropped.
          detail: [e.details?.type, e.details?.detail]
            .filter((x) => x && x !== 'Not Specified' && x !== 'Undisclosed').join(' ') || null,
          returnDate: e.details?.returnDate || null,
          date: e.date || null,
          // shortComment (a sourced beat-writer line) is deliberately NOT carried. The structured
          // status/body-part/return-date are official designations and safe to state; a quoted report
          // is journalism, and some entries are personal or off-field matters where restating a
          // sentence about a real person is a different order of risk. Link out, never paraphrase.
        });
      }
    }
  } catch { /* no injuries this build */ }
  return index;
}

// Pure merge, exported for the checker. Attaches p.injury ONLY for designations that actually affect
// availability. "Active" in this feed means a listed player who has recovered — attaching it would
// badge healthy players, so it is skipped (and clears any stale record).
const INJURY_SHOW = new Set(['Injured Reserve', 'Out', 'Doubtful', 'Questionable', 'Suspension']);
export function applyInjuries(players, index) {
  let flagged = 0, cleared = 0;
  for (const r of players || []) {
    if (r.pos === 'DST') continue;
    const e = index.get(String(r.id));
    if (e && INJURY_SHOW.has(e.status)) { r.injury = e; flagged++; }
    else if (r.injury) { delete r.injury; cleared++; }
  }
  return { flagged, cleared };
}

// Pure merge, exported for the checker. Overwrites team/teamId ONLY where the roster index has the
// athlete. A player who is absent is LEFT ALONE and never marked a free agent: absence is ambiguous
// (one failed roster fetch drops a whole team — a real run lost all of Arizona, including a top-30
// TE), so inferring "no team" from it would confidently publish a falsehood. DST rows ARE a team and
// are skipped; Sleeper-seeded rows already carry current teams from that feed.
export function applyCurrentTeams(players, index) {
  let corrected = 0, confirmed = 0, unmatched = 0;
  for (const r of players || []) {
    if (r.pos === 'DST' || String(r.id).startsWith('sleeper-')) continue;
    const cur = index.get(String(r.id));
    if (!cur || !cur.abbr) { unmatched++; continue; }
    if (r.team !== cur.abbr) { r.team = cur.abbr; corrected++; } else confirmed++;
    if (cur.teamId) r.teamId = cur.teamId;
  }
  return { corrected, confirmed, unmatched };
}

export async function buildNflDataset() {
  const { athletes, categories, season, skipped } = await fetchByAthlete({
    sportPath: 'football/nfl',
    sort: 'scoring.totalPoints:desc',
  });
  const seasonYear = parseInt(season, 10) || new Date().getFullYear();
  const idx = buildIndex(categories);
  const val = makeReader(idx);
  // Prior full season (one year back). Additive; failure-tolerant. Matched by athlete id below.
  const prevMap = await fetchPrevYearNfl(seasonYear - 1);

  const skill = [];
  for (const a of athletes) {
    const at = a.athlete || {};
    if (at.id == null) continue;
    const pos = POS_MAP[at.position?.abbreviation];
    if (!pos) continue; // non-fantasy position
    const v = (c, nm) => val(a, c, nm) || 0;
    const games = v('general', 'gamesPlayed');

    const base = {
      id: at.id,
      name: at.displayName || `${at.firstName || ''} ${at.lastName || ''}`.trim() || 'Unknown',
      team: at.teamShortName || at.teamName || '—',
      teamId: at.teamId != null ? String(at.teamId) : null, // join key to teamContext (Phase 2)
      league: null,
      pos,
      hasStats: true,
    };

    let rec;
    if (pos === 'K') {
      const fgShort = v('kicking', 'fieldGoalsMade1_19') + v('kicking', 'fieldGoalsMade20_29') + v('kicking', 'fieldGoalsMade30_39');
      const fg40 = v('kicking', 'fieldGoalsMade40_49');
      const fg50 = v('kicking', 'fieldGoalsMade50');
      const xpm = v('kicking', 'extraPointsMade');
      const n = {
        fgm: v('kicking', 'fieldGoalsMade'),
        fga: v('kicking', 'fieldGoalAttempts'),
        fgPct: v('kicking', 'fieldGoalPct'),
        lng: v('kicking', 'longFieldGoalMade'),
        xpm,
        games,
      };
      const fp = fgShort * FG_SHORT + fg40 * FG_40 + fg50 * FG_50 + xpm * XP;
      rec = {
        ...base, fp: r1(fp), fpPpr: r1(fp), fpStd: r1(fp), // kickers: no receptions
        s1: String(n.fgm), s2: String(n.fga), s3: n.fgPct ? n.fgPct.toFixed(1) : '—',
        s4: String(xpm), s5: n.lng ? String(n.lng) : '—', s6: r1(fp).toFixed(1),
        statLabels: ['FGM', 'FGA', 'FG%', 'XPM', 'LNG', 'FPTS'],
        cats: skillCats('K', n),
      };
    } else {
      const n = {
        passYd: v('passing', 'passingYards'),
        passTD: v('passing', 'passingTouchdowns'),
        passInt: v('passing', 'interceptions'),
        rushYd: v('rushing', 'rushingYards'),
        rushTD: v('rushing', 'rushingTouchdowns'),
        rec: v('receiving', 'receptions'),
        recYd: v('receiving', 'receivingYards'),
        recTD: v('receiving', 'receivingTouchdowns'),
        tgt: v('receiving', 'receivingTargets'),
        fumLost: v('rushing', 'rushingFumblesLost') + v('receiving', 'receivingFumblesLost'),
        twoPt: v('scoring', 'totalTwoPointConvs'),
        games,
      };
      const fpPpr =
        n.passYd * PASS_YD + n.passTD * PASS_TD + n.passInt * PASS_INT +
        n.rushYd * RUSH_YD + n.rushTD * RUSH_TD +
        n.rec * REC + n.recYd * REC_YD + n.recTD * REC_TD +
        n.fumLost * FUMBLE_LOST + n.twoPt * TWO_PT;
      const fpStd = fpPpr - n.rec * REC; // Standard scoring drops the per-reception point

      // Position-appropriate display columns.
      let cols, labels;
      if (pos === 'QB') {
        cols = [n.passYd, n.passTD, n.passInt, n.rushYd, n.rushTD];
        labels = ['PaYd', 'PaTD', 'INT', 'RuYd', 'RuTD', 'FPTS'];
      } else if (pos === 'RB') {
        cols = [n.rushYd, n.rushTD, n.rec, n.recYd, n.recTD];
        labels = ['RuYd', 'RuTD', 'Rec', 'ReYd', 'ReTD', 'FPTS'];
      } else {
        cols = [n.rec, n.recYd, n.recTD, n.tgt, n.rushYd]; // WR / TE
        labels = ['Rec', 'ReYd', 'ReTD', 'Tgt', 'RuYd', 'FPTS'];
      }
      rec = {
        ...base, fp: r1(fpPpr), fpPpr: r1(fpPpr), fpStd: r1(fpStd),
        s1: String(cols[0]), s2: String(cols[1]), s3: String(cols[2]),
        s4: String(cols[3]), s5: String(cols[4]), s6: r1(fpPpr).toFixed(1),
        statLabels: labels,
        cats: skillCats(pos, n),
      };
      rec.tgt = n.tgt; // player receiving targets on every pass-catcher (QB ~0); feeds target share (Phase 2)
    }
    rec._games = games;
    rec.games = games; // season games played — surfaces as the GP column (public; _games is stripped below)
    skill.push(rec);
  }

  // DST + team offensive context are additive and failure-tolerant — skill players still rank
  // without them (an empty teamContext simply makes the Phase 2 opportunity modifiers a no-op).
  let dsts = [];
  let teamContext = {};
  try {
    const built = await buildDsts(seasonYear);
    dsts = built.dsts;
    teamContext = built.teamContext;
  } catch {
    dsts = [];
    teamContext = {};
  }

  // Positional scaling for kickers. Raw kicker points are deceptively high (a top
  // kicker out-scores most starters), but kickers carry almost no draft value —
  // they go in the last 1-2 rounds because week-to-week output is near-random and
  // replacement level is high. We scale every kicker's points so the BEST kicker
  // lands at roughly the fantasy-point level of the player at KICKER_TARGET_RANK
  // on the rest of the board (~12th-14th round in a 12-team league); the rest scale
  // proportionally and fall in below it. Anchoring to the live board (rather than a
  // hardcoded multiplier) keeps it correct as the point distribution shifts season
  // to season. We only ever scale kickers DOWN (clamped at 1).
  scaleKickers(skill, dsts);

  // One overall board: rank every contributor (skill + DST) by PPR total. Players
  // who never produced (0 games or non-positive points) drop to search-only.
  const all = [...skill, ...dsts];
  const ranked = all.filter((r) => r.fp > 0 && (r.pos === 'DST' || r._games > 0));
  const subThreshold = all.filter((r) => !(r.fp > 0 && (r.pos === 'DST' || r._games > 0)));

  ranked.sort((a, b) => b.fp - a.fp);
  ranked.forEach(decorate);
  for (const r of subThreshold) {
    r.searchOnly = true;
    r.emoji = '🏈';
  }

  const maxGames = skill.reduce((m, r) => Math.max(m, r._games || 0), 0); // for enrichForm
  const players = [...ranked, ...subThreshold];

  // Replace stat-season teams with current ones (see fetchCurrentTeams). After `players` is
  // assembled so both ranked and search-only rows are corrected in one pass.
  const { index: teamIndex, teams: rostersOk, fellBack } = await fetchCurrentTeams(seasonYear);
  const teamFix = applyCurrentTeams(players, teamIndex);
  const injFix = applyInjuries(players, await fetchInjuries());
  for (const r of players) {
    const pv = prevMap.get(String(r.id));
    if (pv) r.prevYear = pv; // prior full-season line for the Mock Draft sidebar (DSTs have no athlete id)
    delete r._games;
  }

  return {
    builtAt: new Date().toISOString(),
    sport: 'nfl',
    players,
    teamContext, // per-team offensive context (targets/pace) for the Phase 2 opportunity modifiers
    counts: {
      season,
      maxGames,
      athletes: athletes.length,
      unfetchable: skipped, // rows ESPN could not serialize; see fetchByAthlete
      ranked: ranked.length,
      dsts: dsts.length,
      // Team reconciliation: how many stale stat-season teams were corrected, how many already
      // agreed, and how many athletes no current roster listed (left untouched, never marked FA).
      teams: { rostersOk, fellBack, indexed: teamIndex.size, ...teamFix },
      injuries: injFix,
      subThreshold: subThreshold.length,
      total: players.length,
    },
  };
}
