// NFL Pick'em data builder — the first Brackets & Bowls section. Assembles one week of
// NFL games with a pick + win probability, an upset flag, key injuries, and (outdoor,
// game-week only) weather, ALL from free/no-key public sources FantasyEdge already uses:
//   • ESPN scoreboard  (games, teams, venue indoor flag, betting spread/total)
//   • ESPN site injuries (all teams in one call)
//   • NWS api.weather.gov (outdoor venues, forecast within ~7 days of kickoff)
// See docs/brackets-data-research.md. No API key, no recurring cost. Built daily by the
// refresh cron and cached in KV; the endpoint self-heals on a cold start.
//
// Pre-game there is NO live win-probability from ESPN (that endpoint 400s until a game is
// underway), so the pick + win% are DERIVED FROM THE BETTING SPREAD — the market-implied
// probability. Win% = Φ(spread / 13.5): NFL margin-of-victory ≈ Normal with SD ~13.5, so a
// −3 favorite ≈ 59%, −7 ≈ 70%. Honest and standard; not framed as betting advice.

const UA = 'FantasyEdge/1.0 (brackets pickem; contact via app)';
const SB = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard';
const INJ = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries';

// Normal CDF via an erf approximation (Abramowitz & Stegun 7.1.26). Used only to turn a
// point spread into a favorite win probability — accuracy here is well within display needs.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
// Favorite win probability from the (positive) spread magnitude. Clamped to a sane band.
export function winProbFromSpread(spreadMag) {
  const s = Math.abs(Number(spreadMag) || 0);
  const p = normCdf(s / 13.5);
  return Math.max(0.5, Math.min(0.97, p));
}

// Injury statuses worth surfacing (skip ACTIVE/PROBABLE — not decision-relevant here).
const NOTABLE_STATUS = new Set(['Out', 'Doubtful', 'Questionable', 'Injured Reserve', 'Suspension']);
// Positions we prioritize when trimming a team's injury list to the few that matter.
const KEY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'LT', 'CB', 'EDGE', 'DE', 'K']);

// Fetch every team's injuries in one ESPN call → { teamAbbr: [{name,pos,status}] }, slimmed
// to notable statuses and capped per team (key positions first). Best-effort: on any failure
// returns {} so a game still renders without injury context.
async function fetchInjuries() {
  try {
    const r = await fetch(INJ, { headers: { 'User-Agent': UA } });
    if (!r.ok) return {};
    const j = await r.json();
    const out = {};
    for (const t of (j.injuries || [])) {
      const abbr = t.team?.abbreviation || t.abbreviation;
      if (!abbr) continue;
      const rows = [];
      for (const e of (t.injuries || [])) {
        const status = e.status || e.type?.description || '';
        const norm = status.replace(/\b\w/g, (c) => c.toUpperCase());
        if (!NOTABLE_STATUS.has(status) && !NOTABLE_STATUS.has(norm)) continue;
        const ath = e.athlete || {};
        rows.push({ name: ath.displayName || ath.fullName || 'Unknown', pos: ath.position?.abbreviation || '', status: norm || status });
      }
      // Key positions first, then cap — the page only needs the handful that move a pick.
      rows.sort((a, b) => (KEY_POS.has(b.pos) ? 1 : 0) - (KEY_POS.has(a.pos) ? 1 : 0));
      if (rows.length) out[abbr] = rows.slice(0, 6);
    }
    return out;
  } catch { return {}; }
}

