# Storage epoch certification preparation — DO NOT MERGE / PUSH / DEPLOY

This packet prepares isolated certification; it does not authorize execution. Production bootstrap,
activation, Redis reads/writes, WAF, credentials and environment remain unchanged.

## Exact-source package and harness

Run `node scripts/prepare-epoch-certification.mjs /tmp/fantasyedge-epoch-certification` only from
committed, reviewed source. It produces a git archive and SHA-256/source-SHA manifest. No .env,
Vercel linkage, node_modules or untracked file is packaged. Install from the lockfile in an isolated
runner; verify SDK 1.38.0. Do not substitute remote PR source for the local reviewed source.

The executable offline reference harness is `scripts/check-storage-epoch.mjs`, including the actual
HTTP handler with synthetic authenticated identity/provider fixtures. `FE_TEST_UPSTASH_SDK=1`
selects the installed SDK REST/base64/automatic-pipeline transport against disposable Redis.
This is SDK protocol certification, NOT hosted Upstash certification. Its FLUSHDB cases and
`raw.command` setup MUST NOT be pointed at a hosted database. The separate hosted adapter/entrypoint
must be reviewed before deployment; none is publicly callable or enabled in this packet.

Hosted design (blocked pending scoped storage capability):

1. Use only fantasyedgepreview project `prj_J2iHBHjE2viBnWRRRl6QeWk2dexi`, Preview target;
   no cron, aliases, integration changes or application traffic. Verify immutable source SHA and
   project/environment metadata. Protected, operator-only build/runner; fixed test phases, counts
   or fixed failure categories only. No arbitrary script/key/URL/identity parameters or public endpoint.
2. Verify the isolated database resource ID/URL against reviewed nonsecret metadata, and its existing
   `fe:preview:project` marker using the approved reader. Reject Production, unknown resources,
   shared Production credentials, and token/URL fallback. Never retrieve real connection values.
3. Existing Preview credential keys are `preview:espn:creds:user_*`. Do NOT use or alter these.
   An exact-source e1 run needs exclusive reservation of fixed `fe:e1:*` plus synthetic
   `espn:creds:epoch_cert_*` legacy fixtures. Refuse any existing e1 keys; refuse any legacy
   `espn:creds:*` key outside the explicitly generated fixture allowlist before reading values.
   SCAN MATCH traverses the keyspace but returns only matching names; no unrelated value reads.
   If this cannot be safely reserved, use separately authorized disposable isolated Redis instead;
   do not rewrite e1 strings in application Lua, broaden a live user's ACL, or use an admin token.
4. Capability preflight must use synthetic keys only and prove every command below, including nested
   Lua ACL enforcement, cjson, TYPE status reply, Redis TIME, PXAT and stale CAS. Missing command or
   key permission => fixed FAIL_CAPABILITY; no credential import or activation. Do not auto-fix ACL.
5. Reuse exact bootstrap/lifecycle/codec modules and actual handler with synthetic Clerk/ESPN
   fixtures. Seed known synthetic plaintext, malformed and expired records; prepare, interrupted
   import/resume, idempotent repeat, seal, verify, activate. Pending is disconnected; absent manifest
   user disconnected. Authentication failure, missing explicit confirmation, provider failure and
   stale revision cannot confirm. Successful fresh fixture validation creates encrypted active state.
6. Issue late legacy credential/permission/consent/watch/manual/dataset writes under the synthetic
   allowlist. New state must be unchanged. Assert cold-dataset no_dataset/noData behavior, safe
   provider rebuild, NX/PX cooldown, quota block, generation invalidation, malformed-control 503,
   seal/import interleaving and expiry during confirmation. Use separate fresh fixture cohorts for
   destructive control cases, never FLUSHDB/FLUSHALL.
7. Future My Edge contract fixture uses the SAME e1 boundary, codec and lifecycle, then instantiate
   compatibility again and verify reads/permission/revocation. This does NOT certify unmodified PR104.
8. Track every created synthetic key in a run-owned journal. Cleanup exact allowlisted owned keys
   only, after checking run ownership; no wildcard deletes, no real user keys. Fail closed if ownership
   or cleanup is uncertain. Report only SHA, fixed case names, counts, PASS/fixed failure categories.

## Preview capability gap

Recorded setup allows GET/SET/DEL (later local docs propose EVAL) only under
`preview:espn:creds:user_*`, plus a separate read-only token. Neither covers e1/bootstrap.
No current provider ACL was fetched or modified, and no live capability command was executed.
Thus current capability is NOT certified, and the documented restricted ACL is insufficient even
if EVAL was subsequently enabled. Do not infer permission from variable names.

Required: EVAL; nested GET SET DEL EXISTS TYPE INCR EXPIRE PTTL TIME SCAN SADD SREM SMEMBERS
SISMEMBER SCARD; SET EX/PX/NX/PXAT. Runtime needs e1 keys; bootstrap needs e1 plus explicitly
approved legacy source keys. SCAN is database-wide iteration despite MATCH. No runtime pipeline,
MULTI, EVALSHA or SCAN API is exposed; SDK automatic pipelines contain individually guarded EVALs.
Ordinary reader tokens cannot execute these guarded read/write-capable scripts. An approved
synthetic-only capability path is required before hosted execution; no paid plan is recommended.

## Eventual Production operator execution (not authorized)

Offline/private reviewed CLI `scripts/bootstrap-storage-epoch.mjs`; no API route or scheduled job.
An authorized human runs pinned source in a controlled runner with credentials injected by the
approved secret mechanism (never env pull, CLI arguments, shell history or output). Validate target
project/database metadata before injection. Explicit operations: prepare RUN, import RUN, seal RUN,
verify RUN, activate RUN. The environment authorization flag is an accident-prevention guard, NOT
an authentication boundary: possession of the operator runner and scoped secret access is the boundary.
Require separate explicit approval for imports and activation, maintenance still active. Keep a
nonsecret run ID/audit log. Rerun imports safely while preparing; never reopen sealed/active control.
Seal/activation retry must inspect control safely; activate currently fails if already active, so do
not reset control to retry. Counts-only success; fixed FAIL_BOOTSTRAP on failure, no raw exceptions.
