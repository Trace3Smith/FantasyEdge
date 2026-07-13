// March Madness bracket optimizer (Brackets & Bowls, premium) — v1. Builds the full men's
// tournament bracket from free ESPN data and produces (a) a per-game pick + win probability,
// (b) exact round-by-round advancement probabilities per team, and (c) a single recommended
// "optimal fill" bracket through the champion. Served daily-cached via api/sports.js
// (?feed=march-madness), same pattern as NFL Pick'em / CFB Bowl. See docs/march-madness-scoping.md.
//
// Data (all free/no-key ESPN):
//   Field/seeds/regions — the tournament scoreboard over the ~R64 window (curatedRank = seed,
//     the note headline carries "<Region> Region - 1st Round").
//   Team strength — the BPI power index (bpi ≈ predicted neutral-court point margin per game).
// Model — each game's win prob blends the BPI margin (current-year strength) with the seed-
// history prior (mmSeedHistory.js). No betting line exists this far out and matchups past the
// first round aren't even set, so — unlike the football Pick'em — the pick is DERIVED FROM THE
// MODEL, not a market spread. Honest and self-consistent; not framed as betting advice.
//
// v1 scope note: this is a PROBABILITY-optimal bracket. The "pool-strategy" leverage layer
// (fade over-picked favorites using national pick-popularity) is intentionally NOT here — that
// input has no free source, and we don't fake it with a weak proxy. Left as a future stretch.
import { getJson } from './espn.js';
import { seedWinProb, SEED_REACH_RATE } from './mmSeedHistory.js';

const SB = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard';
const BPI = 'https://site.web.api.espn.com/apis/fitt/v3/sports/basketball/mens-college-basketball/powerindex';

// Standard seed order of the 16 slots in a region, top to bottom. Adjacent pairs are the R64
// matchups (1v16, 8v9, 5v12, …); the DP and the greedy fill both rely on this exact layout so
// that "the opposite half of a 2^r block" is always the correct next opponent set.
const BRACKET_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];

// SD of a single college-basketball game margin (points). Turns a BPI margin into a win
// probability via the normal CDF. ~11 is the accepted college MOV spread.
const SD = 11;
// How much weight the current-year BPI model gets vs. the seed-history prior. BPI leads; the
// seed prior tempers. First round leans a touch more on seed history (rich, reliable R64 data).
const BPI_WEIGHT = { r64: 0.65, later: 0.75 };

// Normal CDF (Abramowitz & Stegun 7.1.26) — same approximation the football Pick'em uses.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
const clamp = (p, lo = 0.03, hi = 0.97) => Math.max(lo, Math.min(hi, p));
const num = (v) => (v == null || v === '' ? null : Number(v));
const pct = (p) => Math.round(p * 1000) / 10;

// Display confidence tier for a favorite win probability (matches the Pick'em labels).
function confidenceOf(p) {
  if (p >= 0.68) return 'lock';
  if (p >= 0.58) return 'lean';
  return 'coin';
}

// The tournament year for "now": the bracket runs in March, so Jan–May → this year's tourney,
// Jun–Dec → next March. Off-season the field simply doesn't exist yet and the feed is empty.
export function tournamentYear(now = new Date()) {
  return now.getMonth() <= 5 ? now.getFullYear() : now.getFullYear() + 1;
}

// Nominal BPI implied by a seed — a fallback only, used when ESPN has no BPI for a team (rare,
// or a not-yet-decided First Four slot). Rough linear map: a 1-seed ≈ +22, a 16-seed ≈ -8.
function impliedBpi(seed) {
  return 22 - ((seed || 8) - 1) * 2;
}

// P(team A beats team B) in the given round. Favorite = lower seed number; we compute the
// favorite's win prob (BPI margin blended with the seed prior), then orient to A.
function pBeat(a, b, round) {
  const favIsA = a.seed <= b.seed;
  const fav = favIsA ? a : b;
  const dog = favIsA ? b : a;
  const bpiF = fav.bpi ?? impliedBpi(fav.seed);
  const bpiD = dog.bpi ?? impliedBpi(dog.seed);
  const pBpi = normCdf((bpiF - bpiD) / SD);
  const pSeed = seedWinProb(fav.seed, dog.seed, round);
  const w = round === 1 ? BPI_WEIGHT.r64 : BPI_WEIGHT.later;
  const pFav = clamp(w * pBpi + (1 - w) * pSeed);
  return favIsA ? pFav : 1 - pFav;
}

