# ESPN credential storage and connection lifecycle

Implemented on `my-edge-foundation`; not deployed or migrated in this session.

Detailed operator procedure: [production rollout runbook](espn-encryption-rollout.md).
It includes the exact key encoding, compatible rollback release blocker, canary limits and verification.

## Storage contract and rollout prerequisite

`api/_lib/espnCredentials.js` uses Node AES-256-GCM, a fresh 96-bit nonce per encryption,
a 128-bit authentication tag, and authenticated associated data containing the Clerk user ID and
schema version. Redis `espn:creds:{userId}` holds only `{version,iv,tag,data}` for new connections.
The encrypted payload contains both cookies, save time, connection generation and expiry.
No cookies, keys, ciphertext or full member IDs should be printed in logs, diagnostics or handoffs.
Existing status output remains a masked identifier plus save time. Provider read errors return HTTP
status only, not the fan URL (which contains SWID) or response body. Lineup recovery parses responses
internally but logs only status/counts, reports matched roster names and does not return a raw lockedBody.
Unknown write failures remain fail-closed, with no provider body in exceptions.

Required new server-only environment variable: `ESPN_CREDENTIAL_ENCRYPTION_KEY`.
Optional rotation variable: `ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY`.
Each is a canonical base64 encoding of an independently generated 32-byte cryptographic random key.
Provision in the hosting secret store, separately for development/production; never source-control it,
expose through `/api/public-config`, or reuse Clerk, Stripe or Redis credentials as an encryption key.
Production key provisioning and backup custody are **Unknown from repository**.

**Configure the current key before deploying this change.** Missing/malformed encryption configuration
rejects new saves with 503 before revoking existing permissions. Manual cookie connection is retained,
validated with ESPN and tested through the actual handler using offline provider responses. It now
requires encryption configuration. Existing legacy connections still read without the new key.

New saves receive a Redis TTL and authenticated absolute expiry of 90 days. This is an application
retention limit, NOT a claim about ESPN cookie lifetime. ESPN may expire/revoke cookies earlier; normal
provider auth failures still request reconnect. A local expired record reads as disconnected. Redis
expires its bytes; cron removes permissions for a missing connection. Missing/wrong encryption keys
fail closed, do not silently overwrite/delete encrypted credentials and do not masquerade as ESPN expiry.

## Migration without breaking existing users

Plaintext legacy `{espn_s2,swid,savedAt?}` records remain readable temporarily. This compatibility window
is an acknowledged residual security risk; changing code alone does not encrypt existing stored data.
Reads perform no persistence: concurrent disconnect cannot be undone by a lazy migration.

`scripts/migrate-espn-credentials.mjs` scans ONLY `espn:creds:*`. Default invocation is inventory-only;
`--apply` enables encryption; `--apply --limit N` bounds legacy migration attempts.
`--verify` is read-only envelope decryption verification, with aggregate unreadable/expired counts.
Apply and verify preflight key configuration before storage access; unknown options fail closed. It prints aggregate counts only, never IDs or secrets. This tool was NOT
run on production or any live Redis during this task. Running it is an explicit operator step after
key provisioning and deployment approval. It makes no ESPN calls or subscription/lineup changes.

Migration encrypts a record only if its Redis bytes still match the snapshot read (Lua compare-and-set).
Concurrent reconnect/disconnect wins; changed records are skipped and counted. Migrated records retain
the original savedAt and connection generation (legacy remains legacy), preserving valid permissions,
and receive a 90-day retention window from migration. Inventory may count duplicates during SCAN;
run a final inventory after completion and resolve skipped/invalid records deliberately. Compare-and-set
may conservatively skip differently serialized legacy JSON; never bypass the comparison with a blind SET.

Rollout: provision key → deploy compatible reader/encrypted writer → inventory → explicitly authorized
migration → confirm no legacy records remain → separately retire plaintext compatibility. No automatic
compatibility cutoff is introduced. Do not roll back to code that cannot read encrypted envelopes.

Rotation: put the old current key in the previous-key variable and provision a new current key. New saves
use the current key; reads try current then previous. Keep the previous key until every envelope using it
has expired or been replaced by a reconnect (at least the full retention window from the last old-key
write). Do not rotate again while still needing two older keys. This migration tool migrates plaintext,
not previously encrypted envelopes. A future re-encryption tool must use the same concurrency safeguards.
Encryption protects a Redis-only disclosure; compromise of both app execution and its key still exposes
credentials. Hosted key access policy, backups and disaster recovery require an operator review.

## Independent state and disconnect/relink

- ESPN connection: credentials plus a fresh opaque connectionId on each successful save.
- Premium: Clerk publicMetadata.plan, the existing entitlement source; no pricing or Stripe changes.
- Autopilot: explicit per-team permission, bound to connectionId and sport-qualified identity.
- League DNA: current notice v2 consent, independent of the above; golf remains excluded.

Disconnect deletes credentials then removes automation permissions and cron membership. Relink (even the
same account) revokes automation before saving new credentials: user must enable again. Free signed-in
users can disconnect, disable automation and opt out of DNA; all normal paid Team Manager actions retain
the existing Premium gate. DNA disconnect behavior remains reset-consent-and-remove-sweep-membership;
shared historical configs are retained, never blindly deleted. Cancellation does not delete credentials
or consent. Clerk failure skips automation without erasing permissions.

Manual league references are retained (legacy entries are MLB), and each visible manual league is
revalidated against the newly connected ESPN owner. Prospect names, watch wishes and history survive;
old team links become previousLeague and the active association is cleared. Current roster reconciliation
can associate an actually rostered prospect again. A previously dropped watched prospect may need the user
to associate it with a team again; there is not yet a restoration UI. Watch remains MLB-only and cannot
accept another sport's player IDs. Its map still holds only one league association per MLB player: a
multi-league watch model is future work, not silently claimed fixed.

## Execution boundary and remaining concurrency limits

Cron rechecks Clerk entitlement before data work and immediately before a provider write. Confirmed
non-Premium revokes permissions; Clerk uncertainty fails closed. Provider roster responses must list
primaryOwner/owners matching the authenticated SWID; commissioner visibility alone grants no permission.
Apply recomputes plans server-side and verifies the connection generation before submission. Cron also
rechecks the saved permission. An already submitted provider request cannot be recalled by disconnect;
there remains a small check-to-submit race. Credential, permission and consent transitions now use a persistent lifecycle revision and atomic Redis CAS;
concurrent stale transitions return 409 rather than overwriting a newer operation. All writers sharing a
namespace must implement this protocol. See [lifecycle revision](espn-lifecycle-revision.md). No live Autopilot checks or user lineup writes were performed.
