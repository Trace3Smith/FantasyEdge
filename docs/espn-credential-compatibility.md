# Secure ESPN compatibility foundation — DO NOT MERGE OR DEPLOY

Draft PR #105 is the prerequisite for My Edge, not the My Edge product release.
The fixed storage epoch replaces the previous shared-key compatibility plan.
Production activation, bootstrap, WAF publication and any hosted deployment require
separate authorization. Do not rotate Redis or encryption credentials for this work.

## Runtime boundary and schema

`api/_lib/storageEpoch.js` is the only runtime Redis boundary. `kv.js` exports its
wrapped client; every logical key receives the fixed `fe:e1:` prefix. The raw client
is not exported. Every runtime command checks the epoch control atomically in Lua.
Missing/malformed/preparing/sealed control fails closed. Unknown Lua and SDK escape
hatches (pipelines, multi, evalsha, sendCommand, scans) are not exposed. No consumer
currently requires them; adding one requires an explicit wrapped implementation/test.

Physical keys include:

| Logical key (all prefixed `fe:e1:`) | Meaning |
|---|---|
| `control` | Persistent schema1/e1/runId/phase/manifestClosed/quotaNotBefore |
| `espn:creds:<user>` | Active user-bound AES-256-GCM v1 envelope |
| `espn:lifecycle:<user>` | Persistent CAS revision/revocation tombstone |
| `espn:generation:<user>` | Must match authenticated payload connectionId |
| `espn:ready:<user>` | Set only by completed active connect/confirmation |
| `espn:autopilot:<user>`, `espn:autopilot:users` | Fresh generation-bound opt-ins |
| `espn:dna:ack:<user>`, `espn:dna:users` | Fresh generation-bound consent/membership |
| `espn:prospectwatch:<user>`, `espn:manualleagues:<user>` | Generation-bound associations |
| `bootstrap:creds:<user>` | Encrypted pending candidate, never active credentials |
| `bootstrap:user:<user>`, `bootstrap:manifest`, `bootstrap:completed` | Import progress |

The v1 envelope format and user AAD are preserved. Active payloads additionally require
`storageEpoch: e1` and nonempty `connectionId`. Plaintext in an active credential key
is an error, not fallback. All active reads atomically load envelope/revision/generation/
readiness; malformed revision fails closed. Normal connect/confirmation has90-day TTL
and authenticated expiry. Wrong/missing keys never trigger plaintext writes or deletion.

Lifecycle Lua retains compare/advance and disconnect tombstones. Connect/disconnect
clear automation, consent, pending candidates, manual associations and watch state.
Permission, consent, manual and watch changes participate in CAS. Association callers
carry the snapshot from before provider work, so reconnect cannot inherit old results.
NBA/NHL write gates, ownership and Premium checks are preserved. Signed-in free users
can still revoke without decrypting credentials.

## Bootstrap policy and operator tool

`node scripts/bootstrap-storage-epoch.mjs <operation> <runId>` is an operator-only tool,
not an HTTP endpoint or a normal build step. Operations: `prepare`, `import`, `seal`,
`verify`, `activate`. It requires Production context and an explicit authorization flag;
this flag is not a new authentication boundary. Use only an approved secure execution
mechanism with existing in-memory secrets. Never env-pull, print credentials, place
secrets in shell arguments or retrieve the encryption key into operator reports.
Do not execute these commands against Production as part of implementation/certification.

- `prepare`: refuse an occupied epoch without matching preparing control; initialize
  unique run; filtered SCAN of legacy `espn:creds:*`; deduplicate fixed manifest; close it.
  SCAN traverses the keyspace internally but no unrelated values are retrieved.
- `import`: every source read rechecks preparing/run/manifest inside Lua. Strictly
  validate plaintext or authenticate/decrypt v1 in memory. Import encrypted pending
  candidates only; malformed, absent and expired records receive safe dispositions.
  Each user's candidate/revision/generation/completion is committed atomically. Same-run
  completed import is a no-op, even if legacy data changes later. Interrupted runs resume.
- Candidate lifetime is24 hours from capture. A reliable shorter Redis TTL or encrypted
  expiry wins. This is new pending retention, not an inferred historical expiry. No
  credential becomes active merely by existing in the source. No old permission,
  consent, membership, manual league or watch association is copied.
- `seal`: atomically require completed manifest and preparing -> sealed. All subsequent
  legacy reads/import commits reject, including an importer paused before its commit.
- `verify`: sealed-only in-memory envelope/user/expiry verification and sanitized counts.
- `activate`: verify, then atomically sealed -> active. No transition back to legacy.
  Absent users remain disconnected, but may perform a normal authenticated fresh connect.

The only legacy decoder is used by bootstrap/codec tests, never active credential reads.
The CLI emits counts or one fixed failure category. Its Redis credential is broad;
operator authorization and private execution are essential. Hosted execution mechanism
and per-command capability certification remain prerequisites before Production use.

