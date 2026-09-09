// Shared Pick'em pipeline for football (NFL + CFB Bowl). Assembles a slate of games with a
// pick + win probability, an upset flag, key injuries, and (outdoor, game-week) weather —
// all from free/no-key public sources (ESPN scoreboard/injuries, NWS weather). See
// docs/brackets-data-research.md and the sport wrappers (nflPickem.js, cfbBowl.js).
//
// Pre-game there is NO live win-probability from ESPN (that endpoint 400s until a game is
// underway), so the pick + win% are DERIVED FROM THE BETTING SPREAD — the market-implied
// probability. Win% = Φ(spread / 13.5): football margin-of-victory ≈ Normal with SD ~13.5,
// so a −3 favorite ≈ 59%, −7 ≈ 70%. Honest and standard; not framed as betting advice.

import { buildTeamReports } from './teamReport.js';
import { redis, redisConfigured, nwsGridKey, NWS_GRID_TTL, wxCooldownKey } from './kv.js';
import { groupInjuries } from './injuryGroups.js';

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

// American moneyline -> raw implied probability (book's vig still included). "+105" -> 0.488,
// "-125" -> 0.556. Accepts a string or number; returns null when unparseable.
export function mlToProb(ml) {
  const n = Number(ml);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 0 ? (-n) / ((-n) + 100) : 100 / (n + 100);
}

// Injury statuses worth surfacing (skip ACTIVE/PROBABLE — not decision-relevant here).
const NOTABLE_STATUS = new Set(['Out', 'Doubtful', 'Questionable', 'Injured Reserve', 'Suspension']);
// Positions we prioritize when trimming a team's injury list to the few that matter.
const KEY_POS = new Set(['QB', 'RB', 'WR', 'TE', 'LT', 'CB', 'EDGE', 'DE', 'K']);

// Fetch every team's injuries from a league's site injuries endpoint in one call →
// { teamId: [{name,pos,status}] }, slimmed to notable statuses, key positions first.
//
// KEYED BY TEAM ID, and it has to be. This was previously keyed on
// `t.team?.abbreviation || t.abbreviation` — but ESPN's injuries payload shapes a team as
// `{ id, displayName, injuries }`, carrying NEITHER of those fields. So `abbr` was always
// undefined, every team hit the `continue`, and the map came back empty: no NFL injury has ever
// reached a card. `id` is the field that is actually present (22 = Arizona), and it matches the
// team id already on every game object. The old keys are kept as fallbacks for any other shape.
//
// NO CAP HERE, deliberately. This list used to be trimmed to 6 per team, which is fine for
// printing a few names but silently wrong for COUNTING a unit: the sort put KEY_POS first, and
// KEY_POS contains LT but not C, G or OT — so an offensive line could be trimmed away before it
// was counted. Measured against a live payload, ALL 32 teams exceeded that cap, so every team's
// group counts would have been understated. The trim now happens at display time instead, where
// losing a name costs nothing. Best-effort: on any failure returns {} so games still render.
async function fetchInjuries(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) return {};
    const j = await r.json();
    const out = {};
    for (const t of (j.injuries || [])) {
      const key = t.id ?? t.team?.id ?? t.team?.abbreviation ?? t.abbreviation;
      if (key == null) continue;
      const rows = [];
      for (const e of (t.injuries || [])) {
        const status = e.status || e.type?.description || '';
        const norm = status.replace(/\b\w/g, (c) => c.toUpperCase());
        if (!NOTABLE_STATUS.has(status) && !NOTABLE_STATUS.has(norm)) continue;
        const ath = e.athlete || {};
        rows.push({ name: ath.displayName || ath.fullName || 'Unknown', pos: ath.position?.abbreviation || '', status: norm || status });
      }
      rows.sort((a, b) => (KEY_POS.has(b.pos) ? 1 : 0) - (KEY_POS.has(a.pos) ? 1 : 0));
      if (rows.length) out[String(key)] = rows;
    }
    return out;
  } catch { return {}; }
}

// This cache is consulted once PER GAME, which makes a slow Redis expensive in a way a
// once-per-build cache isn't: the client retries internally, so one unreachable command costs
// ~4.3 seconds, and a full slate would serialise that into minutes and blow the cron budget. So
// the cache is skipped entirely when Redis isn't configured, and one failure disables it for the
// rest of the process — a build pays the penalty once, not once per game. Forecasts still work
// throughout; they just cost the extra gridpoint call they cost before this cache existed.
let gridCacheOff = !redisConfigured;