// Pull the tournament field from the scoreboard over the R64 window. Returns games grouped by
// region: [{ region, teams:[favSlot, dogSlot] }]. A not-yet-set First Four opponent comes back
// as a TBD placeholder (seed known, no team) so the bracket stays structurally complete.
async function fetchField(year) {
  const j = await getJson(`${SB}?dates=${year}0315-${year}0410&groups=100&limit=200`);
  const byRegion = new Map();
  for (const ev of j.events || []) {
    const c = ev.competitions?.[0];
    if (!c) continue;
    const note = (c.notes || [])[0]?.headline || '';
    if (!/1st Round/i.test(note)) continue; // R64 only — it fixes the whole 64-team field
    const region = (note.match(/-\s*(.*?)\s+Region\s*-/) || [])[1] || null;
    const comps = c.competitors || [];
    if (comps.length < 2 || !region) continue;
    const teams = comps.map((t) => {
      const seed = t.curatedRank?.current ?? null;
      const id = t.team?.id || null;
      const isTbd = !id || /tbd/i.test(t.team?.abbreviation || '') || /tbd/i.test(t.team?.displayName || '');
      return isTbd
        ? { seed, id: null, abbr: 'TBD', name: 'TBD', short: 'TBD', logo: null, tbd: true }
        : {
            seed,
            id,
            abbr: t.team.abbreviation,
            name: t.team.displayName,
            short: t.team.shortDisplayName || t.team.abbreviation,
            logo: t.team.logo || t.team.logos?.[0]?.href || null,
          };
    });
    if (teams.some((t) => t.seed == null)) continue;
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(teams);
  }
  return byRegion;
}

// Pull BPI for every D-I team → Map(teamId → { bpi, off, def, rank }). Best-effort: on any
// failure (e.g. a future season with no BPI yet) returns an empty map and the model falls back
// to seed-implied ratings, so a bracket still builds.
async function fetchBpi(year) {
  try {
    const j = await getJson(`${BPI}?season=${year}&limit=400`);
    const cat = (j.categories || []).find((c) => c.name === 'bpi');
    const names = cat?.names || [];
    const iBpi = names.indexOf('bpi');
    const iOff = names.indexOf('bpioffense');
    const iDef = names.indexOf('bpidefense');
    const iRank = names.indexOf('bpirank');
    const map = new Map();
    for (const t of j.teams || []) {
      const bc = (t.categories || []).find((c) => c.name === 'bpi');
      const v = bc?.values || [];
      if (!t.team?.id) continue;
      map.set(t.team.id, { bpi: num(v[iBpi]), off: num(v[iOff]), def: num(v[iDef]), rank: num(v[iRank]) });
    }
    return map;
  } catch {
    return new Map();
  }
}

// The TRUE Final Four pairing, read from ESPN's later-round bracket: once the national semifinals
// have real teams (the Elite Eight is complete), each semifinal game's two teams are mapped back
// to their regions via the R64 field, yielding which two regions share a semifinal. Returns
// [[regionA, regionB], [regionC, regionD]] or null (Final Four not yet reached, or unreadable) —
// in which case the caller averages over the possible pairings rather than guessing one.
async function fetchFinalFourPairing(year, byRegion) {
  try {
    const team2region = new Map();
    for (const [region, games] of byRegion) for (const g of games) for (const t of g) if (t.id) team2region.set(t.id, region);
    const j = await getJson(`${SB}?dates=${year}0401-${year}0412&groups=100&limit=20`);
    const pairs = [];
    for (const ev of j.events || []) {
      const c = ev.competitions?.[0];
      const note = (c?.notes || [])[0]?.headline || '';
      if (!/Final Four/i.test(note)) continue;
      const regs = (c.competitors || []).map((t) => team2region.get(t.team?.id)).filter(Boolean);
      if (regs.length === 2 && regs[0] !== regs[1]) pairs.push(regs);
    }
    return pairs.length === 2 ? pairs : null;
  } catch {
    return null;
  }
}

