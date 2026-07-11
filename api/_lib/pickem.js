// Shared Pick'em pipeline for football (NFL + CFB Bowl). Assembles a slate of games with a
// pick + win probability, an upset flag, key injuries, and (outdoor, game-week) weather —
// all from free/no-key public sources (ESPN scoreboard/injuries, NWS weather). See
// docs/brackets-data-research.md and the sport wrappers (nflPickem.js, cfbBowl.js).
//
// Pre-game there is NO live win-probability from ESPN (that endpoint 400s until a game is
// underway), so the pick + win% are DERIVED FROM THE BETTING SPREAD — the market-implied
// probability. Win% = Φ(spread / 13.5): football margin-of-victory ≈ Normal with SD ~13.5,
// so a −3 favorite ≈ 59%, −7 ≈ 70%. Honest and standard; not framed as betting advice.

const UA = 'FantasyEdge/1.0 (brackets pickem; contact via app)';

// Normal CDF via an erf approximation (Abramowitz & Stegun 7.1.26). Used only to turn a
// point spread into a favorite win probability — accuracy here is well within display needs.
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}
// Favorite win probability from the (positive) spread magnitude. Clamped to a sane band.
export function winProbFromSpread(spreadMag) {
  const s = Math.abs(Number(spreadMag) || 0);
  const p = normCdf(s / 13.5);
  return Math.max(0.5, Math.min(0.97, p));
}

// Confidence tier from a favorite win probability (display label only).
export function confidenceOf(winProb) {
  if (winProb >= 0.68) return 'lock';   // clear favorite
  if (winProb >= 0.58) return 'lean';   // solid lean
  return 'coin';                        // near coin-flip
}

// Injury statuses worth surfacing (skip ACTIVE/PROBABLE — not decision-relevant here).
const NOTABLE_STATUS = new Set(['Out', 'Doubtful', 'Questionable', 'Injured Reserve', 'Suspension']);
// Positions we prioritize when trimming a team's injury list to the few that matter.
const KEY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'LT', 'CB', 'EDGE', 'DE', 'K']);

// Fetch every team's injuries from a league's site injuries endpoint in one call →
// { teamAbbr: [{name,pos,status}] }, slimmed to notable statuses and capped per team (key
// positions first). Best-effort: on any failure returns {} so games still render.
async function fetchInjuries(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
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
      rows.sort((a, b) => (KEY_POS.has(b.pos) ? 1 : 0) - (KEY_POS.has(a.pos) ? 1 : 0));
      if (rows.length) out[abbr] = rows.slice(0, 6);
    }
    return out;
  } catch { return {}; }
}

// NWS forecast nearest kickoff for an outdoor venue. `coords` = { lat, lon, dome } or null.
// Two calls (points → forecast); only works within the forecast window (~7 days) and only
// for US/territory locations (NWS is US-only), so anything else returns null (populates as
// the game nears). Best-effort — any failure returns null.
async function fetchWeather(coords, indoor, kickoffIso) {
  if (!coords || coords.dome || indoor) return null;
  const kick = Date.parse(kickoffIso);
  if (Number.isFinite(kick) && kick - Date.now() > 7 * 86400000) return null; // beyond NWS window
  try {
    const pt = await fetch(`https://api.weather.gov/points/${coords.lat},${coords.lon}`, { headers: { 'User-Agent': UA } });
    if (!pt.ok) return null;
    const props = (await pt.json())?.properties || {};
    const purl = props.forecastHourly || props.forecast;
    if (!purl) return null;
    const fc = await fetch(purl, { headers: { 'User-Agent': UA } });
    if (!fc.ok) return null;
    const periods = (await fc.json())?.properties?.periods || [];
    if (!periods.length) return null;
    const p = periods.find((x) => Date.parse(x.startTime) <= kick && kick < Date.parse(x.endTime)) || periods[0];
    return {
      tempF: p.temperature ?? null,
      condition: p.shortForecast || '',
      windMph: parseInt(String(p.windSpeed || '').match(/\d+/)?.[0] || '', 10) || null,
      precipPct: p.probabilityOfPrecipitation?.value ?? null,
    };
  } catch { return null; }
}

// Build a slate of Pick'em games from an ESPN scoreboard. `cfg`:
//   scoreboardUrl  — the ESPN scoreboard URL (already including any query params)
//   injuriesUrl    — the league's site injuries endpoint
//   coordsFor(comp, home, away) — returns { lat, lon, dome } | null for the venue (weather)
//   includeEvent(comp, ev)      — optional filter (e.g. CFB: drop FCS games); default keep all
//   nameOf(comp)                — optional extra label (e.g. CFB bowl/playoff name); default null
// Returns { season, seasonType, week, games, bestPicks, upsetAlerts, builtAt }. Failure-
// tolerant per game so one bad event can't drop the slate.
export async function buildPickem(cfg) {
  const r = await fetch(cfg.scoreboardUrl, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`ESPN scoreboard HTTP ${r.status}`);
  const sb = await r.json();
  const injuries = await fetchInjuries(cfg.injuriesUrl);

  const games = [];
  for (const ev of (sb.events || [])) {
    try {
      const c = ev.competitions?.[0];
      if (!c) continue;
      if (cfg.includeEvent && !cfg.includeEvent(c, ev)) continue;
      const home = c.competitors.find((t) => t.homeAway === 'home');
      const away = c.competitors.find((t) => t.homeAway === 'away');
      if (!home || !away) continue;
      const teamOf = (t) => ({ abbr: t.team.abbreviation, name: t.team.displayName, logo: t.team.logo || null, record: t.records?.[0]?.summary || null });

      // Odds → market-implied pick + win%. Absent odds (rare, or way out) → no pick yet.
      const o = (c.odds || [])[0];
      let odds = null, pick = null, upsetAlert = false;
      if (o && typeof o.spread === 'number' && o.spread !== 0) {
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
      const coords = cfg.coordsFor ? cfg.coordsFor(c, home, away) : null;
      const weather = await fetchWeather(coords, indoor, ev.date);
      const bowlName = cfg.nameOf ? cfg.nameOf(c) : null;

      games.push({
        id: ev.id,
        date: ev.date,
        shortName: ev.shortName,
        state: ev.status?.type?.state || 'pre',
        ...(bowlName ? { bowlName } : {}),
        neutralSite: c.neutralSite === true,
        home: teamOf(home),
        away: teamOf(away),
        venue: { name: c.venue?.fullName || '', indoor, city: c.venue?.address?.city || '' },
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
