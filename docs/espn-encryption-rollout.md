# ESPN encryption production rollout runbook

Status: prepared on my-edge-foundation, 2026-09-12. **Not executed.** No production environment changes,
Redis migration, deployment, ESPN credential retrieval or lineup writes were performed. This is an
operator procedure requiring separate release authorization, not a script to run automatically.

## Exact key contract

`api/_lib/espnCredentials.js` requires `ESPN_CREDENTIAL_ENCRYPTION_KEY`: **32 cryptographically random
bytes encoded as canonical standard padded base64**, exactly **44 characters ending in one `=`**.
It decodes, requires 32 bytes and compares a re-encoding with the trimmed input. Hex (64 characters),
passphrases, unpadded base64, base64url substitutions, surrounding literal quotes and internal line breaks
are rejected. Leading/trailing whitespace is trimmed. Generate with a trusted cryptographic secret
manager; never use the deterministic test keys. No actual key or credential belongs in this document.

`ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY` is optional and has the same contract. Leave it absent initially.
Both configured keys are parsed before encrypted reads: even a malformed previous key breaks reads with
a valid current key. The operator tool preflights a synthetic in-memory round-trip before apply/verify
storage access. Inventory requires no encryption key and does not prove decryptability.

## Safe Vercel setup (operator only)

1. Confirm the actual FantasyEdge Vercel project, team, production branch, Redis instance and privileged
   operator. Their production configuration and key custody are **Unknown from repository**. Do not assume
   that a local link or a Preview deployment uses isolated Redis.
2. Generate the production key in an approved secret manager; retain controlled recovery custody outside
   Git, chat, screenshots, tickets and shell history. Use independent nonproduction keys **and Redis**.
   Deployments sharing a Redis credential namespace must share compatible decryption keys.
3. In Project Settings → Environment Variables, add the server-only name
   `ESPN_CREDENTIAL_ENCRYPTION_KEY`, select Type **Secret**, target **Production** only and enter the value
   through the secure UI. Do not paste it into a command argument, use a public/VITE/NEXT_PUBLIC prefix,
   export production `.env` files into the repository, or expose it through public-config. Set separate
   Preview/Development secrets only for isolated test storage. Restrict project/env edit access.
4. Secret values are write-only after save; retain recovery custody first. Vercel now calls these
   **Secret** variables (legacy **Sensitive** variables remain supported). Secret redaction does not make
   logging credentials safe. See [Vercel Secret variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables).