// The NWS hourly-forecast URL for a coordinate. This is the first of the two calls a forecast
// costs, and it is pure lookup: a coordinate always resolves to the same grid cell, so caching it
// leaves the second call as the only one that has to happen.
async function nwsForecastUrl(lat, lon) {
  const key = nwsGridKey(lat, lon);
  if (!gridCacheOff) {
    try { const hit = await redis.get(key); if (typeof hit === 'string' && hit) return hit; }
    catch { gridCacheOff = true; }
  }
  const pt = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: { 'User-Agent': UA } });
  if (!pt.ok) return null;
  const props = (await pt.json())?.properties || {};
  const url = props.forecastHourly || props.forecast;
  if (!url) return null;
  if (!gridCacheOff) {
    try { await redis.set(key, url, { ex: NWS_GRID_TTL }); }
    catch { gridCacheOff = true; } // serving it matters, storing it doesn't
  }
  return url;
}

// Read one NWS forecast URL and pick the period covering kickoff. This is a forecast FOR KICKOFF,
// not current conditions — which is why an entry hours old is still meaningful, and why it carries
// `fetchedAt`: the card states its own age rather than looking equally fresh at every hour.
// `url` is kept so the forecast can be refreshed later without re-resolving the gridpoint.
async function readForecast(url, kick) {
  const fc = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!fc.ok) return null;
  const periods = (await fc.json())?.properties?.periods || [];
  if (!periods.length) return null;
  const p = periods.find((x) => Date.parse(x.startTime) <= kick && kick < Date.parse(x.endTime)) || periods[0];
  return {
    tempF: p.temperature ?? null,
    condition: p.shortForecast || '',
    windMph: parseInt(String(p.windSpeed || '').match(/\d+/)?.[0] || '', 10) || null,
    precipPct: p.probabilityOfPrecipitation?.value ?? null,
    fetchedAt: new Date().toISOString(),
    url,
  };
}

// NWS forecast nearest kickoff for an outdoor venue. `coords` = { lat, lon, dome, covered } or null.
// Only works within the forecast window (~7 days) and only for the US and its territories (NWS
// covers nothing else), so anything else returns null and populates as the game nears.
// Best-effort — any failure returns null.
async function fetchWeather(coords, indoor, kickoffIso) {
  if (!coords || coords.dome || indoor) return null;
  const kick = Date.parse(kickoffIso);
  if (Number.isFinite(kick) && kick - Date.now() > 7 * 86400000) return null; // beyond NWS window
  try {
    const url = await nwsForecastUrl(coords.lat, coords.lon);
    const wx = url ? await readForecast(url, kick) : null;
    // A roofed but open-sided venue (SoFi — see the stadium table in nflPickem.js). Temperature and
    // wind are real there and stay; the precipitation figure is dropped rather than shown, because
    // the canopy is over the field and rain does not reach it. Reporting "40% precip" for a game
    // played dry would be exactly the kind of confident wrong number this feed avoids elsewhere.
    if (wx && coords.covered) return { ...wx, precipPct: null, covered: true };
    return wx;
  } catch { return null; }
}

// ===== Serve-time top-up =====
//
// The daily cron is the only scheduled writer, so a forecast on a card is up to ~24h old and is
// 5-14h old at kickoff — and the hours that matter most are the ones where a forecast actually
// firms up. Hobby caps crons at once a day, so freshness has to come from the request path
// instead: when the feed is served, any game about to kick off whose forecast has gone stale is
// re-read. That is deliberately narrow — only games inside TOPUP_WINDOW, only the second NWS call
// (the gridpoint is cached), and only once per TOPUP_MAX_AGE across all requests.
// Weather is fetched in a bounded-concurrency pass AFTER the slate is assembled, not inline while
// building each game. Inline was fine at 25 ranked games; measured across a full 86-game FBS slate
// it was ~40 of the build's 51 seconds, because every game waited on the one before it. Every other
// multi-fetch path here already works this way (teamReport, nflDvp) — this one just never had
// enough games for it to matter.
// Version of everything this builder DERIVES — the injury lines, which games are on the slate, the
// fields each team carries. api/sports.js treats a cached feed at an older version as stale and
// rebuilds it once, so a deploy self-heals instead of serving what the previous build decided.
//
// It lives here, named for the feed rather than for any one feature, because that is what it is.
// It was previously INJURY_IMPACT_VERSION over in injuryGroups.js, and the name cost a deploy: when
// CFB Week widened from the ranked slate to the full FBS field, nothing bumped it — the change had
// nothing to do with injuries — so production kept serving 25 cached games with no rank or
// conference on them. Shape is not the trigger and neither is any one feature: if a change would
// make a fresh build disagree with the cached one, bump this.
export const FEED_CONTENT_VERSION = 6;

