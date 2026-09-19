# ESPN credential compatibility baseline

Based on production/main `9f06d0f`, with selected credential/lifecycle changes from
`6306489`, `85846d3`, `625cfea` and the status-error UI fix from `c9b8885`.
Key-format coverage is also taken from `c986ef4`. This is not the My Edge release.

## Storage and behavior

- Read legacy `{espn_s2, swid, savedAt?}` records without a key; never migrate on read.
- Read user-bound AES-256-GCM v1 envelopes with current/optional previous key.
- Every new save uses encryption, a fresh connection generation, and 90-day Redis TTL
  plus authenticated absolute expiry. Missing/malformed current keys fail before
  credentials, permissions, or watch associations are modified. No plaintext fallback.
- Wrong/missing decryption keys raise a configuration error without deleting a record.
  Team Manager shows status unavailable rather than a disconnected/connect form.
- Reconnect revokes automation. Disconnect removes credentials, automation membership,
  and DNA consent/sweep membership. Revocation remains available to signed-in free users
  and does not require decrypting the credential. Shared historical DNA is retained.
- Preserve sport-qualified permissions and legacy permission reads, ownership validation,
  Premium checks and generation checks before provider writes. NBA/NHL writes and
  Autopilot remain disabled. Existing MLB/WNBA/NFL allowlists and decision logic remain.
- Preserve prospect history but clear stale team associations on disconnect/reconnect.

No My Edge UI/aggregation, MLB-position/ROTO corrections, Preview infrastructure,
credential migration runner, homepage changes, billing changes or cron schedule changes.
Existing production DNA behavior remains consent-gated. This baseline has production
mutation capabilities; it is NOT a read-only Preview application.

## Offline verification

Run `check:espn`, `check:espn-handler`, `check:credentials`, `check:autopilot`,
`check:league-config`, `check:league-dna`, `check:sport-readiness`, and `verify:coach`.
`check:credential-compatibility` is included in `check:credentials`. Also run the real-Redis
`check:credential-lifecycle` suite.

`check:credential-browser` uses externally installed Playwright (or its module path via
`FE_PLAYWRIGHT_MODULE`). It loads the actual Team Manager HTML, mocks auth/API responses,
and blocks all external page requests, at desktop and mobile sizes.

All credential inputs are synthetic. The fixture `my-edge-37ccd8d-codec.mjs` freezes
that certified release's actual codec with its source hash; only the error dependency
is stubbed and the unused migration helper omitted. Both writer/reader directions are
checked without requiring a sibling checkout or git history during test execution.

## Atomic lifecycle protocol

`espn:lifecycle:{userId}` is a monotonic, persistent revision, initially zero for legacy
accounts. Never expire or reset it: it is the disconnect tombstone for old requests.
The server captures it immediately after authentication and before Premium/provider
validation, ignoring any browser-supplied revision. Credential reads atomically load
the envelope and revision; the revision is not a change to the encrypted v1 format.

A Redis Lua script compares the captured revision immediately before a connect commit.
A matching commit increments the revision, writes only the encrypted envelope with its
90-day TTL, removes automation permissions/membership, clears stale watch associations,
and records any valid connect-time DNA choice/membership in the same atomic operation.
Disconnect increments the revision and removes credentials, automation and DNA
consent/memberships atomically. A stale operation returns HTTP 409 `connection_changed`
without any state change. A new operation starting after disconnect sees the new revision.

Standalone permission and consent updates also CAS/increment this revision, so a delayed
enable cannot undo a successful disable/opt-out. Apply and cron retain connection-generation
checks and additionally reject changed lifecycle revisions. Cron cleanup uses its observed
revision rather than deleting a newer connection's permissions. No network request is held
inside a lock or Redis transaction. Script types/JSON are checked before mutations because
Lua runtime errors do not roll back earlier commands.

`check:credential-lifecycle` runs the actual script against disposable local Redis via a
private Unix socket, with TCP and persistence disabled. Provide `redis-server` on PATH or
`FE_TEST_REDIS_SERVER`; no external Redis endpoint is accepted by this harness. Existing
in-memory unit fixtures use a separate adapter, not the evidence for Lua atomicity.

The deterministic lifecycle suite pauses before commits and during provider validation,
checks two competing reconnects, repeats disconnect/new-connect/stale-connect sequences,
and checks revoked permission/consent, Apply/cron, key failures and storage-type failures.

Remaining boundaries: an ESPN write already submitted cannot be recalled, and the final
revision-check-to-provider-submit window still exists. Provider/collection work started
before revocation can finish; it cannot recreate consent or automation membership through
the new protocol. Unrelated watch/history writers are not serialized by this change.
A response may be lost after an atomic commit; retry starts a new lifecycle operation.

ALL writers sharing this credential namespace must adopt the protocol. Certified My Edge
`37ccd8d` does not: its unconditional SET can still bypass this tombstone. Codec/record
interoperability does not certify mixed old/new writers as lifecycle-safe. Port the five
runtime-file changes (lifecycle helper, credential helpers, DNA helpers, ESPN dispatcher,
Autopilot cron) and the race tests to My Edge before any production rollout. Its separate
Preview credential writer needs an equivalent protocol in its isolated namespace; do not
silently route it through production Redis or widen its ACLs as part of this baseline.

## Isolated rehearsal and production prerequisites

Local tests establish format compatibility, not a certified production rollback artifact.
Next, rehearse with synthetic users/records, isolated storage and stubbed ESPN/Clerk.
Do not deploy this baseline over the existing My Edge certification environment:
it intentionally lacks that branch's Preview isolation and mutation guards. Do not
reuse production-project Preview variables or live connected accounts for rehearsal.
Any hosting/storage configuration needs separate authorization.

Before production encrypted writes, provision `ESPN_CREDENTIAL_ENCRYPTION_KEY` in the
approved secret store and establish controlled recovery custody. It must decode to
32 random bytes and re-encode identically as canonical padded base64 (44 characters,
one trailing `=` after application whitespace trimming). A trusted process must run
that validation and a synthetic in-memory round trip, outputting only PASS/FAIL.
Do not print the key, ciphertext, cookies, environment dumps or secret-bearing exceptions.
Keep the previous-key variable absent initially; a malformed configured previous key
also prevents encrypted reads. Keys must be independent of nonproduction credentials.

Keep recovery material in an approved secret manager, record only its reference and
custodians, and test recovery privately. All deployments sharing the namespace must
have compatible keys. Environment changes do not retrofit an old deployment snapshot.

Separately authorize the compatibility production release, verify its exact deployment
and environment, and preserve it as the rollback predecessor before My Edge ships.
Confirm artifact retention and rollback eligibility; source code alone is insufficient.
Old main `9f06d0f`/`4a4dce7` is unsafe after the first encrypted save. Never restore stale
plaintext backups or remove keys to force fallback. Rollback preserves current records
and revocations. Full deployment/rollback rehearsal and production key custody remain
outstanding; no production action is performed by these tests.

Migration is a later, explicitly approved operation after stable compatible deployment.
Legacy reads remain available in the meantime; no automatic migration/cutoff is added.