// Static stadium coordinates + dome flag for weather. Domes/retractable-when-closed never
// need a forecast; outdoor venues get NWS weather within ~7 days of kickoff. Keyed by home
// team abbrev (stable), with the ESPN venue indoor flag as the authoritative dome override.
const STADIUMS = {
  ARI: { lat: 33.5277, lon: -112.2626, dome: true }, ATL: { lat: 33.7554, lon: -84.4008, dome: true },
  BAL: { lat: 39.2780, lon: -76.6227, dome: false }, BUF: { lat: 42.7738, lon: -78.7870, dome: false },
  CAR: { lat: 35.2258, lon: -80.8528, dome: false }, CHI: { lat: 41.8623, lon: -87.6167, dome: false },
  CIN: { lat: 39.0954, lon: -84.5160, dome: false }, CLE: { lat: 41.5061, lon: -81.6995, dome: false },
  DAL: { lat: 32.7473, lon: -97.0945, dome: true }, DEN: { lat: 39.7439, lon: -105.0201, dome: false },
  DET: { lat: 42.3400, lon: -83.0456, dome: true }, GB: { lat: 44.5013, lon: -88.0622, dome: false },
  HOU: { lat: 29.6847, lon: -95.4107, dome: true }, IND: { lat: 39.7601, lon: -86.1639, dome: true },
  JAX: { lat: 30.3239, lon: -81.6373, dome: false }, KC: { lat: 39.0489, lon: -94.4839, dome: false },
  LV: { lat: 36.0909, lon: -115.1833, dome: true }, LAC: { lat: 33.9535, lon: -118.3392, dome: true },
  LAR: { lat: 33.9535, lon: -118.3392, dome: true }, MIA: { lat: 25.9580, lon: -80.2389, dome: false },
  MIN: { lat: 44.9736, lon: -93.2575, dome: true }, NE: { lat: 42.0909, lon: -71.2643, dome: false },
  NO: { lat: 29.9509, lon: -90.0812, dome: true }, NYG: { lat: 40.8135, lon: -74.0745, dome: false },
  NYJ: { lat: 40.8135, lon: -74.0745, dome: false }, PHI: { lat: 39.9008, lon: -75.1675, dome: false },
  PIT: { lat: 40.4468, lon: -80.0158, dome: false }, SEA: { lat: 47.5952, lon: -122.3316, dome: false },
  SF: { lat: 37.4030, lon: -121.9700, dome: false }, TB: { lat: 27.9759, lon: -82.5033, dome: false },
  TEN: { lat: 36.1665, lon: -86.7713, dome: false }, WSH: { lat: 38.9078, lon: -76.8645, dome: false },
};

// NWS forecast nearest kickoff for an outdoor venue. Two calls (points → forecast); only
// works within the forecast window (~7 days), so games further out return null (populates as
// the week nears). Best-effort — any failure returns null.
async function fetchWeather(homeAbbr, indoor, kickoffIso) {
  const s = STADIUMS[homeAbbr];
  if (!s || s.dome || indoor) return null;
  const kick = Date.parse(kickoffIso);
  if (Number.isFinite(kick) && kick - Date.now() > 7 * 86400000) return null; // beyond NWS window
  try {
    const pt = await fetch(`https://api.weather.gov/points/${s.lat},${s.lon}`, { headers: { 'User-Agent': UA } });
    if (!pt.ok) return null;
    const props = (await pt.json())?.properties || {};
    const purl = props.forecastHourly || props.forecast;
    if (!purl) return null;
    const fc = await fetch(purl, { headers: { 'User-Agent': UA } });
    if (!fc.ok) return null;
    const periods = (await fc.json())?.properties?.periods || [];
    if (!periods.length) return null;
    // Pick the period covering kickoff, else the first upcoming.
    const p = periods.find((x) => Date.parse(x.startTime) <= kick && kick < Date.parse(x.endTime)) || periods[0];
    return {
      tempF: p.temperature ?? null,
      condition: p.shortForecast || '',
      windMph: parseInt(String(p.windSpeed || '').match(/\d+/)?.[0] || '', 10) || null,
      precipPct: p.probabilityOfPrecipitation?.value ?? null,
    };
  } catch { return null; }
}

// Confidence tier from a favorite win probability (display label only).
function confidenceOf(winProb) {
  if (winProb >= 0.68) return 'lock';   // clear favorite
  if (winProb >= 0.58) return 'lean';   // solid lean
  return 'coin';                        // near coin-flip
}