const WX_CONC = 8;

async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

const TOPUP_WINDOW = 24 * 3600 * 1000;  // only games about to be played
const TOPUP_MAX_AGE = 30 * 60 * 1000;   // how stale a forecast may get inside that window
const TOPUP_BUDGET_MS = 4000;           // hard ceiling: this runs on a user's request

// Games close enough to kick off that their forecast is worth re-reading, and old enough to need
// it. A game with no `weather.url` can't be topped up and doesn't need to be: it is either domed,
// at an unknown venue, or was outside the 7-day window at build time — and something outside that
// window by definition isn't inside a 24-hour one.
export function staleWeatherGames(feed, now = Date.now()) {
  return (feed?.games || []).filter((g) => {
    if (g.state === 'post' || !g.weather?.url) return false;
    const kick = Date.parse(g.date);
    if (!Number.isFinite(kick) || kick - now > TOPUP_WINDOW) return false;
    const age = now - Date.parse(g.weather.fetchedAt ?? 0);
    return !(age >= 0) || age > TOPUP_MAX_AGE;
  });
}

// Refresh the forecasts on a served feed. Returns the feed and whether anything actually changed,
// so the caller only writes back when there is something to write. Never throws: a failed refresh
// leaves the previous forecast in place, which is exactly what it was going to show anyway.
export async function topUpWeather(feed, feedKey) {
  const stale = staleWeatherGames(feed);
  if (!stale.length) return { feed, changed: false };

  // Single-flight across concurrent requests: whoever sets the cooldown does the work, everyone
  // else serves what's cached. Set BEFORE fetching, so a burst can't all pile into NWS at once.
  if (!redisConfigured) return { feed, changed: false }; // no cooldown to hold → never fetch
  try {
    const won = await redis.set(wxCooldownKey(feedKey), Date.now(), { nx: true, px: TOPUP_MAX_AGE });
    if (!won) return { feed, changed: false };
  } catch { return { feed, changed: false }; } // no cooldown available → don't fetch at all

  const deadline = Date.now() + TOPUP_BUDGET_MS;
  let changed = false;
  await Promise.all(stale.map(async (g) => {
    if (Date.now() > deadline) return;
    try {
      const fresh = await readForecast(g.weather.url, Date.parse(g.date));
      // A covered venue keeps its treatment across a top-up. The roof is a property of the
      // stadium, not of the forecast, and this path re-reads NWS directly rather than going back
      // through fetchWeather — so without this the precipitation figure fetchWeather deliberately
      // dropped would quietly reappear in the last half hour before kickoff, which is precisely
      // when the card is being read.
      if (fresh) { g.weather = g.weather.covered ? { ...fresh, precipPct: null, covered: true } : fresh; changed = true; }
    } catch { /* keep the forecast we already have */ }
  }));
  return { feed, changed };
}

