# Storage epoch / main reconciliation — 2026-09-24

Local reconciliation only. No push, hosted certification, deployment, PR edit, external
configuration change, credential access, migration, activation or real provider mutation.

## Inspected state

Read primary PROJECT_HANDOFF.md and AI_SESSION_HANDOFF.md plus the latest epoch review,
certification packet and local PR105 description. The primary handoff pause checkpoint is
historical; the owner's resume instruction authorizes this local reconciliation.

After fetching origin:

- main and origin/main: `021450c`, PR106 NHL Draft Coach merged.
- Local compatibility: `58362d1`, preserving epoch commits `75f1b41` and `58362d1`.
- Remote compatibility / PR105: `9cd0dc1`, open Draft, base main.
- Local and remote My Edge / PR104: `43d6301`, open Draft, base main.
- Before reconciliation compatibility versus main: 4 ahead / 3 behind;
  My Edge versus main: 25 ahead / 3 behind.
- PR104/105 descriptions still describe the shared-namespace compatibility rehearsal;
  neither remote PR contains the local e1 implementation. Their main SHA references are stale.

## Local result

Merged origin/main into espn-credential-compatibility without rewriting history. All eight
NHL files merged cleanly; kv.js retains the epoch wrapper and disabled SDK automatic
JSON deserialization alongside NHL_DATASET_VERSION=12. The preexisting epoch implementation
and security modules are preserved. NHL scoring and draft changes match main.

Fixed one inherited NHL integration mismatch: refresh cron used shared version 11 while
NHL readers require 12. It now writes the hockey-specific version for NHL and retains the
shared version for other sports. This prevents a redundant hockey rebuild after refresh.
No live cron was invoked.

Added an actual loadPlayers/Redis regression: ignore a valid-looking legacy NHL dataset,
rebuild/cache in e1, invalidate an older e1 NHL version, leave the legacy key untouched,
and keep the current NFL cache. Runs through direct Redis and installed SDK transports.

## Validation

All commands passed on the reconciled tree:

- check:redis-boundary (27 runtime consumers)
- check:espn, check:espn-handler, check:autopilot
- check:league-config, check:league-dna, check:credentials, check:sport-readiness
- verify:coach (88 checks), test:draft
- check:model (including prospective CFB snapshot assertions)
- check:storage-epoch, check:credential-lifecycle
- FE_TEST_UPSTASH_SDK=1 check:storage-epoch (218 requests / 220 commands)
- check:credential-browser (1440px and 390px, intercepted synthetic traffic)
- refresh cron syntax and staged/unstaged whitespace checks

Redis 7.0.15 and required libraries were downloaded/extracted only under /tmp; no system
service installed. Test Redis uses private Unix sockets, no TCP or persistence. Existing
Playwright 1.61.1 was used. Sandbox socket/browser restrictions required escalated local
execution. The model suite's public nflverse fetch passed after network escalation.
An initial new raw-value assertion was corrected to explicitly JSON-decode, matching the
SDK configuration; both transports then passed. Existing missing-config/module-mock warnings
remain harmless in offline fixtures. Logs: /tmp/fe-reconcile-*.log (ephemeral).

## Next gates

PR104 is unchanged and still needs the same e1 boundary/codec/lifecycle port before an
actual My Edge rollback rehearsal. A synthetic future-contract test does not certify PR104.
Neither PR was edited, pushed or merged remotely. Primary handoffs remain untracked.

Hosted certification still requires an approved synthetic-only storage capability path
and reviewed hosted adapter described in storage-epoch-certification.md. Existing restricted
Preview credentials do not establish that capability. Do not substitute an admin token,
change ACLs, deploy, or run bootstrap against hosted storage. Any later exact-source packet
must be regenerated from the new reviewed commit; earlier SHA evidence does not certify it.
