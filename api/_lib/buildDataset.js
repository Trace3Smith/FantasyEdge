// Single source of MLB data assembly for FantasyEdge.
//
// Builds the full combined player dataset by joining 40-man rosters (the
// canonical player universe) against the season stat leaderboards (the stats +
// ranking source). Used by the daily refresh cron and by api/sports.js as a
// cold-start fallback. This is the ONLY module that talks to the MLB Stats API.
//
// Output: { builtAt, sport, players, counts }
//   players[]: one record per player. hasStats players are the ranked table;
//   rostered-but-statless players are searchOnly (surfaced in search, never in
//   the default ranked list). Phase 2 prospects will append more searchOnly
//   records here.

const API = 'https://statsapi.mlb.com/api/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// Run async fn over items with bounded concurrency (kind to the MLB API).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- roto category pills (thresholds preserved from the original sports.js) ---
function buildMLBCats(stat) {
  if (!stat) return [];
  const cats = [];
  if (parseFloat(stat.avg) > 0.260) cats.push('AVG');
  if (parseInt(stat.homeRuns) > 10) cats.push('HR');
  if (parseInt(stat.runs) > 20) cats.push('R');
  if (parseInt(stat.rbi) > 20) cats.push('RBI');
  if (parseInt(stat.stolenBases) > 5) cats.push('SB');
  if (parseFloat(stat.obp) > 0.320) cats.push('OBP');
  return cats;
}

function buildMLBPitchingCats(stat) {
  if (!stat) return [];
  const cats = [];
  if (parseFloat(stat.era) > 0 && parseFloat(stat.era) < 3.50) cats.push('ERA');
  if (parseInt(stat.strikeOuts) > 60) cats.push('K');
  if (parseFloat(stat.whip) > 0 && parseFloat(stat.whip) < 1.20) cats.push('WHIP');
  if (parseInt(stat.wins) > 5) cats.push('W');
  if (parseInt(stat.saves) > 8) cats.push('SV');
  if (parseInt(stat.holds) > 8) cats.push('HD');
  return cats;
}

function assignHitting(rec, stat) {
  rec.hasStats = true;
  rec.group = 'hitting';
  rec.s1 = stat.avg || '.000';
  rec.s2 = stat.homeRuns ?? '0';
  rec.s3 = stat.rbi ?? '0';
  rec.s4 = stat.runs ?? '0';
  rec.s5 = stat.stolenBases ?? '0';
  rec.s6 = stat.obp ?? '—';
  rec.statLabels = ['AVG', 'HR', 'RBI', 'R', 'SB', 'OBP'];
  rec.cats = buildMLBCats(stat);
  // Raw numeric inputs for z-score valuation (stripped before the wire).
  rec._h = {
    pa: parseInt(stat.plateAppearances) || 0,
    ab: parseInt(stat.atBats) || 0,
    h: parseInt(stat.hits) || 0,
    bb: parseInt(stat.baseOnBalls) || 0,
    hbp: parseInt(stat.hitByPitch) || 0,
    sf: parseInt(stat.sacFlies) || 0,
    hr: parseInt(stat.homeRuns) || 0,
    r: parseInt(stat.runs) || 0,
    rbi: parseInt(stat.rbi) || 0,
    sb: parseInt(stat.stolenBases) || 0,
    avg: parseFloat(stat.avg) || 0,
    obp: parseFloat(stat.obp) || 0,
  };
}

// The full roto category key set (hitting + pitching). Each player's z block carries
// all keys so a mixed roster's category profile spans both groups (a hitter is simply 0
// in every pitching cat and vice-versa) — see mlbScoring.js. Kept in sync with MLB_CATS.
const Z_KEYS = ['r', 'hr', 'rbi', 'sb', 'avg', 'obp', 'w', 'sv', 'k', 'era', 'whip'];
const emptyZ = () => Object.fromEntries(Z_KEYS.map((k) => [k, 0]));