// Build a slate of Pick'em games from an ESPN scoreboard. `cfg`:
//   scoreboardUrl  — the ESPN scoreboard URL (already including any query params)
//   injuriesUrl    — the league's site injuries endpoint
//   coordsFor(comp, home, away) — returns { lat, lon, dome } | null for the venue (weather)
//   includeEvent(comp, ev)      — optional filter (e.g. CFB: drop FCS games); default keep all
//   nameOf(comp)                — optional extra label (e.g. CFB bowl/playoff name); default null
//   leaguePath                  — ESPN sport/league segment ('football/nfl'); enables team reports
//   starters()                  — optional async () => { [teamAbbr]: { QB|RB|WR|TE: 'Name' } };
//                                 enables the starter injury lines (see injuryGroups.js). Omit and
//                                 they never fire — only the position-group counts do.
// Returns { contentV, season, seasonType, week, games, results, teamReports, bestPicks,
// upsetAlerts, builtAt }, where
// `games` is the still-to-play slate and `results` holds any game in the same window that's
// already final (see the split below). Failure-tolerant per game so one bad event can't drop
// the slate.
export async function buildPickem(cfg) {
  const r = await fetch(cfg.scoreboardUrl, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`ESPN scoreboard HTTP ${r.status}`);
  const sb = await r.json();
  const injuries = await fetchInjuries(cfg.injuriesUrl);
  // Starting skill players, when the league wrapper can identify them. Best-effort and optional:
  // without it the starter lines stay silent rather than guessing at a depth chart.
  let starters = {};
  if (cfg.starters) { try { starters = (await cfg.starters()) || {}; } catch { starters = {}; } }

  const games = [];
  for (const ev of (sb.events || [])) {
    try {
      const c = ev.competitions?.[0];
      if (!c) continue;
      if (cfg.includeEvent && !cfg.includeEvent(c, ev)) continue;
      const home = c.competitors.find((t) => t.homeAway === 'home');
      const away = c.competitors.find((t) => t.homeAway === 'away');
      if (!home || !away) continue;
      const teamOf = (t) => ({
        id: t.team.id,
        abbr: t.team.abbreviation,
        // Rank and conference ride along so the page can filter a slate it already has, rather than
        // the feed deciding for it. `rank` is ESPN's curatedRank (99 means unranked, so it's
        // normalised to null); `conf` is the conference id, absent in leagues that have none.
        rank: (() => { const r = t.curatedRank?.current; return typeof r === 'number' && r >= 1 && r <= 25 ? r : null; })(),
        conf: t.team.conferenceId != null ? Number(t.team.conferenceId) : null,
        name: t.team.displayName,
        logo: t.team.logo || null,
        record: t.records?.[0]?.summary || null,
        // Final score + winner, present only once a game is over — what the results section renders.
        score: t.score != null && t.score !== '' ? Number(t.score) : null,
        winner: t.winner === true,
      });

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

      // Market-implied win % per side, de-vigged from the DraftKings moneyline (spread fallback when
      // a moneyline is absent). This is the betting MARKET's implied probability — NOT a public
      // money/ticket split (no free source exposes that); the UI labels it "Market". Home + away = 100.
      let market = null;
      if (o) {
        const mlH = mlToProb(o.moneyline?.home?.close?.odds ?? o.homeTeamOdds?.moneyLine);
        const mlA = mlToProb(o.moneyline?.away?.close?.odds ?? o.awayTeamOdds?.moneyLine);
        let homePct = null;
        if (mlH != null && mlA != null && mlH + mlA > 0) homePct = (mlH / (mlH + mlA)) * 100;
        else if (typeof o.spread === 'number' && o.spread !== 0) homePct = (o.spread < 0 ? winProbFromSpread(o.spread) : 1 - winProbFromSpread(o.spread)) * 100;
        if (homePct != null) { const h = Math.round(homePct); market = { home: h, away: 100 - h }; }
      }

      const state = ev.status?.type?.state || 'pre';
      const indoor = c.venue?.indoor === true;
      const coords = cfg.coordsFor ? cfg.coordsFor(c, home, away) : null;
      // Filled by the concurrent pass below. A finished game gets no forecast — the weather already
      // happened — and neither does a dome or a venue with no coordinates, so those never queue.
      const wanted = state !== 'post' && !!coords && !coords.dome && !indoor;
      const bowlName = cfg.nameOf ? cfg.nameOf(c) : null;

      games.push({
        id: ev.id,
        date: ev.date,
        shortName: ev.shortName,
        state,
        ...(bowlName ? { bowlName } : {}),
        neutralSite: c.neutralSite === true,
        home: teamOf(home),
        away: teamOf(away),
        // The venue id is the key both CFB coordinate tables use, so carrying it makes the payload
        // self-describing: weather coverage can be checked without re-deriving the venue.
        venue: { id: c.venue?.id ? String(c.venue.id) : null, name: c.venue?.fullName || '', indoor, city: c.venue?.address?.city || '' },
        odds,
        pick,
        market, // { home, away } implied win % (de-vigged moneyline); null when no line
        upsetAlert,
        _wx: wanted ? { coords, indoor, date: ev.date } : null,
        injuries: {
          // The COMPLETE list, uncapped. It was trimmed to 6 while the card printed a few names
          // inline, but that made the card contradict itself: the impact lines count the whole
          // squad, so a card could name a player in a line who had been cut from the list beneath
          // it — San Francisco listed Bosa, Evans and Kittle while a line named McCaffrey, who sat
          // 6th and was never rendered. The card no longer prints names at all (the team panel
          // does), so the cap has nothing left to protect and costs ~10KB to drop: 353 rows
          // league-wide against the 192 a 6-cap allowed, and no team carries more than 17.
          home: injuries[home.team.id] || [],
          away: injuries[away.team.id] || [],
        },
        // Position-group impact lines — "3 OL out or questionable" and what that does to the game.
        // Templated, not generated: no per-game model call. Empty for CFB, which has no injury data.
        injuryImpact: {
          // Injuries key by team id (ESPN's payload shape); starters key by abbreviation (the
          // dataset's). Each map is keyed by whatever its own source actually provides.
          home: groupInjuries(injuries[home.team.id], starters[home.team.abbreviation]),
          away: groupInjuries(injuries[away.team.id], starters[away.team.abbreviation]),
        },
        weather: null,
      });
    } catch { /* skip a single malformed event; keep the slate */ }
  }

  // The concurrent weather pass. Failure-tolerant per game exactly as the inline version was: a
  // game whose forecast fails keeps `weather: null` and renders without one.
  const needsWx = games.filter((g) => g._wx);
  await mapLimit(needsWx, WX_CONC, async (g) => {
    g.weather = await fetchWeather(g._wx.coords, g._wx.indoor, g._wx.date);
  });
  for (const g of games) delete g._wx; // scratch field, never leaves the builder

  // A scoreboard "week" is a DATE RANGE, not a set of unplayed games: ESPN's CFB Week 1 spans
  // the Week-0 Saturday through the following Monday, so games already played sit in the same
  // payload as the upcoming slate. Their betting lines are pulled once they're final, which made
  // them render as "Line not set yet" alongside real picks. Split them out: `games` is what's
  // still ahead (pre + in-progress), `results` is what already happened, newest first.
  const upcoming = games.filter((g) => g.state !== 'post');
  const results = games.filter((g) => g.state === 'post')
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

  // Highest-confidence picks (safest) and the upset watchlist — the page's two headline rails.
  // Built from the upcoming slate only: a rail entry for a finished game is noise.
  const picked = upcoming.filter((g) => g.pick);
  const bestPicks = picked.slice().sort((a, b) => b.pick.winProb - a.pick.winProb).slice(0, 5)
    .map((g) => ({ id: g.id, team: g.pick.team, winProb: g.pick.winProb, opp: g.pick.team === g.home.abbr ? g.away.abbr : g.home.abbr }));
  const upsetAlerts = picked.filter((g) => g.upsetAlert)
    .map((g) => ({ id: g.id, underdog: g.pick.team === g.home.abbr ? g.away.abbr : g.home.abbr, favorite: g.pick.team, favWinProb: g.pick.winProb }));

  // Expandable team reports (recent form + offense/defense ranks) for everyone still to play.
  // Precomputed here rather than fetched per click: the slate's teams are a small, known set, so
  // one league-wide stats call plus a schedule each — on the daily cron — makes the panel instant
  // and costs the reader nothing. Best-effort; a failure leaves the cards exactly as they were.
  let teamReports = null;
  if (cfg.leaguePath) {
    try {
      teamReports = await buildTeamReports({
        leaguePath: cfg.leaguePath,
        season: sb.season?.year ?? null,
        teamIds: upcoming.flatMap((g) => [g.home.id, g.away.id]),
      });
    } catch { /* the slate is the product; the panel is an enhancement */ }
  }

  return {
    // See FEED_CONTENT_VERSION: lets a server that has moved on tell a cached feed is behind,
    // without having to infer it from which optional fields happen to be set.
    contentV: FEED_CONTENT_VERSION,
    season: sb.season?.year ?? null,
    seasonType: sb.season?.type ?? null,
    week: sb.week?.number ?? null,
    games: upcoming,
    results,
    teamReports,
    bestPicks,
    upsetAlerts,
    builtAt: new Date().toISOString(),
  };
}

