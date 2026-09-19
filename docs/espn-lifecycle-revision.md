# ESPN lifecycle revision and cross-release rollback

This ports the production protocol from compatibility commit
`9cd0dc18e0a2550b4dc8f523d96a0c0a412716fe` and adds its isolated Preview equivalent.
No production deployment, hosted configuration change, or credential migration is performed.

## Production mode

`espn:lifecycle:{userId}` is a permanent monotonic revision, defaulting to zero for legacy
accounts. Capture it after authentication and before Premium/provider validation. Browser
revisions are ignored. The exact compatibility Lua script atomically compares the snapshot,
advances the revision, commits a v1 encrypted envelope with its 90-day TTL, revokes automation,
clears stale watch associations, and records any current connect-time DNA choice.
Disconnect advances the revision and removes credentials, automation and DNA memberships in
one operation. Standalone permission/consent changes also CAS/increment the revision.
Stale operations return HTTP 409 `connection_changed`, without writes. New requests after
disconnect see the new revision and may reconnect. No lock is held across a provider request.

Credential reads atomically load the revision and envelope. The revision is returned internally
alongside the decrypted credentials, not embedded as a new v1 schema. Legacy plaintext reads,
current/previous-key decryption, user binding, encrypted-only saves and expiry are preserved.
Apply/cron recheck both generation and revision. Missing/malformed/wrong keys remain explicit
errors rather than disconnection or plaintext fallback. NBA/NHL writes remain disabled.

The Lua script checks types/JSON before mutations: Redis script errors do not roll back prior
commands. All participating runtime writers must use this protocol; an old unconditional SET
writer can bypass the revision. Do not run old releases against the shared namespace.

## Isolated Preview

- Encrypted v1 envelope: `preview:espn:creds:{userId}`; unchanged 90-day TTL.
- Permanent revision: `preview:espn:creds:{userId}:lifecycle`; no expiry.
- The writer remains private and validates user IDs. Its two-key CAS script uses only
  GET/SET/DEL inside EVAL, under `preview:espn:creds:user_*`.
- Reads use the separate read-only token and GET-only revision/envelope/revision checks.
- Configuration/project identity, forbidden-production-alias checks, HTTPS/database marker
  validation and sanitized errors remain mandatory. There is no production Redis fallback.
- No automation/DNA keys are accessible or created. Apply/dry-run/Autopilot/DNA requests remain
  blocked before authentication/provider/storage work; connect-time consent is ignored.

The documented old writer ACL lacks EVAL. Scoped EVAL permission needs a separately approved
hosted review before another Preview deployment/certification; code fails closed if denied.
No hosted ACL or token was changed. Never substitute an administrator token to make CAS work.

## Verification

Run all existing My Edge, ESPN, credentials, Preview safety, Autopilot, League DNA/configuration,
sport-readiness, Coach and browser suites. Also run:

- `npm run check:credential-lifecycle`: actual production Lua and handler with deterministic
  commit/provider barriers, competing reconnects, revocations, Apply/cron, key errors and TTL.
- `npm run check:preview-lifecycle`: actual Preview Lua under a restricted Redis ACL; repeats
  races, blocked mutation attempts, encrypted-only saves, key errors, namespace denial and
  denied-EVAL failure. The writer cannot SET production keys/marker or execute SADD.

Both require local `redis-server` (or `FE_TEST_REDIS_SERVER`). They start disposable Redis on a
private Unix socket, with TCP and persistence disabled, synthetic credentials and mocked
provider/auth responses. The existing unit-fixture adapter is not the evidence for Lua atomicity.

After committing, archive both exact fixed releases. Run compatibility → My Edge → compatibility
against shared synthetic local storage, checking both readers/writers, monotonic revisions,
stale generation/permission rejection and disconnect barriers in every stage. Preserve archive
hashes and results; never label local evidence as a hosted production rollback deployment.

## Remaining boundaries

An already-submitted ESPN transaction cannot be recalled. The final revision-check-to-provider-
submit interval remains, because Redis and ESPN cannot participate in one transaction. In-flight
read/collection work may finish, but cannot restore consent/automation membership via the protocol.
Unrelated watch/history updates are outside the lifecycle transaction. A lost HTTP response may
follow a successful atomic commit; an explicit retry starts a new operation. Keep the persistent
revision keys and never restore stale credentials/permission backups as a rollback mechanism.