// Build one week of Pick'em from the ESPN scoreboard (default = current/upcoming week; pass
// `week` to target a specific one). Returns { season, week, seasonType, games, bestPicks,
// upsetAlerts, builtAt }. Failure-tolerant per game so one bad event can't drop the slate.
export async function buildNflPickem({ week } = {}) {
  const url = week ? `${SB}?week=${encodeURIComponent(week)}` : SB;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`ESPN scoreboard HTTP ${r.status}`);
  const sb = await r.json();
  const injuries = await fetchInjuries();

  const games = [];
  for (const ev of (sb.events || [])) {
    try {
      const c = ev.competitions?.[0];
      if (!c) continue;
      const home = c.competitors.find((t) => t.homeAway === 'home');
      const away = c.competitors.find((t) => t.homeAway === 'away');
      if (!home || !away) continue;
      const teamOf = (t) => ({ abbr: t.team.abbreviation, name: t.team.displayName, logo: t.team.logo || null, record: t.records?.[0]?.summary || null });

      // Odds → market-implied pick + win%. Absent odds (rare, or way out) → no pick yet.
      const o = (c.odds || [])[0];
      let odds = null, pick = null, upsetAlert = false;
      if (o && typeof o.spread === 'number' && o.spread !== 0) {
        // ESPN's `spread` is signed toward the home team's favorite/underdog line: negative
        // means home is favored by |spread|. `details` (e.g. "SEA -3.5") names the favorite.
        const homeFav = o.spread < 0;
        const favAbbr = (o.homeTeamOdds?.favorite && home.team.abbreviation)
          || (o.awayTeamOdds?.favorite && away.team.abbreviation)
          || (homeFav ? home.team.abbreviation : away.team.abbreviation);
        const winProb = winProbFromSpread(o.spread);
        odds = { spread: o.spread, favorite: favAbbr, overUnder: o.overUnder ?? null, details: o.details || '' };
        pick = { team: favAbbr, winProb: Math.round(winProb * 1000) / 10, confidence: confidenceOf(winProb) };
        upsetAlert = winProb < 0.58; // tight line — the underdog has a real shot
      }

      const indoor = c.venue?.indoor === true;
      const weather = await fetchWeather(home.team.abbreviation, indoor, ev.date);

      games.push({
        id: ev.id,
        date: ev.date,
        shortName: ev.shortName,
        state: ev.status?.type?.state || 'pre',
        home: teamOf(home),
        away: teamOf(away),
        venue: { name: c.venue?.fullName || '', indoor },
        odds,
        pick,
        upsetAlert,
        injuries: {
          home: injuries[home.team.abbreviation] || [],
          away: injuries[away.team.abbreviation] || [],
        },
        weather,
      });
    } catch { /* skip a single malformed event; keep the slate */ }
  }

  // Highest-confidence picks (safest) and the upset watchlist — the page's two headline rails.
  const picked = games.filter((g) => g.pick);
  const bestPicks = picked.slice().sort((a, b) => b.pick.winProb - a.pick.winProb).slice(0, 5)
    .map((g) => ({ id: g.id, team: g.pick.team, winProb: g.pick.winProb, opp: g.pick.team === g.home.abbr ? g.away.abbr : g.home.abbr }));
  const upsetAlerts = picked.filter((g) => g.upsetAlert)
    .map((g) => ({ id: g.id, underdog: g.pick.team === g.home.abbr ? g.away.abbr : g.home.abbr, favorite: g.pick.team, favWinProb: g.pick.winProb }));

  return {
    season: sb.season?.year ?? null,
    seasonType: sb.season?.type ?? null,
    week: sb.week?.number ?? null,
    games,
    bestPicks,
    upsetAlerts,
    builtAt: new Date().toISOString(),
  };
}
