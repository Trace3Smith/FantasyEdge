// Translate an ESPN league's scoringSettings (pulled from the v3 league endpoint via
// `view=mSettings`) into the optimizer's internal category weights. This lets the
// Team Manager value players under EACH league's actual scoring automatically — the
// same way it already reads each league's roster — with no manual entry.
//
// Design is defensive: we only map the stat ids we're confident about, and we FALL
// BACK to the sport's sensible default valuation (WNBA points defaults / MLB blended
// value) whenever the settings can't be translated with confidence. A wrong or
// unfamiliar stat id therefore degrades gracefully instead of producing bad advice.
//
// Stat ids are from ESPN's fantasy scoring schema. Basketball is well-established;
// baseball (esp. pitching) is less certain and is only used for the uncommon MLB
// POINTS format — BY-SPEC, adjust the maps below if a detected weight looks wrong.

// ESPN basketball (fba / wfba) statId → our per-game key.
const HOOPS_STAT = {
  0: 'pts', 1: 'blk', 2: 'stl', 3: 'ast', 6: 'reb', 11: 'to', 17: 'tpm', 37: 'dd',
};
// ESPN baseball (flb) statId → our category key (hitting + the pitching cats we track).
const MLB_STAT = {
  5: 'hr', 20: 'r', 21: 'rbi', 23: 'sb', 2: 'avg', 17: 'obp',   // hitting
  53: 'w', 57: 'sv', 48: 'k', 47: 'era', 41: 'whip',            // pitching
};
// ESPN football (ffl) statId → our per-game scoring key. NFL is a POINTS league: parseScoringSettings
// reads each item's `points` value, so `weights` comes back as the league's actual point-per-unit for
// each stat — which captures PPR TYPE (receptions weight = 1 full / 0.5 half / 0 or absent standard)
// AND custom TD/yardage values in one pass, no separate PPR detection. Only stats that ALSO appear in
// the ESPN gamelog are mapped, so per-game fantasy points stay recomputable from the box score; 2-pt
// conversions and yardage bonuses aren't in the gamelog and are intentionally out of scope for the form
// badge. Ids are ESPN's fantasy-football scoring schema — spot-check against a real league's
// scoringItems if a detected weight looks off (same defensive stance as the maps above).
const NFL_STAT = {
  3: 'passYds', 4: 'passTD', 20: 'passInt',   // passing
  24: 'rushYds', 25: 'rushTD',                // rushing
  42: 'recYds', 43: 'recTD', 53: 'rec',       // receiving (53 = receptions → the PPR knob)
  72: 'fumLost',                              // turnovers (lost fumbles)
};
const STAT_MAP_BY_SPORT = { wnba: HOOPS_STAT, nba: HOOPS_STAT, mlb: MLB_STAT, nfl: NFL_STAT };

// Min recognized scored stats before we trust derived POINTS weights (else default).
const MIN_RECOGNIZED = 4;

// Friendly label for an ESPN scoringType (e.g. 'H2H_POINTS' → 'H2H Points').
export function scoringLabel(typeRaw) {
  const t = String(typeRaw || '').toUpperCase();
  if (!t) return 'Unknown';
  if (t.includes('POINT')) return t.startsWith('H2H') ? 'H2H Points' : 'Points';
  if (t.includes('ROTO')) return 'Roto (category)';
  if (t.includes('MOST')) return 'H2H Most Categories';
  if (t.includes('CATEGOR')) return 'H2H Categories';
  return t.replace(/_/g, ' ');
}

// Key for the per-league scoring record in KV (stored alongside the roster data).
export const scoringKey = (sport, season, leagueId) => `espn:scoring:${sport}:${season}:${leagueId}`;

// Category keys where a LOWER cumulative total is better (ranked ascending). Everything
// else ranks descending (more is better). ERA/WHIP are the roto "rate against" cats.
const LOWER_BETTER_CATS = new Set(['era', 'whip', 'gaa', 'l', 'to']);

// Compute the user's roto rank in each scored category from mStandings' per-team stat
// totals. `standings` is [{ id, valuesByStat: { [statId]: number } }] (from
// buildLeagueResult). Returns { catKey: { rank, of } } with rank 1 = best (leading the
// category), `of` = teams with data. Ties share a rank (rank = 1 + #teams strictly
// better). Returns null when there's no usable standings data — the advisor then falls
// back to unweighted category counting.
export function categoryRanks(standings, myTeamId, sport) {
  const statMap = STAT_MAP_BY_SPORT[sport];
  if (!statMap || !Array.isArray(standings) || standings.length < 2 || myTeamId == null) return null;
  const out = {};
  for (const [statIdStr, catKey] of Object.entries(statMap)) {
    const statId = Number(statIdStr);
    const vals = [];
    for (const t of standings) {
      const v = t.valuesByStat ? t.valuesByStat[statId] : undefined;
      if (typeof v === 'number' && Number.isFinite(v)) vals.push({ id: t.id, v });
    }
    if (vals.length < 2) continue;
    const mine = vals.find((x) => x.id === myTeamId);
    if (!mine) continue;
    const lower = LOWER_BETTER_CATS.has(catKey);
    let better = 0;
    for (const x of vals) {
      if (x.id === myTeamId) continue;
      if (lower ? x.v < mine.v : x.v > mine.v) better++;
    }
    out[catKey] = { rank: better + 1, of: vals.length };
  }
  return Object.keys(out).length ? out : null;
}

// Parse a raw scoringSettings object for a sport. Returns:
//   { scoringType, label, format:'points'|'category', weights, cats, unrecognized }
// `weights` is a per-category map ONLY for a confidently-translated POINTS league;
// otherwise it's null (→ the optimizer keeps its default valuation). `cats` is the set
// of scored categories we recognized (for display). Returns null if there's nothing to
// parse.
export function parseScoringSettings(scoringSettings, sport) {
  if (!scoringSettings || typeof scoringSettings !== 'object') return null;
  const typeRaw = scoringSettings.scoringType || '';
  const label = scoringLabel(typeRaw);
  const isPoints = String(typeRaw).toUpperCase().includes('POINT');
  const statMap = STAT_MAP_BY_SPORT[sport] || null;
  const items = Array.isArray(scoringSettings.scoringItems) ? scoringSettings.scoringItems : [];

  const recognized = {};
  for (const it of items) {
    const key = statMap ? statMap[it.statId] : null;
    if (!key) continue;
    // Points value for the stat (can be negative, e.g. turnovers). Some leagues use
    // pointsOverrides keyed by slot/position — fall back to the first override.
    let pts = typeof it.points === 'number' ? it.points : null;
    if (pts == null && it.pointsOverrides && typeof it.pointsOverrides === 'object') {
      const first = Object.values(it.pointsOverrides).find((v) => typeof v === 'number');
      if (typeof first === 'number') pts = first;
    }
    recognized[key] = isPoints ? (pts ?? 0) : 1;
  }
  const cats = Object.keys(recognized);

  if (isPoints) {
    // Trust the derived weights only if we recognized a solid core of scored stats;
    // otherwise the optimizer keeps the sport's default valuation.
    if (cats.length < MIN_RECOGNIZED) {
      return { scoringType: typeRaw, label, format: 'points', weights: null, cats, unrecognized: true };
    }
    return { scoringType: typeRaw, label, format: 'points', weights: recognized, cats };
  }
  // Category / roto: we surface the scored categories for display, but keep the
  // default roto valuation (MLB blended value / WNBA points defaults) — for equal-
  // weighted category scoring that balanced default is already the right model.
  return { scoringType: typeRaw, label, format: 'category', weights: null, cats };
}
