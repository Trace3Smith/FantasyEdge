# Isolated My Edge preview setup

Supersedes the shared-storage option in my-edge-preview-certification.md. No external services have
been created or changed. Do not deploy until the owner confirms this checklist is ready.

## Upstash

Create an empty database dedicated to FantasyEdge Preview. Do not restore/copy production records.
Create the separate Vercel project first to obtain its project ID, then use the Upstash console to set
`fe:preview:project` to that project ID as a string. This is a manual bootstrap marker; the app never
creates or changes it. Never set this marker in production.

Obtain the HTTPS REST URL and database read-only token. Create a separate Redis ACL user with only
GET/SET/DEL access to `preview:espn:creds:*` (no other keys/commands), then obtain its REST token. This is
FE_PREVIEW_ESPN_CREDENTIAL_TOKEN. Do not use the default full-access token. Provision the ACL through
Upstash's ACL console/secure tooling; keep its password and token out of logs/chat. The application
never receives the administrative token. See https://upstash.com/docs/redis/features/restapi for ACL
REST tokens. Configure ACL user from a clean denied-by-default rule set, not an inherited admin role.

## Clerk

Create a separate FantasyEdge Preview application, Development instance. Enable the owner's preferred
sign-in method; create a test user there. For Premium testing, the owner can set only that test user's
publicMetadata.plan to premium. No Stripe checkout or production subscription change is involved.
Get the matching development publishable/secret keys; optionally get its JWT verification public key.
Do not use the production instance, keys or user IDs. Configure redirects for the chosen preview origin.

## Separate Vercel project: fantasyedge-preview

Keep Git auto-deployment disconnected initially. Copy no environment integrations from production.
All variables below belong in **Preview only**. The project may host Preview-target deployments even
though its name contains preview; the application still requires VERCEL_ENV=preview.

| Name | Value source | Sensitive | Fresh for isolated preview? |
| --- | --- | --- | --- |
| FE_PREVIEW_ISOLATED | Literal true | No | Yes, configuration flag |
| FE_PREVIEW_PROJECT_ID | New project's ID from Vercel Settings | No | Assigned by Vercel |
| FE_PREVIEW_REDIS_REST_URL | New database HTTPS REST URL | No | Assigned by Upstash |
| FE_PREVIEW_REDIS_READ_ONLY_TOKEN | New database read-only REST token | Yes | Yes, new database token |
| FE_PREVIEW_ESPN_CREDENTIAL_TOKEN | New restricted ACL user's REST token described above | Yes | Yes |
| ESPN_CREDENTIAL_ENCRYPTION_KEY |32 cryptographically random bytes, canonical standard base64,44 characters ending in one = | Yes | Yes; recommended |
| CLERK_PUBLISHABLE_KEY | New Clerk Development instance | No | Yes, issued by Clerk |
| CLERK_SECRET_KEY | Same Development instance | Yes | Yes, issued by Clerk |
| CLERK_JWT_KEY | Optional public verification PEM from same instance; omit if using secret-key verification | No | Issued by Clerk, not independently generated |
| APP_URL | Exact HTTPS preview origin, no wildcard | No | Set after choosing the hostname |

VERCEL_ENV and VERCEL_PROJECT_ID come from Vercel system environment variables; enable system environment
variable exposure if necessary. Do not manually spoof them. The latter must equal FE_PREVIEW_PROJECT_ID,
and must not equal the known FantasyEdge production project ID. Confirm the final preview origin before
signed-in certification; stable preview alias or a subsequent preview rebuild may be needed for APP_URL.

Do not set any KV_*/REDIS_URL/UPSTASH_REDIS_REST_* production-style aliases in this project. The explicit
aliases checked by previewIsolation.js cause fail-closed rejection if present, even with otherwise valid
preview configuration. Do not set a previous encryption key, Stripe/cron secrets or ESPN cookies as env vars.

## Implemented narrow capability

Preview ESPN connect validates the user's cookies with the existing ESPN fan read before encrypting them.
The private writer exposes only save/disconnect for the authenticated Clerk user, with90-day TTL and a
fresh connection generation. It writes only preview:espn:creds:user_*. Readback uses the read-only client,
checks the bootstrap marker and rejects plaintext records. Disconnect deletes only that credential key;
no automation, watch or DNA state exists to revoke through this restricted path. Premium is still needed
to connect; authenticated free users can disconnect. Credentials remain user-bound by AES-GCM AAD.

Every credential operation requires complete isolation configuration, exact project match, valid key and
matching Redis bootstrap marker before writing. Other preview data reads use only the explicit preview URL
and read-only token. No fallback to production aliases. Production connect/disconnect/read behavior is
unchanged. Preview migration helper refuses execution. General preview guards still reject lineup apply,
Autopilot, trades, billing, DNA choice/capture, cron and generic mutating APIs. No generic writer exported.

The project and marker guards detect missing/mismatched setup; they cannot discover resource ownership
from an arbitrary URL. Isolation also requires the operator to create the NEW database and scoped ACL.
Do not configure a production database with a preview marker or mint production ACL credentials for this
purpose. These provisioning invariants are verified before deployment, not assumed from a hostname.

## Test evidence / limits

check:preview-safety includes offline actual-handler tests for encrypted save/read/disconnect, TTL,
Premium/free-revoke behavior, no DNA writes even with requested consent, migration rejection, missing keys,
production-project rejection, inherited-alias rejection, marker mismatch, namespace-only writes and
blocked mutation handlers. Existing production handler/storage suites retain their normal behavior checks.
No Upstash ACL, actual Clerk origin or live ESPN login has been certified yet; that follows configuration.
Empty Redis has no recommendation datasets. Missing coverage remains honest; existing sanitized fixtures
remain controlled test evidence and are never presented as live account recommendations.

## Diagnosing a signed-in status503 before connecting ESPN

The outer preview guard returns preview_read_only_storage_required when previewConfig fails. In contrast,
"Isolated preview credential storage is not configured" originates AFTER that guard. The latter does not
mean an environment variable is necessarily missing. In particular, the database bootstrap marker is a
separate prerequisite, not an environment variable.

Authenticated status/myEdge failures now include a fixed reason code (no values or provider errors):
- preview_configuration_invalid: storage preflight configuration rejected.
- preview_user_id_invalid: authenticated Clerk subject does not match supported user-ID format.
- preview_redis_read_failed: marker GET failed; inspect isolated URL/read-token/ACL/connectivity securely.
- preview_database_marker_missing: GET succeeded but fe:preview:project does not exist.
- preview_database_marker_mismatch: marker exists but does not match project ID as a string.
- preview_credential_read_failed: credential-key GET failed.
- preview_credential_format_invalid: an unexpected non-version1 record exists; no plaintext imported.

Never auto-create the marker from the app or convert these failures into DISCONNECTED. Provision/check
fe:preview:project in the dedicated database using its admin console; its string value must match the
separate project's ID exactly. This nonsecret bootstrap step needs no ESPN credentials. Once the marker
and read path succeed, an empty database returns status connected:false and My Edge DISCONNECTED200.
Token presence does not certify write-token ACL permissions; those must be checked separately.
