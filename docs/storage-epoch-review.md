# PR105 epoch security/SDK/cost review — 2026-09-21

**DO NOT PUSH / MERGE / DEPLOY.** Remote Draft PR105 was read-only verified at
`9cd0dc18e0a2550b4dc8f523d96a0c0a412716fe`. Review began at local
`75f1b41a559eb5b268e3d13ae3a2468a817ba388`; the local follow-up commit containing this
report addresses the findings below. No Production or Preview Redis values were read.

## Result and corrections

No active runtime legacy Redis fallback found. All physical runtime keys pass through the
fixed e1 boundary, including datasets and caches. Review found two SET-option regressions:
weather cooldown NX/PX and CFB immutable snapshots NX were rejected by the original wrapper.
The wrapper now supports positive EX or PX, optional boolean NX, and rejects conflicting/unknown
options. The entire SET remains inside the control-guarded Lua operation.

SDK automatic JSON deserialization plus the epoch decoder could decode JSON-looking strings twice.
Runtime and operator SDK clients now disable automatic deserialization; the explicit epoch/row
codec decodes once. New tests cover strings `123`, `true`, `null`, JSON text, arrays and objects.

Cold synopsis previously reported a missing dataset as a missing player; now 503/no_dataset.
Team Manager explicitly marks recommendations unavailable when the epoch dataset is absent.
No legacy cache recovery was added. Autopilot noData skips and provider rebuild coverage added.

## Security boundary and all 27 consumers

| Files under api (grouped, all audited) | Trusted path / cold behavior |
|---|---|
| _lib/storageEpoch.js, _lib/espnLifecycle.js | Private raw eval boundary; 11 lifecycle keys, all prefixed plus control; no raw exported client |
| _lib/espnFantasy.js, _lib/espnPending.js, espn/index.js | v1-only active reader, readiness/generation match, CAS; candidate never active; confirmation requires identity/Premium/explicit action/fresh provider ownership read |
| _lib/leagueDnaConsent.js, _lib/leagueDnaSweep.js, _lib/leagueConfig.js | Current-notice generation-bound consent and epoch membership; empty membership captures nothing; missing configs remain missing until fresh consented capture |
| _lib/prospectWatch.js, cron/autopilot.js | Generation-bound watch/manual relationships and permissions; stale snapshot CAS rejected; no old membership scan; cold dataset skips writes |
| _lib/auth.js | Clerk remains entitlement authority; free quota unavailable until next UTC day, then epoch counters; no legacy counter reads |
| cron/refresh.js, sports.js, _lib/draft.js | e1-only datasets; safe provider rebuild on cache miss; provider errors propagate/degrade, never legacy read-through |
| _lib/coachContext.js, _lib/playerSynopsis.js, synopsis/index.js | Empty context/unavailable synopsis instead of legacy ratings; fingerprint cache remains e1 |
| _lib/boxScore.js, _lib/teamReport.js | Fresh provider reads on miss; only validated final/full results cached |
| _lib/cfbRatings.js, _lib/cfbSpSnapshots.js | Missing ratings unavailable; public reads do not spend paid-provider quota; cron rebuild; NX snapshot immutability preserved |
| _lib/pickem.js, _lib/nflPickem.js | Public-provider rebuild/partial feeds; missing model data returns empty/null; epoch NX/PX weather cooldown |
| _lib/crosswalk.js, _lib/enrichProspects.js | Provider rebuild of missing identity/state; no legacy prospect association trust |
| _lib/fantasyAdp.js, _lib/fantasyProjections.js | Provider refresh then e1-only cache fallback; cold failure yields absent enrichment, never legacy values |

The count includes the boundary itself. kv.js is the only SDK constructor/import in runtime.
Consumer parameters are supplied the shared wrapped client; raw Redis constructor, direct REST,
computed Redis methods, pipeline/multi/evalsha and operator imports were searched across runtime.
No bypass found. In-process caches belong to the new deployment process, not a legacy Redis path.

Key occurrence classification:

