# Isolated pre-cutover lineup accounting release

Based on Production `021450cbc72346f365d2c198068d82156e07476f`, on branch
`provider-lineup-accounting`. This is a separate pre-cutover release. No Production
or Preview mutation, push, deployment, WAF publication, or PR105 modification is
part of implementing/certifying this branch. Only synthetic certification Redis
writes are authorized. The eventual commit is local until separately authorized.

## Accounting and the corrected safety contract

All ESPN lineup writes still pass through setLineup/postLineupTxn. Selection,
optimization, request URL/method/headers/body and parsed-409 move filtering are
unchanged. The wrapper records each attempt before executing its send callback.

The separate persistent namespace `fe:lineup-audit:v1:` contains:

| Key suffix | Required contents |
| --- | --- |
| admission | JSON `{schema:1, registryId:UUID, generation:UUID, phase:OPEN or CLOSED}` |
| registry | JSON `{schema:1, id:UUID, generation:UUID}` |
| operations | Set of every operation UUID plus `registry:<registry UUID>` |
| active | Set of active/blocked operation UUIDs plus the same registry marker |
| op:<UUID> | Strict operation document, source SHA, registry/generation, pseudonymous target, revision, status, timestamps and attempts |
| target:<HMAC> | Owning operation UUID while active or blocked |

All four safety roots ALWAYS exist with the exact Redis type and PTTL=-1. Redis
normally deletes an empty set; persistent registry markers keep both sets present,
so missing state cannot masquerade as an empty journal. Every existing operation
and target lock also requires PTTL=-1. PTTL=-2, zero and positive TTL all fail.
Nothing in runtime/reconciliation repairs, recreates or extends an unsafe root.
No TTL-based unlocking, leases, journal deletion, or automatic initialization exists.

Gate and registry must have exact schemas, canonical lowercase RFC4122 version-4
UUIDs, identical registry identity and identical current generation. BEGIN checks
these, persistence, Redis types and both markers atomically before recording an
operation. The operation captures that registry/generation. PREPARED and POSSIBLY_SENT
updates recheck the safety roots, operation membership, persistent target ownership,
raw-document CAS and current OPEN generation atomically. Rotation/closure between
BEGIN and dispatch eligibility invalidates the old operation; it remains locked and
unresolved. No retry is opened. New attempts in an existing 409 chain also need the
original generation still OPEN.

POSSIBLY_SENT acknowledgement is the dispatch eligibility boundary. Once committed,
the process may send even if closure races immediately afterward; its active record
remains blocking until the result is recorded. This unavoidable Redis/HTTP gap is
why CLOSED alone is insufficient: the complete active/possibly-sent ledger must drain.
A later CLOSED generation still permits recording an already-sent outcome and safe
completion, but cannot grant an old operation a fresh send. Operator changes must
atomically CAS both gate and registry to a fresh never-reused UUID. Never restore a
previous generation/snapshot or change the registry ID under existing operations.
Trusted operator custody and no competing raw writes are required; this is not an
anti-tampering system against an administrator rewriting all evidence.

Each attempt is:

`PREPARED -> POSSIBLY_SENT -> ACKNOWLEDGED | REJECTED | UNKNOWN`.

Complete explicit HTTP 2xx response/body yields ACKNOWLEDGED. Observed
400/401/403/409/422 yields REJECTED. Other statuses or network/timeout/body loss
produce UNKNOWN. httpStatus=0 explicitly means no complete provider response; no null
fields are used because hosted Lua JSON can drop them. This records observed responses, not an invented ESPN settlement
or cancellation guarantee. Only a parsed 409 can cause the existing filtered retry;
every retry has a distinct opaque attempt UUID under the same operation (maximum six).
No automatic transport retry occurs. Failure to acknowledge POSSIBLY_SENT means
zero dispatch. An ambiguous journal acknowledgement leaves persistent blocking state.
A known ESPN success is still returned when its journal write fails, avoiding an
instrumentation-induced resend prompt; the lock/active record remains blocking.

The shared schema validates exact required fields, operation/attempt ownership,
canonical IDs, global attempt-ID uniqueness during reconciliation, ordinals, event
chains, HTTP classifications and revision count. Only a preceding REJECTED/409 can
have a successor. COMPLETE requires at least one attempt and terminal safe outcomes.
Missing/null/string attempts never become empty. Redis cjson's empty `{}` and `[]`
are valid only for pristine ACTIVE revision-0 BEGIN, which always blocks journalClear.
Orphan records, extra namespace keys, unknown schema/status and malformed chains fail.

## Root causes fixed

1. Runtime previously checked only that generation was a string; reconciliation used
   a loose UUID regex and no durable registry linkage. Strict shared schemas plus
   atomic Lua validation and captured-generation fencing now prevent dispatch.
2. Persistence was checked only for operation records/locks. Admission and indexes
   could expire or disappear, and absent empty sets were accepted. Mandatory linked
   persistent roots/markers and initial/final TYPE+PTTL checks now reject these states.
