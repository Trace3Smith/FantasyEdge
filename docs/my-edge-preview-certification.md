> Superseded for setup by [isolated-preview-setup.md](isolated-preview-setup.md). Shared production data is no longer an option. Preview connect/disconnect now use the isolated credential-only path. Historical review follows.

# My Edge preview certification — blocked before deployment

2026-09-12. Starting branch my-edge-foundation at 5cf3551, tracked tree clean.
Fresh origin fetch: origin/main is an ancestor, branch18 commits ahead/0 behind. Existing My Edge
commits are intact and unmerged. No branch push or deployment was performed during this review.

## Observed remote configuration (names/scopes only)

Vercel project fantasy-edge has shared Production/Preview definitions for CLERK_SECRET_KEY,
CLERK_JWT_KEY, KV_REST_API_URL, KV_REST_API_TOKEN, KV_REST_API_READ_ONLY_TOKEN, KV_URL and REDIS_URL.
There are no my-edge-foundation branch-specific overrides. Treat this as shared production storage,
not isolation. Secret values were not downloaded, compared, printed or changed.
Preview CLERK_PUBLISHABLE_KEY, APP_URL and ESPN_CREDENTIAL_ENCRYPTION_KEY are absent from the listing.
Actual stored credential versions, read-only token validity and available authenticated browser session
are unknown; no production inventory/migration or account metadata changes were run.

## Safety fix

When VERCEL_ENV=preview, previewSafety.js permits only public-config and POST ESPN status/myEdge/
leagueContext/leagues. All other API handlers return403 before auth, network or write work. This includes
both crons, all billing routes, connect/disconnect, consent changes, preferences, manual league changes,
lineup apply (including dry-run), Coach model calls, trade scans and dataset-building public APIs.
No user query/body flag overrides the guard. Production/development behavior is unchanged.

Preview Redis uses only KV_REST_API_READ_ONLY_TOKEN, never the writable token fallback. If missing,
ESPN reads fail503 before authentication. The configured token must actually be an Upstash read-only
token for the selected database; a variable name is not proof of its ACL. Team Manager preview reads
also explicitly suppress scoring persistence, prospect-watch reconciliation persistence and League DNA
capture. Consent rules remain unchanged in production. My Edge/getCreds already had no write-on-read.
NBA/NHL engine/write/Autopilot allowlists remain unchanged and closed for writes/automation.

Vercel schedules crons against production, but preview handlers now also refuse manual invocations.
See [Vercel cron documentation](https://vercel.com/docs/cron-jobs). .vercelignore explicitly excludes local
environment files, agent state and local handoffs from CLI uploads. No additional handler was introduced.

## Required configuration decision before deployment

1. Prefer isolated preview Redis and a dedicated test Clerk instance/account. Configure database URL and
   its read-only REST token for Preview, branch my-edge-foundation. Populate only an explicitly approved
   test account/connection outside the deployed read-only application; do not clone production user data
   or grant subscriptions as part of this task. Fresh recommendation datasets also need an approved source.
2. Alternative: explicitly choose existing Clerk plus production Redis reads. Keep the new read-only token
   enforcement and endpoint guard. Use an already Premium connected account; no subscription changes.
3. If neither is available, retain fixture-only local verification and label live certification incomplete.

Configure CLERK_PUBLISHABLE_KEY with matching CLERK_SECRET_KEY/CLERK_JWT_KEY in Preview only. Verify Clerk
supports the preview host. Set APP_URL to the exact chosen preview origin for the server authorized-party
check (not a client-supplied origin or wildcard). A stable preview alias can avoid deployment-URL churn.
Do not add Stripe/CRON secrets for this certification. Browser sign-in requires the account owner's normal
Clerk flow; do not send passwords, session tokens or ESPN cookies in chat.

## Encryption details and safe setup

espnCredentials.js uses AES-256-GCM with user-bound AAD, random12-byte nonce and16-byte tag. The key
must be canonical standard base64 of exactly32 cryptographically random bytes:44 characters ending in
one '='. URL-safe base64, hex and arbitrary32-character text are rejected. Outer whitespace is trimmed.
New stored credentials expire after90 days. Legacy plaintext remains readable with no key and is never
automatically rewritten. Encrypted records require their matching current/previous key; failure is503,
not a replacement credential write.

For isolated preview records, create a separate32-byte random secret in a trusted secret manager and
paste it directly into Vercel Project Settings → Environment Variables → ESPN_CREDENTIAL_ENCRYPTION_KEY.
Select **Preview only**, branch **my-edge-foundation**, mark Sensitive. Keep a secure recovery copy.
Do not print the value, place it in shell arguments, commit it, or select Production. Follow
[Vercel branch-scoped environment setup](https://vercel.com/docs/environment-variables/manage-across-environments).

A random preview key cannot decrypt production ciphertext. If reading existing encrypted production data,
the matching decryption key must be provisioned through the approved secret-management path. Do not rotate
or replace the production key. If only legacy records are read, no key is needed for these read-only paths.
Connect/migration remains blocked in the preview web app regardless. The standalone migration script is
not invoked by deployment; its explicit apply/CAS workflow must NOT be run against production here.

## Verification and remaining certification

All local suites exit0: check:preview-safety, check:my-edge, check:espn, check:espn-handler,
check:autopilot, check:league-config, check:league-dna, check:sport-readiness, check:credentials,
verify:coach (88 checks). Preview tests invoke every blocked handler with network forbidden, verify
allowed authenticated reads leave the mock store untouched, and preserve NBA/NHL write gates.

Live preview URL: **none**. No live browser checks passed or failed: they have not run. Previous controlled
Chromium coverage is not live Clerk certification. After configuration: deploy Preview from this branch
with VERCEL_ENV supplied by Vercel, without --prod; confirm upload exclusions, then verify signed-out and
real signed-in flows, read-only ownership, desktop/mobile, context links and observed league states.
Do not manufacture live All Clear/preseason/pagination cases if the real account does not contain them;
retain fixture results separately. Verify denied routes with local tests, not real lineup transactions.

Coach prepared context is in scope, model sending is deliberately disabled. Trade league selection is
in scope, trade scan execution is disabled. Full-site dataset/billing behavior is not certified by this
restricted preview. Home/nav recommendations in my-edge-home-integration.md stand, but cannot yet be
reviewed against a live preview. Production consideration remains blocked by live certification plus the
separate encrypted-storage rollout/rollback prerequisites. No production homepage change is proposed here.
