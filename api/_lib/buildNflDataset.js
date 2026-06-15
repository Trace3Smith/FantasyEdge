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
  rec.trend = i < 10 ? 'up' : i > 35 ? 'down' : 'flat';
  rec.trendVal = i < 10 ? '+' + (10 - i) : i > 35 ? '-' + (i - 35) : '0';
  rec.own = Math.max(10, 99 - i * 2);
  rec.tag = i < 5 ? 'fire' : i < 15 ? 'trending' : i > 40 ? 'slump' : null;
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

// --- DST: core team statistics + standings points-allowed --------------------
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

  // Fetch every team's core defensive stat line in parallel.
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
        return {
          id: 'dst-' + tm.id,
          name: tm.name + ' D/ST',
          team: tm.abbr,
          league: null,
          pos: 'DST',
          hasStats: true,
          fp: r1(fp), fpPpr: r1(fp), fpStd: r1(fp), // no receptions: same in both formats
          s1: String(sacks), s2: String(int), s3: String(fr),
          s4: String(td), s5: String(tm.pa), s6: r1(fp).toFixed(1),
          statLabels: ['Sack', 'INT', 'FR', 'TD', 'PA', 'FPTS'],
          cats: dstCats(n),
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

export async function buildNflDataset() {
  const { athletes, categories, season } = await fetchByAthlete({
    sportPath: 'football/nfl',
    sort: 'scoring.totalPoints:desc',
    limit: 1000,
  });
  const seasonYear = parseInt(season, 10) || new Date().getFullYear();
  const idx = buildIndex(categories);
  const val = makeReader(idx);

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
    }
    rec._games = games;
    skill.push(rec);
  }

  // DST is additive and failure-tolerant — skill players still rank without it.
  let dsts = [];
  try {
    dsts = await buildDsts(seasonYear);
  } catch {
    dsts = [];
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

  const players = [...ranked, ...subThreshold];
  for (const r of players) delete r._games;

  return {
    builtAt: new Date().toISOString(),
    sport: 'nfl',
    players,
    counts: {
      season,
      athletes: athletes.length,
      ranked: ranked.length,
      dsts: dsts.length,
      subThreshold: subThreshold.length,
      total: players.length,
    },
  };
}