3. The old attempts fallback coerced missing/null fields to an empty list, allowing
   malformed COMPLETE records to look clear. Exact schemas, nonempty terminal histories,
   attempt ownership, legal retry chains and revision accounting remove that fallback.

## Canonical identity and privacy

The target tuple is game/season/league/team. Game must be one of the exact ESPN game
codes. Numeric identity accepts a positive JavaScript safe integer or a 1-64 character
ASCII decimal string within the same safe-integer range. Leading zeros canonicalize
through BigInt: 123, "123" and "000123" share the same target lock. Zero, negatives,
fractions, whitespace, signs, exponent/hex strings, Unicode digits, objects, booleans,
BigInt inputs and unsafe integers are rejected before any journal or ESPN call.
Canonicalization affects ONLY the pseudonymous locking identity, not the submitted
ESPN URL or payload. Wire comparisons include MLB, NFL and WNBA success/409 paths.

The HMAC uses a domain-separated subkey from the existing encryption key; no new
secret is needed. Keep that key byte-identical across deployments and observation.
There are no raw league/team/user IDs, moves, cookies, tokens, provider bodies or
credential material in journal/log output. Restricted HMAC tags are pseudonymous data.
Opaque operation/attempt IDs and timestamps remain in restricted Redis. Reconciliation
prints only counts/statuses. Existing internal lockedBody return is retained for
baseline compatibility but not journaled/logged or returned by the HTTP handler.

## Behavior boundaries

No roster selection, scoring/model, Draft Coach, My Edge, DNA, billing or authentication
policy code changes. Missing/closed/unsafe admission, noncanonical unsupported identity,
journal failure, and an unresolved same-target operation now fail closed. Accounting
adds awaited Redis work; timeout remains active through provider body consumption.
These are intentional availability/error changes. No duplicate request is introduced.
The existing six-attempt exhaustion behavior is preserved; use the journal rather
than application applied-count summaries as acknowledgement evidence.

Redis acknowledged writes are the durability boundary. Require provider persistence,
no eviction, capacity, stable key material and exclusive administrative custody.
Loss/rollback of journal data invalidates coverage; it cannot be reconstructed by a
timer. No distributed transaction or exactly-once ESPN guarantee is claimed.

## Certification and read-only reconciliation

Local suite: `npm run check:lineup-accounting` (requires local redis-server; supports
FE_TEST_REDIS_SERVER and its required library path in this operator environment).
Fencing predicates: `node scripts/check-lineup-accounting-fencing.mjs`.
Hosted suite: `python3 scripts/certify-lineup-accounting.py` only in this operator
workspace with separately authorized disposable-db access. It uses the existing
private certification file, strict data-only parsing/0600 ownership checks, a fresh
child environment, and the independent prior cert endpoint-origin fingerprint.
No Production/Preview file is opened. ESPN outcomes are all mocked. Exact reviewed
Lua runs on hosted Upstash; native network access is limited to the pinned origin.

Hosted evidence and source hashes are written to ignored
`.cache/lineup-accounting-certification/hosted-evidence.json`. The source list includes
runtime, tests, harnesses, documentation and templates; unchanged hashes are verified
at run completion. The final local commit must contain exactly those tested files.
Certification atomically reserves an initially empty disposable database, journals
owned fixed-namespace keys, checks ownership and deletes only owned keys. It never
uses FLUSHDB/FLUSHALL, real ESPN requests or deploys. Uncertain reservation ownership
is checked read-only before cleanup. Cleanup failure blocks certification and commit.

The production observer is `node scripts/reconcile-lineup-accounting.mjs`, using
separately reviewed private injection of KV_REST_API_URL, KV_REST_API_TOKEN and
FE_EPOCH_ENDPOINT_SHA256. It accepts no arguments or mutation mode and uses only
GET, TYPE, PTTL, SMEMBERS and SCAN. It does not repair unsafe records. The old inventory
loader remains fixed to storage inventory and must not be repurposed without review.
Do not load secrets through shell evaluation or pass them in argv.

Reconciliation validates the exact namespace, schema, every operation and active lock,
registry linkage, membership, persistent state and stable rereads of records, roots,
sets and types/TTLs. It fails above 10,000 operations or the command budget. SCAN and
rereads are not an atomic snapshot: require CLOSED admission, a configuration freeze
and no administrative writers. A changing snapshot fails; never infer safety from
partial output. maintenanceAuthorized is ALWAYS false even when journalClear is true.

## Future rollout and fencing — proposal, never automatic

A separate approved Production accounting release is necessary before live traffic
can produce evidence. It defaults closed and requires separate approval for private
initialization of the four persistent safety roots. No initializer/admin endpoint is
exposed by the application or observer; fixtures in scripts/lib are synthetic tests,
not an operator command. Initialization must require an empty journal namespace and
one owner; OPEN/CLOSED changes must use checked atomic CAS and fresh generations.
No repair of existing records is implied by initialization.

