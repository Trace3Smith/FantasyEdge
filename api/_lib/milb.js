// Minor-league hitting stats for Phase 2, sourced the same way Phase 1 sources
// MLB stats: fetch each level's season leaderboard once (limit high enough to
// pull everyone) and join by MLBAM person.id. Five level calls cover every
// minor leaguer at every level — far cheaper than per-player stat requests.
//
// Levels (MLB sportIds): AAA=11, AA=12, High-A=13, Single-A=14, Rookie/complex=16.
// A player with lines at multiple levels in one season gets one entry per level,
// ordered most-advanced first (AAA above AA, etc.).

const API = 'https://statsapi.mlb.com/api/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

// Ordered most-advanced first; index doubles as the promotion comparator.
export const LEVELS = [
  { sportId: 11, label: 'AAA' },
  { sportId: 12, label: 'AA' },
  { sportId: 13, label: 'A+' },
  { sportId: 14, label: 'A' },
  { sportId: 16, label: 'Rk' },
];
const LEVEL_INDEX = new Map(LEVELS.map((l, i) => [l.label, i]));
export const levelIndex = (label) => (LEVEL_INDEX.has(label) ? LEVEL_INDEX.get(label) : 99);

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

function normName(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z\s]/g, '') // drop punctuation (Jr., periods, hyphens)
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineFromStat(label, split) {
  const s = split.stat || {};
  const num = (v) => parseInt(v) || 0;
  return {
    level: label,
    team: split.team?.name || '—',
    pa: num(s.plateAppearances),
    ab: num(s.atBats),
    h: num(s.hits),
    bb: num(s.baseOnBalls),
    hbp: num(s.hitByPitch),
    sf: num(s.sacFlies),
    tb: num(s.totalBases),
    hr: num(s.homeRuns),
    r: num(s.runs),
    rbi: num(s.rbi),
    sb: num(s.stolenBases),
    avg: s.avg ?? '.000',
    obp: s.obp ?? '.000',
    slg: s.slg ?? '.000',
    ops: s.ops ?? '.000',
  };
}

// Fetch all five level leaderboards and build:
//   byId:   Map<mlbamId, [line, …]>  (lines sorted most-advanced first)
//   byName: Map<normName, mlbamId | null>  (null marks an ambiguous name)
//   names:  Map<mlbamId, fullName>
export async function fetchMilbHitting({ season = new Date().getFullYear() } = {}) {
  const boards = await Promise.all(
    LEVELS.map((l) =>
      getJson(
        `${API}/stats?stats=season&group=hitting&gameType=R&season=${season}&sportId=${l.sportId}&limit=3000&sortStat=plateAppearances&order=desc`
      )
        .then((d) => ({ level: l.label, splits: d.stats?.[0]?.splits || [] }))
        .catch(() => ({ level: l.label, splits: [] }))
    )
  );

  const byId = new Map();
  const names = new Map();
  const nameCount = new Map(); // normName -> Set<id> to detect ambiguity
  for (const { level, splits } of boards) {
    for (const sp of splits) {
      const id = sp.player?.id;
      if (id == null) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(lineFromStat(level, sp));
      const full = sp.player?.fullName;
      if (full && !names.has(id)) {
        names.set(id, full);
        const nn = normName(full);
        if (!nameCount.has(nn)) nameCount.set(nn, new Set());
        nameCount.get(nn).add(id);
      }
    }
  }
  for (const lines of byId.values()) lines.sort((a, b) => levelIndex(a.level) - levelIndex(b.level));

  const byName = new Map();
  for (const [nn, ids] of nameCount) byName.set(nn, ids.size === 1 ? [...ids][0] : null);

  return { byId, byName, names, normName };
}