// Exact per-team advancement within one region of 16 slots (in BRACKET_ORDER). Returns, per
// slot, the probability of reaching each round: { s16, e8, f4 } where f4 = P(win the region).
// reach[i][r] = P(team i plays round r); r=0 is the R64 (everyone plays), r=4 = wins region.
// For round r, the opponent set is the opposite half of team i's 2^(r+1) block, weighted by
// each opponent's own probability of getting there. O(16^2 · 4) — trivial and deterministic.
function regionAdvancement(slots) {
  const N = 16;
  const reach = slots.map(() => [1, 0, 0, 0, 0]);
  for (let r = 0; r < 4; r++) {
    const blk = 1 << (r + 1);
    const half = 1 << r;
    for (let i = 0; i < N; i++) {
      if (reach[i][r] <= 0) continue;
      const base = Math.floor(i / blk) * blk;
      const inFirstHalf = i - base < half;
      const oppStart = inFirstHalf ? base + half : base;
      const oppEnd = inFirstHalf ? base + blk : base + half;
      let pWin = 0;
      for (let j = oppStart; j < oppEnd; j++) pWin += reach[j][r] * pBeat(slots[i], slots[j], r + 1);
      reach[i][r + 1] = reach[i][r] * pWin;
    }
  }
  return reach.map((row) => ({ s16: row[2], e8: row[3], f4: row[4] }));
}

// Greedy "optimal fill": walk the bracket, at each game advancing the higher win-probability
// team against its projected opponent. Returns the pick per game per round plus the final
// winner. Used for the recommended bracket (Final Four + champion) and the R64 pick tiles.
function greedyFill(slots, startRound) {
  let arr = slots.slice();
  let round = startRound;
  const byRound = [];
  while (arr.length > 1) {
    const next = [];
    const picks = [];
    for (let i = 0; i < arr.length; i += 2) {
      const a = arr[i];
      const b = arr[i + 1];
      const pa = pBeat(a, b, round);
      const win = pa >= 0.5 ? a : b;
      picks.push({ win, prob: Math.max(pa, 1 - pa) });
      next.push(win);
    }
    byRound.push(picks);
    arr = next;
    round += 1;
  }
  return { winner: arr[0], byRound };
}

