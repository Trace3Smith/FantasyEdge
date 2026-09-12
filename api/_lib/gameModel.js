// The game model: turns team ratings into a predicted MARGIN and the handful of measured
// component gaps that explain it. One scorer per sport, one output shape for the card.
//
// MARGIN, NOT WIN PROBABILITY — and this is the central design decision, not a detail.
// A margin is in the same units as the betting line, so "model: Georgia -9.5 / market: -6.5" is a
// sentence that explains itself. A bare probability is not comparable to anything the reader can
// see, and ours is measurably worse than the market's: walk-forward over 1,865 games (2019-2025)
// the NFL model scores Brier 0.2260 against the market's 0.2111. So `winProb` is computed and
// carried, and `showWinProb` is FALSE — the number exists for evaluation, not for display.
// scripts/fit-nfl-model.mjs decides that flag from the backtest and writes it into
// nflModelCoef.json; nothing here re-decides it by taste.
//
// The same backtest killed the disagreement flag. Bucketing games by how far the model's line sat
// from the market's, the model's preferred side won LESS often than the market implied in the two largest
// buckets (3-6 points out: 31.9% against an implied 38.8%). A "the model
// disagrees" badge would therefore have pointed users at the wrong side, so it does not ship.
// `gates.showDisagreement` records that verdict for the renderer.
import { normCdf } from './pickem.js';
import NFL_COEF from './nflModelCoef.json' with { type: 'json' };
export const CFB_HOME_FIELD = 2.5;

// Same conversion the market pick already uses (pickem.js), deliberately: putting both numbers
// through one function means a difference between them is a difference of OPINION, not of
// arithmetic. Bounds are wider than the market's because a model line can be more extreme.
const MARGIN_SD = 13.5;
export function winProbFromMargin(margin) {
  return Math.max(0.03, Math.min(0.97, normCdf(margin / MARGIN_SD)));
}

const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;
// A component gap: one unit of one team set against the opposing unit, with both sides' measured
// values and ranks so the card can state the claim rather than assert a conclusion.
function gap({ label, side, homeVal, awayVal, homeRank, awayRank, unit, betterIsHigher = true }) {
  if (!Number.isFinite(homeVal) || !Number.isFinite(awayVal)) return null;
  const raw = homeVal - awayVal;
  return {
    label, side, unit,
    home: r3(homeVal), away: r3(awayVal),
    homeRank: homeRank ?? null, awayRank: awayRank ?? null,
    edge: betterIsHigher ? r3(raw) : r3(-raw),      // positive = favours the home team
    magnitude: Math.abs(raw),
  };
}

// The two or three gaps worth printing, largest first. Ranked by how far apart the two units are
// in RANK terms where ranks exist, because "11th vs 78th" is what a reader can act on — a raw EPA
// difference of 0.06 means nothing without the field it sits in.
function topGaps(gaps, n = 3) {
  return gaps.filter(Boolean)
    .map((g) => ({
      ...g,
      spread: (Number.isFinite(g.homeRank) && Number.isFinite(g.awayRank))
        ? Math.abs(g.homeRank - g.awayRank) : null,
    }))
    .sort((a, b) => (b.spread ?? -1) - (a.spread ?? -1) || b.magnitude - a.magnitude)
    .slice(0, n)
    .map(({ magnitude, ...g }) => { void magnitude; return g; });
}

// ---- NFL -------------------------------------------------------------------

// predicted_home_margin = intercept + netDiff * (net_home - net_away)
// The intercept IS home-field advantage (fitted at 1.67 points, 2016-2024) and is dropped at a
// neutral site — the league plays in London, Munich and São Paulo, and crediting the nominal home
// team with a home field it does not have is exactly the class of quiet wrongness espn.js warns
// about elsewhere in this codebase.
export function scoreNflGame({ ratings, homeAbbr, awayAbbr, neutralSite = false }) {
  const h = ratings?.teams?.[homeAbbr], a = ratings?.teams?.[awayAbbr];
  if (!h || !a || !Number.isFinite(h.net) || !Number.isFinite(a.net)) return null;
  const { intercept, netDiff } = NFL_COEF.coef;
  const margin = (neutralSite ? 0 : intercept) + netDiff * (h.net - a.net);
  const gaps = topGaps([
    gap({
      label: 'Home offense vs away defense', side: 'home', unit: 'EPA/play',
      homeVal: h.off, awayVal: a.def, homeRank: h.offRank, awayRank: a.defRank,
    }),
    gap({
      label: 'Away offense vs home defense', side: 'away', unit: 'EPA/play',
      homeVal: h.def, awayVal: a.off, homeRank: h.defRank, awayRank: a.offRank,
    }),
  ], 2);
  return {
    sport: 'nfl',
    season: ratings.season,
    margin: r1(margin),
    favorite: margin >= 0 ? homeAbbr : awayAbbr,
    winProb: Math.round(winProbFromMargin(margin) * 1000) / 10,
    showWinProb: NFL_COEF.gates.showWinProb,
    showDisagreement: NFL_COEF.gates.showDisagreement,
    // How much of this rating is THIS season rather than last. In Week 2 it is nearly all carried
    // over, and a card that quotes a rank without saying so is overstating what it knows.
    sampleWeight: Math.min(h.weight ?? 1, a.weight ?? 1),
    instrumentation: ratings.instrumentation,   // 'team-week'
    garbageTimeFiltered: ratings.garbageTimeFiltered, // false for the NFL — see nflRatings.js
    gaps,
    fittedAt: NFL_COEF.fittedAt,
    outOfSample: {
      brier: r3(NFL_COEF.outOfSample.modelBrier),
      marketBrier: r3(NFL_COEF.outOfSample.marketBrier),
      games: NFL_COEF.outOfSample.games,
    },
  };
}

