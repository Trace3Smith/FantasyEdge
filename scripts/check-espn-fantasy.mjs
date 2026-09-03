#!/usr/bin/env node
// Offline checks for the ESPN Fantasy integration layer: the NFL slot/position maps and the 409
// rejection parser. No ESPN session needed — both are pure.
//
// The NFL maps were reconstructed from ESPN's public kona_player_info feed by cross-referencing
// eligibleSlots against defaultPositionId, so these assertions pin what that data showed.
//
// Usage:  npm run check:espn      Exit: 0 clean · 1 a check failed
import { slotLabel, isActiveSlot, parse409Names } from '../api/_lib/espnFantasy.js';

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

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