// Assemble the full feed payload from the field + BPI. ffPairing (or null) is the literal Final
// Four region pairing read from ESPN's later-round bracket, when available.
function assemble(byRegion, bpiMap, year, ffPairing) {
  const regionNames = [...byRegion.keys()];
  // Attach BPI to every team slot, ordered into the standard 16-slot bracket layout per region.
  const regions = regionNames.map((name) => {
    const games = byRegion.get(name);
    const bySeed = new Map();
    for (const g of games) for (const t of g) bySeed.set(t.seed, { ...t, ...(t.id ? bpiMap.get(t.id) : null) });
    const slots = BRACKET_ORDER.map((seed) => bySeed.get(seed)).filter(Boolean);
    return { name, slots };
  });

  // A region is only DP-ready with all 16 slots present. If any region is short (mid-reveal),
  // fall back to a first-round-only feed (picks, no advancement/champion).
  const complete = regions.length === 4 && regions.every((r) => r.slots.length === 16);

  // First-round matchups per region (all 8), with the model pick + win prob + upset flag.
  const buildFirstRound = (slots) => {
    const out = [];
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i];
      const b = slots[i + 1];
      const fav = a.seed <= b.seed ? a : b;
      const dog = a.seed <= b.seed ? b : a;
      const pFav = pBeat(fav, dog, 1);
      const teamOut = (t) => ({ seed: t.seed, abbr: t.abbr, name: t.name, short: t.short, logo: t.logo, tbd: !!t.tbd, bpiRank: t.rank ?? null });
      out.push({
        fav: teamOut(fav),
        dog: teamOut(dog),
        pick: { team: fav.abbr, winProb: pct(pFav), confidence: confidenceOf(pFav) },
        upsetAlert: 1 - pFav >= 0.42, // live underdog — a real coin-flip-or-better shot
        dogWinProb: pct(1 - pFav),
      });
    }
    return out.sort((x, y) => x.fav.seed - y.fav.seed);
  };

  const feed = {
    field: complete ? 'set' : 'incomplete',
    season: year,
    builtAt: new Date().toISOString(),
    regions: regions.map((r) => ({ name: r.name, firstRound: buildFirstRound(r.slots) })),
    recommended: null,
    titleOdds: [],
    upsetAlerts: [],
    pairing: { source: 'projected', semifinals: null },
  };

  // Region-level upset watchlist (R64 games where the underdog is live).
  for (const r of feed.regions) {
    for (const g of r.firstRound) {
      if (g.upsetAlert) feed.upsetAlerts.push({ region: r.name, dog: g.dog, fav: g.fav, dogWinProb: g.dogWinProb });
    }
  }
  feed.upsetAlerts.sort((a, b) => b.dogWinProb - a.dogWinProb);

  if (!complete) return feed;

  // Full bracket: advancement DP per region + Final Four / championship across region winners.
  const regionAdv = regions.map((r) => regionAdvancement(r.slots)); // per region: [{s16,e8,f4}] by slot
  const regionWin = regionAdv.map((adv) => adv.map((a) => a.f4)); // P(win region) per slot

  // Final Four pairing — which two region winners meet in each national semifinal. This is set by
  // the committee on Selection Sunday and is NOT derivable from team strength: ESPN's overall-seed
  // order is a strength ranking, not the bracket order, so using it (or field order) gives the
  // wrong pairing. The one reliable source is ESPN's later-round bracket itself — once the Final
  // Four teams are set, fetchFinalFourPairing maps each semifinal game's teams back to their
  // regions to read the TRUE pairing (ffPairing). Before the Final Four is reached the literal
  // pairing isn't published in a machine-readable form, so rather than assert a specific (possibly
  // wrong) pairing we compute the deepest two layers as an UNBIASED AVERAGE over all three
  // possible region pairings. Everything shallower — region winners, S16/E8/F4 — is pairing-
  // agnostic and exact either way.
  const idxByName = new Map(regions.map((r, i) => [r.name, i]));
  const literalSemis = ffPairing
    ? ffPairing.map((pair) => pair.map((name) => idxByName.get(name))).filter((s) => s.length === 2 && s.every((x) => x != null))
    : null;
  const pairingKnown = !!(literalSemis && literalSemis.length === 2);

  // reachFinal (P reach the championship game) and champion (P win the title) per region slot, for
  // a given semifinal pairing semis = [[gA,gB],[gC,gD]] (the two winners of the semis meet in the
  // final). reachFinal[g][i] = P(win region g) · P(beat the partner region's field in the semi).
  const bracketOdds = (semis) => {
    const rf = [[], [], [], []];
    for (const [x, y] of semis) {
      rf[x] = regions[x].slots.map((t, i) => regionWin[x][i] * regions[y].slots.reduce((s, o, k) => s + regionWin[y][k] * pBeat(t, o, 5), 0));
      rf[y] = regions[y].slots.map((t, i) => regionWin[y][i] * regions[x].slots.reduce((s, o, k) => s + regionWin[x][k] * pBeat(t, o, 5), 0));
    }
    const otherSemi = (g) => (semis[0].includes(g) ? semis[1] : semis[0]);
    const champ = regions.map((r, g) =>
      r.slots.map((t, i) => rf[g][i] * otherSemi(g).reduce((s, og) => s + regions[og].slots.reduce((s2, o, k) => s2 + rf[og][k] * pBeat(t, o, 6), 0), 0)),
    );
    return { reachFinal: rf, champion: champ };
  };

  const ALL_PAIRINGS = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  let reachFinal;
  let champion;
  if (pairingKnown) {
    ({ reachFinal, champion } = bracketOdds(literalSemis));
  } else {
    const odds = ALL_PAIRINGS.map(bracketOdds);
    const avg = (pick) => [0, 1, 2, 3].map((g) => regions[g].slots.map((_, i) => odds.reduce((s, o) => s + pick(o)[g][i], 0) / odds.length));
    reachFinal = avg((o) => o.reachFinal);
    champion = avg((o) => o.champion);
  }

  // Per-team advancement, attached to each region's team list (sorted by seed for display).
  feed.regions = feed.regions.map((rf, g) => {
    const teams = regions[g].slots.map((t, i) => ({
      seed: t.seed,
      abbr: t.abbr,
      name: t.name,
      short: t.short,
      logo: t.logo,
      tbd: !!t.tbd,
      bpi: t.bpi ?? null,
      bpiRank: t.rank ?? null,
      s16: pct(regionAdv[g][i].s16),
      e8: pct(regionAdv[g][i].e8),
      f4: pct(regionAdv[g][i].f4),
      finals: pct(reachFinal[g][i]),
      champ: pct(champion[g][i]),
    }));
    teams.sort((a, b) => a.seed - b.seed);
    return { ...rf, teams };
  });

  // National title odds (top of the field).
  const allTeams = feed.regions.flatMap((r) => r.teams.map((t) => ({ ...t, region: r.name })));
  feed.titleOdds = allTeams
    .filter((t) => !t.tbd)
    .sort((a, b) => b.champ - a.champ)
    .slice(0, 12)
    .map((t) => ({ seed: t.seed, abbr: t.abbr, name: t.name, region: t.region, champ: t.champ }));

  // Recommended optimal fill: greedily win each region, then resolve the Final Four.
  const regionWinners = regions.map((r) => greedyFill(r.slots, 1).winner); // slot per region index
  const regionOf = (t) => regions.find((r) => r.slots.some((s) => s.abbr === t.abbr))?.name || null;
  const teamCard = (t) => ({ seed: t.seed, abbr: t.abbr, name: t.name, short: t.short, logo: t.logo, region: regionOf(t) });
  const champProbOf = (abbr) => { const at = allTeams.find((t) => t.abbr === abbr); return at ? at.champ : null; };

  let recFinalists;
  let recChampion;
  if (pairingKnown) {
    // Play the real semifinals (per the true pairing) then the final, greedily.
    const semiWinners = literalSemis.map(([x, y]) => (pBeat(regionWinners[x], regionWinners[y], 5) >= 0.5 ? regionWinners[x] : regionWinners[y]));
    recFinalists = semiWinners;
    recChampion = pBeat(semiWinners[0], semiWinners[1], 6) >= 0.5 ? semiWinners[0] : semiWinners[1];
  } else {
    // Pairing not yet published: the two highest title-odds region winners are the projected
    // finalists (no specific semifinal asserted), and the top one is the projected champion.
    const ranked = regionWinners.slice().sort((a, b) => (champProbOf(b.abbr) || 0) - (champProbOf(a.abbr) || 0));
    recFinalists = ranked.slice(0, 2);
    recChampion = ranked[0];
  }
  feed.recommended = {
    finalFour: regionWinners.map(teamCard),
    championship: recFinalists.map(teamCard),
    champion: { ...teamCard(recChampion), winProb: champProbOf(recChampion.abbr) },
    pairingKnown,
  };
  feed.pairing = {
    source: pairingKnown ? 'bracket' : 'projected',
    semifinals: pairingKnown ? literalSemis.map(([x, y]) => [regions[x].name, regions[y].name]) : null,
  };

  return feed;
}

// Build the March Madness feed. Off-season (no field yet) returns an empty, well-formed payload
// so the endpoint/UI degrade gracefully ("bracket sets on Selection Sunday"). Any hard failure
// propagates to the caller (sports.js), which serves the last good cached feed.
export async function buildMarchMadness({ now = new Date() } = {}) {
  const year = tournamentYear(now);
  const byRegion = await fetchField(year);
  const totalGames = [...byRegion.values()].reduce((s, g) => s + g.length, 0);
  if (totalGames === 0) {
    return { field: 'none', season: year, builtAt: new Date().toISOString(), regions: [], recommended: null, titleOdds: [], upsetAlerts: [], pairing: { source: 'projected', semifinals: null } };
  }
  const bpiMap = await fetchBpi(year);
  const ffPairing = await fetchFinalFourPairing(year, byRegion);
  return assemble(byRegion, bpiMap, year, ffPairing);
}

// Exposed for the seed-context tooltip layer (unused server-side; handy for tests/UI).
export { SEED_REACH_RATE };