// ---- CFB -------------------------------------------------------------------

// SP+ is published in points above average, so the rating difference IS the expected neutral-field
// margin and there is nothing to fit. Home field is added as a constant and flagged unfitted (see
// CFB_HOME_FIELD) — the honest label for a number taken from convention rather than measured here.
export function scoreCfbGame({ ratings, homeEspnId, awayEspnId, neutralSite = false }) {
  const hs = ratings?.crosswalk?.[String(homeEspnId)];
  const as = ratings?.crosswalk?.[String(awayEspnId)];
  const h = hs ? ratings.teams?.[hs] : null;
  const a = as ? ratings.teams?.[as] : null;
  if (!h || !a || !Number.isFinite(h.sp?.rating) || !Number.isFinite(a.sp?.rating)) return null;

  const hfa = neutralSite ? 0 : (ratings.homeField ?? CFB_HOME_FIELD);
  const margin = (h.sp.rating - a.sp.rating) + hfa;

  const gaps = topGaps([
    gap({
      label: 'Home offense vs away defense', side: 'home', unit: 'EPA/play',
      homeVal: h.eff?.epaOff, awayVal: a.eff?.epaDef,
      homeRank: h.ranks?.epaOff, awayRank: a.ranks?.epaDef,
    }),
    gap({
      label: 'Away offense vs home defense', side: 'away', unit: 'EPA/play',
      homeVal: h.eff?.epaDef, awayVal: a.eff?.epaOff,
      homeRank: h.ranks?.epaDef, awayRank: a.ranks?.epaOff,
    }),
    gap({
      label: 'Success rate', side: 'home', unit: 'rate',
      homeVal: h.eff?.srOff, awayVal: a.eff?.srOff,
      homeRank: h.ranks?.srOff, awayRank: a.ranks?.srOff,
    }),
    gap({
      label: 'Explosiveness', side: 'home', unit: 'per play',
      homeVal: h.eff?.explOff, awayVal: a.eff?.explOff,
      homeRank: h.ranks?.explOff, awayRank: a.ranks?.explOff,
    }),
    gap({
      label: 'Returning production', side: 'home', unit: '% PPA',
      homeVal: h.returning?.percentPPA, awayVal: a.returning?.percentPPA,
      homeRank: h.ranks?.returning, awayRank: a.ranks?.returning,
    }),
    gap({
      label: 'Recruiting talent', side: 'home', unit: 'composite',
      homeVal: h.talent, awayVal: a.talent,
      homeRank: h.ranks?.talent, awayRank: a.ranks?.talent,
    }),
  ], 3);

  return {
    sport: 'cfb',
    margin: r1(margin),
    favorite: margin >= 0 ? (h.school) : (a.school),
    winProb: Math.round(winProbFromMargin(margin) * 1000) / 10,
    // CFB HAS NOT BEEN BACKTESTED. There is no CFBD key in this environment, so
    // no out-of-sample Brier exists for college yet.
    // The gate therefore stays shut — an unvalidated number is not a better reason to show a
    // probability than a validated-and-worse one.
    showWinProb: false,
    showDisagreement: false,
    validated: false,
    sp: {
      home: { rating: r1(h.sp.rating), rank: h.sp.ranking, offense: Number.isFinite(h.sp.offense) ? r1(h.sp.offense) : null, defense: Number.isFinite(h.sp.defense) ? r1(h.sp.defense) : null },
      away: { rating: r1(a.sp.rating), rank: a.sp.ranking, offense: Number.isFinite(a.sp.offense) ? r1(a.sp.offense) : null, defense: Number.isFinite(a.sp.defense) ? r1(a.sp.defense) : null },
    },
    season: ratings.basis === 'prior-season' ? ratings.season - 1 : ratings.season,
    basis: ratings.basis || 'season',
    instrumentation: ratings.instrumentation,       // 'cfbd-advanced'
    garbageTimeFiltered: ratings.garbageTimeFiltered, // true for college
    homeFieldFitted: ratings.homeFieldFitted === true,
    gaps,
  };
}
