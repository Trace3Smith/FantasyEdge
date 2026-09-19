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
`check:credential-compatibility` is included in `check:credentials`.

`check:credential-browser` uses externally installed Playwright (or its module path via
`FE_PLAYWRIGHT_MODULE`). It loads the actual Team Manager HTML, mocks auth/API responses,
and blocks all external page requests, at desktop and mobile sizes.

All credential inputs are synthetic. The fixture `my-edge-37ccd8d-codec.mjs` freezes
that certified release's actual codec with its source hash; only the error dependency
is stubbed and the unused migration helper omitted. Both writer/reader directions are
checked without requiring a sibling checkout or git history during test execution.

## Remaining concurrency limits

This release preserves the certified branch's lifecycle semantics, not a distributed
transaction protocol. Credential deletion/saving, permission cleanup, watch cleanup,
and DNA cleanup are separate Redis operations. Storage failures can leave partial
cleanup; they are reported rather than claimed successful. An already in-flight save
can finish after a disconnect. Two reconnects are last-completion-wins. Preference
read/modify/write operations can lose concurrent updates; a stale enable can reinsert
a generation-bound permission, which the cron must refuse if its generation differs.

Apply/cron tests revoke or change the connection during planning and prove zero provider
submissions. They do not eliminate the final check-to-submit race or recall a request
already sent to ESPN. Serialized/atomic lifecycle and permission work is a separate
hardening change, which must remain compatible with My Edge before rollout.

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
