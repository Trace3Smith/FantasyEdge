#!/usr/bin/env node
// Offline checks for Autopilot's apply-outcome accounting.
//
// ESPN rejects a whole lineup transaction with a 409 when it contains a locked player — it does not
// silently no-op — and setLineup recovers by dropping the named players and retrying. The run
// therefore has three distinct outcomes per league (landed / locked-out / redundant), which the cron
// previously collapsed: it discarded setLineup's result and incremented `applied` unconditionally,
// so a fully blocked league was indistinguishable from a fully applied one.
//
// No ESPN session needed — tallyApply is pure.
//
// Usage:  npm run check:autopilot     Exit: 0 clean · 1 a check failed
import { tallyApply } from '../api/cron/autopilot.js';

let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`   ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`); };
const blank = () => ({ moves: 0, lockedSkipped: 0, alreadySet: 0, deferredLeagues: 0, noopLeagues: 0 });

console.log('offline — Autopilot apply-outcome accounting');
{
  // Everything landed.
  let s = tallyApply(blank(), { applied: 4, skippedLocked: [], alreadySet: 0 });
  check('a fully applied league counts its moves', s.moves === 4 && s.lockedSkipped === 0);
  check('...and is not marked deferred or no-op', s.deferredLeagues === 0 && s.noopLeagues === 0);

  // Everything blocked by locks — the case that used to look identical to success.
  s = tallyApply(blank(), { applied: 0, skippedLocked: ['A', 'B'], alreadySet: 0 });
  check('a fully locked-out league lands zero moves', s.moves === 0);
  check('...counts the locked players', s.lockedSkipped === 2);
  check('...and is flagged BOTH deferred and no-op', s.deferredLeagues === 1 && s.noopLeagues === 1);

  // Partial: some landed, some locked. NFL's normal case once players lock per-game.
  s = tallyApply(blank(), { applied: 3, skippedLocked: ['C'], alreadySet: 0 });
  check('a partial apply counts both sides', s.moves === 3 && s.lockedSkipped === 1);
  check('...is deferred but not a no-op', s.deferredLeagues === 1 && s.noopLeagues === 0);

  // Redundant moves are neither a success nor a lock.
  s = tallyApply(blank(), { applied: 0, skippedLocked: [], alreadySet: 2 });
  check('redundant moves are tallied separately', s.alreadySet === 2 && s.lockedSkipped === 0);
  check('...and count as a no-op, not a deferral', s.noopLeagues === 1 && s.deferredLeagues === 0);

  // Accumulation across leagues in one run.
  s = blank();
  tallyApply(s, { applied: 2, skippedLocked: ['X'], alreadySet: 1 });
  tallyApply(s, { applied: 5, skippedLocked: [], alreadySet: 0 });
  tallyApply(s, { applied: 0, skippedLocked: ['Y', 'Z'], alreadySet: 0 });
  check('totals accumulate across leagues', s.moves === 7 && s.lockedSkipped === 3 && s.alreadySet === 1);
  check('per-league flags accumulate', s.deferredLeagues === 2 && s.noopLeagues === 1);

  // setLineup's early return omits alreadySet entirely; malformed input must not produce NaN.
  s = tallyApply(blank(), { applied: 0, skippedLocked: [] });
  check('a result without alreadySet does not produce NaN', s.alreadySet === 0);
  s = tallyApply(blank(), undefined);
  check('an undefined result is handled', s.moves === 0 && s.lockedSkipped === 0 && s.noopLeagues === 1);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