// Standardize a pool over a set of {srcKey -> zKey} columns: z-score each column and write
// a per-player z block (rec.z) + summed value (rec.zTotal). `read(rec)` returns the raw
// numeric source object for that record. Counting cats are plain z; pre-marginalized rate
// cats (mAVG/mOBP/mERA/mWHIP) are passed as their own columns by the callers.
function standardize(pool, cols, read) {
  if (!pool.length) return;
  const norm = {};
  for (const [src] of cols) {
    const xs = pool.map((p) => read(p)[src]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1;
    norm[src] = { m, sd };
  }
  for (const p of pool) {
    const z = emptyZ();
    let tot = 0;
    for (const [src, zKey] of cols) {
      const v = (read(p)[src] - norm[src].m) / norm[src].sd;
      z[zKey] = v;
      tot += v;
    }
    p.z = z;
    p.zTotal = tot;
    p.score = tot; // legacy: hitter ranking still sorts by this (unchanged value)
  }
}

// Rank qualified hitters by total standardized roto value across the six
// hitting categories. Counting cats (HR/R/RBI/SB) use a plain z-score; rate
// cats (AVG/OBP) use a playing-time-weighted marginal value so a hot bat in a
// small sample can't outrank a regular. Sets rec.z / rec.zTotal / rec.score in place.
function scoreHitters(pool) {
  if (!pool.length) return;
  // Pool-aggregate league rates (weighted by opportunity).
  const sum = (f) => pool.reduce((a, p) => a + f(p._h), 0);
  const lgAVG = sum((h) => h.h) / (sum((h) => h.ab) || 1);
  const lgOBP =
    sum((h) => h.h + h.bb + h.hbp) / (sum((h) => h.ab + h.bb + h.hbp + h.sf) || 1);
  for (const p of pool) {
    const h = p._h;
    h.mAVG = (h.avg - lgAVG) * h.ab; // hits above average given their at-bats
    h.mOBP = (h.obp - lgOBP) * (h.ab + h.bb + h.hbp + h.sf); // times-on-base above avg
  }
  standardize(
    pool,
    [['r', 'r'], ['hr', 'hr'], ['rbi', 'rbi'], ['sb', 'sb'], ['mAVG', 'avg'], ['mOBP', 'obp']],
    (p) => p._h,
  );
}

// Score pitchers across the five standard pitching cats (W/SV/K + inverted, innings-weighted
// ERA/WHIP). Counting cats are plain z; the rate cats use an innings-weighted marginal so a
// dominant ratio over many innings beats the same ratio in a cup of coffee. Adds rec.z /
// rec.zTotal for the draft board WITHOUT changing rec.rank (pitchers still display K-sorted).
function scorePitchers(pool) {
  if (!pool.length) return;
  const sumIp = pool.reduce((a, p) => a + p._p.ip, 0) || 1;
  const lgERA = pool.reduce((a, p) => a + p._p.era * p._p.ip, 0) / sumIp;
  const lgWHIP = pool.reduce((a, p) => a + p._p.whip * p._p.ip, 0) / sumIp;
  for (const p of pool) {
    const pi = p._p;
    pi.mERA = (lgERA - pi.era) * pi.ip; // earned runs prevented vs. league, over his innings
    pi.mWHIP = (lgWHIP - pi.whip) * pi.ip; // baserunners prevented vs. league, over his innings
  }
  standardize(
    pool,
    [['w', 'w'], ['sv', 'sv'], ['k', 'k'], ['mERA', 'era'], ['mWHIP', 'whip']],
    (p) => p._p,
  );
}

// Innings pitched: MLB notates partial innings as .1 (1 out) / .2 (2 outs), so
// "50.1" is 50⅓ IP — convert the fractional part from thirds, not tenths.
function parseIp(s) {
  if (s == null) return 0;
  const [whole, frac] = String(s).split('.');
  return (parseInt(whole) || 0) + (frac ? parseInt(frac) / 3 : 0);
}

function assignPitching(rec, stat) {
  rec.hasStats = true;
  rec.group = 'pitching';
  rec.sortVal = parseInt(stat.strikeOuts) || 0; // ranked by K desc (as before)
  // The API only reports position "P"; classify SP vs RP from usage.
  const gs = parseInt(stat.gamesStarted) || 0;
  const gp = parseInt(stat.gamesPlayed) || 0;
  rec.pos = gs >= Math.max(1, gp * 0.5) ? 'SP' : 'RP';
  rec.s1 = stat.strikeOuts ?? '0';
  rec.s2 = stat.wins ?? '0';
  rec.s3 = stat.saves ?? '0';
  rec.s4 = stat.holds ?? '0';
  rec.s5 = stat.era ?? '—';
  rec.s6 = stat.whip ?? '—';
  rec.statLabels = ['K', 'W', 'SV', 'HD', 'ERA', 'WHIP'];
  rec.cats = buildMLBPitchingCats(stat);
  // Raw numeric inputs for z-score valuation (stripped before the wire).
  rec._p = {
    ip: parseIp(stat.inningsPitched),
    w: parseInt(stat.wins) || 0,
    sv: parseInt(stat.saves) || 0,
    k: parseInt(stat.strikeOuts) || 0,
    era: parseFloat(stat.era) || 0,
    whip: parseFloat(stat.whip) || 0,
  };
}

// Cosmetic trend/own/tag, derived from a player's rank within its group —
// mirrors the original sports.js behavior.
function decorate(rec, i) {
  rec.rank = i + 1;
  rec.emoji = '⚾';
  rec.trend = 'flat';   // real HOT/COLD form is applied later by enrichForm (cron)
  rec.trendVal = '';
  rec.own = Math.max(10, 99 - i * 2);
  rec.tag = null;       // no rank-based badges; HOT/COLD come from recent form
}

export async function buildDataset({ season = new Date().getFullYear() } = {}) {
  // 1. Teams (30) → 2. 40-man rosters (canonical universe).
  const teams = (await getJson(`${API}/teams?sportId=1&season=${season}`)).teams || [];
  // League per team id (AL=103, NL=104) — drives the AL/NL rankings filter. A
  // player's league follows his roster, so trades auto-update on the next build.
  const leagueByTeamId = new Map(
    teams.map((t) => [t.id, t.league?.id === 103 ? 'AL' : t.league?.id === 104 ? 'NL' : null])
  );
  const rosters = await mapLimit(teams, 5, (t) =>
    getJson(`${API}/teams/${t.id}/roster?rosterType=40Man&season=${season}`)
      .then((d) => ({ team: t, roster: d.roster || [] }))
      .catch(() => ({ team: t, roster: [] }))
  );

  // 3. Stat leaderboards. Hitting is sorted by a COUNTING stat (homeRuns) to
  // avoid the qualified-batter min-PA filter that caps battingAverage sorts at
  // ~156; high limit pulls everyone with stats.
  const [hd, pd] = await Promise.all([
    getJson(`${API}/stats?stats=season&group=hitting&gameType=R&season=${season}&limit=2000&sortStat=homeRuns&order=desc`),
    getJson(`${API}/stats?stats=season&group=pitching&gameType=R&season=${season}&limit=2000&sortStat=strikeOuts&order=desc`),
  ]);
  const hitSplits = hd.stats?.[0]?.splits || [];
  const pitSplits = pd.stats?.[0]?.splits || [];
  // Games the leaders have played ≈ team games played; drives the dynamic PA gate.
  const teamGames = Math.max(
    0,
    ...hitSplits.map((s) => parseInt(s.stat?.gamesPlayed) || 0),
    ...pitSplits.map((s) => parseInt(s.stat?.gamesPlayed) || 0)
  );
  const hitById = new Map(hitSplits.filter((s) => s.player?.id).map((s) => [s.player.id, s]));
  const pitById = new Map(pitSplits.filter((s) => s.player?.id).map((s) => [s.player.id, s]));

  // 4. Seed records from rosters (identity + rostered flag).
  const records = new Map();
  for (const { team, roster } of rosters) {
    for (const e of roster) {
      const id = e.person?.id;
      if (id == null) continue;
      records.set(id, {
        id,
        name: e.person.fullName || 'Unknown',
        team: team.name || '—',
        league: leagueByTeamId.get(team.id) || null,
        pos: e.position?.abbreviation || '—',
        posType: e.position?.type || '',
        rostered: true,
        hasStats: false,
      });
    }
  }

  // Ensure a record exists for a leaderboard player not on any 40-man (rare:
  // recently DFA'd / traded). They still get stats and appear in rankings.
  function ensure(id, split) {
    let r = records.get(id);
    if (!r) {
      r = {
        id,
        name: split.player?.fullName || 'Unknown',
        team: split.team?.name || '—',
        league: leagueByTeamId.get(split.team?.id) || null,
        pos: split.position?.abbreviation || '—',
        posType: split.position?.type || '',
        rostered: false,
        hasStats: false,
      };
      records.set(id, r);
    }
    return r;
  }

  // 5. Join stats. Group decided by roster position type, falling back to which
  // leaderboard the player appears in. Pitchers prefer pitching stats; everyone
  // else (incl. two-way players like Ohtani, listed as DH/TWP) takes hitting.
  const allStatIds = new Set([...hitById.keys(), ...pitById.keys()]);
  for (const id of allStatIds) {
    const rec = ensure(id, hitById.get(id) || pitById.get(id));
    const isPitcher = rec.posType === 'Pitcher' || (pitById.has(id) && !hitById.has(id));
    if (isPitcher && pitById.has(id)) assignPitching(rec, pitById.get(id).stat || {});
    else if (hitById.has(id)) assignHitting(rec, hitById.get(id).stat || {});
    else if (pitById.has(id)) assignPitching(rec, pitById.get(id).stat || {});
  }

  // 6. Rank the table.
  //   Hitters: gate by 2.0 PA per team game, then order by multi-category
  //   z-score value. Sub-threshold hitters fall to searchOnly (kept stats, but
  //   out of the ranked list) so small samples don't float to the top.
  //   Pitchers: K desc, as before. searchOnly: statless roster players too.
  const all = [...records.values()];
  const paThreshold = Math.round(2.0 * teamGames);
  const allHitters = all.filter((r) => r.hasStats && r.group === 'hitting');
  const qualHitters = allHitters.filter((r) => r._h.pa >= paThreshold);
  const subHitters = allHitters.filter((r) => r._h.pa < paThreshold);
  const pitchers = all
    .filter((r) => r.hasStats && r.group === 'pitching')
    .sort((a, b) => b.sortVal - a.sortVal);

  scoreHitters(qualHitters);
  qualHitters.sort((a, b) => b.score - a.score);
  // Pitchers keep their K-sorted rank/order (unchanged for the rankings page), but get a
  // roto z block + zTotal so the draft board can value them on the same scale as hitters.
  scorePitchers(pitchers);

  qualHitters.forEach(decorate);
  pitchers.forEach(decorate);

  const searchOnly = [...subHitters, ...all.filter((r) => !r.hasStats)];
  for (const r of searchOnly) {
    r.searchOnly = true; // out of the ranked list; surfaced in search only
    r.emoji = '⚾';
  }

  const players = [...qualHitters, ...pitchers, ...searchOnly];
  // Clean internal-only fields off the wire (z / zTotal are kept for the draft board).
  for (const r of players) {
    delete r.posType;
    delete r.sortVal;
    delete r.group;
    delete r.score;
    delete r._h;
    delete r._p;
  }

  return {
    builtAt: new Date().toISOString(),
    sport: 'mlb',
    players,
    counts: {
      teams: teams.length,
      teamGames,
      paThreshold,
      rostered: all.filter((r) => r.rostered).length,
      hitters: qualHitters.length,
      pitchers: pitchers.length,
      hasStats: qualHitters.length + pitchers.length,
      subThresholdHitters: subHitters.length,
      searchOnly: searchOnly.length,
      total: players.length,
    },
  };
}