- Runtime literals `espn:*`, `dataset:*`, `mockdraft:count:*`, scoring/configuration/sweep,
  projections/ADP/crosswalk/prospect/weather/Pick'em/ratings/synopsis keys are **logical identifiers**,
  not raw legacy access: the boundary adds fe:e1 exactly once. This necessary fourth classification
  avoids incorrectly calling a safe logical key a bootstrap read or unsafe fallback.
- Physical unprefixed `espn:creds:*` SCAN/GET/PTTL in scripts/lib/epoch-bootstrap.mjs is operator-only,
  preparing/run/manifest guarded inside Lua. No active API imports it. No other legacy value is copied.
- Legacy fixture mutations and codec reads in scripts/check-* / scripts/lib/* are synthetic tests.
  Markdown descriptions are docs only. Bootstrap CLI is operator-only, never build/cron/API invoked.
- decryptCredentials retains an in-memory legacy decoder; runtime uses decryptActive, which rejects
  non-v1 before calling it. No raw key read or write fallback exists in the codec.
- fe:e1 construction is centralized in PREFIX/epochKey/CONTROL. Bootstrap empty-epoch SCAN has the
  same fixed literal; no runtime configurable epoch, remapping or alternate namespace fallback.

Missing/preparing/sealed/malformed control rejects guarded runtime operations. Imports recheck phase
at source read AND atomic commit; completed imports no-op; seal requires closed manifest/completed
cardinality. Only the importer can add completed members, and only for a manifest member. No normal
runtime operation can write bootstrap keys. Seal/import interleavings use real Redis. Activation is
monotonic; no active-to-preparing path. Operator credentials remain trusted; this is not an ACL against
arbitrary administrator writes or malicious code. Script registration is a repository guard, not a
sandbox for untrusted Lua. Actual registered script was audited: all key accesses use declared KEYS,
TYPE iteration visits only those keys, ARGV carries data, and no dynamic Redis key comes from payload.

## SDK and Lua evidence

Installed/locked @upstash/redis 1.38.0: EvalCommand sends script/key-count/keys/args; string ARGV is
not JSON-stringified again. Numeric cursors/revisions are explicitly normalized. Bootstrap SET stores
JSON objects; pending exact-string CAS survives SDK transport. TTL EX/PX/NX and bootstrap PXAT use
Redis semantics; TYPE status `.ok`, false->null replies, nested arrays, SCAN cursor and membership
responses are exercised. SDK automatic pipelines contain guarded EVAL calls; they are NOT a
transaction, and the implementation does not rely on cross-command pipeline atomicity.

The added SDK transport uses the real installed HTTP client, base64 response handling, automatic
pipeline/serialization and disposable Redis Lua. Full rehearsal passed with 209 requests/211 commands
(including negative/interleaving/cold tests). No actual Upstash server was called. This closes local
harness serialization gaps but does not certify hosted ACL, Upstash engine limits or network retries.
Runtime SDK retries can repeat a non-idempotent INCR on transport loss (conservative quota consumption);
CAS mutations reject a repeated old revision; bootstrap CLI disables transport retries and resumes
through explicit idempotent markers. No fallback to plaintext or legacy keys occurs on any SDK error.

Upstash documents EVAL support and conservative global locking for Lua unless explicitly opting into
key-locking. These scripts do not opt in; bootstrap SCAN inside Lua must be capability-tested on host.
No claim of Redis Cluster cross-slot compatibility is made.

## Free command/cost model

Count submitted Redis commands separately from HTTP requests (pipeline reduces requests, not commands)
and server-side Lua work. No live usage/billing counters were read. Define K=total existing database
keys and S=actual SCAN calls per full pass; COUNT100 is a hint, not a guaranteed page size. There are
TWO global traversals: initial empty-e1 check and legacy manifest capture, not N traversals. A MATCH
filter does not avoid traversing unrelated keys. No values outside matching credential keys are read.

For all valid pending candidates, sequence prepare/import/seal/verify/activate submits
**5N + 8 + S_empty + S_manifest** EVALs. Included: N manifest additions, 2N import read+commit,
N explicit verify plus N activation verify; control/seal/manifest overhead. Retries and scan duplicates
add calls. If explicit verify is omitted (activate still verifies), subtract N+1. Completed import
retry costs N+1, no re-encryption/write. All manifest reads use SMEMBERS, O(N) memory; 1,000 users is
small, but larger cohorts need batching. No N×SCAN or nested per-user full membership scans found.

| Synthetic size | Bootstrap illustrative EVALs* | One confirmation each | One connected status each | One read-heavy view budget** |
|---:|---:|---:|---:|---:|
| 1 | 15 | 3 | 3 | 20 |
| 10 | 60 | 30 | 30 | 200 |
| 100 | 510 | 300 | 300 | 2,000 |
| 1,000 | 5,028 | 3,000 | 3,000 | 20,000 |

*Illustration only: S_empty=S_manifest=ceil(N/100), no unrelated keys, duplicates or retries.
Use the formula with measured S on an authorized synthetic host, not these numbers as a guarantee.
**Planning budget for roughly one league/view, including optional associations/config/scoring; actual
calls depend on sport, number of leagues, consent and provider results. My Edge104 is not implemented
on e1 yet; its future aggregate cannot be assigned a certified command count from105.

Runtime primitive GET/SET costs one EVAL containing control GET plus one operation. Lifecycle read is
one EVAL with five GETs including control. Mutation adds 11 TYPE checks and about 10–20 reads/writes.
Conservative internal-work budget for bootstrap: <=100N + scan/control work for clean valid fixtures;
confirmation <=40N; status <=10N; read-heavy view <=200N. These are work estimates, not documented
billing multipliers. Public pricing reviewed does not explicitly settle nested-Lua billing; retain
both submitted-command and conservative internal-command budgets until hosted usage deltas establish it.

Autopilot: one epoch membership SMEMBERS, about 5 EVAL/user before leagues; roughly 3 revalidation
reads plus optional config write per attempted league; MLB watch work adds roughly3/user. Sport datasets
cached once per sport/run, NOT once/user. DNA sweep adds membership+cursor+cursor-save, 2 consent reads
and1 credential read per visited user, plus one config write per distinct fetched league. Provider/time
budgets may stop early. Empty fresh membership is cheap and cannot import old opt-ins.

Dataset/cache warm hit: one guarded EVAL per key. Cold rebuild adds SET and dependent cache accesses;
cost tracks distinct sports/games/venues/players/league configurations, not a fixed per-user multiplier.
Do not trigger a full rebuild per certification user. SDK sends script text on each EVAL: bandwidth and
payload-size limits matter in addition to command counts, especially large datasets.

Free documentation: 500K commands/month, 256MB, 10GB bandwidth. A 1,000-user bootstrap is modest;
20 calls ×1,000 daily views ×30 days is already600K submitted commands before cron/caches. This does
not establish today's usage or justify an upgrade. Measure authorized synthetic deltas/latency and
actual traffic before proposing paid capacity. Remain Free; no configuration/plan changes.

Sources (checked 2026-09-21):
- https://upstash.com/pricing/redis
- https://upstash.com/docs/redis/sdks/ts/commands/scripts/eval
- https://upstash.com/docs/redis/features/key-locking
- installed node_modules/@upstash/redis/nodejs.mjs and chunk-2X4SLXT7.mjs (1.38.0)

## Certification gate

All14 regression suites passed after the review fixes, including installed-SDK epoch rehearsal,
actual Redis lifecycle/interleaving, cold provider rebuild, cold synopsis, cold Autopilot and browser
1440/390 fixtures. No unsafe runtime legacy fallback remains. No new product-policy decision needed.
The source is ready for isolated certification preparation; hosted execution is BLOCKED on a verified
synthetic-only storage capability path and reviewed hosted adapter. Existing Preview restricted ACL
is insufficient by documented key scope regardless of EVAL status. No ACL upgrade/change or admin-token
substitution is authorized. See storage-epoch-certification.md for the exact-source packet/design,
operator model and remaining hosted checks. No push or deployment occurred.
