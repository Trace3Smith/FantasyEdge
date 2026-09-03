#!/usr/bin/env node
// Regression check for player team affiliation. Two layers:
//
//   1. OFFLINE unit cases over applyCurrentTeams — the pure merge. Deterministic, always runs.
//   2. LIVE check of the served board against ESPN's current rosters, joined on athlete id.
//
// Why this exists: the byathlete leaderboard reports each athlete's STAT-SEASON team, so after an
// offseason ~20% of the pool carried a stale one (A.J. Brown as PHI, Wan'Dale Robinson as NYG). Not
// a caching bug — the cron refreshes daily; the field simply means "2025 team".
//
// Usage:  npm run check:teams          Exit: 0 clean · 1 drift found · 2 could not check
const BOARD = process.env.BOARD_URL || 'https://fantasy-edge-nine.vercel.app/api/sports?sport=nfl';
const H = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };
const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl';
const get = async (u) => { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(30000) }); return r.ok ? r.json() : null; };

let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };

// ---- 1. offline unit cases ---------------------------------------------------------------------
const { applyCurrentTeams } = await import('../api/_lib/buildNflDataset.js');
console.log('offline — applyCurrentTeams merge rules');
{
  const ps = [
    { id: '1', pos: 'WR', name: 'Stale', team: 'NYG', teamId: '19' },
    { id: '2', pos: 'WR', name: 'Agrees', team: 'KC', teamId: '12' },
    { id: '3', pos: 'RB', name: 'Absent', team: 'ARI', teamId: '22' },
    { id: 'dst-1', pos: 'DST', name: 'Falcons D/ST', team: 'ATL' },
    { id: 'sleeper-9', pos: 'WR', name: 'Seeded', team: 'GB' },
  ];
  const idx = new Map([['1', { abbr: 'TEN', teamId: '10' }], ['2', { abbr: 'KC', teamId: '12' }]]);
  const r = applyCurrentTeams(ps, idx);
  check('a stale team is corrected', ps[0].team === 'TEN' && ps[0].teamId === '10');
  check('an agreeing team is left alone', ps[1].team === 'KC' && r.confirmed === 1);
  // The important one: absence is ambiguous (one failed roster fetch drops a whole team), so it must
  // never become "free agent". A real run lost all of Arizona, including a top-30 TE.
  check('an athlete no roster lists is NOT marked FA', ps[2].team === 'ARI' && r.unmatched === 1);
  check('DST rows are skipped (a DST IS a team)', ps[3].team === 'ATL');
  check('Sleeper-seeded rows are skipped (already current)', ps[4].team === 'GB');
  check('counts are reported', r.corrected === 1 && r.confirmed === 1 && r.unmatched === 1);
  const empty = applyCurrentTeams([{ id: '1', pos: 'WR', team: 'NYG' }], new Map());
  check('an empty index changes nothing', empty.corrected === 0);
}

// ---- 1b. offline injury merge rules -------------------------------------------------------------
const { applyInjuries } = await import('../api/_lib/espnInjuries.js');
console.log('\noffline — applyInjuries merge rules');
{
  const ps = [
    { id: '1', pos: 'RB', name: 'Questionable' },
    { id: '2', pos: 'WR', name: 'Healthy' },
    { id: '3', pos: 'WR', name: 'Recovered', injury: { status: 'Out' } },
    { id: '4', pos: 'QB', name: 'Suspended' },
    { id: 'dst-1', pos: 'DST', name: 'Falcons D/ST' },
  ];
  const idx = new Map([
    ['1', { code: 'INJURY_STATUS_QUESTIONABLE', status: 'Questionable', abbr: 'Q', detail: 'Ankle Sprain', returnDate: '2026-09-13' }],
    ['3', { code: 'INJURY_STATUS_ACTIVE', status: 'Active' }],        // recovered — must NOT stay flagged
    ['4', { code: 'INJURY_STATUS_SUSPENSION', status: 'suspension', abbr: 'SUSP' }], // MLB spells it lowercase
    ['dst-1', { code: 'INJURY_STATUS_OUT', status: 'Out' }],
  ]);
  const r = applyInjuries(ps, idx);
  check('an availability-affecting status is attached', ps[0].injury?.status === 'Questionable');
  check('a healthy player carries nothing', !ps[1].injury);
  // "Active" here means a listed player who has RECOVERED. Attaching it would badge healthy players,
  // and leaving a previous record would keep a returned player flagged as Out.
  check('a recovered player is cleared, not left flagged', !ps[2].injury && r.cleared === 1);
  // Keyed on type.name, so MLB's lowercase "suspension" is the same state as the NFL's "Suspension".
  check('a suspension is carried regardless of status casing', ps[3].injury?.code === 'INJURY_STATUS_SUSPENSION');
  check('DST rows are skipped', !ps[4].injury);
  check('counts are reported', r.flagged === 2 && r.cleared === 1);
  // The regression that motivated the re-key: an allowlist over the free-text status dropped every
  // MLB entry and 67 of 76 NBA ones. A code we have never seen must SURFACE, not vanish.
  const exotic = [{ id: 'x', pos: 'RB', name: 'Novel' }];
  applyInjuries(exotic, new Map([['x', { code: 'INJURY_STATUS_60DAYIL', status: '60-Day-IL', abbr: 'IL60' }]]));
  check('an unfamiliar designation still surfaces (denylist, not allowlist)', exotic[0].injury?.abbr === 'IL60');
}