Use `lineup-accounting-fencing.template.json` as a reviewed proposal, NOT vercel.json
or an automatic publish script. Its persistent deny rule, all methods/environments:

- Reject any x-deployment-id header, dpl query or __vdpl cookie on ALL paths.
- Reject ALL paths on hosts other than verified current www/apex and H.
- Permit H only the two exact refresh/Autopilot cron paths; deny any other H path.
- Deny /api/cron prefixes on every host other than H.

H is a placeholder: replace it only with the verified scheduler host of the exact
accounting deployment. www must resolve to that same deployment; apex must be verified
redirect-only to www. Default, branch, Preview and old immutable hosts are quarantined,
including their static pages. This covers unknown historical non-/api rewrites; with
complete historical route proof a narrower API-only policy could be reviewed later.
Rules precede any bypass. No host allowlist alone proves a deployment SHA: freeze and
verify aliases, cron destination, rollback/rolling-release settings and effective code.

For a future authorized rollout, first close old admission with the all-host/all-method
/api maintenance deny and persistent quarantine, verify propagation and effective path
normalization, then promote the approved accounting release under that deny. Do not
start the evidence coverage boundary until old queued/running work has a documented
terminal disposition. Only then privately initialize/open accounting and consider
removing the temporary maintenance deny. Historical transactions remain a separate
settlement gate even when the new journal is clear. No timer proves remote settlement.

On eventual PR105 cutover, close accounting admission, verify stable clear evidence,
retain quarantine and apply the temporary /api deny. Before reopening after PR105,
replace H with the new verified epoch deployment cron host, thereby excluding even
the accounting release's now-old immutable host. Keep all selector/host fencing.
Verify real WAF enforcement on immutable/default/branch/custom hosts, both cron paths,
all methods, casing/encoding/normalization and selectors before claiming coverage.
A deployment-protection login page is not proof of WAF denial. Predicate unit tests
are design checks only. No rules have been staged, published or otherwise applied.

Future staffed window remains 14:15-16:00 UTC, outside refresh 11:00-11:59 and Autopilot
13:00-13:59 UTC scheduling windows. Reverify actual schedules/destinations then.
Observability Plus is not required or a substitute for transaction settlement evidence.

Official rule/selector references:
- https://vercel.com/docs/vercel-firewall/vercel-waf/rule-configuration
- https://vercel.com/docs/skew-protection
- https://vercel.com/docs/vercel-firewall/firewall-concepts

## Maintenance-entry PASS and unresolved outcomes

Require verified coverage of ALL writer deployments/routes, frozen aliases/config,
CLOSED admission, valid persistent complete journal, zero ACTIVE/BLOCKED operations,
zero PREPARED/POSSIBLY_SENT/UNKNOWN attempts, and no active retry chain. Any malformed
record fails rather than producing a clear result. Old submitted/queued transactions
must have separate documented disposition. A pristine empty operation also blocks.
An already-sent UNKNOWN remains locked until authoritative provider-supported terminal
result/history/cancellation evidence is available. Roster readback is corroboration,
not proof no delayed transaction can occur. No automatic unknown resolver/unlock exists;
any future manual reconciliation must preserve history through a separately reviewed
schema/procedure. No undocumented ESPN status API or settlement deadline is assumed.

There is no fixed quiet interval that repairs historical evidence. After full writer
coverage, CLOSED plus a stable clear ledger establishes local lineup quiescence without
an extra fixed sleep. Remote ambiguity and older uninstrumented transactions remain
separate gates. Production maintenance readiness is not granted by Draft-PR readiness.

## PR105 port and recertification

PR105 remains untouched at `24b5c4262c30f07716b893256dcc23a40e2bbe35`.
The earlier three-way simulation found four conflict regions in espnFantasy.js, one
package-script conflict, and a local-Redis helper add/add conflict. Preserve PR105's
credential/lifecycle/consent changes and known-roster-only sanitization; do not restore
lockedBody. Port accounting around its setLineup boundary and retain body-timeout/UNKNOWN
semantics. Keep PR105's protected KEYS/ARGV Redis helper. Merge all test scripts.

The operational journal deliberately survives storage epochs. PR105's raw-Redis
boundary checks need a narrow audited exception for this exact namespace/transport/
script set, never a blanket exemption. Include the schema module; forbid any legacy
credential or epoch user-data access from it. Test that bootstrap/cleanup does not
remove journal data and that old/new code shares HMAC identity, persistent roots,
generations, active locks and unresolved attempts across releases.

Rerun accounting local+hosted/adversarial/wire checks (compare wire separately from
PR105's sanitized return contract), immutable Lua, Redis boundary, full storage epoch
and bootstrap/recovery suite, credential codec/compatibility/lifecycle/browser/handler,
Autopilot entitlement, sport readiness, DNA, Coach/draft and NHL/cache isolation.
Refresh operator manifests/package hashes and repeat hosted epoch certification with
accounting continuity. The port creates a new source SHA needing certification; the
old certified SHA is not a certificate for modified source. No PR105 change occurs here.
