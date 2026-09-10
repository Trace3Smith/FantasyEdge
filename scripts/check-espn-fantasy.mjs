#!/usr/bin/env node
// Offline checks for the ESPN Fantasy integration layer: the NFL slot/position maps and the 409
// rejection parser. No ESPN session needed — both are pure.
//
// The NFL maps were reconstructed from ESPN's public kona_player_info feed by cross-referencing
// eligibleSlots against defaultPositionId, so these assertions pin what that data showed.
//
// Usage:  npm run check:espn      Exit: 0 clean · 1 a check failed
import { slotLabel, isActiveSlot, parse409Names } from '../api/_lib/espnFantasy.js';
import { buildValueIndex, suggestLineup, nflScoringOf } from '../api/_lib/lineupAdvisor.js';

let failed = 0;
const check = (n, ok, d) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${n}${d ? ` — ${d}` : ''}`); };

console.log('offline — NFL slot map (derived from ESPN\'s player feed)');
{
  check('offensive slots map correctly',
    slotLabel(0,'nfl')==='QB' && slotLabel(2,'nfl')==='RB' && slotLabel(4,'nfl')==='WR' && slotLabel(6,'nfl')==='TE');
  // Slot 23 accepts exactly RB/WR/TE in the feed; slot 7 adds QB.
  check('slot 23 is FLEX and slot 7 is the superflex/OP', slotLabel(23,'nfl')==='FLEX' && slotLabel(7,'nfl')==='OP');
  check('K and D/ST map', slotLabel(17,'nfl')==='K' && slotLabel(16,'nfl')==='D/ST');
  // 20 and 21 are the two universal slots (11,196 players each, identical position sets).
  check('20 is the bench and 21 is IR', slotLabel(20,'nfl')==='BE' && slotLabel(21,'nfl')==='IR');
  check('bench and IR are both inactive slots', !isActiveSlot(20,'nfl') && !isActiveSlot(21,'nfl'));
  check('a real lineup slot is active', isActiveSlot(0,'nfl') && isActiveSlot(23,'nfl'));
  // Slot 25 is real but unidentified (668 players, 97% rookies, not injury-linked). Deliberately
  // unmapped rather than given a guessed label — it must fall through to its raw id.
  check('slot 25 is left unmapped, not guessed', slotLabel(25,'nfl') === '25');
  check('other sports are untouched', slotLabel(17,'mlb')==='IL' && slotLabel(13,'nba')==='IR' && slotLabel(12,'wnba')==='BE');
}

console.log('\noffline — 409 rejection parsing');
{
  const locked = (b) => parse409Names(b, 'is\\s+locked');
  check('the MLB wording it was built on still parses', locked('Spencer Horwitz is locked')[0] === 'Spencer Horwitz');
  check('an NFL skill player parses', locked('Christian McCaffrey is locked')[0] === 'Christian McCaffrey');
  // THE REGRESSION: ESPN names NFL defenses "Bills D/ST". Before the character class allowed '/',
  // this captured "ST", which matches no roster entry — so the locked player could not be dropped and
  // the WHOLE lineup write aborted instead of degrading to a partial apply.
  check('a D/ST name is not truncated at the slash', locked('Bills D/ST is locked')[0] === 'Bills D/ST');
  check('a long-form D/ST name parses', locked('Buffalo Bills D/ST is locked')[0] === 'Buffalo Bills D/ST');
  check('a generational suffix survives', locked('Michael Pittman Jr. is locked')[0] === 'Michael Pittman Jr.');
  check('the already-in-slot reason still parses',
    parse409Names('Mike Trout is already in the BE slot', 'is\\s+already\\s+in')[0] === 'Mike Trout');
  check('junk input yields nothing', locked('').length === 0 && locked(null).length === 0);
}

console.log('\noffline — NFL value index and bye handling');
{
  // NFL carries no per-game stat object, so this is a third value model over the blended season
  // projection divided by the season length. Scoring is the league's own PPR/half/standard.
  const pool = [
    { name: 'Elite RB', pos: 'RB', fpPpr: 340, fpStd: 250, rank: 1 },
    { name: 'Mid WR',   pos: 'WR', fpPpr: 170, fpStd: 120, rank: 50 },
  ];
  const ppr = buildValueIndex(pool, 'nfl', 'ppr');
  const std = buildValueIndex(pool, 'nfl', 'standard');
  check('the NFL index builds per-game values', Math.abs(ppr.get('elite rb').z - 340 / 17) < 0.01);
  check('...and honours the league scoring', std.get('elite rb').z < ppr.get('elite rb').z);
  check('it does not fall through to the hoops/MLB models', ppr.size === 2 && ppr.get('mid wr'));

  // A bye is not an injury. Both halves matter: bench him, never IR him.
  const mk = (name, slotId, proTeamId, injury = '') => ({ id: name, name, slotId, starter: ![20, 21].includes(slotId),
    injury, injuryStatus: injury ? 'OUT' : 'ACTIVE', eligibleSlots: [0, 2, 4, 6, 23, 20, 21], locked: false, pos: 'RB', proTeamId });
  const league = (week, byeTeam) => ({ scoringPeriodId: week, slotCounts: { 2: 1, 20: 2, 21: 1 },
    roster: [mk('Elite RB', 2, byeTeam), mk('Mid WR', 20, 99)] });
  const byes = new Map([[12, 5]]);   // team 12 is on bye in week 5

  let s2 = suggestLineup(league(5, 12), ppr, 'nfl', { byeWeeks: byes });
  check('a player on bye is never sent to IR', !s2.plan.some((x) => x.il));
  check('...but is moved off a starting slot', s2.plan.some((x) => x.playerId === 'Elite RB' && x.toLineupSlotId === 20));
  // An absent or empty map means UNKNOWN. Treating it as "not on bye" would be a silent wrong answer.
  s2 = suggestLineup(league(5, 12), ppr, 'nfl', {});
  check('no bye map means unknown, so nobody is benched for a bye', !s2.plan.some((x) => x.playerId === 'Elite RB'));
  s2 = suggestLineup(league(9, 12), ppr, 'nfl', { byeWeeks: byes });
  check('a non-bye week leaves the same player alone', !s2.plan.some((x) => x.playerId === 'Elite RB'));
}

console.log('\noffline — NFL league scoring reaches the value model');
{
  // parseScoringSettings hands the engine a per-stat POINTS map, not a PPR string. Reading only a
  // string sent every NFL league down the full-PPR path, whatever it actually scored receptions at.
  const pool = [{ name: 'Slot WR', pos: 'WR', fpPpr: 200, fpStd: 120, rank: 30 }];
  const base = { passYds: 0.04, passTD: 4, rushYds: 0.1, rushTD: 6, recYds: 0.1, recTD: 6 };
  const z = (w) => buildValueIndex(pool, 'nfl', w).get('slot wr').z;
  check('rec 1 is full PPR', nflScoringOf({ ...base, rec: 1 }) === 'ppr' && Math.abs(z({ ...base, rec: 1 }) - 200 / 17) < 0.01);
  check('rec 0.5 is half PPR', nflScoringOf({ ...base, rec: 0.5 }) === 'half' && Math.abs(z({ ...base, rec: 0.5 }) - 160 / 17) < 0.01);
  check('no reception scoring is standard', nflScoringOf(base) === 'standard' && Math.abs(z(base) - 120 / 17) < 0.01);
  check('unparsed scoring keeps the PPR default', nflScoringOf(null) === 'ppr');
  check('a PPR string still passes straight through', nflScoringOf('half') === 'half');
}

console.log('\noffline — NFL waiver adds respect position need');
{
  // The reported case: Hurts starts, Mahomes backs him up, 1-QB league. The waiver engine compared
  // raw per-game points only, so free-agent QB Jordan Love (+5.4 over bench WR Jakobi Meyers) was
  // suggested as an add — a QB3 who never sees the field. The IR move and the empty-slot start on
  // the same roster were right and must stay exactly as they were.
  const pool = [
    ['Jalen Hurts', 'QB', 400], ['Patrick Mahomes', 'QB', 370], ['Jordan Love', 'QB', 300],
    ['Zach Charbonnet', 'RB', 200], ['Bijan Robinson', 'RB', 340], ['James Conner', 'RB', 230],
    ['Jaylen Waddle', 'WR', 240], ['Jakobi Meyers', 'WR', 190], ['Amon-Ra St. Brown', 'WR', 330],
    ['Tee Higgins', 'WR', 230], ['Sam LaPorta', 'TE', 200], ['Brandon Aubrey', 'K', 150], ['Ravens D/ST', 'D/ST', 130],
    ['Waiver WR', 'WR', 290], ['Waiver TE', 'TE', 120],
  ].map(([name, pos, fp], i) => ({ name, pos, fpPpr: fp, fpStd: fp * 0.75, rank: i + 1 }));
  const idx = buildValueIndex(pool, 'nfl', 'ppr');
  const E = { QB: [0, 7, 20, 21], RB: [2, 23, 7, 20, 21], WR: [4, 23, 7, 20, 21], TE: [6, 23, 7, 20, 21], K: [17, 20, 21], 'D/ST': [16, 20, 21] };
  let nid = 1;
  const pl = (name, pos, slotId, injury = '') => ({ id: nid++, name, pos, slotId, starter: ![20, 21].includes(slotId),
    eligibleSlots: E[pos], injury, locked: false, proTeamId: nid });
  const fa = (name, pos) => ({ id: 900 + nid++, name, pos, eligibleSlots: E[pos], injury: '', proTeamId: 99 });
  const lg = () => ({ scoringPeriodId: 1, slotCounts: { 0: 1, 2: 2, 4: 2, 6: 1, 23: 1, 16: 1, 17: 1, 20: 6, 21: 1 },
    roster: [pl('Jalen Hurts', 'QB', 0), pl('Bijan Robinson', 'RB', 2), pl('Zach Charbonnet', 'RB', 2, 'O'),
      pl('Amon-Ra St. Brown', 'WR', 4), pl('Tee Higgins', 'WR', 23), pl('Sam LaPorta', 'TE', 6),
      pl('Brandon Aubrey', 'K', 17), pl('Ravens D/ST', 'D/ST', 16),
      pl('Patrick Mahomes', 'QB', 20), pl('James Conner', 'RB', 20), pl('Jaylen Waddle', 'WR', 20), pl('Jakobi Meyers', 'WR', 20)] });
  // WR slot 2 is empty (only St. Brown at slot 4), so Waddle should start there.
  const waivers = (s) => s.moves.filter((m) => m.waiver);

  let s = suggestLineup(lg(), idx, 'nfl', { freeAgents: [fa('Jordan Love', 'QB')] });
  check('a third QB is not suggested behind an established starter', !waivers(s).length,
    waivers(s).map((m) => `${m.add} for ${m.drop}`).join(', '));
  check('...the IR move for the OUT starter is unchanged', s.moves.some((m) => m.il && m.action === 'to_il' && m.out === 'Zach Charbonnet'));
  check('...and the empty-slot start is unchanged', s.moves.some((m) => m.reason === 'empty_slot' && m.in === 'Jaylen Waddle')
    || s.plan.some((x) => x.name === 'Jaylen Waddle' && x.toLineupSlotId !== 20));

  // A free agent who genuinely improves the starting lineup is still suggested.
  s = suggestLineup(lg(), idx, 'nfl', { freeAgents: [fa('Jordan Love', 'QB'), fa('Waiver WR', 'WR')] });
  check('a free agent who would start is still suggested', waivers(s).some((m) => m.add === 'Waiver WR'));
  check('...with the gain measured on the lineup, not raw points', waivers(s).every((m) => m.gain > 0 && m.gain < 290 / 17));

  // A position-full backstop even when the add WOULD start: a QB better than both rostered QBs.
  const idxElite = buildValueIndex([...pool.filter((p) => p.name !== 'Jordan Love'), { name: 'Jordan Love', pos: 'QB', fpPpr: 480, fpStd: 360, rank: 0 }], 'nfl', 'ppr');
  s = suggestLineup(lg(), idxElite, 'nfl', { freeAgents: [fa('Jordan Love', 'QB')] });
  check('a third QB is refused at the QB cap even when he would start', !waivers(s).length);

  // A bench player who adds nothing this week (TE behind a starter) is not a reason to churn.
  s = suggestLineup(lg(), idx, 'nfl', { freeAgents: [fa('Waiver TE', 'TE')] });
  check('a bench-only add is not suggested', !waivers(s).length);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