// ---- 1c. offline MLB status mapping -------------------------------------------------------------
const { mlbStatusToInjury } = await import('../api/_lib/mlbInjuries.js');
console.log('\noffline — MLB statsapi status mapping');
{
  const inj = ['D60', 'D15', 'D10', 'D7', 'ILF', 'RA', 'SU'];
  check('every injury/suspension code maps', inj.every((c) => mlbStatusToInjury(c, 'x')));
  check('IL codes carry the shared cross-sport shape',
    mlbStatusToInjury('D15', 'Injured 15-Day')?.code === 'INJURY_STATUS_15DAYIL'
    && mlbStatusToInjury('D15', 'Injured 15-Day')?.abbr === 'IL15');
  check('MLB wording is preserved verbatim', mlbStatusToInjury('D60', 'Injured 60-Day')?.status === 'Injured 60-Day');
  check('statsapi has no body part or return date, and we do not invent one',
    mlbStatusToInjury('D10', 'x')?.detail === null && mlbStatusToInjury('D10', 'x')?.returnDate === null);
  // Roster mechanics are not injuries — a demoted player must not wear an injury badge.
  check('roster-mechanic codes are excluded',
    ['RM', 'DEV', 'RES', 'TAX', 'NYR', 'DES', 'TI', 'A'].every((c) => mlbStatusToInjury(c, 'x') === null));
  // Off-field designations are deliberately out of scope. None currently land on a pool player, and
  // surfacing an off-field status about a real person is a decision to take deliberately, not inherit.
  check('off-field designations are excluded',
    ['RST', 'ADM', 'IN', 'RET', 'MIL'].every((c) => mlbStatusToInjury(c, 'x') === null));
  check('an unknown code is ignored rather than guessed', mlbStatusToInjury('ZZZ', 'x') === null);
}

// ---- 1d. MLB condition parsing (body part, from the transactions feed) --------------------------
const { conditionFromDescription } = await import('../api/_lib/mlbInjuries.js');
console.log('\noffline — MLB IL condition parsing');
{
  const c = conditionFromDescription;
  check('a plain placement yields the condition',
    c('Atlanta Braves placed 3B Austin Riley on the 10-day injured list. Left oblique strain.') === 'Left oblique strain');
  // THE TRAP: team names contain periods, so splitting on '.' returns the middle of the sentence.
  // This exact case produced "Louis Cardinals placed 3B ..." on the first attempt.
  check('a team name containing a period does not corrupt the parse',
    c('St. Louis Cardinals placed 3B Blaze Jordan on the 10-day injured list. Left ankle sprain.') === 'Left ankle sprain');
  check('a retroactive clause is skipped, not captured',
    c('St. Louis Cardinals placed RHP Peter Strzelecki on the 15-day injured list retroactive to August 26, 2026. Right forearm extensor inflammation.')
      === 'Right forearm extensor inflammation');
  check('an activation is not a placement', c('Las Vegas Aviators activated C Chad Wallach from the 7-day injured list.') === null);
  check('a placement with no stated condition yields null',
    c('Cedar Rapids Kernels placed RHP Eston Stull on the 7-day injured list.') === null);
  check('junk input is handled', c('') === null && c(null) === null && c('traded for cash') === null);
}

// ---- 2. live drift check ------------------------------------------------------------------------
console.log('\nlive — served board vs ESPN current rosters');
let board, index = new Map(), rosters = 0;
try {
  board = await get(BOARD);
  const list = await get(`${ESPN}/teams?limit=40`);
  const ids = (list?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t?.team?.id).filter(Boolean);
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.all(ids.slice(i, i + 8).map(async (id) => {
      try { const j = await get(`${ESPN}/teams/${id}/roster`); if (!j) return null;
        const out = []; for (const g of (j.athletes || [])) for (const a of (g.items || [])) if (a?.id) out.push([String(a.id), j.team?.abbreviation]);
        return out; } catch { return null; }
    }));
    for (const rows of batch) { if (!rows) continue; rosters++; for (const [k, v] of rows) index.set(k, v); }
  }
} catch (e) { console.error(`   could not reach a source: ${e.message}`); process.exit(2); }
if (!board?.players?.length || !index.size) { console.error('   no board or no roster index'); process.exit(2); }

const pool = board.players.filter((p) => p.rank != null && !p.searchOnly && p.pos !== 'DST' && !String(p.id).startsWith('sleeper-'));
const drift = pool.filter((p) => { const t = index.get(String(p.id)); return t && t !== p.team; });
console.log(`   board built ${board.builtAt} · ${rosters}/32 rosters read · ${pool.length} players comparable`);
check(`no pool player disagrees with the current roster feed`, drift.length === 0,
  drift.length ? `${drift.length} stale: ` + drift.sort((a,b)=>a.rank-b.rank).slice(0,6).map((p) => `${p.name} ${p.team}->${index.get(String(p.id))}`).join(', ') : '');
check('rosters were substantially readable (>= 28/32)', rosters >= 28, `${rosters}/32`);

// Injury coverage on the served board. Absent entirely = the enrichment did not run.
const flagged = board.players.filter((p) => p.injury && p.injury.status);
console.log(`   ${flagged.length} players carry an injury designation`);
check('the board carries injury designations at all', flagged.length > 0,
  flagged.length ? '' : 'no p.injury anywhere — enrichment missing or not yet deployed');
check('no player is flagged with a non-availability status', !flagged.some((p) => p.injury.status === 'Active'));

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