## Confirmation and fresh authorization

Team Manager shows a minimal confirmation prompt for a pending candidate. It never
returns cookies or submits confirmation automatically. Authenticated Premium confirmation
requires an explicit action, successful fresh all-sport discovery AND an owned-league
read. Empty discovery, provider failure, wrong account/key, expiry, disconnect/reconnect
or stale revision prevent activation. If validation cannot succeed, reconnect normally.
The final Lua operation compares the exact pending record and checks Redis TIME, then
creates the normal active lifecycle with the candidate's new generation. It consumes
the candidate; successful confirmation does not enable Autopilot or DNA.

Autopilot starts OFF. DNA consent is missing/denied and the current notice must be
accepted explicitly. Watch/manual associations rebuild through fresh authorized actions.
This small confirmation UI is not My Edge navigation or aggregation UI.

## Redis consumer audit

All27 runtime Redis-consuming modules use the same wrapped client or receive it from
an audited caller. `check:redis-boundary` rejects new raw clients, unregistered runtime
Lua, dynamic command escapes and runtime bootstrap imports. Coverage includes:

- ESPN credential/lifecycle/generation/permission/consent/watch/manual state;
- Autopilot and DNA sweep membership/cursors;
- refresh cron, all sport datasets/rankings, DvP/Pick'em/brackets;
- ESPN scoring and league configuration, provider/team/boxscore/weather caches;
- prospect enrichment/crosswalk state, projections/ADP;
- synopsis, Draft/Coach context and mock-draft quotas.

All rebuild in e1; no read-through on cache miss. Provider failures may leave cold
features unavailable until refresh succeeds. Shared historical DNA/configuration stays
in legacy storage, but is not read as current authority. No legacy data is deleted.

Premium entitlement remains in Clerk. Free mock-draft allowance is conservatively
unavailable until the next UTC day after activation. This prevents granting a second
allowance while avoiding mutable legacy-counter reads. No billing change or silent quota
reset. Hosted performance matters: the epoch wrapper uses guarded EVAL for each command,
so evaluate command budget/latency on Free before cutover. No new dependency is required.

## Cutover and rollback contract

Freeze releases/builds; certify exact source; account for cron; activate all-host WAF
maintenance only with authorization. Drain active invocations using the audited bound
and investigate already-sent ESPN transactions. Legacy Redis settlement is no longer
an activation gate: old audited code targets legacy keys and all import paths close.

Deploy revised105 under maintenance; bootstrap/seal/verify/activate; rebuild and verify
decision datasets; establish permanent old-host/selector fencing; reopen canonical new
routes. Runtime e1 isolation is not an ACL against a compromised broad Redis credential.
Rotation is optional defense in depth, not required for audited old-code correctness.

After activation, pre-epoch deployments are permanently retired as normal rollback
choices even if their Redis credential still works. Record actual verified105 as My
Edge's immediate predecessor.104 must adopt the identical epoch/activation/codec/CAS
contract. No reverse migration or epoch switch during rollback. Retention and cron-host
fence must be rechecked. The current104 code is NOT certified by a future-contract fixture.

## Verification

Run `check:redis-boundary`, `check:storage-epoch`, `check:credential-lifecycle`,
`check:credentials`, `check:espn-handler`, `check:espn`, `check:autopilot`,
`check:league-dna`, `check:league-config`, `check:sport-readiness`, `verify:coach`,
plus `check:credential-browser` at desktop/mobile sizes.

The epoch and lifecycle suites use actual Lua against disposable Redis on a private
Unix socket (TCP/persistence disabled). Provide redis-server on PATH or
FE_TEST_REDIS_SERVER. The browser test requires Playwright or FE_PLAYWRIGHT_MODULE;
all page requests/auth/providers are synthetic and external requests are blocked.

The exact-source epoch rehearsal covers legacy capture -> encrypted pending import ->
seal -> activate -> late legacy writes -> unchanged trusted state; provider/auth confirmation;
shorter/24h expiry; missing/malformed phases; interrupted/duplicate import and sealing
interleavings; expiry/disconnect during validation; no legacy cache/permission/consent/
watch/manual fallback; and compatibility ->future My Edge CONTRACT fixture ->compatibility
rollback. The separate frozen prior My Edge codec fixture verifies v1 interoperability.

Hosted isolated certification remains outstanding: new SCAN/PTTL/TIME/PXAT/set-membership
and guarded-EVAL paths, SDK serialization, Free command budget/latency, cold dataset
refresh, sealed-control behavior, deployment snapshot and protected test execution.
Do not mark105 Ready or merge based solely on local tests.

## Review follow-up

See [security/SDK/cost review](storage-epoch-review.md) and
[isolated certification packet](storage-epoch-certification.md). NX/PX cache operations and
single-pass SDK decoding are covered; all14 local suites pass. Hosted execution remains blocked
on an approved synthetic-only capability path. Do not push, deploy, merge or change ACLs.
