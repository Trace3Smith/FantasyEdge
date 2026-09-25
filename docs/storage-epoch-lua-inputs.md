# Immutable Redis Lua inputs

## Root cause and fix

Hosted certification of 9e7d745 failed after activation: ACTIVE_GUARD removed the first
entry from Redis's supplied KEYS table. Hosted Upstash protects this table; local Redis
7.0.15 did not. The guard now checks control at the unchanged physical KEYS[1], copies
positions 2..N into a fresh runtimeKeys table in order, and creates a local KEYS binding
for the existing command/lifecycle body. This shadows the name; it does not modify the
Redis global or its table. ARGV remains unchanged. All namespace checks, control checks,
11-key lifecycle ordering and CAS arguments remain intact.

Script registration additionally rejects ARGV writes and direct KEYS/ARGV rebinding.
Existing restrictions on literal/dynamic keys, rawset, table functions and unregistered
runtime scripts remain in place. Registration is still a reviewed-script allowlist,
not a sandbox for arbitrary Lua.

## Repository-wide mutation audit

Searched tracked and nonignored repository files for KEYS/ARGV indexed assignments,
rebinding, table.remove/insert/sort/move/setn, rawset, _G access and aliases.
Reviewed every Lua body in storageEpoch.js, espnLifecycle.js and epoch-bootstrap.mjs.

Original occurrences:

- api/_lib/storageEpoch.js: ACTIVE_GUARD's table.remove(KEYS, 1) was the only runtime
  mutation. Replaced by the ordered local copy described above.
- scripts/check-storage-epoch.mjs: an intentional KEYS[1] = 'legacy' rejection fixture;
  retained because registerEpochScript must reject it before Redis execution.
- api/_lib/coachContext.js and api/synopsis/index.js: JavaScript const KEYS maps, not Lua
  globals. They need no change.
- No ARGV mutation, other Lua global rebinding, or alias-based runtime mutation found.
  Lifecycle and operator bootstrap bodies only read the supplied tables.

New deliberate negative fixtures in check-lua-inputs.mjs exercise writes/removal/appending,
insert/sort/rawset, direct aliases and iterator-state aliases for both input tables.
They run against disposable local Redis only and must fail. The guard's new local KEYS
binding refers exclusively to a newly allocated table; it is not a global assignment.
The test shim's function parameters are local proxies, also not global assignments.

## Deterministic regression

local-redis.mjs protects both supplied inputs for every EVAL, including SDK REST calls.
Empty proxy tables plus __newindex reject overwrites and appended/deleted indices.
Test-local wrappers preserve read operations and reject mutating C helpers/rawset on a
protected proxy. Iterators do not expose the mutable backing table as their state.

Lua 5.1 ignores a table __len metamethod, so the shim translates #KEYS/#ARGV expressions
to its length helper. This covers every current input-length use in application/operator
Lua. The shim approximates hosted immutability; it does not replace hosted certification
or claim full language equivalence for arbitrary future Lua code. No production module
imports this test shim. Actual hosted runs use the unmodified application Lua.

check:storage-epoch now first proves 20 mutation attempts fail and ordinary reads and
local-copy transformations still work. The full epoch/bootstrap and lifecycle suites
then run through the protected-input helper; the installed SDK transport does too.
check:redis-boundary also rejects direct mutations in all three shipped Lua source files.

## Local verification before commit

Passed: storage epoch (direct and installed SDK), credentials/compatibility, lifecycle,
ESPN handler/foundation, Redis boundary, League DNA, Autopilot, sport-readiness, Coach
(88 checks), draft opponents (8 checks), and targeted NHL slots/caps/category-balance
fixtures. NHL epoch cache-version behavior is covered by the storage-epoch suite.
No application scoring, provider permissions, or lifecycle transitions were changed.

Hosted certification must use a fresh archive of the resulting commit, the existing
disposable fantasyedge-epoch-cert database and owner-provided private environment.
Record hosted results separately without changing the certified source revision.
No push/deployment, production/real Preview storage or database recreation is authorized.