5. An environment edit applies to **new deployments**, not existing ones. A later separately authorized
   release must include the key; setting it alone does not migrate or fix the deployed application.
   See [Vercel environment variables](https://vercel.com/docs/environment-variables).

Do not use a production env pull, printenv, secret echo, full diagnostic request dump or browser cookie
screenshot as verification. Check only presence/format and aggregate outcomes in a trusted process.

## Release prerequisite: a genuinely compatible rollback target

Current main `4a4dce7` predates encrypted storage. It is **not a safe rollback target once even one new
connection has been saved by the encrypted writer**, whether or not migration has started. Stopping
migration does not remove this incompatibility. Old deployments have their own environment snapshots;
adding a key to project settings does not retrofit them.
[Vercel Instant Rollback](https://vercel.com/docs/instant-rollback) restores an earlier deployment state.

Before any production encrypted write, prepare and test a compatibility release/rollback artifact that:

- Reads both legacy records and v1 envelopes, with the production-compatible key environment attached.
- Preserves connection revocation, Premium checks, current-version DNA consent and write allowlists.
- Can safely continue encrypted writes, or explicitly fail closed on new connections while existing
  encrypted connections remain readable. It must not silently resume plaintext saves.
- Passes a rollback rehearsal against synthetic legacy/encrypted records in isolated Redis, including
  disconnect/relink races. Verify the exact deployment artifact and environment, not just a Git hash.

**This artifact and rehearsal are outstanding production blockers.** The current branch does not contain
a separate compatibility-only release switch. Decide and prepare that release before scheduling rollout.
Do not claim old main is compatible, restore plaintext database exports, or remove encryption keys to
force fallback. Recovery must never resurrect a connection or automation permission that a user revoked.

## Migration tool inspection and staged procedure

`scripts/migrate-espn-credentials.mjs` only scans `espn:creds:*`; no ESPN calls or subscription/lineup work.
Commands below are operator examples, **not execution authorization**. Redis connection variables must be
injected by the approved secret runner (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`); verify target
selection without printing credentials. See `api/_lib/kv.js` for any deployment aliases.

1. Run `npm run check:credentials` offline, then rehearse all modes with isolated Redis and synthetic
   records. Verify the recovery key and compatible rollback artifact before touching production.
2. After separately approved compatible deployment, run:
   `node scripts/migrate-espn-credentials.mjs`
   This is read-only inventory. It counts legacy/encrypted/invalid records; encrypted does **not** mean
   decryptable. Keep only aggregate output. Investigate invalid records without dumping their values.
3. Run `node scripts/migrate-espn-credentials.mjs --verify`.
   It preflights key configuration, then decrypts envelopes in memory and reports readable, expired and
   unreadable counts. It never modifies credentials, calls ESPN or proves that ESPN still accepts cookies.
   Invalid/unreadable records yield exit 1. Require zero unreadable and zero unresolved invalid records.
4. After explicit migration approval, canary with:
   `node scripts/migrate-espn-credentials.mjs --apply --limit 1`
   The limit bounds **legacy CAS attempts**, including skips/races, not SCAN reads or selected users.
   SCAN order is unspecified: this is not an operator-selected account canary. If a specific account is
   required, add a separately reviewed targeting mechanism first. `complete:false` means the scan stopped
   at the limit; it does not describe the remaining population. Restart each run from cursor zero.
5. Verify again and check a consenting operator account's normal manual connection/roster-read flow.
   Confirm relink revokes automation and DNA behavior is unchanged. Never use live Autopilot, lineup apply
   or mutating account/premium tools as health checks. Monitor aggregate failures only.
6. If canary acceptance holds, authorize larger bounded batches or an unrestricted `--apply` run. Re-run
   inventory and verification after completion; require `complete:true`, zero legacy, zero unreadable and
   no unresolved invalid records. SCAN may duplicate or omit changing entries during concurrent activity;
   repeat until stable rather than treating counts as an exact transactionally consistent user census.
7. Keep the legacy reader for a separately reviewed compatibility window. Retiring it is a separate code
   change after stable inventory and backup/rollback review; there is no automatic cutoff in this release.

Each migration encrypts then uses Lua to compare the exact original serialized Redis bytes before SET
with a 90-day TTL. A disconnect/reconnect or competing migration wins over stale input. Skips are counted;
never bypass CAS with blind SET. Differently serialized JSON may conservatively skip and needs deliberate
review. The encrypted payload preserves savedAt and connectionId and adds expiry from migration time;
it does not renew ESPN's actual session or grant new Autopilot permission. No legacy record is deleted by
verification, including expired envelopes. TTL handles retention; verify's expired count is not corruption.

The tool rejects unknown/mixed flags. A storage failure in apply may follow successful writes: exit 1
is **not an atomic rollback**, and a full summary may be unavailable. Stop, inventory, verify, then resume
idempotently after diagnosing. Keep the compatible reader and keys available throughout. Run only one
operator migration at a time for understandable counts; CAS still protects against concurrent app writes.

## Abort, rollback and rotation

Abort migration on unreadable envelopes, unexpected manual-connect failures, unknown invalid records,
wrong storage target, or changed revocation/consent behavior. Stop further batches. Prefer a targeted fix
or the rehearsed compatible rollback deployment; never roll back to 4a4dce7 or restore stale credential
backups. A Redis restore can resurrect revoked credentials and requires a separate revocation-aware
recovery plan. Key backup custody and tested disaster recovery remain **Unknown from repository**.

For rotation, retain old current as `ESPN_CREDENTIAL_ENCRYPTION_PREVIOUS_KEY`, add a new current key and
rehearse new/old reads. Every active and rollback deployment must know the keys needed for its storage.
Do not rotate again while records still need a key older than the one previous slot. Retain the old key
for at least 90 days after the **last possible old-key write** (including rollback deployments), or until
all such records are verified replaced/expired. This tool does not rotate encrypted envelopes. A future
rewrapper needs CAS and must preserve authenticated expiry rather than extending retention silently.

Production acceptance and execution owner, deployment IDs, key custody, migration counts and rollback
rehearsal results are **Unknown from repository**. Record nonsecret evidence when execution is authorized.
