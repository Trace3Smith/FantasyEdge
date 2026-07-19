// Batter-vs-pitcher (BvP) career lines for the day's probable-pitcher matchups.
//
// For each batter whose team plays today AND faces a NAMED probable starter, fetch that
// batter's career line against that specific pitcher. This is a DAY-OF feature: probable
// starters aren't posted until the morning, so it runs in the autopilot cron (13:00 UTC /
// ~9am ET), not the overnight refresh — and never precomputes ahead.
//
// COST. One schedule call names every game's probable starters. BvP itself is one call per
// (batter, pitcher) pair and CANNOT be batched — a comma-list of opposing ids returns 400 —
// so a full slate is ~1 + ~440 vsPlayer calls. Measured ~54/s at concurrency 8, ~8s total,
// which fits the cron budget with room to spare.
//
// This is DATA ONLY: it records the line and the AB count and stores them. It does not
// classify stars, apply any at-bat floor, or make a start/sit call — that logic reads this
// data elsewhere. Display shows any history, even a single at-bat; the sample-size rules
// live in the start-sit consumer, not here.
//
// Failure-tolerant per batter and overall: a pair that fails is skipped, and if the whole
// thing throws the caller keeps the last good BvP payload rather than dropping it.

import { getJson } from './espn.js';
import { starHitterIds, bvpAdvice } from './bvpAdvice.js';

const API = 'https://statsapi.mlb.com/api/v1';
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isFinite(n) ? n : 0; };
const iso = (d) => d.toISOString().slice(0, 10);

// Bounded-concurrency map (same shape as enrichForm's), so we never open 440 sockets at once.
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

// teamId -> { id, name } of the opposing probable starter today. A batter faces the SP the
// OTHER side is starting, so home batters map to the away probable and vice versa. Teams
// whose opponent has no named starter yet are simply absent (their batters get no BvP today).
async function opposingStarters(date) {
  const j = await getJson(`${API}/schedule?sportId=1&date=${date}&gameType=R&hydrate=probablePitcher`);
  const map = new Map();
  for (const g of j.dates?.[0]?.games || []) {
    const home = g.teams?.home, away = g.teams?.away;
    const homeId = home?.team?.id, awayId = away?.team?.id;
    if (homeId != null && away?.probablePitcher?.id != null) {
      map.set(homeId, { id: away.probablePitcher.id, name: away.probablePitcher.fullName });
    }
    if (awayId != null && home?.probablePitcher?.id != null) {
      map.set(awayId, { id: home.probablePitcher.id, name: home.probablePitcher.fullName });
    }
  }
  return map;
}

// A batter who has NEVER faced this pitcher — the vsPlayer endpoint returns empty splits.
// That is a real, displayable state ("first career matchup"), distinct from a fetch failure,
// so it gets a 0-AB line rather than being dropped. ab === 0 also reads as "no BvP signal"
// to the start-sit consumer, same as a thin sample, so the fallback path is automatic.
const NO_HISTORY = { ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0, avg: null, ops: null };

// One BvP career line. vsPlayer returns a vsPlayerTotal split (career aggregate) plus a
// vsPlayer split; the total is the career line we want. Empty splits => never faced =>
// NO_HISTORY. Returns null ONLY on a malformed response, which the caller counts as an error.
async function bvpLine(batterId, pitcherId) {
  const j = await getJson(
    `${API}/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting&gameType=R`
  );
  const stats = j.stats || [];
  if (!stats.length) return null; // malformed — not the same as "never faced"
  const total = stats.find((s) => /vsplayertotal/i.test(s.type?.displayName || '')) || stats[0];
  const st = total?.splits?.[0]?.stat;
  if (!st) return { ...NO_HISTORY }; // empty splits => never faced
  return {
    ab: num(st.atBats),
    h: num(st.hits),
    hr: num(st.homeRuns),
    rbi: num(st.rbi),
    bb: num(st.baseOnBalls),
    k: num(st.strikeOuts),
    avg: st.avg ?? null,
    ops: st.ops ?? null,
  };
}

// Build the day's BvP payload from the MLB dataset's hitters. Pure: returns the payload,
// the caller decides where to store it. `players` is dataset.players (searchOnly filtered
// out by the caller or here). Only hitters whose team faces a named starter are fetched.
export async function buildBvp(players, { date = iso(new Date()) } = {}) {
  const opp = await opposingStarters(date);
  if (!opp.size) {
    return { date, builtAt: new Date().toISOString(), batters: {}, counts: { matchups: 0, fetched: 0, withHistory: 0, skipped: 0 } };
  }

  // MLB team names on the dataset are full names ("Washington Nationals"); the schedule keys
  // by numeric team id. Resolve via the schedule's own team ids, matched to each hitter's
  // teamId — which the dataset doesn't carry, so map by full team name to id first.
  const nameToId = await teamNameIndex();

  const hitters = players.filter(
    (p) => !p.searchOnly && !['SP', 'RP'].includes(p.pos) && p.id != null
  );
  const targets = [];
  for (const p of hitters) {
    const teamId = nameToId.get(p.team);
    const sp = teamId != null ? opp.get(teamId) : null;
    if (sp) targets.push({ batter: p, sp });
  }

  let withHistory = 0, noHistory = 0, errors = 0;
  const results = await mapLimit(targets, 8, async ({ batter, sp }) => {
    try {
      const line = await bvpLine(batter.id, sp.id);
      if (!line) { errors++; return null; } // malformed response only
      if (line.ab > 0) withHistory++; else noHistory++;
      return { id: batter.id, oppSp: sp, line };
    } catch {
      errors++;
      return null;
    }
  });

  // Attach the start/sit advice now, while the full player list is in hand — the star cutoff
  // needs to rank all hitters by zTotal, so it's computed once here rather than per request.
  const stars = starHitterIds(players);
  const batters = {};
  let starCount = 0, startCount = 0, sitCount = 0;
  for (const r of results) {
    if (!r) continue;
    const advice = bvpAdvice(r.line, stars.has(String(r.id)));
    if (advice.star) starCount++;
    else if (advice.call === 'start') startCount++;
    else if (advice.call === 'sit') sitCount++;
    batters[r.id] = { oppSp: r.oppSp, line: r.line, advice };
  }
  return {
    date,
    builtAt: new Date().toISOString(),
    batters,
    // withHistory = ab>0 ; noHistory = faced today's SP for the first time (0 AB) ;
    // errors = malformed fetches only. matchups = batters with a game vs a named SP.
    // stars/starts/sits count how the advice fell out (stars are START by override).
    counts: { matchups: targets.length, fetched: Object.keys(batters).length, withHistory, noHistory, errors, stars: starCount, starts: startCount, sits: sitCount },
  };
}

// Full team name -> numeric team id (e.g. "Houston Astros" -> 117), from the teams endpoint.
// The dataset stores full names, the schedule stores ids; this bridges them. One call, cached
// for the process lifetime.
let _teamIndex;
async function teamNameIndex() {
  if (_teamIndex) return _teamIndex;
  const j = await getJson(`${API}/teams?sportId=1&activeStatus=Y`);
  _teamIndex = new Map();
  for (const t of j.teams || []) if (t.name && t.id != null) _teamIndex.set(t.name, t.id);
  return _teamIndex;
}