// ===== Past weeks (the week selector's archive) =====

// Shape version for a cached past-week payload. DELIBERATELY SEPARATE from FEED_CONTENT_VERSION:
// that one tracks the pre-game product — weather fields, impact lines, which games make the slate —
// and bumps for reasons a finished scoreline could not care less about. Coupling to it would
// re-fetch every archived week in the season each time a forecast detail changed. This moves only
// when the shape below does.
export const PAST_WEEK_VERSION = 1;

// The season a football date belongs to. Both leagues label a season by the calendar year it
// STARTS in and both run August through January, so a January game belongs to the previous year's
// season. Used only to default the season when a week request doesn't name one — the page always
// names it, because the live feed told it which season it's in.
export function footballSeason(now = new Date()) {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// One PAST week: the finished slate, and nothing that only means something before kickoff.
//
// buildPickem above is the PRE-GAME product — market pick, win %, injuries, weather, team reports —
// and every one of those is a forward-looking read. For a week already played, none of them belong
// on the card (resultCard renders the score and nothing else) and the two rails are built from the
// still-to-play games, so a finished week's rails are empty by construction. Building them anyway
// would spend the ~12s, 172 team reports and ~40 forecast round-trips a live CFB week costs, in
// order to render a scoreline.
//
// So this is the scoreboard call and nothing else — one request in, result cards out. That is what
// makes a full-season week selector cheap enough to leave un-gated, and it is why exposing an
// inline build on a public URL is safe here in the way it is for a box score and is NOT for DvP.
export async function buildPastWeek(cfg) {
  const r = await fetch(cfg.scoreboardUrl, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`ESPN scoreboard HTTP ${r.status}`);
  const sb = await r.json();

  const all = [];
  for (const ev of (sb.events || [])) {
    try {
      const c = ev.competitions?.[0];
      if (!c) continue;
      if (cfg.includeEvent && !cfg.includeEvent(c, ev)) continue;
      const home = c.competitors.find((t) => t.homeAway === 'home');
      const away = c.competitors.find((t) => t.homeAway === 'away');
      if (!home || !away) continue;
      // Only the fields a result card and the slate filters actually read: who played, the score,
      // who won, and the rank/conference the Top-25 and per-conference filters key on. Everything
      // buildPickem carries for a pre-game card — odds, market %, injuries, weather — is absent
      // rather than null-filled, because a played game has no such thing to report.
      const teamOf = (t) => ({
        id: t.team.id,
        abbr: t.team.abbreviation,
        rank: (() => { const k = t.curatedRank?.current; return typeof k === 'number' && k >= 1 && k <= 25 ? k : null; })(),
        conf: t.team.conferenceId != null ? Number(t.team.conferenceId) : null,
        name: t.team.displayName,
        logo: t.team.logo || null,
        record: t.records?.[0]?.summary || null,
        score: t.score != null && t.score !== '' ? Number(t.score) : null,
        winner: t.winner === true,
      });
      const bowlName = cfg.nameOf ? cfg.nameOf(c) : null;
      all.push({
        id: ev.id,
        date: ev.date,
        shortName: ev.shortName,
        state: ev.status?.type?.state || 'pre',
        ...(bowlName ? { bowlName } : {}),
        neutralSite: c.neutralSite === true,
        home: teamOf(home),
        away: teamOf(away),
      });
    } catch { /* skip a single malformed event; keep the slate */ }
  }

  // Same split and same ordering as the live feed, so the page's renderer needs no special case.
  const results = all.filter((g) => g.state === 'post')
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const games = all.filter((g) => g.state !== 'post');

  return {
    // The page reads this to drop the rails, leave live polling off, and stamp the header as a
    // result rather than a freshness time.
    past: true,
    pastV: PAST_WEEK_VERSION,
    season: sb.season?.year ?? null,
    seasonType: sb.season?.type ?? null,
    week: sb.week?.number ?? null,
    games,
    results,
    // Present and explicitly empty rather than omitted: every reader of a Pick'em payload looks
    // for these, and a missing key reads as "never built" to the staleness checks in sports.js.
    teamReports: null,
    bestPicks: [],
    upsetAlerts: [],
    // True only when the window holds games and none of them are still to play — the one condition
    // under which this payload can never change again, and so the only one under which it gets
    // cached. Same rule, for the same reason, as boxScore.js's `final`.
    complete: all.length > 0 && games.length === 0,
    builtAt: new Date().toISOString(),
  };
}
